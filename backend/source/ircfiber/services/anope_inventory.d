/**
 * Live account/channel inventory behind the admin NickServ/ChanServ
 * sections, sourced over JSON-RPC from the merged Anope 2.1 instance.
 *
 * Accounts come from `anope.listAccounts ["full"]` — a map of display name
 * to the `anope.account` object (`display`, `email`|`null`, `registered`,
 * `extensions` bool flags such as `NS_NO_EXPIRE`/`UNCONFIRMED`, `nicks`
 * mapping each grouped alias to its `lastseen`/`registered`, `opertype` or
 * null, `users`) — joined with `anope.listSuspendedAccounts []`, a map of
 * display to `{by, reason, time, expires}`. Suspension lives outside
 * `extensions` (Anope suspends the core, so every grouped alias of a
 * suspended account is flagged, exactly as before). Channels come from
 * `anope.listRegisteredChannels ["full"]`, whose objects carry
 * `founder`/`successor`/`description` (null when unset), `registered`,
 * `lastused`, the `topic` trio (`value`/`setby`/`setat`, null when unset),
 * `bot`, `accesscount`, `users`, `suspended` (null when clear) and the
 * `extensions` bool flags (`CS_NO_EXPIRE`, `PERSIST`, `CS_PRIVATE`, ...).
 * Absent = false, as `rpc_data` emits every serializable flag.
 *
 * The data is live: `asOf` is the query time. There is no five-minute
 * staleness window — the old flatfile reader is gone with the volume mount
 * the gateway used to need.
 *
 * The read functions take `AnopeSettings` and never throw: a transport
 * failure (or a refusal, e.g. a wrong token) lands in `reason` with
 * `available == false`, exactly like the file reader reported a missing
 * mount, so `nickserv_sync.d` (which silently skips when unavailable) and
 * the admin endpoints keep their degrade behaviour.
 */
module ircfiber.services.anope_inventory;

import std.datetime : Clock;
import std.string : indexOf, strip;

import vibe.data.json : Json;

import ircfiber.services.anope : AnopeSettings, anopeRpc;

/**
 * One row of the account inventory: one grouped alias joined to its owning
 * account and to that account's suspension, if any.
 */
struct AnopeAccount {
    string nick;              /// the alias nick
    string account;           /// the owning account display
    string email;             /// account email; "" when unset (null)
    long registeredAt;        /// alias `registered`, unix seconds, 0 when absent
    long lastSeenAt;          /// alias `lastseen`, unix seconds, 0 when absent
    string lastUsermask;      /// no RPC equivalent; always ""
    string lastRealName;      /// no RPC equivalent; always ""
    bool suspended;           /// the owning account is suspended (every grouped alias is flagged)
    string suspendedBy;       /// suspension "by"
    string suspendReason;     /// "reason"
    long suspendedAt;         /// "time"
    long suspendExpiresAt;    /// "expires", 0 = never
}

/// ASCII lowercase. IRC nicks and Anope account displays are ASCII, and the
/// joins below must not depend on the locale-independent-but-slower Unicode
/// tables.
private char asciiLower(char c) @safe pure nothrow @nogc {
    return (c >= 'A' && c <= 'Z') ? cast(char)(c + ('a' - 'A')) : c;
}

/// ASCII lowercase. Public because the admin NickServ page joins the same
/// values (nicks, account displays, email addresses) and must fold them
/// identically; an email comparison in particular must not depend on Unicode
/// case folding (`İ` lowercases to two code points).
string asciiLowerStr(string s) @safe pure {
    bool needs = false;
    foreach (char c; s)
        if (c >= 'A' && c <= 'Z') { needs = true; break; }
    if (!needs) return s;
    char[] out_;
    out_.length = s.length;
    foreach (i, char c; s) out_[i] = asciiLower(c);
    return out_.idup;
}


/**
 * Who owns one NickServ account: `"staff"`, `"linked"`, `"email"` or
 * `"unowned"`. `ownerUsername` is set only for `"email"` — a `"linked"` row
 * already carries its owner from the platform join, and the caller keeps
 * that value.
 *
 * Pure, and every input is resolved once per request, because the interesting
 * part is the precedence and it has to be reviewable without a services
 * connection: staff > linked > email > unowned. Staff first is the
 * load-bearing rule — `sq` and `Zodiac` are both staff opers *and* website
 * users, and a staff account must never be presented as unowned.
 */
