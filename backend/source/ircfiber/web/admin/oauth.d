module ircfiber.web.admin.oauth;

///
/// Social-login provider configuration for the admin dashboard.
///
/// Reads the same `loadOAuthSettings` the public routes use, so the status
/// shown here is exactly what the buttons reflect. Credentials come from
/// deployed env (always wins) or the admin override store (Redis; fills
/// only halves the environment leaves empty) — the secrets dir is
/// root-owned and the container env is immutable at runtime, so there is
/// no file/env write path.
///
/// The secret is write-only: GET reports `hasSecret`, never the value
/// (same rule as the bouncer token, which is never returned either).
/// POST with an empty/missing `clientSecret` keeps the stored one, so the
/// ID can be edited without retyping the secret. DELETE drops the whole
/// override and the provider falls back to env (usually: off).
import std.algorithm.searching : startsWith;
import std.algorithm.sorting : sort;
import std.datetime : Clock, SysTime;
import std.process : environment;
import std.string : strip, toUpper;

import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.env : envSecret;
import ircfiber.oauth : OAuthConfigOverride, OAuthConfigStore, loadOAuthSettings,
    oauthProvider, oauthProviders, oauthRedirectUri, oauthStatusRow;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;
import ircfiber.db.user : UserRepository;
import ircfiber.models.user : User;

/// Max credential length: provider IDs/secrets are short tokens; this only
/// rejects junk, not any real value.
private enum size_t maxCredentialLength = 512;

private bool badCredential(string s) {
    return s.length == 0 || s.length > maxCredentialLength;
}

/// GET /api/admin/oauth/status — one row per provider: live state, where
/// each half comes from, the redirect URI to register, and the client ID.
/// The secret itself is never returned (`hasSecret` only).
package void apiOAuthStatus(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    auto settings = loadOAuthSettings(redis);
    OAuthConfigStore store;
    try store = new OAuthConfigStore(redis);
    catch (Exception) {}
    Json[] rows;
    foreach (p; oauthProviders) {
        string prefix = "IRCFIBER_OAUTH_" ~ p.name.toUpper ~ "_";
        string envId = "";
        try envId = environment.get(prefix ~ "CLIENT_ID", "");
        catch (Exception) {}
        string envSecretVal = envSecret(prefix ~ "CLIENT_SECRET");
        string ovId = "";
        bool ovSecret = false;
        if (store !is null) {
            try {
                auto ov = store.get(p.name);
                if (!ov.isNull) {
                    ovId = ov.get.clientId;
                    ovSecret = ov.get.clientSecret.length > 0;
                }
            } catch (Exception) {}
        }
        rows ~= oauthStatusRow(p, (p.name in settings) !is null, envId,
            envSecretVal.length > 0, ovId, ovSecret, oauthRedirectUri(p.name));
    }
    Json out_ = Json.emptyObject;
    out_["providers"] = Json(rows);
    jsonOk(res, out_);
}

/// Activity window for the signups panel: an identity counts as active
/// when `lastUsedAt` falls inside it.
private enum long OAUTH_ACTIVE_WINDOW_DAYS = 30;
/// Hard cap on the signups table (admin-only list; social accounts are a
/// small slice of `users`). `truncated` tells the UI when it bit.
private enum int OAUTH_SIGNUP_LIST_MAX = 500;

/// Unix seconds for a possibly-unset stamp: `SysTime.init` is year 1, whose
/// unix time is negative — report 0 so the UI renders "—".
private long unixOrZero(SysTime t) {
    const ts = t.toUnixTime();
    return ts > 0 ? ts : 0;
}

/// Newest social use across a user's identities, 0 when never used.
private long lastSocialUse(const User u) {
    long best = 0;
    foreach (o; u.oauthIdentities) {
        const ts = unixOrZero(o.lastUsedAt);
        if (ts > best) best = ts;
    }
    return best;
}

