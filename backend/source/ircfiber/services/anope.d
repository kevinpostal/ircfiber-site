/**
 * Anope 2.0 XML-RPC client (`m_httpd` + `m_xmlrpc` + `m_xmlrpc_main`).
 *
 * Anope cannot be told "register account X" over IRC: `NickServ REGISTER`
 * registers the nick of the *sending* connection, and at signup time the
 * engine already holds the user's nick. `m_xmlrpc_main`'s `command` method
 * runs a services command as an arbitrary nick — online or offline — which
 * is the mechanism `ircfiber.services.accounts` uses.
 *
 * Transport (see Anope `modules/m_xmlrpc.cpp`): HTTP POST to `/xmlrpc` with
 * `Content-Type: text/xml`. The request parser is naive — it takes
 * `<methodName>` and then every `<string>` element in document order as
 * positional parameters, so every parameter must be XML-escaped. The reply
 * is always a `methodResponse` holding one struct; for `command` its members
 * are `result` (`Success`) and `return` (the services output text).
 *
 * Escaping, verified against anope/anope:2.0.20 (probe: `command NickServ
 * <nick> "FOO>Z"` → `Unknown command FOOgt&amp;qt;Z`):
 *   - Request `<string>` values ARE XML-unescaped by Anope, so every
 *     parameter must be escaped on the way out (`anopeXmlEscape`).
 *   - Reply text is escaped TWICE — `Sanitize()` runs on the services reply
 *     and again when m_xmlrpc serializes the struct. So a newline arrives as
 *     `&amp;#xA;` and '>' as `&amp;qt;` (`&qt;` is an upstream typo for
 *     `&gt;`). `decodeAnopeReply` therefore unescapes exactly twice.
 *
 * The listener has no authentication of its own; it is only reachable from
 * the services container's docker network (see
 * `site/deploy/roles/ircd/templates/services.conf.j2`).
 *
 * Env:
 *   IRCFIBER_ANOPE_RPC_URL      full endpoint, e.g. http://services:8080/xmlrpc
 *                               (empty → auto-registration disabled)
 *   IRCFIBER_ANOPE_RPC_TIMEOUT  connect/read timeout in seconds (default 10)
 */
module ircfiber.services.anope;

import std.ascii : isDigit, isHexDigit;
import std.conv : to;
import std.process : environment;
import std.string : indexOf, strip;
import std.utf : encode;
import core.time : seconds;

import vibe.core.log;
import vibe.http.client : requestHTTP, HTTPClientRequest, HTTPClientResponse,
    HTTPClientSettings, HTTPMethod;
import vibe.stream.operations : readAll;

/// Endpoint configuration read from the environment.
struct AnopeSettings {
    string rpcUrl;             /// IRCFIBER_ANOPE_RPC_URL; "" disables provisioning
    int timeoutSeconds = 10;   /// IRCFIBER_ANOPE_RPC_TIMEOUT

    bool configured() const @safe pure nothrow @nogc { return rpcUrl.length > 0; }
}

AnopeSettings loadAnopeSettings() {
    AnopeSettings s;
    s.rpcUrl = environment.get("IRCFIBER_ANOPE_RPC_URL", "").strip();
    const raw = environment.get("IRCFIBER_ANOPE_RPC_TIMEOUT", "").strip();
    if (raw.length) {
        try {
            const v = raw.to!int;
            if (v > 0 && v <= 120) s.timeoutSeconds = v;
        } catch (Exception) {
            // keep the default; a bad env value must not disable provisioning
        }
    }
    return s;
}

/// One decoded XML-RPC struct response.
struct AnopeReply {
    bool transportOk;       /// HTTP 200 and a parseable methodResponse
    string result;          /// "result" member ("Success")
    string error;           /// "error" member ("Invalid parameters"/"Invalid service")
    string text;            /// "return" member, unescaped
    string transportError;  /// non-empty when transportOk is false
    /// Every member of the returned struct, decoded. `command` only ever
    /// sets result/error/return; `user` returns nick plus, when a live user
    /// object exists, ident/host/ip/timestamp/signon.
    string[string] members;
}

