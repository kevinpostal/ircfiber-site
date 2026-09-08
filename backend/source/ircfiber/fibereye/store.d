/**
 * FiberEye's Mongo persistence: one document per client session, one
 * rollup document per IP group and one document per placed (or merely
 * contemplated) ban.
 *
 * This lives in the backend tree rather than `common/source/ircfiber/db/`
 * because `common/` is vendored byte-identically into three places and the
 * engine never reads FiberEye data. `web/admin/uploads.d` sets the
 * precedent for a backend-local collection reached through
 * `AppMongoConnection.getDb()`.
 *
 * Every method swallows its Mongo failures with a `logWarn`: the caller is
 * the bot's IRC read loop (or a 60 s sweep task), and a Mongo hiccup must
 * never stall reading snotices or take the connection down.
 */
module ircfiber.fibereye.store;

import std.conv : to;
import std.datetime : Clock, days;
import std.process : environment;
import std.typecons : Nullable;
import std.uuid : randomUUID;

import vibe.core.log;
import vibe.data.bson;
import vibe.db.mongo.mongo;

import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.logs.format : GeoInfo;

/// Retention for `fibereye_sessions`, enforced by a TTL index on `tsAt`.
/// Changing this on a live deployment needs a manual
/// `db.fibereye_sessions.dropIndex("tsAt_1")` first — see `ensureIndexes`.
int fiberEyeRetentionDays() @trusted {
    try {
        const raw = environment.get("IRCFIBER_FIBEREYE_RETENTION_DAYS", "");
        if (raw.length) {
            const v = raw.to!int;
            if (v > 0) return v;
        }
    } catch (Exception) {
    }
    return 90;
}

// ─── tolerant Bson field readers ────────────────────────────────────────
// `fibereye_ips` documents are produced by $inc/$max/$setOnInsert, not by
// a toBson(), so a document from an older deploy legitimately lacks
// fields. A missing field must read as its init value, never throw.

private string bstr(Bson b, string key) @trusted {
    try {
        auto v = b.tryIndex(key);
        if (v.isNull || v.get.type != Bson.Type.string) return "";
        return v.get.get!string;
    } catch (Exception) {
        return "";
    }
}

private long blong(Bson b, string key) @trusted {
    try {
        auto v = b.tryIndex(key);
        if (v.isNull) return 0;
        switch (v.get.type) {
            case Bson.Type.long_:   return v.get.get!long;
            case Bson.Type.int_:    return v.get.get!int;
            case Bson.Type.double_: return cast(long) v.get.get!double;
            default:                return 0;
        }
    } catch (Exception) {
        return 0;
    }
}

private bool bbool(Bson b, string key) @trusted {
    try {
        auto v = b.tryIndex(key);
        if (v.isNull || v.get.type != Bson.Type.bool_) return false;
        return v.get.get!bool;
    } catch (Exception) {
        return false;
    }
}

/// One observed client session: a connect, and the quit that closed it.
struct SessionRecord {
    /// UUID string (`_id`).
    string id;
    /// Connect time (unix ms).
    long ts;
    /// Nick at connect time.
    string nick;
    /// Ident as sent by the client.
    string ident;
    /// Cloaked host the network shows.
    string host;
    /// Real IP as the ircd sees it.
    string ip;
    /// GECOS.
    string realname;
    /// ircd connect class the client landed in.
    string connClass;
    /// Server port used.
    long port;
    /// True when `port` is the TLS port.
    bool tls;
    /// `ipGroup(ip)` — the unit FiberEye counts and bans.
    string ipGroup;
    /// 4 or 6.
    int ipVersion;
    /// Services account, filled in from numeric 330 when one arrives.
    string account;
    /// Quit time (unix ms), 0 while the session is open.
    long quitTs;
    /// Quit reason.
    string quitReason;
    /// Session length, 0 while open.
    long durationMs;
    /// Geo, filled in from the #staff bot's cache.
    string geoCity, geoRegion, geoCountry, geoOrg, geoTimezone, geoPrivacy;
    /// True until the geo cache answered for this session's IP.
    bool geoPending;

