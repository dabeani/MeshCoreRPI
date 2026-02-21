#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
mkdir -p "$OUT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This target is Linux-only (Raspberry Pi)."
  exit 1
fi

g++ -std=c++17 -O2 -Wall -Wextra \
  -I"$SCRIPT_DIR/include" \
  -I"$REPO_ROOT/src" \
  -I"$REPO_ROOT/src/helpers" \
  "$REPO_ROOT/src/Packet.cpp" \
  "$REPO_ROOT/src/Dispatcher.cpp" \
  "$REPO_ROOT/src/helpers/StaticPoolPacketManager.cpp" \
  "$SCRIPT_DIR/src/SX1262LinuxRadio.cpp" \
  "$SCRIPT_DIR/src/main.cpp" \
  -o "$OUT_DIR/meshcore-rpi-native"

echo "Built: $OUT_DIR/meshcore-rpi-native"
