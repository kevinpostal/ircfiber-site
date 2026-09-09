/**
 * Provider-agnostic transactional mail send.
 *
 * Signup email verification (ircfiber.signup) delivers its confirm link
 * through here. Three providers:
 *   "resend" — Resend HTTP API (POST https://api.resend.com/emails, Bearer
 *              key from IRCFIBER_RESEND_API_KEY[_FILE]). One address string
 *              for `from`, an array for `to`, and a queued message answers
 *              with its `id`.
 *   "sender" — sender.net transactional HTTP API
 *              (POST https://api.sender.net/v2/message/send, Bearer token).
 *   "log"    — local-dev/smoke provider: logs the message (link included)
 *              and returns. Anything else (incl. unset) is unconfigured and
 *              every send throws.
 *
 * Both HTTP providers refuse to send until the sending domain's SPF/DKIM
 * (and, for sender.net, DMARC) records exist, and answer with a 4xx that
 * names the missing record — see deploy/README.md "Outbound mail".
 *
 * The API credential never appears in a log line or an exception message.
 */
module ircfiber.mail;
import std.conv : to;
import std.process : environment;
import std.string : strip;
import core.time : seconds;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : requestHTTP, HTTPClientRequest, HTTPClientResponse,
    HTTPClientSettings, HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;

struct MailSettings {
    /// "resend" | "sender" | "log" | "" (unconfigured)
    string provider;
    /// The selected provider's credential: IRCFIBER_RESEND_API_KEY[_FILE]
    /// for "resend", IRCFIBER_SENDER_API_TOKEN[_FILE] for "sender".
    string apiToken;
    string fromEmail = "no-reply@ircfiber.com";
    string fromName = "IRC Fiber";

    bool configured() const @safe pure nothrow @nogc {
        return provider == "log"
            || ((provider == "resend" || provider == "sender") && apiToken.length > 0);
    }
}

struct MailMessage {
    string toEmail;
    string subject;
    string text;
    string html;
    /// One-click unsubscribe URL for bulk campaign mail. Empty = no header.
    string listUnsubscribeUrl = "";
}

class MailException : Exception {
    this(string msg, string file = __FILE__, size_t line = __LINE__) @safe pure nothrow {
        super(msg, file, line);
    }
}

/// Env: IRCFIBER_MAIL_PROVIDER, the selected provider's credential (via
/// ircfiber.env.envSecret, so the `_FILE` form wins), IRCFIBER_MAIL_FROM,
/// IRCFIBER_MAIL_FROM_NAME.
MailSettings loadMailSettings() {
    MailSettings s;
    s.provider = environment.get("IRCFIBER_MAIL_PROVIDER", "").strip();
    // One field, one credential: each provider reads only its own env name,
    // so a host can keep both configured across a provider switch and the
    // unselected one is simply never read.
    s.apiToken = s.provider == "resend"
        ? envSecret("IRCFIBER_RESEND_API_KEY", "")
        : envSecret("IRCFIBER_SENDER_API_TOKEN", "");
    const from = environment.get("IRCFIBER_MAIL_FROM", "").strip();
    if (from.length > 0) s.fromEmail = from;
    const name = environment.get("IRCFIBER_MAIL_FROM_NAME", "").strip();
    if (name.length > 0) s.fromName = name;
    return s;
}

/// Pure: the exact JSON sender.net expects.
/// {"from":{"email","name"},"to":{"email"},"subject","text","html"}
Json senderNetPayload(const MailSettings s, const MailMessage m) @safe {
    Json from = Json.emptyObject;
    from["email"] = Json(s.fromEmail);
    from["name"] = Json(s.fromName);
    Json to = Json.emptyObject;
    to["email"] = Json(m.toEmail);
    Json payload = Json.emptyObject;
    payload["from"] = from;
    payload["to"] = to;
    payload["subject"] = Json(m.subject);
    payload["text"] = Json(m.text);
    payload["html"] = Json(m.html);
    return payload;
}

