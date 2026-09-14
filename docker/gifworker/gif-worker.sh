#!/bin/sh
# ircfiber GIF worker — the ONLY place untrusted user media is parsed.
#
# Why a sidecar: ffmpeg/ffprobe are a huge C attack surface driven entirely by
# attacker-supplied bytes (any logged-in user can upload a file). Running them
# inside the gateway container meant a decoder bug executed next to the
# gateway's Redis/Mongo credentials, its uploads volume (read-write) and its
# network namespace. This script runs in its own container with:
#   network_mode: none · read_only rootfs · cap_drop ALL · no-new-privileges
#   user 65534 · memory/cpu/pids caps · /uploads mounted READ-ONLY
# so the worst a decoder RCE gets is a throwaway process that cannot reach the
# network, cannot write to the uploads volume, and holds no credentials.
#
# IPC is a file spool on the shared /work volume — deliberately not Redis or
# HTTP, because a queue would force a network namespace back onto the sandbox.
#
# Spool protocol (all files live in $GIF_WORK_DIR):
#   <id>.job    gateway → worker. `key=value` lines, written to <id>.job.tmp
#               and renamed into place so the worker never sees a partial file:
#                 src=<basename in $GIF_SRC_DIR>   (server-generated name)
#                 out=<basename to create in $GIF_WORK_DIR>
#                 seconds=<max output duration>
#   <id>.claim  worker's atomic claim (renamed from <id>.job).
#   <id>.meta   duration_ms=<n>, format=<ffprobe format_name list>
#   <id>.p1     ffmpeg -progress stream of pass 1 (palette)
#   <id>.p2     ffmpeg -progress stream of pass 2 (encode)
#   <id>.<ext>  the finished GIF (name from `out=`)
#   <id>.exit   TERMINAL, written last: status=<n> [+ error=<text>]
#
# Usage:
#   gif-worker.sh                 daemon: poll $GIF_WORK_DIR forever
#   gif-worker.sh --once <id>     run exactly one already-spooled job
#                                 (the gateway's no-sidecar dev fallback)
set -u

WORK_DIR="${GIF_WORK_DIR:-/work}"
SRC_DIR="${GIF_SRC_DIR:-/uploads}"
POLL_SECONDS="${GIF_POLL_SECONDS:-0.25}"
# Wall-clock ceiling per pass. The output is capped at `seconds=`, so a pass
# that outruns this is stuck, not slow.
PASS_TIMEOUT="${GIF_PASS_TIMEOUT:-240}"
# Spool entries older than this are abandoned leftovers (gateway gone away).
STALE_MINUTES="${GIF_STALE_MINUTES:-30}"

# Container formats we are willing to hand to a decoder. Everything else is
# rejected BEFORE the decode passes — this is what keeps a file whose bytes
# are really an HLS/DASH/concat playlist from turning ffmpeg into a file-read
# or SSRF primitive, on top of the protocol whitelist below.
FORMAT_ALLOWLIST="mov mp4 m4a 3gp 3g2 mj2 matroska webm avi asf flv mpegts mpeg mpegvideo ogg webp webp_pipe gif"

# Only the local file protocol. Blocks http/tcp/udp/rtmp/concat/subfile/... so
# a crafted container cannot make ffmpeg open anything we did not hand it.
PROTOCOLS="file"

VF="fps=12,scale=w='min(480,iw)':h=-2:flags=lanczos"

log() { echo "[gif-worker] $*" >&2; }

# prlimit belongs to util-linux and may be absent on a dev box; the limits are
# defence in depth on top of the container's cgroup caps, so a missing binary
# degrades instead of failing the job.
if command -v prlimit >/dev/null 2>&1; then
    LIMIT="prlimit --as=2147483648 --cpu=180 --fsize=67108864 --nofile=256 --nproc=64 --"
else
    LIMIT=""
fi
if command -v timeout >/dev/null 2>&1; then
    DEADLINE="timeout -k 5 $PASS_TIMEOUT"
else
    DEADLINE=""
fi

