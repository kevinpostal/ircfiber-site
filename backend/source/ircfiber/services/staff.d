/**
 * The accounts the sync must never mint and the admin page must never offer
 * to drop — one oracle, so the two views cannot disagree. Lives outside
 * `web/admin` so `services-test` links it without the bot modules.
 */
module ircfiber.services.staff;

import std.process : environment;
import std.string : strip;

import ircfiber.bots.nick : FIBEREYE_DEFAULT_NICK, SUPPORT_BOT_DEFAULT_NICK;
import ircfiber.services.anope : anopeOperAccounts, loadAnopeSettings;
import ircfiber.services.anope_db : AnopeInventory, asciiLowerStr;

/**
 * The accounts that must never read as unowned, ASCII-lowercased.
 *
 * Three sources, because no single one covers the staff population:
 *   * `OperServ OPER LIST` over RPC — the authoritative opers, but it reports
 *     the *nick* each `oper {}` block names, so prod's `admin` block has to
 *     be resolved through the inventory to its display `Zodiac` (both rows
 *     are then staff);
 *   * `IRCFIBER_ANOPE_OPER_ACCOUNT` — the account this gateway itself runs
 *     privileged commands as. It is an oper by construction, and adding it
 *     unconditionally means an unreachable Anope cannot make it look
 *     droppable;
 *   * the bots' nicks — `FIBERSUPPORT` and `FiberLogs` are *not* Anope
 *     opers (verified: their `NickServ INFO` has no "is a Services
 *     Operator" line), they are infrastructure this codebase owns and
 *     identifies as, so nothing in Mongo will ever claim them.
 */
bool[string] staffAccountsLower(const ref AnopeInventory inv) {
    auto s = loadAnopeSettings();
    auto staff = anopeOperAccounts(s);
    if (s.operAccount.length) staff[asciiLowerStr(s.operAccount)] = true;
    auto botNick = environment.get("IRCFIBER_SUPPORT_BOT_NICK", "").strip();
    if (!botNick.length) botNick = SUPPORT_BOT_DEFAULT_NICK;
    if (botNick.length) staff[asciiLowerStr(botNick)] = true;
    auto eyeNick = environment.get("IRCFIBER_FIBEREYE_NICK", "").strip();
    if (!eyeNick.length) eyeNick = FIBEREYE_DEFAULT_NICK;
    if (eyeNick.length) staff[asciiLowerStr(eyeNick)] = true;

    // Alias → display. A grouped account is one identity wearing several
    // nicks, so flagging only the nick the oper block happens to name would
    // leave its other rows (prod: `Zodiac`, from the `admin` block) looking
    // ownerless.
    foreach (ref a; inv.accounts) {
        if (!a.account.length) continue;
        const nick = asciiLowerStr(a.nick);
        const display = asciiLowerStr(a.account);
        if (nick in staff || display in staff) {
            staff[nick] = true;
            staff[display] = true;
        }
    }
    return staff;
}
