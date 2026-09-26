/**
 * Klipy inline embeds — `GET /api/embed/klipy?slug=<slug>`.
 *
 * A klipy.com/gifs/<slug> page sits behind a Cloudflare managed challenge,
 * so neither the browser nor this process can scrape it for og:image. The
 * only stable way to turn a share link into media is KLIPY's Items API
 * (`api/v1/{app_key}/gifs/items?slugs=`), which needs the partner app key
 * (`IRCFIBER_KLIPY_APP_KEY` / `_FILE`, partner.klipy.com → API Keys).
 *
 * With a key it returns the `md` rendition (animated WebP, GIF, MP4,
 * poster JPG, dimensions, title); the frontend loads the image through
 * /api/image-proxy like every other external inline, so the key and the
 * client IP never reach KLIPY from the browser.
 *
 * Without a key it falls back to the page's Open Graph tags. KLIPY serves
 * those only to allowlisted chat unfurlers (Discordbot, WhatsApp — our own
 * UA and generic browser UAs get the challenge), so the fallback presents
 * as Discordbot. That is a borrowed allowlist entry, not a contract: if
 * KLIPY tightens it the fallback returns 502 and links go back to plain
 * text. Set the key to be on the supported path.
 *
 * Results are cached per slug for an hour (testing-mode keys are limited
 * to 100 requests/hour). Misses (unknown slug) are cached too, briefly, so
 * a bad link pasted in a busy channel cannot drain the quota.
 */
module ircfiber.api.klipy;

import std.conv : to;
import std.datetime : Clock, SysTime;
import std.regex : ctRegex, matchFirst;
import std.algorithm.searching : endsWith;
import core.sync.mutex : Mutex;
import core.time : seconds;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : requestHTTP, HTTPMethod, HTTPClientSettings, HTTPClientRequest, HTTPClientResponse;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.inet.url : URL;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;

private enum SLUG_RE = ctRegex!(`^[a-z0-9][a-z0-9-]{0,127}$`);
private enum HIT_TTL = 3600;   // seconds
private enum MISS_TTL = 300;

private struct Entry {
    Json body_;      // resolved embed, or null for a cached miss
    long expiresAt;  // unix seconds
}

private __gshared Mutex cacheLock;
private __gshared Entry[string] cache;

shared static this() { cacheLock = new Mutex; }

private bool isAuthed(HTTPServerRequest req) @safe {
    try {
        if (!req.session) return false;
        return req.session.get("sessionUserId", "").length > 0;
    } catch (Exception) { return false; }
}

/// One rendition (`file.md.webp` etc.) as `{url,width,height}`, or null.
private Json rendition(Json file, string size, string fmt) @safe {
    if (file.type != Json.Type.object) return Json(null);
    auto s = size in file;
    if (s is null || s.type != Json.Type.object) return Json(null);
    auto f = fmt in *s;
    if (f is null || f.type != Json.Type.object) return Json(null);
    auto url = "url" in *f;
    if (url is null || url.type != Json.Type.string || !url.get!string.length) return Json(null);
    // Only KLIPY's own CDN ever reaches the image proxy from here.
    try {
        auto u = URL(url.get!string);
        if (u.schema != "https" || (u.host != "static.klipy.com" && !u.host.endsWith(".klipy.com"))) return Json(null);
    } catch (Exception) { return Json(null); }
    auto w = "width" in *f;
    auto h = "height" in *f;
    return Json([
        "url": *url,
        "width": Json(w !is null && w.type == Json.Type.int_ ? w.get!long : 0),
        "height": Json(h !is null && h.type == Json.Type.int_ ? h.get!long : 0),
    ]);
}