    /// Serializes to Bson. `tsAt` is the TTL index field and carries the
    /// same instant as `ts`.
    Bson toBson() const @trusted {
        return Bson([
            "_id": Bson(id), "ts": Bson(ts),
            "tsAt": Bson(BsonDate(ts)),
            "nick": Bson(nick), "ident": Bson(ident), "host": Bson(host),
            "ip": Bson(ip), "realname": Bson(realname), "connClass": Bson(connClass),
            "port": Bson(port), "tls": Bson(tls),
            "ipGroup": Bson(ipGroup), "ipVersion": Bson(ipVersion),
            "account": Bson(account),
            "quitTs": Bson(quitTs), "quitReason": Bson(quitReason),
            "durationMs": Bson(durationMs),
            "geoCity": Bson(geoCity), "geoRegion": Bson(geoRegion),
            "geoCountry": Bson(geoCountry), "geoOrg": Bson(geoOrg),
            "geoTimezone": Bson(geoTimezone), "geoPrivacy": Bson(geoPrivacy),
            "geoPending": Bson(geoPending),
        ]);
    }

    /// Deserializes from Bson; missing fields keep their init value.
    static SessionRecord fromBson(Bson b) @trusted {
        SessionRecord r;
        r.id = bstr(b, "_id");
        r.ts = blong(b, "ts");
        r.nick = bstr(b, "nick");
        r.ident = bstr(b, "ident");
        r.host = bstr(b, "host");
        r.ip = bstr(b, "ip");
        r.realname = bstr(b, "realname");
        r.connClass = bstr(b, "connClass");
        r.port = blong(b, "port");
        r.tls = bbool(b, "tls");
        r.ipGroup = bstr(b, "ipGroup");
        r.ipVersion = cast(int) blong(b, "ipVersion");
        r.account = bstr(b, "account");
        r.quitTs = blong(b, "quitTs");
        r.quitReason = bstr(b, "quitReason");
        r.durationMs = blong(b, "durationMs");
        r.geoCity = bstr(b, "geoCity");
        r.geoRegion = bstr(b, "geoRegion");
        r.geoCountry = bstr(b, "geoCountry");
        r.geoOrg = bstr(b, "geoOrg");
        r.geoTimezone = bstr(b, "geoTimezone");
        r.geoPrivacy = bstr(b, "geoPrivacy");
        r.geoPending = bbool(b, "geoPending");
        return r;
    }
}

/// Rollup for one IP group. `_id` is the group itself, so the admin IP
/// table needs no aggregation.
///
/// Deliberately carries no nick array: a nick-rotating bot would grow it
/// without bound. Distinct nicks are computed in the admin read path from
/// the newest sessions instead.
struct IpRecord {
    /// The IP group (`_id`): an exact IPv4 address or an IPv6 `…::/64`.
    string ipGroup;
    /// Most recently seen exact address inside the group.
    string ip;
    /// 4 or 6.
    int ipVersion;
    /// First and last connect seen (unix ms).
    long firstSeen, lastSeen;
    /// Lifetime connect count and count of sessions shorter than `shortMs`.
    long connects, shortSessions;
    /// Most recent nick / account / GECOS / connect class.
    string lastNick, lastAccount, lastRealname, lastClass;
    /// Geo, filled in from the #staff bot's cache.
    string geoCity, geoRegion, geoCountry, geoOrg, geoTimezone, geoPrivacy;
    /// True until the geo cache answered.
    bool geoPending;
    /// Strike count (mirrors the Redis counter, for display).
    long strikes;
    /// Ban expiry (unix ms), 0 when not banned.
    long bannedUntil;
    /// `fibereye_bans._id` of the most recent ban row.
    string lastBanId;

