/**
 * Pure formatting for the #support bot: announcement lines for outbox
 * events, `!issues` / `!issue <n>` / `!help` replies and the command
 * parser. No IO — covered by `tests/support_format_test.d`.
 *
 * Lines never contain a report body, e-mail or diagnostics: only the
 * issue number, kind, title (≤80 chars), usernames and the admin link.
 */
module ircfiber.support.format;

import std.algorithm : min;
import std.array : replace;
import std.conv : to;
import std.string : strip, indexOf, toLower, split;
import std.utf : stride;

import ircfiber.db.support_issues : SupportIssueRecord, supportStatuses;
import ircfiber.support.events : SupportEvent;
import ircfiber.support.json : sanitizeLine;

/// Hard cap for one announcement line (bytes, before the PRIVMSG prefix).
enum SUPPORT_LINE_MAX_BYTES = 400;
/// Title length (code points) shown on IRC.
enum SUPPORT_TITLE_MAX_CHARS = 80;
/// Rows listed by `!issues`.
enum SUPPORT_SUMMARY_ROWS = 5;

/// Cuts `s` to at most `max` code points; when cut, the last kept code point
/// is replaced by `…` so the result still fits in `max`. Never splits a
/// multi-byte sequence.
string truncateText(string s, size_t max) @safe pure {
    if (max == 0) return "";
    size_t i = 0;       // byte offset
    size_t chars = 0;   // code points seen
    size_t cutAt = 0;   // byte offset after (max-1) code points
    try {
        while (i < s.length) {
            if (chars == max - 1) cutAt = i;
            i += stride(s, i);
            chars++;
            if (chars > max) return s[0 .. cutAt] ~ "…";
        }
    } catch (Exception) {
        // Not valid UTF-8 (cannot happen for JSON-sourced text) — fall
        // back to a byte clip so we still never emit an over-long line.
        return s.length > max ? clipBytes(s, max) ~ "…" : s;
    }
    return s;
}

/// Cuts `s` to at most `maxBytes` bytes without splitting a UTF-8 sequence.
string clipBytes(string s, size_t maxBytes) @safe pure nothrow @nogc {
    if (s.length <= maxBytes) return s;
    size_t cut = maxBytes;
    while (cut > 0 && (s[cut] & 0xC0) == 0x80) cut--;
    return s[0 .. cut];
}

/// "just now" | "5m ago" | "3h ago" | "2d ago".
string relativeAge(long ms, long nowMs) @safe pure {
    long delta = nowMs - ms;
    if (delta < 0) delta = 0;
    const secs = delta / 1000;
    if (secs < 60) return "just now";
    if (secs < 3600) return (secs / 60).to!string ~ "m ago";
    if (secs < 86_400) return (secs / 3600).to!string ~ "h ago";
    return (secs / 86_400).to!string ~ "d ago";
}

/// `https://ircfiber.com/admin#/support/<id>` (trailing `/` of `publicUrl` dropped).
string adminIssueUrl(string publicUrl, string issueId) @safe pure {
    auto base = publicUrl.strip();
    while (base.length && base[$ - 1] == '/') base = base[0 .. $ - 1];
    return base ~ "/admin#/support/" ~ issueId;
}

/// `<publicUrl>/?/feedback`.
string feedbackUrl(string publicUrl) @safe pure {
    auto base = publicUrl.strip();
    while (base.length && base[$ - 1] == '/') base = base[0 .. $ - 1];
    return base ~ "/?/feedback";
}

/// Status wire value → display (`in_progress` → `in progress`).
string statusLabel(string status) @safe pure {
    return status.replace("_", " ");
}

private string ircTitle(string title) @safe pure {
    return truncateText(sanitizeLine(title), SUPPORT_TITLE_MAX_CHARS);
}

private string ircName(string name) @safe pure {
    auto n = sanitizeLine(name);
    return n.length ? n : "someone";
}

private string finish(string line) @safe pure nothrow @nogc {
    return clipBytes(line, SUPPORT_LINE_MAX_BYTES);
}

/// One IRC line per event; empty for unknown event types.
///
/// - issue_created:  `New issue #12 [bug] "Title" — reported by zodiac · <admin url>`
/// - status_changed: `Issue #12 → in progress (by kevin) — "Title"`
/// - comment_added:  `Issue #12 — new reply from kevin (admin) — "Title" · <admin url>`
///                   (`(reporter)` for the reporter; ` · reopened` appended when it reopened the issue)
/// - notice:         `Notice from kevin: <title>` — free text queued from the admin IRCD page
string[] formatSupportEvent(const SupportEvent ev, string publicUrl) @safe pure {
    const num = "#" ~ ev.number.to!string;
    const title = "\"" ~ ircTitle(ev.title) ~ "\"";
    const url = adminIssueUrl(publicUrl, ev.issueId);
    switch (ev.type) {
        case "issue_created":
            return [finish("New issue " ~ num ~ " [" ~ sanitizeLine(ev.kind) ~ "] " ~ title
                ~ " — reported by " ~ ircName(ev.reporter) ~ " · " ~ url)];
        case "status_changed":
            return [finish("Issue " ~ num ~ " → " ~ statusLabel(sanitizeLine(ev.status))
                ~ " (by " ~ ircName(ev.actor) ~ ") — " ~ title)];
        case "comment_added":
            auto line = "Issue " ~ num ~ " — new reply from " ~ ircName(ev.actor)
                ~ (ev.actorIsAdmin ? " (admin)" : " (reporter)") ~ " — " ~ title ~ " · " ~ url;
            if (ev.reopened) line ~= " · reopened";
            return [finish(line)];
        case "notice":
            const text = sanitizeLine(ev.title);
            if (!text.length) return [];
            return [finish("Notice from " ~ ircName(ev.actor) ~ ": " ~ text)];
        default:
            return [];
    }
}