# Server-generated names only: the gateway writes the uploads-relative
# basename it created itself. Anything with a slash, a leading dot or an
# unexpected character is a bug or an attack, never a real job.
safe_name() {
    case "$1" in
        ''|.*|*/*|*..*) return 1 ;;
    esac
    case "$1" in
        *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    [ "${#1}" -le 128 ]
}

# `key=value` lookup that ignores anything after the first `=` in the key.
spool_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }

finish() { # <id> <status> [error]
    _id=$1; _status=$2; _err=${3:-}
    {
        echo "status=$_status"
        [ -n "$_err" ] && echo "error=$_err"
    } > "$WORK_DIR/$_id.exit.tmp"
    mv -f "$WORK_DIR/$_id.exit.tmp" "$WORK_DIR/$_id.exit"
    rm -f "$WORK_DIR/$_id.claim"
}

format_allowed() { # <ffprobe format_name list, comma separated>
    _names=$(echo "$1" | tr ',' ' ')
    for _n in $_names; do
        for _a in $FORMAT_ALLOWLIST; do
            [ "$_n" = "$_a" ] && return 0
        done
    done
    return 1
}

run_job() { # <id>
    id=$1
    spec="$WORK_DIR/$id.claim"
    src=$(spool_get "$spec" src)
    out=$(spool_get "$spec" out)
    seconds=$(spool_get "$spec" seconds)
    case "$seconds" in ''|*[!0-9]*) seconds=30 ;; esac

    if ! safe_name "$src" || ! safe_name "$out"; then
        log "job $id: rejected names src=$src out=$out"
        finish "$id" 64 "Invalid conversion request"
        return
    fi
    srcPath="$SRC_DIR/$src"
    if [ ! -f "$srcPath" ]; then
        finish "$id" 66 "Source file is gone"
        return
    fi

    # ── probe ────────────────────────────────────────────────────────────
    # Runs in the sandbox like the decode passes: ffprobe parses the same
    # untrusted bytes.
    # `-nostdin` is an ffmpeg-only flag: ffprobe 4.4 rejects it outright
    # ("Option not found") and every probe fails closed as "not a video".
    probe=$($DEADLINE $LIMIT ffprobe -v error \
        -protocol_whitelist "$PROTOCOLS" \
        -show_entries format=duration,format_name \
        -of default=noprint_wrappers=1 "$srcPath" 2>"$WORK_DIR/$id.err")
    format=$(echo "$probe" | sed -n 's/^format_name=//p' | head -1)
    duration=$(echo "$probe" | sed -n 's/^duration=//p' | head -1)

    if [ -z "$format" ]; then
        finish "$id" 65 "Could not read this file as video"
        return
    fi
    if ! format_allowed "$format"; then
        log "job $id: rejected format $format"
        finish "$id" 65 "Unsupported media container ($format)"
        return
    fi

    # Duration in ms, clamped to the output cap — the gateway divides by this
    # for the percentage, so it must match what `-t` will actually produce.
    duration_ms=$(awk -v d="$duration" -v cap="$seconds" 'BEGIN{
        if (d+0 <= 0) { print 0; exit }
        if (d+0 > cap+0) d = cap
        printf "%d", d*1000
    }')
    printf 'duration_ms=%s\nformat=%s\n' "$duration_ms" "$format" > "$WORK_DIR/$id.meta.tmp"
    mv -f "$WORK_DIR/$id.meta.tmp" "$WORK_DIR/$id.meta"

    # ── pass 1: palette ──────────────────────────────────────────────────
    # `-t` sits BEFORE `-i` deliberately. As an output option it cannot
    # truncate a palette graph — palettegen emits nothing until EOF, so no
    # output timestamp ever reaches the cutoff and ffmpeg decodes the WHOLE
    # source. That is what OOM-killed a 4-minute upload (exit 137) before a
    # single byte was written. Input-side `-t` stops the demuxer instead.
    #
    # Two passes rather than one split[s0][s1] graph: in that graph paletteuse
    # holds every scaled frame until palettegen releases the palette at EOF —
    # 350 MB peak RSS for a 30 s clip against 58 MB for this form (measured).
    pal="$WORK_DIR/$id.pal.png"
    $DEADLINE $LIMIT ffmpeg -hide_banner -loglevel error -y -nostdin -nostats \
        -progress "$WORK_DIR/$id.p1" -stats_period 0.2 \
        -protocol_whitelist "$PROTOCOLS" \
        -t "$seconds" -i "$srcPath" \
        -vf "$VF,palettegen=stats_mode=diff" \
        -f image2 -update 1 "$pal" 2>"$WORK_DIR/$id.err"
    status=$?
    if [ $status -ne 0 ]; then
        log "job $id: palette pass failed ($status)"
        rm -f "$pal"
        finish "$id" "$status" ""
        return
    fi

    # ── pass 2: encode ───────────────────────────────────────────────────
    $DEADLINE $LIMIT ffmpeg -hide_banner -loglevel error -y -nostdin -nostats \
        -progress "$WORK_DIR/$id.p2" -stats_period 0.2 \
        -protocol_whitelist "$PROTOCOLS" \
        -t "$seconds" -i "$srcPath" -i "$pal" \
        -lavfi "$VF[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" \
        -loop 0 "$WORK_DIR/$out" 2>>"$WORK_DIR/$id.err"
    status=$?
    rm -f "$pal"
    if [ $status -ne 0 ]; then
        rm -f "$WORK_DIR/$out"
        log "job $id: encode pass failed ($status)"
        finish "$id" "$status" ""
        return
    fi
    finish "$id" 0 ""
}

sweep_stale() {
    find "$WORK_DIR" -maxdepth 1 -type f -mmin "+$STALE_MINUTES" \
        \( -name '*.job' -o -name '*.claim' -o -name '*.meta' -o -name '*.p1' \
           -o -name '*.p2' -o -name '*.err' -o -name '*.exit' -o -name '*.gif' \
           -o -name '*.pal.png' \) -delete 2>/dev/null
}

if [ "${1:-}" = "--once" ]; then
    id=${2:-}
    case "$id" in
        ''|*[!0-9a-zA-Z]*) log "--once needs a job id"; exit 2 ;;
    esac
    if ! mv "$WORK_DIR/$id.job" "$WORK_DIR/$id.claim" 2>/dev/null; then
        log "no spooled job $id"
        exit 2
    fi
    run_job "$id"
    exit 0
fi

log "watching $WORK_DIR (src=$SRC_DIR, limits='${LIMIT:-none}')"
sweep_ticks=0
while :; do
    claimed=0
    for spec in "$WORK_DIR"/*.job; do
        [ -f "$spec" ] || continue
        id=$(basename "$spec" .job)
        case "$id" in
            ''|*[!0-9a-zA-Z]*) log "ignoring $spec"; rm -f "$spec"; continue ;;
        esac
        # Atomic claim: whoever wins the rename owns the job.
        mv "$spec" "$WORK_DIR/$id.claim" 2>/dev/null || continue
        claimed=1
        run_job "$id"
    done
    sweep_ticks=$((sweep_ticks + 1))
    if [ $sweep_ticks -ge 240 ]; then
        sweep_ticks=0
        sweep_stale
    fi
    [ $claimed -eq 1 ] || sleep "$POLL_SECONDS"
done
