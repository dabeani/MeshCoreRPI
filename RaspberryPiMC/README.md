# RaspberryPiMC

Dedicated runtime environment for Raspberry Pi 2/3/4 using Waveshare SX1262 HAT, separated from the main development tree workflow.

This environment is native C++ and builds from MeshCore code in this repository.

## Raspberry Pi: Do This First (Simple Path)

Use this section directly on the Pi.

### One-command helper (recommended)

```bash
cd ~/MeshCoreRPI
bash RaspberryPiMC/easy_pi_setup.sh
```

Optional non-interactive examples:

```bash
# package install, both roles, auto-start services
bash RaspberryPiMC/easy_pi_setup.sh --mode package --role both

# direct build for repeater only, do not start it yet
bash RaspberryPiMC/easy_pi_setup.sh --mode direct --role repeater --no-start
```

### Portable mode (only script + executables)

If you do **not** want to copy the full repository to the Pi, use the portable bundle.

Create bundle on your build machine:

```bash
cd ~/MeshCoreRPI
bash RaspberryPiMC/make_portable_bundle.sh
```

If PlatformIO is not installed on that machine (for example directly on an RPi), use existing binaries:

```bash
bash RaspberryPiMC/make_portable_bundle.sh --skip-build \
	--repeater-bin /usr/lib/raspberrypimc/repeater/program \
	--companion-bin /usr/lib/raspberrypimc/companion/program
```

Important:

- Build portable bundle on **Linux ARM/aarch64** for Raspberry Pi.
- Native binaries are host-specific (for example, macOS binaries will fail on Linux with `Exec format error`).
- Only use `--force` if you explicitly know what you are doing.

Copy this folder or tarball to Raspberry Pi:

- `RaspberryPiMC/dist/meshcore-rpi-portable/`
- `RaspberryPiMC/dist/meshcore-rpi-portable.tar.gz`

Run on Raspberry Pi (interactive menu for all decisions/values):

```bash
cd meshcore-rpi-portable
chmod +x meshcore_pi_menu.sh meshcore-repeater meshcore-companion
./meshcore_pi_menu.sh
```

The menu lets you:

- configure LoRa + TCP + BLE + data path values
- run repeater or companion directly
- enable companion BLE bridge
- install/start systemd services from the same script

### 1) Pick one install mode

- **A. Package mode (`.deb`)**: use when `dpkg` is available.
- **B. Direct mode (no package)**: use when package install is not possible.

### 2) Package mode (`.deb`) — copy/paste

```bash
cd ~/MeshCoreRPI
sudo bash RaspberryPiMC/setup_env.sh
bash RaspberryPiMC/build_deb.sh repeater
bash RaspberryPiMC/build_deb.sh companion
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-repeater_*.deb
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-companion_*.deb
```

Configure and start:

```bash
sudo nano /etc/raspberrypimc/repeater.env
sudo nano /etc/raspberrypimc/companion.env
sudo systemctl enable --now raspberrypimc-repeater.service
sudo systemctl enable --now raspberrypimc-companion.service
```

For Waveshare SX1262 HAT, ensure these keys exist in `/etc/raspberrypimc/repeater.env`:

```dotenv
RPI_CS_PIN=21
RPI_TXEN_PIN=13
RPI_RXEN_PIN=12
RPI_USE_TCXO=0
RPI_USE_DIO2_RF=0
```

These map to runtime flags equivalent to:

`--cs-pin 21 --txen-pin 13 --rxen-pin 12 --no-tcxo --no-dio2-rf`

### 2b) Persistent autostart on boot (repeater only)

If you only want the repeater to auto-start after reboot:

```bash
cd ~/MeshCoreRPI
bash RaspberryPiMC/build_deb.sh repeater
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-repeater_*.deb
sudo nano /etc/raspberrypimc/repeater.env
sudo systemctl enable --now raspberrypimc-repeater.service
```

Verify it is persistent:

```bash
systemctl is-enabled raspberrypimc-repeater.service
systemctl status raspberrypimc-repeater.service --no-pager
```

