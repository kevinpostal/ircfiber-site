/**
 * Reader for Anope's `db_flatfile` database — the account inventory behind the
 * admin NickServ section.
 *
 * Why a file parser instead of RPC: Anope 2.0's `m_xmlrpc_main` exposes only
 * `command`, `checkAuthentication`, `stats`, `channel`, `user`, `opers` and
 * `notice` — no account enumeration — and `NickServ LIST` is capped by
 * `nickserv.conf`'s `listmax` (50 on our deployment), so it is a search, never
 * an inventory. Our services persist with `db_flatfile`
 * (`services.conf.j2`: `module { name = "db_flatfile"; database = "anope.db" }`),
 * so the full account list is simply on disk.
 *
 * On-disk shape (`modules/database/db_flatfile.cpp`), one object per record:
 *
 *     OBJECT NickAlias
 *     ID 12
 *     DATA nick alice
 *     DATA nc alice
 *     END
 *
 * `SaveData::operator[]` only re-emits the `DATA <key> ` prefix when the key
 * changes, so a value containing newlines continues onto the following physical
 * lines until the next line beginning `DATA `, `ID `, `OBJECT ` or `END`. This
 * parser reproduces that exactly.
 *
 * Freshness: Anope flushes the file every `options { updatetimeout }` (5m) and
 * on shutdown, so an inventory read is up to five minutes stale. The admin
 * page's per-account view goes through `NickServ INFO` over RPC and is
 * therefore live; only the table is time-shifted, and it says so.
 *
 * `NickCore`'s `pass` member is a password hash and is never read here.
 *
 * Env:
 *   IRCFIBER_ANOPE_DB_PATH  path to anope.db ("" → inventory disabled)
 */
module ircfiber.services.anope_db;

import std.string : indexOf, splitLines, startsWith, strip;

/// One record of the flatfile stream: its `OBJECT` type plus every `DATA` pair.
struct AnopeDbRecord {
    string type;              /// the word after `OBJECT`
    string[string] data;      /// `DATA <key> <value>` pairs, last one wins
}

/**
 * Split a `db_flatfile` stream into records.
 *
 * A line that matches none of the four keywords is a continuation of the
 * previous `DATA` value (see the module comment) and is appended with the
 * newline that produced the split. A record with no `END` — a file Anope was
 * killed halfway through writing — is still returned rather than dropped.
 */
AnopeDbRecord[] parseAnopeDb(string contents) @safe pure {
    AnopeDbRecord[] records;
    AnopeDbRecord cur;
    bool inObject = false;
    string curKey;

    void flush() {
        if (inObject && cur.type.length) records ~= cur;
        cur = AnopeDbRecord.init;
        inObject = false;
        curKey = null;
    }

    foreach (line; contents.splitLines()) {
        if (line.startsWith("OBJECT ")) {
            flush();
            cur.type = line["OBJECT ".length .. $].strip();
            inObject = true;
            continue;
        }
        if (line.strip() == "END") {
            flush();
            continue;
        }
        if (!inObject) continue;   // preamble/garbage outside any object
        if (line.startsWith("ID ")) {
            curKey = null;         // terminates any continued value
            continue;
        }
        if (line.startsWith("DATA ")) {
            const rest = line["DATA ".length .. $];
            const sp = rest.indexOf(' ');
            if (sp < 0) {
                curKey = rest;
                cur.data[curKey] = "";
            } else {
                curKey = rest[0 .. sp];
                cur.data[curKey] = rest[sp + 1 .. $];
            }
            continue;
        }
        if (curKey.length) cur.data[curKey] = cur.data[curKey] ~ "\n" ~ line;
    }
    flush();
    return records;
}

/**
 * One row of the account inventory: an `OBJECT NickAlias` joined to its owning
 * `OBJECT NickCore` and to any `OBJECT NSSuspendInfo` naming it.
 */
