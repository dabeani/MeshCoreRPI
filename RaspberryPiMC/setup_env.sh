#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash RaspberryPiMC/setup_env.sh"
  exit 1
fi

bash "$REPO_ROOT/scripts/rpi/setup_waveshare_hat.sh" --no-reboot
bash "$REPO_ROOT/scripts/rpi/verify_waveshare_hat.sh"

mkdir -p "$SCRIPT_DIR/bin" "$SCRIPT_DIR/logs"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
fi

echo "RaspberryPiMC environment prepared in $SCRIPT_DIR"
echo "If SPI was newly enabled, reboot once before first run."
