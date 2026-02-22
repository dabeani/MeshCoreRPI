#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#ifndef TELEM_CHANNEL_SELF
#define TELEM_CHANNEL_SELF 1
#endif

class CayenneLPP {
  uint8_t buf[255]{};
  uint8_t max_ = 172;
  uint8_t len_ = 0;

public:
  explicit CayenneLPP(uint8_t size = 172) : max_(size > sizeof(buf) ? sizeof(buf) : size) {}

  void reset() { len_ = 0; }

  void addVoltage(uint8_t channel, float value) {
    if (len_ + 4 > max_) return;
    int16_t mv = static_cast<int16_t>(value * 1000.0f);
    buf[len_++] = channel;
    buf[len_++] = 0x02;
    buf[len_++] = static_cast<uint8_t>((mv >> 8) & 0xFF);
    buf[len_++] = static_cast<uint8_t>(mv & 0xFF);
  }

  void addTemperature(uint8_t channel, float value) {
    if (len_ + 4 > max_) return;
    int16_t t = static_cast<int16_t>(value * 10.0f);
    buf[len_++] = channel;
    buf[len_++] = 0x67;
    buf[len_++] = static_cast<uint8_t>((t >> 8) & 0xFF);
    buf[len_++] = static_cast<uint8_t>(t & 0xFF);
  }

  void addAnalogInput(uint8_t channel, float value) {
    if (len_ + 4 > max_) return;
    int16_t v = static_cast<int16_t>(value * 100.0f);
    buf[len_++] = channel;
    buf[len_++] = 0x02;
    buf[len_++] = static_cast<uint8_t>((v >> 8) & 0xFF);
    buf[len_++] = static_cast<uint8_t>(v & 0xFF);
  }

  uint8_t getSize() const { return len_; }
  uint8_t* getBuffer() { return buf; }
};
