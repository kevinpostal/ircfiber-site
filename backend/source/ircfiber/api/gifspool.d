/// File-spool protocol shared by the gateway and the GIF sandbox.
///
/// Untrusted user media (video, WebP) is decoded ONLY inside the
/// `runtime-gifworker` container: no network namespace, read-only rootfs, all
/// capabilities dropped, uid 65534, the uploads volume mounted read-only.
/// ffmpeg/ffprobe are a large C attack surface driven entirely by
/// attacker-supplied bytes, and running them next to the gateway's Redis and
/// Mongo credentials was the exposure this protocol removes.
///
/// IPC is a directory of small files on a shared volume, deliberately not
/// Redis or HTTP: a queue or socket would force a network namespace back onto
/// the sandbox. Everything here is pure text munging so it can be tested
/// without a container — see `tests/gif_spool_test.d` and the worker itself,
/// `docker/gifworker/gif-worker.sh`, which owns the ffmpeg recipe.
module ircfiber.api.gifspool;

import std.conv : to;

/// Upload basenames are server-generated (`<uuid-hex>.<ext>`, see
/// `ircfiber.upload.local.saveUpload`), so a spool entry only ever carries a
/// flat, boring name. Anything else — a slash, a `..`, an exotic byte — is
/// refused here rather than trusted to the shell on the other side.
bool gifSpoolSafeName(string name) @safe pure {
    if (name.length == 0 || name.length > 128) return false;
    if (name[0] == '.') return false;
    foreach (char c; name) {
        const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

/// Body of the `.job` file handed to the sandbox.
string gifSpoolSpec(string srcName, string outName, int seconds) @safe pure {
    return "src=" ~ srcName ~ "\nout=" ~ outName ~ "\nseconds=" ~ seconds.to!string ~ "\n";
}

/// First value for `key` in a `key=value` spool file.
string gifSpoolValue(string text, string key) @safe pure {
    import std.algorithm.iteration : splitter;
    import std.string : strip, startsWith;
    foreach (line; text.splitter('\n')) {
        auto l = line.strip;
        if (l.startsWith(key ~ "=")) return l[key.length + 1 .. $];
    }
    return null;
}

/// One parsed ffmpeg `-progress` snapshot.
struct GifProgressSnapshot {
    bool any;      /// at least one complete block was present
    bool ended;    /// the last block was `progress=end`
    long frame;
    double fps = 0;
    double speed = 0;
    long outTimeMs;
}

/// Parses the LAST COMPLETE block of an ffmpeg `-progress` file. ffmpeg
/// appends `key=value` lines and terminates every block with
/// `progress=continue|end`; committing only on that terminator is what stops
/// a snapshot from mixing this block's frame count with the previous block's
/// timestamp — the file is read while it is still being written, so a
/// trailing partial block is the normal case, not the exception.
GifProgressSnapshot parseGifProgress(string text) @safe pure {
    import std.algorithm.iteration : splitter;
    import std.string : strip, indexOf, endsWith;
    GifProgressSnapshot cur, committed;
    foreach (line; text.splitter('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line[0 .. eq].strip;
        const val = line[eq + 1 .. $].strip;
        switch (key) {
            case "frame":
                try cur.frame = val.to!long; catch (Exception) {}
                break;
            case "fps":
                try cur.fps = val.to!double; catch (Exception) {}
                break;
            case "speed":
                // e.g. "1.42x", or "N/A" before the first frame.
                try cur.speed = val.endsWith("x") ? val[0 .. $ - 1].to!double : val.to!double;
                catch (Exception) {}
                break;
            case "out_time_us":
            case "out_time_ms":   // ffmpeg reports microseconds here too
                try cur.outTimeMs = val.to!long / 1000; catch (Exception) {}
                break;
            case "progress":
                cur.any = true;
                cur.ended = val == "end";
                committed = cur;
                break;
            default:
                break;
        }
    }
    return committed;
}

/// Terminal record the sandbox writes last.
struct GifExitRecord {
    bool present;
    int status;
    string error;   /// worker-supplied message, empty when it has none
}

/// Parses a `.exit` file. A missing `status` means the file was caught
/// mid-write, which must read as "not finished yet" rather than as success.
GifExitRecord parseGifExit(string text) @safe pure {
    GifExitRecord r;
    auto status = gifSpoolValue(text, "status");
    if (status.length == 0) return r;
    try r.status = status.to!int;
    catch (Exception) return r;
    r.present = true;
    auto err = gifSpoolValue(text, "error");
    if (err.length > 0) r.error = err;
    return r;
}

/// Fallback message for a worker exit status that carried no `error=` line.
/// SIGKILL (137, or a bare/negative signal number depending on the runtime)
/// is what the cgroup OOM killer leaves behind, and "exit 137" told the user
/// nothing actionable.
string gifExitMessage(int status) @safe pure {
    if (status == 137 || status == -9 || status == 9)
        return "Ran out of memory converting this video — try a shorter clip";
    if (status == 124 || status == 152 || status == -24)
        return "This video took too long to convert — try a shorter clip";
    if (status == 153 || status == -25)
        return "The converted GIF got too big — try a shorter clip";
    return "Video conversion failed (code " ~ status.to!string ~ ")";
}
