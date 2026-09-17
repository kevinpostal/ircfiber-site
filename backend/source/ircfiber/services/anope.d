/**
 * Anope 2.1 JSON-RPC client (`httpd` + `jsonrpc` + `rpc_user` + `rpc_data`).
 *
 * Anope cannot be told "register account X" over IRC: `NickServ REGISTER`
 * registers the nick of the *sending* connection, and at signup time the
 * engine already holds the user's nick. `anope.command` runs a services
 * command as an account — or as an unregistered nick, thanks to our image's
 * `rpc_user { allowunregistered = yes }` (`CommandSource(<that nick>,
 * nullptr, nullptr, ...)`), which is the mechanism
 * `ircfiber.services.accounts` uses. With a null user `ns_register`
 * registers `source.GetNick()` and does NOT identify any live session, so
 * the old 2.0 hijack side effect (`u->Identify(na)` on whoever holds the
 * nick) is gone; the presence guard in `accounts.d` stays anyway.
 *
 * Transport (Anope `modules/rpc/jsonrpc.cpp`): HTTP POST to `/jsonrpc` with
 * `Content-Type: application/json`, body
 * `{"jsonrpc":"2.0","id":"<any>","method":"<m>","params":["<str>",...]}` —
 * every param MUST be a JSON string (non-strings become ""). The reply is
 * `{"jsonrpc":"2.0","id":...,"result":<value>}` or
 * `{"jsonrpc":"2.0","id":...,"error":{"code":<int>,"message":"..."}}`.
 * Auth is `Authorization: Bearer <base64(token)>` — the listener
 * base64-DECODES the credential before comparing, so the raw token is
 * encoded here, never sent verbatim. Sending it raw answers
 * `-32601 No authorization for method: ...`.
 *
 * For `anope.command` the `result` is an ARRAY of strings, one per reply
 * line, with IRC formatting already stripped (`Anope::RemoveFormatting`).
 * Unknown commands (`No such command`) and refusals (`Access denied.`,
 * `Nick X isn't registered.`) arrive through the two reply shapes exactly
 * as before: refusals are ordinary result lines, while `No such command` /
 * `No such account` / `No such service` are JSON-RPC `error` objects — a
 * refusal by services, never a transport failure, so they land in
 * `AnopeReply.text` with `errorCode` set instead of failing the call.
 *
 * One request per connection, forced on the request headers below, with an
 * explicit Content-Length. `defaultKeepAliveTimeout = 0` was the obvious
 * knob and it does NOT work: prod kept logging `Connection closed while
 * writing` and 404s with an 18-byte body ("Unrecognized page") after it was
 * deployed on the old transport. vibe.d writes `Connection: keep-alive`
 * itself (client.d:727) and then derives
 * `close_conn` from whatever the requester left in that header
 * (client.d:750), so the header is the lever that actually decides.
 *
 * Why it matters: Anope's `httpd` is a hand-rolled server that does not
 * serve a second request on a connection. Reusing one makes it read the
 * next POST body as a request line — hence "Unrecognized page" rather than
 * a JSON fault — or, if it closed first, the write fails outright.
 * Observed 2026-09-06 (same httpd under the old transport): a deletion's
 * `INFO` answered 200 and the `DROP` behind it 404'd, leaving the account
 * standing; and every provisioning credential check failed the same way,
 * which is what produced prod's 10 orphan pending credentials.
 * No address-family pin: the listener binds `::` (see the httpd block in
 * services.conf.j2), which on Linux accepts IPv4 too, so either record of
 * the dual-stack `services` alias works.
 *
 * Without an explicit Content-Length vibe.d sends neither Content-Length
 * nor chunked encoding and lets the body run to connection close; `httpd`'s
 * naive parser then reads whatever has arrived so far, and when headers and
 * body land in separate TCP segments it parses an empty body and answers
 * 404 "Unrecognized query". Observed 2026-09-06/07 on prod: curl (which
 * always sets Content-Length) never failed while back-to-back gateway calls
 * failed intermittently. Proven by capturing vibe.d's exact bytes (no
 * Content-Length present) against a dump server.
 *
 * Env:
 *   IRCFIBER_ANOPE_RPC_URL      full endpoint, e.g. http://services:8080/jsonrpc
 *                               (empty → services surface disabled)
 *   IRCFIBER_ANOPE_RPC_TOKEN    Bearer token, raw (or _FILE indirection via
 *                               `ircfiber.env.envSecret`); the gateway
 *                               base64-encodes it into the header itself.
 *                               Empty → services surface disabled.
 *   IRCFIBER_ANOPE_RPC_TIMEOUT  connect/read timeout in seconds (default 10)
 *   IRCFIBER_ANOPE_OPER_ACCOUNT NickServ account privileged commands run as
 *                               (empty → privileged actions disabled)
 */
