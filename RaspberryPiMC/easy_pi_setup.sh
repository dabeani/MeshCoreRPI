#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

MODE=""
ROLE=""
START_NOW=1

usage() {
  cat <<'EOF'
Easy RaspberryPiMC setup

Usage:
  bash RaspberryPiMC/easy_pi_setup.sh [--mode package|direct] [--role repeater|companion|both] [--no-start]

Defaults:
  - Interactive mode and role selection when flags are omitted.
  - Starts selected role(s) after build/install unless --no-start is used.
EOF
}

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    echo "Created $ENV_FILE from template."
  fi
}

prepare_data_dir_for_user() {
  ensure_env_file
  local data_dir
  data_dir="$(grep -E '^RPI_DATA_DIR=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true)"
  if [[ -z "$data_dir" ]]; then
    data_dir="/var/lib/raspberrypimc/userdata"
  fi

  sudo mkdir -p "$data_dir"
  sudo chown -R "$USER":"$USER" "$(dirname "$data_dir")"
}

choose_mode() {
  if [[ -n "$MODE" ]]; then return; fi
  echo
  echo "Choose install mode:"
  echo "  1) package  (build/install .deb, run as systemd services)"
  echo "  2) direct   (build/run from this repo, no package install)"
  read -r -p "Select [1-2]: " pick
  case "$pick" in
    1) MODE="package" ;;
    2) MODE="direct" ;;
    *) echo "Invalid selection"; exit 1 ;;
  esac
}

choose_role() {
  if [[ -n "$ROLE" ]]; then return; fi
  echo
  echo "Choose role:"
  echo "  1) repeater"
  echo "  2) companion"
  echo "  3) both"
  read -r -p "Select [1-3]: " pick
  case "$pick" in
    1) ROLE="repeater" ;;
    2) ROLE="companion" ;;
    3) ROLE="both" ;;
    *) echo "Invalid selection"; exit 1 ;;
  esac
}

install_package_role() {
  local role="$1"
  bash "$SCRIPT_DIR/build_deb.sh" "$role"
  sudo dpkg -i "$SCRIPT_DIR"/dist/raspberrypimc-native-"$role"_*.deb
}

start_package_role() {
  local role="$1"
  local svc="raspberrypimc-${role}.service"
  sudo systemctl enable --now "$svc"
  echo "Started $svc"
  systemctl status "$svc" --no-pager || true
}

build_direct_role() {
  local role="$1"
  platformio run --environment "RaspberryPiMC_native_${role}"
}

start_direct_role() {
  local role="$1"
  echo
  echo "Starting $role (Ctrl+C to stop)..."
  if [[ "$role" == "repeater" ]]; then
    bash "$SCRIPT_DIR/run_repeater.sh"
  else
    bash "$SCRIPT_DIR/run_companion.sh"
  fi
}

run_package_mode() {
  need_cmd sudo
  need_cmd dpkg
  need_cmd systemctl

  sudo bash "$SCRIPT_DIR/setup_env.sh"
  prepare_data_dir_for_user

  if [[ "$ROLE" == "both" ]]; then
    install_package_role repeater
    install_package_role companion
  else
    install_package_role "$ROLE"
  fi

  if [[ "$START_NOW" -eq 1 ]]; then
    if [[ "$ROLE" == "both" ]]; then
      start_package_role repeater
      start_package_role companion
    else
      start_package_role "$ROLE"
    fi
  else
    echo "Install complete. Start manually with:"
    if [[ "$ROLE" == "both" ]]; then
      echo "  sudo systemctl enable --now raspberrypimc-repeater.service"
      echo "  sudo systemctl enable --now raspberrypimc-companion.service"
    else
      echo "  sudo systemctl enable --now raspberrypimc-${ROLE}.service"
    fi
  fi
}

run_direct_mode() {
  need_cmd platformio
  need_cmd sudo

  sudo bash "$SCRIPT_DIR/setup_env.sh"
  ensure_env_file
  prepare_data_dir_for_user

  if [[ "$ROLE" == "both" ]]; then
    build_direct_role repeater
    build_direct_role companion
  else
    build_direct_role "$ROLE"
  fi

  if [[ "$START_NOW" -eq 1 ]]; then
    if [[ "$ROLE" == "both" ]]; then
      echo "Both roles are built. Start in separate terminals:"
      echo "  bash RaspberryPiMC/run_repeater.sh"
      echo "  bash RaspberryPiMC/run_companion.sh"
    else
      start_direct_role "$ROLE"
    fi
  else
    echo "Build complete. Start manually with:"
    if [[ "$ROLE" == "both" ]]; then
      echo "  bash RaspberryPiMC/run_repeater.sh"
      echo "  bash RaspberryPiMC/run_companion.sh"
    else
      echo "  bash RaspberryPiMC/run_${ROLE}.sh"
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    --no-start)
      START_NOW=0
      shift
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

if [[ -n "$MODE" && "$MODE" != "package" && "$MODE" != "direct" ]]; then
  echo "Invalid --mode: $MODE"
  exit 1
fi
if [[ -n "$ROLE" && "$ROLE" != "repeater" && "$ROLE" != "companion" && "$ROLE" != "both" ]]; then
  echo "Invalid --role: $ROLE"
  exit 1
fi

choose_mode
choose_role

echo

echo "Mode: $MODE"
echo "Role: $ROLE"

if [[ "$MODE" == "package" ]]; then
  run_package_mode
else
  run_direct_mode
fi

echo
echo "Done."