/// Projects one Items API entry onto the embed the frontend renders.
/// Public for tests/klipy_test.d.
Json embedFromItem(Json item, string slug) @safe {
    if (item.type != Json.Type.object) return Json(null);
    auto file = "file" in item;
    if (file is null) return Json(null);
    // md is the display size; hd only as a fallback when md is absent.
    Json pick(string fmt) {
        auto r = rendition(*file, "md", fmt);
        return r.type == Json.Type.null_ ? rendition(*file, "hd", fmt) : r;
    }
    auto webp = pick("webp");
    auto gif = pick("gif");
    auto mp4 = pick("mp4");
    auto jpg = pick("jpg");
    if (webp.type == Json.Type.null_ && gif.type == Json.Type.null_) return Json(null);
    auto title = "title" in item;
    return Json([
        "slug": Json(slug),
        "title": Json(title !is null && title.type == Json.Type.string ? title.get!string : ""),
        "page": Json("https://klipy.com/gifs/" ~ slug),
        "webp": webp,
        "gif": gif,
        "mp4": mp4,
        "poster": jpg,
    ]);
}

/// Resolves a slug through the Items API. Returns null for an unknown slug
/// and throws on transport/API failure (the caller answers 502 and does
/// not cache).
private Json resolve(string appKey, string slug) {
    import std.process : environment;
    // IRCFIBER_KLIPY_API_BASE: local stub for smoke tests; production uses the default.
    const base = environment.get("IRCFIBER_KLIPY_API_BASE", "https://api.klipy.com");
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 5.seconds;
    settings.readTimeout = 8.seconds;
    int status;
    string body_;
    requestHTTP(base ~ "/api/v1/" ~ appKey ~ "/gifs/items?slugs=" ~ slug,
        (scope HTTPClientRequest req) {
            req.method = HTTPMethod.GET;
            req.headers["Accept"] = "application/json";
            req.headers["Connection"] = "close";
        },
        (scope HTTPClientResponse res) {
            status = res.statusCode;
            body_ = cast(string) res.bodyReader.readAll();
        }, settings);
    if (status < 200 || status >= 300)
        throw new Exception("klipy items api answered " ~ status.to!string);
    auto j = parseJsonString(body_);
    auto data = "data" in j;
    if (data is null || data.type != Json.Type.object) return Json(null);
    auto items = "data" in *data;
    if (items is null || items.type != Json.Type.array || items.length == 0) return Json(null);
    foreach (item; *items) {
        auto s = "slug" in item;
        if (s !is null && s.type == Json.Type.string && s.get!string == slug)
            return embedFromItem(item, slug);
    }
    return embedFromItem((*items)[0], slug);
}

/// The unfurler UA KLIPY allowlists (generic/browser UAs get the challenge).
private enum UNFURL_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

private enum OG_META_RE = ctRegex!(`<meta\s+(?:property|name)="(og:[a-z:_]+)"\s+content="([^"]*)"`, "g");

/// Builds the embed from the share page's Open Graph tags. Public for
/// tests/klipy_test.d. Returns null when the page carries no usable media.
Json embedFromOpenGraph(string html, string slug) @safe {
    import std.regex : matchAll;
    import std.string : replace;
    Json webp = Json(null), gif = Json(null), mp4 = Json(null);
    string title;
    // og:image repeats (webp, then gif); each is followed by its own
    // width/height/type, so track the most recent image/video.
    string curUrl; long curW, curH; string curKind;
    void flush() @safe {
        if (!curUrl.length) return;
        auto r = Json(["url": Json(curUrl), "width": Json(curW), "height": Json(curH)]);
        bool okHost;
        try { auto u = URL(curUrl); okHost = u.schema == "https" && (u.host == "klipy.com" || u.host.endsWith(".klipy.com")); }
        catch (Exception) {}
        if (okHost) {
            if (curKind == "image/webp" || (curKind == "" && curUrl.endsWith(".webp"))) webp = r;
            else if (curKind == "image/gif" || (curKind == "" && curUrl.endsWith(".gif"))) gif = r;
            else if (curKind == "video/mp4" || (curKind == "" && curUrl.endsWith(".mp4"))) mp4 = r;
        }
        curUrl = null; curW = 0; curH = 0; curKind = null;
    }
    foreach (m; matchAll(html, OG_META_RE)) {
        const key = m[1];
        const val = m[2].replace("&amp;", "&");
        switch (key) {
            case "og:title":
                // "KLIPY: <name> GIF – View & Share" (the dash is &#8211; or the
                // literal en dash, and & has already been unescaped above).
                title = val.replace("KLIPY: ", "").replace(" &#8211; View & Share", "").replace(" – View & Share", "");
                break;
            case "og:image": case "og:video:url": flush(); curUrl = val; break;
            case "og:video:secure_url": if (!curUrl.length) curUrl = val; break;
            case "og:image:width": case "og:video:width": try curW = val.to!long; catch (Exception) {} break;
            case "og:image:height": case "og:video:height": try curH = val.to!long; catch (Exception) {} break;
            case "og:image:type": case "og:video:type": curKind = val; break;
            default: break;
        }
    }
    flush();
    if (webp.type == Json.Type.null_ && gif.type == Json.Type.null_) return Json(null);
    return Json([
        "slug": Json(slug), "title": Json(title), "page": Json("https://klipy.com/gifs/" ~ slug),
        "webp": webp, "gif": gif, "mp4": mp4, "poster": Json(null),
    ]);
}