module ircfiber.services.anope;

import std.base64 : Base64;
import std.conv : to;
import std.process : environment;
import std.string : indexOf, splitLines, strip;
import std.array : join;
import core.time : seconds;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : requestHTTP, HTTPClientRequest, HTTPClientResponse,
    HTTPClientSettings, HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;

/// Endpoint configuration read from the environment.
struct AnopeSettings {
    string rpcUrl;             /// IRCFIBER_ANOPE_RPC_URL; "" disables the surface
    string token;              /// IRCFIBER_ANOPE_RPC_TOKEN, raw (not yet base64)
    int timeoutSeconds = 10;   /// IRCFIBER_ANOPE_RPC_TIMEOUT
    string operAccount;        /// IRCFIBER_ANOPE_OPER_ACCOUNT; "" = no privileged ops

    /// Both RPC inputs are required: the listener rejects a missing or wrong
    /// token with `No authorization for method`, so a half-configured
    /// endpoint must read as disabled, not as usable.
    bool configured() const @safe pure nothrow @nogc {
        return rpcUrl.length > 0 && token.length > 0;
    }
    /// Whether privileged services commands can be attempted at all. The
    /// account must also be tied to an Anope opertype, which only Anope
    /// knows — a misconfiguration there surfaces as `Access denied.`
    bool hasOper() const @safe pure nothrow @nogc { return operAccount.length > 0; }
}

