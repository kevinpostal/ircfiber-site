/**
 * Public self-service ban appeal (`/unban`, `/unban/<token>`).
 *
 * A visitor whose address FiberEye Z-lined sees the appeal URL in the ban
 * reason itself, which is the only channel a banned client has. Solving a
 * Cloudflare Turnstile challenge here removes the Z-line, so an ordinary
 * user who tripped the flood detector can get back on the network without
 * finding an oper.
 *
 * The safety rules, in order of importance:
 *   1. Only *machine-placed* Z-lines are liftable — `isAutoPlacedZline`
 *      matches the `FiberEye:` reason marker that both FiberEye and the
 *      ircd's own `<connectban banmessage>` carry. A human oper's ban can
 *      never be removed from here.
 *   2. A catch-all mask (`*`, `0.0.0.0/0`, `::/0`) never counts as "the
 *      visitor's own ban" — `zlineMatches` rejects those outright.
 *   3. No release without a verified challenge. A missing Turnstile secret
 *      fails closed with 503 rather than releasing.
 *   4. Rate limits per client IP and per IP group, so the endpoint cannot
 *      be used to keep an address permanently unbanned.
 *
 * The actual `ZLINE` removal runs over the dashboard-oper session in
 * `ircfiber.web.admin.ircd.removeXlineNow` — the web process is the one
 * that holds a ZLINE-capable oper session, and any oper may remove any
 * X-line.
 *
 * Env:
 *   IRCFIBER_TURNSTILE_SITE_KEY        rendered into the page; unset → the
 *                                      offer stage explains it is off
 *   IRCFIBER_TURNSTILE_SECRET(_FILE)   siteverify secret; unset → 503
 */
module ircfiber.web.unban;

import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.string : strip;
import core.time : seconds;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : HTTPClientRequest, HTTPClientResponse, HTTPClientSettings, requestHTTP;
import vibe.http.common : HTTPMethod;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse, render;
import vibe.stream.operations : readAll;
import vibe.textfilter.urlencode : urlEncode;

import ircfiber.env : envSecret;
import ircfiber.fibereye.events : Appeal, fiberEyeAppealKey, fiberEyeReleaseGrpKey,
    fiberEyeReleaseIpKey;
import ircfiber.fibereye.format : ipGroup, zlineMatches;
import ircfiber.fibereye.rules : isAutoPlacedZline;
import ircfiber.fibereye.store : FiberEyeStore;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.ircd : IrcdError, XLine, listXlinesNow, removeXlineNow;
import ircfiber.web.common : getClientIp;

/// Attempts per client IP per day.
private enum RELEASE_IP_LIMIT = 3;
/// Successful releases per IP group per week.
private enum RELEASE_GROUP_LIMIT = 2;

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

/// What the visitor is being offered, resolved from either the token or
/// their own address.
private struct Resolved {
    bool ok;
    /// Z-line mask exactly as the ircd lists it.
    string mask;
    /// IP group the ban was computed for.
    string ipGroup;
    /// `fibereye_bans._id`, empty when resolved tokenlessly.
    string banId;
    /// Ban expiry (unix ms), 0 when unknown.
    long expiresAtMs;
    /// Set when the ircd could not be reached at all.
    bool ircdUnavailable;
}

/// Token path: the appeal record names the mask, so no `STATS Z` is
/// needed and an expired appeal key is itself the "no longer banned"
/// answer.
private Resolved resolveByToken(RedisStorage redis, string token) {
    Resolved r;
    if (redis is null || !token.length) return r;
    Json j = Json(null);
    try j = redis.getJson(fiberEyeAppealKey(token));
    catch (Exception e) {
        logWarn("unban: appeal lookup failed: %s", e.msg);
        return r;
    }
    if (j.type != Json.Type.object) return r;
    const a = Appeal.fromJson(j);
    if (!a.mask.length) return r;
    r.ok = true;
    r.mask = a.mask;
    r.ipGroup = a.ipGroup.length ? a.ipGroup : a.mask;
    r.banId = a.banId;
    r.expiresAtMs = a.expiresAtMs;
    return r;
}

/// Tokenless path: the visitor is here from a connection refusal, so the
/// only identity we have is their address. Pick the first live Z-line that
/// covers it AND is machine-placed.
private Resolved resolveByAddress(string clientIp) {
    Resolved r;
    if (!clientIp.length) return r;
    XLine[] lines;
    try
        lines = listXlinesNow("zline");
    catch (Exception e) {
        logWarn("unban: STATS Z unavailable: %s", e.msg);
        r.ircdUnavailable = true;
        return r;
    }
    foreach (x; lines) {
        if (!zlineMatches(x.mask, clientIp)) continue;
        if (!isAutoPlacedZline(x.reason)) continue;
        r.ok = true;
        r.mask = x.mask;
        r.ipGroup = ipGroup(clientIp);
        if (x.durationSecs > 0) r.expiresAtMs = (x.setAt + x.durationSecs) * 1000;
        break;
    }
    return r;
}

