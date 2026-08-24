module ircfiber.api.image_proxy;

import std.algorithm : canFind, startsWith, endsWith;
import std.array : replicate;
import std.conv : to;
import std.random : choice;
import std.string : toLower, strip, indexOf, lastIndexOf;
import core.time : seconds, Duration;
import core.sync.mutex : Mutex;
import std.datetime : Clock;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.http.client : requestHTTP, HTTPMethod, HTTPClientSettings, HTTPClientRequest, HTTPClientResponse;
import vibe.inet.url : URL;
import vibe.data.json : Json;
import vibe.core.log;
import vibe.core.stream : IOMode;

// 8 MiB limit — matches plan constant MAX_PROXY_BYTES = 8_388_608
private enum MAX_PROXY_BYTES = 8_388_608;
private enum MAX_URL_LENGTH = 2048;
private enum FETCH_TIMEOUT = 10.seconds;
private enum MAX_REDIRECTS = 3;
private enum CACHE_MAX_BYTES = 64 * 1024 * 1024;
private enum CACHE_TTL_MS = 86400L * 1000L;

private immutable string[] ALLOWED_CT_PREFIXES = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "image/avif", "image/svg+xml", "image/bmp", "image/x-icon"
];

// ── In-memory LRU-like cache (fastest path: hit avoids egress) ──
private struct CacheEntry {
    ubyte[] data;
    string contentType;
    long expiryMs;
}

__gshared Mutex g_cacheMutex;
__gshared CacheEntry[string] g_cache;
__gshared size_t g_cacheBytes;

shared static this() {
    g_cacheMutex = new Mutex();
}

private bool cacheGet(string url, out ubyte[] data, out string ct) {
    long now = Clock.currTime.toUnixTime!long * 1000L;
    synchronized (g_cacheMutex) {
        if (auto e = url in g_cache) {
            if (e.expiryMs > now) {
                data = e.data;
                ct = e.contentType;
                return true;
            } else {
                g_cacheBytes -= e.data.length;
                g_cache.remove(url);
            }
        }
    }
    return false;
}

private void cachePut(string url, const ubyte[] data, string ct) {
    if (data.length > MAX_PROXY_BYTES) return;
    if (data.length > CACHE_MAX_BYTES / 4) return; // don't cache huge single image
    long expiry = Clock.currTime.toUnixTime!long * 1000L + CACHE_TTL_MS;
    synchronized (g_cacheMutex) {
        // evict if over limit — drop oldest 25% (by expiry)
        if (g_cacheBytes + data.length > CACHE_MAX_BYTES) {
            // simple: remove entries until under 75%
            import std.array : array;
            import std.algorithm : sort;
            string[] keys = g_cache.keys.array;
            // sort by expiry ascending (oldest first)
            sort!((a,b) => g_cache[a].expiryMs < g_cache[b].expiryMs)(keys);
            foreach (k; keys) {
                g_cacheBytes -= g_cache[k].data.length;
                g_cache.remove(k);
                if (g_cacheBytes + data.length <= CACHE_MAX_BYTES * 3 / 4) break;
            }
        }
        // replace existing
        if (auto old = url in g_cache) g_cacheBytes -= old.data.length;
        CacheEntry e;
        e.data = data.dup;
        e.contentType = ct;
        e.expiryMs = expiry;
        g_cache[url] = e;
        g_cacheBytes += e.data.length;
    }
}

