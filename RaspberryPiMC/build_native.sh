#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

bash "$REPO_ROOT/host/rpi_native_cli/build.sh"
mkdir -p "$SCRIPT_DIR/bin"
cp "$REPO_ROOT/host/rpi_native_cli/out/meshcore-rpi-native" "$SCRIPT_DIR/bin/meshcore-rpi-native"

echo "Staged binary: $SCRIPT_DIR/bin/meshcore-rpi-native"