private string turnstileSiteKey() {
    return environment.get("IRCFIBER_TURNSTILE_SITE_KEY", "").strip();
}

/// `incr` + `expire`-when-1, fail-open on a Redis exception exactly like
/// the signup IP limiter: a Redis outage must not lock a legitimate
/// visitor out of the only appeal channel they have.
private bool limitHit(RedisStorage redis, string key, long ttlSeconds, long limit) {
    if (redis is null) return false;
    try {
        auto db = redis.getDb();
        const n = db.incr(key);
        if (n == 1) db.expire(key, ttlSeconds);
        return n > limit;
    } catch (Exception e) {
        logWarn("unban: rate limit check failed: %s", e.msg);
        return false;
    }
}

/// Verifies a Turnstile response token. Returns false for every failure
/// mode — a network error, a non-2xx answer, `success: false` — so the
/// release path can never be reached without a real solve.
private bool turnstileVerified(string secret, string response, string remoteIp) {
    if (!secret.length || !response.length) return false;
    const payload = "secret=" ~ urlEncode(secret)
        ~ "&response=" ~ urlEncode(response)
        ~ (remoteIp.length ? "&remoteip=" ~ urlEncode(remoteIp) : "");
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 5.seconds;
    settings.readTimeout = 5.seconds;
    int status;
    string body_;
    try {
        requestHTTP("https://challenges.cloudflare.com/turnstile/v0/siteverify",
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.POST;
                req.headers["Content-Type"] = "application/x-www-form-urlencoded";
                req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
                req.headers["Content-Length"] = payload.length.to!string;
                req.bodyWriter.write(cast(const(ubyte)[]) payload);
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try body_ = cast(string) res.bodyReader.readAll();
                catch (Exception e) logWarn("unban: reading siteverify response failed: %s", e.msg);
            },
            settings);
    } catch (Exception e) {
        logWarn("unban: siteverify request failed: %s", e.msg);
        return false;
    }
    if (status < 200 || status >= 300) {
        logWarn("unban: siteverify returned HTTP %s", status);
        return false;
    }
    try {
        auto j = parseJsonString(body_);
        return j.type == Json.Type.object
            && j["success"].type == Json.Type.bool_
            && j["success"].get!bool;
    } catch (Exception e) {
        logWarn("unban: siteverify answer unparsable: %s", e.msg);
        return false;
    }
}

private string tokenOf(HTTPServerRequest req) {
    if (auto p = "token" in req.params) return (*p).strip();
    return "";
}

/// GET /unban and GET /unban/:token — show the offer, or say why there is
/// nothing to lift.
package void unbanGet(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const token = tokenOf(req);
    if (token.length) {
        auto r = resolveByToken(redis, token);
        if (!r.ok) {
            renderUnban(res, 410, "none", "", token, 0,
                "This appeal link has expired or the ban is no longer active.");
            return;
        }
        renderUnban(res, 200, "offer", r.mask, token, r.expiresAtMs, "");
        return;
    }
    const clientIp = getClientIp(req);
    auto r = resolveByAddress(clientIp);
    if (r.ircdUnavailable) {
        renderUnban(res, 502, "error", "", "", 0,
            "We can't reach the IRC server right now. Please try again in a minute.");
        return;
    }
    if (!r.ok) {
        renderUnban(res, 404, "none", "", "", 0,
            "We don't see an automatic ban on your address.");
        return;
    }
    renderUnban(res, 200, "offer", r.mask, "", r.expiresAtMs, "");
}

