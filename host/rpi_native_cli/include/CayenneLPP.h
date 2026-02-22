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

  void writeInt16(uint8_t channel, uint8_t type, int16_t value) {
    if (len_ + 4 > max_) return;
    buf[len_++] = channel;
    buf[len_++] = type;
    buf[len_++] = static_cast<uint8_t>((value >> 8) & 0xFF);
    buf[len_++] = static_cast<uint8_t>(value & 0xFF);
  }

  void writeUInt8(uint8_t channel, uint8_t type, uint8_t value) {
    if (len_ + 3 > max_) return;
    buf[len_++] = channel;
    buf[len_++] = type;
    buf[len_++] = value;
  }

  void writeInt24(uint8_t*& out, int32_t value) {
    out[0] = static_cast<uint8_t>((value >> 16) & 0xFF);
    out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
    out[2] = static_cast<uint8_t>(value & 0xFF);
    out += 3;
  }

public:
  explicit CayenneLPP(uint8_t size = 172) : max_(size > sizeof(buf) ? sizeof(buf) : size) {}

  void reset() { len_ = 0; }

  void addVoltage(uint8_t channel, float value) {
    writeInt16(channel, 0x02, static_cast<int16_t>(value * 1000.0f));
  }

  void addTemperature(uint8_t channel, float value) {
    writeInt16(channel, 0x67, static_cast<int16_t>(value * 10.0f));
  }

  void addAnalogInput(uint8_t channel, float value) {
    writeInt16(channel, 0x02, static_cast<int16_t>(value * 100.0f));
  }

  void addRelativeHumidity(uint8_t channel, float value) {
    writeUInt8(channel, 0x68, static_cast<uint8_t>(value * 2.0f));
  }

  void addBarometricPressure(uint8_t channel, float value) {
    writeInt16(channel, 0x73, static_cast<int16_t>(value * 10.0f));
  }

  void addLuminosity(uint8_t channel, float value) {
    writeInt16(channel, 0x65, static_cast<int16_t>(value));
  }

  void addPresence(uint8_t channel, bool present) {
    writeUInt8(channel, 0x66, present ? 1 : 0);
  }

  void addDistance(uint8_t channel, float value) {
    writeInt16(channel, 0x82, static_cast<int16_t>(value * 100.0f));
  }

  void addCurrent(uint8_t channel, float value) {
    writeInt16(channel, 0x85, static_cast<int16_t>(value * 1000.0f));
  }

  void addPower(uint8_t channel, float value) {
    writeInt16(channel, 0x80, static_cast<int16_t>(value));
  }

  void addAltitude(uint8_t channel, float value) {
    writeInt16(channel, 0x83, static_cast<int16_t>(value * 100.0f));
  }

  void addGPS(uint8_t channel, double lat, double lon, double alt) {
    if (len_ + 11 > max_) return;
    buf[len_++] = channel;
    buf[len_++] = 0x88;
    uint8_t* out = &buf[len_];
    writeInt24(out, static_cast<int32_t>(lat * 10000.0));
    writeInt24(out, static_cast<int32_t>(lon * 10000.0));
    writeInt24(out, static_cast<int32_t>(alt * 100.0));
    len_ += 9;
  }

  uint8_t getSize() const { return len_; }
  uint8_t* getBuffer() { return buf; }
};