/// Fetches the share page as an unfurler and projects its Open Graph tags.
/// Null for a page without media (unknown slug renders a generic page);
/// throws on transport failure or the challenge page (403).
private Json resolveViaOpenGraph(string slug) {
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 5.seconds;
    settings.readTimeout = 8.seconds;
    int status;
    string body_;
    requestHTTP("https://klipy.com/gifs/" ~ slug,
        (scope HTTPClientRequest req) {
            req.method = HTTPMethod.GET;
            req.headers["User-Agent"] = UNFURL_UA;
            req.headers["Accept"] = "text/html";
            req.headers["Connection"] = "close";
        },
        (scope HTTPClientResponse res) {
            status = res.statusCode;
            body_ = cast(string) res.bodyReader.readAll();
        }, settings);
    if (status == 404) return Json(null);
    if (status < 200 || status >= 300)
        throw new Exception("klipy page answered " ~ status.to!string ~ " (unfurler allowlist changed?)");
    return embedFromOpenGraph(body_, slug);
}

void handleKlipyEmbed(HTTPServerRequest req, HTTPServerResponse res) {
    if (!isAuthed(req)) {
        res.statusCode = 401;
        res.writeJsonBody(Json(["error": Json("Unauthorized")]));
        return;
    }
    const slug = req.query.get("slug", "");
    if (slug.matchFirst(SLUG_RE).empty) {
        res.statusCode = 400;
        res.writeJsonBody(Json(["error": Json("invalid slug")]));
        return;
    }
    const appKey = envSecret("IRCFIBER_KLIPY_APP_KEY");

    const now = Clock.currTime.toUnixTime!long;
    Json cached;
    bool haveCached;
    synchronized (cacheLock) {
        if (auto e = slug in cache) {
            if (e.expiresAt > now) { cached = e.body_; haveCached = true; }
            else cache.remove(slug);
        }
    }
    if (!haveCached) {
        try cached = appKey.length ? resolve(appKey, slug) : resolveViaOpenGraph(slug);
        catch (Exception e) {
            logWarn("klipy: resolving %s failed: %s", slug, e.msg);
            res.statusCode = 502;
            res.headers["Cache-Control"] = "no-store";
            res.writeJsonBody(Json(["error": Json("klipy lookup failed")]));
            return;
        }
        const ttl = cached.type == Json.Type.null_ ? MISS_TTL : HIT_TTL;
        synchronized (cacheLock) {
            if (cache.length > 5000) cache = null; // crude bound; entries expire anyway
            cache[slug] = Entry(cached, now + ttl);
        }
    }
    if (cached.type == Json.Type.null_) {
        res.statusCode = 404;
        res.headers["Cache-Control"] = "private, max-age=" ~ MISS_TTL.to!string;
        res.writeJsonBody(Json(["error": Json("unknown gif")]));
        return;
    }
    res.headers["Cache-Control"] = "private, max-age=" ~ HIT_TTL.to!string;
    res.writeJsonBody(cached);
}
