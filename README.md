Would be nice if you support me: https://buymeacoffee.com/bmks — thank you very much!!

Important: Use at your own risk. You, the device owner, are responsible for any damage, data loss, or bricked devices.

## MeshCore RPI (forked MeshCore)

With a Waveshare LoRa HAT on Raspberry Pi, this fork (based on MeshCore `v1.13.0`) can build and run native MeshCore:

- Repeater
- Companion

Current status:

- Repeater is working.
- From Mobile Phone to Companion via Ethernet works

Reference hardware settings (recommended to mirror in env files):

- pyMC_Repeater radio settings JSON: https://github.com/rightup/pyMC_Repeater/blob/3e47122daee85734d323009d67f606257828698f/radio-settings.json
- Apply matching values in:
	- `/etc/raspberrypimc/repeater.env`
	- `/etc/raspberrypimc/companion.env`

### 1) Binary install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y libgpiod-dev gpiod jq curl
```

### 2) Binary install (repeater)

```bash
sudo dpkg -i raspberrypimc-native-repeater_*.deb
sudo nano /etc/raspberrypimc/repeater.env
sudo systemctl enable --now raspberrypimc-repeater.service
systemctl is-enabled raspberrypimc-repeater.service
systemctl status raspberrypimc-repeater.service --no-pager
```

### 3) Build on Raspberry Pi (advanced)

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-pip python3-venv python3-dev libgpiod-dev gpiod jq curl
```

Build target should be Linux `aarch64` (best: build directly on the Pi).

```bash
cd ~/MeshCoreRPI
sudo apt update
sudo apt install -y python3-venv python3-full

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install platformio

platformio run -e RaspberryPiMC_native_repeater
platformio run -e RaspberryPiMC_native_companion
```

### 4) Repeater autostart flow

```bash
cd ~/MeshCoreRPI
git pull
rm -rf ~/MeshCoreRPI/RaspberryPiMC/dist/*
bash RaspberryPiMC/build_deb.sh repeater
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-repeater_*.deb
sudo nano /etc/raspberrypimc/repeater.env
sudo systemctl enable --now raspberrypimc-repeater.service
```

Verify persistence after reboot:

```bash
systemctl is-enabled raspberrypimc-repeater.service
systemctl status raspberrypimc-repeater.service --no-pager
```

After env changes:

```bash
sudo systemctl restart raspberrypimc-repeater.service
```

### 5) Companion service flow

```bash
cd ~/MeshCoreRPI
git pull
bash RaspberryPiMC/build_deb.sh companion
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-companion_*.deb
sudo systemctl restart raspberrypimc-companion.service
systemctl status raspberrypimc-companion.service --no-pager
```

### 6) Companion debug run (manual)

```bash
/usr/lib/raspberrypimc/companion/program \
	--freq 869618000 --sf 8 --bw 62500 --cr 8 --tx 22 \
	--spi-bus 0 --spi-cs 0 --cs-pin 21 --spi-speed 1000000 \
	--reset-pin 18 --busy-pin 20 --irq-pin 16 --txen-pin 13 --rxen-pin 12 \
	--no-tcxo --no-dio2-rf
```
