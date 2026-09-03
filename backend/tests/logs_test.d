module logs_test;

// Pure-code unit test for the admin Logs SigNoz proxy helpers
// (no SigNoz needed):
//   dub --root=backend build --config=logs-test && ./backend/logs-test
//
// Covers the v0.138 envelope reshape (results[].rows[].data into the
// legacy data.<name>.list shape the admin UI parses) and the request
// sanitizer (strips top-level compositeQuery fields v0.138 rejects).

import std.stdio : writeln, writefln;
import std.string : indexOf;
import vibe.data.json : Json, parseJsonString;

import ircfiber.web.admin.logs;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

// Abridged real v0.138 raw row (nanosecond timestamp, service under
// resources_string, attributes split by type).
private enum ROW138 = `{"data":{"attributes_string":{"a":"1"},"attributes_number":{"n":2},"body":"x failed","resources_string":{"service.name":"irc-fiber-engine"},"severity_text":"ERROR","timestamp":1788450492501404500,"trace_id":"abc"},"timestamp":"2026-09-03T15:48:12.5014045Z"}`;

private void testReshapeRow() {
    auto o = reshapeRow(parseJsonString(ROW138));
    check(o["severity_text"].get!string == "ERROR", "severity passthrough");
    check(o["body"].get!string == "x failed", "body passthrough");
    check(o["trace_id"].get!string == "abc", "trace id kept");
    check(o["timestamp_nano"].get!long == 1788450492501404500L, "ns timestamp kept");
    check(o["service_name"].get!string == "irc-fiber-engine", "service from resources");
    check(o["attributes"]["a"].get!string == "1", "string attr merged");
    check(o["attributes"]["service.name"].get!string == "irc-fiber-engine",
        "resource merged into attributes");
}

private void testReshapeRowMissing() {
    // Empty trace id dropped; missing timestamp tolerated (the UI
    // falls back to Date.now()).
    auto o = reshapeRow(parseJsonString(
        `{"data":{"body":"b","severity_text":"WARN","trace_id":""}}`));
    check(o["trace_id"].type == Json.Type.undefined, "empty trace dropped");
    check(o["timestamp_nano"].type == Json.Type.undefined, "missing ts tolerated");
    check(o["body"].get!string == "b", "body kept");
    // Non-object data passes through untouched.
    auto raw = parseJsonString(`{"weird":true}`);
    check(reshapeRow(raw) == raw, "unknown row shape passes through");
}

private void testReshapeEnvelope() {
    auto v = parseJsonString(
        `{"status":"success","data":{"type":"raw","data":{"results":[` ~
        `{"queryName":"A","rows":[` ~ ROW138 ~ `]},` ~
        `{"queryName":"B","rows":null}]}}}`);
    auto o = reshapeQueryRange(v);
    check(o["status"].get!string == "success", "status kept");
    check(o["data"]["A"]["list"].get!(Json[]).length == 1, "A has one row");
    check(o["data"]["A"]["list"][0]["service_name"].get!string == "irc-fiber-engine",
        "row reshaped inside envelope");
    check(o["data"]["B"]["list"].get!(Json[]).length == 0, "null rows become empty list");
    // Non-v138 envelopes pass through untouched.
    auto legacy = parseJsonString(`{"status":"success","data":{"A":{"list":[]}}}`);
    check(reshapeQueryRange(legacy) == legacy, "legacy envelope passes through");
}

private void testSanitize() {
    auto raw = `{"start":1,"end":2,"requestType":"raw","schemaVersion":"v1",` ~
        `"compositeQuery":{"queryType":"builder","panelType":"list","queries":[]}}`;
    auto v = parseJsonString(sanitizeQueryBody(raw));
    check(v["compositeQuery"]["queryType"].type == Json.Type.undefined,
        "queryType stripped");
    check(v["compositeQuery"]["panelType"].type == Json.Type.undefined,
        "panelType stripped");
    check(v["requestType"].get!string == "raw", "requestType kept");
    check(v["compositeQuery"]["queries"].get!(Json[]).length == 0, "queries kept");
    check(sanitizeQueryBody("not json{{{") == "not json{{{",
        "unparseable body passes through");
}

void main() {
    testReshapeRow();
    testReshapeRowMissing();
    testReshapeEnvelope();
    testSanitize();
    if (failures == 0) writeln("logs proxy tests: PASS");
    else writefln("logs proxy tests: %d FAILURES", failures);
    import core.stdc.stdlib : exit;
    exit(failures == 0 ? 0 : 1);
}
