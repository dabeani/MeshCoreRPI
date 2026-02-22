#!/usr/bin/env bash

set -euo pipefail

ROLE="${1:-}"
BIN_PATH="${2:-}"

if [[ "$ROLE" != "repeater" && "$ROLE" != "companion" ]]; then
  echo "Usage: bash RaspberryPiMC/build_deb.sh <repeater|companion> [binary-path]"
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "DEB packaging is Linux-only."
  exit 0
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb not found. Install: sudo apt-get install dpkg-dev"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
mkdir -p "$DIST_DIR"

if [[ -z "$BIN_PATH" ]]; then
  if [[ "$ROLE" == "repeater" ]]; then
    platformio run --environment RaspberryPiMC_native_repeater
    BIN_PATH="$REPO_ROOT/.pio/build/RaspberryPiMC_native_repeater/program"
  else
    platformio run --environment RaspberryPiMC_native_companion
    BIN_PATH="$REPO_ROOT/.pio/build/RaspberryPiMC_native_companion/program"
  fi
fi

if [[ ! -f "$BIN_PATH" ]]; then
  echo "Binary not found: $BIN_PATH"
  exit 1
fi

ARCH="$(dpkg --print-architecture)"
VERSION_BASE="0.1.0"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nosha)"
PKG_VERSION="${VERSION_BASE}+${GIT_SHA}"
PKG_NAME="raspberrypimc-native-${ROLE}"
PKG_ROOT="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_${ARCH}"

rm -rf "$PKG_ROOT"
mkdir -p \
  "$PKG_ROOT/DEBIAN" \
  "$PKG_ROOT/usr/lib/raspberrypimc/${ROLE}" \
  "$PKG_ROOT/usr/bin" \
  "$PKG_ROOT/etc/raspberrypimc" \
  "$PKG_ROOT/lib/systemd/system"

cp "$BIN_PATH" "$PKG_ROOT/usr/lib/raspberrypimc/${ROLE}/program"
chmod 0755 "$PKG_ROOT/usr/lib/raspberrypimc/${ROLE}/program"

if [[ "$ROLE" == "companion" ]]; then
  BLE_SRC=""
  if [[ -f "$SCRIPT_DIR/ble_nus_bridge.py" ]]; then
    BLE_SRC="$SCRIPT_DIR/ble_nus_bridge.py"
  elif [[ -f "$SCRIPT_DIR/dist/meshcore-rpi-portable/ble_nus_bridge.py" ]]; then
    BLE_SRC="$SCRIPT_DIR/dist/meshcore-rpi-portable/ble_nus_bridge.py"
  fi

  if [[ -n "$BLE_SRC" ]]; then
    cp "$BLE_SRC" "$PKG_ROOT/usr/lib/raspberrypimc/${ROLE}/ble_nus_bridge.py"
    chmod 0755 "$PKG_ROOT/usr/lib/raspberrypimc/${ROLE}/ble_nus_bridge.py"
  else
    echo "Warning: ble_nus_bridge.py not found; companion package built without BLE bridge script."
    echo "         BLE mode (RPI_COMPANION_BLE_ENABLE=1) will not work until script is installed."
  fi
fi

cat > "$PKG_ROOT/usr/bin/raspberrypimc-${ROLE}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE=/etc/raspberrypimc/${ROLE}.env
BIN=/usr/lib/raspberrypimc/${ROLE}/program
if [[ -f "\$ENV_FILE" ]]; then
  set -a
  source "\$ENV_FILE"
  set +a
fi

DATA_DIR="\${RPI_DATA_DIR:-/var/lib/raspberrypimc/userdata}"
mkdir -p "\$DATA_DIR" >/dev/null 2>&1 || true
export MESHCORE_DATA_DIR="\$DATA_DIR"