    /// Deserializes from Bson; missing fields keep their init value.
    static IpRecord fromBson(Bson b) @trusted {
        IpRecord r;
        r.ipGroup = bstr(b, "_id");
        r.ip = bstr(b, "ip");
        r.ipVersion = cast(int) blong(b, "ipVersion");
        r.firstSeen = blong(b, "firstSeen");
        r.lastSeen = blong(b, "lastSeen");
        r.connects = blong(b, "connects");
        r.shortSessions = blong(b, "shortSessions");
        r.lastNick = bstr(b, "lastNick");
        r.lastAccount = bstr(b, "lastAccount");
        r.lastRealname = bstr(b, "lastRealname");
        r.lastClass = bstr(b, "lastClass");
        r.geoCity = bstr(b, "geoCity");
        r.geoRegion = bstr(b, "geoRegion");
        r.geoCountry = bstr(b, "geoCountry");
        r.geoOrg = bstr(b, "geoOrg");
        r.geoTimezone = bstr(b, "geoTimezone");
        r.geoPrivacy = bstr(b, "geoPrivacy");
        r.geoPending = bbool(b, "geoPending");
        r.strikes = blong(b, "strikes");
        r.bannedUntil = blong(b, "bannedUntil");
        r.lastBanId = bstr(b, "lastBanId");
        return r;
    }
}

/// What the rule engine saw at the moment it tripped, kept so an operator
/// can judge a ban (or a would-be ban) after the fact.
struct BanEvidence {
    long connects, nicks, shortSessions, windowSeconds;
}

/// One ban FiberEye placed — or, while disarmed, would have placed.
struct BanRecord {
    /// UUID string (`_id`).
    string id;
    /// Z-line mask sent to the ircd (equals `ipGroup` today).
    string mask;
    /// The IP group the verdict was computed for.
    string ipGroup;
    /// X-line type; always `"zline"` for now.
    string type = "zline";
    /// Rule that tripped: `connect_flood` | `nick_churn` | `session_churn`.
    string rule;
    /// Reason text sent to the ircd, including the appeal URL.
    string reason;
    /// Ban duration.
    long durationSeconds;
    /// When FiberEye decided (unix ms).
    long placedAtMs;
    /// When the ircd will expire it (unix ms).
    long expiresAtMs;
    /// Strike number this ban represents.
    long strikes;
    /// Appeal token embedded in `reason`.
    string token;
    /// True when enforcement was disarmed: nothing was sent to the ircd.
    bool observeOnly;
    /// True only once a `STATS Z` sweep actually saw the mask.
    bool placed;
    /// Why placement failed, when it did.
    string placeError;
    /// The counts behind the verdict.
    BanEvidence evidence;
    /// When the ban was lifted (unix ms), 0 while it stands.
    long releasedAtMs;
    /// `""` | `"self-service"` | `"expired-or-removed"` | admin username.
    string releasedBy;

    /// Serializes to Bson.
    Bson toBson() const @trusted {
        return Bson([
            "_id": Bson(id), "mask": Bson(mask), "ipGroup": Bson(ipGroup),
            "type": Bson(type), "rule": Bson(rule), "reason": Bson(reason),
            "durationSeconds": Bson(durationSeconds),
            "placedAtMs": Bson(placedAtMs), "expiresAtMs": Bson(expiresAtMs),
            "strikes": Bson(strikes), "token": Bson(token),
            "observeOnly": Bson(observeOnly), "placed": Bson(placed),
            "placeError": Bson(placeError),
            "evidence": Bson([
                "connects": Bson(evidence.connects),
                "nicks": Bson(evidence.nicks),
                "shortSessions": Bson(evidence.shortSessions),
                "windowSeconds": Bson(evidence.windowSeconds),
            ]),
            "releasedAtMs": Bson(releasedAtMs), "releasedBy": Bson(releasedBy),
        ]);
    }

    /// Deserializes from Bson; missing fields keep their init value.
    static BanRecord fromBson(Bson b) @trusted {
        BanRecord r;
        r.id = bstr(b, "_id");
        r.mask = bstr(b, "mask");
        r.ipGroup = bstr(b, "ipGroup");
        r.type = bstr(b, "type");
        r.rule = bstr(b, "rule");
        r.reason = bstr(b, "reason");
        r.durationSeconds = blong(b, "durationSeconds");
        r.placedAtMs = blong(b, "placedAtMs");
        r.expiresAtMs = blong(b, "expiresAtMs");
        r.strikes = blong(b, "strikes");
        r.token = bstr(b, "token");
        r.observeOnly = bbool(b, "observeOnly");
        r.placed = bbool(b, "placed");
        r.placeError = bstr(b, "placeError");
        r.releasedAtMs = blong(b, "releasedAtMs");
        r.releasedBy = bstr(b, "releasedBy");
        try {
            auto ev = b.tryIndex("evidence");
            if (!ev.isNull && ev.get.type == Bson.Type.object) {
                r.evidence.connects = blong(ev.get, "connects");
                r.evidence.nicks = blong(ev.get, "nicks");
                r.evidence.shortSessions = blong(ev.get, "shortSessions");
                r.evidence.windowSeconds = blong(ev.get, "windowSeconds");
            }
        } catch (Exception) {
        }
        return r;
    }
}

