#!/bin/sh
# IRC Fiber engine entrypoint.
#
# Ensures clean container state on every restart:
#   1. Kill any leftover irc-fiber-engine processes (defensive — Docker
#      should never leave them, but we've seen several accumulate in the
#      past).
#   2. Wait (<= 60 s) for the connection holder's Unix socket, so the
#      engine's first attach never races the holder container coming up.
#   3. exec the engine binary directly (replaces the shell so signals
#      reach the engine process and tini reports correct PID).
#
# This script is built into the engine image at /usr/local/bin and is
# the container's ENTRYPOINT in deploy/roles/engine/tasks/main.yml.

set -eu

ENGINE_BIN=/app/irc-fiber-engine

log() { printf '[engine-entrypoint] %s\n' "$*" >&2; }

# ── 1. Kill stale engine processes ───────────────────────────────────────
# pkill -f matches the full cmdline (`/app/irc-fiber-engine`). -x avoids
# matching tini itself.
STALE=$(pgrep -f irc-fiber-engine || true)
if [ -n "$STALE" ]; then
    log "Killing stale engine processes: $STALE"
    # shellcheck disable=SC2086
    kill $STALE 2>/dev/null || true
    # Give them 5s to exit gracefully, then SIGKILL stragglers.
    sleep 2
    REMAINING=$(pgrep -f irc-fiber-engine || true)
    if [ -n "$REMAINING" ]; then
        log "Force-killing stubborn processes: $REMAINING"
        # shellcheck disable=SC2086
        kill -9 $REMAINING 2>/dev/null || true
        sleep 1
    fi
fi

# ── 2. Wait for the connection holder socket ─────────────────────────────
# IRCFIBER_HOLDER_ADDR is unix:///run/ircfiber/holder.sock on docker (the
# holder volume, mounted read-only here). The engine itself retries the
# HELLO for IRCFIBER_HOLDER_CONNECT_TIMEOUT_SECS; this wait just keeps the
# boot log clean when the holder container is still starting. tcp://
# addresses (k8s) have nothing to wait for on the filesystem.
HOLDER_ADDR=${IRCFIBER_HOLDER_ADDR:-unix:///run/ircfiber/holder.sock}
case "$HOLDER_ADDR" in
    unix://*)
        HOLDER_SOCK=${HOLDER_ADDR#unix://}
        i=0
        while [ ! -S "$HOLDER_SOCK" ] && [ "$i" -lt 60 ]; do
            [ "$i" -eq 0 ] && log "Waiting for holder socket $HOLDER_SOCK"
            i=$((i + 1))
            sleep 1
        done
        if [ -S "$HOLDER_SOCK" ]; then
            log "Holder socket present after ${i}s"
        else
            log "Holder socket $HOLDER_SOCK still missing after 60s — starting anyway (engine retries the HELLO)"
        fi
        ;;
esac

# ── 3. Exec the engine ─────────────────────────────────────────────────
# `exec` replaces the shell so the engine becomes PID 1's child via
# tini — signals (SIGTERM/SIGINT) reach the engine cleanly, and the
# container's main PID matches the engine PID. This is critical for
# healthchecks and graceful shutdown.
log "Starting irc-fiber-engine ($ENGINE_BIN)"
exec "$ENGINE_BIN" "$@"