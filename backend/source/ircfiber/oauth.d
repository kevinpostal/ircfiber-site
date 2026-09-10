/**
 * Social OAuth signup/signin (GitHub, Google, Codeberg, GitLab).
 *
 * No new dub dependency: HTTP goes through vibe.d `requestHTTP` with the
 * same 10s connect/read timeouts and `Connection: close` framing as
 * `ircfiber.mail.sendMail` / `anopePost`.
 *
 * Layout mirrors `ircfiber.signup`: pure helpers (provider table, username
 * derivation, profile normalizer) carry `@("…")` unittests in-file, while
 * the Redis-backed `OAuthStateStore` and the `requestHTTP` exchange/fetch
 * paths are exercised through the `oauth-test` config's main checks plus
 * the live verification steps in the plan.
 */
module ircfiber.oauth;

import std.algorithm : canFind;
import std.ascii : isAlphaNum;
import std.conv : to;
import std.process : environment;
import std.regex : regex, replaceAll;
import std.string : indexOf, stripRight, toUpper;
import std.typecons : Nullable, nullable;
import std.uri : encodeComponent;

import core.time : seconds;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisDatabase;
import vibe.http.client : HTTPClientRequest, HTTPClientResponse, HTTPClientSettings, requestHTTP;
import vibe.http.common : HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;
import ircfiber.services.accounts : generateServicesPassword;
import ircfiber.storage.redis : RedisStorage;

// ────────────────────────────────────────────────────────────
// Provider table
// ────────────────────────────────────────────────────────────

/// One OAuth provider's fixed endpoints. `emailsUrl` is "" when the
/// address arrives inside the userinfo document (Google, GitLab).
struct OAuthProvider {
    string name;
    string label;
    string authorizeUrl;
    string tokenUrl;
    string userUrl;
    string emailsUrl;
    string scope_;
}

/// The exact four providers this plan wires. A fifth is a one-row addition.
immutable OAuthProvider[] oauthProviders = [
    OAuthProvider("github", "GitHub",
        "https://github.com/login/oauth/authorize",
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
        "https://api.github.com/user/emails",
        "read:user user:email"),
    OAuthProvider("google", "Google",
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "https://openidconnect.googleapis.com/v1/userinfo",
        "",
        "openid email profile"),
    OAuthProvider("codeberg", "Codeberg",
        "https://codeberg.org/login/oauth/authorize",
        "https://codeberg.org/login/oauth/access_token",
        "https://codeberg.org/api/v1/user",
        "https://codeberg.org/api/v1/user/emails",
        ""),
    OAuthProvider("gitlab", "GitLab",
        "https://gitlab.com/oauth/authorize",
        "https://gitlab.com/oauth/token",
        "https://gitlab.com/oauth/userinfo",
        "",
        "read_user openid email"),
];

/// Table lookup; null when the provider name is unknown.
const(OAuthProvider)* oauthProvider(string name) @trusted {
    foreach (ref p; oauthProviders)
        if (p.name == name) return &p;
    return null;
}

// ────────────────────────────────────────────────────────────
// Settings (env-driven; unconfigured providers stay hidden)
// ────────────────────────────────────────────────────────────

/// One provider's credentials. Both halves are required: a provider with
/// either half empty reads as disabled and is never advertised.
struct OAuthSettings {
    string clientId;
    string clientSecret;

    bool configured() const @safe pure nothrow {
        return clientId.length > 0 && clientSecret.length > 0;
    }
}

/// Per-provider `IRCFIBER_OAUTH_<NAME>_CLIENT_ID` (inline; IDs are public —
/// they appear in the authorize URL) and `IRCFIBER_OAUTH_<NAME>_CLIENT_SECRET`
/// via `envSecret` (file wins). Either half may instead come from the admin
/// override store below (Redis; fills only halves the environment leaves
/// empty, so deployed env always wins). Only configured providers are
/// returned.
OAuthSettings[string] loadOAuthSettings(RedisStorage redis = null) {
    OAuthSettings[string] result;
    OAuthConfigStore store = redis is null ? null : new OAuthConfigStore(redis);
    foreach (p; oauthProviders) {
        string prefix = "IRCFIBER_OAUTH_" ~ p.name.toUpper ~ "_";
        string id = "";
        try id = environment.get(prefix ~ "CLIENT_ID", "");
        catch (Exception) {}
        string secret = envSecret(prefix ~ "CLIENT_SECRET");
        if ((id.length == 0 || secret.length == 0) && store !is null) {
            try {
                auto ov = store.get(p.name);
                if (!ov.isNull) {
                    if (id.length == 0) id = ov.get.clientId;
                    if (secret.length == 0) secret = ov.get.clientSecret;
                }
            } catch (Exception e) {
                logWarn("oauth: reading %s override failed: %s", p.name, e.msg);
            }
        }
        if (id.length > 0 && secret.length > 0)
            result[p.name] = OAuthSettings(id, secret);
    }
    return result;
}