/// Persistence for FiberEye; collections `fibereye_sessions`,
/// `fibereye_ips` and `fibereye_bans`. Instantiated per call site, like
/// every other repository here — no module singleton, no DI.
final class FiberEyeStore {
    private MongoCollection sessions, ips, bans;

    /// Binds the three collections and ensures their indexes.
    this() {
        auto db = AppMongoConnection.getDb();
        sessions = db["fibereye_sessions"];
        ips = db["fibereye_ips"];
        bans = db["fibereye_bans"];
        ensureIndexes();
    }

    private void ensureIndexes() @trusted {
        static void idx(MongoCollection c, Bson keys, string what) {
            try {
                c.createIndex(keys);
            } catch (Exception e) {
                logWarn("FiberEye: failed to create %s index: %s", what, e.msg);
            }
        }
        idx(sessions, Bson(["ts": Bson(-1)]), "sessions ts");
        idx(sessions, Bson(["ip": Bson(1), "ts": Bson(-1)]), "sessions ip");
        idx(sessions, Bson(["ipGroup": Bson(1), "ts": Bson(-1)]), "sessions ipGroup");
        idx(sessions, Bson(["nick": Bson(1), "ts": Bson(-1)]), "sessions nick");
        idx(sessions, Bson(["account": Bson(1), "ts": Bson(-1)]), "sessions account");
        idx(ips, Bson(["lastSeen": Bson(-1)]), "ips lastSeen");
        idx(ips, Bson(["connects": Bson(-1)]), "ips connects");
        idx(ips, Bson(["bannedUntil": Bson(-1)]), "ips bannedUntil");
        idx(ips, Bson(["geoPending": Bson(1), "lastSeen": Bson(-1)]), "ips geoPending");
        idx(bans, Bson(["placedAtMs": Bson(-1)]), "bans placedAtMs");
        idx(bans, Bson(["ipGroup": Bson(1), "placedAtMs": Bson(-1)]), "bans ipGroup");
        idx(bans, Bson(["token": Bson(1)]), "bans token");

        // A connection log must age out on its own; this is the only TTL
        // index in the codebase. Re-running createIndex with a different
        // expireAfterSeconds throws IndexOptionsConflict, which the catch
        // below swallows — so changing IRCFIBER_FIBEREYE_RETENTION_DAYS on
        // a live deployment needs db.fibereye_sessions.dropIndex("tsAt_1")
        // first, otherwise the old retention silently stays in force.
        try {
            IndexOptions o;
            o.expireAfter = fiberEyeRetentionDays().days;
            sessions.createIndex(Bson(["tsAt": Bson(1)]), o);
        } catch (Exception e) {
            logWarn("FiberEye: sessions TTL index unchanged (%s); "
                ~ "drop tsAt_1 manually to change retention", e.msg);
        }
    }

    /// Inserts a session document and returns its id (empty on failure).
    string insertSession(SessionRecord r) @trusted {
        if (!r.id.length) r.id = randomUUID().toString();
        try {
            sessions.insertOne(r.toBson());
            return r.id;
        } catch (Exception e) {
            logWarn("FiberEye: insertSession failed: %s", e.msg);
            return "";
        }
    }

    /// Closes an open session row with its quit time, reason and duration.
    void closeSession(string id, long quitTs, string quitReason, long durationMs) @trusted {
        if (!id.length) return;
        try {
            sessions.updateOne(Bson(["_id": Bson(id)]),
                Bson(["$set": Bson([
                    "quitTs": Bson(quitTs),
                    "quitReason": Bson(quitReason),
                    "durationMs": Bson(durationMs),
                ])]));
        } catch (Exception e) {
            logWarn("FiberEye: closeSession failed: %s", e.msg);
        }
    }