// Check if host is blocked for SSRF. Host must already be lowercased and
// stripped of port/brackets.
private bool isBlockedHost(string h) @safe pure {
    if (h.length == 0) return true;
    // Exact literals
    if (h == "localhost" || h == "redis" || h == "mongo" || h == "signoz"
        || h == "clickhouse" || h == "grafana" || h == "tailscale"
        || h == "ircfiber-gateway" || h == "ircfiber_engine" || h == "ircfiber_engine_ovh"
        || h == "0.0.0.0")
        return true;
    if (h.startsWith("signoz-")) return true;
    if (h.endsWith(".ts.net")) return true;
    // 127.*
    if (h.startsWith("127.")) return true;
    if (h == "127.0.0.1" || h == "::1" || h == "::ffff:127.0.0.1" || h == "[::1]") return true;
    // Zero
    if (h == "0.0.0.0") return true;
    // 10.*
    if (h.startsWith("10.")) return true;
    // 192.168.*
    if (h.startsWith("192.168.")) return true;
    // 172.16.* — 172.31.*
    if (h.startsWith("172.")) {
        auto dot = h.indexOf(".", 4);
        string second;
        if (dot > 0) second = h[4 .. dot];
        else second = h[4 .. $];
        try {
            int v = to!int(second);
            if (v >= 16 && v <= 31) return true;
        } catch (Exception) {}
    }
    // 169.254.* link-local / cloud metadata
    if (h.startsWith("169.254.")) return true;
    // IPv6 unique-local fc00::/7 and link-local fe80::/10
    if (h.startsWith("fc00:") || h.startsWith("fd00:")) return true;
    if (h.startsWith("[fc00:") || h.startsWith("[fd00:")) return true;
    if (h.startsWith("fe80:") || h.startsWith("[fe80:")) return true;
    return false;
}

// Extract host lower-cased without port or brackets for SSRF checks
private string extractHostLower(string urlStr) @safe {
    try {
        auto u = URL(urlStr);
        string host = u.host;
        // URL.host may include :port — strip it (but not IPv6 brackets)
        if (host.length >= 2 && host[0] == '[') {
            auto close = host.indexOf("]");
            if (close > 0) host = host[1 .. close];
        } else {
            // strip port
            auto colon = host.lastIndexOf(":");
            if (colon >= 0) {
                bool isPort = true;
                foreach (c; host[colon+1 .. $]) if (c < '0' || c > '9') { isPort = false; break; }
                if (isPort) host = host[0 .. colon];
            }
        }
        return host.toLower().strip();
    } catch (Exception) {
        return "";
    }
}

// Pure validation for testability
// Returns 0 on success, else HTTP status (400/403/414) and sets error
private int validateProxyUrlPure(string rawUrl, out string error) @safe {
    if (rawUrl.length == 0) { error = "missing url"; return 400; }
    if (rawUrl.length > MAX_URL_LENGTH) { error = "url too long"; return 414; }
    URL u;
    try { u = URL(rawUrl); } catch (Exception) { error = "invalid url"; return 400; }
    string schema = u.schema.toLower();
    if (schema != "http" && schema != "https") { error = "unsupported scheme"; return 400; }
    string host = extractHostLower(rawUrl);
    if (host.length == 0) { error = "missing host"; return 400; }
    if (isBlockedHost(host)) { error = "blocked host"; return 403; }
    return 0;
}

// Public for unit tests — matches plan signature concept
int validateProxyUrl(string rawUrl) @safe {
    string err;
    return validateProxyUrlPure(rawUrl, err);
}

bool isAllowedContentType(string ct) @safe pure {
    auto semi = ct.indexOf(";");
    string base = semi >= 0 ? ct[0 .. semi].strip().toLower() : ct.strip().toLower();
    if (base.length == 0) return false;
    // Exact allowed or startsWith image/
    foreach (p; ALLOWED_CT_PREFIXES) if (base == p) return true;
    // Allow any image/* as fallback (future types)
    if (base.startsWith("image/")) return true;
    // application/octet-stream may still be an image (sniff later), reject for now per plan
    return false;
}

