#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"
WEB_BRIDGE="$SCRIPT_DIR/webgui/companion_webgui.py"

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

export RPI_CONFIG_FILE="${RPI_CONFIG_FILE:-$ENV_FILE}"

DATA_DIR="${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="$DATA_DIR"

WEB_PID=""
cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "${RPI_REPEATER_WEB_ENABLE:-1}" == "1" ]]; then
  if [[ ! -f "$WEB_BRIDGE" ]]; then
    echo "Missing repeater web GUI script: $WEB_BRIDGE"
    exit 1
  fi

  WEB_HOST="${RPI_REPEATER_WEB_HOST:-0.0.0.0}"
  WEB_PORT="${RPI_REPEATER_WEB_PORT:-8081}"
  REPEATER_TCP_HOST="${RPI_REPEATER_TCP_HOST:-127.0.0.1}"
  REPEATER_TCP_PORT="${RPI_REPEATER_TCP_PORT:-5001}"

  echo "[run_repeater] starting Web GUI on ${WEB_HOST}:${WEB_PORT} (repeater bridge ${REPEATER_TCP_HOST}:${REPEATER_TCP_PORT})"

  python3 "$WEB_BRIDGE" \
    --role repeater \
    --repeater-host "$REPEATER_TCP_HOST" \
    --repeater-port "$REPEATER_TCP_PORT" \
    --bind-host "$WEB_HOST" \
    --bind-port "$WEB_PORT" \
    >/tmp/meshcore-repeater-web.log 2>&1 &
  WEB_PID="$!"
  sleep 0.4
  if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then
    echo "[run_repeater] repeater Web GUI failed to start. Log:"
    cat /tmp/meshcore-repeater-web.log || true
    exit 1
  fi
fi

if [[ -n "$WEB_PID" ]]; then
  "$BIN" \
    "$@"
else
  exec "$BIN" \
    "$@"
fi
