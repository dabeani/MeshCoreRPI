# Raspberry Pi + Waveshare SX1262 HAT

This directory contains host-side setup helpers for running MeshCore-compatible radio workloads on Raspberry Pi 2/3/4 with the Waveshare SX1262 SPI HAT.

These files are intentionally additive and do not modify core firmware code paths, so pulling upstream MeshCore updates remains straightforward.

## Native C++ MeshCore runtime (recommended)

This repository now includes a native Linux C++ target that links directly to MeshCore core code from `src/`.

```bash
sudo bash scripts/rpi/setup_waveshare_hat.sh
bash scripts/rpi/verify_waveshare_hat.sh
sudo bash scripts/rpi/run_native_meshcore_cli.sh
```

Details:

- `host/rpi_native_cli/README.md`

## Included scripts

- `setup_waveshare_hat.sh` – enables SPI, installs runtime tooling, and adds your user to `spi`/`gpio` groups.
- `verify_waveshare_hat.sh` – checks SPI device nodes, boot config, and GPIO tooling.
- `waveshare_hat.env.example` – template of common SX1262 wiring and radio defaults.
- `run_native_meshcore_cli.sh` – builds and runs the native MeshCore C++ CLI target.

## Quick start

```bash
sudo bash scripts/rpi/setup_waveshare_hat.sh
bash scripts/rpi/verify_waveshare_hat.sh
cp scripts/rpi/waveshare_hat.env.example .env.meshcore-rpi
```
