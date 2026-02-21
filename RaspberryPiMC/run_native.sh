#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
BIN="$SCRIPT_DIR/bin/meshcore-rpi-native"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Run: cp RaspberryPiMC/.env.example RaspberryPiMC/.env"
  exit 1
fi

if [[ ! -x "$BIN" ]]; then
  echo "Missing binary: $BIN"
  echo "Run: bash RaspberryPiMC/build_native.sh"
  exit 1
fi

source "$ENV_FILE"

DATA_DIR="${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="$DATA_DIR"

exec "$BIN" \
  --freq "${RPI_FREQ_HZ:-869525000}" \
  --sf "${RPI_SF:-11}" \
  --bw "${RPI_BW_HZ:-250000}" \
  --cr "${RPI_CR:-5}" \
  --tx "${RPI_TX_DBM:-22}"
