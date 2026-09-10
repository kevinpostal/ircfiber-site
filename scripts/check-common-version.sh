#!/usr/bin/env bash
# check-common-version.sh — version-based drift check (replaces file-diff)
# Paths resolve relative to this repo, so it works in a lone `ircfiber-site`
# checkout (peers absent -> skipped) and in the `irc-fiber` superproject
# (peers = ../common and ../engine/common -> compared).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPER="$(cd "$ROOT/.." && pwd)"

ver() { grep -E '^version' "$1" | head -n1 | sed -E 's/.*"(.*)".*/\1/'; }

SITE_VER=$(ver "$ROOT/common/dub.sdl")
echo "site/common version: $SITE_VER"

rc=0
for peer in "common" "engine/common"; do
  sdl="$SUPER/$peer/dub.sdl"
  if [ ! -f "$sdl" ]; then
    echo "$peer: not in this checkout — skipped"
    continue
  fi
  peer_ver=$(ver "$sdl")
  echo "$peer version: $peer_ver"
  if [ "$peer_ver" != "$SITE_VER" ]; then
    echo "✗ version drift: $peer $peer_ver != site/common $SITE_VER"
    rc=1
  fi
done

SITE_DEP=$(grep -E 'dependency "irc-fiber-common"' "$ROOT/backend/dub.sdl" | sed -E 's/.*version="([^"]+)".*/\1/' | head -n1)
echo "site/backend dep: $SITE_DEP"
if [[ "$SITE_DEP" != *"$SITE_VER"* ]]; then
  echo "✗ site/backend dep $SITE_DEP != $SITE_VER"
  rc=1
fi

[ "$rc" -eq 0 ] && echo "✓ common versions in sync ($SITE_VER)"
exit "$rc"