/// A parsed `!command`.
struct BotCommand {
    /// Lower-cased command word without the `!` ("" when not a command).
    string name;
    /// Remaining text, stripped.
    string arg;
    /// True for a known command with a well-formed argument.
    bool ok;
}

/// Parses `!help`, `!issues [open|all]`, `!issue <n>`, `!adduser <nick>`,
/// `!nsinfo <nick>`. Anything else is
/// returned with `ok=false`; unknown `!words` keep their `name` so the
/// caller can stay silent for them.
BotCommand parseBotCommand(string text) @safe pure {
    BotCommand c;
    auto s = text.strip();
    if (s.length < 2 || s[0] != '!') return c;
    s = s[1 .. $];
    auto sp = s.indexOf(' ');
    if (sp < 0) { c.name = s.toLower(); c.arg = ""; }
    else { c.name = s[0 .. sp].toLower(); c.arg = s[sp + 1 .. $].strip(); }
    switch (c.name) {
        case "help":
            c.ok = true;
            break;
        case "issues":
            c.arg = c.arg.toLower();
            c.ok = c.arg == "" || c.arg == "open" || c.arg == "all";
            break;
        case "issue":
            c.ok = c.arg.length > 0 && c.arg.length <= 9 && isDigits(c.arg) && c.arg != "0";
            break;
        case "adduser":
        case "nsinfo":
            // Exactly one whitespace-free token, 1–32 chars. Charset is
            // deliberately loose here; the handler enforces the strict
            // `isValidIrcNick` gate signup uses. Arg case preserved.
            c.ok = isSingleNickToken(c.arg);
            break;
        default:
            break;
    }
    return c;
}

private bool isSingleNickToken(string s) @safe pure nothrow @nogc {
    if (s.length == 0 || s.length > 32) return false;
    foreach (ch; s) {
        if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == '\v' || ch == '\f') return false;
    }
    return true;
}

private bool isDigits(string s) @safe pure nothrow @nogc {
    foreach (ch; s) if (ch < '0' || ch > '9') return false;
    return true;
}

/// `Support: 3 open · 1 in progress · 12 resolved · 2 closed` followed by
/// up to `SUPPORT_SUMMARY_ROWS` rows `#12 [bug] Title — zodiac, 2h ago`.
string[] formatIssuesSummary(long[string] counts, const SupportIssueRecord[] recent,
                             long nowMs, string publicUrl) @safe pure {
    string head = "Support:";
    bool first = true;
    foreach (s; supportStatuses) {
        head ~= (first ? " " : " · ") ~ counts.get(s, 0).to!string ~ " " ~ statusLabel(s);
        first = false;
    }
    string[] lines = [finish(head)];
    foreach (i, ref r; recent) {
        if (i >= SUPPORT_SUMMARY_ROWS) break;
        lines ~= finish("#" ~ r.number.to!string ~ " [" ~ sanitizeLine(r.kind) ~ "] " ~ ircTitle(r.title)
            ~ " — " ~ ircName(r.reporterUsername) ~ ", " ~ relativeAge(r.createdAt, nowMs));
    }
    if (recent.length == 0) lines ~= "No matching issues · report problems at " ~ feedbackUrl(publicUrl);
    return lines;
}

/// `#12 [bug · open · normal] Title — reported by zodiac 2h ago · assignee: — · <admin url>`
string[] formatIssueDetail(const SupportIssueRecord r, long nowMs, string publicUrl) @safe pure {
    return [finish("#" ~ r.number.to!string ~ " [" ~ sanitizeLine(r.kind) ~ " · "
        ~ statusLabel(sanitizeLine(r.status)) ~ " · " ~ sanitizeLine(r.priority) ~ "] " ~ ircTitle(r.title)
        ~ " — reported by " ~ ircName(r.reporterUsername) ~ " " ~ relativeAge(r.createdAt, nowMs)
        ~ " · assignee: " ~ (r.assigneeUsername.length ? sanitizeLine(r.assigneeUsername) : "—")
        ~ " · " ~ adminIssueUrl(publicUrl, r.id))];
}

/// Bot help line.
string[] formatHelp(string publicUrl) @safe pure {
    return ["FiberSupport: !issues [open|all] — recent issues · !issue <n> — details · !adduser <nick> — create a site account from a NickServ account, or send a signup link when there is none · !nsinfo <nick> — show NickServ account info (opers only) · report problems at "
        ~ feedbackUrl(publicUrl)];
}

/// Reply for a malformed `!issue` / `!issues`.
enum SUPPORT_USAGE = "Usage: !issues [open|all] · !issue <n> · !adduser <nick> · !nsinfo <nick> (last two: opers only)";
