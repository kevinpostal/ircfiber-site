module ircfiber.upload.local;

import std.file : mkdirRecurse, write;
import std.path : buildPath, extension;
import std.uuid : randomUUID;
import std.string : replace, startsWith;
import std.process : environment;
import vibe.core.log;

/// Upload directory, defaulting to /app/uploads (inside the gateway
/// container). Override via the UPLOAD_DIR environment variable for
/// local dev and testing.
string uploadDir() @safe {
    auto env = environment.get("UPLOAD_DIR");
    return env.length > 0 ? env : "/app/uploads";
}

/// Result of a successful local upload.
struct LocalUploadResult {
    /// Direct URL to the uploaded file.
    string url; // https://ircfiber.com/uploads/<uuid>.<ext>
}

/// Thrown when the file can't be written.
class LocalUploadException : Exception {
    /// Constructs the exception with an error message.
    this(string msg, string file = __FILE__, size_t line = __LINE__) @safe {
        super(msg, file, line);
    }
}

/// Saves an uploaded file to the local filesystem under uploadDir.
/// Returns a URL constructed from the given baseUrl (e.g. "https://ircfiber.com").
/// Throws LocalUploadException on I/O failure.
LocalUploadResult saveUpload(string filename, string mime, const(ubyte)[] data, string baseUrl) @trusted {
    import std.string : strip;

    // Preserve original extension
    auto ext = extension(filename).strip;
    if (ext.length == 0) {
        // Guess extension from MIME type for common types (preserve universal binary support)
        import std.string : toLower;
        auto lowerMime = mime.toLower();
        if (mime == "image/png") ext = ".png";
        else if (mime == "image/jpeg" || mime == "image/jpg") ext = ".jpg";
        else if (mime == "image/gif") ext = ".gif";
        else if (mime == "image/webp") ext = ".webp";
        else if (mime == "image/svg+xml") ext = ".svg";
        else if (lowerMime == "text/html" || lowerMime == "application/xhtml+xml") ext = ".html";
        else if (mime == "text/plain") ext = ".txt";
        else if (mime == "application/json") ext = ".json";
        else if (mime == "text/x-python" || mime == "application/x-python") ext = ".py";
        else if (mime == "application/javascript" || mime == "text/javascript") ext = ".js";
        else if (lowerMime == "application/pdf") ext = ".pdf";
        else if (lowerMime == "application/zip" || lowerMime == "application/x-zip-compressed") ext = ".zip";
        else if (lowerMime == "application/gzip" || lowerMime == "application/x-gzip") ext = ".gz";
        else if (lowerMime == "video/mp4") ext = ".mp4";
        else if (lowerMime == "video/webm") ext = ".webm";
        else if (lowerMime == "audio/mpeg" || lowerMime == "audio/mp3") ext = ".mp3";
        else if (lowerMime == "audio/ogg") ext = ".ogg";
        else if (mime.startsWith("text/")) ext = ".txt";
        else if (mime.startsWith("video/")) ext = ".mp4";
        else if (mime.startsWith("audio/")) ext = ".mp3";
        else {
            auto lower = filename.toLower();
            if (lower == "dockerfile" || lower == "makefile" || lower == "gemfile" || lower == "rakefile") ext = "";
            else ext = ".bin";
        }
    }

    const uuid = randomUUID().toString().replace("-", "");
    auto destName = uuid ~ ext;
    auto dir = uploadDir();
    auto destPath = buildPath(dir, destName);

    // Ensure upload directory exists
    try {
        mkdirRecurse(dir);
    } catch (Exception e) {
        throw new LocalUploadException("Failed to create upload directory: " ~ e.msg);
    }

    // Write the file
    try {
        write(destPath, data);
    } catch (Exception e) {
        throw new LocalUploadException("Failed to write uploaded file: " ~ e.msg);
    }

    // Strip trailing slash from baseUrl
    auto base = baseUrl.strip;
    while (base.length > 0 && base[$-1] == '/') base = base[0..$-1];

    auto url = base ~ "/uploads/" ~ destName;
    logInfo("Saved upload: %s (%s bytes, mime=%s)", url, data.length, mime);
    return LocalUploadResult(url);
}
/// Saves an IRC art original image under uploadDir/img2irc/<uuid>.<ext>.
/// Returns the URL path (e.g. https://host/uploads/img2irc/<uuid>.png).
LocalUploadResult saveIrcArtOriginal(string filename, string mime, const(ubyte)[] data, string baseUrl) @trusted {
    import std.string : strip;
    auto ext = extension(filename).strip;
    if (ext.length == 0) {
        if (mime == "image/png") ext = ".png";
        else if (mime == "image/jpeg" || mime == "image/jpg") ext = ".jpg";
        else if (mime == "image/gif") ext = ".gif";
        else if (mime == "image/webp") ext = ".webp";
        else if (mime.startsWith("text/")) ext = ".txt";
        else ext = ".bin";
    }
    const uuid = randomUUID().toString().replace("-", "");
    auto destName = uuid ~ ext;
    auto dir = buildPath(uploadDir(), "img2irc");
    auto destPath = buildPath(dir, destName);
    try { mkdirRecurse(dir); } catch (Exception e) { throw new LocalUploadException("Failed to create img2irc directory: " ~ e.msg); }
    try { write(destPath, data); } catch (Exception e) { throw new LocalUploadException("Failed to write img2irc original: " ~ e.msg); }
    auto base = baseUrl.strip;
    while (base.length > 0 && base[$-1] == '/') base = base[0..$-1];
    auto url = base ~ "/uploads/img2irc/" ~ destName;
    logInfo("Saved img2irc original: %s (%s bytes)", url, data.length);
    return LocalUploadResult(url);
}

