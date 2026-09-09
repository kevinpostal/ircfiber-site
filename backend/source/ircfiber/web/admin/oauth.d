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
import std.process : environment;
import std.string : strip, toUpper;

import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.env : envSecret;
import ircfiber.oauth : OAuthConfigOverride, OAuthConfigStore, loadOAuthSettings,
    oauthProvider, oauthProviders, oauthRedirectUri, oauthStatusRow;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;

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
