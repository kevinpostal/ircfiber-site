/**
 * One fiber-aware HTTP GET for every IP-intelligence source.
 *
 * `requestHTTP` with connect+read timeouts, `Connection: close`, one
 * redirect followed (RDAP servers redirect between registries), the body
 * read in full and parsed as JSON. Never throws: a transport or parse
 * failure is reported in `HttpJson.error` so an adapter can turn it into
 * a `degraded` entry.
 */
module ircfiber.ipintel.http;

import std.conv : to;
import core.time : Duration;

import vibe.data.json : Json, parseJsonString;
import vibe.http.client : HTTPClientRequest, HTTPClientResponse, HTTPClientSettings, requestHTTP;
import vibe.http.common : HTTPMethod;
import vibe.stream.operations : readAll;

/// A GET's outcome. `status` is 0 when no response was received.
struct HttpJson {
    int status;
    Json body;
    /// `""` on a 2xx with a parsable body; otherwise `http<code>`, `parse`, `timeout` or the transport error.
    string error;
}

/// Raw text GET: status via `status`, `""` body on any failure.
string httpGetText(string url, const string[string] headers, Duration timeout, out int status,
                   int maxRedirects = 1) nothrow {
    status = 0;
    string body_;
    string location;
    try {
        auto settings = new HTTPClientSettings;
        settings.connectTimeout = timeout;
        settings.readTimeout = timeout;
        int st;
        requestHTTP(url,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.GET;
                foreach (k, v; headers) req.headers[k] = v;
                if (!("Accept" in headers)) req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
                req.headers["User-Agent"] = "ircfiber-ipintel/1 (+https://ircfiber.com)";
            },
            (scope HTTPClientResponse res) {
                st = res.statusCode;
                if (st >= 300 && st < 400) {
                    if (auto l = "Location" in res.headers) location = *l;
                    try res.dropBody(); catch (Exception) {}
                    return;
                }
                try body_ = cast(string) res.bodyReader.readAll();
                catch (Exception) { body_ = ""; }
            },
            settings);
        status = st;
        if (st >= 300 && st < 400 && location.length && maxRedirects > 0)
            return httpGetText(location, headers, timeout, status, maxRedirects - 1);
        return body_;
    } catch (Exception e) {
        status = 0;
        return "";
    }
}

/// JSON GET. A 2xx whose body is not JSON is `error = "parse"`;
/// a non-2xx is `error = "http<code>"`; no response is `"timeout"`.
HttpJson httpGetJson(string url, const string[string] headers, Duration timeout, int maxRedirects = 1) nothrow {
    HttpJson r;
    const text = httpGetText(url, headers, timeout, r.status, maxRedirects);
    if (r.status == 0) { r.error = "timeout"; return r; }
    if (r.status < 200 || r.status >= 300) { r.error = "http" ~ r.status.to!string; return r; }
    try r.body = parseJsonString(text);
    catch (Exception) { r.error = "parse"; return r; }
    return r;
}
