#!/usr/bin/env bash

set -euo pipefail

NO_REBOOT=0
SKIP_PACKAGES=0

for arg in "$@"; do
  case "$arg" in
    --no-reboot)
      NO_REBOOT=1
      ;;
    --skip-packages)
      SKIP_PACKAGES=1
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: sudo bash scripts/rpi/setup_waveshare_hat.sh [--no-reboot] [--skip-packages]"
      exit 1
      ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/rpi/setup_waveshare_hat.sh"
  exit 1
fi

if [[ -f "/boot/firmware/config.txt" ]]; then
  BOOT_CONFIG="/boot/firmware/config.txt"
elif [[ -f "/boot/config.txt" ]]; then
  BOOT_CONFIG="/boot/config.txt"
else
  echo "Unable to locate Raspberry Pi boot config (tried /boot/firmware/config.txt and /boot/config.txt)."
  exit 1
fi

ensure_line() {
  local line="$1"
  local file="$2"
  if ! grep -Fxq "$line" "$file"; then
    echo "$line" >> "$file"
    return 0
  fi
  return 1
}

echo "Configuring SPI in $BOOT_CONFIG ..."
changed=0

if ensure_line "dtparam=spi=on" "$BOOT_CONFIG"; then
  changed=1
fi

if [[ "$SKIP_PACKAGES" -eq 0 ]]; then
  echo "Installing required packages ..."
  apt-get update
  apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    libgpiod2 \
    gpiod \
    jq \
    curl
fi

TARGET_USER="${SUDO_USER:-}"
if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  usermod -a -G spi,gpio "$TARGET_USER" || true
  echo "Added $TARGET_USER to gpio/spi groups."
fi

echo
echo "Waveshare SX1262 defaults for Raspberry Pi 2/3/4:"
echo "  SPI bus:   0"
echo "  SPI CS:    0"
echo "  CS pin:    21"
echo "  Reset pin: 18"
echo "  Busy pin:  20"
echo "  IRQ pin:   16"

if [[ "$changed" -eq 1 ]]; then
  if [[ "$NO_REBOOT" -eq 1 ]]; then
    echo
    echo "SPI config changed. Reboot is required before using the radio."
  else
    echo
    echo "SPI config changed. Rebooting now ..."
    reboot
  fi
else
  echo
  echo "SPI already enabled."
fi
