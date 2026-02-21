#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Native CLI target is Linux-only (Raspberry Pi)."
  exit 1
fi

bash "$REPO_ROOT/host/rpi_native_cli/build.sh"
exec "$REPO_ROOT/host/rpi_native_cli/out/meshcore-rpi-native" "$@"
