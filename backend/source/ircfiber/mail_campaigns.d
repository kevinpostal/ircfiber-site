/**
 * Bulk mail campaign jobs — model + status machine + Redis key helpers.
 *
 * The job worker lives in `ircfiber.web.admin.emails` (it needs sendMail,
 * the audience repository and the send log). This module stays dependency-
 * free so `campaignTransition` and the JSON round-trip are unit-testable
 * without Redis/Mongo (`dub test --config=signup-test`).
 *
 * Storage (Redis, 30-day TTL matching `mailEventTtlSeconds`):
 * - `irc:mail:campaign:<id>` → job JSON (subject/text/html, filter fields,
 *   scheduleAtMs, status, counters, total, createdBy/createdAtMs, error)
 * - `irc:mail:campaign:recipients:<id>` → JSON array of {username,email},
 *   resolved once at schedule time, capped at CAMPAIGN_MAX_RECIPIENTS
 * - `irc:mail:campaigns` → newest-first id list (LPUSH + LTRIM 200)
 */
module ircfiber.mail_campaigns;

import vibe.data.json : Json, parseJsonString;

/// Max recipients per campaign job. Same cap as the send-now path.
enum CAMPAIGN_JOB_MAX_RECIPIENTS = 200;

/// How long job rows live. Matches the send-log retention.
enum campaignJobTtlSeconds = 30 * 24 * 3600;

/// Cap on the job index list.
enum campaignJobIndexCap = 200;

/// Job lifecycle. `draft` exists only for dry-run responses, which never
/// persist a row — it documents the terminal intent of the dry-run branch.
enum CampaignStatus : string {
    scheduled = "scheduled",
    sending = "sending",
    paused = "paused",
    done_ = "done",
    cancelled = "cancelled",
    failed = "failed",
}

string campaignJobKey(string id) @safe pure {
    return "irc:mail:campaign:" ~ id;
}

string campaignRecipientsKey(string id) @safe pure {
    return "irc:mail:campaign:recipients:" ~ id;
}

string campaignIndexKey() @safe pure {
    return "irc:mail:campaigns";
}

/// Pure transition gate. Returns "" when allowed, else the human reason.
string campaignTransition(string from, string to) @safe pure {
    switch (from) {
        case "scheduled":
            if (to == "sending" || to == "cancelled") return "";
            break;
        case "sending":
            if (to == "paused" || to == "done" || to == "failed" || to == "cancelled") return "";
            break;
        case "paused":
            if (to == "sending" || to == "cancelled") return "";
            break;
        default:
            break;
    }
    if (from == "done" || from == "cancelled" || from == "failed")
        return "That campaign already finished (" ~ from ~ ").";
    return "Cannot move a campaign from " ~ from ~ " to " ~ to ~ ".";
}

bool campaignTerminal(string status) @safe pure nothrow @nogc {
    return status == "done" || status == "cancelled" || status == "failed";
}

/// One recipient resolved at schedule time.
struct CampaignRecipient {
    string username;
    string email;
}

/// Full job row. Filter fields are kept so the Review step can restate
/// the audience without re-resolving it.
struct CampaignJob {
    string id;
    string subject;
    string text;
    string html;
    string role;
    string q;
    long afterMs;
    long beforeMs;
    bool all;
    long scheduleAtMs;
    string status = "scheduled";
    string createdBy;
    long createdAtMs;
    long startedAtMs;
    long finishedAtMs;
    long sent;
    long failed;
    long skipped;
    long total;
    string error;

    Json toJson() const @safe {
        Json j = Json.emptyObject;
        j["id"] = Json(id);
        j["subject"] = Json(subject);
        j["text"] = Json(text);
        j["html"] = Json(html);
        j["role"] = Json(role);
        j["q"] = Json(q);
        j["afterMs"] = Json(afterMs);
        j["beforeMs"] = Json(beforeMs);
        j["all"] = Json(all);
        j["scheduleAtMs"] = Json(scheduleAtMs);
        j["status"] = Json(status);
        j["createdBy"] = Json(createdBy);
        j["createdAtMs"] = Json(createdAtMs);
        j["startedAtMs"] = Json(startedAtMs);
        j["finishedAtMs"] = Json(finishedAtMs);
        j["sent"] = Json(sent);
        j["failed"] = Json(failed);
        j["skipped"] = Json(skipped);
        j["total"] = Json(total);
        j["error"] = Json(error);
        return j;
    }

