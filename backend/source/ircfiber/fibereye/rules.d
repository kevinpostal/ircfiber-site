/**
 * FiberEye's rule engine: the thresholds, the verdict, the strike
 * escalation and the ban-reason wording.
 *
 * Pure — no Redis, no clock, no IO. The bot supplies the window counts it
 * read from Redis and applies whatever this module decides, so the whole
 * decision surface is unit-testable (`tests/fibereye_test.d`).
 */
module ircfiber.fibereye.rules;

import std.string : startsWith, strip;

/// Tunables, all env-driven in `ircfiber.fibereye.bot` and echoed on the
/// admin card so what is in force is always visible.
struct Thresholds {
    /// Length of the counting window.
    long windowSeconds  = 60;
    /// Connects per window per IP group.
    long connects       = 10;
    /// Distinct nicks per window per IP group.
    long nicks          = 6;
    /// Sessions shorter than `shortMs`, per window per IP group.
    long churn          = 6;
    /// What counts as a "short" session.
    long shortMs        = 20_000;
    /// First-strike ban duration.
    long banSeconds     = 3_600;
    /// Per-rule switches. Turning a rule off preserves its threshold, so
    /// re-enabling it restores what the admin last chose instead of the
    /// value they had to type to disable it.
    bool connectsEnabled = true;
    bool nicksEnabled    = true;
    bool churnEnabled    = true;
}

/// Bounds every stored rule set is held to. They live here, next to the
/// engine that consumes them, so the admin API and the bot enforce one
/// definition; `web/admin/fibereye.d` also serves them to the UI rather
/// than letting TypeScript keep a second copy.
enum RULE_WINDOW_MIN      = 5,     RULE_WINDOW_MAX      = 3_600;
/// A threshold of 1 bans on the first connect from any non-exempt
/// address, which is indistinguishable from an outage — hence a floor of 2.
enum RULE_COUNT_MIN       = 2,     RULE_COUNT_MAX       = 100_000;
enum RULE_SHORT_MS_MIN    = 1_000, RULE_SHORT_MS_MAX    = 600_000;
enum RULE_BAN_SECONDS_MIN = 60,    RULE_BAN_SECONDS_MAX = 2_592_000;

/// Human-readable reasons `t` is not a usable rule set; empty result means
/// it is storable. A disabled rule's threshold is still range-checked, so
/// re-enabling it can never bring back a nonsense value.
string[] validateThresholds(const Thresholds t) @safe pure {
    string[] errs;
    if (t.windowSeconds < RULE_WINDOW_MIN || t.windowSeconds > RULE_WINDOW_MAX)
        errs ~= "window must be between 5 and 3600 seconds";
    if (t.connects < RULE_COUNT_MIN || t.connects > RULE_COUNT_MAX)
        errs ~= "connect threshold must be between 2 and 100000";
    if (t.nicks < RULE_COUNT_MIN || t.nicks > RULE_COUNT_MAX)
        errs ~= "nick threshold must be between 2 and 100000";
    if (t.churn < RULE_COUNT_MIN || t.churn > RULE_COUNT_MAX)
        errs ~= "short-session threshold must be between 2 and 100000";
    if (t.shortMs < RULE_SHORT_MS_MIN || t.shortMs > RULE_SHORT_MS_MAX)
        errs ~= "short session must be between 1000 and 600000 ms";
    if (t.banSeconds < RULE_BAN_SECONDS_MIN || t.banSeconds > RULE_BAN_SECONDS_MAX)
        errs ~= "first ban must be between 60 and 2592000 seconds";
    return errs;
}

/// The window counts for one IP group at the moment of a connect.
struct Observation {
    long connects, nicks, churn, windowSeconds;
}

/// The engine's answer. `rule` is one of `connect_flood`, `nick_churn`,
/// `session_churn` or `""` when nothing tripped.
struct Verdict {
    bool trip;
    string rule;
}

/// First match wins, in this order, so the recorded rule is deterministic
/// for an observation that exceeds several thresholds at once:
/// connect_flood > nick_churn > session_churn.
Verdict evaluate(const Observation o, const Thresholds t) @safe pure {
    // The `> 0` guards stay: a rule that is on but carries a stored 0 (an
    // override written before the bounds existed) must not fire on every
    // connect.
    if (t.connectsEnabled && t.connects > 0 && o.connects >= t.connects) return Verdict(true, "connect_flood");
    if (t.nicksEnabled && t.nicks > 0 && o.nicks >= t.nicks) return Verdict(true, "nick_churn");
    if (t.churnEnabled && t.churn > 0 && o.churn >= t.churn) return Verdict(true, "session_churn");
    return Verdict(false, "");
}

/// Escalation: 1st strike = base, 2nd = base × 24 (a day at the default
/// hour), 3rd and later = base × 168 (a week). A repeat offender pays
/// more without any operator involvement, and it never grows past a week
/// so a mistake ages out on its own.
long banDurationFor(long strikes, long baseSeconds) @safe pure {
    const base = baseSeconds > 0 ? baseSeconds : 3_600;
    if (strikes <= 1) return base;
    if (strikes == 2) return base * 24;
    return base * 168;
}

/// The literal that marks a Z-line as machine-placed. Both FiberEye's own
/// reasons and the ircd's `<connectban banmessage>` start with it, so one
/// predicate covers both and a human oper's Z-line can never be lifted by
/// the public unban page.
enum FIBEREYE_BAN_MARKER = "FiberEye:";

/// True when `reason` marks an automatically placed ban — the only kind
/// the self-service `/unban` page may remove.
bool isAutoPlacedZline(string reason) @safe pure {
    return reason.strip().startsWith(FIBEREYE_BAN_MARKER);
}

/// The reason text sent to the ircd, which is also what the banned client
/// sees on its next connect attempt — hence the appeal URL.
string banReason(string rule, string appealUrl) @safe pure {
    string what;
    switch (rule) {
        case "connect_flood": what = "connection flood from your address"; break;
        case "nick_churn":    what = "too many nicknames from your address"; break;
        case "session_churn": what = "repeated connect/disconnect from your address"; break;
        default:              what = "banned by staff"; break;
    }
    string r = FIBEREYE_BAN_MARKER ~ " " ~ what ~ ".";
    const url = appealUrl.strip();
    if (url.length) r ~= " Appeal: " ~ url;
    return r;
}