if [[ "${ROLE}" == "companion" ]]; then
  BLE_BRIDGE=/usr/lib/raspberrypimc/companion/ble_nus_bridge.py
  BLE_PID=""
  cleanup() {
    if [[ -n "\$BLE_PID" ]]; then
      kill "\$BLE_PID" >/dev/null 2>&1 || true
      wait "\$BLE_PID" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT INT TERM
  if [[ "\${RPI_COMPANION_BLE_ENABLE:-0}" == "1" ]]; then
    python3 "\$BLE_BRIDGE" \
      --adapter "\${RPI_COMPANION_BLE_ADAPTER:-hci0}" \
      --name "\${RPI_COMPANION_BLE_NAME:-MeshCore}" \
      --tcp-host "\${RPI_COMPANION_TCP_HOST:-127.0.0.1}" \
      --tcp-port "\${RPI_COMPANION_TCP_PORT:-5000}" \
      >/var/log/raspberrypimc-companion-ble.log 2>&1 &
    BLE_PID="\$!"
    sleep 0.2
  fi
fi

if [[ "${ROLE}" == "companion" && -n "\${BLE_PID:-}" ]]; then
  "$BIN" "$@"
elif [[ "${ROLE}" == "companion" ]]; then
  exec "$BIN" "$@"
else
  exec "$BIN" "$@"
fi
EOF
chmod 0755 "$PKG_ROOT/usr/bin/raspberrypimc-${ROLE}"

if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$PKG_ROOT/etc/raspberrypimc/${ROLE}.env"
else
  cat > "$PKG_ROOT/etc/raspberrypimc/${ROLE}.env" <<EOF
RPI_FREQ_HZ=869525000
RPI_SF=11
RPI_BW_HZ=250000
RPI_CR=5
RPI_TX_DBM=22
RPI_RADIO_DRIVER=sx1262
RPI_DATA_DIR=/var/lib/raspberrypimc/userdata
RPI_SPI_DEV_PREFIX=/dev/spidev
RPI_SPI_BUS=0
RPI_SPI_CS=0
RPI_CS_PIN=21
RPI_SPI_SPEED_HZ=8000000
RPI_RESET_PIN=18
RPI_BUSY_PIN=20
RPI_IRQ_PIN=16
RPI_TXEN_PIN=-1
RPI_RXEN_PIN=-1
RPI_USE_TCXO=0
RPI_USE_DIO2_RF=0
EOF
fi
chmod 0644 "$PKG_ROOT/etc/raspberrypimc/${ROLE}.env"

cat > "$PKG_ROOT/lib/systemd/system/raspberrypimc-${ROLE}.service" <<EOF
[Unit]
Description=RaspberryPiMC Native ${ROLE^}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/raspberrypimc-${ROLE}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "$PKG_ROOT/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Section: net
Priority: optional
Architecture: ${ARCH}
Maintainer: MeshCore RaspberryPiMC
Depends: libc6, systemd$(if [[ "$ROLE" == "companion" ]]; then echo ', python3, python3-dbus, python3-gi, bluez'; fi)
Description: RaspberryPiMC native MeshCore ${ROLE} runtime
 Native MeshCore runtime package for Raspberry Pi using Waveshare SX1262 HAT.
EOF

cat > "$PKG_ROOT/DEBIAN/postinst" <<EOF
#!/usr/bin/env bash
set -e
if ! id -u raspberrypimc >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin raspberrypimc || true
fi
mkdir -p /var/lib/raspberrypimc/userdata || true
chown -R raspberrypimc:raspberrypimc /var/lib/raspberrypimc || true
chown -R raspberrypimc:raspberrypimc /etc/raspberrypimc || true
systemctl daemon-reload || true
systemctl enable raspberrypimc-${ROLE}.service || true
EOF

cat > "$PKG_ROOT/DEBIAN/prerm" <<EOF
#!/usr/bin/env bash
set -e
systemctl disable raspberrypimc-${ROLE}.service >/dev/null 2>&1 || true
systemctl stop raspberrypimc-${ROLE}.service >/dev/null 2>&1 || true
EOF

chmod 0755 "$PKG_ROOT/DEBIAN/postinst" "$PKG_ROOT/DEBIAN/prerm"

OUT_DEB="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"
dpkg-deb --build "$PKG_ROOT" "$OUT_DEB"

echo "Built package: $OUT_DEB"
