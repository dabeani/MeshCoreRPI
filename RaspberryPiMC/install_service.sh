#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="/etc/systemd/system/raspberrypimc.service"
RUN_USER="${SUDO_USER:-root}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash RaspberryPiMC/install_service.sh"
  exit 1
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=RaspberryPiMC Native MeshCore Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/run_native.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

chmod +x "$SCRIPT_DIR"/*.sh

systemctl daemon-reload
systemctl enable raspberrypimc
systemctl restart raspberrypimc

echo "Installed service: raspberrypimc"
echo "Logs: sudo journalctl -u raspberrypimc -f"