string classifyAccountOwnership(string account, string accountEmail, bool linked,
                                const bool[string] staffLower,
                                const string[string] emailToUsernameLower,
                                out string ownerUsername) @safe pure {
    ownerUsername = "";
    const name = asciiLowerStr(account.strip());
    if (name.length && name in staffLower) return "staff";
    if (linked) return "linked";
    const email = asciiLowerStr(accountEmail.strip());
    // An empty email is "unset", not an identity: Anope leaves `email` blank
    // for `Bunghole` and `redlegion` on prod, and Mongo has users with no
    // address either. Matching those to each other would invent an owner.
    if (email.length)
        if (auto u = email in emailToUsernameLower) {
            ownerUsername = *u;
            return "email";
        }
    return "unowned";
}

@("classifyAccountOwnership puts staff ahead of every other owner")
unittest {
    string owner;
    // sq on prod: an oper block, a saslUsername link and a website email.
    assert(classifyAccountOwnership("sq", "paigeadele@gmail.com", true,
        ["sq": true], ["paigeadele@gmail.com": "sq"], owner) == "staff");
    assert(owner == "");
}

@("a linked account is never reclassified by its email")
unittest {
    string owner;
    assert(classifyAccountOwnership("quark", "casters@icloud.com", true,
        null, ["casters@icloud.com": "someone-else"], owner) == "linked");
    // The platform join owns this value for a linked row.
    assert(owner == "");
}

@("the email fallback matches case-insensitively and names the owner")
unittest {
    string owner;
    assert(classifyAccountOwnership("kfnFiber", "Sorter.Bristle_1C@iCloud.COM", false,
        ["zodiac": true], ["sorter.bristle_1c@icloud.com": "kfn"], owner) == "email");
    assert(owner == "kfn");
}

@("an account with no email does not match a user with no email")
unittest {
    string owner;
    assert(classifyAccountOwnership("Bunghole", "   ", false,
        null, ["": "nobody", "someone@example.com": "someone"], owner) == "unowned");
    assert(owner == "");
}

@("an account nothing can be tied to is unowned")
unittest {
    string owner;
    assert(classifyAccountOwnership("dnsk", "shusky.canine@protonmail.com", false,
        ["zodiac": true, "sq": true], ["other@example.com": "other"], owner) == "unowned");
    assert(owner == "");
}


/// ASCII case-insensitive ordering, for the inventory sort.
private int asciiICmp(string a, string b) @safe pure nothrow @nogc {
    const n = a.length < b.length ? a.length : b.length;
    foreach (i; 0 .. n) {
        const ca = asciiLower(a[i]);
        const cb = asciiLower(b[i]);
        if (ca != cb) return ca < cb ? -1 : 1;
    }
    if (a.length == b.length) return 0;
    return a.length < b.length ? -1 : 1;
}

/// A JSON string value, or "" when absent, null, or mistyped.
private string jsonStr(Json v) @safe {
    return v.type == Json.Type.string ? v.get!string : "";
}

/// A JSON integer value, or 0 when absent, null, or mistyped.
private long jsonLong(Json v) @safe {
    return v.type == Json.Type.int_ ? v.get!long : 0;
}

/// One serializable bool flag of an `extensions` object; absent = false.
private bool jsonFlag(Json v, string key) @safe {
    if (v.type != Json.Type.object) return false;
    auto f = v[key];
    return f.type == Json.Type.bool_ && f.get!bool;
}

/**
 * Assemble the account inventory: every alias in each account's `nicks` map
 * joined to its display for the email, plus the display's suspension entry
 * when `anope.listSuspendedAccounts` names it. Both joins are ASCII
 * case-insensitive because IRC nicks are. Sorted by nick, case-insensitively.
 *
 * An account with no aliases is kept as its display, so it stays visible
 * rather than dropping out of the table.
 */
