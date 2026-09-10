#!/usr/bin/env bash
# sync-common.sh — push `site/common` (the source of truth for the shared D
# library) out to its mirrors: `engine/common` and the canonical `common`
# submodule of the superproject.
#
# Copies the package contract only — `source/`, `dub.sdl`,
# `dub.selections.json`. Build output (`libirc-fiber-common.a`, the
# `irc-fiber-common-test-unittest` binary) and each mirror's own `README.md`
# are left alone; a blanket `rsync -a` would drag ~11 MB of binaries into the
# other two repos and clobber the canonical README.
#
# Requires the superproject layout (mirrors are siblings of this repo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPER="$(cd "$ROOT/.." && pwd)"
FILES=(dub.sdl dub.selections.json)

targets=()
for t in "$SUPER/engine/common" "$SUPER/common"; do
  [ -d "$t" ] && targets+=("$t")
done

if [ "${#targets[@]}" -eq 0 ]; then
  echo "No mirrors under $SUPER — run this from the irc-fiber superproject checkout" >&2
  exit 1
fi

for t in "${targets[@]}"; do
  rsync -a --delete "$ROOT/common/source/" "$t/source/"
  for f in "${FILES[@]}"; do
    [ -f "$ROOT/common/$f" ] && cp "$ROOT/common/$f" "$t/$f"
  done
  echo "→ ${t#"$SUPER"/}"
done

echo ""
echo "Synced $(sed -nE 's/^version "(.*)"/\1/p' "$ROOT/common/dub.sdl") from site/common. Next:"
echo "  ./scripts/check-common-drift.sh --fetch   # site vs engine"
echo "  ./scripts/check-common-version.sh         # versions + dep specs"
echo "  commit common/ in each repo, then bump the superproject pins"
