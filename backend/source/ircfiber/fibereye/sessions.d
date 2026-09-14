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
 *
 * The map is per IRC session: a reconnect or a restart starts it empty
 * while Mongo still holds the rows of everyone who is connected right
 * now. `planReconcile` is the other half — it pairs a WHOX sweep of the
 * live network against those rows, so sessions survive a restart instead
 * of hanging open forever. It is pure, so the pairing rules (and the
 * cases where it refuses to guess) are asserted in the test binary.
 */
module ircfiber.fibereye.sessions;

import std.algorithm.comparison : min;
import std.algorithm.sorting : sort;
import std.array : array;
import std.range : iota;
import std.string : toLower;
import std.uni : icmp;

import ircfiber.fibereye.format : ipGroup, WhoEntry;

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

/// One `fibereye_sessions` row with no quit recorded yet.
struct OpenRow {
    /// `fibereye_sessions._id`.
    string id;
    /// Nick at connect time.
    string nick;
    /// Nick in force when the row was last touched; empty on rows written
    /// before nick changes were tracked.
    string currentNick;
    /// Real IP and its ban/flood group.
    string ip, ipGroup;
    /// Connect instant (unix ms).
    long ts;

    /// The nick this session was last known to be using.
    string knownNick() const @safe pure nothrow {
        return currentNick.length ? currentNick : nick;
    }
}

/// A rename the sweep found: the client renamed while the bot was away.
struct ReconcileRename {
    string id, ipGroup, nick;
}

/// What a reconciliation would do. Pure data, so the pairing rules are
/// asserted without Mongo or an ircd, and the bot only has to apply it.
struct ReconcilePlan {
    /// Rows whose client is still connected, with the live nick filled in:
    /// these go back into the open-session map so the eventual QUIT closes
    /// them with a real duration instead of leaving them open for good.
    OpenRow[] adopt;
    /// Adopted rows whose live nick differs from the stored one.
    ReconcileRename[] rename;
    /// Ids whose client is provably gone.
    string[] abandon;
    /// Live clients with no open row — their connect was never recorded
    /// (it predates the deployment, or the row aged out). Deliberately
    /// reported and not turned into rows: a synthesised connect would
    /// inflate the rollup's `connects` and the flood counters.
    WhoEntry[] unknown;
    /// Rows left open because pairing was not provable.
    long ambiguous;
}

/// Pairs a WHOX sweep of the live network against the session rows that
/// are still open, and says what to adopt, rename, close and report.
///
/// `haveIps` is the caller's answer to "did the ircd actually give us
/// addresses" — without `users/auspex` every `354` carries
/// `WHOX_IP_HIDDEN` instead, and matching on that would fold the whole
/// network into one fictional address. With addresses the pairing is
/// exact; without them it falls back to the nick alone, which is still
/// sound (a nick is unique network-wide at any instant) but cannot see a
/// client that renamed while the bot was away.
///
/// Nothing here guesses: a row is only closed when no live client can
/// possibly be it, and an ambiguous group (several unpaired clients
/// behind one VPN exit) is counted rather than resolved.
ReconcilePlan planReconcile(const WhoEntry[] live, const OpenRow[] rows, bool haveIps) @safe {
    ReconcilePlan p;
    if (!rows.length && !live.length) return p;

    // Newest row first: a nick that connected twice adopts its newest
    // row, and identical input always yields an identical plan.
    auto order = iota(rows.length).array;
    order.sort!((a, b) => rows[a].ts != rows[b].ts
        ? rows[a].ts > rows[b].ts
        : rows[a].id < rows[b].id);

    auto rowTaken = new bool[rows.length];
    auto liveTaken = new bool[live.length];
    auto liveGroup = new string[live.length];
    foreach (i, ref e; live)
        liveGroup[i] = (haveIps && !e.ipHidden) ? ipGroup(e.ip) : "";

    // Pass 1 — the nick is the join key: it is unique network-wide at any
    // instant, so a live nick equal to an open row's nick is that row's
    // client. The address, when we have it, must agree — a stale row can
    // carry a nick a different client now holds.
    foreach (i, ref e; live) {
        foreach (ri; order) {
            if (rowTaken[ri]) continue;
            const r = rows[ri];
            if (liveGroup[i].length && r.ipGroup != liveGroup[i]) continue;
            if (icmp(r.knownNick(), e.nick) != 0 && icmp(r.nick, e.nick) != 0) continue;
            rowTaken[ri] = true;
            liveTaken[i] = true;
            p.adopt ~= OpenRow(r.id, r.nick, e.nick, r.ip, r.ipGroup, r.ts);
            if (icmp(r.knownNick(), e.nick) != 0)
                p.rename ~= ReconcileRename(r.id, r.ipGroup, e.nick);
            break;
        }
    }

    // Pass 2 — renamed while the bot was away, so no nick matches. When a
    // group has exactly one unpaired client and exactly one unpaired row
    // they are the same session; anything less certain is left alone.
    if (haveIps) {
        foreach (i, ref e; live) {
            if (liveTaken[i] || !liveGroup[i].length) continue;
            size_t liveHere, rowsHere, only;
            foreach (j; 0 .. live.length)
                if (!liveTaken[j] && liveGroup[j] == liveGroup[i]) liveHere++;
            foreach (ri; order)
                if (!rowTaken[ri] && rows[ri].ipGroup == liveGroup[i]) { rowsHere++; only = ri; }
            if (liveHere != 1 || rowsHere != 1) continue;
            const r = rows[only];
            rowTaken[only] = true;
            liveTaken[i] = true;
            p.adopt ~= OpenRow(r.id, r.nick, e.nick, r.ip, r.ipGroup, r.ts);
            p.rename ~= ReconcileRename(r.id, r.ipGroup, e.nick);
        }
    }

    // Pass 3 — a row is gone only when nothing unpaired could be it.
    foreach (ri; order) {
        if (rowTaken[ri]) continue;
        const r = rows[ri];
        bool gone = true;
        if (haveIps) {
            foreach (j; 0 .. live.length)
                if (!liveTaken[j] && liveGroup[j] == r.ipGroup) { gone = false; break; }
        } else {
            // No addresses: the weaker "is this nick online at all". A
            // client that renamed while we were away is indistinguishable
            // from one that quit, and its row is unrecoverable either way.
            foreach (ref e; live)
                if (icmp(e.nick, r.knownNick()) == 0 || icmp(e.nick, r.nick) == 0) { gone = false; break; }
        }
        if (gone) p.abandon ~= r.id;
        else p.ambiguous++;
    }

    foreach (i, ref e; live) {
        if (liveTaken[i]) continue;
        p.unknown ~= WhoEntry(e.ok, e.nick, e.ip, e.account, e.ipHidden);
    }
    return p;
}
