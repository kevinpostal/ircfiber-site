#!/usr/bin/env bash
# check-common-version.sh — version-based drift check (replaces file-diff)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOP_VER=$(grep -E '^version' "/Users/zodiac/LocalWork/ircfiber/common/dub.sdl" | head -n1 | sed -E 's/.*"(.*)".*/\1/')
SITE_VER=$(grep -E '^version' "$ROOT/common/dub.sdl" | head -n1 | sed -E 's/.*"(.*)".*/\1/')
ENGINE_VER=$(grep -E '^version' "/Users/zodiac/LocalWork/ircfiber/engine/common/dub.sdl" | head -n1 | sed -E 's/.*"(.*)".*/\1/' || echo "unknown")
echo "top common version: $TOP_VER"
echo "site/common version: $SITE_VER"
echo "engine/common version: $ENGINE_VER"
if [ "$SITE_VER" != "$TOP_VER" ] || [ "$ENGINE_VER" != "$TOP_VER" ]; then
  echo "✗ version drift"
  exit 1
fi
SITE_DEP=$(grep -E 'dependency "irc-fiber-common"' "$ROOT/backend/dub.sdl" | sed -E 's/.*version="([^"]+)".*/\1/' | head -n1)
echo "site/backend dep: $SITE_DEP"
if [[ "$SITE_DEP" != *"$TOP_VER"* ]]; then
  echo "✗ site/backend dep $SITE_DEP != $TOP_VER"
  exit 1
fi
echo "✓ common versions in sync ($TOP_VER)"