/// Redis key for a provider's admin override.
string oauthConfigKey(string provider) @safe pure {
    return "oauth:config:" ~ provider;
}

/// Admin-saved credentials for one provider. Serialized as
/// `{"clientId":…, "clientSecret":…}` under `oauthConfigKey`.
struct OAuthConfigOverride {
    string clientId;
    string clientSecret;

    Json toJson() const {
        return Json(["clientId": Json(clientId), "clientSecret": Json(clientSecret)]);
    }

    static OAuthConfigOverride fromJson(Json j) {
        OAuthConfigOverride o;
        if (auto pv = "clientId" in j) o.clientId = pv.get!string;
        if (auto pv = "clientSecret" in j) o.clientSecret = pv.get!string;
        return o;
    }
}

/// Admin credential overrides on Redis (the secrets dir is root-owned and
/// the container env is immutable at runtime, so there is no file/env
/// write path; Redis matches the `setFiberEnabled` runtime-config
/// precedent). `put`/`remove` throw on Redis failure (the caller turns it
/// into 503); `get` returns null on absent or unparseable rows. A restart
/// that loses Redis fails safe: providers read as unconfigured and their
/// buttons hide.
final class OAuthConfigStore {
    private RedisStorage redis;

    this(RedisStorage redis) {
        this.redis = redis;
    }

    private RedisDatabase db() @trusted {
        return redis.getDb();
    }

    Nullable!OAuthConfigOverride get(string provider) {
        try {
            auto raw = db().get(oauthConfigKey(provider));
            if (raw.length == 0) return Nullable!OAuthConfigOverride.init;
            return nullable(OAuthConfigOverride.fromJson(parseJsonString(raw)));
        } catch (Exception e) {
            logWarn("oauth: reading %s override failed: %s", provider, e.msg);
            return Nullable!OAuthConfigOverride.init;
        }
    }

    /// Throws on Redis failure.
    void put(string provider, OAuthConfigOverride o) {
        db().set(oauthConfigKey(provider), o.toJson().toString());
    }

    /// Throws on Redis failure.
    void remove(string provider) {
        db().del(oauthConfigKey(provider));
    }
}

/// Pure admin status-row assembly (the handler supplies the inputs; the
/// secret itself never enters the row — `hasSecret` only).
Json oauthStatusRow(const OAuthProvider p, bool live, string envId,
        bool envSecretPresent, string ovId, bool ovSecretPresent, string redirectUri) {
    string source = "off";
    if (live) {
        bool envBoth = envId.length > 0 && envSecretPresent;
        bool anyEnv = envId.length > 0 || envSecretPresent;
        source = envBoth ? "env" : (anyEnv ? "mixed" : "override");
    }
    return Json([
        "name": Json(p.name),
        "label": Json(p.label),
        "configured": Json(live),
        "source": Json(source),
        "clientId": Json(envId.length > 0 ? envId : ovId),
        "hasSecret": Json(envSecretPresent || ovSecretPresent),
        "envId": Json(envId),
        "envHasSecret": Json(envSecretPresent),
        "redirectUri": Json(redirectUri),
    ]);
}
/// The registered callback for a provider. Derived, never configured, so
/// there is exactly one URI to register on every provider app page.
string oauthRedirectUri(string provider) {
    string base = "https://ircfiber.com";
    try base = environment.get("IRCFIBER_PUBLIC_URL", base);
    catch (Exception) {}
    return base.stripRight("/") ~ "/auth/" ~ provider ~ "/callback";
}