    /// Records the services account a WHOIS (numeric 330) reported.
    void setSessionAccount(string id, string account) @trusted {
        if (!id.length) return;
        try {
            sessions.updateOne(Bson(["_id": Bson(id)]),
                Bson(["$set": Bson(["account": Bson(account)])]));
        } catch (Exception e) {
            logWarn("FiberEye: setSessionAccount failed: %s", e.msg);
        }
    }

    private static Bson geoSet(const GeoInfo g) @trusted {
        return Bson([
            "geoCity": Bson(g.city), "geoRegion": Bson(g.region),
            "geoCountry": Bson(g.country), "geoOrg": Bson(g.org),
            "geoTimezone": Bson(g.timezone), "geoPrivacy": Bson(g.privacyFlags),
            "geoPending": Bson(false),
        ]);
    }

    /// Fills one session's geo fields and clears its pending flag.
    void fillSessionGeo(string id, const GeoInfo g) @trusted {
        if (!id.length) return;
        try {
            sessions.updateOne(Bson(["_id": Bson(id)]), Bson(["$set": geoSet(g)]));
        } catch (Exception e) {
            logWarn("FiberEye: fillSessionGeo failed: %s", e.msg);
        }
    }

    /// Fills every pending session row of one IP group at once — the geo
    /// answer is per IP, so a per-session sweep would re-read the same
    /// cache entry once per connect of a flood.
    void fillGroupGeo(string ipGroup, const GeoInfo g) @trusted {
        if (!ipGroup.length) return;
        try {
            sessions.updateMany(
                Bson(["ipGroup": Bson(ipGroup), "geoPending": Bson(true)]),
                Bson(["$set": geoSet(g)]));
        } catch (Exception e) {
            logWarn("FiberEye: fillGroupGeo failed: %s", e.msg);
        }
    }

    /// Records one connect against the IP-group rollup.
    ///
    /// Deliberately NOT a single `upsert`: vibe-d 0.10.3 maps the reply's
    /// `upserted[].\_id` with `get!BsonObjectID` (collection.d:431), so an
    /// upsert that *creates* a document with our string `_id` throws
    /// `BSON value is type 'string', expected to be one of objectID`
    /// AFTER the write has already committed. That turned every
    /// first-ever sighting of an IP into a spurious warning and made a
    /// genuine write failure indistinguishable from it.
    ///
    /// So: update first, and insert the whole first-sight document when
    /// nothing matched. `onConnect` is the only writer and runs on the
    /// bot's single read-loop fiber, so the two steps cannot interleave;
    /// the duplicate-key retry only guards a future second writer.
    void upsertIp(const SessionRecord r) @trusted {
        if (!r.ipGroup.length) return;
        auto selector = Bson(["_id": Bson(r.ipGroup)]);
        auto update = Bson([
            "$inc": Bson(["connects": Bson(1L)]),
            "$max": Bson(["lastSeen": Bson(r.ts)]),
            "$min": Bson(["firstSeen": Bson(r.ts)]),
            "$set": Bson([
                "ip": Bson(r.ip), "ipVersion": Bson(r.ipVersion),
                "lastNick": Bson(r.nick), "lastRealname": Bson(r.realname),
                "lastClass": Bson(r.connClass),
            ]),
        ]);
        try {
            if (ips.updateOne(selector, update).matchedCount > 0) return;
        } catch (Exception e) {
            logWarn("FiberEye: upsertIp update failed: %s", e.msg);
            return;
        }
        try {
            ips.insertOne(Bson([
                "_id": Bson(r.ipGroup),
                "ip": Bson(r.ip), "ipVersion": Bson(r.ipVersion),
                "firstSeen": Bson(r.ts), "lastSeen": Bson(r.ts),
                "connects": Bson(1L), "shortSessions": Bson(0L),
                "lastNick": Bson(r.nick), "lastAccount": Bson(""),
                "lastRealname": Bson(r.realname), "lastClass": Bson(r.connClass),
                "geoCity": Bson(""), "geoRegion": Bson(""), "geoCountry": Bson(""),
                "geoOrg": Bson(""), "geoTimezone": Bson(""), "geoPrivacy": Bson(""),
                "geoPending": Bson(true),
                "strikes": Bson(0L), "bannedUntil": Bson(0L), "lastBanId": Bson(""),
            ]));
        } catch (Exception e) {
            // Lost a race with another writer: the document exists now, so
            // the connect still has to be counted.
            try {
                if (ips.updateOne(selector, update).matchedCount > 0) return;
            } catch (Exception) {
            }
            logWarn("FiberEye: upsertIp insert failed: %s", e.msg);
        }
    }

