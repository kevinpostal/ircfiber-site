# common — source of truth, mirrored from ircfiber-common

This `common/` is the source of truth, mirrored in `engine/common` and the canonical `kevinpostal/ircfiber-common` repo (dub package `irc-fiber-common`, tagged `common-v0.3.x`).
Sync with `site/scripts/sync-common.sh` (copies `source/` + `dub.sdl` only). Guards: `site/scripts/check-common-drift.sh --fetch` fails CI on drift; `site/scripts/check-common-version.sh` checks version + dep strings (`~>0.3.1`).