Expected `is-enabled` output: `enabled`

After changing `/etc/raspberrypimc/repeater.env`, apply changes with:

```bash
sudo systemctl restart raspberrypimc-repeater.service
```

Note:

- Current native SX1262 Linux runtime uses sysfs GPIO export, which typically requires root privileges.
- Package services are configured to run as root so GPIO/SPI access works reliably on Raspberry Pi.
- If your existing installed unit still has `User=raspberrypimc`, rebuild/reinstall the latest `.deb` and restart the service.

Quick check/fix for existing systemd unit on the Pi:

```bash
systemctl cat raspberrypimc-repeater.service | sed -n '1,120p'
sudo systemctl daemon-reload
sudo systemctl restart raspberrypimc-repeater.service
sudo journalctl -u raspberrypimc-repeater.service -n 80 --no-pager
```

Check status/logs:

```bash
systemctl status raspberrypimc-repeater.service --no-pager
systemctl status raspberrypimc-companion.service --no-pager
sudo journalctl -u raspberrypimc-repeater.service -f
sudo journalctl -u raspberrypimc-companion.service -f
```

### 3) Direct mode (no package) — copy/paste

```bash
cd ~/MeshCoreRPI
sudo bash RaspberryPiMC/setup_env.sh
cp RaspberryPiMC/.env.example RaspberryPiMC/.env
nano RaspberryPiMC/.env
```

Build and run manually:

```bash
# repeater
platformio run --environment RaspberryPiMC_native_repeater
bash RaspberryPiMC/run_repeater.sh

# companion
platformio run --environment RaspberryPiMC_native_companion
bash RaspberryPiMC/run_companion.sh
```

### 4) Persistent data folder (both modes)

```bash
sudo mkdir -p /var/lib/raspberrypimc/userdata
sudo chown -R "$USER":"$USER" /var/lib/raspberrypimc
```

- Default data path: `/var/lib/raspberrypimc/userdata`
- Override path in env: `RPI_DATA_DIR=/your/path`

## Quick Start

```bash
sudo bash RaspberryPiMC/setup_env.sh
bash RaspberryPiMC/build_native.sh
sudo bash RaspberryPiMC/run_repeater.sh
```

Role-specific runtime wrappers:

```bash
sudo bash RaspberryPiMC/run_repeater.sh
sudo bash RaspberryPiMC/run_companion.sh
```

Companion IP bridge transport (default TCP port `5000`) is available in the native companion runtime.
Frame envelope:

- app -> companion: `'<', len(LE16), payload`
- companion -> app: `'>' , len(LE16), payload`

Set port in `RaspberryPiMC/.env`:

```text
RPI_COMPANION_TCP_PORT=5000
```

Companion BLE (BlueZ, Nordic UART Service compatible UUIDs) is available via the bundled bridge process.
Enable in `RaspberryPiMC/.env`:

```text
RPI_COMPANION_BLE_ENABLE=1
RPI_COMPANION_BLE_ADAPTER=hci0
RPI_COMPANION_BLE_NAME=MeshCore
```

## PlatformIO Build Target

You can select and compile this environment directly in PlatformIO:

- Environment names:
	- `RaspberryPiMC_native_repeater`
	- `RaspberryPiMC_native_companion`
- Config file: `platformio.ini`

CLI build:

```bash
pio run -e RaspberryPiMC_native_repeater
pio run -e RaspberryPiMC_native_companion
```

In VS Code PlatformIO sidebar, select either environment and click Build.

## DEB Packaging (automatic on Linux)

When you build either native role env on Linux, a matching `.deb` package is created automatically:

- repeater build -> `raspberrypimc-native-repeater_<version>_<arch>.deb`
- companion build -> `raspberrypimc-native-companion_<version>_<arch>.deb`

Output folder:

```text
RaspberryPiMC/dist/
```

Manual packaging:

```bash
bash RaspberryPiMC/build_deb.sh repeater
bash RaspberryPiMC/build_deb.sh companion
```

Install on Raspberry Pi:

