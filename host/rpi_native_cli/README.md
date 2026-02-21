# MeshCore Native Raspberry Pi CLI

This target builds a Linux binary that directly links MeshCore C++ core files from this repository.

Used core files:

- `src/Dispatcher.cpp`
- `src/Packet.cpp`
- `src/helpers/StaticPoolPacketManager.cpp`

The runtime includes a native SX1262 SPI/GPIO driver for Raspberry Pi + Waveshare HAT in:

- `host/rpi_native_cli/src/SX1262LinuxRadio.cpp`

## Build (on Raspberry Pi)

```bash
bash host/rpi_native_cli/build.sh
```

Binary output:

```text
host/rpi_native_cli/out/meshcore-rpi-native
```

## Run

```bash
sudo host/rpi_native_cli/out/meshcore-rpi-native
```

Optional radio params:

```bash
sudo host/rpi_native_cli/out/meshcore-rpi-native --freq 869525000 --sf 11 --bw 250000 --cr 5 --tx 22
```

CLI commands:

- `stats`
- `quit`

## Notes

- This path is fully native C++ using this MeshCore codebase directly.
- No `pymc_core` runtime dependency is required for this binary.
- Current behavior is repeater-style forwarding with duplicate suppression.
