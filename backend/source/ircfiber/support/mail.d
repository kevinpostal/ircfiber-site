/**
 * Support-issue e-mail notifications.
 *
 * The #support IRC line (`ircfiber.support.events`) reaches whoever is
 * sitting in the channel; this is the same change delivered to the people
 * who are not:
 *
 *   admin acts (public reply, status change)  →  the reporter
 *   reporter acts (new report, follow-up)      →  the assignee, or every
 *                                                 admin when unassigned
 *
 * The actor never mails themself, internal notes never mail anyone (the
 * caller does not call in), and a reporter with no usable address is
 * skipped. Sends run on their own fiber through `ircfiber.mail.sendMail`
 * — the HTTP request that persisted the change has already answered by
 * then and a provider failure only shows up in the mail-event log
 * (`ircfiber.mail_events`) and the #staff feed, exactly like a failed
 * signup verification. With no mail provider configured nothing is sent
 * and nothing is logged as failed.
 *
 * `supportSubject`, `supportReporterMail`, `supportStaffMail` and
 * `supportMailRecipients` are pure and unit-tested in
 * tests/support_format_test.d.
 */
module ircfiber.support.mail;

import std.algorithm : canFind, splitter;
import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.string : strip;
import std.uuid : parseUUID;
import core.time : MonoTime;

import vibe.core.core : runTask;
import vibe.core.log : logInfo, logWarn;
import vibe.textfilter.html : htmlEscape, htmlAttribEscape;

import ircfiber.db.user : UserRepository;
import ircfiber.mail : MailMessage, MailSettings, loadMailSettings, sendMail, emailWellFormed;
import ircfiber.mail_events : MailEvent, MailEventLog;
import ircfiber.models.user : User;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.format : adminIssueUrl, feedbackUrl, statusLabel;

/// One user-visible change, with everything a mail needs. Unlike
/// `SupportEvent` it carries the text of the change (comment body or, for a
/// new report, the description): a mail goes to a party of the issue, not to
/// a public channel.
struct SupportMailNotice {
    /// "issue_created" | "status_changed" | "comment_added"
    string type;
    string issueId;
    long number;
    string kind;
    string title;
    /// Status after the change.
    string status;
    /// Status before a `status_changed`; "" otherwise.
    string previousStatus;
    string priority;
    /// User id / username of whoever acted.
    string actorId;
    string actor;
    bool actorIsAdmin;
    /// Reporter (issue owner).
    string reporterId;
    string reporter;
    /// Assignee user id, "" when unassigned.
    string assigneeId;
    /// Comment body, or the report description for `issue_created`.
    string text;
    /// A reporter follow-up reopened a resolved/closed issue.
    bool reopened;
}

/// Who a notice goes to. `staff` selects the admin-facing wording and link.
struct SupportMailRecipient {
    string email;
    string username;
    bool staff;
}

/// Pure recipient policy over the notice and the live user rows the caller
/// looked up. Admin actions reach the reporter; reporter actions reach the
/// assignee when there is one, else every admin. The actor is never a
/// recipient, malformed/empty addresses are dropped, and one address is
/// mailed once even if it wears two hats.
SupportMailRecipient[] supportMailRecipients(const SupportMailNotice n, const User reporter,
                                             const User[] admins) @safe {
    SupportMailRecipient[] out_;
    bool seen(string email) {
        foreach (const ref r; out_) if (r.email == email) return true;
        return false;
    }
    void add(const User u, bool staff) {
        const email = u.email.strip();
        if (email.length == 0 || !emailWellFormed(email)) return;
        if (u.id.toString() == n.actorId) return;
        if (seen(email)) return;
        out_ ~= SupportMailRecipient(email, u.username, staff);
    }

    if (n.actorIsAdmin) {
        add(reporter, false);
        return out_;
    }
    if (n.assigneeId.length) {
        foreach (const ref a; admins)
            if (a.id.toString() == n.assigneeId) { add(a, true); return out_; }
        // Assignee row gone (deleted/demoted): fall through to everyone.
    }
    foreach (const ref a; admins)
        if (a.roles.canFind("admin")) add(a, true);
    return out_;
}

