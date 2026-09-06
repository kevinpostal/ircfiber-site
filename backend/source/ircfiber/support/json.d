/**
 * JSON shape of a support issue shared by the user REST API
 * (`/api/support/issues`) and the admin API (`/api/admin/support/issues`),
 * plus the enum validators and the single-line sanitizer used by both the
 * HTTP handlers and the #support bot.
 */
module ircfiber.support.json;

import std.algorithm : canFind;
import std.string : strip;
import vibe.data.json : Json;
import ircfiber.db.support_issues : SupportIssueRecord, SupportComment, SupportIssueContext,
    supportKinds, supportStatuses, supportPriorities;

/// True when `k` is a wire value of `SupportIssueRecord.kind`.
bool isValidKind(string k) @safe pure nothrow @nogc { return supportKinds.canFind(k); }
/// True when `s` is a wire value of `SupportIssueRecord.status`.
bool isValidStatus(string s) @safe pure nothrow @nogc { return supportStatuses.canFind(s); }
/// True when `p` is a wire value of `SupportIssueRecord.priority`.
bool isValidPriority(string p) @safe pure nothrow @nogc { return supportPriorities.canFind(p); }

/// Collapses a user string onto one line: CR, LF and every other C0
/// control byte (including IRC formatting codes) become a space; the
/// result is stripped. Safe to embed in an IRC PRIVMSG or a log line.
string sanitizeLine(string s) @safe pure {
    char[] buf = s.dup;
    foreach (ref c; buf)
        if (c < 0x20) c = ' ';
    return (() @trusted => cast(string) buf)().strip();
}

private Json commentToJson(const ref SupportComment c) {
    return Json([
        "id": Json(c.id), "authorName": Json(c.authorName),
        "fromAdmin": Json(c.fromAdmin), "internal": Json(c.internal),
        "body": Json(c.body_), "createdAt": Json(c.createdAt),
    ]);
}

private Json contextToJson(const ref SupportIssueContext c) {
    return Json([
        "appVersion": Json(c.appVersion), "userAgent": Json(c.userAgent), "url": Json(c.url),
        "networkId": Json(c.networkId), "bufferName": Json(c.bufferName), "viewport": Json(c.viewport),
    ]);
}

/// Serializes an issue for an HTTP response.
///
/// `includeInternal=false` (reporter view) omits admin-only notes and
/// counts only public comments in `commentCount`. `includeContext` adds the
/// captured diagnostics (admin view only).
Json supportIssueToJson(const SupportIssueRecord r, bool includeInternal, bool includeContext) {
    auto comments = Json.emptyArray;
    long publicCount = 0;
    foreach (ref c; r.comments) {
        if (c.internal && !includeInternal) continue;
        comments ~= commentToJson(c);
        publicCount++;
    }
    auto attachments = Json.emptyArray;
    foreach (a; r.attachments) attachments ~= Json(a);

    auto j = Json.emptyObject;
    j["id"] = Json(r.id);
    j["number"] = Json(r.number);
    j["kind"] = Json(r.kind);
    j["title"] = Json(r.title);
    j["body"] = Json(r.body_);
    j["status"] = Json(r.status);
    j["priority"] = Json(r.priority);
    j["reporterUsername"] = Json(r.reporterUsername);
    j["userId"] = Json(r.userId);
    j["assigneeId"] = Json(r.assigneeId);
    j["assigneeUsername"] = Json(r.assigneeUsername);
    j["attachments"] = attachments;
    j["comments"] = comments;
    j["createdAt"] = Json(r.createdAt);
    j["updatedAt"] = Json(r.updatedAt);
    j["resolvedAt"] = Json(r.resolvedAt);
    j["commentCount"] = Json(publicCount);
    if (includeContext) j["context"] = contextToJson(r.context);
    return j;
}
