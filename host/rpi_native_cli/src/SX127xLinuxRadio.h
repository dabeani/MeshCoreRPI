#pragma once

#include "LinuxRadioBase.h"

#include <cstdint>
#include <string>

class SX127xLinuxRadio : public LinuxRadioBase {
public:
  using Config = LinuxRadioBase::Config;

  explicit SX127xLinuxRadio(const Config& cfg);
  ~SX127xLinuxRadio();

  void setConfig(const Config& cfg_) override { cfg = cfg_; }
  const Config& getConfig() const override { return cfg; }
  const char* getDriverName() const override { return "sx127x"; }

  void begin() override;
  int recvRaw(uint8_t* bytes, int sz) override;
  uint32_t getEstAirtimeFor(int len_bytes) override;
  float packetScore(float snr, int packet_len) override;
  bool startSendRaw(const uint8_t* bytes, int len) override;
  bool isSendComplete() override;
  void onSendFinished() override;
  bool isInRecvMode() const override;
  bool isReceiving() override;
  void loop() override;
  float getLastRSSI() const override;
  float getLastSNR() const override;
  int getNoiseFloor() const override;
  void triggerNoiseFloorCalibrate(int threshold) override;
  void resetAGC() override;

  uint32_t getRecvErrorEvents() const override { return recv_error_events; }

  uint8_t debugGetStatus() override;
  uint16_t debugGetIrqStatus() override;
  uint16_t debugGetDeviceErrors() override;

private:
  Config cfg;
  int spi_fd = -1;
  bool tx_pending = false;
  bool rx_mode = false;
  float last_rssi = -120.0f;
  float last_snr = 0.0f;
  float noise_floor = -120.0f;
  uint32_t recv_error_events = 0;
  int16_t noise_threshold = 14;

  int sysfs_gpio_base = -1;

  void openSpi();
  void spiTransfer(const uint8_t* tx, uint8_t* rx, size_t len);
  int toSysfsPin(int pin);
  std::string gpioNodePath(int pin, const std::string& node);
  void gpioExport(int pin);
  void gpioDirection(int pin, const char* mode);
  void gpioWrite(int pin, int value);
  int gpioRead(int pin);
  void gpioPulseReset();

  uint8_t readReg(uint8_t reg);
  void writeReg(uint8_t reg, uint8_t val);
  void writeBurst(uint8_t reg, const uint8_t* data, int len);
  void readBurst(uint8_t reg, uint8_t* data, int len);

  void setMode(uint8_t mode);
  void setFrequency(int hz);
  void setTxPower(int8_t dbm);
  void setBandwidthAndCodingRate(int bandwidth_hz, int coding_rate);
  void setSpreadingFactor(int sf);
  void setPreamble(int preamble);
  void setSyncWord(uint8_t sync_word);
  float readInstantRssi();
  void updateNoiseFloor(float rssi_dbm);

  static uint8_t bwToReg(int bandwidth_hz);
};
