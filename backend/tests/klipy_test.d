module klipy_test;

import std.stdio : writefln, writeln;
import std.algorithm.searching : endsWith;
import vibe.data.json : Json, parseJsonString;

import ircfiber.api.klipy : embedFromItem, embedFromOpenGraph;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

/// Items API entry → the embed the frontend renders. The shape is the
/// documented one (docs.klipy.com/gifs-api/gifs-items-api): file.<size>.<fmt>.
private void testEmbedFromItem() {
    auto item = parseJsonString(`{"slug":"hello-hi-662","title":"Hello","file":{
        "md":{"webp":{"url":"https://static.klipy.com/ii/a/b.webp","width":300,"height":200},
              "gif":{"url":"https://static.klipy.com/ii/a/b.gif","width":300,"height":200}},
        "hd":{"mp4":{"url":"https://static.klipy.com/ii/a/b.mp4","width":498,"height":332}}}}`);
    auto e = embedFromItem(item, "hello-hi-662");
    check(e.type == Json.Type.object, "resolves");
    check(e["title"].get!string == "Hello", "title");
    check(e["page"].get!string == "https://klipy.com/gifs/hello-hi-662", "page link");
    check(e["webp"]["url"].get!string.endsWith("b.webp"), "md webp preferred");
    check(e["webp"]["width"].get!long == 300, "md width");
    check(e["mp4"]["width"].get!long == 498, "hd fallback when md lacks the format");
    check(e["poster"].type == Json.Type.null_, "missing rendition is null, not an error");

    // Off-CDN URLs are never surfaced: the frontend feeds these to the
    // image proxy, so an API answer must not be able to redirect it.
    auto evil = parseJsonString(`{"file":{"md":{"webp":{"url":"https://evil.example/x.webp"}}}}`);
    check(embedFromItem(evil, "x").type == Json.Type.null_, "foreign host rejected");
    auto plain = parseJsonString(`{"file":{"md":{"webp":{"url":"http://static.klipy.com/x.webp"}}}}`);
    check(embedFromItem(plain, "x").type == Json.Type.null_, "plaintext rejected");
    check(embedFromItem(parseJsonString(`{"file":{}}`), "x").type == Json.Type.null_, "no renditions → null");
    check(embedFromItem(parseJsonString(`[]`), "x").type == Json.Type.null_, "non-object → null");
}

/// The share page as served to an allowlisted unfurler: og:image twice
/// (webp, gif), each followed by its own dims/type, then og:video.
private void testEmbedFromOpenGraph() {
    enum html = `<html><head>
<meta property="og:title" content="KLIPY: Johnny Depp in Fear And Loathing In Las Vegas GIF &#8211; View &amp; Share"/>
<meta property="og:image" content="https://static2.klipy.com/ii/4e/77/59/QcM5.webp"/>
<meta property="og:image:width" content="640"/>
<meta property="og:image:height" content="404"/>
<meta property="og:image:type" content="image/webp"/>
<meta property="og:image" content="https://static2.klipy.com/ii/4e/77/59/obo.gif"/>
<meta property="og:image:width" content="640"/>
<meta property="og:image:height" content="404"/>
<meta property="og:image:type" content="image/gif"/>
<meta property="og:video:url" content="https://static2.klipy.com/ii/4e/77/59/Ggn.mp4"/>
<meta property="og:video:secure_url" content="https://static2.klipy.com/ii/4e/77/59/Ggn.mp4"/>
<meta property="og:video:width" content="640"/>
<meta property="og:video:height" content="404"/>
<meta property="og:video:type" content="video/mp4"/>
</head></html>`;
    auto e = embedFromOpenGraph(html, "johnny-depp-mad");
    check(e.type == Json.Type.object, "og resolves");
    check(e["webp"]["url"].get!string.endsWith("QcM5.webp"), "webp from first og:image");
    check(e["webp"]["width"].get!long == 640 && e["webp"]["height"].get!long == 404, "webp dims");
    check(e["gif"]["url"].get!string.endsWith("obo.gif"), "gif from second og:image");
    check(e["mp4"]["url"].get!string.endsWith("Ggn.mp4"), "mp4 from og:video");
    check(e["title"].get!string == "Johnny Depp in Fear And Loathing In Las Vegas GIF", "title stripped of KLIPY chrome: " ~ e["title"].get!string);
    check(e["page"].get!string == "https://klipy.com/gifs/johnny-depp-mad", "page");

    // The challenge page has no og media; a foreign CDN is rejected.
    check(embedFromOpenGraph(`<html><title>Just a moment...</title></html>`, "x").type == Json.Type.null_, "challenge page → null");
    check(embedFromOpenGraph(`<meta property="og:image" content="https://evil.example/a.webp"/><meta property="og:image:type" content="image/webp"/>`, "x").type == Json.Type.null_, "foreign host rejected");
}

int main() {
    testEmbedFromItem();
    testEmbedFromOpenGraph();
    if (failures) { writefln("klipy tests: %d FAILED", failures); return 1; }
    writeln("klipy tests: PASS");
    return 0;
}