/// The 302 target for `GET /auth/:provider`. Google additionally gets
/// `prompt=select_account` so multi-account users can switch; Google, GitLab
/// and Codeberg require an explicit `response_type=code` (GitHub defaults to
/// code when it is absent; Forgejo rejects the request without it).
string oauthAuthorizeUrl(const OAuthProvider p, string clientId, string state, string redirectUri) {
    string q = "client_id=" ~ encodeComponent(clientId)
        ~ "&redirect_uri=" ~ encodeComponent(redirectUri)
        ~ "&state=" ~ encodeComponent(state);
    if (p.scope_.length > 0)
        q ~= "&scope=" ~ encodeComponent(p.scope_);
    if (p.name == "google" || p.name == "gitlab" || p.name == "codeberg")
        q ~= "&response_type=code";
    if (p.name == "google")
        q ~= "&prompt=select_account";
    return p.authorizeUrl ~ "?" ~ q;
}

// ────────────────────────────────────────────────────────────
// State store (CSRF defense; mirrors PendingSignupStore)
// ────────────────────────────────────────────────────────────

/// Redis key for a pending OAuth state value.
string oauthStateKey(string state) @safe pure {
    return "oauth:state:" ~ state;
}

/// How long a state value survives: 10 minutes is generous for an
/// authorize round-trip and short enough to bound replay.
enum long oauthStateTtlSeconds = 600;

/// 40 unbiased [A-Za-z0-9] chars from /dev/urandom (~238 bits) — the same
/// generator signup uses, already tested; URL-safe so no encoding needed.
string newOAuthState() {
    return generateServicesPassword(40);
}

/// Single-use CSRF states on Redis. `take` is GET+DEL: a raced
/// double-callback fails closed to the error page, same rationale as
/// invites (a lost race only means the second take sees nothing).
final class OAuthStateStore {
    private RedisStorage redis;

    this(RedisStorage redis) {
        this.redis = redis;
    }

    private RedisDatabase db() @trusted {
        return redis.getDb();
    }

    /// Throws on Redis failure (the caller turns it into 503; starting a
    /// login that cannot be completed must not 302 to the provider).
    void put(string state) {
        db().setEX(oauthStateKey(state), oauthStateTtlSeconds, "1");
    }

    /// True exactly once per issued state.
    bool take(string state) {
        if (state.length == 0) return false;
        try {
            auto raw = db().get(oauthStateKey(state));
            if (raw.length == 0) return false;
            db().del(oauthStateKey(state));
            return true;
        } catch (Exception e) {
            logWarn("oauth: taking state failed: %s", e.msg);
            return false;
        }
    }
}

// ────────────────────────────────────────────────────────────
// Code exchange (one path for all four providers)
// ────────────────────────────────────────────────────────────

/// Outcome of the authorization-code exchange. Never throws: transport
/// failures and provider rejections surface as `error`.
struct OAuthTokenResult {
    string accessToken;
    string error;
}

OAuthTokenResult exchangeOAuthCode(const OAuthProvider p, const OAuthSettings s,
        string code, string redirectUri) {
    OAuthTokenResult r;
    const payload = "grant_type=authorization_code"
        ~ "&code=" ~ encodeComponent(code)
        ~ "&redirect_uri=" ~ encodeComponent(redirectUri)
        ~ "&client_id=" ~ encodeComponent(s.clientId)
        ~ "&client_secret=" ~ encodeComponent(s.clientSecret);

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 10.seconds;

    int status = 0;
    string responseBody;
    try {
        requestHTTP(p.tokenUrl,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                req.headers["Accept"] = "application/json";
                req.headers["Content-Type"] = "application/x-www-form-urlencoded";
                req.headers["Connection"] = "close";
                req.headers["Content-Length"] = payload.length.to!string;
                req.bodyWriter.write(cast(const(ubyte)[]) payload);
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try responseBody = cast(string) res.bodyReader.readAll();
                catch (Exception e)
                    logWarn("oauth: reading %s token response failed: %s", p.name, e.msg);
            },
            settings);
    } catch (Exception e) {
        r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
        logWarn("oauth: %s token request failed: %s", p.name, e.msg);
        return r;
    }
    if (status != 200) {
        r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
        // Response bodies here are provider error JSON (our secret travels
        // in the request, never in the reply), so a snippet is safe to log
        // and turns the next silent 502 into a named provider error.
        auto snippet = responseBody.length > 200 ? responseBody[0 .. 200] : responseBody;
        logWarn("oauth: %s token request answered HTTP %d: %s", p.name, status, snippet);
        return r;
    }
    try {
        auto j = parseJsonString(responseBody);
        if (auto pv = "access_token" in j)
            r.accessToken = pv.get!string;
    } catch (Exception e) {
        logWarn("oauth: parsing %s token response failed: %s", p.name, e.msg);
    }
    if (r.accessToken.length == 0) {
        r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
        auto snippet = responseBody.length > 200 ? responseBody[0 .. 200] : responseBody;
        logWarn("oauth: %s token reply carried no access_token (HTTP %d): %s",
            p.name, status, snippet);
    }
    return r;
}

