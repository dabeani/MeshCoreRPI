#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Run: cp RaspberryPiMC/.env.example RaspberryPiMC/.env"
  exit 1
fi

if [[ ! -x "$BIN" ]]; then
  echo "Binary not found for RaspberryPiMC_native_repeater. Building now..."
  platformio run --environment RaspberryPiMC_native_repeater
fi

set -a
source "$ENV_FILE"
set +a

DATA_DIR="${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="$DATA_DIR"

exec "$BIN" \
  "$@"
