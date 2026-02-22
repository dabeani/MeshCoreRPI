#pragma once

#include <Dispatcher.h>

#include <cstdint>
#include <string>

struct LinuxRadioConfig {
  std::string spi_dev_prefix = "/dev/spidev";
  int spi_bus = 0;
  int spi_cs = 0;
  int spi_speed_hz = 8000000;
  int cs_pin = 21;
  int reset_pin = 18;
  int busy_pin = 20;
  int irq_pin = 16;
  int txen_pin = -1;
  int rxen_pin = -1;

  bool use_dio3_tcxo = true;
  uint8_t tcxo_voltage = 0x02;
  uint32_t tcxo_delay_us = 5000;

  bool use_dio2_rf_switch = true;
  int frequency_hz = 869618000;
  int tx_power_dbm = 22;
  uint16_t sync_word = 0x1424;
  int bandwidth_hz = 625000;
  int spreading_factor = 8;
  int coding_rate = 8;
  int preamble_len = 17;
};

class LinuxRadioBase : public mesh::Radio {
public:
  using Config = LinuxRadioConfig;

  virtual ~LinuxRadioBase() = default;
  virtual void setConfig(const Config& cfg) = 0;
  virtual const Config& getConfig() const = 0;
  virtual const char* getDriverName() const = 0;

  virtual uint32_t getRecvErrorEvents() const { return 0; }
  virtual uint8_t debugGetStatus() { return 0; }
  virtual uint16_t debugGetIrqStatus() { return 0; }
  virtual uint16_t debugGetDeviceErrors() { return 0; }
  virtual void debugClearDeviceErrors() { }
};