AnopeAccount[] buildAccountInventory(Json accounts, Json suspended) @trusted {
    import std.algorithm.sorting : sort;

    AnopeAccount[] rows;
    if (accounts.type != Json.Type.object) return rows;

    static struct Susp {
        string by;
        string reason;
        long at;
        long expires;
    }
    Susp[string] sus;                       // lower(display) → suspension
    if (suspended.type == Json.Type.object)
        foreach (string display, Json s; suspended) {
            if (s.type != Json.Type.object) continue;
            Susp e;
            e.by = jsonStr(s["by"]);
            e.reason = jsonStr(s["reason"]);
            e.at = jsonLong(s["time"]);
            e.expires = jsonLong(s["expires"]);
            sus[asciiLowerStr(display)] = e;
        }

    foreach (string display, Json acct; accounts) {
        if (acct.type != Json.Type.object) continue;
        const account = jsonStr(acct["display"]);
        const name = account.length ? account : display;
        if (!name.length) continue;
        const email = jsonStr(acct["email"]);
        auto s = asciiLowerStr(name) in sus;

        auto nicks = acct["nicks"];
        bool any = false;
        if (nicks.type == Json.Type.object)
            foreach (string nick, Json na; nicks) {
                if (!nick.length || na.type != Json.Type.object) continue;
                any = true;
                AnopeAccount a;
                a.nick = nick;
                a.account = name;
                a.email = email;
                a.registeredAt = jsonLong(na["registered"]);
                a.lastSeenAt = jsonLong(na["lastseen"]);
                if (s !is null) {
                    a.suspended = true;
                    a.suspendedBy = s.by;
                    a.suspendReason = s.reason;
                    a.suspendedAt = s.at;
                    a.suspendExpiresAt = s.expires;
                }
                rows ~= a;
            }
        if (!any) {
            AnopeAccount a;
            a.nick = name;
            a.account = name;
            a.email = email;
            if (s !is null) {
                a.suspended = true;
                a.suspendedBy = s.by;
                a.suspendReason = s.reason;
                a.suspendedAt = s.at;
                a.suspendExpiresAt = s.expires;
            }
            rows ~= a;
        }
    }

    sort!((a, b) => asciiICmp(a.nick, b.nick) < 0)(rows);
    return rows;
}

/// Outcome of one inventory read. `available == false` is a normal, expected
/// state (services unreachable, token wrong) that the admin UI explains via
/// `reason` instead of failing.
struct AnopeInventory {
    bool available;
    string reason;             /// why it is unavailable, for the admin UI
    long asOf;                 /// unix seconds of the query, so the UI can show "as of"
    AnopeAccount[] accounts;
}

/// Read the account inventory over RPC. Never throws: every failure lands in
/// `reason`.
AnopeInventory readAnopeInventory(AnopeSettings s) {
    AnopeInventory inv;
    inv.asOf = Clock.currTime.toUnixTime!long;
    try {
        auto accounts = anopeRpc(s, "anope.listAccounts", ["full"], "listAccounts full", true);
        if (!accounts.transportOk) {
            inv.reason = accounts.transportError;
            return inv;
        }
        if (accounts.errorCode != 0) {
            inv.reason = accounts.error;
            return inv;
        }
        auto suspended = anopeRpc(s, "anope.listSuspendedAccounts", [], "listSuspendedAccounts", true);
        if (!suspended.transportOk) {
            inv.reason = suspended.transportError;
            return inv;
        }
        if (suspended.errorCode != 0) {
            inv.reason = suspended.error;
            return inv;
        }
        inv.accounts = buildAccountInventory(accounts.result, suspended.result);
        inv.available = true;
    } catch (Exception e) {
        inv.available = false;
        inv.accounts = null;
        inv.reason = e.msg;
    }
    return inv;
}

// ---------------------------------------------------------------------------
// Channel inventory (admin ChanServ section)
// ---------------------------------------------------------------------------

/**
 * One registered channel, as `anope.listRegisteredChannels ["full"]`
 * reports it, joined to its suspension (non-null `suspended`) when present.
 */
