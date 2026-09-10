/**
 * The FiberEye rule set as one value: what the admin page edits, what
 * Mongo stores, what Redis mirrors and what the bot puts in force.
 *
 * Separate from `events.d` (which documents itself as importing nothing
 * but `vibe.data.json`) so the dependency runs one way only: `ruleset.d`
 * needs `rules.d` for the thresholds and `format.d` for the exemption
 * predicate, and nothing needs `ruleset.d` back. Imports stay pure so the
 * module links into the `fibereye-test` configuration.
 */
module ircfiber.fibereye.ruleset;

import std.algorithm : canFind;
import std.array : appender;
import std.conv : to;
import std.string : strip, toLower;

import vibe.data.json : Json;

import ircfiber.fibereye.format : validExemptEntry, validExemptNick;
import ircfiber.fibereye.rules : Thresholds, validateThresholds;

/// Longest list the admin API will store, per list.
enum RULE_LIST_MAX = 64;
/// Longest single connect-class name.
enum RULE_CLASS_MAX_LEN = 64;

/// Everything an admin can change about FiberEye's ban rules.
///
/// One rule set applies to the whole network; per-IP or per-class
/// overrides are deliberately not modelled.
struct RuleSet {
    Thresholds thresholds;
    /// Connect classes whose connects are never counted or banned.
    string[] ignoreClasses;
    /// Addresses and CIDRs that are never counted or banned.
    string[] exemptIps;
    /// Nicks whose connects are never counted or banned. Exact nicks or
    /// `*`/`?` globs (`p34c3*`), matched case-insensitively. An exempt
    /// nick still behind a flooding exit does not shield the strangers
    /// around it — only its own connects are skipped.
    string[] exemptNicks;
    /// When this override was stored (unix ms); 0 for the env baseline.
    long updatedAtMs;
    /// Admin username that stored it; "" for the env baseline.
    string updatedBy;

    /// The canonical wire shape — the one used by the Redis mirror, the
    /// Mongo `rules` field, the admin API and the bot heartbeat.
    Json toJson() const @safe {
        auto classes = appender!(Json[]);
        foreach (c; ignoreClasses) classes ~= Json(c);
        auto ips = appender!(Json[]);
        foreach (i; exemptIps) ips ~= Json(i);
        auto nicks = appender!(Json[]);
        foreach (n; exemptNicks) nicks ~= Json(n);
        return Json([
            "windowSeconds":   Json(thresholds.windowSeconds),
            "connects":        Json(thresholds.connects),
            "connectsEnabled": Json(thresholds.connectsEnabled),
            "nicks":           Json(thresholds.nicks),
            "nicksEnabled":    Json(thresholds.nicksEnabled),
            "churn":           Json(thresholds.churn),
            "churnEnabled":    Json(thresholds.churnEnabled),
            "shortMs":         Json(thresholds.shortMs),
            "banSeconds":      Json(thresholds.banSeconds),
            "ignoreClasses":   Json(classes.data),
            "exemptIps":       Json(ips.data),
            "exemptNicks":     Json(nicks.data),
            "updatedAtMs":     Json(updatedAtMs),
            "updatedBy":       Json(updatedBy),
        ]);
    }

    /// Missing or mistyped fields inherit `fallback`, so adding a rule
    /// field in a later release degrades to the deployed baseline for that
    /// field instead of invalidating a whole stored override. Lists are
    /// de-duplicated here, which is what makes the stored document
    /// canonical no matter what the client posted.
    static RuleSet fromJson(Json j, const RuleSet fallback) @safe {
        RuleSet r;
        r.thresholds = fallback.thresholds;
        r.ignoreClasses = fallback.ignoreClasses.dup;
        r.exemptIps = fallback.exemptIps.dup;
        r.exemptNicks = fallback.exemptNicks.dup;
        r.updatedAtMs = fallback.updatedAtMs;
        r.updatedBy = fallback.updatedBy;
        if (j.type != Json.Type.object) return r;
        r.thresholds.windowSeconds = optLong(j, "windowSeconds", fallback.thresholds.windowSeconds);
        r.thresholds.connects = optLong(j, "connects", fallback.thresholds.connects);
        r.thresholds.nicks = optLong(j, "nicks", fallback.thresholds.nicks);
        r.thresholds.churn = optLong(j, "churn", fallback.thresholds.churn);
        r.thresholds.shortMs = optLong(j, "shortMs", fallback.thresholds.shortMs);
        r.thresholds.banSeconds = optLong(j, "banSeconds", fallback.thresholds.banSeconds);
        r.thresholds.connectsEnabled = optBool(j, "connectsEnabled", fallback.thresholds.connectsEnabled);
        r.thresholds.nicksEnabled = optBool(j, "nicksEnabled", fallback.thresholds.nicksEnabled);
        r.ignoreClasses = optList(j, "ignoreClasses", fallback.ignoreClasses, true);
        r.exemptIps = optList(j, "exemptIps", fallback.exemptIps, false);
        r.exemptNicks = optList(j, "exemptNicks", fallback.exemptNicks, true);
        r.updatedAtMs = optLong(j, "updatedAtMs", fallback.updatedAtMs);
        r.updatedBy = optString(j, "updatedBy", fallback.updatedBy);
        return r;
    }
}

