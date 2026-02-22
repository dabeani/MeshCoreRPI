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

source "$ENV_FILE"

DATA_DIR="${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="$DATA_DIR"

exec "$BIN" \
  --freq "${RPI_FREQ_HZ:-869525000}" \
  --sf "${RPI_SF:-11}" \
  --bw "${RPI_BW_HZ:-250000}" \
  --cr "${RPI_CR:-5}" \
  --tx "${RPI_TX_DBM:-22}" \
  --radio-driver "${RPI_RADIO_DRIVER:-sx1262}" \
  --spi-dev-prefix "${RPI_SPI_DEV_PREFIX:-/dev/spidev}" \
  --spi-bus "${RPI_SPI_BUS:-0}" \
  --spi-cs "${RPI_SPI_CS:-0}" \
  --spi-speed "${RPI_SPI_SPEED_HZ:-8000000}" \
  --reset-pin "${RPI_RESET_PIN:-18}" \
  --busy-pin "${RPI_BUSY_PIN:-20}" \
  --irq-pin "${RPI_IRQ_PIN:-16}" \
  --txen-pin "${RPI_TXEN_PIN:--1}" \
  --rxen-pin "${RPI_RXEN_PIN:--1}" \
  "$@"
