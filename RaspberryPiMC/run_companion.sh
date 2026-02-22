#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program"
BLE_BRIDGE="$SCRIPT_DIR/ble_nus_bridge.py"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Run: cp RaspberryPiMC/.env.example RaspberryPiMC/.env"
  exit 1
fi

if [[ ! -x "$BIN" ]]; then
  echo "Binary not found for RaspberryPiMC_native_companion. Building now..."
  platformio run --environment RaspberryPiMC_native_companion
fi

set -a
source "$ENV_FILE"
set +a

DATA_DIR="${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="$DATA_DIR"

BLE_PID=""
cleanup() {
  if [[ -n "$BLE_PID" ]]; then
    kill "$BLE_PID" >/dev/null 2>&1 || true
    wait "$BLE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "${RPI_COMPANION_BLE_ENABLE:-0}" == "1" ]]; then
  if [[ ! -f "$BLE_BRIDGE" ]]; then
    echo "Missing BLE bridge script: $BLE_BRIDGE"
    exit 1
  fi
  python3 "$BLE_BRIDGE" \
    --adapter "${RPI_COMPANION_BLE_ADAPTER:-hci0}" \
    --name "${RPI_COMPANION_BLE_NAME:-MeshCore}" \
    --tcp-host "${RPI_COMPANION_TCP_HOST:-127.0.0.1}" \
    --tcp-port "${RPI_COMPANION_TCP_PORT:-5000}" \
    >/tmp/meshcore-ble-bridge.log 2>&1 &
  BLE_PID="$!"
  sleep 0.2
fi

if [[ -n "$BLE_PID" ]]; then
  "$BIN" \
    "$@"
else
  exec "$BIN" \
    "$@"
fi