private bool sniffImageMagic(const ubyte[] data) @safe pure {
    if (data.length >= 2) {
        // JPEG SOI FF D8
        if (data[0] == 0xFF && data[1] == 0xD8) return true;
        // PNG 89 50 4E 47
        if (data.length >= 8 && data[0]==0x89 && data[1]==0x50 && data[2]==0x4E && data[3]==0x47) return true;
        // GIF 47 49 46 38
        if (data.length >= 4 && data[0]==0x47 && data[1]==0x49 && data[2]==0x46 && data[3]==0x38) return true;
        // WebP RIFF....WEBP
        if (data.length >= 12 && data[0]==0x52 && data[1]==0x49 && data[2]==0x46 && data[3]==0x46
            && data[8]==0x57 && data[9]==0x45 && data[10]==0x42 && data[11]==0x50) return true;
        // BMP 42 4D
        if (data[0]==0x42 && data[1]==0x4D) return true;
        // AVIF ftyp
        if (data.length >= 12 && data[4]==0x66 && data[5]==0x74 && data[6]==0x79 && data[7]==0x70) return true;
        // SVG <?xml or <svg
        if (data.length >= 4) {
            // quick ascii check for <svg or <?xml
            import std.ascii : isWhite;
            size_t i=0; while (i<data.length && (data[i]==' '||data[i]=='\n'||data[i]=='\r'||data[i]=='\t')) i++;
            if (i+4 <= data.length) {
                if (data[i]=='<' && data[i+1]=='s' && data[i+2]=='v' && data[i+3]=='g') return true;
                if (data[i]=='<' && data[i+1]=='?' && data[i+2]=='x' && data[i+3]=='m') return true;
            }
        }
    }
    return false;
}

private bool isAuthed(HTTPServerRequest req) @safe {
    try {
        if (!req.session) return false;
        auto sid = req.session.get("sessionUserId", "");
        return sid.length > 0;
    } catch (Exception) { return false; }
}

