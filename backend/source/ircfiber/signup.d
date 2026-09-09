/**
 * Verify-first signup: no account (Mongo row, network, NickServ) exists
 * until the signer clicks the emailed link.
 *
 * POST /register stores a PendingSignup in Redis (24h TTL) and mails a
 * `/verify?token=` link; POST /verify consumes the token and creates the
 * account. Existing users are untouched — the User model does not change.
 *
 * Pure helpers (token, link, email body, expiry gate) are unit-tested in
 * tests/signup_test.d. The Redis store needs a live Redis and is covered
 * by the live verification flow instead.
 */
module ircfiber.signup;

import std.conv : to;
import std.process : environment;
import std.string : strip, toLower;
import std.typecons : Nullable, nullable;
import std.uuid : randomUUID;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisDatabase;
import vibe.textfilter.html : htmlEscape, htmlAttribEscape;

import ircfiber.mail : MailMessage, MailSettings;
import ircfiber.services.accounts : generateServicesPassword;
import ircfiber.storage.redis : RedisStorage;

struct PendingSignup {
    string username;
    string email;
    string passwordHash;
    string signupIp;
    long createdAt; // unix seconds

    // Keys: username,email,passwordHash,signupIp,createdAt.
    Json toJson() const @safe {
        Json j = Json.emptyObject;
        j["username"] = Json(username);
        j["email"] = Json(email);
        j["passwordHash"] = Json(passwordHash);
        j["signupIp"] = Json(signupIp);
        j["createdAt"] = Json(createdAt);
        return j;
    }

    // Throws on missing keys.
    static PendingSignup fromJson(Json j) @safe {
        PendingSignup p;
        p.username = j["username"].get!string;
        p.email = j["email"].get!string;
        p.passwordHash = j["passwordHash"].get!string;
        p.signupIp = j["signupIp"].get!string;
        p.createdAt = j["createdAt"].get!long;
        return p;
    }
}

enum pendingTtlSeconds = 24 * 3600;
enum resendCooldownSeconds = 60;
enum ipHourlyLimit = 10;

string pendingKey(string token) @safe pure {
    return "signup:pending:" ~ token;
}

string sentKey(string emailLower) @safe pure {
    return "signup:sent:" ~ emailLower;
}

string ipKey(string ip) @safe pure {
    return "signup:ip:" ~ ip;
}

// 40 unbiased [A-Za-z0-9] chars from /dev/urandom (~238 bits). Reuses
// ircfiber.services.accounts.generateServicesPassword(40) — same
// generator, already tested; URL-safe so no encoding is needed in the link.
string newSignupToken() {
    return generateServicesPassword(40);
}

/// Bulk-campaign List-Unsubscribe tokens, mirroring the PendingSignup
/// pattern: per-recipient random token (same generator as signup tokens),
/// Redis `campaign:unsub:<token>` → lowercased email, 30-day TTL, single
/// use (consumed on POST). Created only for addresses actually mailed.
enum campaignUnsubTtlSeconds = 30 * 24 * 3600;

string campaignUnsubKey(string token) @safe pure {
    return "campaign:unsub:" ~ token;
}

// `<base without trailing '/'>/unsubscribe?token=<token>`
string unsubscribeLink(string publicBaseUrl, string token) @safe pure {
    string base = publicBaseUrl;
    while (base.length > 0 && base[$ - 1] == '/')
        base = base[0 .. $ - 1];
    return base ~ "/unsubscribe?token=" ~ token;
}

// `<base without trailing '/'>/verify?token=<token>`
string verificationLink(string publicBaseUrl, string token) @safe pure {
    string base = publicBaseUrl;
    while (base.length > 0 && base[$ - 1] == '/')
        base = base[0 .. $ - 1];
    return base ~ "/verify?token=" ~ token;
}

// Builds the email. `username` is escaped in the html body; the link
// is alnum-only but goes through htmlAttribEscape in the href regardless.
MailMessage verificationEmail(string username, string email, string link) @safe {
    MailMessage m;
    m.toEmail = email;
    m.subject = "Confirm your IRC Fiber account";
    m.text = "Hi " ~ username ~ ",\n"
        ~ "\n"
        ~ "Confirm your email address to finish creating your IRC Fiber account:\n"
        ~ "\n"
        ~ link ~ "\n"
        ~ "\n"
        ~ "This link expires in 24 hours. If you did not sign up, "
        ~ "ignore this email: no account is created until the link is used.\n";
    const safeUser = htmlEscape(username).idup;
    const safeLink = htmlAttribEscape(link).idup;
    m.html = "<p>Hi " ~ safeUser ~ ",</p>"
        ~ "<p>Confirm your email address to finish creating your IRC Fiber account:</p>"
        ~ "<p><a href=\"" ~ safeLink ~ "\">" ~ safeLink ~ "</a></p>"
        ~ "<p>This link expires in 24 hours. If you did not sign up, "
        ~ "ignore this email: no account is created until the link is used.</p>";
    return m;
}

// IRCFIBER_EMAIL_VERIFICATION: "1"/"true" -> required, "0"/"false" -> off,
// unset/other -> required iff `mail.configured`.
bool emailVerificationRequired(const MailSettings mail) {
    const raw = environment.get("IRCFIBER_EMAIL_VERIFICATION", "").strip().toLower();
    if (raw == "1" || raw == "true") return true;
    if (raw == "0" || raw == "false") return false;
    return mail.configured;
}

// Pending-signup store on Redis (24h TTL, no Mongo collection).
final class PendingSignupStore {
    private RedisStorage redis;

    this(RedisStorage redis) {
        this.redis = redis;
    }

    private RedisDatabase db() @trusted {
        return redis.getDb();
    }

    // Throws on Redis failure (the caller turns it into 503; a signup
    // must not report "sent" when nothing was stored).
    void put(string token, PendingSignup p) {
        db().setEX(pendingKey(token), pendingTtlSeconds, p.toJson().toString());
    }

    bool exists(string token) {
        try {
            return db().exists(pendingKey(token));
        } catch (Exception) {
            return false;
        }
    }

    // GET+DEL (not GETDEL): a lost race here only means the second take
    // sees nothing; the loser of a concurrent double-submit fails
    // harmlessly.
    Nullable!PendingSignup take(string token) {
        try {
            auto raw = db().get(pendingKey(token));
            if (raw.length == 0) return Nullable!PendingSignup.init;
            db().del(pendingKey(token));
            return nullable(PendingSignup.fromJson(parseJsonString(raw)));
        } catch (Exception e) {
            logWarn("signup: taking pending signup failed: %s", e.msg);
            return Nullable!PendingSignup.init;
        }
    }

    // The exact SET NX EX + read-back-compare pattern from the retry
    // throttle in rest.d; true when someone else holds the cooldown.
    // Redis exception: logWarn and false (fail-open, like the throttle).
    bool emailCooldownHit(string emailLower) {
        const key = sentKey(emailLower);
        const marker = randomUUID().toString();
        try {
            db().request!string("SET", key, marker, "NX", "EX",
                resendCooldownSeconds.to!string);
            return db().get(key) != marker;
        } catch (Exception e) {
            logWarn("signup: email cooldown check failed: %s", e.msg);
            return false;
        }
    }

    // Exception: logWarn and false (fail-open).
    bool ipLimitHit(string ip) {
        try {
            auto n = db().incr(ipKey(ip));
            if (n == 1) db().expire(ipKey(ip), 3600);
            return n > ipHourlyLimit;
        } catch (Exception e) {
            logWarn("signup: IP limit check failed: %s", e.msg);
            return false;
        }
    }
}
