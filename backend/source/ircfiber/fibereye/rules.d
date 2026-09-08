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
    if (t.connects > 0 && o.connects >= t.connects) return Verdict(true, "connect_flood");
    if (t.nicks > 0 && o.nicks >= t.nicks) return Verdict(true, "nick_churn");
    if (t.churn > 0 && o.churn >= t.churn) return Verdict(true, "session_churn");
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