/// XML-escape one parameter value. `&` must be replaced first.
string anopeXmlEscape(string s) @safe pure {
    string res;
    foreach (char c; s) {
        switch (c) {
            case '&':  res ~= "&amp;";  break;
            case '"':  res ~= "&quot;"; break;
            case '<':  res ~= "&lt;";   break;
            case '>':  res ~= "&gt;";   break;
            case '\'': res ~= "&#39;";  break;
            default:   res ~= c;        break;
        }
    }
    return res;
}

/// Decode the entities Anope's `Sanitize()` produces, plus generic numeric
/// character references. Unknown entities are left verbatim.
string anopeXmlUnescape(string s) @safe pure {
    if (s.indexOf('&') < 0) return s;
    string res;
    size_t i = 0;
    while (i < s.length) {
        if (s[i] != '&') {
            res ~= s[i];
            i++;
            continue;
        }
        const semi = s[i .. $].indexOf(';');
        if (semi <= 0) {
            res ~= s[i];
            i++;
            continue;
        }
        const ent = s[i + 1 .. i + semi];
        const next = i + semi + 1;
        switch (ent) {
            case "amp":  res ~= '&';  i = next; continue;
            case "quot": res ~= '"';  i = next; continue;
            case "apos": res ~= '\''; i = next; continue;
            case "lt":   res ~= '<';  i = next; continue;
            // "qt" is Anope's Sanitize() typo for '>'; both spellings appear.
            case "gt":
            case "qt":   res ~= '>';  i = next; continue;
            default: break;
        }
        if (ent.length >= 2 && ent[0] == '#') {
            uint code = 0;
            bool ok = true;
            const hex = ent[1] == 'x' || ent[1] == 'X';
            const digits = hex ? ent[2 .. $] : ent[1 .. $];
            if (!digits.length) ok = false;
            foreach (char d; digits) {
                if (hex) {
                    if (!isHexDigit(d)) { ok = false; break; }
                    code = code * 16 + hexValue(d);
                } else {
                    if (!isDigit(d)) { ok = false; break; }
                    code = code * 10 + cast(uint)(d - '0');
                }
                if (code > 0x10FFFF) { ok = false; break; }
            }
            if (ok && code != 0 && !(code >= 0xD800 && code <= 0xDFFF)) {
                char[4] buf;
                const n = encode(buf, cast(dchar) code);
                res ~= buf[0 .. n];
                i = next;
                continue;
            }
        }
        res ~= s[i];
        i++;
    }
    return res;
}

private uint hexValue(char c) @safe pure nothrow @nogc {
    if (c >= '0' && c <= '9') return cast(uint)(c - '0');
    if (c >= 'a' && c <= 'f') return cast(uint)(c - 'a') + 10;
    return cast(uint)(c - 'A') + 10;
}

/**
 * Recover the true reply text. m_xmlrpc_main sanitizes the services reply and
 * m_xmlrpc sanitizes again when it serializes the struct, so every value in a
 * `methodResponse` is escaped exactly twice: a newline reaches us as
 * `&amp;#xA;`, '>' as `&amp;qt;`, '&' as `&amp;amp;`. Two passes invert two
 * passes exactly, including for text that legitimately contains entities.
 * Unescaped words like `Success` are unaffected.
 */
string decodeAnopeReply(string s) @safe pure {
    return anopeXmlUnescape(anopeXmlUnescape(s));
}

/// Build the request body. Every parameter is emitted as its own `<string>`
/// element, in order, which is exactly what m_xmlrpc's parser consumes.
string buildXmlRpcCall(string method, const string[] params) @safe pure {
    string res = `<?xml version="1.0"?><methodCall><methodName>`;
    res ~= anopeXmlEscape(method);
    res ~= `</methodName><params>`;
    foreach (p; params) {
        res ~= `<param><value><string>`;
        res ~= anopeXmlEscape(p);
        res ~= `</string></value></param>`;
    }
    res ~= `</params></methodCall>`;
    return res;
}

/// Pull the first `<tag>…</tag>` payload out of `chunk`.
private string innerText(string chunk, string tag) @safe pure {
    const open = "<" ~ tag ~ ">";
    const a = chunk.indexOf(open);
    if (a < 0) return "";
    const from = a + open.length;
    const b = chunk[from .. $].indexOf("</" ~ tag ~ ">");
    if (b < 0) return "";
    return chunk[from .. from + b];
}