```bash
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-repeater_*.deb
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-companion_*.deb
```

Each package installs:

- role binary
- `/usr/bin/raspberrypimc-<role>` launcher
- `/etc/raspberrypimc/<role>.env` config
- `raspberrypimc-<role>.service` systemd unit

Companion package also installs:

- BlueZ NUS bridge script (`ble_nus_bridge.py`)
- dependencies (`python3`, `python3-dbus`, `python3-gi`, `bluez`)

## Manual Install (without `.deb` package)

If you cannot use package installation (`dpkg`), run directly from this repository.

1) Prepare environment and config:

```bash
sudo bash RaspberryPiMC/setup_env.sh
cp RaspberryPiMC/.env.example RaspberryPiMC/.env
```

2) Optional: set persistent data location and ownership:

```bash
sudo mkdir -p /var/lib/raspberrypimc/userdata
sudo chown -R "$USER":"$USER" /var/lib/raspberrypimc
```

3) Build and start the role you need:

```bash
# repeater
platformio run --environment RaspberryPiMC_native_repeater
bash RaspberryPiMC/run_repeater.sh

# companion
platformio run --environment RaspberryPiMC_native_companion
bash RaspberryPiMC/run_companion.sh
```

4) Optional: manual systemd service (without package), repeater example:

```bash
sudo tee /etc/systemd/system/raspberrypimc-repeater.service >/dev/null <<'EOF'
[Unit]
Description=RaspberryPiMC Repeater (manual)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
Group=%i
WorkingDirectory=/opt/MeshCoreRPI
ExecStart=/opt/MeshCoreRPI/RaspberryPiMC/run_repeater.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now raspberrypimc-repeater.service
```

Optional: manual systemd service (without package), companion example:

```bash
sudo tee /etc/systemd/system/raspberrypimc-companion.service >/dev/null <<'EOF'
[Unit]
Description=RaspberryPiMC Companion (manual)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
Group=%i
WorkingDirectory=/opt/MeshCoreRPI
ExecStart=/opt/MeshCoreRPI/RaspberryPiMC/run_companion.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now raspberrypimc-companion.service
```

If you need BLE for companion in service mode, set these in `RaspberryPiMC/.env` before starting:

```text
RPI_COMPANION_BLE_ENABLE=1
RPI_COMPANION_BLE_ADAPTER=hci0
RPI_COMPANION_BLE_NAME=MeshCore
```

Update `WorkingDirectory`/`ExecStart` paths to your clone location.

## Companion Mobile App Connectivity Scope

The native companion runtime is role-separated, package-ready, and includes both:

- IP framed bridge transport
- Bluetooth LE bridge using Nordic UART Service UUIDs

## Separate Environment Layout

- `RaspberryPiMC/.env` - runtime radio parameters
- `.pio/build/RaspberryPiMC_native_repeater/program` - repeater binary
- `.pio/build/RaspberryPiMC_native_companion/program` - companion binary
- `RaspberryPiMC/logs/` - local runtime logs

## Data Location

Persistent runtime data (prefs, identity, contacts, channels, regions, blobs) is stored in:

```text
/var/lib/raspberrypimc/userdata
```

Override this path in env:

```text
RPI_DATA_DIR=/your/custom/path
```

Runtime wrappers export `MESHCORE_DATA_DIR` from `RPI_DATA_DIR`.
If the configured path cannot be created (for example in local dev without root permissions), native runtime falls back to:

```text
<current-working-directory>/RaspberryPiMC/userdata
```

For service deployments, ensure the runtime user can write the default path:

```bash
sudo mkdir -p /var/lib/raspberrypimc/userdata && sudo chown -R raspberrypimc:raspberrypimc /var/lib/raspberrypimc
```

## Update Flow

After pulling new upstream changes:

```bash
git pull
bash RaspberryPiMC/build_native.sh
sudo systemctl restart raspberrypimc
```

## Optional Systemd Service

```bash
sudo bash RaspberryPiMC/install_service.sh
sudo systemctl status raspberrypimc
sudo journalctl -u raspberrypimc -f
```
