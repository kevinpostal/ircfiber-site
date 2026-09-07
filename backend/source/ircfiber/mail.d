/**
 * Provider-agnostic transactional mail send.
 *
 * Signup email verification (ircfiber.signup) delivers its confirm link
 * through here. Two providers:
 *   "sender" — sender.net transactional HTTP API
 *              (POST https://api.sender.net/v2/message/send, Bearer token).
 *   "log"    — local-dev/smoke provider: logs the message (link included)
 *              and returns. Anything else (incl. unset) is unconfigured and
 *              every send throws.
 *
 * The API token never appears in a log line or an exception message.
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
    /// "sender" | "log" | "" (unconfigured)
    string provider;
    /// sender.net API token (IRCFIBER_SENDER_API_TOKEN[_FILE]).
    string apiToken;
    string fromEmail = "no-reply@ircfiber.com";
    string fromName = "IRC Fiber";

    bool configured() const @safe pure nothrow @nogc {
        return provider == "log" || (provider == "sender" && apiToken.length > 0);
    }
}

struct MailMessage {
    string toEmail;
    string subject;
    string text;
    string html;
}

class MailException : Exception {
    this(string msg, string file = __FILE__, size_t line = __LINE__) @safe pure nothrow {
        super(msg, file, line);
    }
}

/// Env: IRCFIBER_MAIL_PROVIDER, IRCFIBER_SENDER_API_TOKEN (via
/// ircfiber.env.envSecret, so IRCFIBER_SENDER_API_TOKEN_FILE wins),
/// IRCFIBER_MAIL_FROM, IRCFIBER_MAIL_FROM_NAME.
MailSettings loadMailSettings() {
    MailSettings s;
    s.provider = environment.get("IRCFIBER_MAIL_PROVIDER", "").strip();
    s.apiToken = envSecret("IRCFIBER_SENDER_API_TOKEN", "");
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

/// Throws MailException on any failure. The token never appears in a log
/// or message.
void sendMail(const MailSettings s, const MailMessage m) {
    if (s.provider == "log") {
        logInfo("mail (log provider): to=%s subject=%s\n%s", m.toEmail, m.subject, m.text);
        return;
    }
    if (s.provider != "sender")
        throw new MailException("mail provider not configured");
    if (s.apiToken.length == 0)
        throw new MailException("mail provider not configured");

    const payload = senderNetPayload(s, m).toString();

    // Mirrors anopePost (services/anope.d): one request per connection with
    // an explicit Content-Length, since vibe.d otherwise frames the body by
    // connection close.
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 10.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP("https://api.sender.net/v2/message/send",
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
                    logWarn("mail: reading sender.net response failed: %s", e.msg);
            },
            settings);
    } catch (Exception e) {
        throw new MailException("sender.net request failed: " ~ e.msg);
    }
    if (!senderNetAccepted(status, responseBody))
        throw new MailException("sender.net rejected the message: HTTP "
            ~ status.to!string ~ " " ~ responseBody);
}
