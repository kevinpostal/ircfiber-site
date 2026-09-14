/**
 * Pure geo/window logic behind the FiberEye map: resolving a requested
 * time range into absolute bounds, folding observed IP groups into
 * coordinate cells, and rolling them up per country.
 *
 * Imports phobos only — no `vibe.*`, no `Bson`, no `Json`. That is
 * load-bearing: it is what lets this module join the pure `fibereye-test`
 * configuration, whose `sourceFiles` deliberately excludes `store.d`
 * (which needs Mongo). `ipintel/record.d` carries the same constraint.
 */
module ircfiber.fibereye.map;

import std.algorithm : sort;
import std.math : isFinite, round;

/// One IP group observed inside the requested window. `lat`/`lon` are NaN
/// when the intel record has no coordinates (never looked up, or the
/// source returned none) — the map reports those as "unlocated" rather
/// than dropping them silently.
struct MapPoint {
    string ipGroup;     /// `fibereye_ips._id` — the ban/flood unit.
    string ip;          /// Most recent exact address in the group.
    int ipVersion;
    double lat = double.nan, lon = double.nan;
    string city, region, country, org, asn, flags, nick, account, connClass;
    int risk = -1;
    long connects;      /// Connects **inside the window**, not lifetime.
    long lastTs;        /// Newest connect inside the window (unix ms).
    long bannedUntil;   /// 0 when not banned.
    long strikes;
    bool geoPending;
}

/// One rounded-coordinate cell. Labels come from the cell's busiest point.
struct MapCluster {
    double lat, lon;
    string city, region, country, topOrg;
    long groups;        /// Distinct IP groups in the cell.
    long connects;      /// Summed window connects.
    long lastTs;
    long banned;        /// Points with `bannedUntil > nowMs`.
    long flagged;       /// Points with a non-empty `intelFlags` label.
    MapPoint[] samples; /// Busiest first, capped by `maxSamples`.
}

/// One country row for the table under the map.
struct MapCountry {
    string country;     /// ISO-3166-1 alpha-2 (`geoCountry` holds countryCode).
    long groups, connects, banned;
}

/// The window the server actually queried. `label` echoes the resolved token.
struct MapWindow {
    long startMs, endMs;
    string label;
}

enum MAP_RANGE_DEFAULT = "24h";

/// Coordinate cell size: 1 decimal degree ~ 11 km. City-level geo already
/// collapses a metro to one point; this merges adjacent suburbs so a
/// 2000-point payload does not render as 2000 overlapping dots.
enum MAP_CELL_DECIMALS = 1;

/// Bucket for a country a point carries no `geoCountry` for.
enum MAP_COUNTRY_UNKNOWN = "??";

private enum long MS_HOUR = 3_600_000L;
private enum long MS_DAY = 86_400_000L;

/// `10 ^^ MAP_CELL_DECIMALS`, by repeated multiplication so it stays CTFE-able
/// and needs no `std.math.pow`.
private double cellFactor() @safe pure nothrow @nogc {
    double f = 1.0;
    foreach (_; 0 .. MAP_CELL_DECIMALS) f *= 10.0;
    return f;
}

/// Resolves a requested range token into absolute unix-ms bounds.
///
/// Relative tokens are resolved from the caller's `nowMs` — i.e. the
/// server clock — so a skewed browser clock cannot shift the window. Only
/// `custom` trusts client-supplied absolute bounds; an incoherent custom
/// range (or any unrecognised token) falls back to the 24 h window and
/// says so in `label`. The window is never length-capped: the TTL index
/// on `fibereye_sessions` already bounds the collection.
MapWindow resolveMapWindow(string range, long startMs, long endMs, long nowMs) @safe pure nothrow {
    switch (range) {
        case "1h":
            return MapWindow(nowMs - MS_HOUR, nowMs, "1h");
        case "7d":
            return MapWindow(nowMs - 7 * MS_DAY, nowMs, "7d");
        case "30d":
            return MapWindow(nowMs - 30 * MS_DAY, nowMs, "30d");
        case "all":
            return MapWindow(0, nowMs, "all");
        case "custom":
            if (startMs > 0 && endMs > startMs)
                return MapWindow(startMs, endMs, "custom");
            goto default;
        default:
            return MapWindow(nowMs - MS_DAY, nowMs, MAP_RANGE_DEFAULT);
    }
}

/// Folds points into rounded-coordinate cells.
///
/// Points without finite coordinates are skipped (they still count in the
/// country rollup); `located` reports how many were kept, so the caller
/// can publish an honest "unlocated" figure instead of a short list.
///
/// Ordering is a total order at both levels — connects descending, then
/// `ipGroup` / coordinate ascending — so identical data always yields an
/// identical payload for the frontend's keyed `{#each}`.
MapCluster[] clusterMapPoints(const MapPoint[] points, int maxSamples, long nowMs, out long located) @safe pure {
    located = 0;
    if (maxSamples < 1) maxSamples = 1;
    const factor = cellFactor();

    MapPoint[][long[2]] cells;
    foreach (ref p; points) {
        if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
        ++located;
        long[2] key = [
            cast(long) round(p.lat * factor),
            cast(long) round(p.lon * factor),
        ];
        cells[key] ~= p;
    }

    MapCluster[] out_;
    out_.reserve(cells.length);
    foreach (key, cell; cells) {
        auto members = cell;
        members.sort!((a, b) => a.connects != b.connects
            ? a.connects > b.connects
            : a.ipGroup < b.ipGroup);

        MapCluster c;
        c.lat = cast(double) key[0] / factor;
        c.lon = cast(double) key[1] / factor;
        c.city = members[0].city;
        c.region = members[0].region;
        c.country = members[0].country;
        c.topOrg = members[0].org;
        c.groups = members.length;
        foreach (ref m; members) {
            c.connects += m.connects;
            if (m.lastTs > c.lastTs) c.lastTs = m.lastTs;
            if (m.bannedUntil > nowMs) ++c.banned;
            if (m.flags.length) ++c.flagged;
        }
        c.samples = members.length > maxSamples ? members[0 .. maxSamples] : members;
        out_ ~= c;
    }

    out_.sort!((a, b) {
        if (a.connects != b.connects) return a.connects > b.connects;
        if (a.lat != b.lat) return a.lat < b.lat;
        return a.lon < b.lon;
    });
    return out_;
}

/// Rolls the **full** point array — unlocated rows included — up per
/// country. A row can carry `geoCountry` while having no coordinates;
/// dropping it would make the table disagree with the KPI counts.
MapCountry[] rollupCountries(const MapPoint[] points, long nowMs) @safe pure {
    MapCountry[string] byCountry;
    foreach (ref p; points) {
        const key = p.country.length ? p.country : MAP_COUNTRY_UNKNOWN;
        auto row = key in byCountry;
        if (row is null) {
            byCountry[key] = MapCountry(key, 0, 0, 0);
            row = key in byCountry;
        }
        ++row.groups;
        row.connects += p.connects;
        if (p.bannedUntil > nowMs) ++row.banned;
    }

    MapCountry[] out_;
    out_.reserve(byCountry.length);
    foreach (_, row; byCountry) out_ ~= row;
    out_.sort!((a, b) => a.connects != b.connects
        ? a.connects > b.connects
        : a.country < b.country);
    return out_;
}