    /// Counts one session that ended sooner than `Thresholds.shortMs`.
    void bumpShortSession(string ipGroup) @trusted {
        if (!ipGroup.length) return;
        try {
            ips.updateOne(Bson(["_id": Bson(ipGroup)]),
                Bson(["$inc": Bson(["shortSessions": Bson(1L)])]));
        } catch (Exception e) {
            logWarn("FiberEye: bumpShortSession failed: %s", e.msg);
        }
    }

    /// Records the services account on the IP rollup.
    void setIpAccount(string ipGroup, string account) @trusted {
        if (!ipGroup.length) return;
        try {
            ips.updateOne(Bson(["_id": Bson(ipGroup)]),
                Bson(["$set": Bson(["lastAccount": Bson(account)])]));
        } catch (Exception e) {
            logWarn("FiberEye: setIpAccount failed: %s", e.msg);
        }
    }

    /// Fills an IP rollup's geo fields and clears its pending flag.
    void setIpGeo(string ipGroup, const GeoInfo g) @trusted {
        if (!ipGroup.length) return;
        try {
            ips.updateOne(Bson(["_id": Bson(ipGroup)]), Bson(["$set": geoSet(g)]));
        } catch (Exception e) {
            logWarn("FiberEye: setIpGeo failed: %s", e.msg);
        }
    }

    /// Marks an IP group banned until `bannedUntil` (0 clears the ban).
    void setIpBan(string ipGroup, long bannedUntil, string banId, long strikes) @trusted {
        if (!ipGroup.length) return;
        try {
            ips.updateOne(Bson(["_id": Bson(ipGroup)]), Bson(["$set": Bson([
                "bannedUntil": Bson(bannedUntil),
                "lastBanId": Bson(banId),
                "strikes": Bson(strikes),
            ])]));
        } catch (Exception e) {
            logWarn("FiberEye: setIpBan failed: %s", e.msg);
        }
    }

    /// Inserts a ban document and returns its id (empty on failure).
    string insertBan(BanRecord b) @trusted {
        if (!b.id.length) b.id = randomUUID().toString();
        try {
            bans.insertOne(b.toBson());
            return b.id;
        } catch (Exception e) {
            logWarn("FiberEye: insertBan failed: %s", e.msg);
            return "";
        }
    }

    /// Records whether the ircd actually shows the mask in `STATS Z`.
    void markBanPlaced(string id, bool placed, string placeError) @trusted {
        if (!id.length) return;
        try {
            bans.updateOne(Bson(["_id": Bson(id)]), Bson(["$set": Bson([
                "placed": Bson(placed), "placeError": Bson(placeError),
            ])]));
        } catch (Exception e) {
            logWarn("FiberEye: markBanPlaced failed: %s", e.msg);
        }
    }

    /// Records who lifted a ban and when.
    void markBanReleased(string id, long atMs, string by) @trusted {
        if (!id.length) return;
        try {
            bans.updateOne(Bson(["_id": Bson(id)]), Bson(["$set": Bson([
                "releasedAtMs": Bson(atMs), "releasedBy": Bson(by),
            ])]));
        } catch (Exception e) {
            logWarn("FiberEye: markBanReleased failed: %s", e.msg);
        }
    }

