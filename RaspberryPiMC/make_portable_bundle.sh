#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
BUNDLE_DIR="$DIST_DIR/meshcore-rpi-portable"
OUT_TGZ="$DIST_DIR/meshcore-rpi-portable.tar.gz"
FORCE=0
SKIP_BUILD=0
REPEATER_BIN=""
COMPANION_BIN=""

usage() {
  cat <<'EOF'
Usage:
  bash RaspberryPiMC/make_portable_bundle.sh [--force] [--skip-build] \
    [--repeater-bin /path/to/repeater] [--companion-bin /path/to/companion]

Behavior:
  - If PlatformIO exists and --skip-build is not set, builds both native role binaries.
  - If PlatformIO is missing, uses existing binaries from common locations.
  - You can always pass explicit binary paths via --repeater-bin/--companion-bin.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --repeater-bin)
      REPEATER_BIN="${2:-}"
      shift 2
      ;;
    --companion-bin)
      COMPANION_BIN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

if [[ "$HOST_OS" != "Linux" && "$FORCE" -ne 1 ]]; then
  echo "Error: portable Raspberry Pi bundle must be built on Linux (current: $HOST_OS)."
  echo "Reason: native PlatformIO binaries are host-specific (macOS binaries do not run on Raspberry Pi Linux)."
  echo "If you really want to bypass this check, run: bash RaspberryPiMC/make_portable_bundle.sh --force"
  exit 1
fi

if [[ "$HOST_ARCH" != "aarch64" && "$HOST_ARCH" != arm* && "$FORCE" -ne 1 ]]; then
  echo "Error: portable Raspberry Pi bundle should be built on ARM Linux (current arch: $HOST_ARCH)."
  echo "For Raspberry Pi 64-bit use an aarch64 builder (or run this script on the Pi)."
  echo "If you really want to bypass this check, run: bash RaspberryPiMC/make_portable_bundle.sh --force"
  exit 1
fi

mkdir -p "$DIST_DIR"

if [[ -z "$REPEATER_BIN" ]]; then
  if [[ -x "$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program" ]]; then
    REPEATER_BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"
  elif [[ -x "/usr/lib/raspberrypimc/repeater/program" ]]; then
    REPEATER_BIN="/usr/lib/raspberrypimc/repeater/program"
  fi
fi

if [[ -z "$COMPANION_BIN" ]]; then
  if [[ -x "$REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program" ]]; then
    COMPANION_BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program"
  elif [[ -x "/usr/lib/raspberrypimc/companion/program" ]]; then
    COMPANION_BIN="/usr/lib/raspberrypimc/companion/program"
  fi
fi

if [[ "$SKIP_BUILD" -eq 0 ]] && command -v platformio >/dev/null 2>&1; then
  echo "Building native role binaries with PlatformIO..."
  platformio run --environment RaspberryPiMC_native_repeater
  platformio run --environment RaspberryPiMC_native_companion

  REPEATER_BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"
  COMPANION_BIN="$REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program"
elif [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "PlatformIO not found, skipping build and using existing binaries."
fi

if [[ ! -x "$REPEATER_BIN" || ! -x "$COMPANION_BIN" ]]; then
  echo "Could not find usable repeater/companion binaries."
  echo "Tried defaults:"
  echo "  $REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"
  echo "  $REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program"
  echo "  /usr/lib/raspberrypimc/repeater/program"
  echo "  /usr/lib/raspberrypimc/companion/program"
  echo "Provide explicit paths, for example:"
  echo "  bash RaspberryPiMC/make_portable_bundle.sh --skip-build --repeater-bin /path/repeater --companion-bin /path/companion"
  exit 1
fi

echo "Using repeater binary: $REPEATER_BIN"
echo "Using companion binary: $COMPANION_BIN"

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

cp "$SCRIPT_DIR/meshcore_pi_menu.sh" "$BUNDLE_DIR/meshcore_pi_menu.sh"
cp "$REPEATER_BIN" "$BUNDLE_DIR/meshcore-repeater"
cp "$COMPANION_BIN" "$BUNDLE_DIR/meshcore-companion"
cp "$SCRIPT_DIR/ble_nus_bridge.py" "$BUNDLE_DIR/ble_nus_bridge.py"
cp "$SCRIPT_DIR/.env.example" "$BUNDLE_DIR/meshcore.env.example"

cat > "$BUNDLE_DIR/BUNDLE_INFO" <<EOF
BUILD_OS=$HOST_OS
BUILD_ARCH=$HOST_ARCH
BUILD_TIME_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

chmod +x "$BUNDLE_DIR/meshcore_pi_menu.sh" "$BUNDLE_DIR/meshcore-repeater" "$BUNDLE_DIR/meshcore-companion"

cat > "$BUNDLE_DIR/README_PORTABLE.txt" <<'EOF'
MeshCore Raspberry Pi portable bundle

Files:
- meshcore_pi_menu.sh      interactive launcher/config menu
- meshcore-repeater        repeater executable
- meshcore-companion       companion executable
- ble_nus_bridge.py        BLE bridge helper
- meshcore.env.example     config reference

Run on Raspberry Pi:
1) Copy this whole folder to the Pi
2) cd into the folder
3) chmod +x meshcore_pi_menu.sh meshcore-repeater meshcore-companion
4) ./meshcore_pi_menu.sh
EOF

rm -f "$OUT_TGZ"
tar -czf "$OUT_TGZ" -C "$DIST_DIR" "meshcore-rpi-portable"

echo "Portable folder: $BUNDLE_DIR"
echo "Portable archive: $OUT_TGZ"
