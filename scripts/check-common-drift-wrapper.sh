#!/usr/bin/env bash
# Deprecated: use check-common-version.sh
echo "check-common-drift.sh is deprecated — use check-common-version.sh"
exec "$(dirname "$0")/check-common-version.sh" "$@"