void handleImageProxy(HTTPServerRequest req, HTTPServerResponse res) {
    // Fast auth: session check only (no Mongo lookup). Vibe session store already validated cookie.
    if (!isAuthed(req)) {
        res.statusCode = 401;
        res.writeJsonBody(Json(["error": Json("Unauthorized")]));
        return;
    }

    string rawUrl = req.query.get("url", "");
    if (rawUrl.length == 0) {
        res.statusCode = 400;
        res.writeJsonBody(Json(["error": Json("missing url")]));
        return;
    }
    if (rawUrl.length > MAX_URL_LENGTH) {
        res.statusCode = 414;
        res.writeJsonBody(Json(["error": Json("url too long")]));
        return;
    }

    string vErr;
    int vCode = validateProxyUrlPure(rawUrl, vErr);
    if (vCode != 0) {
        if (vCode == 403) logWarn("image-proxy blocked host %s", extractHostLower(rawUrl));
        res.statusCode = vCode;
        res.writeJsonBody(Json(["error": Json(vErr)]));
        return;
    }

    // ── Fast path: in-memory cache hit (no egress) ──
    ubyte[] cachedData;
    string cachedCT;
    if (cacheGet(rawUrl, cachedData, cachedCT)) {
        res.statusCode = 200;
        res.headers["Content-Type"] = cachedCT;
        res.headers["Cache-Control"] = "public, max-age=86400, immutable";
        res.headers["X-Content-Type-Options"] = "nosniff";
        res.headers["X-Cache"] = "HIT";
        res.headers["Content-Length"] = to!string(cachedData.length);
        res.bodyWriter.write(cachedData);
        return;
    }

    // Fetch loop with redirect handling (max 3) — streaming for TTFB
    string fetchUrl = rawUrl;

    auto settings = new HTTPClientSettings;
    settings.connectTimeout = FETCH_TIMEOUT;
    settings.readTimeout = FETCH_TIMEOUT;
    // keep-alive reuse is default; ensure pool stays warm

    foreach (redirectIdx; 0 .. MAX_REDIRECTS + 1) {
        // Re-validate each redirect target
        if (redirectIdx > 0) {
            string reErr;
            int reCode = validateProxyUrlPure(fetchUrl, reErr);
            if (reCode != 0) {
                logWarn("image-proxy redirect blocked host %s", extractHostLower(fetchUrl));
                res.statusCode = 403;
                res.writeJsonBody(Json(["error": Json("blocked host")]));
                return;
            }
            // check cache for redirect target too
            if (cacheGet(fetchUrl, cachedData, cachedCT)) {
                res.statusCode = 200;
                res.headers["Content-Type"] = cachedCT;
                res.headers["Cache-Control"] = "public, max-age=86400, immutable";
                res.headers["X-Content-Type-Options"] = "nosniff";
                res.headers["X-Cache"] = "HIT";
                res.headers["Content-Length"] = to!string(cachedData.length);
                res.bodyWriter.write(cachedData);
                // also populate original URL cache
                cachePut(rawUrl, cachedData, cachedCT);
                return;
            }
        }

        bool gotResponse = false;
        string locationHeader;
        int statusCode = 0;
        string contentType;
        string contentLengthStr;
        bool shouldStream = false;
        string fetchError;

        // streaming state
        bool headersSent = false;
        size_t streamedBytes = 0;
        ubyte[] sniffBuf; // for ambiguous CT
        bool sniffDone = false;
        string finalCT;
        // buffer for caching while streaming
        ubyte[] cacheAccum;
        bool cacheAccumEnabled = true;
        try {
            requestHTTP(fetchUrl,
                (scope HTTPClientRequest r) {
                    r.method = HTTPMethod.GET;
                    string[] user_agent_list = [
                          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
                          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
                          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
                    ];
                    r.headers["User-Agent"] = choice(user_agent_list);
                    r.headers["Accept"] = "image/*,*/*;q=0.8";
                    r.headers["Accept-Encoding"] = "identity";
                    r.headers["Connection"] = "keep-alive";
                },
                (scope HTTPClientResponse remoteRes) {
                    gotResponse = true;
                    statusCode = remoteRes.statusCode;
                    contentType = remoteRes.headers.get("Content-Type", "");
                    contentLengthStr = remoteRes.headers.get("Content-Length", "");
                    locationHeader = remoteRes.headers.get("Location", "");

                    // Handle redirects — don't read body
                    if (statusCode >= 300 && statusCode < 400 && locationHeader.length > 0 && redirectIdx < MAX_REDIRECTS) {
                        try {
                            auto base = URL(fetchUrl);
                            auto loc = URL(locationHeader);
                            if (loc.schema.length == 0) {
                                fetchUrl = base.toString()[0 .. base.toString().lastIndexOf("/") + 1] ~ locationHeader;
                                try { fetchUrl = URL(fetchUrl).toString(); } catch (Exception) {}
                            } else {
                                fetchUrl = loc.toString();
                            }
                        } catch (Exception) {
                            fetchUrl = locationHeader;
                        }
                        return;
                    }

                    // Size guard via Content-Length header (fast reject before streaming)
                    if (contentLengthStr.length > 0) {
                        try {
                            long clen = to!long(contentLengthStr.strip());
                            if (clen > MAX_PROXY_BYTES) {
                                fetchError = "too large";
                                statusCode = 413;
                                return;
                            }
                        } catch (Exception) {}
                    }

                    // Remote 4xx/5xx — don't stream
                    if (statusCode >= 400) {
                        return;
                    }

                    // Decide streaming strategy based on Content-Type header
                    bool ctOk = isAllowedContentType(contentType);
                    string ctBase = contentType;
                    auto semi = ctBase.indexOf(";");
                    if (semi >= 0) ctBase = ctBase[0 .. semi].strip();
                    if (ctBase.length == 0) ctBase = "image/jpeg";
                    finalCT = ctBase;

                    auto reader = remoteRes.bodyReader;

                    // If CT is known image, we can stream immediately
                    if (ctOk) {
                        // Send headers now (before any body)
                        if (!headersSent) {
                            // we are inside callback — we can write to server res directly
                            // but we need to ensure we haven't already written error
                            // Set headers lazily on first chunk; for now just mark shouldStream
                            shouldStream = true;
                            finalCT = ctBase;
                        }
                    } else {
                        // Ambiguous CT — need to peek first chunk to sniff
                        shouldStream = false; // will decide after first chunk
                    }

                    // Streaming loop — 64KB buffer for throughput
                    ubyte[65536] buf;
                    // For ambiguous CT, we buffer first chunk separately
                    while (!reader.empty) {
                        size_t chunk = reader.read(buf[], IOMode.once);
                        if (chunk == 0) break;
                        auto slice = buf[0 .. chunk];

                        // Size guard
                        streamedBytes += chunk;
                        if (streamedBytes > MAX_PROXY_BYTES) {
                            fetchError = "too large";
                            statusCode = 413;
                            // if headers already sent, we can't change status — just truncate
                            // else we will return 413 below
                            return;
                        }

                        // Handle ambiguous CT sniff on first chunk
                        if (!ctOk && !sniffDone) {
                            sniffDone = true;
                            bool isImg = sniffImageMagic(slice);
                            // also check if CT was application/octet-stream with magic
                            if (!isImg && slice.length >= 512) isImg = sniffImageMagic(slice[0 .. 512]);
                            if (!isImg) {
                                fetchError = "not an image";
                                statusCode = 415;
                                return;
                            }
                            // sniff says image — promote to streaming
                            if (finalCT == "" || finalCT.toLower() == "application/octet-stream" || !isAllowedContentType(finalCT))
                                finalCT = "image/jpeg";
                            shouldStream = true;
                        }

                        // First time we know we will stream, send headers
                        if (shouldStream && !headersSent) {
                            headersSent = true;
                            // Set response headers before first body byte
                            res.statusCode = 200;
                            res.headers["Content-Type"] = finalCT;
                            res.headers["Cache-Control"] = "public, max-age=86400, immutable";
                            res.headers["X-Content-Type-Options"] = "nosniff";
                            res.headers["X-Cache"] = "MISS";
                            if (contentLengthStr.length > 0 && ctOk) {
                                // forward length when we know it and CT was ok
                                res.headers["Content-Length"] = contentLengthStr.strip();
                            }
                            // else chunked (no Content-Length) — vibe will use chunked
                        }

                        if (shouldStream && headersSent) {
                            res.bodyWriter.write(slice);
                            if (cacheAccumEnabled) {
                                // accumulate for cache (up to limit)
                                if (cacheAccum.length + slice.length <= MAX_PROXY_BYTES)
                                    cacheAccum ~= slice;
                                else
                                    cacheAccumEnabled = false;
                            }
                        } else if (!shouldStream) {
                            // shouldn't happen — we would have returned on sniff fail
                            // buffer for later? but we already decided to stream
                        }
                    }
                    // If we never streamed (e.g. empty body with ambiguous CT), handle
                    if (!headersSent && shouldStream) {
                        // empty image? still send headers
                        res.statusCode = 200;
                        res.headers["Content-Type"] = finalCT;
                        res.headers["Cache-Control"] = "public, max-age=86400, immutable";
                        res.headers["X-Content-Type-Options"] = "nosniff";
                        res.headers["X-Cache"] = "MISS";
                    }
                    // cache the streamed data if we have it
                    if (shouldStream && headersSent && cacheAccum.length > 0 && fetchError.length == 0) {
                        cachePut(rawUrl, cacheAccum, finalCT);
                        if (fetchUrl != rawUrl) cachePut(fetchUrl, cacheAccum, finalCT);
                    }
                },
                settings
            );
        } catch (Exception e) {
            logWarn("image-proxy fetch failed %s: %s", fetchUrl, e.msg);
            if (!headersSent) {
                res.statusCode = 502;
                res.headers["Cache-Control"] = "no-store";
                try res.writeJsonBody(Json(["error": Json("upstream error")]));
                catch (Exception) {}
            }
            return;
        }

        if (!gotResponse) {
            if (!headersSent) {
                res.statusCode = 502;
                res.headers["Cache-Control"] = "no-store";
                res.writeJsonBody(Json(["error": Json("upstream error")]));
            }
            return;
        }

        // Redirect loop continuation
        if (statusCode >= 300 && statusCode < 400 && locationHeader.length > 0 && redirectIdx < MAX_REDIRECTS) {
            continue;
        }

        if (fetchError == "too large") {
            if (!headersSent) {
                res.statusCode = 413;
                res.headers["Cache-Control"] = "no-store";
                res.writeJsonBody(Json(["error": Json("too large")]));
            }
            return;
        }
        if (fetchError == "not an image") {
            if (!headersSent) {
                res.statusCode = 415;
                res.headers["Cache-Control"] = "no-store";
                res.writeJsonBody(Json(["error": Json("not an image")]));
            }
            return;
        }

        // Remote 4xx/5xx
        if (statusCode >= 400) {
            if (!headersSent) {
                res.statusCode = 502;
                res.headers["Cache-Control"] = "no-store";
                res.writeJsonBody(Json(["error": Json("upstream " ~ to!string(statusCode))]));
            }
            return;
        }

        // Success — headers already sent and body streamed; just log
        if (headersSent) {
            logInfo("image-proxy %s -> 200 %s %d bytes (streamed)", rawUrl, finalCT, cast(int)streamedBytes);
            return;
        } else {
            // Fallback: no body? try to handle empty success (should not happen)
            // If we got here without streaming, it means empty body with ok CT — send empty
            res.statusCode = 200;
            res.headers["Content-Type"] = contentType.length ? contentType : "image/jpeg";
            res.headers["Cache-Control"] = "public, max-age=86400, immutable";
            res.headers["X-Content-Type-Options"] = "nosniff";
            res.headers["X-Cache"] = "MISS";
            return;
        }
    }

    // too many redirects
    res.statusCode = 502;
    res.headers["Cache-Control"] = "no-store";
    res.writeJsonBody(Json(["error": Json("too many redirects")]));
}