/// `[IRC Fiber support #12] …` — one line, the title last so a long one
/// gets cut by the client, not the verb.
string supportSubject(const SupportMailNotice n) @safe pure {
    const head = "[IRC Fiber support #" ~ n.number.to!string ~ "] ";
    switch (n.type) {
        case "issue_created":
            return head ~ "New " ~ n.kind ~ " from " ~ n.reporter ~ ": " ~ n.title;
        case "status_changed":
            return head ~ "Status: " ~ statusLabel(n.status) ~ " — " ~ n.title;
        case "comment_added":
            return head ~ (n.actorIsAdmin ? "Reply from " : "Follow-up from ") ~ n.actor
                ~ (n.reopened ? " (reopened)" : "") ~ ": " ~ n.title;
        default:
            return head ~ n.title;
    }
}

private string quoteText(string text) @safe pure {
    // Text part: indent the quoted change so it reads apart from the frame.
    string out_;
    foreach (line; text.strip().splitter('\n'))
        out_ ~= "    " ~ line ~ "\n";
    return out_;
}

private string htmlBlock(string text) @safe {
    return "<blockquote style=\"white-space:pre-wrap;border-left:3px solid #999;margin:0;padding:0 0 0 12px\">"
        ~ htmlEscape(text.strip()).idup ~ "</blockquote>";
}

/// Mail to the reporter after an admin acted on their issue. Links to the
/// Help & Feedback page (the reporter's own view), never the admin pane.
MailMessage supportReporterMail(const SupportMailNotice n, string toEmail, string publicUrl) @safe {
    MailMessage m;
    m.toEmail = toEmail;
    m.subject = supportSubject(n);
    const link = feedbackUrl(publicUrl);
    const issue = "#" ~ n.number.to!string ~ " \"" ~ n.title ~ "\"";
    const safeIssue = htmlEscape(issue).idup;
    const safeActor = htmlEscape(n.actor).idup;
    const safeLink = htmlAttribEscape(link).idup;
    const safeReporter = htmlEscape(n.reporter).idup;

    string lead, htmlLead;
    if (n.type == "status_changed") {
        lead = n.actor ~ " set your report " ~ issue ~ " to " ~ statusLabel(n.status)
            ~ (n.previousStatus.length ? " (was " ~ statusLabel(n.previousStatus) ~ ")" : "") ~ ".";
        htmlLead = "<p>" ~ safeActor ~ " set your report " ~ safeIssue ~ " to <b>"
            ~ htmlEscape(statusLabel(n.status)).idup ~ "</b>"
            ~ (n.previousStatus.length
                ? " (was " ~ htmlEscape(statusLabel(n.previousStatus)).idup ~ ")" : "")
            ~ ".</p>";
    } else {
        lead = n.actor ~ " replied to your report " ~ issue ~ ":";
        htmlLead = "<p>" ~ safeActor ~ " replied to your report " ~ safeIssue ~ ":</p>"
            ~ htmlBlock(n.text);
    }

    m.text = "Hi " ~ n.reporter ~ ",\n\n" ~ lead ~ "\n"
        ~ (n.type == "status_changed" ? "" : "\n" ~ quoteText(n.text))
        ~ "\nStatus: " ~ statusLabel(n.status) ~ "\n"
        ~ "\nView the conversation and reply from Help & Feedback:\n" ~ link ~ "\n";
    m.html = "<p>Hi " ~ safeReporter ~ ",</p>" ~ htmlLead
        ~ "<p>Status: <b>" ~ htmlEscape(statusLabel(n.status)).idup ~ "</b></p>"
        ~ "<p>View the conversation and reply from Help &amp; Feedback: "
        ~ "<a href=\"" ~ safeLink ~ "\">" ~ safeLink ~ "</a></p>";
    return m;
}