/// POST /unban and POST /unban/:token — verify the challenge, then lift.
package void unbanPost(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const token = tokenOf(req);
    const clientIp = getClientIp(req);

    // 1. Re-resolve: the ban may have expired between the GET and this POST.
    Resolved r;
    if (token.length) {
        r = resolveByToken(redis, token);
        if (!r.ok) {
            renderUnban(res, 410, "none", "", token, 0,
                "This appeal link has expired or the ban is no longer active.");
            return;
        }
    } else {
        r = resolveByAddress(clientIp);
        if (r.ircdUnavailable) {
            renderUnban(res, 502, "error", "", "", 0,
                "We can't reach the IRC server right now. Please try again in a minute.");
            return;
        }
        if (!r.ok) {
            renderUnban(res, 404, "none", "", "", 0,
                "We don't see an automatic ban on your address.");
            return;
        }
    }

    // 2. Abuse counters, before the challenge so a solve cannot be spent
    //    on an attempt that was never going to be allowed.
    const overIp = limitHit(redis, fiberEyeReleaseIpKey(clientIp), 86_400, RELEASE_IP_LIMIT);
    const overGroup = redis is null ? false : groupLimitHit(redis, r.ipGroup);
    if (overIp || overGroup) {
        renderUnban(res, 429, "limited", r.mask, token, r.expiresAtMs,
            "This address has already been unbanned recently. "
            ~ "Please contact staff in #support.");
        return;
    }

    // 3. The challenge. Never release without one.
    const secret = envSecret("IRCFIBER_TURNSTILE_SECRET", "").strip();
    if (!secret.length) {
        renderUnban(res, 503, "error", r.mask, token, r.expiresAtMs,
            "Self-service unban is not configured.");
        return;
    }
    const answer = req.form.get("cf-turnstile-response", "").strip();
    if (!turnstileVerified(secret, answer, clientIp)) {
        renderUnban(res, 400, "offer", r.mask, token, r.expiresAtMs,
            "Verification failed. Please try the challenge again.");
        return;
    }

    // 4. Remove the Z-line.
    try
        removeXlineNow("zline", r.mask);
    catch (IrcdError e) {
        logWarn("unban: removal of %s failed: %s", r.mask, e.msg);
        renderUnban(res, 502, "error", r.mask, token, r.expiresAtMs,
            "We couldn't remove the ban just now. Please try again in a minute.");
        return;
    } catch (Exception e) {
        logWarn("unban: removal of %s failed: %s", r.mask, e.msg);
        renderUnban(res, 502, "error", r.mask, token, r.expiresAtMs,
            "We couldn't remove the ban just now. Please try again in a minute.");
        return;
    }

    // 5. Record it. Best-effort: the ban is already gone, and failing the
    //    visitor's page over a bookkeeping error would be perverse.
    try {
        auto store = new FiberEyeStore();
        auto ban = r.banId.length ? store.findBanById(r.banId) : store.findBanByToken(token);
        if (!ban.isNull) {
            store.markBanReleased(ban.get.id, nowMs(), "self-service");
            store.setIpBan(ban.get.ipGroup, 0, ban.get.id, ban.get.strikes);
        }
    } catch (Exception e) {
        logWarn("unban: recording the release of %s failed: %s", r.mask, e.msg);
    }
    if (redis !is null && token.length) redis.del(fiberEyeAppealKey(token));
    countGroupRelease(redis, r.ipGroup);
    logInfo("FiberEye: self-service release of %s from %s", r.mask, clientIp);
    renderUnban(res, 200, "released", r.mask, "", 0,
        "Your address is no longer banned. Reconnect to irc.ircfiber.com.");
}

/// Reads the per-group weekly release counter without incrementing it —
/// the increment happens only on success (`countGroupRelease`), so a
/// failed challenge does not burn the group's allowance.
private bool groupLimitHit(RedisStorage redis, string group) {
    if (!group.length) return false;
    try {
        const raw = redis.getDb().get(fiberEyeReleaseGrpKey(group));
        if (!raw.length) return false;
        return raw.to!long >= RELEASE_GROUP_LIMIT;
    } catch (Exception e) {
        logWarn("unban: group release counter unreadable: %s", e.msg);
        return false;
    }
}

private void countGroupRelease(RedisStorage redis, string group) {
    if (redis is null || !group.length) return;
    try {
        auto db = redis.getDb();
        const key = fiberEyeReleaseGrpKey(group);
        const n = db.incr(key);
        if (n == 1) db.expire(key, 604_800);
    } catch (Exception e) {
        logWarn("unban: group release counter not updated: %s", e.msg);
    }
}

/// Renders `unban.dt`. `stage` is one of `offer`, `released`, `none`,
/// `limited`, `error`. `expiresAtMs` is turned into text here rather than
/// in the template: the view has no formatting helpers.
private void renderUnban(HTTPServerResponse res, int status, string stage,
        string mask, string token, long expiresAtMs, string message) {
    const siteKey = turnstileSiteKey();
    const formAction = token.length ? "/unban/" ~ token : "/unban";
    string expires;
    if (expiresAtMs > 0) {
        const remaining = expiresAtMs - nowMs();
        if (remaining > 0) {
            const mins = remaining / 60_000;
            if (mins >= 120) expires = "about " ~ (mins / 60).to!string ~ " hours";
            else if (mins >= 2) expires = "about " ~ mins.to!string ~ " minutes";
            else expires = "under a minute";
        }
    }
    res.statusCode = status;
    res.render!("unban.dt", stage, mask, expires, message, siteKey, formAction)();
}
