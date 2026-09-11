/**
 * Pure nick-reclaim helpers for the gateway IRC bots (`IrcBot` in core.d).
 *
 * Anope guards both bot nicks with NickServ `killprotect` (20 s killquick):
 * any session holding `FIBERSUPPORT`/`FIBEREYE` without identifying is
 * SVSNICKed to `GuestNNNN` (`guestnickprefix = "Guest"` in
 * `site/deploy/roles/ircd/templates/nickserv.conf.j2`). That strikes
 * whenever the ircd restarts and the bot's 001-time IDENTIFY lands while
 * services are still re-linking — exactly the 2026-09-08 08:11 outage that
 * left both bots on Guest nicks with healthy sessions. No I/O here; every
 * function is exercised by `tests/bot_nick_test.d`.
 */
module ircfiber.bots.nick;

/// Minimum gap between `NICK <want>` reclaim attempts (driven by checkIdle).
enum NICK_RECLAIM_EVERY_MS = 30_000;
/// Minimum gap between IDENTIFY sends outside the 001 welcome, so a wrong
/// vault password cannot burn Anope's identification throttle in a loop.
enum IDENTIFY_RESEND_MIN_MS = 60_000;

/// Nick part of an `nick!user@host` prefix, or the whole prefix when bare.
string prefixNick(string prefix) @safe pure {
    import std.string : indexOf;
    const bang = prefix.indexOf('!');
    return bang >= 0 ? prefix[0 .. bang] : prefix;
}

/// True when `nick` is not `want` while the session is registered: the
/// condition under which the bot must try to take its configured nick back.
/// Comparison is case-insensitive — IRC nicks are.
bool nickNeedsReclaim(bool registered, string nick, string want) @safe pure {
    if (!registered || !nick.length || !want.length) return false;
    return lower(nick) != lower(want);
}

/// Classification of a NOTICE whose sender is NickServ.
enum NickServNote {
    none,
    /// "This nickname is registered … please identify", enforce countdowns.
    identifyRequest,
    /// "Password accepted - you are now recognized."
    identifyOk,
    /// "Invalid password …" — resending is pointless; a human must fix
    /// the vault secret.
    identifyBad,
}

/// Classifies a NOTICE by sender + wording. Anything not from NickServ is
/// `none` — ChanServ and server notices must never trigger an IDENTIFY.
NickServNote classifyNickServNotice(string senderPrefix, string text) @safe pure {
    if (lower(prefixNick(senderPrefix)) != "nickserv") return NickServNote.none;
    const t = lower(text);
    if (hasAny(t, ["now identified", "password accepted", "you are now recognized",
            "already identified"]))
        return NickServNote.identifyOk;
    if (hasAny(t, ["invalid password", "identification failed", "wrong password",
            "too many failed", "access denied"]))
        return NickServNote.identifyBad;
    if (hasAny(t, ["is registered", "please identify", "identify yourself",
            "will be changed", "now being changed", "enforce", "if you do not",
            "/msg nickserv identify"]))
        return NickServNote.identifyRequest;
    return NickServNote.none;
}

/// True when a MODE line grants `+r` (Anope `modeonid`) on `me`:
/// params are `[target, modestring, ...]`. Our own `MODE <me> +B` and the
/// snomask `+s` carry no `+r` and are ignored, as is `-r`.
bool modeGrantsRegistered(string me, string[] params) @safe pure {
    if (params.length < 2 || lower(params[0]) != lower(me)) return false;
    bool adding = false;
    foreach (c; params[1]) {
        if (c == '+') adding = true;
        else if (c == '-') adding = false;
        else if (adding && c == 'r') return true;
    }
    return false;
}

private string lower(string s) @safe pure {
    import std.uni : toLower;
    return s.toLower();
}

private bool hasAny(string haystack, string[] needles) @safe pure {
    import std.algorithm : canFind;
    foreach (n; needles) if (haystack.canFind(n)) return true;
    return false;
}