/// Mail to staff after the reporter acted. Links straight to the admin
/// triage page for the issue.
MailMessage supportStaffMail(const SupportMailNotice n, string toEmail, string publicUrl) @safe {
    MailMessage m;
    m.toEmail = toEmail;
    m.subject = supportSubject(n);
    const link = adminIssueUrl(publicUrl, n.issueId);
    const issue = "#" ~ n.number.to!string ~ " \"" ~ n.title ~ "\"";
    const safeIssue = htmlEscape(issue).idup;
    const safeReporter = htmlEscape(n.reporter).idup;
    const safeLink = htmlAttribEscape(link).idup;

    string lead, htmlLead;
    if (n.type == "issue_created") {
        lead = n.reporter ~ " filed a new " ~ n.kind ~ " report " ~ issue ~ ":";
        htmlLead = "<p>" ~ safeReporter ~ " filed a new " ~ htmlEscape(n.kind).idup
            ~ " report " ~ safeIssue ~ ":</p>";
    } else {
        lead = n.reporter ~ " followed up on " ~ issue
            ~ (n.reopened ? " (reopened)" : "") ~ ":";
        htmlLead = "<p>" ~ safeReporter ~ " followed up on " ~ safeIssue
            ~ (n.reopened ? " <b>(reopened)</b>" : "") ~ ":</p>";
    }

    m.text = lead ~ "\n\n" ~ quoteText(n.text)
        ~ "\nStatus: " ~ statusLabel(n.status) ~ " · Priority: " ~ n.priority ~ "\n"
        ~ "\nTriage: " ~ link ~ "\n";
    m.html = htmlLead ~ htmlBlock(n.text)
        ~ "<p>Status: <b>" ~ htmlEscape(statusLabel(n.status)).idup ~ "</b> · Priority: "
        ~ htmlEscape(n.priority).idup ~ "</p>"
        ~ "<p>Triage: <a href=\"" ~ safeLink ~ "\">" ~ safeLink ~ "</a></p>";
    return m;
}

/// Kind recorded in the mail-event log for every support send.
enum SUPPORT_MAIL_KIND = "support_notice";

/// Queues the notice for delivery and returns at once. Safe to call from a
/// request handler: nothing here can throw into the caller. The notice is
/// boxed: vibe-core caps task arguments at 128 bytes and the struct is
/// larger.
void notifySupportByMail(RedisStorage redis, SupportMailNotice n) {
    auto boxed = new SupportMailNotice;
    *boxed = n;
    try runTask(&deliverSupportMail, redis, boxed);
    catch (Exception e)
        logWarn("support-mail: could not queue %s for #%d: %s", n.type, n.number, e.msg);
}

private void deliverSupportMail(RedisStorage redis, SupportMailNotice* np) nothrow {
    try {
        const n = *np;
        auto mail = loadMailSettings();
        if (!mail.configured) return;

        auto users = new UserRepository();
        User reporter;
        User[] admins;
        if (n.actorIsAdmin) {
            if (n.reporterId.length)
                try reporter = users.findById(parseUUID(n.reporterId.idup));
                catch (Exception) {}
        } else {
            foreach (u; users.findAll(users.count() + 50, 0))
                if (u.roles.canFind("admin")) admins ~= u;
        }
        auto recipients = supportMailRecipients(n, reporter, admins);
        if (recipients.length == 0) {
            logInfo("support-mail: %s for #%d has no recipient", n.type, n.number);
            return;
        }

        const publicUrl = environment.get("IRCFIBER_PUBLIC_URL", "https://ircfiber.com");
        auto log = new MailEventLog(redis);
        foreach (const ref r; recipients) {
            const msg = r.staff
                ? supportStaffMail(n, r.email, publicUrl)
                : supportReporterMail(n, r.email, publicUrl);
            MailEvent ev;
            ev.atMs = Clock.currTime.toUnixTime!long * 1000;
            ev.kind = SUPPORT_MAIL_KIND;
            ev.toEmail = r.email;
            ev.username = r.username;
            ev.provider = mail.provider;
            const started = MonoTime.currTime;
            try {
                sendMail(mail, msg);
                ev.status = "sent";
                ev.durationMs = (MonoTime.currTime - started).total!"msecs";
                log.record(ev);
                logInfo("support-mail: %s for #%d sent to %s", n.type, n.number, r.username);
            } catch (Exception e) {
                ev.status = "failed";
                ev.error = e.msg;
                ev.durationMs = (MonoTime.currTime - started).total!"msecs";
                log.record(ev);
                logWarn("support-mail: %s for #%d to %s failed: %s", n.type, n.number, r.username, e.msg);
            }
        }
    } catch (Exception e) {
        try logWarn("support-mail: delivering %s for #%d failed: %s", np.type, np.number, e.msg);
        catch (Exception) {}
    }
}
