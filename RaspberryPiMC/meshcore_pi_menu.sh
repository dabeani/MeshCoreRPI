#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="$SCRIPT_DIR/meshcore.conf"
REPEATER_BIN="$SCRIPT_DIR/meshcore-repeater"
COMPANION_BIN="$SCRIPT_DIR/meshcore-companion"
BLE_BRIDGE="$SCRIPT_DIR/ble_nus_bridge.py"
BUNDLE_INFO="$SCRIPT_DIR/BUNDLE_INFO"

RPI_FREQ_HZ="869525000"
RPI_SF="11"
RPI_BW_HZ="250000"
RPI_CR="5"
RPI_TX_DBM="22"
RPI_DATA_DIR="/var/lib/raspberrypimc/userdata"
RPI_SPI_DEV_PREFIX="/dev/spidev"
RPI_SPI_BUS="0"
RPI_SPI_CS="0"
RPI_SPI_SPEED_HZ="8000000"
RPI_RESET_PIN="18"
RPI_BUSY_PIN="20"
RPI_IRQ_PIN="16"
RPI_TXEN_PIN="-1"
RPI_RXEN_PIN="-1"
RPI_COMPANION_TCP_HOST="127.0.0.1"
RPI_COMPANION_TCP_PORT="5000"
RPI_COMPANION_BLE_ENABLE="0"
RPI_COMPANION_BLE_ADAPTER="hci0"
RPI_COMPANION_BLE_NAME="MeshCore"

BLE_PID=""