AnopeSettings loadAnopeSettings() {
    AnopeSettings s;
    s.rpcUrl = environment.get("IRCFIBER_ANOPE_RPC_URL", "").strip();
    s.operAccount = environment.get("IRCFIBER_ANOPE_OPER_ACCOUNT", "").strip();
    s.token = envSecret("IRCFIBER_ANOPE_RPC_TOKEN", "").strip();
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

/// One decoded JSON-RPC reply for an `anope.command` call.
struct AnopeReply {
    bool transportOk;       /// HTTP answer carrying a JSON-RPC reply (result or error)
    string text;            /// result lines, flattened — or the error message on refusal
    /// The result lines joined with `\n`, NOT newline-flattened. `text`
    /// stays single-line for classification/logging/Redis values; multi-line
    /// replies (INFO) must be parsed from here. On a JSON-RPC error this
    /// carries the error message, so `No such command` stays classifiable.
    string rawText;
    string transportError;  /// non-empty when transportOk is false
    long errorCode;         /// JSON-RPC error code, 0 when the call succeeded
    string error;           /// JSON-RPC error message, "" when the call succeeded
}

/// The decoded envelope of any JSON-RPC call: transport outcome, the refusal
/// when services answered one, and the raw `result` for the caller to map.
/// Shared with `ircfiber.services.anope_inventory`, which maps the list
/// methods' results; everything else goes through `AnopeReply`.
struct AnopeRpcResult {
    bool transportOk;       /// HTTP answer carrying a JSON-RPC reply (result or error)
    string transportError;  /// non-empty when transportOk is false
    long errorCode;         /// JSON-RPC error code, 0 when the call succeeded
    string error;           /// JSON-RPC error message, "" when the call succeeded
    Json result;            /// the `result` value; undefined on refusal/transport failure
}

/// Build the request body. Every parameter is emitted as a JSON string, in
/// order — anything else becomes "" on the Anope side.
string buildJsonRpcCall(string method, const string[] params) @safe {
    auto call = Json.emptyObject;
    call["jsonrpc"] = Json("2.0");
    call["id"] = Json("gateway");
    call["method"] = Json(method);
    auto list = Json.emptyArray;
    foreach (p; params)
        list ~= Json(p);
    call["params"] = list;
    return call.toString();
}

/// The `Authorization` header value for the raw token: the listener runs
/// `B64Decode` on everything after `Bearer ` before comparing (rpc.h), so
/// the raw token must never be sent verbatim.
string anopeBearerHeader(string token) @safe pure {
    return "Bearer " ~ Base64.encode(cast(const(ubyte)[]) token).idup;
}

/// Decode one HTTP response body into the envelope. A JSON-RPC `error`
/// object is a refusal by services, NOT a transport failure: it yields
/// `transportOk == true` with `errorCode`/`error` set and an undefined
/// result. Only a body that is not a JSON-RPC reply at all is a transport
/// failure.
AnopeRpcResult parseJsonRpcReply(string body_) @safe {
    AnopeRpcResult r;
    Json reply;
    try
        reply = parseJsonString(body_);
    catch (Exception e) {
        r.transportError = "unparseable JSON-RPC body: " ~ e.msg;
        return r;
    }
    if (reply.type != Json.Type.object) {
        r.transportError = "unparseable JSON-RPC body";
        return r;
    }
    auto err = reply["error"];
    if (err.type == Json.Type.object) {
        r.transportOk = true;
        auto c = err["code"];
        if (c.type == Json.Type.int_) r.errorCode = c.get!long;
        auto m = err["message"];
        if (m.type == Json.Type.string) r.error = m.get!string;
        if (!r.error.length) r.error = "services refused the command";
        // An error object without a code is still a refusal, never a
        // transport failure, so it must not be reported with code 0.
        if (r.errorCode == 0) r.errorCode = -1;
        return r;
    }
    auto res = reply["result"];
    if (res.type == Json.Type.undefined) {
        r.transportError = "JSON-RPC reply holds no result";
        return r;
    }
    r.transportOk = true;
    r.result = res;
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
 * POST one prebuilt JSON-RPC body. `label` is what reaches the log — callers
 * must keep secrets out of it (`REGISTER <password>` never appears).
 * Fiber-aware; never throws: transport problems land in `transportError`
 * with `transportOk == false`.
 */
private AnopeRpcResult anopePost(AnopeSettings s, string payload, string label) {
    AnopeRpcResult r;
    if (!s.configured) {
        r.transportError = "Anope RPC not configured";
        return r;
    }
    const auth = anopeBearerHeader(s.token);

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = s.timeoutSeconds.seconds;
    settings.readTimeout = s.timeoutSeconds.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP(s.rpcUrl,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                req.headers["Connection"] = "close";
                req.headers["Content-Type"] = "application/json";
                req.headers["Authorization"] = auth;
                // Frame the body explicitly — see the module comment. Without
                // it httpd parses an empty body and answers 404
                // "Unrecognized query" whenever headers and body land in
                // separate TCP segments.
                req.headers["Content-Length"] = payload.length.to!string;
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

    // httpd's status code is not a reliable verdict: the old client watched
    // prod answer 404 with a parseable body on one socket while `command` on
    // the same socket answered 200, and jsonrpc signals its own errors in
    // the `error` object. So the body decides — a JSON-RPC reply is a real
    // answer whatever the status, and only a body that is not one is a
    // transport failure. The status is logged when unexpected so the next
    // occurrence is diagnosable.
    r = parseJsonRpcReply(responseBody);
    if (!r.transportOk) {
        r.transportError = status == 200
            ? r.transportError
            : "HTTP " ~ status.to!string ~ ": " ~ r.transportError;
        logWarn("anope rpc: %s returned HTTP %s with an unparseable body (%s bytes): %s",
                label, status, responseBody.length,
                responseBody.length > 200 ? responseBody[0 .. 200] : responseBody);
        return r;
    }
    if (status != 200)
        logWarn("anope rpc: %s answered HTTP %s but the body parsed — using it", label, status);
    return r;
}

/**
 * The one generic JSON-RPC call. `label` is what reaches the log — callers
 * must keep secrets out of it. Retried once, but only when `idempotent`:
 * a stale connection or a services restart shows up as a transport failure
 * on the write, and losing a read-only probe needlessly defers
 * provisioning. Never used for `REGISTER`, which is not idempotent. A
 * JSON-RPC `error` object is a refusal, not a transport failure, so it is
 * never retried either way.
 */
package AnopeRpcResult anopeRpc(AnopeSettings s, string method, string[] params,
                                string label, bool idempotent) {
    const payload = buildJsonRpcCall(method, params);
    auto r = anopePost(s, payload, label);
    if (r.transportOk || !idempotent) return r;
    logDebug("anope rpc: retrying %s after %s", label, r.transportError);
    return anopePost(s, payload, label);
}

/// Map an `anope.command` envelope onto the command reply: result lines, or
/// the refusal's message with its code.
private AnopeReply commandReply(AnopeRpcResult r) @safe {
    AnopeReply out_;
    if (!r.transportOk) {
        out_.transportError = r.transportError;
        return out_;
    }
    out_.transportOk = true;
    if (r.errorCode != 0) {
        out_.errorCode = r.errorCode;
        out_.error = r.error;
        out_.text = r.error;
        out_.rawText = r.error;
        return out_;
    }
    if (r.result.type != Json.Type.array) {
        out_.transportOk = false;
        out_.transportError = "unexpected anope.command result type";
        return out_;
    }
    string[] lines;
    foreach (v; r.result.get!(Json[]))
        if (v.type == Json.Type.string) lines ~= v.get!string;
    out_.rawText = lines.join("\n");
    out_.text = flattenReplyText(out_.rawText);
    return out_;
}

/**
 * Run `command` on `service` as the account `asNick` — or as the
 * unregistered nick `asNick` when no such account exists
 * (`rpc_user { allowunregistered = yes }`). Sent exactly once: repeating
 * `REGISTER` after a transport failure is not free of consequence (the
 * first attempt may well have landed).
 *
 * The single command string is passed as one parameter: Anope joins the
 * words with spaces on its side. Every value interpolated into it must
 * still pass `isSafeServicesArg` at the call site.
 */
AnopeReply anopeCommand(AnopeSettings s, string service, string asNick, string command) {
    return commandReply(anopeRpc(s, "anope.command", [asNick, service, command],
                                service ~ " " ~ commandVerb(command) ~ " as " ~ asNick, false));
}

/// Read-only `command` variant, retried once. Only for probes — never for
/// `REGISTER`, which `anopeCommand` sends exactly once.
AnopeReply anopeQuery(AnopeSettings s, string service, string asNick, string command) {
    return commandReply(anopeRpc(s, "anope.command", [asNick, service, command],
                                service ~ " " ~ commandVerb(command) ~ " as " ~ asNick, true));
}

/**
 * Read-only NickServ command run as the services-oper account, retried once
 * like every other probe. `AnopeReply.transportOk` is false with a spelled-out
 * `transportError` when no oper account is configured, so callers never have
 * to special-case the unconfigured deployment themselves.
 */
AnopeReply anopeOperQuery(AnopeSettings s, string command) {
    AnopeReply r;
    if (!s.hasOper) {
        r.transportError = "Anope oper account not configured";
        return r;
    }
    return anopeQuery(s, "NickServ", s.operAccount, command);
}

/**
 * Mutating NickServ command run as the services-oper account, sent exactly
 * once: repeating SUSPEND/DROP/SASET after a transport failure is not free of
 * consequence (the first attempt may well have landed).
 */
AnopeReply anopeOperCommand(AnopeSettings s, string command) {
    AnopeReply r;
    if (!s.hasOper) {
        r.transportError = "Anope oper account not configured";
        return r;
    }
    return anopeCommand(s, "NickServ", s.operAccount, command);
}

/**
 * Read-only ChanServ command run as the services-oper account, retried once.
 * Same contract as `anopeOperQuery`: an unconfigured oper account is reported
 * as a transport failure instead of being silently attempted.
 */
AnopeReply anopeChanServQuery(AnopeSettings s, string command) {
    AnopeReply r;
    if (!s.hasOper) {
        r.transportError = "Anope oper account not configured";
        return r;
    }
    return anopeQuery(s, "ChanServ", s.operAccount, command);
}

/**
 * Mutating ChanServ command run as the services-oper account, sent exactly
 * once: a retried SUSPEND/DROP/REGISTER may well be a second application of
 * a command whose first attempt landed.
 */
AnopeReply anopeChanServCommand(AnopeSettings s, string command) {
    AnopeReply r;
    if (!s.hasOper) {
        r.transportError = "Anope oper account not configured";
        return r;
    }
    return anopeCommand(s, "ChanServ", s.operAccount, command);
}

/**
 * True when Anope refused the command for lack of privileges. This is NOT a
 * transport error: `Access denied.` (`include/language.h`'s ACCESS_DENIED)
 * arrives as an ordinary result, so it has to be detected in the reply
 * text. It means the oper account is not tied to an opertype holding the
 * command's priv — Anope attaches `nc->o` only at config load.
 */
bool anopeAccessDenied(const AnopeReply r) @safe pure {
    import std.uni : toLower;
    static bool denied(string s) @safe pure {
        return s.length > 0 && s.toLower().indexOf("access denied") >= 0;
    }
    return denied(r.text) || denied(r.rawText);
}

/// ASCII lowercase. Account displays and nicks are ASCII on IRC, and the
/// caller's set lookups must not depend on Unicode case folding.
private string asciiLowerStr(string s) @safe pure {
    char[] res;
    res.length = s.length;
    foreach (i, char c; s)
        res[i] = (c >= 'A' && c <= 'Z') ? cast(char)(c + ('a' - 'A')) : c;
    return res.idup;
}

/**
 * Pull the account names out of an `OperServ OPER LIST` reply. Feed it
 * `AnopeReply.rawText`; the reply is line-oriented.
 *
 * Observed shape (probe: `command OperServ admin "OPER LIST"`):
 *
 *     Name     Type
 *     sq       Services Root
 *        This oper is configured in the configuration file.
 *        sq is online using this oper block.
 *     admin    Services Root
 *        This oper is configured in the configuration file.
 *
 * so a row is a line starting in column 0 whose first token is the name and
 * whose second column is the opertype; the indented lines are `os_oper`'s
 * per-entry annotations. Parsed positionally, never by matching the prose,
 * because every one of those strings is translatable.
 *
 * The first non-empty line is `ListFormatter`'s header and is dropped
 * unconditionally. That is also what makes every single-line refusal
 * (`Access denied.`, `There are no Services Operators.`) come out as the
 * empty set instead of as an account called "Access" or "There".
 */
private string[] parseOperListNames(string rawText) @safe pure {
    string[] names;
    bool headerSeen = false;
    foreach (line; rawText.splitLines()) {
        if (!line.strip().length) continue;
        if (!headerSeen) {
            headerSeen = true;
            continue;
        }
        if (line[0] == ' ' || line[0] == '\t') continue;
        size_t i = 0;
        while (i < line.length && line[i] != ' ' && line[i] != '\t') i++;
        // No second column → not a list row (a wrapped Syntax:/help line).
        if (i == 0 || i >= line.length) continue;
        names ~= asciiLowerStr(line[0 .. i]);
    }
    return names;
}

/**
 * The nicks Anope has tied to an opertype, ASCII-lowercased — the "this is
 * staff, never offer to drop it" oracle for the admin inventory.
 *
 * NOT a data RPC: the list methods expose no oper enumeration our token may
 * call, so `OperServ OPER LIST` (`os_oper.cpp`) does the job, covering
 * config-file opers as well as `OPER ADD` ones.
 *
 * The names are *nicks*: Anope resolves `oper { name = }` through
 * `NickAlias::Find`, and `OPER LIST` prints the configured name verbatim. On
 * prod that means `admin`, whose account display is `Zodiac` — so a caller
 * comparing against account displays MUST resolve the alias itself.
 *
 * Never throws and never reports failure: an unreachable Anope, a missing
 * oper account or a refused command all yield an empty set, and the caller
 * degrades to "nobody is staff" (a false droppable flag on a report page)
 * rather than to an error.
 */
bool[string] anopeOperAccounts(AnopeSettings s) {
    bool[string] names;
    if (!s.hasOper) return names;
    auto r = anopeQuery(s, "OperServ", s.operAccount, "OPER LIST");
    if (!r.transportOk) {
        logWarn("anope rpc: OPER LIST failed, treating nobody as staff: %s", r.transportError);
        return names;
    }
    if (anopeAccessDenied(r)) {
        logWarn("anope rpc: OPER LIST refused — %s holds no operserv/oper priv", s.operAccount);
        return names;
    }
    foreach (name; parseOperListNames(r.rawText))
        if (name.length) names[name] = true;
    return names;
}

/**
 * The `SASET PASSWORD` command line for `nick`.
 *
 * `SASET`'s parameters are option-first — `SASET <option> <nickname>
 * <parameters>` — the reversed form `SASET <nick> PASSWORD <pw>` answers
 * `Syntax: SASET option nickname parameters` and changes nothing. That
 * failure is silent (no `Access denied`, old password still valid), which is
 * why the order lives here with the evidence instead of inline at the call
 * site.
 */
string nickServSetPasswordCommand(string nick, string password) @safe pure {
    return "SASET PASSWORD " ~ nick ~ " " ~ password;
}

/**
 * The `SET FOUNDER` command line for `channel`.
 *
 * `cs_set` is option-first too — `SET <option> <channel> <parameters>` —
 * the reversed form `SET <#chan> FOUNDER <acct>` answers
 * `Syntax: SET option channel parameters` and transfers nothing. Same
 * silent shape as `SASET` above (no `Access denied`, the old founder still
 * owns the channel), so the order lives here with its evidence.
 */
string chanServSetFounderCommand(string channel, string founder) @safe pure {
    return "SET FOUNDER " ~ channel ~ " " ~ founder;
}

/**
 * The `DROP` command line for `nick`, run as the services-oper account.
 *
 * 2.1's `ns_drop` confirms with a per-target random code: a bare `DROP
 * <nick>` answers `Please confirm that you want to drop <nick> with /msg
 * NickServ DROP <nick> <code>` and drops nothing — 2.0's "name twice"
 * shape is gone. A source holding `nickserv/drop/override` (Services
 * Root has every priv) skips the code with the literal `OVERRIDE`, which
 * answers `Nickname <nick> has been dropped.` — verified on Anope
 * 2.1.27 over `anope.command`.
 */
string nickServDropCommand(string nick) @safe pure {
    return "DROP " ~ nick ~ " OVERRIDE";
}

/**
 * The `DROP` command line for `channel`, same contract as
 * `nickServDropCommand`: `cs_drop`'s confirmation code is skipped with
 * `OVERRIDE` under `chanserv/drop/override`, answering `Channel <#chan>
 * has been dropped.` A bare `DROP <#chan>` (or 2.0's `DROP <#chan>
 * <#chan>`) only prints the confirmation prompt.
 */
string chanServDropCommand(string channel) @safe pure {
    return "DROP " ~ channel ~ " OVERRIDE";
}

/**
 * The `ACCESS LIST` command line for `channel`.
 *
 * 2.1's `cs_access` hides entries that belong to another access provider:
 * the XOP tiers the channel setup script grants (`SOP`, `HOP`, `AOP`) come
 * back as `No matching entries on <#chan> access list.` plus `N access
 * entries from other access systems not shown; use ACCESS <#chan> LIST *
 * ALL`. The `* ALL` form lists every provider's rows in the same
 * `Number  Level  Mask  Description` table `parseChanAccessList` reads
 * (verified on 2.1.27: `1  SOP  sq`, `2  HOP  FIBEREYE`).
 */
string chanServAccessListCommand(string channel) @safe pure {
    return "ACCESS " ~ channel ~ " LIST * ALL";
}

/// Whether a nick is currently held by a live IRC session.
enum AnopePresence {
    online,    /// Anope knows a `User` object for the nick
    offline,   /// Anope answered `No such user`
    unknown,   /// Anope unreachable, misconfigured, or an unrecognised reply
}

/**
 * Map an `anope.user` envelope onto presence. `result` present means a live
 * session; the `No such user` error means nobody holds the nick; anything
 * else — transport failure, refusal, an empty result — is `unknown`, so
 * callers decide explicitly whether to fail open or closed.
 */
AnopePresence classifyUserPresence(const AnopeRpcResult r) @safe {
    if (!r.transportOk) return AnopePresence.unknown;
    if (r.errorCode != 0)
        return r.error.indexOf("No such user") >= 0
            ? AnopePresence.offline : AnopePresence.unknown;
    return (r.result.type != Json.Type.undefined && r.result.type != Json.Type.null_)
        ? AnopePresence.online : AnopePresence.unknown;
}

/// Presence lookup for any nick, registered or not (`NickServ STATUS`
/// cannot do this — it reports identification, so an online unregistered
/// nick answers 0 exactly like an offline one). `unknown` on any transport
/// problem, so callers decide explicitly whether to fail open or closed.
AnopePresence anopeUserPresence(AnopeSettings s, string nick) {
    if (!isSafeServicesArg(nick)) return AnopePresence.unknown;
    return classifyUserPresence(
        anopeRpc(s, "anope.user", [nick], "user " ~ nick, true));
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
    auto r = anopeQuery(s, "NickServ", nick, "INFO " ~ nick);
    if (!r.transportOk) return NickRegistration.unknown;
    return classifyNickInfoReply(r.text);
}

/// One parsed `NickServ INFO <nick>` reply.
struct NickInfo {
    bool registered;            /// false when the reply is NICK_X_NOT_REGISTERED
    string account;             /// "Account" field
    string realName;            /// tail of the leading "<nick> is <realname>" line
    string[string] fields;      /// every "Label: value" line, label trimmed
    string[] lines;             /// every reply line verbatim, for display
}

/**
 * Parse a `NickServ INFO <nick>` reply. Feed it `AnopeReply.rawText`, never
 * `text`: the latter is newline-flattened and the whole reply is line-oriented.
 *
 * A line is a field when it reads `<label>: <value>` after trimming, with a
 * non-empty label; the labels our `nickserv.conf` can emit are `Account`,
 * `Online from`, `Last seen address`, `Registered`, `Last seen`,
 * `Last quit message`, `Email address`, `VHost`, plus `Suspended`, `By`,
 * `Reason`, `On`, `Expires` from `ns_suspend`'s `show` list. A repeated label
 * (`Online from` appears twice for a dual-host session) keeps the last value,
 * and every raw line is kept in `lines` so the UI can show the reply verbatim.
 *
 * `registered` reuses `classifyNickInfoReply` rather than re-matching, so a
 * service bot ("is part of this Network's Services") and an unregistered nick
 * both come back `registered == false` with an empty `account`.
 */
NickInfo parseNickInfo(string rawText) @safe pure {
    NickInfo info;
    info.registered = classifyNickInfoReply(flattenReplyText(rawText))
        == NickRegistration.registered;

    bool first = true;
    foreach (line; rawText.splitLines()) {
        const trimmed = line.strip();
        if (!trimmed.length) continue;   // Anope emits none; a trailing one would be noise
        info.lines ~= line;
        const colon = trimmed.indexOf(':');
        if (colon > 0) {
            info.fields[trimmed[0 .. colon].strip()] = trimmed[colon + 1 .. $].strip();
        } else if (first && info.registered) {
            // Leading line of a registered reply: "<nick> is <realname>".
            const is_ = trimmed.indexOf(" is ");
            if (is_ > 0) info.realName = trimmed[is_ + 4 .. $].strip();
        }
        first = false;
    }

    if (auto p = "Account" in info.fields) info.account = *p;
    return info;
}

/**
 * True when an `anope.checkCredentials` result object names the
 * authenticated account. Success is `result.account` present; the
 * `Invalid password` / `Invalid account` / `Account suspended` refusals
 * never reach here — they arrive as JSON-RPC errors.
 */
bool credentialsAuthenticated(Json result) @safe {
    if (result.type != Json.Type.object) return false;
    auto a = result["account"];
    return a.type == Json.Type.string && a.get!string.length > 0;
}

/**
 * Verify an account/password pair through the same code path SASL PLAIN uses
 * (`anope.checkCredentials`). Used to prove a freshly generated credential
 * actually works before it is persisted and shown to the user. `determined`
 * is false when Anope was unreachable; a refusal (`Invalid password`,
 * `Invalid account`, `Account suspended`) is a determined false.
 */
bool anopeCheckAuthentication(AnopeSettings s, string account, string password, out bool determined) {
    determined = false;
    if (!isSafeServicesArg(account) || !isSafeServicesArg(password)) return false;
    auto r = anopeRpc(s, "anope.checkCredentials", [account, password],
                      "checkCredentials " ~ account, true);
    if (!r.transportOk) return false;
    determined = true;
    if (r.errorCode != 0) {
        logWarn("anope rpc: checkCredentials %s refused: %s", account, r.error);
        return false;
    }
    return credentialsAuthenticated(r.result);
}

/**
 * One parsed `ChanServ INFO <#channel>` reply.
 *
 * `registered` is decided by the header line `cs_info` always emits
 * (`Information for channel #x:`), never by the presence of a `Founder`
 * line: an oper INFO on a channel whose founder NickCore was dropped carries
 * no Founder at all, and that channel is still registered.
 */
struct ChanInfo {
    bool registered;
    string founder;       /// "Founder" field
    string successor;     /// "Successor"
    string description;   /// "Description"
    bool suspended;       /// a "Suspended" field is present
    string[string] fields;
    string[] lines;
}

/**
 * Parse a `ChanServ INFO <#channel>` reply. Feed it `AnopeReply.rawText`:
 * `text` is newline-flattened and the reply is line-oriented.
 *
 * The header line is skipped rather than split on its ':' — otherwise
 * `Information for channel #x` would become a bogus field label.
 */
ChanInfo parseChanInfo(string rawText) @safe pure {
    import std.algorithm : canFind;
    import std.string : startsWith;
    import std.uni : toLower;

    ChanInfo info;
    const flat = flattenReplyText(rawText).toLower();
    const missing = flat.canFind("isn't registered") || flat.canFind("is not registered");
    info.registered = flat.canFind("information for channel") && !missing;

    foreach (line; rawText.splitLines()) {
        const trimmed = line.strip();
        if (!trimmed.length) continue;
        info.lines ~= line;
        if (trimmed.startsWith("Information for channel")) continue;
        const colon = trimmed.indexOf(':');
        if (colon > 0)
            info.fields[trimmed[0 .. colon].strip()] = trimmed[colon + 1 .. $].strip();
    }

    if (auto p = "Founder" in info.fields) info.founder = *p;
    if (auto p = "Successor" in info.fields) info.successor = *p;
    if (auto p = "Description" in info.fields) info.description = *p;
    info.suspended = ("Suspended" in info.fields) !is null;
    return info;
}

/// One row of `ChanServ ACCESS <#channel> LIST`.
struct ChanAccessEntry {
    int number;
    string level;
    string mask;
}

/**
 * Parse `ChanServ ACCESS <#channel> LIST` positionally, never by prose: a row
 * is a line whose first whitespace-separated token is all digits and which has
 * at least three tokens (`Number  Level  Mask`; masks never contain spaces).
 *
 * Everything else — the `Access list for …:` header, the column header, the
 * `End of access list` footer and the `… access list is empty.` reply — yields
 * no row, so an empty list is an empty array rather than an error.
 */
ChanAccessEntry[] parseChanAccessList(string rawText) @safe pure {
    import std.algorithm : all, splitter;
    import std.array : array;
    import std.ascii : isDigit;

    ChanAccessEntry[] rows;
    foreach (line; rawText.splitLines()) {
        auto tokens = line.strip().splitter().array();
        if (tokens.length < 3) continue;
        if (!tokens[0].length || !tokens[0].all!isDigit) continue;
        ChanAccessEntry e;
        try e.number = tokens[0].to!int;
        catch (Exception) continue;   // a number too large for int is not a row
        e.level = tokens[1];
        e.mask = tokens[2];
        rows ~= e;
    }
    return rows;
}

/// The `anope.command` envelope → reply mapping every command call shares.
/// In-module because `commandReply` is private; `services-test` covers the
/// public builders and parsers it is built from.
unittest {
    import std.algorithm : canFind;

    // Result lines arrive as an array; rawText keeps them line-oriented for
    // the INFO/ACCESS parsers while text is flattened for logging.
    auto ok = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","result":["alice is alice","          Account: alice"]}`);
    assert(ok.transportOk && ok.errorCode == 0);
    auto reply = commandReply(ok);
    assert(reply.transportOk);
    assert(reply.rawText == "alice is alice\n          Account: alice");
    assert(reply.text.indexOf('\n') < 0 && reply.text.canFind("Account: alice"));

    // A refusal is a usable answer, not a transport failure: the message
    // stays classifiable and the code travels with it.
    auto refused = parseJsonRpcReply(
        `{"jsonrpc":"2.0","id":"gateway","error":{"code":-32001,"message":"No such command"}}`);
    assert(refused.transportOk);
    auto r2 = commandReply(refused);
    assert(r2.transportOk && r2.errorCode == -32001);
    assert(r2.text == "No such command" && r2.rawText == "No such command");
    assert(anopeAccessDenied(r2) == false);

    // A well-formed reply with a mistyped result is a transport failure —
    // `anope.command` only ever answers an array of lines.
    auto weird = parseJsonRpcReply(`{"jsonrpc":"2.0","id":"gateway","result":"oops"}`);
    assert(weird.transportOk);
    assert(!commandReply(weird).transportOk);
}
