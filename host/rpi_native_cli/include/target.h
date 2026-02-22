#pragma once

#include <MeshCore.h>
#include <helpers/ArduinoHelpers.h>
#include <helpers/SensorManager.h>
#include <LinuxRadioBase.h>
#include <SX1262LinuxRadio.h>
#include <SX127xLinuxRadio.h>
#include "LittleFS.h"

#include <memory>
#include <string>

#define RP2040_PLATFORM 1

class LinuxBoard : public mesh::MainBoard {
  uint16_t boot_voltage_mv = 5000;
  float adc_multiplier = 1.0f;

public:
  void begin();
  uint16_t getBattMilliVolts() override;
  float getMCUTemperature() override;
  bool setAdcMultiplier(float multiplier) override;
  float getAdcMultiplier() const override { return adc_multiplier; }
  const char* getManufacturerName() const override { return "RaspberryPi"; }
  void reboot() override;
  uint8_t getStartupReason() const override { return BD_STARTUP_NORMAL; }
  bool isExternalPowered() override;
  uint16_t getBootVoltage() override { return boot_voltage_mv; }
  uint32_t getResetReason() const override { return 0; }
  const char* getResetReasonString(uint32_t) override { return "Host start"; }
  uint8_t getShutdownReason() const override { return 0; }
  const char* getShutdownReasonString(uint8_t) override { return "Not available"; }
};

class LinuxRTCClock : public VolatileRTCClock {
public:
  void begin() {}
};

class LinuxRadioDriver : public mesh::Radio {
  LinuxRadioConfig cfg;
  std::string driver_name = "sx1262";
  std::unique_ptr<LinuxRadioBase> backend;

  uint32_t packets_recv = 0;
  uint32_t packets_sent = 0;
  uint32_t packets_recv_errors = 0;

  void ensureBackend();

public:
  explicit LinuxRadioDriver(const LinuxRadioConfig& cfg);

  void setDriverName(const std::string& name);
  const char* getDriverName() const;
  void setConfig(const LinuxRadioConfig& cfg_);
  const LinuxRadioConfig& getConfig() const;

  void begin() override;

  uint32_t getEstAirtimeFor(int len_bytes) override;
  float packetScore(float snr, int packet_len) override;

  int recvRaw(uint8_t* bytes, int sz) override {
    ensureBackend();
    const uint32_t prev_error_events = backend->getRecvErrorEvents();
    const int n = backend->recvRaw(bytes, sz);
    const uint32_t cur_error_events = backend->getRecvErrorEvents();
    if (cur_error_events > prev_error_events) {
      packets_recv_errors += (cur_error_events - prev_error_events);
    }
    if (n > 0) packets_recv++;
    return n;
  }

  bool startSendRaw(const uint8_t* bytes, int len) override {
    ensureBackend();
    return backend->startSendRaw(bytes, len);
  }

  bool isSendComplete() override {
    ensureBackend();
    const bool done = backend->isSendComplete();
    if (done) packets_sent++;
    return done;
  }

  void onSendFinished() override {
    ensureBackend();
    backend->onSendFinished();
  }

  bool isInRecvMode() const override;
  bool isReceiving() override;
  void loop() override;
  float getLastRSSI() const override;
  float getLastSNR() const override;
  int getNoiseFloor() const override;
  void triggerNoiseFloorCalibrate(int threshold) override;
  void resetAGC() override;

  uint32_t getPacketsRecv() const { return packets_recv; }
  uint32_t getPacketsSent() const { return packets_sent; }
  uint32_t getPacketsRecvErrors() const { return packets_recv_errors; }
  void resetStats() { packets_recv = packets_sent = packets_recv_errors = 0; }

  uint8_t debugGetStatus();
  uint16_t debugGetIrqStatus();
  uint16_t debugGetDeviceErrors();
  void debugClearDeviceErrors();

  void setRuntimeRadio(float freq, float bw, uint8_t sf, uint8_t cr, int8_t tx);
};

extern LinuxBoard board;
extern LinuxRadioDriver radio_driver;
extern LinuxRTCClock rtc_clock;
extern SensorManager sensors;

bool radio_init();
uint32_t radio_get_rng_seed();
void radio_set_driver(const char* driver_name);
void radio_set_params(float freq, float bw, uint8_t sf, uint8_t cr);
void radio_set_tx_power(int8_t dbm);
void radio_set_hw_config(const char* spi_dev_prefix, int spi_bus, int spi_cs, int spi_speed_hz,
                         int cs_pin,
                         int reset_pin, int busy_pin, int irq_pin,
                         int txen_pin, int rxen_pin,
                         bool use_dio3_tcxo,
                         bool use_dio2_rf_switch);
mesh::LocalIdentity radio_new_identity();
