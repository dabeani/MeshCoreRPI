## MeshCore RPI (forked MeshCore)
When you have e.g a Waveshare LoRa HAT for Raspberry PI, now you can compile or RUN out of this code (base MeshCore v1.13.0) a MeshCore Repeater or Companion directly on your Raspberry PI.

* NOT fully tested - but Repeater is Working, and connection via Ethernet to the Companion via MobilePhone!

For more information about RPI & LoRa HATs you can check out pyMC_Repeater (https://github.com/rightup/pyMC_Repeater/blob/3e47122daee85734d323009d67f606257828698f/radio-settings.json). Settings like this should be respected in the /etc/raspberrypimc/repeater.env or /etc/raspberrypimc/companion.env!

Only for Binary install you need the following packages: 
sudo apt-get update && sudo apt-get install -y libgpiod-dev gpiod jq curl

Binary install:
sudo dpkg -i raspberrypimc-native-repeater_*.deb
sudo nano /etc/raspberrypimc/repeater.env
sudo systemctl enable --now raspberrypimc-repeater.service
systemctl is-enabled raspberrypimc-repeater.service
systemctl status raspberrypimc-repeater.service --no-pager

IF you want to Build it on your own, here we go:

Advanced installation on RPI (with possibility for compiling):
sudo apt-get update && sudo apt-get install -y python3 python3-pip python3-venv python3-dev libgpiod-dev gpiod jq curl

You must compile on Linux aarch64 (best: directly on the Pi),
cd ~/MeshCoreRPI
apt update
apt install -y python3-venv python3-full

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install platformio

platformio run -e RaspberryPiMC_native_repeater
platformio run -e RaspberryPiMC_native_companion


REPEATER
Use this on your Pi (repeater-only autostart):
cd ~/MeshCoreRPI
git pull
rm -R ~/MeshCoreRPI/RaspberryPiMC/dist/*
bash RaspberryPiMC/build_deb.sh repeater
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-repeater_*.deb
sudo nano /etc/raspberrypimc/repeater.env
sudo systemctl enable --now raspberrypimc-repeater.service

Verify it survives reboot:
systemctl is-enabled raspberrypimc-repeater.service
systemctl status raspberrypimc-repeater.service --no-pager

After editing repeater env later:
sudo systemctl restart raspberrypimc-repeater.service

COMPANION:
cd ~/MeshCoreRPI
git pull
bash RaspberryPiMC/build_deb.sh companion
sudo dpkg -i RaspberryPiMC/dist/raspberrypimc-native-companion_*.deb
sudo systemctl restart raspberrypimc-companion.service
systemctl status raspberrypimc-companion.service --no-pager

Debug:
/usr/lib/raspberrypimc/companion/program  --freq 869618000 --sf 8 --bw 62500 --cr 8 --tx 22 --spi-bus 0 --spi-cs 0 --cs-pin 21 --spi-speed 1000000 --reset-pin 18 --busy-pin 20 --irq-pin 16 --txen-pin 13 --rxen-pin 12 --no-tcxo --no-dio2-rf
