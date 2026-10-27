#pragma once

#include "LinuxRadioBase.h"
#include "Ch341MeshStickTransport.h"
#include <memory>

#include <cstdint>
#include <string>

class SX1262LinuxRadio : public LinuxRadioBase {
public:
  using Config = LinuxRadioBase::Config;

  explicit SX1262LinuxRadio(const Config& cfg);
  ~SX1262LinuxRadio();

  void setConfig(const Config& cfg_) override { cfg = cfg_; }
  const Config& getConfig() const override { return cfg; }
  const char* getDriverName() const override { return "sx1262"; }

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
  void debugClearDeviceErrors() override;

private:
  Config cfg;
  int spi_fd = -1;
  std::unique_ptr<raspmeshcore::RadioTransport> usb_transport;
  bool tx_pending = false;
  bool rx_mode = false;
  float last_rssi = -120.0f;
  float last_snr = 0.0f;
  float noise_floor = -120.0f;
  uint32_t recv_error_events = 0;
  int16_t noise_threshold = 0;
  uint16_t floor_samples = 0;
  int32_t floor_sample_sum = 0;
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

  void waitBusyLow();
  void spiCommand(uint8_t cmd, const uint8_t* payload, int payload_len);
  void spiReadCommand(uint8_t cmd, uint8_t* out, int out_len);
  uint8_t spiReadStatusByte(uint8_t cmd);

  void sxSetStandby();
  void sxSetRegulatorMode(uint8_t mode);
  void sxSetPacketTypeLora();
  void sxSetSyncWord(uint16_t sync_word);
  void sxSetDio2AsRfSwitchCtrl(bool enable);
  void sxSetDio3AsTcxoCtrl(uint8_t voltage, uint32_t delay_us);
  void sxSetRfFrequency(int hz);
  void sxSetBufferBase(uint8_t tx_base, uint8_t rx_base);
  void sxSetModulation();
  void sxSetPacketParams(int payload_len);
  void sxSetPaConfig();
  void sxSetTxParams(int power_dbm);
  void sxSetDioIrqMask(uint16_t mask);
  void sxClearIrq(uint16_t mask = 0xFFFF);
  uint16_t sxGetIrq();
  uint16_t sxGetDeviceErrors();
  void sxClearDeviceErrors();
  void sxSetRxContinuous();
  void sxSetTx();
  void sxWriteBuffer(const uint8_t* data, int len);
  int sxReadBuffer(uint8_t* out, int max_len);
  float sxReadInstantRssi();
  void sxUpdateNoiseFloor(float rssi_dbm);
  void sxUpdateSignalMetrics();
};
