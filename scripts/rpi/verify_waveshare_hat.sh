#!/usr/bin/env bash

set -euo pipefail

errors=0

echo "Checking Raspberry Pi SPI device nodes ..."
if [[ -e "/dev/spidev0.0" || -e "/dev/spidev0.1" ]]; then
  ls -l /dev/spidev0.* 2>/dev/null || true
else
  echo "ERROR: No /dev/spidev0.x devices found."
  errors=$((errors + 1))
fi

echo
echo "Checking boot SPI setting ..."
if [[ -f "/boot/firmware/config.txt" ]]; then
  CFG="/boot/firmware/config.txt"
elif [[ -f "/boot/config.txt" ]]; then
  CFG="/boot/config.txt"
else
  CFG=""
fi

if [[ -n "$CFG" ]] && grep -q '^dtparam=spi=on' "$CFG"; then
  echo "OK: dtparam=spi=on found in $CFG"
else
  echo "ERROR: dtparam=spi=on not found in Raspberry Pi config."
  errors=$((errors + 1))
fi

echo
echo "Checking GPIO tooling ..."
if command -v gpioinfo >/dev/null 2>&1; then
  echo "OK: gpioinfo installed"
else
  echo "ERROR: gpioinfo not found (install package: gpiod)."
  errors=$((errors + 1))
fi

echo
if [[ "$errors" -eq 0 ]]; then
  echo "Verification passed: Raspberry Pi is ready for Waveshare SX1262 HAT usage."
  exit 0
fi

echo "Verification failed with $errors issue(s)."
exit 1