struct AnopeAccount {
    string nick;              /// NickAlias "nick"
    string account;           /// NickAlias "nc" — the owning NickCore display
    string email;             /// NickCore "email"; "" when unset
    long registeredAt;        /// NickAlias "time_registered", unix seconds, 0 when absent
    long lastSeenAt;          /// NickAlias "last_seen", unix seconds, 0 when absent
    string lastUsermask;      /// NickAlias "last_usermask"
    string lastRealName;      /// NickAlias "last_realname"
    bool suspended;           /// an NSSuspendInfo names this nick
    string suspendedBy;       /// NSSuspendInfo "by"
    string suspendReason;     /// NSSuspendInfo "reason"
    long suspendedAt;         /// NSSuspendInfo "time"
    long suspendExpiresAt;    /// NSSuspendInfo "expires", 0 = never
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

/// Anope stores whatever bytes the ircd delivered — a realname or quit message
/// need not be UTF-8 — and vibe.d's Json serializer throws on invalid UTF-8, so
/// every value that leaves this module is sanitized. Valid input is returned
/// unchanged (same slice, no allocation).
private string sanitizeUtf8(string s) @safe pure {
    import std.utf : decode, UTFException;

    size_t i = 0;
    while (i < s.length) {
        const before = i;
        try {
            decode(s, i);
        } catch (UTFException) {
            break;
        }
        if (i <= before) break;
    }
    if (i >= s.length) return s;

    string res;
    i = 0;
    while (i < s.length) {
        size_t j = i;
        bool ok = true;
        try {
            decode(s, j);
        } catch (UTFException) {
            ok = false;
        }
        if (!ok || j <= i) {
            res ~= '?';
            i++;
            continue;
        }
        res ~= s[i .. j];
        i = j;
    }
    return res;
}

/// Unix timestamp from a serialized integer; 0 for absent or non-numeric.
private long parseUnixTime(string raw) @safe pure {
    const t = raw.strip();
    if (!t.length) return 0;
    size_t i = 0;
    bool neg = false;
    if (t[0] == '-' || t[0] == '+') {
        neg = t[0] == '-';
        i = 1;
    }
    if (i >= t.length) return 0;
    long v = 0;
    foreach (char c; t[i .. $]) {
        if (c < '0' || c > '9') return 0;
        if (v > (long.max - 9) / 10) return 0;   // absurd value → treat as absent
        v = v * 10 + (c - '0');
    }
    return neg ? -v : v;
}

private string field(const AnopeDbRecord r, string key) @safe pure {
    if (auto p = key in r.data) return sanitizeUtf8(*p);
    return "";
}

/**
 * Assemble the inventory: every `NickAlias` joined to its `NickCore` by
 * `nc == display` for the email, plus the suspension flags of any matching
 * `NSSuspendInfo`. Both joins are ASCII case-insensitive because IRC nicks
 * are. Sorted by nick, case-insensitively.
 *
 * An alias whose core is missing (a database Anope is mid-write on, or a
 * hand-edited file) is kept with an empty email rather than dropped: the admin
 * needs to see that the nick is registered.
 */
AnopeAccount[] anopeAccountsFromDb(string contents) @safe pure {
    import std.algorithm.sorting : sort;

    auto records = parseAnopeDb(contents);

    string[string] coreEmail;                 // lower(display) → email
    AnopeDbRecord[string] suspensions;        // lower(nick)    → NSSuspendInfo
    foreach (ref rec; records) {
        switch (rec.type) {
            case "NickCore":
                const display = field(rec, "display");
                if (display.length) coreEmail[asciiLowerStr(display)] = field(rec, "email");
                break;
            case "NSSuspendInfo":
                const nick = field(rec, "nick");
                if (nick.length) suspensions[asciiLowerStr(nick)] = rec;
                break;
            default:
                break;
        }
    }

    AnopeAccount[] rows;
    foreach (ref rec; records) {
        if (rec.type != "NickAlias") continue;
        const nick = field(rec, "nick");
        if (!nick.length) continue;

        AnopeAccount a;
        a.nick = nick;
        a.account = field(rec, "nc");
        a.registeredAt = parseUnixTime(field(rec, "time_registered"));
        a.lastSeenAt = parseUnixTime(field(rec, "last_seen"));
        a.lastUsermask = field(rec, "last_usermask");
        a.lastRealName = field(rec, "last_realname");

        if (auto email = asciiLowerStr(a.account.length ? a.account : nick) in coreEmail)
            a.email = *email;

        if (auto sus = asciiLowerStr(nick) in suspensions) {
            a.suspended = true;
            a.suspendedBy = field(*sus, "by");
            a.suspendReason = field(*sus, "reason");
            a.suspendedAt = parseUnixTime(field(*sus, "time"));
            a.suspendExpiresAt = parseUnixTime(field(*sus, "expires"));
        }
        rows ~= a;
    }

    sort!((a, b) => asciiICmp(a.nick, b.nick) < 0)(rows);
    return rows;
}

/// Configured path of Anope's flatfile database; "" disables the inventory.
string anopeDbPath() {
    import std.process : environment;
    return environment.get("IRCFIBER_ANOPE_DB_PATH", "").strip();
}

/// A read of `anope.db` is refused above this size rather than slurped; prod's
/// file is ~450 KB, so anything near the cap is a misconfigured path.
enum ulong ANOPE_DB_MAX_BYTES = 32UL * 1024 * 1024;

/// Outcome of one inventory read. `available == false` is a normal, expected
/// state (no mount, services not deployed) that the admin UI explains via
/// `reason` instead of failing.
struct AnopeInventory {
    bool available;
    string reason;             /// why it is unavailable, for the admin UI
    long fileMtime;            /// unix seconds, so the UI can show "as of"
    AnopeAccount[] accounts;
}

/// Reads the configured flatfile. `reason` is the admin-facing explanation
/// when it returns false; `mtime` is unix seconds so the UI can say "as of".
private bool readAnopeDbFile(out string raw, out long mtime, out string reason) {
    import std.file : exists, getSize, read, timeLastModified;

    raw = "";
    mtime = 0;
    reason = "";
    const path = anopeDbPath();
    if (!path.length) {
        reason = "IRCFIBER_ANOPE_DB_PATH is not set";
        return false;
    }
    try {
        if (!exists(path)) {
            reason = "anope.db not found at " ~ path;
            return false;
        }
        if (getSize(path) > ANOPE_DB_MAX_BYTES) {
            reason = "anope.db is larger than 32 MiB";
            return false;
        }
        mtime = timeLastModified(path).toUnixTime!long;
        raw = cast(string) read(path, cast(size_t) ANOPE_DB_MAX_BYTES);
        return true;
    } catch (Exception e) {
        raw = "";
        mtime = 0;
        reason = e.msg;
        return false;
    }
}

/// Read + parse `anope.db`. Never throws: every failure lands in `reason`.
AnopeInventory readAnopeInventory() {
    AnopeInventory inv;
    string raw;
    if (!readAnopeDbFile(raw, inv.fileMtime, inv.reason)) return inv;
    try {
        inv.accounts = anopeAccountsFromDb(raw);
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
 * One registered channel, as Anope's `db_flatfile` records it: an
 * `OBJECT ChannelInfo` joined to any `OBJECT CSSuspendInfo` naming it and to
 * the count of `OBJECT ChanAccess` records pointing at it.
 *
 * Anope 2.0.20 writes extensible flags as bare `DATA <FLAG> 1` lines (no
 * `extensible:` prefix), which is what the flag reads below rely on.
 */
struct AnopeChannel {
    string name;               /// ChannelInfo "name"
    string founder;            /// "founder" — a NickCore display; "" when the core was dropped
    string successor;          /// "successor"; absent in the file when unset
    string description;        /// "description"; often empty
    long registeredAt;         /// "time_registered", unix seconds, 0 when absent
    long lastUsedAt;           /// "last_used"
    string lastTopic;          /// "last_topic"
    string lastTopicSetter;    /// "last_topic_setter"
    long lastTopicAt;          /// "last_topic_time"
    string bot;                /// "bi" — assigned BotServ bot, "" when none
    long accessCount;          /// ChanAccess records whose "ci" is this channel
    bool noExpire;             /// bare "CS_NO_EXPIRE" flag
    bool isPrivate;            /// bare "CS_PRIVATE"
    bool persistent;           /// bare "PERSIST"
    bool suspended;            /// a CSSuspendInfo names this channel
    string suspendedBy;        /// CSSuspendInfo "by"
    string suspendReason;      /// "reason"
    long suspendedAt;          /// "time"
    long suspendExpiresAt;     /// "expires", 0 = never
}

/**
 * Assemble the channel inventory. Both joins (`CSSuspendInfo.chan`,
 * `ChanAccess.ci`) are ASCII case-insensitive because channel names are.
 * Sorted by name, case-insensitively.
 *
 * A channel whose founder core is gone keeps an empty `founder` rather than
 * dropping out: the admin needs to see that the registration exists.
 */
AnopeChannel[] anopeChannelsFromDb(string contents) @safe pure {
    import std.algorithm.sorting : sort;

    auto records = parseAnopeDb(contents);

    AnopeDbRecord[string] suspensions;   // lower(chan) → CSSuspendInfo
    long[string] accessCounts;           // lower(ci)   → ChanAccess rows
    foreach (ref rec; records) {
        switch (rec.type) {
            case "CSSuspendInfo":
                const chan = field(rec, "chan");
                if (chan.length) suspensions[asciiLowerStr(chan)] = rec;
                break;
            case "ChanAccess":
                const ci = field(rec, "ci");
                if (ci.length) accessCounts[asciiLowerStr(ci)] += 1;
                break;
            default:
                break;
        }
    }

    AnopeChannel[] rows;
    foreach (ref rec; records) {
        if (rec.type != "ChannelInfo") continue;
        const name = field(rec, "name");
        if (!name.length) continue;

        AnopeChannel c;
        c.name = name;
        c.founder = field(rec, "founder");
        c.successor = field(rec, "successor");
        c.description = field(rec, "description");
        c.registeredAt = parseUnixTime(field(rec, "time_registered"));
        c.lastUsedAt = parseUnixTime(field(rec, "last_used"));
        c.lastTopic = field(rec, "last_topic");
        c.lastTopicSetter = field(rec, "last_topic_setter");
        c.lastTopicAt = parseUnixTime(field(rec, "last_topic_time"));
        c.bot = field(rec, "bi");
        c.noExpire = field(rec, "CS_NO_EXPIRE") == "1";
        c.isPrivate = field(rec, "CS_PRIVATE") == "1";
        c.persistent = field(rec, "PERSIST") == "1";

        const key = asciiLowerStr(name);
        if (auto n = key in accessCounts) c.accessCount = *n;
        if (auto sus = key in suspensions) {
            c.suspended = true;
            c.suspendedBy = field(*sus, "by");
            c.suspendReason = field(*sus, "reason");
            c.suspendedAt = parseUnixTime(field(*sus, "time"));
            c.suspendExpiresAt = parseUnixTime(field(*sus, "expires"));
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
    long fileMtime;            /// unix seconds, so the UI can show "as of"
    AnopeChannel[] channels;
}

/// Read + parse the channel side of `anope.db`. Never throws.
AnopeChannelInventory readAnopeChannelInventory() {
    AnopeChannelInventory inv;
    string raw;
    if (!readAnopeDbFile(raw, inv.fileMtime, inv.reason)) return inv;
    try {
        inv.channels = anopeChannelsFromDb(raw);
        inv.available = true;
    } catch (Exception e) {
        inv.available = false;
        inv.channels = null;
        inv.reason = e.msg;
    }
    return inv;
}