// ────────────────────────────────────────────────────────────
// Profile normalize
// ────────────────────────────────────────────────────────────

/// A verified provider identity: `subject` is the provider-side user id as
/// a string (GitHub/Codeberg numeric `id`, Google/GitLab `sub`).
struct OAuthProfile {
    string provider;
    string subject;
    string username;
    string email;
    bool emailVerified;
}

/// Outcome of fetching + normalizing a profile. Never throws.
struct OAuthProfileResult {
    OAuthProfile profile;
    string error;
}

/// Bearer GET returning parsed JSON. `error` is "" on a 2xx with a
/// parsable body, else a short machine tag (`timeout`, `http<code>`,
/// `parse`); the caller maps it to a user-facing message.
private struct BearerJson {
    Json body = Json.undefined;
    string error;
}

private BearerJson bearerGetJson(string url, string accessToken) {
    BearerJson r;
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 10.seconds;
    int status = 0;
    string text;
    try {
        requestHTTP(url,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.GET;
                req.headers["Authorization"] = "Bearer " ~ accessToken;
                req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
                req.headers["User-Agent"] = "ircfiber-oauth/1 (+https://ircfiber.com)";
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try text = cast(string) res.bodyReader.readAll();
                catch (Exception) { text = ""; }
            },
            settings);
    } catch (Exception e) {
        logWarn("oauth: GET %s failed: %s", url, e.msg);
        r.error = "timeout";
        return r;
    }
    if (status < 200 || status >= 300) {
        r.error = "http" ~ status.to!string;
        return r;
    }
    try r.body = parseJsonString(text);
    catch (Exception) { r.error = "parse"; }
    return r;
}

private string oauthJsonStr(Json j, string key) {
    try {
        if (auto pv = key in j)
            if (pv.type == Json.Type.string) return pv.get!string;
    } catch (Exception) {}
    return "";
}

private bool oauthJsonHas(Json j, string key) {
    try {
        if (auto pv = key in j) return pv.type != Json.Type.undefined;
    } catch (Exception) {}
    return false;
}

private bool oauthJsonBool(Json j, string key) {
    try {
        if (auto pv = key in j)
            if (pv.type == Json.Type.bool_) return pv.get!bool;
    } catch (Exception) {}
    return false;
}

/// Provider user id as a string: numeric `id` (GitHub/Codeberg) or string
/// `sub` (Google/GitLab userinfo).
private string oauthJsonId(Json j, string key) {
    try {
        if (auto pv = key in j) {
            if (pv.type == Json.Type.string) return pv.get!string;
            if (pv.type == Json.Type.int_) return pv.get!long.to!string;
            if (pv.type == Json.Type.float_) return (cast(long) pv.get!double).to!string;
        }
    } catch (Exception) {}
    return "";
}

// ────────────────────────────────────────────────────────────
// Username derivation (pure; collision loop lives with the caller)
// ────────────────────────────────────────────────────────────

/**
 * Prefer the provider handle, else the email local-part, sanitized with
 * the exact `registerPost` idiom (strip `[^a-zA-Z0-9_\-]`, drop leading
 * non-letters, fallback `"user"`). The caller truncates the base to 24
 * chars then tries base, base`2` … base`50`.
 */
string deriveOAuthUsername(string handle, string email) {
    string base = handle;
    if (base.length == 0 && email.length > 0) {
        auto at = email.indexOf("@");
        base = at > 0 ? email[0 .. at].idup : email;
    }
    base = replaceAll(base, regex(r"[^a-zA-Z0-9_\-]"), "");
    size_t nickStart = 0;
    while (nickStart < base.length) {
        const c = base[nickStart];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) break;
        nickStart++;
    }
    base = base[nickStart .. $];
    if (base.length == 0) base = "user";
    return base;
}
/**
 * Pure normalizer: provider userinfo (+ the provider's emails document
 * where one exists) into an `OAuthProfile`. Provider-verified email is
 * trusted as email verification, so an unverified/absent address rejects
 * the profile with a user-facing message instead of falling back to a
 * password round-trip.
 *
 * `extraJson` carries the provider-specific second document: the emails
 * array (GitHub/Codeberg) or the `/api/v4/user` record (GitLab, only
 * fetched when userinfo carries no `email_verified` key).
 */