/// Saves a PNG thumbnail under uploadDir/img2irc/thumbs/<uuid>.png.
LocalUploadResult saveIrcArtThumbnail(const(ubyte)[] pngBytes, string baseUrl) @trusted {
    import std.string : strip;
    const uuid = randomUUID().toString().replace("-", "");
    auto destName = uuid ~ ".png";
    auto dir = buildPath(uploadDir(), "img2irc", "thumbs");
    auto destPath = buildPath(dir, destName);
    try { mkdirRecurse(dir); } catch (Exception e) { throw new LocalUploadException("Failed to create img2irc thumbs directory: " ~ e.msg); }
    try { write(destPath, pngBytes); } catch (Exception e) { throw new LocalUploadException("Failed to write img2irc thumbnail: " ~ e.msg); }
    auto base = baseUrl.strip;
    while (base.length > 0 && base[$-1] == '/') base = base[0..$-1];
    auto url = base ~ "/uploads/img2irc/thumbs/" ~ destName;
    logInfo("Saved img2irc thumbnail: %s (%s bytes)", url, pngBytes.length);
    return LocalUploadResult(url);
}

@("saveUpload generates a URL and writes to disk")
unittest {
    import std.algorithm : canFind, startsWith;
    import std.file : exists;

    const tmpDir = "/tmp/ircfiber-upload-test";
    auto testData = cast(const(ubyte)[])"fakeimagedata";

    // Set env var to a writable temp dir so the test works on any machine
    environment["UPLOAD_DIR"] = tmpDir;
    scope(exit) environment.remove("UPLOAD_DIR");

    auto result = saveUpload("test.png", "image/png", testData, "https://ircfiber.com");
    assert(result.url.canFind("/uploads/"));
    assert(result.url.canFind(".png"));
    assert(result.url.startsWith("https://ircfiber.com"));
}

@("saveUpload handles filenames without extension")
unittest {
    import std.algorithm : canFind;

    const tmpDir = "/tmp/ircfiber-upload-test2";
    auto testData = cast(const(ubyte)[])"data";

    environment["UPLOAD_DIR"] = tmpDir;
    scope(exit) environment.remove("UPLOAD_DIR");

    auto result = saveUpload("noext", "image/gif", testData, "http://localhost:8090");
    assert(result.url.canFind(".gif"), "Should guess extension from MIME: " ~ result.url);
}
