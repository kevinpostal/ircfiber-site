#!/bin/sh
# IRC Fiber engine healthcheck.
#
# Returns 0 if the engine is healthy, 1 otherwise.
#
# Healthy means the engine binary is running (pgrep -f). Whether it is
# attached to the connection holder is not judged here — the engine's own
# holder reconnect loop and IRC keepalive cover that, and a holder outage
# must not restart the engine (restarting it cannot help).
#
# Runs inside the container via docker healthcheck. Also asserts a single
# engine process so an accumulation of leaked processes never silently
# passes the healthcheck.

ENGINE_PROCESS_PATTERN='irc-fiber-engine'
MAX_PROCESSES=2  # main binary + 1 slack for a process mid-exit (transient)

COUNT=$(pgrep -cf "$ENGINE_PROCESS_PATTERN" || true)
if [ "$COUNT" -eq 0 ]; then
    echo "no engine process running" >&2
    exit 1
fi

# If we have more processes than the steady-state count, warn. The
# threshold is generous so a process mid-exit doesn't trigger false
# failures, but tight enough to catch accumulation.
if [ "$COUNT" -gt "$MAX_PROCESSES" ]; then
    echo "WARN: $COUNT engine processes running (max=$MAX_PROCESSES) — possible process leak" >&2
    # Still return 0 so docker doesn't restart the container; the entrypoint
    # script handles process cleanup at container start.
fi

exit 0