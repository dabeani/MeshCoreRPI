#pragma once
#include <cstdint>

// SX1262 GetStatus: chip-mode bits [6:4] must be a documented mode.
// Reject floating-high/low SPI buses before the Companion accepts traffic.
inline bool sx1262StatusPlausible(uint8_t status) {
  const uint8_t mode = static_cast<uint8_t>((status >> 4) & 0x07);
  return (status & 0x81) == 0 && mode >= 2 && mode <= 6;
}
