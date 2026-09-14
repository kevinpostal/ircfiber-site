/**
 * FiberEye's open-session bookkeeping: which client sessions the bot has
 * seen connect and not yet seen quit.
 *
 * Pure in-memory state, no IO, so the invariant that actually matters is
 * testable (`tests/fibereye_test.d`): a session must stay findable across
 * a nick change. The ircd's QUIT notice carries the nick the client is
 * using *at quit time*, so a map keyed by the connect nick loses every
 * session that renamed — the row is never closed (no `durationMs`, no
 * short-session churn count) and the "open sessions" gauge climbs for
 * good. That was a live bug until the `NICK` snotice was wired up.
 *
 * Keys are `toLower(nick) \0 ip`: IRC nicks are case-insensitive, and the
 * address disambiguates the same nick reconnecting from elsewhere.
 * Sessions are evicted oldest-first at a caller-supplied cap so a flood
 * can never grow the maps without bound.
 */
module ircfiber.fibereye.sessions;

import std.algorithm.sorting : sort;
import std.string : toLower;

import ircfiber.fibereye.format : ipGroup;

/// One session the bot saw connect and has not seen quit.
struct OpenSession {
    /// `fibereye_sessions._id`.
    string id;
    /// Nick the client is using now — the connect nick until it renames.
    string nick;
    /// Real IP as the ircd reported it at connect time.
    string ip;
    /// Connect instant (unix ms), so a quit computes its duration without
    /// reading the session row back from Mongo.
    long openedAt;
}

/// The open-session map. Not a class: it is plain state owned by the bot's
/// single read-loop fiber, and copying it is never wanted.
struct OpenSessions {
    /// `key(nick, ip)` → session id.
    private string[string] byKey;
    /// Session id → its record. The reverse index is what makes a rename
    /// O(1) instead of a scan of the whole map.
    private OpenSession[string] byId;
    /// Ids in insertion order, for oldest-first eviction. May hold ids
    /// that are already gone (closed, or rebound by a reconnect); those
    /// evict as no-ops, which keeps eviction O(1) amortised.
    private string[] order;

    private static string key(string nick, string ip) @safe pure {
        return nick.toLower() ~ "\0" ~ ip;
    }

    /// Sessions currently open.
    size_t length() const @safe nothrow { return byId.length; }

    /// Records a connect. `cap` bounds the map: the oldest session is
    /// dropped once it is exceeded, which only costs that session its
    /// `durationMs` — it has been open longer than `cap` others.
    void remember(string nick, string ip, string id, long atMs, size_t cap) @safe {
        if (!id.length) return;
        byKey[key(nick, ip)] = id;
        byId[id] = OpenSession(id, nick, ip, atMs);
        order ~= id;
        while (cap > 0 && order.length > cap) {
            const evict = order[0];
            order = order[1 .. $];
            drop(evict);
        }
    }

    /// Moves an open session to its new nick, so the quit notice — which
    /// carries the new nick — still finds it. False when the old nick is
    /// not open here (its connect predates this bot, or it was evicted);
    /// the caller still has the IP group to update.
    bool rename(string oldNick, string newNick, string ip, out OpenSession s) @safe {
        string from = key(oldNick, ip);
        auto found = from in byKey;
        if (found is null) return false;
        const id = *found;
        auto rec = id in byId;
        if (rec is null) {                 // stale key; nothing to move
            byKey.remove(from);
            return false;
        }
        byKey.remove(from);
        rec.nick = newNick;
        byKey[key(newNick, ip)] = id;
        s = *rec;
        return true;
    }

    /// Takes the session out of the map on quit. False when this
    /// nick/address pair has no open session.
    bool close(string nick, string ip, out OpenSession s) @safe {
        string k = key(nick, ip);
        auto found = k in byKey;
        if (found is null) return false;
        const id = *found;
        auto rec = id in byId;
        if (rec is null) {
            byKey.remove(k);
            return false;
        }
        s = *rec;
        drop(id);
        return true;
    }

    /// The newest open session using `nick` on any address — a WHOIS reply
    /// (numeric 330) carries no IP, so the nick is all there is to key on.
    bool findByNick(string nick, out OpenSession s) const @safe {
        bool have;
        foreach (id, rec; byId) {
            if (rec.nick.toLower() != nick.toLower()) continue;
            if (have && rec.openedAt <= s.openedAt) continue;
            s = OpenSession(rec.id, rec.nick, rec.ip, rec.openedAt);
            have = true;
        }
        return have;
    }

    /// Open sessions whose address is `mask`, or whose IP group is — the
    /// ircd's connectban notice carries only the mask, never the nick that
    /// tripped it. Newest connect first (ties broken by nick, so the same
    /// state always attributes the same way), capped at `limit`.
    OpenSession[] forMask(string mask, size_t limit) const @safe {
        if (!mask.length || limit == 0) return null;
        OpenSession[] hits;
        foreach (id, rec; byId) {
            if (rec.ip != mask && ipGroup(rec.ip) != mask) continue;
            hits ~= OpenSession(rec.id, rec.nick, rec.ip, rec.openedAt);
        }
        hits.sort!((a, b) => a.openedAt != b.openedAt
            ? a.openedAt > b.openedAt
            : a.nick < b.nick);
        if (hits.length > limit) hits = hits[0 .. limit];
        return hits;
    }

    /// Removes every trace of one id. The key is only unbound when it
    /// still points at *this* id: a reconnect with the same nick and
    /// address rebinds the key to a newer row, and evicting the old id
    /// must not take the live session's key with it.
    private void drop(string id) @safe {
        if (auto rec = id in byId) {
            string k = key(rec.nick, rec.ip);
            if (auto cur = k in byKey) {
                if (*cur == id) byKey.remove(k);
            }
            byId.remove(id);
        }
    }
}