/// GET /api/admin/oauth/signups — social-login adoption: exact
/// per-provider linked/created/active counts plus one row per user holding
/// an identity, most recent social use first.
package void apiOAuthSignups(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new UserRepository();
    auto settings = loadOAuthSettings(redis);
    const cutoff = Clock.currTime.toUnixTime() - OAUTH_ACTIVE_WINDOW_DAYS * 86_400;

    Json[] provRows;
    foreach (p; oauthProviders) {
        Json r = Json.emptyObject;
        r["name"] = Json(p.name);
        r["label"] = Json(p.label);
        r["configured"] = Json((p.name in settings) !is null);
        r["linked"] = Json(repo.countOAuthLinked(p.name));
        r["signups"] = Json(repo.countOAuthSignups(p.name));
        r["activeInWindow"] = Json(repo.countOAuthActiveSince(cutoff, p.name));
        provRows ~= r;
    }

    auto users = repo.listWithOAuth(OAUTH_SIGNUP_LIST_MAX);
    // Newest social use first; never-used (pre-tracking) identities last.
    users.sort!((a, b) => lastSocialUse(a) > lastSocialUse(b));

    Json[] userRows;
    foreach (u; users) {
        Json row = Json.emptyObject;
        row["id"] = Json(u.id.toString());
        row["username"] = Json(u.username);
        row["email"] = Json(u.email);
        row["signupIp"] = Json(u.signupIp);
        row["provisionedFrom"] = Json(u.provisionedFrom);
        row["viaSocial"] = Json(u.provisionedFrom.startsWith("oauth:"));
        row["createdAt"] = Json(unixOrZero(u.createdAt));
        row["lastLoginAt"] = Json(unixOrZero(u.lastLoginAt));
        Json[] ids;
        foreach (o; u.oauthIdentities)
            ids ~= Json([
                "provider": Json(o.provider),
                "linkedAt": Json(unixOrZero(o.linkedAt)),
                "lastUsedAt": Json(unixOrZero(o.lastUsedAt)),
                "useCount": Json(o.useCount)
            ]);
        row["identities"] = Json(ids);
        userRows ~= row;
    }

    Json totals = Json.emptyObject;
    totals["users"] = Json(cast(long) repo.count());
    totals["linked"] = Json(repo.countOAuthLinked(""));
    totals["signups"] = Json(repo.countOAuthSignups(""));
    totals["activeInWindow"] = Json(repo.countOAuthActiveSince(cutoff, ""));

    Json out_ = Json.emptyObject;
    out_["providers"] = Json(provRows);
    out_["users"] = Json(userRows);
    out_["totals"] = totals;
    out_["windowDays"] = Json(OAUTH_ACTIVE_WINDOW_DAYS);
    out_["truncated"] = Json(users.length >= OAUTH_SIGNUP_LIST_MAX);
    jsonOk(res, out_);
}

/// POST /api/admin/oauth/:provider — upsert the admin override.
/// `{clientId, clientSecret?}`; an empty/missing secret keeps the stored
/// one. Unknown provider → 404; ID missing/oversize → 400.
package void apiOAuthSave(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    string provider;
    try provider = req.params["provider"];
    catch (Exception) {}
    if (oauthProvider(provider) is null) {
        jsonError(res, 404, "Unknown provider");
        return;
    }
    auto body = readJsonBody(req);
    string id = "";
    string secret = "";
    bool secretGiven = false;
    try {
        if (auto pv = "clientId" in body) id = (*pv).get!string;
        if (auto pv = "clientSecret" in body) {
            secret = (*pv).get!string;
            secretGiven = secret.length > 0;
        }
    } catch (Exception) {
        jsonError(res, 400, "clientId string required");
        return;
    }
    id = id.strip();
    secret = secret.strip();
    if (badCredential(id)) {
        jsonError(res, 400, "clientId is required (max 512 chars)");
        return;
    }
    if (secret.length > maxCredentialLength) {
        jsonError(res, 400, "clientSecret too long (max 512 chars)");
        return;
    }
    OAuthConfigStore store;
    try store = new OAuthConfigStore(redis);
    catch (Exception e) {
        jsonError(res, 503, "Settings store unavailable");
        return;
    }
    if (!secretGiven) {
        try {
            auto existing = store.get(provider);
            if (!existing.isNull) secret = existing.get.clientSecret;
        } catch (Exception) {}
    }
    if (secret.length == 0) {
        jsonError(res, 400, "clientSecret is required (no secret stored yet)");
        return;
    }
    try store.put(provider, OAuthConfigOverride(id, secret));
    catch (Exception e) {
        jsonError(res, 503, "Saving settings failed");
        return;
    }
    Json out_ = Json.emptyObject;
    out_["ok"] = Json(true);
    out_["provider"] = Json(provider);
    jsonOk(res, out_);
}

/// DELETE /api/admin/oauth/:provider — drop the admin override; the
/// provider falls back to env (usually: off). Unknown provider → 404.
package void apiOAuthClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    string provider;
    try provider = req.params["provider"];
    catch (Exception) {}
    if (oauthProvider(provider) is null) {
        jsonError(res, 404, "Unknown provider");
        return;
    }
    try new OAuthConfigStore(redis).remove(provider);
    catch (Exception) {
        jsonError(res, 503, "Settings store unavailable");
        return;
    }
    Json out_ = Json.emptyObject;
    out_["ok"] = Json(true);
    out_["provider"] = Json(provider);
    jsonOk(res, out_);
}
