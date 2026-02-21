# Raspberry Pi 2/3/4 + Waveshare LoRa HAT (SX1262)

This repository currently targets embedded firmware builds (ESP32/NRF52/RP2040/STM32) and does not include a native Linux PlatformIO environment for Raspberry Pi.

To keep this fork update-friendly with upstream MeshCore, Raspberry Pi support is added as an additive host integration layer in `scripts/rpi/`.

## Hardware assumptions

- Raspberry Pi 2/3/4 running Raspberry Pi OS.
- Waveshare SX1262 LoRa HAT (SPI variant, not UART).
- Default pin mapping used by the provided template:
  - CS: 21
  - RESET: 18
  - BUSY: 20
  - IRQ: 16
  - SPI bus 0 / chip-select 0

## Setup

```bash
sudo bash scripts/rpi/setup_waveshare_hat.sh
bash scripts/rpi/verify_waveshare_hat.sh
cp scripts/rpi/waveshare_hat.env.example .env.meshcore-rpi
```

If SPI was just enabled, reboot once before verification.

## Native RPi runtime

### Native MeshCore C++ runtime (codebase-linked)

This is the direct codebase-native path. It compiles and runs using MeshCore C++ core files from this repository.

```bash
sudo bash scripts/rpi/setup_waveshare_hat.sh
bash scripts/rpi/verify_waveshare_hat.sh
sudo bash scripts/rpi/run_native_meshcore_cli.sh
```

Reference:

- `host/rpi_native_cli/README.md`

## Notes on upstream-safe architecture

- No changes are made to core `src/` routing, packet, or protocol files.
- No new board variant is injected into existing embedded PlatformIO targets.
- Raspberry Pi specific behavior is isolated in `scripts/rpi/` and documentation.

This keeps the diff small and easy to maintain when rebasing onto new upstream MeshCore releases.