load_conf() {
  if [[ -f "$CONF_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONF_FILE"
  fi
}

save_conf() {
  cat > "$CONF_FILE" <<EOF
RPI_FREQ_HZ=$RPI_FREQ_HZ
RPI_SF=$RPI_SF
RPI_BW_HZ=$RPI_BW_HZ
RPI_CR=$RPI_CR
RPI_TX_DBM=$RPI_TX_DBM
RPI_DATA_DIR=$RPI_DATA_DIR
RPI_SPI_DEV_PREFIX=$RPI_SPI_DEV_PREFIX
RPI_SPI_BUS=$RPI_SPI_BUS
RPI_SPI_CS=$RPI_SPI_CS
RPI_SPI_SPEED_HZ=$RPI_SPI_SPEED_HZ
RPI_RESET_PIN=$RPI_RESET_PIN
RPI_BUSY_PIN=$RPI_BUSY_PIN
RPI_IRQ_PIN=$RPI_IRQ_PIN
RPI_TXEN_PIN=$RPI_TXEN_PIN
RPI_RXEN_PIN=$RPI_RXEN_PIN
RPI_COMPANION_TCP_HOST=$RPI_COMPANION_TCP_HOST
RPI_COMPANION_TCP_PORT=$RPI_COMPANION_TCP_PORT
RPI_COMPANION_BLE_ENABLE=$RPI_COMPANION_BLE_ENABLE
RPI_COMPANION_BLE_ADAPTER=$RPI_COMPANION_BLE_ADAPTER
RPI_COMPANION_BLE_NAME=$RPI_COMPANION_BLE_NAME
EOF
  echo "Saved config: $CONF_FILE"
}

prompt_value() {
  local key="$1"
  local current="$2"
  local prompt="$3"
  local input
  read -r -p "$prompt [$current]: " input
  if [[ -n "$input" ]]; then
    printf '%s' "$input"
  else
    printf '%s' "$current"
  fi
}

configure_values() {
  echo
  echo "Configure runtime values (press Enter to keep current)"
  RPI_FREQ_HZ="$(prompt_value RPI_FREQ_HZ "$RPI_FREQ_HZ" "LoRa frequency (Hz)")"
  RPI_SF="$(prompt_value RPI_SF "$RPI_SF" "LoRa SF")"
  RPI_BW_HZ="$(prompt_value RPI_BW_HZ "$RPI_BW_HZ" "LoRa bandwidth (Hz)")"
  RPI_CR="$(prompt_value RPI_CR "$RPI_CR" "LoRa coding rate")"
  RPI_TX_DBM="$(prompt_value RPI_TX_DBM "$RPI_TX_DBM" "TX power (dBm)")"
  RPI_DATA_DIR="$(prompt_value RPI_DATA_DIR "$RPI_DATA_DIR" "Data directory")"
  RPI_SPI_DEV_PREFIX="$(prompt_value RPI_SPI_DEV_PREFIX "$RPI_SPI_DEV_PREFIX" "SPI device prefix")"
  RPI_SPI_BUS="$(prompt_value RPI_SPI_BUS "$RPI_SPI_BUS" "SPI bus")"
  RPI_SPI_CS="$(prompt_value RPI_SPI_CS "$RPI_SPI_CS" "SPI chip-select")"
  RPI_SPI_SPEED_HZ="$(prompt_value RPI_SPI_SPEED_HZ "$RPI_SPI_SPEED_HZ" "SPI speed (Hz)")"
  RPI_RESET_PIN="$(prompt_value RPI_RESET_PIN "$RPI_RESET_PIN" "SX1262 reset GPIO")"
  RPI_BUSY_PIN="$(prompt_value RPI_BUSY_PIN "$RPI_BUSY_PIN" "SX1262 busy GPIO")"
  RPI_IRQ_PIN="$(prompt_value RPI_IRQ_PIN "$RPI_IRQ_PIN" "SX1262 IRQ GPIO")"
  RPI_TXEN_PIN="$(prompt_value RPI_TXEN_PIN "$RPI_TXEN_PIN" "SX1262 TXEN GPIO (-1 disable)")"
  RPI_RXEN_PIN="$(prompt_value RPI_RXEN_PIN "$RPI_RXEN_PIN" "SX1262 RXEN GPIO (-1 disable)")"
  RPI_COMPANION_TCP_HOST="$(prompt_value RPI_COMPANION_TCP_HOST "$RPI_COMPANION_TCP_HOST" "Companion TCP host")"
  RPI_COMPANION_TCP_PORT="$(prompt_value RPI_COMPANION_TCP_PORT "$RPI_COMPANION_TCP_PORT" "Companion TCP port")"
  RPI_COMPANION_BLE_ADAPTER="$(prompt_value RPI_COMPANION_BLE_ADAPTER "$RPI_COMPANION_BLE_ADAPTER" "BLE adapter")"
  RPI_COMPANION_BLE_NAME="$(prompt_value RPI_COMPANION_BLE_NAME "$RPI_COMPANION_BLE_NAME" "BLE device name")"

  local ble_in
  read -r -p "Enable BLE bridge by default? (0/1) [$RPI_COMPANION_BLE_ENABLE]: " ble_in
  if [[ "$ble_in" == "0" || "$ble_in" == "1" ]]; then
    RPI_COMPANION_BLE_ENABLE="$ble_in"
  fi

  save_conf
}

show_values() {
  echo
  echo "Current config"
  echo "  RPI_FREQ_HZ=$RPI_FREQ_HZ"
  echo "  RPI_SF=$RPI_SF"
  echo "  RPI_BW_HZ=$RPI_BW_HZ"
  echo "  RPI_CR=$RPI_CR"
  echo "  RPI_TX_DBM=$RPI_TX_DBM"
  echo "  RPI_DATA_DIR=$RPI_DATA_DIR"
  echo "  RPI_SPI_DEV_PREFIX=$RPI_SPI_DEV_PREFIX"
  echo "  RPI_SPI_BUS=$RPI_SPI_BUS"
  echo "  RPI_SPI_CS=$RPI_SPI_CS"
  echo "  RPI_SPI_SPEED_HZ=$RPI_SPI_SPEED_HZ"
  echo "  RPI_RESET_PIN=$RPI_RESET_PIN"
  echo "  RPI_BUSY_PIN=$RPI_BUSY_PIN"
  echo "  RPI_IRQ_PIN=$RPI_IRQ_PIN"
  echo "  RPI_TXEN_PIN=$RPI_TXEN_PIN"
  echo "  RPI_RXEN_PIN=$RPI_RXEN_PIN"
  echo "  RPI_COMPANION_TCP_HOST=$RPI_COMPANION_TCP_HOST"
  echo "  RPI_COMPANION_TCP_PORT=$RPI_COMPANION_TCP_PORT"
  echo "  RPI_COMPANION_BLE_ENABLE=$RPI_COMPANION_BLE_ENABLE"
  echo "  RPI_COMPANION_BLE_ADAPTER=$RPI_COMPANION_BLE_ADAPTER"
  echo "  RPI_COMPANION_BLE_NAME=$RPI_COMPANION_BLE_NAME"
}

prepare_runtime() {
  mkdir -p "$RPI_DATA_DIR" >/dev/null 2>&1 || true
  export MESHCORE_DATA_DIR="$RPI_DATA_DIR"
}

cleanup() {
  if [[ -n "$BLE_PID" ]]; then
    kill "$BLE_PID" >/dev/null 2>&1 || true
    wait "$BLE_PID" >/dev/null 2>&1 || true
    BLE_PID=""
  fi
}

check_binary_compat() {
  local bin="$1"
  local role="$2"

  if [[ ! -x "$bin" ]]; then
    echo "Missing executable: $bin"
    return 1
  fi

  local runtime_os runtime_arch
  runtime_os="$(uname -s)"
  runtime_arch="$(uname -m)"

  if [[ -f "$BUNDLE_INFO" ]]; then
    # shellcheck disable=SC1090
    source "$BUNDLE_INFO"
    if [[ "${BUILD_OS:-}" != "$runtime_os" || "${BUILD_ARCH:-}" != "$runtime_arch" ]]; then
      echo "Binary bundle mismatch for $role: built on ${BUILD_OS:-unknown}/${BUILD_ARCH:-unknown}, running on $runtime_os/$runtime_arch"
      echo "Create bundle on Linux ARM (aarch64) for this Raspberry Pi, then copy it again."
      return 1
    fi
  fi

  if command -v file >/dev/null 2>&1; then
    local info
    info="$(file "$bin")"
    if [[ "$runtime_os" == "Linux" && "$info" != *"ELF"* ]]; then
      echo "Binary format mismatch for $role: $info"
      echo "Expected a Linux ELF binary. Rebuild bundle on Linux ARM (aarch64)."
      return 1
    fi
    if [[ "$runtime_arch" == "aarch64" && "$info" != *"aarch64"* && "$info" != *"ARM aarch64"* ]]; then
      echo "Binary architecture mismatch for $role: $info"
      echo "Expected aarch64 binary for this Raspberry Pi."
      return 1
    fi
  fi

  return 0
}

run_repeater() {
  if ! check_binary_compat "$REPEATER_BIN" "repeater"; then
    return 1
  fi
  prepare_runtime
  exec "$REPEATER_BIN" \
    --freq "$RPI_FREQ_HZ" \
    --sf "$RPI_SF" \
    --bw "$RPI_BW_HZ" \
    --cr "$RPI_CR" \
    --tx "$RPI_TX_DBM" \
    --spi-dev-prefix "$RPI_SPI_DEV_PREFIX" \
    --spi-bus "$RPI_SPI_BUS" \
    --spi-cs "$RPI_SPI_CS" \
    --spi-speed "$RPI_SPI_SPEED_HZ" \
    --reset-pin "$RPI_RESET_PIN" \
    --busy-pin "$RPI_BUSY_PIN" \
    --irq-pin "$RPI_IRQ_PIN" \
    --txen-pin "$RPI_TXEN_PIN" \
    --rxen-pin "$RPI_RXEN_PIN"
}

run_companion() {
  local with_ble="$1"
  if ! check_binary_compat "$COMPANION_BIN" "companion"; then
    return 1
  fi

  prepare_runtime

  if [[ "$with_ble" == "1" ]]; then
    if [[ ! -f "$BLE_BRIDGE" ]]; then
      echo "Missing BLE bridge script: $BLE_BRIDGE"
      return 1
    fi
    python3 "$BLE_BRIDGE" \
      --adapter "$RPI_COMPANION_BLE_ADAPTER" \
      --name "$RPI_COMPANION_BLE_NAME" \
      --tcp-host "$RPI_COMPANION_TCP_HOST" \
      --tcp-port "$RPI_COMPANION_TCP_PORT" \
      >/tmp/meshcore-ble-bridge.log 2>&1 &
    BLE_PID="$!"
    trap cleanup EXIT INT TERM
    sleep 0.2
  fi

  if [[ -n "$BLE_PID" ]]; then
    "$COMPANION_BIN" \
      --freq "$RPI_FREQ_HZ" \
      --sf "$RPI_SF" \
      --bw "$RPI_BW_HZ" \
      --cr "$RPI_CR" \
      --tx "$RPI_TX_DBM" \
      --spi-dev-prefix "$RPI_SPI_DEV_PREFIX" \
      --spi-bus "$RPI_SPI_BUS" \
      --spi-cs "$RPI_SPI_CS" \
      --spi-speed "$RPI_SPI_SPEED_HZ" \
      --reset-pin "$RPI_RESET_PIN" \
      --busy-pin "$RPI_BUSY_PIN" \
      --irq-pin "$RPI_IRQ_PIN" \
      --txen-pin "$RPI_TXEN_PIN" \
      --rxen-pin "$RPI_RXEN_PIN" \
      --tcp-port "$RPI_COMPANION_TCP_PORT"
  else
    exec "$COMPANION_BIN" \
      --freq "$RPI_FREQ_HZ" \
      --sf "$RPI_SF" \
      --bw "$RPI_BW_HZ" \
      --cr "$RPI_CR" \
      --tx "$RPI_TX_DBM" \
      --spi-dev-prefix "$RPI_SPI_DEV_PREFIX" \
      --spi-bus "$RPI_SPI_BUS" \
      --spi-cs "$RPI_SPI_CS" \
      --spi-speed "$RPI_SPI_SPEED_HZ" \
      --reset-pin "$RPI_RESET_PIN" \
      --busy-pin "$RPI_BUSY_PIN" \
      --irq-pin "$RPI_IRQ_PIN" \
      --txen-pin "$RPI_TXEN_PIN" \
      --rxen-pin "$RPI_RXEN_PIN" \
      --tcp-port "$RPI_COMPANION_TCP_PORT"
  fi
}

install_service() {
  local role="$1"
  local use_ble="$2"
  local service_name="meshcore-${role}.service"
  local service_file="/etc/systemd/system/${service_name}"

  if [[ "$EUID" -ne 0 ]]; then
    echo "Service install requires root. Re-run with sudo."
    return 1
  fi

  local start_cmd
  if [[ "$role" == "repeater" ]]; then
    start_cmd="$SCRIPT_DIR/meshcore_pi_menu.sh --run repeater"
  elif [[ "$use_ble" == "1" ]]; then
    start_cmd="$SCRIPT_DIR/meshcore_pi_menu.sh --run companion --ble"
  else
    start_cmd="$SCRIPT_DIR/meshcore_pi_menu.sh --run companion"
  fi

  cat > "$service_file" <<EOF
[Unit]
Description=MeshCore ${role} (portable)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$start_cmd
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$service_name"
  echo "Installed and started: $service_name"
}

run_service_menu() {
  echo
  echo "Install systemd service"
  echo "  1) repeater"
  echo "  2) companion (TCP)"
  echo "  3) companion (BLE+TCP)"
  read -r -p "Select [1-3]: " sel
  case "$sel" in
    1) install_service repeater 0 ;;
    2) install_service companion 0 ;;
    3) install_service companion 1 ;;
    *) echo "Invalid selection" ;;
  esac
}

