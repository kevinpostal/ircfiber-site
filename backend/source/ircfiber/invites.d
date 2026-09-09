/**
 * Single-use 24h invite tokens for NickServ-less nicks (`!adduser` invite
 * path). New file rather than growing `signup.d`: that module documents
 * itself as the verify-first email flow and shares nothing but the token
 * generator.
 *
 * Flow: oper runs `!adduser <nick>` for a nick with no NickServ account →
 * bot mints a token, stores `InvitePending` in Redis with 24h TTL, PMs the
 * target a `/invite?token=` link. The invitee redeems it on the site, which
 * creates the account through the normal verified path with the username
 * locked to the token record.
 */
module ircfiber.invites;

import std.typecons : Nullable, nullable;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisDatabase;

import ircfiber.services.accounts : generateServicesPassword;
import ircfiber.storage.redis : RedisStorage;

struct InvitePending {
    string nick;        /// NickServ-less IRC nick, locked at redemption
    string invitedBy;   /// oper nick that ran !adduser, for audit
    long createdAt;     /// unix seconds

    Json toJson() const @safe {
        Json j = Json.emptyObject;
        j["nick"] = Json(nick);
        j["invitedBy"] = Json(invitedBy);
        j["createdAt"] = Json(createdAt);
        return j;
    }

    /// Throws on missing keys.
    static InvitePending fromJson(Json j) @safe {
        InvitePending p;
        p.nick = j["nick"].get!string;
        p.invitedBy = j["invitedBy"].get!string;
        p.createdAt = j["createdAt"].get!long;
        return p;
    }
}

enum inviteTtlSeconds = 24 * 3600;

/// Redis key for one invite token.
string inviteKey(string token) @safe pure {
    return "signup:invite:" ~ token;
}

/// 40 unbiased [A-Za-z0-9] chars, URL-safe alnum, no encoding needed.
string newInviteToken() {
    return generateServicesPassword(40);
}

/// `<base without trailing '/'>/invite?token=<token>`
string inviteLink(string publicBaseUrl, string token) @safe pure {
    string base = publicBaseUrl;
    while (base.length > 0 && base[$ - 1] == '/')
        base = base[0 .. $ - 1];
    return base ~ "/invite?token=" ~ token;
}

final class InviteStore {
    private RedisStorage redis;

    this(RedisStorage redis) {
        this.redis = redis;
    }

    private RedisDatabase db() @trusted {
        return redis.getDb();
    }

    /// setEX TTL, throws on Redis failure.
    void put(string token, InvitePending p) {
        db().setEX(inviteKey(token), inviteTtlSeconds, p.toJson().toString());
    }

    bool exists(string token) {
        try {
            return db().exists(inviteKey(token));
        } catch (Exception) {
            return false;
        }
    }

    /// GET+DEL, null when absent/raced.
    Nullable!InvitePending take(string token) {
        try {
            auto raw = db().get(inviteKey(token));
            if (raw.length == 0) return Nullable!InvitePending.init;
            db().del(inviteKey(token));
            return nullable(InvitePending.fromJson(parseJsonString(raw)));
        } catch (Exception e) {
            logWarn("invites: taking invite failed: %s", e.msg);
            return Nullable!InvitePending.init;
        }
    }

    /// Peek without consuming (for rendering the locked-nick form).
    Nullable!InvitePending peek(string token) {
        try {
            auto raw = db().get(inviteKey(token));
            if (raw.length == 0) return Nullable!InvitePending.init;
            return nullable(InvitePending.fromJson(parseJsonString(raw)));
        } catch (Exception e) {
            logWarn("invites: peeking invite failed: %s", e.msg);
            return Nullable!InvitePending.init;
        }
    }
}
