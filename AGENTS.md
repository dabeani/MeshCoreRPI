# AGENTS.md

## What This Repository Is

MeshCoreRPI is a fork of MeshCore focused on running MeshCore natively on Raspberry Pi.

Main runtime roles:

- Repeater: LoRa mesh node/repeater runtime.
- Companion: LoRa + TCP (and optional BLE bridge) runtime.

The project keeps upstream-style embedded code plus a Linux native target for Raspberry Pi packaging and deployment.

## Key Raspberry Pi Areas

- Raspberry Pi runtime scripts and packaging: `RaspberryPiMC/`
- Native target entrypoints and Linux radio glue: `host/rpi_native_cli/src/`
- Repeater application logic: `examples/simple_repeater/`
- Companion application logic: `examples/companion_radio/`
- Native build environments: `platformio.ini`

## Native Build Targets

- `RaspberryPiMC_native_repeater`
- `RaspberryPiMC_native_companion`

Use PlatformIO to build these targets.

## Configuration Model (Important)

Runtime config is environment-based (`RPI_*` keys), primarily from:

- `/etc/raspberrypimc/repeater.env`
- `/etc/raspberrypimc/companion.env`

Behavior:

- Native binaries load role env files directly at startup.
- Optional override: `RPI_CONFIG_FILE=/path/to/file.env`.
- Role config values are interpreted and printed on startup.

At startup, native binaries print:

- `startup-config: ...` (effective interpreted values)
- `radio-diag: {...}` (radio diagnostics snapshot)

This output is the first place to verify configuration issues (SPI path/pins/speed, driver, radio params).

## Packaging Rules

DEB packaging must preserve existing user config files in `/etc/raspberrypimc/`.

- Do not overwrite existing `repeater.env` or `companion.env` on upgrade.
- Default templates are shipped as examples in `/usr/share/raspberrypimc/*.env.example`.
- Post-install should create `/etc/raspberrypimc/<role>.env` only if missing.

## Runtime vs Compile-Time Settings

Runtime (change in env file, restart service):

- `RPI_FREQ_HZ`, `RPI_SF`, `RPI_BW_HZ`, `RPI_CR`, `RPI_TX_DBM`
- `RPI_RADIO_DRIVER` (`sx1262` or `sx127x`)
- SPI/pin settings (`RPI_SPI_DEV_PREFIX`, bus/cs/speed, reset/busy/irq/txen/rxen)

Compile-time (change in `platformio.ini`, rebuild binaries):

- `MAX_CONTACTS`
- `MAX_GROUP_CHANNELS`
- `MESH_DEBUG`
- `MESH_PACKET_LOGGING`

Do not claim compile-time macros are runtime-configurable without refactoring to dynamic containers.

## Radio Drivers

Native Linux supports selectable drivers:

- `sx1262`
- `sx127x`

Driver selection is runtime-controlled via `RPI_RADIO_DRIVER`.

## Logging Expectations

For repeater CLI, `log start` should show live log lines in CLI output (not only file logging).

## Service/Execution Notes

- Wrapper scripts in `RaspberryPiMC/` source env and start binaries.
- Binaries also self-load role env files to support direct execution.
- Services typically run as root because native GPIO/SPI access may require elevated permissions.

## Recommended Validation After Changes

1. Build both native targets.
2. Verify startup prints show expected config (`startup-config` + `radio-diag`).
3. Verify `radio-diag` reflects env values (especially `spi_dev_prefix`, pins, speed, driver).
4. Validate DEB install/upgrade behavior does not overwrite existing `/etc/raspberrypimc/*.env`.
5. For CLI behavior changes, test interactively (`log start`, `radio-diag`, `exit`).

## Editing Guidance for Agents

- Keep changes minimal and scoped to the requested behavior.
- Preserve existing config compatibility unless explicitly breaking changes are requested.
- Update docs when changing config semantics or deployment behavior.
- If changing packaging or startup config loading, verify both repeater and companion paths.
