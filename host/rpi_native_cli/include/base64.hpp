#pragma once

#include <cstddef>
#include <cstdint>

inline int decode_base64(const unsigned char* input, std::size_t len, uint8_t* output) {
  auto decode_char = [](unsigned char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    if (c == '=') return -2;
    return -1;
  };

  int out = 0;
  int vals[4];
  std::size_t i = 0;

  while (i < len) {
    int collected = 0;
    while (collected < 4 && i < len) {
      const int v = decode_char(input[i++]);
      if (v == -1) {
        continue;
      }
      vals[collected++] = v;
    }
    if (collected < 4) {
      break;
    }

    if (vals[0] < 0 || vals[1] < 0) {
      return -1;
    }

    output[out++] = static_cast<uint8_t>((vals[0] << 2) | (vals[1] >> 4));

    if (vals[2] == -2) {
      break;
    }
    if (vals[2] < 0) {
      return -1;
    }
    output[out++] = static_cast<uint8_t>(((vals[1] & 0x0F) << 4) | (vals[2] >> 2));

    if (vals[3] == -2) {
      break;
    }
    if (vals[3] < 0) {
      return -1;
    }
    output[out++] = static_cast<uint8_t>(((vals[2] & 0x03) << 6) | vals[3]);
  }

  return out;
}