unittest {
    // validateProxyUrl pure tests — matches plan
    assert(validateProxyUrl("https://example.com/x.jpg") == 0);
    assert(validateProxyUrl("javascript:alert(1)") != 0);
    assert(validateProxyUrl("http://127.0.0.1/x.jpg") == 403);
    assert(validateProxyUrl("http://10.0.0.1/x.jpg") == 403);
    assert(validateProxyUrl("http://169.254.169.254/latest/meta-data/") == 403);
    assert(validateProxyUrl("http://192.168.1.1/x.jpg") == 403);
    assert(validateProxyUrl("http://172.16.5.1/x.jpg") == 403);
    assert(validateProxyUrl("http://172.31.255.1/x.jpg") == 403);
    assert(validateProxyUrl("http://172.15.0.1/x.jpg") == 0); // not in 16-31
    assert(validateProxyUrl("http://172.32.0.1/x.jpg") == 0);
    assert(validateProxyUrl("http://example.com.tS.net/x.jpg") == 403); // *.ts.net
    assert(validateProxyUrl("http://redis/x.jpg") == 403);
    assert(validateProxyUrl("http://signoz-test/x.jpg") == 403);
    // scheme check
    assert(validateProxyUrl("ftp://example.com/x.jpg") == 400);
    assert(validateProxyUrl("data:text/plain,hello") == 400);
    // length
    string longUrl = "https://example.com/" ~ "a".replicate(2050);
    assert(validateProxyUrl(longUrl) == 414);
    // isAllowedContentType
    assert(isAllowedContentType("image/jpeg") == true);
    assert(isAllowedContentType("image/png; charset=utf-8") == true);
    assert(isAllowedContentType("text/html") == false);
    assert(isAllowedContentType("application/octet-stream") == false);
}