/// Decode the flat `<member><name>K</name><value><string>V</string>…` struct
/// m_xmlrpc always returns. Anything else is a transport failure.
AnopeReply parseXmlRpcResponse(string body_) @safe pure {
    AnopeReply r;
    if (body_.indexOf("<methodResponse") < 0) {
        r.transportError = "malformed XML-RPC response";
        return r;
    }
    r.transportOk = true;

    enum memberOpen = "<member>";
    enum memberClose = "</member>";
    size_t pos = 0;
    while (pos < body_.length) {
        const rel = body_[pos .. $].indexOf(memberOpen);
        if (rel < 0) break;
        const start = pos + rel + memberOpen.length;
        const closeRel = body_[start .. $].indexOf(memberClose);
        const end = closeRel < 0 ? body_.length : start + closeRel;
        pos = closeRel < 0 ? body_.length : end + memberClose.length;

        const chunk = body_[start .. end];
        const key = innerText(chunk, "name");
        if (!key.length) continue;
        const val = decodeAnopeReply(innerText(chunk, "string"));
        r.members[key] = val;
        switch (key) {
            case "result": r.result = val; break;
            case "error":  r.error = val;  break;
            case "return": r.text = val;   break;
            default: break;
        }
    }
    return r;
}

/// First whitespace-delimited word, used to log a command verb without its
/// arguments (`REGISTER <password> <email>` must never reach the log).
private string commandVerb(string command) @safe pure nothrow @nogc {
    foreach (i, char c; command)
        if (c == ' ' || c == '\t') return command[0 .. i];
    return command;
}

/// Services replies are newline-terminated and sometimes multi-line. Callers
/// only classify and log them (and store them in a Redis skip key), so give
/// them one line.
string flattenReplyText(string text) @safe pure {
    string res;
    foreach (char c; text) res ~= (c == '\n' || c == '\r' || c == '\t') ? ' ' : c;
    return res.strip();
}

/**
 * POST one prebuilt XML-RPC body. `label` is what reaches the log — callers
 * must keep secrets out of it (`REGISTER <password>` never appears).
 * Fiber-aware; never throws: transport problems land in `transportError`
 * with `transportOk == false`.
 */
private AnopeReply anopePost(AnopeSettings s, string payload, string label) {
    AnopeReply r;
    if (!s.configured) {
        r.transportError = "Anope RPC not configured";
        return r;
    }

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = s.timeoutSeconds.seconds;
    settings.readTimeout = s.timeoutSeconds.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP(s.rpcUrl,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                req.headers["Content-Type"] = "text/xml";
                req.bodyWriter.write(cast(const(ubyte)[]) payload);
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try responseBody = cast(string) res.bodyReader.readAll();
                catch (Exception e)
                    logWarn("anope rpc: reading %s response failed: %s", label, e.msg);
            },
            settings);
    } catch (Exception e) {
        r.transportError = e.msg;
        logWarn("anope rpc: %s failed: %s", label, e.msg);
        return r;
    }

    if (status != 200) {
        r.transportError = "HTTP " ~ status.to!string;
        logWarn("anope rpc: %s returned HTTP %s", label, status);
        return r;
    }

    r = parseXmlRpcResponse(responseBody);
    r.text = flattenReplyText(r.text);
    if (!r.transportOk)
        logWarn("anope rpc: %s returned an unparseable body (%s bytes)",
                label, responseBody.length);
    return r;
}

/**
 * Run `command` on `service` as if `asNick` had sent it. The nick may be
 * online or offline.
 *
 * Beware the side effect this exists for and must be guarded against: when
 * `asNick` is online, `ns_register` finishes with `u->Identify(na)`, so the
 * live session on that nick is logged into the new account (observed:
 * `900 … :You are now logged in as <nick>` plus `MODE +r` delivered to that
 * client). Only ever register a nick you know belongs to your own session —
 * see `anopeNickOnline`.
 */
AnopeReply anopeCommand(AnopeSettings s, string service, string asNick, string command) {
    return anopePost(s, buildXmlRpcCall("command", [service, asNick, command]),
                     service ~ " " ~ commandVerb(command) ~ " as " ~ asNick);
}