OAuthProfileResult normalizeOAuthProfile(const OAuthProvider p, Json userJson, Json extraJson = Json.undefined) {
    OAuthProfileResult r;
    try {
        OAuthProfile prof;
        prof.provider = p.name;

        if (p.name == "github" || p.name == "codeberg") {
            prof.subject = oauthJsonId(userJson, "id");
            prof.username = oauthJsonStr(userJson, "login");
            // Same shape on both: [{email, primary, verified}].
            try {
                foreach (e; extraJson.get!(Json[])) {
                    try {
                        if (oauthJsonBool(e, "primary") && oauthJsonBool(e, "verified")) {
                            prof.email = oauthJsonStr(e, "email");
                            break;
                        }
                    } catch (Exception) {}
                }
            } catch (Exception) {}
            prof.emailVerified = prof.email.length > 0;
        } else if (p.name == "google") {
            prof.subject = oauthJsonStr(userJson, "sub");
            prof.email = oauthJsonStr(userJson, "email");
            prof.emailVerified = prof.email.length > 0 && oauthJsonBool(userJson, "email_verified");
            if (!prof.emailVerified) prof.email = "";
            // Preferred username is the email local-part.
            auto at = prof.email.indexOf("@");
            prof.username = at > 0 ? prof.email[0 .. at] : "";
        } else if (p.name == "gitlab") {
            prof.subject = oauthJsonStr(userJson, "sub");
            foreach (k; ["username", "preferred_username", "nickname"]) {
                prof.username = oauthJsonStr(userJson, k);
                if (prof.username.length > 0) break;
            }
            prof.email = oauthJsonStr(userJson, "email");
            if (prof.email.length == 0)
                prof.email = oauthJsonStr(extraJson, "email");
            if (oauthJsonHas(userJson, "email_verified")) {
                prof.emailVerified = prof.email.length > 0 && oauthJsonBool(userJson, "email_verified");
            } else {
                // No `email_verified` on this userinfo: fall back to the
                // /api/v4/user record (`confirmed_at != null` proves the
                // address the same way clicking our link would).
                prof.emailVerified = prof.email.length > 0
                    && oauthJsonStr(extraJson, "confirmed_at").length > 0;
            }
            if (!prof.emailVerified) prof.email = "";
            if (prof.username.length == 0 && prof.email.length > 0) {
                auto at = prof.email.indexOf("@");
                prof.username = at > 0 ? prof.email[0 .. at] : "";
            }
        } else {
            r.error = "Unknown provider.";
            return r;
        }

        if (prof.subject.length == 0) {
            r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
            return r;
        }
        if (prof.email.length == 0) {
            r.error = "We couldn't get a verified email address from " ~ p.label
                ~ ". Please make sure your " ~ p.label
                ~ " account has a verified email address, then try again.";
            return r;
        }
        r.profile = prof;
        return r;
    } catch (Exception e) {
        logWarn("oauth: normalizing %s profile failed: %s", p.name, e.msg);
        r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
        return r;
    }
}

/// Full fetch path: userinfo, then the second document where the provider
/// needs one (emails array for GitHub/Codeberg; `/api/v4/user` for GitLab
/// only when userinfo carries no `email_verified` key). Never throws.
OAuthProfileResult fetchOAuthProfile(const OAuthProvider p, string accessToken) {
    OAuthProfileResult r;
    auto u = bearerGetJson(p.userUrl, accessToken);
    if (u.error.length > 0) {
        r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
        logWarn("oauth: %s userinfo fetch failed: %s", p.name, u.error);
        return r;
    }
    Json extra = Json.undefined;
    if (p.emailsUrl.length > 0) {
        auto e = bearerGetJson(p.emailsUrl, accessToken);
        if (e.error.length > 0) {
            r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
            logWarn("oauth: %s emails fetch failed: %s", p.name, e.error);
            return r;
        }
        extra = e.body;
    } else if (p.name == "gitlab" && !oauthJsonHas(u.body, "email_verified")) {
        auto v = bearerGetJson("https://gitlab.com/api/v4/user", accessToken);
        if (v.error.length > 0) {
            r.error = "Sign-in with " ~ p.label ~ " failed. Please try again.";
            logWarn("oauth: gitlab /api/v4/user fetch failed: %s", v.error);
            return r;
        }
        extra = v.body;
    }
    return normalizeOAuthProfile(p, u.body, extra);
}