    /// Summary for the list route: no message bodies, no recipient lists.
    Json toSummaryJson() const @safe {
        Json j = Json.emptyObject;
        j["id"] = Json(id);
        j["subject"] = Json(subject);
        j["role"] = Json(role);
        j["q"] = Json(q);
        j["scheduleAtMs"] = Json(scheduleAtMs);
        j["status"] = Json(status);
        j["createdBy"] = Json(createdBy);
        j["createdAtMs"] = Json(createdAtMs);
        j["sent"] = Json(sent);
        j["failed"] = Json(failed);
        j["skipped"] = Json(skipped);
        j["total"] = Json(total);
        return j;
    }

    static CampaignJob fromJson(Json j) @safe {
        CampaignJob c;
        c.id = strOf(j, "id");
        c.subject = strOf(j, "subject");
        c.text = strOf(j, "text");
        c.html = strOf(j, "html");
        c.role = strOf(j, "role");
        c.q = strOf(j, "q");
        c.afterMs = longOf(j, "afterMs");
        c.beforeMs = longOf(j, "beforeMs");
        c.all = boolOf(j, "all");
        c.scheduleAtMs = longOf(j, "scheduleAtMs");
        c.status = strOf(j, "status");
        if (c.status.length == 0) c.status = "scheduled";
        c.createdBy = strOf(j, "createdBy");
        c.createdAtMs = longOf(j, "createdAtMs");
        c.startedAtMs = longOf(j, "startedAtMs");
        c.finishedAtMs = longOf(j, "finishedAtMs");
        c.sent = longOf(j, "sent");
        c.failed = longOf(j, "failed");
        c.skipped = longOf(j, "skipped");
        c.total = longOf(j, "total");
        c.error = strOf(j, "error");
        return c;
    }
}

private string strOf(Json j, string key) @safe {
    try {
        auto v = j[key];
        if (v.type == Json.Type.string) return v.get!string;
    } catch (Exception) {
    }
    return "";
}

private long longOf(Json j, string key) @safe {
    try {
        auto v = j[key];
        if (v.type == Json.Type.int_) return v.get!long;
        if (v.type == Json.Type.float_) return cast(long) v.get!double;
    } catch (Exception) {
    }
    return 0;
}

private bool boolOf(Json j, string key) @safe {
    try {
        auto v = j[key];
        if (v.type == Json.Type.bool_) return v.get!bool;
    } catch (Exception) {
    }
    return false;
}

Json recipientsToJson(const CampaignRecipient[] rows) @safe {
    Json arr = Json.emptyArray;
    foreach (const ref r; rows) {
        Json j = Json.emptyObject;
        j["username"] = Json(r.username);
        j["email"] = Json(r.email);
        arr ~= j;
    }
    return arr;
}
CampaignRecipient[] recipientsFromJson(Json arr) @safe {
    CampaignRecipient[] out_;
    try {
        foreach (size_t i; 0 .. arr.length) {
            auto v = arr[i];
            CampaignRecipient r;
            r.username = strOf(v, "username");
            r.email = strOf(v, "email");
            out_ ~= r;
        }
    } catch (Exception) {
    }
    return out_;
}

unittest {
    assert(campaignTransition("scheduled", "sending") == "");
    assert(campaignTransition("scheduled", "cancelled") == "");
    assert(campaignTransition("sending", "paused") == "");
    assert(campaignTransition("sending", "done") == "");
    assert(campaignTransition("sending", "failed") == "");
    assert(campaignTransition("sending", "cancelled") == "");
    assert(campaignTransition("paused", "sending") == "");
    assert(campaignTransition("paused", "cancelled") == "");
    assert(campaignTransition("scheduled", "done").length > 0);
    assert(campaignTransition("paused", "done").length > 0);
    assert(campaignTransition("done", "sending").length > 0);
    assert(campaignTransition("cancelled", "sending").length > 0);
    assert(campaignTransition("failed", "sending").length > 0);
    assert(campaignTerminal("done"));
    assert(campaignTerminal("cancelled"));
    assert(campaignTerminal("failed"));
    assert(!campaignTerminal("scheduled"));
    assert(!campaignTerminal("sending"));
    assert(!campaignTerminal("paused"));

    CampaignJob c;
    c.id = "abc";
    c.subject = "Hi";
    c.text = "body";
    c.status = "scheduled";
    c.sent = 3;
    c.total = 10;
    auto rt = CampaignJob.fromJson(c.toJson());
    assert(rt.id == "abc" && rt.subject == "Hi" && rt.sent == 3 && rt.total == 10);
    assert(rt.status == "scheduled");
    CampaignRecipient[] rs = [CampaignRecipient("al", "al@x.test")];
    assert(recipientsFromJson(recipientsToJson(rs))[0].email == "al@x.test");
    // Tolerant: missing status defaults to scheduled.
    assert(CampaignJob.fromJson(parseJsonString(`{"id":"x"}`)).status == "scheduled");
}