/// Pure: the exact JSON Resend expects. `from` is a single RFC 5322 address
/// ("IRC Fiber <no-reply@…>"), and `to` is an array even for one recipient.
/// A non-empty `listUnsubscribeUrl` adds `headers: {"List-Unsubscribe":
/// "<url>"}` (angle brackets are the RFC 2369 form). sender.net gets no
/// header: its template API has no verified headers surface, so campaign
/// sends there carry the unsubscribe link in the body footer only.
Json resendPayload(const MailSettings s, const MailMessage m) @safe {
    Json payload = Json.emptyObject;
    payload["from"] = Json(s.fromName.length > 0
        ? s.fromName ~ " <" ~ s.fromEmail ~ ">"
        : s.fromEmail);
    payload["to"] = Json([Json(m.toEmail)]);
    payload["subject"] = Json(m.subject);
    payload["text"] = Json(m.text);
    payload["html"] = Json(m.html);
    if (m.listUnsubscribeUrl.length > 0) {
        Json headers = Json.emptyObject;
        headers["List-Unsubscribe"] = Json("<" ~ m.listUnsubscribeUrl ~ ">");
        payload["headers"] = headers;
    }
    return payload;
}

/// Pure: 2xx AND the body carries the queued message's `id`. A refusal is
/// `{"statusCode":403,"message":"The … domain is not verified",…}` with no
/// id, and a 2xx without one would mean nothing was queued.
bool resendAccepted(int status, string body_) @safe {
    if (status < 200 || status >= 300) return false;
    Json parsed;
    try parsed = parseJsonString(body_);
    catch (Exception) return false;
    try {
        auto id = parsed["id"];
        return id.type == Json.Type.string && id.get!string.length > 0;
    } catch (Exception) {
        return false;
    }
}

/// Pure: 2xx AND body parses as JSON with `success == true`. Anything else
/// (incl. an unparseable body) is a failure.
bool senderNetAccepted(int status, string body_) @safe {
    if (status < 200 || status >= 300) return false;
    Json parsed;
    try parsed = parseJsonString(body_);
    catch (Exception) return false;
    try {
        auto success = parsed["success"];
        return success.type == Json.Type.bool_ && success.get!bool;
    } catch (Exception) {
        return false;
    }
}

/// Whitespace and control characters are rejected outright: the address is
/// interpolated into `NickServ REGISTER <password> <email>`, a space-delimited
/// services command.
bool emailWellFormed(string email) @safe pure nothrow @nogc {
    bool at = false, dot = false;
    foreach (char c; email) {
        if (c <= 0x20 || c == 0x7F) return false;
        if (c == '@') at = true;
        if (c == '.') dot = true;
    }
    return at && dot;
}

/// Body of the admin "send test email" action. No link, no user data — its
/// only job is to make the provider answer.
MailMessage adminTestEmail(string toEmail) @safe {
    MailMessage m;
    m.toEmail = toEmail;
    m.subject = "IRC Fiber mail test";
    m.text = "This is a test message from the IRC Fiber admin dashboard.\n"
        ~ "If you received it, transactional mail is working.\n";
    m.html = "<p>This is a test message from the IRC Fiber admin dashboard.</p>"
        ~ "<p>If you received it, transactional mail is working.</p>";
    return m;
}

/// Throws MailException on any failure. The token never appears in a log
/// or message.
void sendMail(const MailSettings s, const MailMessage m) {
    if (s.provider == "log") {
        logInfo("mail (log provider): to=%s subject=%s\n%s", m.toEmail, m.subject, m.text);
        return;
    }
    if (s.provider != "resend" && s.provider != "sender")
        throw new MailException("mail provider not configured");
    if (s.apiToken.length == 0)
        throw new MailException("mail provider not configured");

    const isResend = s.provider == "resend";
    const url = isResend
        ? "https://api.resend.com/emails"
        : "https://api.sender.net/v2/message/send";
    const payload = (isResend ? resendPayload(s, m) : senderNetPayload(s, m)).toString();

    // Mirrors anopePost (services/anope.d): one request per connection with
    // an explicit Content-Length, since vibe.d otherwise frames the body by
    // connection close.
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 10.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP(url,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                req.headers["Authorization"] = "Bearer " ~ s.apiToken;
                req.headers["Content-Type"] = "application/json";
                req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
                req.headers["Content-Length"] = payload.length.to!string;
                req.bodyWriter.write(cast(const(ubyte)[]) payload);
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try responseBody = cast(string) res.bodyReader.readAll();
                catch (Exception e)
                    logWarn("mail: reading %s response failed: %s", s.provider, e.msg);
            },
            settings);
    } catch (Exception e) {
        throw new MailException(s.provider ~ " request failed: " ~ e.msg);
    }
    const accepted = isResend
        ? resendAccepted(status, responseBody)
        : senderNetAccepted(status, responseBody);
    if (!accepted)
        throw new MailException(s.provider ~ " rejected the message: HTTP "
            ~ status.to!string ~ " " ~ responseBody);
}
