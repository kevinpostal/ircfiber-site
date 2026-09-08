/**
 * Mongo persistence for IP-intelligence records: collection
 * `ipintel_records`, one document per exact address.
 *
 *   _id: <ip>, record: <IpIntel JSON>, firstSeen/lastSeen: ms,
 *   lastSeenAt: BsonDate(lastSeen) (TTL index), sessionCount, updatedAt
 *
 * `record.provenance` is stored as an array (`[{field, src, at, ttl,
 * confidence, votes}]`) rather than the JSON object keyed by
 * `"group.field"` — Mongo cannot address dotted field names.
 *
 * Same shape as `ircfiber.fibereye.store`: instantiated per call site,
 * every method swallows its Mongo failure with a `logWarn`, and a string
 * `_id` is never upserted (update, then insert on no match).
 */
module ircfiber.ipintel.store;

import std.datetime : days;

import vibe.core.log;
import vibe.data.bson;
import vibe.data.json : Json;
import vibe.db.mongo.mongo;

import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.fibereye.store : fiberEyeRetentionDays;
import ircfiber.ipintel.record : IpIntel;

/// `provenance{}` → `[{field,…}]` for Mongo.
Json toMongoJson(const IpIntel r) @safe {
    auto j = r.toJson();
    auto prov = j["provenance"];
    auto arr = Json.emptyArray;
    if (prov.type == Json.Type.object) {
        foreach (key; r.provenance.byKey) {
            auto m = prov[key];
            m["field"] = Json(key);
            arr ~= m;
        }
    }
    j["provenance"] = arr;
    return j;
}

/// Inverse of `toMongoJson`.
IpIntel fromMongoJson(Json j) @trusted {
    if (j.type == Json.Type.object && j["provenance"].type == Json.Type.array) {
        auto obj = Json.emptyObject;
        foreach (m; j["provenance"]) {
            if (m.type != Json.Type.object) continue;
            auto f = m["field"];
            if (f.type != Json.Type.string) continue;
            obj[f.get!string] = m;
        }
        j["provenance"] = obj;
    }
    return IpIntel.fromJson(j);
}

/// Repository over `ipintel_records`.
final class IpIntelStore {
    private MongoCollection records;

    /// Binds the collection and ensures its indexes.
    this() {
        records = AppMongoConnection.getDb()["ipintel_records"];
        ensureIndexes();
    }

    private void ensureIndexes() @trusted {
        static void idx(MongoCollection c, Bson keys, string what) {
            try c.createIndex(keys);
            catch (Exception e) logWarn("ipintel: failed to create %s index: %s", what, e.msg);
        }
        idx(records, Bson(["lastSeen": Bson(-1)]), "lastSeen");
        idx(records, Bson(["record.network.asn": Bson(1)]), "asn");
        idx(records, Bson(["record.identity.group": Bson(1)]), "group");
        // Same retention as FiberEye's sessions; same caveat — changing it
        // needs db.ipintel_records.dropIndex("lastSeenAt_1") first.
        try {
            IndexOptions o;
            o.expireAfter = fiberEyeRetentionDays().days;
            records.createIndex(Bson(["lastSeenAt": Bson(1)]), o);
        } catch (Exception e) {
            logWarn("ipintel: TTL index unchanged (%s); drop lastSeenAt_1 manually to change retention", e.msg);
        }
    }

    /// Counts a sighting: `$inc sessionCount, $min firstSeen, $max lastSeen`.
    /// Returns true when the document was created — the first sighting.
    bool touch(string ip, long tsMs) @trusted {
        if (!ip.length) return false;
        auto selector = Bson(["_id": Bson(ip)]);
        auto update = Bson([
            "$inc": Bson(["sessionCount": Bson(1L)]),
            "$min": Bson(["firstSeen": Bson(tsMs)]),
            "$max": Bson(["lastSeen": Bson(tsMs)]),
            "$set": Bson(["lastSeenAt": Bson(BsonDate(tsMs)), "updatedAt": Bson(tsMs)]),
        ]);
        try {
            if (records.updateOne(selector, update).matchedCount > 0) return false;
        } catch (Exception e) {
            logWarn("ipintel: touch update failed for %s: %s", ip, e.msg);
            return false;
        }
        try {
            records.insertOne(Bson([
                "_id": Bson(ip), "record": Bson(null),
                "firstSeen": Bson(tsMs), "lastSeen": Bson(tsMs),
                "lastSeenAt": Bson(BsonDate(tsMs)), "sessionCount": Bson(1L),
                "updatedAt": Bson(tsMs),
            ]));
            return true;
        } catch (Exception e) {
            // Lost a race with another writer: count it on the existing row.
            try {
                if (records.updateOne(selector, update).matchedCount > 0) return false;
            } catch (Exception) {
            }
            logWarn("ipintel: touch insert failed for %s: %s", ip, e.msg);
            return false;
        }
    }

    /// Stores the assembled record (creating the row when it has never been sighted).
    void save(string ip, const IpIntel r) @trusted {
        if (!ip.length) return;
        auto selector = Bson(["_id": Bson(ip)]);
        Bson rec;
        try rec = Bson.fromJson(toMongoJson(r));
        catch (Exception e) {
            logWarn("ipintel: record for %s is not BSON-safe: %s", ip, e.msg);
            return;
        }
        const now = r.assembledAt;
        auto update = Bson(["$set": Bson(["record": rec, "updatedAt": Bson(now)])]);
        try {
            if (records.updateOne(selector, update).matchedCount > 0) return;
        } catch (Exception e) {
            logWarn("ipintel: save update failed for %s: %s", ip, e.msg);
            return;
        }
        try {
            records.insertOne(Bson([
                "_id": Bson(ip), "record": rec,
                "firstSeen": Bson(0L), "lastSeen": Bson(0L),
                "lastSeenAt": Bson(BsonDate(now)), "sessionCount": Bson(0L),
                "updatedAt": Bson(now),
            ]));
        } catch (Exception e) {
            try {
                if (records.updateOne(selector, update).matchedCount > 0) return;
            } catch (Exception) {
            }
            logWarn("ipintel: save insert failed for %s: %s", ip, e.msg);
        }
    }

    /// The stored record with our sighting counters folded into
    /// `reputation.firstSeen/lastSeen/sessionCount`. `found` is false when
    /// the address has no row at all; a row without a record yields a bare
    /// `IpIntel` carrying only the counters.
    IpIntel get(string ip, out bool found) @trusted {
        found = false;
        IpIntel r;
        if (!ip.length) return r;
        try {
            auto doc = records.findOne(Bson(["_id": Bson(ip)]));
            if (doc.isNull) return r;
            found = true;
            auto rec = doc.tryIndex("record");
            if (!rec.isNull && rec.get.type == Bson.Type.object) r = fromMongoJson(rec.get.toJson());
            if (!r.identity.ip.length) r.identity.ip = ip;
            r.reputation.firstSeen = blong(doc, "firstSeen");
            r.reputation.lastSeen = blong(doc, "lastSeen");
            r.reputation.sessionCount = blong(doc, "sessionCount");
        } catch (Exception e) {
            logWarn("ipintel: get failed for %s: %s", ip, e.msg);
        }
        return r;
    }

    /// Number of stored addresses.
    long count() @trusted {
        try return records.countDocuments(Bson.emptyObject);
        catch (Exception e) {
            logWarn("ipintel: count failed: %s", e.msg);
            return 0;
        }
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