private long optLong(Json j, string key, long fallback) @safe {
    auto v = j[key];
    if (v.type == Json.Type.int_) return v.get!long;
    if (v.type == Json.Type.bigInt) return v.to!long;
    if (v.type == Json.Type.float_) return cast(long) v.get!double;
    return fallback;
}

private bool optBool(Json j, string key, bool fallback) @safe {
    auto v = j[key];
    return v.type == Json.Type.bool_ ? v.get!bool : fallback;
}

private string optString(Json j, string key, string fallback) @safe {
    auto v = j[key];
    return v.type == Json.Type.string ? v.get!string : fallback;
}

/// Strings from `j[key]`, stripped and de-duplicated; `fallback` when the
/// field is absent or not an array. An explicitly empty array clears the
/// list — that is a legitimate edit, not a missing field.
private string[] optList(Json j, string key, const string[] fallback, bool foldCase) @safe {
    auto v = j[key];
    if (v.type != Json.Type.array) return fallback.dup;
    auto outp = appender!(string[]);
    string[] seen;
    foreach (e; v.get!(Json[])) {
        if (e.type != Json.Type.string) continue;
        const s = e.get!string.strip();
        if (!s.length) continue;
        const k = foldCase ? s.toLower() : s;
        if (seen.canFind(k)) continue;
        seen ~= k;
        outp ~= s;
    }
    return outp.data;
}

/// `validateThresholds` plus the list checks. Empty result = storable.
string[] validateRuleSet(const RuleSet r) @safe {
    auto errs = validateThresholds(r.thresholds);
    if (r.ignoreClasses.length > RULE_LIST_MAX)
        errs ~= "ignoreClasses has more than 64 entries";
    if (r.exemptIps.length > RULE_LIST_MAX)
        errs ~= "exemptIps has more than 64 entries";
    if (r.exemptNicks.length > RULE_LIST_MAX)
        errs ~= "exemptNicks has more than 64 entries";
    foreach (c; r.ignoreClasses)
        if (!validClassEntry(c)) errs ~= "invalid connect class: " ~ c;
    foreach (i; r.exemptIps)
        if (!validExemptEntry(i))
            errs ~= "invalid exemption (use an address or a CIDR no wider than /16 or /32): " ~ i;
    foreach (n; r.exemptNicks)
        if (!validExemptNick(n))
            errs ~= "invalid nick exemption (use a nick or a glob like p34c3*): " ~ n;
    return errs;
}

/// A connect-class name as InspIRCd spells it: no separators, no control
/// characters, nothing long enough to be a paste accident.
private bool validClassEntry(string c) @safe pure {
    if (!c.length || c.length > RULE_CLASS_MAX_LEN) return false;
    foreach (dchar ch; c) {
        if (ch <= ' ' || ch == 0x7F) return false;
        if (ch == ',') return false;
    }
    return true;
}

/// One line naming what changed, for the audit row and the container log:
///   "connects 10 -> 4; session_churn disabled; exemptIps +1"
/// "" when nothing that matters changed (`updatedAtMs`/`updatedBy` always
/// differ between an override and the baseline, so they are not compared).
string summarizeRuleChange(const RuleSet before, const RuleSet after) @safe {
    string[] parts;
    void num(string name, long a, long b) @safe {
        if (a != b) parts ~= name ~ " " ~ a.to!string ~ " -> " ~ b.to!string;
    }
    num("window", before.thresholds.windowSeconds, after.thresholds.windowSeconds);
    num("connects", before.thresholds.connects, after.thresholds.connects);
    num("nicks", before.thresholds.nicks, after.thresholds.nicks);
    num("churn", before.thresholds.churn, after.thresholds.churn);
    num("shortMs", before.thresholds.shortMs, after.thresholds.shortMs);
    num("banSeconds", before.thresholds.banSeconds, after.thresholds.banSeconds);

    void flag(string rule, bool a, bool b) @safe {
        if (a != b) parts ~= rule ~ (b ? " enabled" : " disabled");
    }
    flag("connect_flood", before.thresholds.connectsEnabled, after.thresholds.connectsEnabled);
    flag("nick_churn", before.thresholds.nicksEnabled, after.thresholds.nicksEnabled);
    flag("session_churn", before.thresholds.churnEnabled, after.thresholds.churnEnabled);

    void list(string name, const string[] a, const string[] b) @safe {
        long added, removed;
        foreach (e; b) if (!a.canFind(e)) added++;
        foreach (e; a) if (!b.canFind(e)) removed++;
        if (!added && !removed) return;
        string s = name;
        if (added) s ~= " +" ~ added.to!string;
        if (removed) s ~= " -" ~ removed.to!string;
        parts ~= s;
    }
    list("ignoreClasses", before.ignoreClasses, after.ignoreClasses);
    list("exemptIps", before.exemptIps, after.exemptIps);
    list("exemptNicks", before.exemptNicks, after.exemptNicks);

    string outp;
    foreach (i, p; parts) outp ~= (i ? "; " : "") ~ p;
    return outp;
}