// ────────────────────────────────────────────────────────────
// Username derivation (pure; collision loop lives with the caller)
// ────────────────────────────────────────────────────────────

/**
 * Prefer the provider handle, else the email local-part, sanitized with
 * the exact `registerPost` idiom (strip `[^a-zA-Z0-9_\-]`, drop leading
 * non-letters, fallback `"user"`). The caller truncates the base to 24
 * chars then tries base, base`2` … base`50`.
 */

// ────────────────────────────────────────────────────────────
// In-file unittests (run under the oauth-test config)
// ────────────────────────────────────────────────────────────

@("oauth provider table holds the four exact authorize/token URLs")
unittest {
    assert(oauthProviders.length == 4);
    const github = oauthProvider("github");
    assert(github !is null);
    assert(github.authorizeUrl == "https://github.com/login/oauth/authorize");
    assert(github.tokenUrl == "https://github.com/login/oauth/access_token");
    assert(github.userUrl == "https://api.github.com/user");
    assert(github.emailsUrl == "https://api.github.com/user/emails");
    const google = oauthProvider("google");
    assert(google !is null);
    assert(google.authorizeUrl == "https://accounts.google.com/o/oauth2/v2/auth");
    assert(google.tokenUrl == "https://oauth2.googleapis.com/token");
    assert(google.userUrl == "https://openidconnect.googleapis.com/v1/userinfo");
    const codeberg = oauthProvider("codeberg");
    assert(codeberg !is null);
    assert(codeberg.authorizeUrl == "https://codeberg.org/login/oauth/authorize");
    assert(codeberg.tokenUrl == "https://codeberg.org/login/oauth/access_token");
    const gitlab = oauthProvider("gitlab");
    assert(gitlab !is null);
    assert(gitlab.authorizeUrl == "https://gitlab.com/oauth/authorize");
    assert(gitlab.tokenUrl == "https://gitlab.com/oauth/token");
    assert(gitlab.userUrl == "https://gitlab.com/oauth/userinfo");
    assert(oauthProvider("microsoft") is null);
}

@("deriveOAuthUsername sanitizes like registerPost")
unittest {
    assert(deriveOAuthUsername("octo-cat!", "x@y.co") == "octo-cat");
    assert(deriveOAuthUsername("", "bob.smith@example.com") == "bobsmith");
    assert(deriveOAuthUsername("", "9lives@example.com") == "lives");
    assert(deriveOAuthUsername("", "") == "user");
    assert(deriveOAuthUsername("!!!", "") == "user");
    assert(deriveOAuthUsername("4bob", "") == "bob");
}

@("oauth state key shape and token charset")
unittest {
    assert(oauthStateKey("abc") == "oauth:state:abc");
    const t = newOAuthState();
    assert(t.length == 40);
    foreach (char c; t) assert(isAlphaNum(c));
    assert(newOAuthState() != t, "two draws differ");
}

@("oauth authorize URL carries client_id, redirect_uri, scope and state")
unittest {
    const github = oauthProvider("github");
    const url = oauthAuthorizeUrl(*github, "CID", "ST", "https://ircfiber.com/auth/github/callback");
    assert(url.canFind("https://github.com/login/oauth/authorize?"));
    assert(url.canFind("client_id=CID"));
    assert(url.canFind("redirect_uri=" ~ encodeComponent("https://ircfiber.com/auth/github/callback")));
    assert(url.canFind("scope=" ~ encodeComponent("read:user user:email")));
    assert(url.canFind("state=ST"));
    const google = oauthProvider("google");
    const gurl = oauthAuthorizeUrl(*google, "CID", "ST", "https://ircfiber.com/auth/google/callback");
    assert(gurl.canFind("prompt=select_account"));
    assert(gurl.canFind("response_type=code"));
}