    /// Newest-first page of ban documents.
    ///
    /// `state`: `active` (placed, unreleased, unexpired), `observed`
    /// (disarmed candidates), `released`, anything else = all.
    BanRecord[] pageBans(string state, int offset, int limit, out long total) @trusted {
        const now = Clock.currTime.toUnixTime() * 1000;
        Bson filter = Bson.emptyObject;
        switch (state) {
            case "active":
                filter = Bson([
                    "observeOnly": Bson(false),
                    "releasedAtMs": Bson(0L),
                    "expiresAtMs": Bson(["$gt": Bson(now)]),
                ]);
                break;
            case "observed":
                filter = Bson(["observeOnly": Bson(true)]);
                break;
            case "released":
                filter = Bson(["releasedAtMs": Bson(["$gt": Bson(0L)])]);
                break;
            default:
                break;
        }
        total = 0;
        BanRecord[] rows;
        try {
            total = bans.countDocuments(filter);
            FindOptions opts;
            opts.sort = Bson(["placedAtMs": Bson(-1)]);
            opts.skip = offset;
            opts.limit = limit;
            foreach (doc; bans.find(filter, opts)) rows ~= BanRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: pageBans failed: %s", e.msg);
        }
        return rows;
    }

    /// Ban documents for one IP group, newest first.
    BanRecord[] bansForGroup(string ipGroup, int limit) @trusted {
        BanRecord[] rows;
        if (!ipGroup.length) return rows;
        try {
            FindOptions opts;
            opts.sort = Bson(["placedAtMs": Bson(-1)]);
            opts.limit = limit;
            foreach (doc; bans.find(Bson(["ipGroup": Bson(ipGroup)]), opts))
                rows ~= BanRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: bansForGroup failed: %s", e.msg);
        }
        return rows;
    }

    /// The newest unreleased, unexpired ban row for one group, if any.
    /// Used to stop a continuing flood creating one ban row per connect.
    Nullable!BanRecord activeBanForGroup(string ipGroup, long nowMs) @trusted {
        Nullable!BanRecord result;
        if (!ipGroup.length) return result;
        try {
            FindOptions opts;
            opts.sort = Bson(["placedAtMs": Bson(-1)]);
            opts.limit = 1;
            auto filter = Bson([
                "ipGroup": Bson(ipGroup),
                "releasedAtMs": Bson(0L),
                "expiresAtMs": Bson(["$gt": Bson(nowMs)]),
            ]);
            foreach (doc; bans.find(filter, opts)) {
                result = BanRecord.fromBson(doc);
                break;
            }
        } catch (Exception e) {
            logWarn("FiberEye: activeBanForGroup failed: %s", e.msg);
        }
        return result;
    }

    /// Every ban the ircd should still be enforcing — the reconciliation
    /// input for the `STATS Z` sweep.
    BanRecord[] standingBans(long nowMs) @trusted {
        BanRecord[] rows;
        try {
            auto filter = Bson([
                "observeOnly": Bson(false),
                "releasedAtMs": Bson(0L),
                "expiresAtMs": Bson(["$gt": Bson(nowMs)]),
            ]);
            FindOptions opts;
            opts.sort = Bson(["placedAtMs": Bson(-1)]);
            opts.limit = 500;
            foreach (doc; bans.find(filter, opts)) rows ~= BanRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: standingBans failed: %s", e.msg);
        }
        return rows;
    }

    /// Newest-first page of session documents matching `filter`.
    SessionRecord[] pageSessions(Bson filter, int offset, int limit, out long total) @trusted {
        total = 0;
        SessionRecord[] rows;
        try {
            total = sessions.countDocuments(filter);
            FindOptions opts;
            opts.sort = Bson(["ts": Bson(-1)]);
            opts.skip = offset;
            opts.limit = limit;
            foreach (doc; sessions.find(filter, opts)) rows ~= SessionRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: pageSessions failed: %s", e.msg);
        }
        return rows;
    }

    /// Newest-first sessions of one IP group (used for the detail page and
    /// for the distinct-nick/account rollup the IP document deliberately
    /// does not store).
    SessionRecord[] sessionsForGroup(string ipGroup, int limit) @trusted {
        SessionRecord[] rows;
        if (!ipGroup.length) return rows;
        try {
            FindOptions opts;
            opts.sort = Bson(["ts": Bson(-1)]);
            opts.limit = limit;
            foreach (doc; sessions.find(Bson(["ipGroup": Bson(ipGroup)]), opts))
                rows ~= SessionRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: sessionsForGroup failed: %s", e.msg);
        }
        return rows;
    }