struct AnopeChannel {
    string name;
    string founder;            /// a NickCore display; "" when null (the core was dropped)
    string successor;          /// "" when null
    string description;        /// "" when null
    long registeredAt;         /// "registered", unix seconds, 0 when absent
    long lastUsedAt;           /// "lastused"
    string lastTopic;          /// topic "value"; "" when the topic is null
    string lastTopicSetter;    /// topic "setby"
    long lastTopicAt;          /// topic "setat"
    string bot;                /// assigned BotServ bot, "" when null
    long accessCount;          /// "accesscount"
    bool noExpire;             /// extensions "CS_NO_EXPIRE"
    bool isPrivate;            /// extensions "CS_PRIVATE"
    bool persistent;           /// extensions "PERSIST"
    bool suspended;            /// "suspended" is non-null
    string suspendedBy;        /// suspension "by"
    string suspendReason;      /// "reason"
    long suspendedAt;          /// "time"
    long suspendExpiresAt;     /// "expires", 0 = never
}

/**
 * Assemble the channel inventory. Sorted by name, case-insensitively.
 *
 * A channel whose founder core is gone keeps an empty `founder` rather than
 * dropping out: the admin needs to see that the registration exists.
 */
AnopeChannel[] buildChannelInventory(Json channels) @trusted {
    import std.algorithm.sorting : sort;

    AnopeChannel[] rows;
    if (channels.type != Json.Type.object) return rows;

    foreach (string name, Json ch; channels) {
        if (ch.type != Json.Type.object) continue;
        const title = jsonStr(ch["name"]);
        if (!title.length && !name.length) continue;

        AnopeChannel c;
        c.name = title.length ? title : name;
        c.founder = jsonStr(ch["founder"]);
        c.successor = jsonStr(ch["successor"]);
        c.description = jsonStr(ch["description"]);
        c.registeredAt = jsonLong(ch["registered"]);
        c.lastUsedAt = jsonLong(ch["lastused"]);
        auto topic = ch["topic"];
        if (topic.type == Json.Type.object) {
            c.lastTopic = jsonStr(topic["value"]);
            c.lastTopicSetter = jsonStr(topic["setby"]);
            c.lastTopicAt = jsonLong(topic["setat"]);
        }
        c.bot = jsonStr(ch["bot"]);
        c.accessCount = jsonLong(ch["accesscount"]);
        auto ext = ch["extensions"];
        c.noExpire = jsonFlag(ext, "CS_NO_EXPIRE");
        c.isPrivate = jsonFlag(ext, "CS_PRIVATE");
        c.persistent = jsonFlag(ext, "PERSIST");
        auto sus = ch["suspended"];
        if (sus.type == Json.Type.object) {
            c.suspended = true;
            c.suspendedBy = jsonStr(sus["by"]);
            c.suspendReason = jsonStr(sus["reason"]);
            c.suspendedAt = jsonLong(sus["time"]);
            c.suspendExpiresAt = jsonLong(sus["expires"]);
        }
        rows ~= c;
    }

    sort!((a, b) => asciiICmp(a.name, b.name) < 0)(rows);
    return rows;
}

/// Outcome of one channel-inventory read; `available == false` is an expected
/// state the admin UI explains via `reason` instead of failing.
struct AnopeChannelInventory {
    bool available;
    string reason;
    long asOf;                 /// unix seconds of the query, so the UI can show "as of"
    AnopeChannel[] channels;
}

/// Read the channel inventory over RPC. Never throws.
AnopeChannelInventory readAnopeChannelInventory(AnopeSettings s) {
    AnopeChannelInventory inv;
    inv.asOf = Clock.currTime.toUnixTime!long;
    try {
        auto channels = anopeRpc(s, "anope.listRegisteredChannels", ["full"],
                                 "listRegisteredChannels full", true);
        if (!channels.transportOk) {
            inv.reason = channels.transportError;
            return inv;
        }
        if (channels.errorCode != 0) {
            inv.reason = channels.error;
            return inv;
        }
        inv.channels = buildChannelInventory(channels.result);
        inv.available = true;
    } catch (Exception e) {
        inv.available = false;
        inv.channels = null;
        inv.reason = e.msg;
    }
    return inv;
}