usage() {
  cat <<'EOF'
Usage:
  bash meshcore_pi_menu.sh
  bash meshcore_pi_menu.sh --run repeater
  bash meshcore_pi_menu.sh --run companion [--ble]
EOF
}

if [[ "${1:-}" == "--run" ]]; then
  load_conf
  role="${2:-}"
  ble="0"
  if [[ "${3:-}" == "--ble" ]]; then
    ble="1"
  fi

  case "$role" in
    repeater) run_repeater ;;
    companion) run_companion "$ble" ;;
    *) usage; exit 1 ;;
  esac
fi

load_conf

while true; do
  echo
  echo "=== MeshCore Raspberry Pi Menu ==="
  echo "1) Configure values"
  echo "2) Show current values"
  if [[ -x "$REPEATER_BIN" ]]; then
    echo "3) Run repeater"
  else
    echo "3) Run repeater (binary missing)"
  fi
  if [[ -x "$COMPANION_BIN" ]]; then
    echo "4) Run companion (TCP)"
    echo "5) Run companion (BLE+TCP)"
  else
    echo "4) Run companion (binary missing)"
    echo "5) Run companion BLE (binary missing)"
  fi
  echo "6) Install systemd service"
  echo "0) Exit"
  read -r -p "Select: " choice

  case "$choice" in
    1) configure_values ;;
    2) show_values ;;
    3) run_repeater ;;
    4) run_companion 0 ;;
    5) run_companion 1 ;;
    6) run_service_menu ;;
    0) exit 0 ;;
    *) echo "Unknown option" ;;
  esac
done
+