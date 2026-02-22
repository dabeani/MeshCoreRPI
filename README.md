Would be nice if you support me: https://buymeacoffee.com/bmks — thank you very much!!

Important: Use at your own risk. You, the device owner, are responsible for any damage, data loss, or bricked devices.

## MeshCore RPI (forked MeshCore)

With a Waveshare LoRa HAT on Raspberry Pi, this fork (based on MeshCore `v1.13.0`) can build and run native MeshCore:
Tested with the following LoRa HAT: https://www.amazon.de/dp/B0C61XFGHC?ref=ppx_yo2ov_dt_b_fed_asin_title


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

### Runtime configuration options (`/etc/raspberrypimc/*.env`)

Core radio/runtime keys:

```dotenv
RPI_FREQ_HZ=869618000
RPI_SF=8
RPI_BW_HZ=62500
RPI_CR=8
RPI_TX_DBM=22

# Radio backend selector
RPI_RADIO_DRIVER=sx1262   # or: sx127x

# SPI device node prefix (default: /dev/spidev)
RPI_SPI_DEV_PREFIX=/dev/spidev

RPI_SPI_BUS=0
RPI_SPI_CS=0
RPI_SPI_SPEED_HZ=1000000
RPI_CS_PIN=21
RPI_RESET_PIN=18
RPI_BUSY_PIN=20
RPI_IRQ_PIN=16
RPI_TXEN_PIN=13
RPI_RXEN_PIN=12

RPI_USE_TCXO=0
RPI_USE_DIO2_RF=0
```

Notes:

- If `RPI_RADIO_DRIVER` is unset, default is `sx1262`.
- If `RPI_SPI_DEV_PREFIX` is unset, default is `/dev/spidev`.
- After changing env values, restart the service:

```bash
sudo systemctl restart raspberrypimc-repeater.service
sudo systemctl restart raspberrypimc-companion.service
```

### SX127x quick-start profile

If you use an SX127x-based module, set the driver explicitly and adjust GPIO pins to your wiring:

```dotenv
RPI_RADIO_DRIVER=sx127x
RPI_SPI_DEV_PREFIX=/dev/spidev
RPI_SPI_BUS=0
RPI_SPI_CS=0
RPI_SPI_SPEED_HZ=1000000

# Example GPIO mapping (change for your board/wiring)
RPI_CS_PIN=21
RPI_RESET_PIN=18
RPI_IRQ_PIN=16
RPI_TXEN_PIN=-1
RPI_RXEN_PIN=-1
```

Then restart the service and verify from CLI:

```text
radio-diag
```

Expected: `"driver":"sx127x"` in the diagnostic JSON.

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
	--radio-driver sx1262 \
	--spi-dev-prefix /dev/spidev \
	--spi-bus 0 --spi-cs 0 --cs-pin 21 --spi-speed 1000000 \
	--reset-pin 18 --busy-pin 20 --irq-pin 16 --txen-pin 13 --rxen-pin 12 \
	--no-tcxo --no-dio2-rf
```

Feel Free to Download / Modify / Distribute
