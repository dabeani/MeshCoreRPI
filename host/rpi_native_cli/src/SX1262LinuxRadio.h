#pragma once

#include <Dispatcher.h>

#include <cstdint>
#include <string>

class SX1262LinuxRadio : public mesh::Radio {
public:
  struct Config {
    std::string spi_dev_prefix = "/dev/spidev";
    int spi_bus = 0;
    int spi_cs = 0;
    int spi_speed_hz = 8000000;
    // Optional manual chip-select GPIO (BCM pin). If >=0, driver asserts this GPIO
    // around each SPI transfer and asks spidev to not toggle its own CS.
    int cs_pin = 21;
    int reset_pin = 18;
    int busy_pin = 20;
    int irq_pin = 16;
    int txen_pin = -1;
    int rxen_pin = -1;

    // Some SX1262 HATs require TCXO control via DIO3 to get a stable RF clock.
    // If enabled, we configure DIO3 as TCXO control at startup.
    bool use_dio3_tcxo = true;
    // SX126x TCXO voltage selector: 0..7 => 1.6,1.7,1.8,2.2,2.4,2.7,3.0,3.3V
    uint8_t tcxo_voltage = 0x02; // 1.8V
    uint32_t tcxo_delay_us = 5000;

    // Enable DIO2 RF switch control (board-dependent). Leaving this on is usually
    // harmless if DIO2 is unconnected.
    bool use_dio2_rf_switch = true;
    int frequency_hz = 869618000;
    int tx_power_dbm = 22;
    uint16_t sync_word = 0x1424; // MeshCore private LoRa sync word
    int bandwidth_hz = 625000;
    int spreading_factor = 8;
    int coding_rate = 8;
    int preamble_len = 17;
  };

  explicit SX1262LinuxRadio(const Config& cfg);
  ~SX1262LinuxRadio();

  void setConfig(const Config& cfg_) { cfg = cfg_; }
  const Config& getConfig() const { return cfg; }

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

  uint32_t getRecvErrorEvents() const { return recv_error_events; }

  uint8_t debugGetStatus();
  uint16_t debugGetIrqStatus();
  uint16_t debugGetDeviceErrors();
  void debugClearDeviceErrors();

private:
  Config cfg;
  int spi_fd = -1;
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
