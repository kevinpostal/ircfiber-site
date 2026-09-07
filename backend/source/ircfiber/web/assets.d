module ircfiber.web.assets;

import std.algorithm : canFind, endsWith;
import std.file : readText;
import vibe.core.log : logError;
import vibe.data.json : Json, parseJsonString;

/// Content-hashed bundle URLs the SPA shell (views/index.dt) links. Resolved
/// at runtime from Vite's manifest so the shell can never name a bundle other
/// than the one shipped beside it — the shell used to be rewritten at build
/// time and CTFE-baked, which made every frontend change a D recompile and
/// let a stale baked shell point at a bundle the image no longer contained.
struct AssetManifest {
    string mainJs;      /// "/public/dist/assets/main-<hash>.js"
    string vendorJs;    /// "" when absent
    string[] css;       /// entry CSS first, then static-import-closure CSS, deduped
}

private enum manifestPath = "public/dist/.vite/manifest.json";
private enum urlPrefix = "/public/dist/";

/// Parsed once at first use from public/dist/.vite/manifest.json. On a
/// missing/unparseable manifest every field stays empty: the shell then
/// renders no script tag, which is loud and obvious rather than silently stale.
ref const(AssetManifest) siteAssets() @trusted {
    __gshared AssetManifest assets;
    __gshared bool loaded;
    if (!loaded) {
        try {
            assets = parseAssetManifest(parseJsonString(readText(manifestPath)));
        } catch (Exception e) {
            logError("assets: cannot read %s: %s — SPA shell will link no bundle", manifestPath, e.msg);
        }
        loaded = true;
    }
    return assets;
}

/// Same selection rules as the former frontend/inject-manifest.js:
/// entry "index.html"; eager CSS = entry + its STATIC import closure
/// (feature chunks are dynamic imports and Vite injects their CSS at load);
/// vendor = the first JS chunk whose name contains "vendor" but not
/// "vendor-admin" (the admin SPA's vendor must never be preloaded by the
/// chat shell).
AssetManifest parseAssetManifest(Json manifest) @trusted {
    AssetManifest out_;
    auto entry = "index.html" in manifest;
    if (entry is null || entry.type != Json.Type.object)
        throw new Exception("no index.html entry in manifest");

    out_.mainJs = urlPrefix ~ (*entry)["file"].get!string;

    void addCss(string file) {
        auto href = urlPrefix ~ file;
        if (!out_.css.canFind(href)) out_.css ~= href;
    }
    if (auto css = "css" in *entry)
        if (css.type == Json.Type.array && css.length > 0)
            addCss((*css)[0].get!string);

    bool[string] seen;
    void collect(string key) {
        if (key in seen) return;
        seen[key] = true;
        auto node = key in manifest;
        if (node is null || node.type != Json.Type.object) return;
        if (auto css = "css" in *node)
            if (css.type == Json.Type.array)
                foreach (c; *css) addCss(c.get!string);
        if (auto imports = "imports" in *node)
            if (imports.type == Json.Type.array)
                foreach (imp; *imports) collect(imp.get!string);
    }
    collect("index.html");

    foreach (string key, Json node; manifest) {
        if (node.type != Json.Type.object) continue;
        auto file = "file" in node;
        if (file is null || file.type != Json.Type.string) continue;
        auto f = file.get!string;
        if (f.endsWith(".js") && f.canFind("vendor") && !f.canFind("vendor-admin")) {
            out_.vendorJs = urlPrefix ~ f;
            break;
        }
    }
    return out_;
}
