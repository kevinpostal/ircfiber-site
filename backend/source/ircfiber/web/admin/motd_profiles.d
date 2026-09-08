/**
 * Per-user MOTD data for the ircd's motdpool module: `motd.d/profiles`,
 * one TAB-separated record per address (geo + FiberEye rollup) plus the
 * reserved `default` record, read by the ircd on every MOTD.
 *
 * A file snapshot rather than a live query: a blocking Redis/Mongo call
 * inside InspIRCd's single-threaded event loop at registration time is
 * what this avoids. Rewritten once at boot and every minute; the write is
 * idempotent and atomic, so several gateway replicas doing it is harmless.
 *
 * Record: `<ip>\t<field>=<value>\t…` with the fields geo_city, geo_region,
 * geo_country, geo_org, geo_tz, connects, first_seen, last_seen (YYYY-MM-DD
 * UTC), last_nick, strikes, banned (yes|no). Keyed by the exact address the
 * ircd sees (`IpRecord.ip`), never the `/64` group id. The last line is
 * the `default` record every unknown visitor resolves to, so all fallback
 * wording lives here, not in the module.
 */
module ircfiber.web.admin.motd_profiles;

import std.array : join, replace;
import std.conv : to;
import std.datetime : Clock, SysTime, UTC;
import std.path : buildPath;

import vibe.core.log : logInfo, logWarn;
import vibe.data.bson : Bson;

import ircfiber.fibereye.store : FiberEyeStore, IpRecord;
import ircfiber.web.admin.ircd : loadIrcdSettings;
import ircfiber.web.admin.motd : writeIrcdFile;

/// Most recently seen addresses written per snapshot (~1 MiB of file; the
/// module reads up to 4 MiB / 20 000 records).
private enum int MOTD_PROFILE_ROWS = 5000;
/// Byte cap per value: keeps any line far below the module's 400-byte
/// rendered-line budget even when a template uses several fields.
private enum size_t MOTD_PROFILE_VALUE_BYTES = 120;

/// Records in the last successful profiles write (0 until one happens).
private __gshared long motdProfiles = 0;

/// Path of the ircd profiles file inside the gateway container (sibling of
/// the pool, same rw-mounted `motd.d/`).
package string motdProfilesPath() {
    return buildPath(loadIrcdSettings().confDir, "motd.d", "profiles");
}

package long motdProfileCount() { return motdProfiles; }

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

/// Record separators and NUL can never reach the file; the module splits
/// on TAB and newline.
private string sanitize(string v) @safe {
    v = v.replace("\t", " ").replace("\r", " ").replace("\n", " ").replace("\0", " ");
    if (v.length > MOTD_PROFILE_VALUE_BYTES) {
        size_t cut = MOTD_PROFILE_VALUE_BYTES;
        while (cut > 0 && (v[cut] & 0xC0) == 0x80) cut--;
        v = v[0 .. cut];
    }
    return v;
}

private string ymd(long unixMs) @safe {
    if (unixMs <= 0) return "";
    auto t = SysTime.fromUnixTime(unixMs / 1000, UTC());
    return t.toISOExtString()[0 .. 10];
}

private string record(string key, string[string] fields) @safe {
    static immutable order = ["geo_city", "geo_region", "geo_country", "geo_org", "geo_tz",
        "connects", "first_seen", "last_seen", "last_nick", "strikes", "banned"];
    string[] parts = [sanitize(key)];
    foreach (k; order) parts ~= k ~ "=" ~ sanitize(fields.get(k, ""));
    return parts.join("\t");
}

/// Writes the snapshot. Returns "" on success or the failure reason.
package string writeMotdProfiles() {
    auto store = new FiberEyeStore();
    long total;
    auto rows = store.pageIps(Bson.emptyObject, "lastSeen", 0, MOTD_PROFILE_ROWS, total);
    const now = nowMs();
    string[] lines;
    foreach (r; rows) {
        if (r.ip.length == 0) continue;
        lines ~= record(r.ip, [
            "geo_city": r.geoCity, "geo_region": r.geoRegion, "geo_country": r.geoCountry,
            "geo_org": r.geoOrg, "geo_tz": r.geoTimezone,
            "connects": r.connects.to!string,
            "first_seen": ymd(r.firstSeen), "last_seen": ymd(r.lastSeen),
            "last_nick": r.lastNick, "strikes": r.strikes.to!string,
            "banned": r.bannedUntil > now ? "yes" : "no",
        ]);
    }
    lines ~= record("default", [
        "geo_city": "somewhere new", "geo_region": "", "geo_country": "parts unknown",
        "geo_org": "", "geo_tz": "", "connects": "1", "first_seen": "today",
        "last_seen": "today", "last_nick": "", "strikes": "0", "banned": "no",
    ]);
    auto err = writeIrcdFile(motdProfilesPath(), lines.join("\n"));
    if (err.length) return err;
    motdProfiles = lines.length;
    return "";
}

/// Boot: one write now so the file exists before the first connect after a
/// deploy, then every minute.
public void startMotdProfiles() {
    import vibe.core.core : setTimer;
    import core.time : seconds;
    try {
        auto err = writeMotdProfiles();
        if (err.length) logWarn("motd: profile snapshot failed: %s", err);
        else logInfo("motd: profiles hold %d record(s)", motdProfiles);
    } catch (Exception e) {
        logWarn("motd: profile snapshot failed: %s", e.msg);
    }
    setTimer(60.seconds, () @trusted nothrow {
        try {
            auto err = writeMotdProfiles();
            if (err.length) logWarn("motd: profile snapshot failed: %s", err);
        } catch (Exception e) {
            logWarn("motd: profile timer failed: %s", e.msg);
        }
    }, true);
}
