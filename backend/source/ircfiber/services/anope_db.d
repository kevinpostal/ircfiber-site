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

private string asciiLowerStr(string s) @safe pure {
    bool needs = false;
    foreach (char c; s)
        if (c >= 'A' && c <= 'Z') { needs = true; break; }
    if (!needs) return s;
    char[] out_;
    out_.length = s.length;
    foreach (i, char c; s) out_[i] = asciiLower(c);
    return out_.idup;
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

/// Read + parse `anope.db`. Never throws: every failure lands in `reason`.
AnopeInventory readAnopeInventory() {
    import std.file : exists, getSize, read, timeLastModified;

    AnopeInventory inv;
    const path = anopeDbPath();
    if (!path.length) {
        inv.reason = "IRCFIBER_ANOPE_DB_PATH is not set";
        return inv;
    }
    try {
        if (!exists(path)) {
            inv.reason = "anope.db not found at " ~ path;
            return inv;
        }
        if (getSize(path) > ANOPE_DB_MAX_BYTES) {
            inv.reason = "anope.db is larger than 32 MiB";
            return inv;
        }
        inv.fileMtime = timeLastModified(path).toUnixTime!long;
        const raw = cast(string) read(path, cast(size_t) ANOPE_DB_MAX_BYTES);
        inv.accounts = anopeAccountsFromDb(raw);
        inv.available = true;
    } catch (Exception e) {
        inv.available = false;
        inv.accounts = null;
        inv.reason = e.msg;
    }
    return inv;
}