    /// Page of IP rollups matching `filter`, sorted by `sortField` desc.
    IpRecord[] pageIps(Bson filter, string sortField, int offset, int limit, out long total) @trusted {
        total = 0;
        IpRecord[] rows;
        const field = sortField == "connects" ? "connects" : "lastSeen";
        try {
            total = ips.countDocuments(filter);
            FindOptions opts;
            opts.sort = Bson([field: Bson(-1)]);
            opts.skip = offset;
            opts.limit = limit;
            foreach (doc; ips.find(filter, opts)) rows ~= IpRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: pageIps failed: %s", e.msg);
        }
        return rows;
    }

    /// IP groups still waiting for a geo answer, newest activity first.
    IpRecord[] pendingGeoIps(int limit) @trusted {
        IpRecord[] rows;
        try {
            FindOptions opts;
            opts.sort = Bson(["lastSeen": Bson(-1)]);
            opts.limit = limit;
            foreach (doc; ips.find(Bson(["geoPending": Bson(true)]), opts))
                rows ~= IpRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: pendingGeoIps failed: %s", e.msg);
        }
        return rows;
    }

    /// Looks up one ban by its id.
    Nullable!BanRecord findBanById(string id) @trusted {
        Nullable!BanRecord result;
        if (!id.length) return result;
        try {
            auto doc = bans.findOne(Bson(["_id": Bson(id)]));
            if (!doc.isNull) result = BanRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: findBanById failed: %s", e.msg);
        }
        return result;
    }

    /// Looks up one ban by its appeal token.
    Nullable!BanRecord findBanByToken(string token) @trusted {
        Nullable!BanRecord result;
        if (!token.length) return result;
        try {
            auto doc = bans.findOne(Bson(["token": Bson(token)]));
            if (!doc.isNull) result = BanRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: findBanByToken failed: %s", e.msg);
        }
        return result;
    }

    /// Looks up one IP rollup by group.
    Nullable!IpRecord findIp(string ipGroup) @trusted {
        Nullable!IpRecord result;
        if (!ipGroup.length) return result;
        try {
            auto doc = ips.findOne(Bson(["_id": Bson(ipGroup)]));
            if (!doc.isNull) result = IpRecord.fromBson(doc);
        } catch (Exception e) {
            logWarn("FiberEye: findIp failed: %s", e.msg);
        }
        return result;
    }

    /// Session count since `sinceMs`.
    long countSessionsSince(long sinceMs) @trusted {
        try {
            return sessions.countDocuments(Bson(["ts": Bson(["$gte": Bson(sinceMs)])]));
        } catch (Exception e) {
            logWarn("FiberEye: countSessionsSince failed: %s", e.msg);
            return 0;
        }
    }

    /// Count of sessions that ended since `sinceMs`.
    long countQuitsSince(long sinceMs) @trusted {
        try {
            return sessions.countDocuments(Bson(["quitTs": Bson(["$gte": Bson(sinceMs)])]));
        } catch (Exception e) {
            logWarn("FiberEye: countQuitsSince failed: %s", e.msg);
            return 0;
        }
    }

    /// Count of sessions still open (no quit seen).
    long countOpenSessions() @trusted {
        try {
            return sessions.countDocuments(Bson(["quitTs": Bson(0L)]));
        } catch (Exception e) {
            logWarn("FiberEye: countOpenSessions failed: %s", e.msg);
            return 0;
        }
    }

    /// Count of IP groups with activity since `sinceMs`.
    long countIpsSeenSince(long sinceMs) @trusted {
        try {
            return ips.countDocuments(Bson(["lastSeen": Bson(["$gte": Bson(sinceMs)])]));
        } catch (Exception e) {
            logWarn("FiberEye: countIpsSeenSince failed: %s", e.msg);
            return 0;
        }
    }

    /// Count of ban documents matching `filter`.
    long countBans(Bson filter) @trusted {
        try {
            return bans.countDocuments(filter);
        } catch (Exception e) {
            logWarn("FiberEye: countBans failed: %s", e.msg);
            return 0;
        }
    }
}