/**
 * `m_xmlrpc_main`'s `user` method: presence lookup for any nick, registered
 * or not (`NickServ STATUS` cannot do this — it reports identification, so an
 * online unregistered nick answers 0 exactly like an offline one).
 */
AnopeReply anopeUser(AnopeSettings s, string nick) {
    return anopePost(s, buildXmlRpcCall("user", [nick]), "user " ~ nick);
}

/**
 * True when the `user` reply describes a live session. The method echoes the
 * queried nick back in `nick` even when nobody is online, so `nick` is not a
 * presence signal; the fields Anope only adds when it found a `User` object
 * are (see `DoUser` in 2.0.20: ident, vident, host, ip, timestamp, signon).
 */
bool anopeUserOnline(const AnopeReply r) @safe pure {
    if (!r.transportOk) return false;
    static immutable string[] liveFields = ["ident", "vident", "host", "ip", "timestamp", "signon"];
    foreach (f; liveFields)
        if (f in r.members) return true;
    return false;
}

/**
 * Services commands are whitespace-delimited, so an argument carrying
 * whitespace or control characters would inject extra parameters into the
 * command Anope runs (`REGISTER <pw> <email>` becoming `REGISTER <pw> <x> <y>`).
 * Every value interpolated into a command MUST pass this first.
 */
bool isSafeServicesArg(string s) @safe pure nothrow @nogc {
    if (s.length == 0) return false;
    foreach (char c; s)
        if (c <= 0x20 || c == 0x7F) return false;
    return true;
}

/// Whether a nick can still be claimed on this network.
enum NickRegistration {
    free,              /// no NickServ account owns it
    registered,        /// somebody already owns it
    servicesReserved,  /// it is a service bot (NickServ, ChanServ, …)
    unknown            /// Anope unreachable or an unrecognised reply
}

/**
 * Classify a `NickServ INFO <nick>` reply (see `ns_info.cpp`):
 *   - no alias        → `Nick \2X\2 isn't registered.`
 *   - a service bot   → `Nick \2X\2 is part of this Network's Services.`
 *   - registered      → `X is <realname>` followed by an `Account: …` line,
 *                       which `ns_info` emits for every caller regardless of
 *                       the account's PRIVATE/HIDE_* options.
 *
 * `Account:` is tested first because it is the only marker that cannot be
 * forged: the not-registered reply echoes the queried nick, so a nick called
 * "Account" would otherwise read as registered.
 */
NickRegistration classifyNickInfoReply(string text) @safe pure {
    import std.uni : toLower;
    const t = text.toLower();
    if (t.indexOf("account:") >= 0) return NickRegistration.registered;
    if (t.indexOf("part of this network's services") >= 0) return NickRegistration.servicesReserved;
    if (t.indexOf("isn't registered") >= 0 || t.indexOf("is not registered") >= 0)
        return NickRegistration.free;
    return NickRegistration.unknown;
}

/// Ask whether `nick` is claimable. `unknown` on any transport problem, so
/// callers decide explicitly whether to fail open or closed.
NickRegistration anopeNickRegistration(AnopeSettings s, string nick) {
    if (!isSafeServicesArg(nick)) return NickRegistration.unknown;
    auto r = anopeCommand(s, "NickServ", nick, "INFO " ~ nick);
    if (!r.transportOk) return NickRegistration.unknown;
    return classifyNickInfoReply(r.text);
}

/**
 * Verify an account/password pair through the same code path SASL PLAIN uses
 * (`m_xmlrpc_main`'s `checkAuthentication` → `OnCheckAuthentication`). Used to
 * prove a freshly generated credential actually works before it is persisted
 * and shown to the user. `determined` is false when Anope was unreachable.
 */
bool anopeCheckAuthentication(AnopeSettings s, string account, string password, out bool determined) {
    determined = false;
    if (!isSafeServicesArg(account) || !isSafeServicesArg(password)) return false;
    auto r = anopePost(s, buildXmlRpcCall("checkAuthentication", [account, password]),
                       "checkAuthentication " ~ account);
    if (!r.transportOk) return false;
    determined = true;
    if (r.result == "Success") return true;
    if (r.error.length)
        logWarn("anope rpc: checkAuthentication %s rejected: %s", account, r.error);
    return false;
}