@("github profile accepts primary+verified, rejects the rest")
unittest {
    const github = oauthProvider("github");
    auto ok = normalizeOAuthProfile(*github,
        parseJsonString(`{"id": 1234, "login": "octo-cat"}`),
        parseJsonString(`[{"email": "o@x.co", "primary": true, "verified": true}]`));
    assert(ok.error.length == 0, ok.error);
    assert(ok.profile.subject == "1234");
    assert(ok.profile.username == "octo-cat");
    assert(ok.profile.email == "o@x.co");

    auto unverified = normalizeOAuthProfile(*github,
        parseJsonString(`{"id": 1234, "login": "octo-cat"}`),
        parseJsonString(`[{"email": "o@x.co", "primary": true, "verified": false}]`));
    assert(unverified.error.canFind("verified email address"));

    auto none = normalizeOAuthProfile(*github,
        parseJsonString(`{"id": 1234, "login": "octo-cat"}`),
        parseJsonString(`[]`));
    assert(none.error.canFind("verified email address"));
}

@("google profile gates on email_verified, username is the local-part")
unittest {
    const google = oauthProvider("google");
    auto ok = normalizeOAuthProfile(*google,
        parseJsonString(`{"sub": "abc123", "email": "BoB@x.co", "email_verified": true}`));
    assert(ok.error.length == 0, ok.error);
    assert(ok.profile.subject == "abc123");
    assert(ok.profile.username == "BoB");
    assert(ok.profile.email == "BoB@x.co");

    auto unverified = normalizeOAuthProfile(*google,
        parseJsonString(`{"sub": "abc123", "email": "b@x.co", "email_verified": false}`));
    assert(unverified.error.canFind("verified email address"));
}

@("gitlab profile prefers username keys, falls back to confirmed_at")
unittest {
    const gitlab = oauthProvider("gitlab");
    auto ok = normalizeOAuthProfile(*gitlab,
        parseJsonString(`{"sub": "77", "preferred_username": "gl-user", "email": "g@x.co", "email_verified": true}`));
    assert(ok.error.length == 0, ok.error);
    assert(ok.profile.username == "gl-user");

    auto viaApi = normalizeOAuthProfile(*gitlab,
        parseJsonString(`{"sub": "78", "nickname": "nick9", "email": "n@x.co"}`),
        parseJsonString(`{"confirmed_at": "2026-01-01T00:00:00Z"}`));
    assert(viaApi.error.length == 0, viaApi.error);
    assert(viaApi.profile.username == "nick9");

    auto unconfirmed = normalizeOAuthProfile(*gitlab,
        parseJsonString(`{"sub": "79", "username": "u9", "email": "u@x.co"}`),
        parseJsonString(`{"confirmed_at": null}`));
    assert(unconfirmed.error.canFind("verified email address"));
}

@("oauth config override key shape and JSON round-trip")
unittest {
    assert(oauthConfigKey("github") == "oauth:config:github");
    OAuthConfigOverride o = { "Iv1.abc", "s3cret" };
    auto rt = OAuthConfigOverride.fromJson(o.toJson());
    assert(rt.clientId == "Iv1.abc");
    assert(rt.clientSecret == "s3cret");
    // Missing halves read as "": an ID-only row configures nothing.
    auto bare = OAuthConfigOverride.fromJson(parseJsonString(`{"clientId": "x"}`));
    assert(bare.clientId == "x" && bare.clientSecret == "");
}

@("oauth status row classifies env/override/mixed/off and never leaks the secret")
unittest {
    const github = oauthProvider("github");
    // Off: nothing anywhere.
    auto off = oauthStatusRow(*github, false, "", false, "", false, "https://ircfiber.com/auth/github/callback");
    assert(off["source"].get!string == "off");
    assert(!off["configured"].get!bool);
    // Env: both halves deployed.
    auto env = oauthStatusRow(*github, true, "EID", true, "", false, "cb");
    assert(env["source"].get!string == "env");
    assert(env["clientId"].get!string == "EID");
    // Override: env empty, admin store filled.
    auto ov = oauthStatusRow(*github, true, "", false, "AID", true, "cb");
    assert(ov["source"].get!string == "override");
    assert(ov["clientId"].get!string == "AID");
    assert(ov["hasSecret"].get!bool);
    // Mixed: env ID plus admin secret.
    auto mixed = oauthStatusRow(*github, true, "EID", false, "", true, "cb");
    assert(mixed["source"].get!string == "mixed");
    // The secret value itself never appears in the serialized row.
    OAuthConfigOverride o = { "AID", "super-secret-value" };
    auto leak = oauthStatusRow(*github, true, "", false, o.clientId, true, "cb");
    assert(!leak.toString().canFind("super-secret-value"));
}
