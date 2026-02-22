#include "target.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>

LinuxBoard board;

static SX1262LinuxRadio::Config g_cfg{};
LinuxRadioDriver radio_driver(g_cfg);
LinuxRTCClock rtc_clock;
SensorManager sensors;

namespace {

bool readFileString(const std::filesystem::path& path, std::string& out) {
  std::ifstream file(path);
  if (!file.is_open()) {
    return false;
  }
  std::getline(file, out);
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ' || out.back() == '\t')) {
    out.pop_back();
  }
  return !out.empty();
}

bool readFileInt64(const std::filesystem::path& path, int64_t& out) {
  std::ifstream file(path);
  if (!file.is_open()) {
    return false;
  }
  file >> out;
  return !file.fail();
}

bool isBatterySupply(const std::filesystem::path& dir) {
  std::string type;
  return readFileString(dir / "type", type) && type == "Battery";
}

bool isExternalSupplyType(const std::string& type) {
  return type == "Mains" || type == "USB" || type == "USB_DCP" ||
         type == "USB_CDP" || type == "USB_ACA" || type == "USB_PD";
}

bool getSysfsBatteryMilliVolts(uint16_t& battery_mv) {
  std::error_code ec;
  const std::filesystem::path root("/sys/class/power_supply");
  if (!std::filesystem::exists(root, ec)) {
    return false;
  }

  for (const auto& entry : std::filesystem::directory_iterator(root, ec)) {
    if (ec || !entry.is_directory()) {
      continue;
    }
    const auto dir = entry.path();
    if (!isBatterySupply(dir)) {
      continue;
    }

    int64_t microvolts = 0;
    if (!readFileInt64(dir / "voltage_now", microvolts) && !readFileInt64(dir / "voltage_avg", microvolts)) {
      continue;
    }
    if (microvolts <= 0) {
      continue;
    }

    const int64_t mv = microvolts / 1000;
    if (mv <= 0) {
      continue;
    }
    battery_mv = static_cast<uint16_t>(mv > 65535 ? 65535 : mv);
    return true;
  }
  return false;
}

bool hasBatterySupply() {
  std::error_code ec;
  const std::filesystem::path root("/sys/class/power_supply");
  if (!std::filesystem::exists(root, ec)) {
    return false;
  }

  for (const auto& entry : std::filesystem::directory_iterator(root, ec)) {
    if (ec || !entry.is_directory()) {
      continue;
    }
    if (isBatterySupply(entry.path())) {
      return true;
    }
  }
  return false;
}

bool hasOnlineExternalSupply() {
  std::error_code ec;
  const std::filesystem::path root("/sys/class/power_supply");
  if (!std::filesystem::exists(root, ec)) {
    return false;
  }

  for (const auto& entry : std::filesystem::directory_iterator(root, ec)) {
    if (ec || !entry.is_directory()) {
      continue;
    }

    std::string type;
    if (!readFileString(entry.path() / "type", type) || !isExternalSupplyType(type)) {
      continue;
    }

    int64_t online = 0;
    if (readFileInt64(entry.path() / "online", online) && online > 0) {
      return true;
    }
  }
  return false;
}

bool getThermalZone0Celsius(float& out_temp_c) {
  int64_t milli_c = 0;
  if (!readFileInt64("/sys/class/thermal/thermal_zone0/temp", milli_c)) {
    return false;
  }
  out_temp_c = static_cast<float>(milli_c) / 1000.0f;
  return true;
}

}

void LinuxBoard::begin() {
  boot_voltage_mv = getBattMilliVolts();
}

bool LinuxBoard::setAdcMultiplier(float multiplier) {
  if (multiplier <= 0.0f) {
    adc_multiplier = 1.0f;
    return true;
  }
  adc_multiplier = multiplier;
  return true;
}

uint16_t LinuxBoard::getBattMilliVolts() {
  uint16_t measured_mv = 0;
  uint32_t base_mv = (boot_voltage_mv > 0) ? boot_voltage_mv : 5000;
  if (getSysfsBatteryMilliVolts(measured_mv)) {
    base_mv = measured_mv;
  }

  const float scaled = static_cast<float>(base_mv) * adc_multiplier;
  if (scaled <= 0.0f) {
    return 0;
  }
  if (scaled >= 65535.0f) {
    return 65535;
  }
  return static_cast<uint16_t>(scaled + 0.5f);
}

float LinuxBoard::getMCUTemperature() {
  float temp_c = NAN;
  if (getThermalZone0Celsius(temp_c)) {
    return temp_c;
  }
  return 25.0f;
}

void LinuxBoard::reboot() {
  std::exit(0);
}

bool LinuxBoard::isExternalPowered() {
  if (hasOnlineExternalSupply()) {
    return true;
  }
  if (hasBatterySupply()) {
    return false;
  }
  return true;
}

void LinuxRadioDriver::setRuntimeRadio(float freq, float bw, uint8_t sf, uint8_t cr, int8_t tx) {
  Config cfg = g_cfg;
  cfg.frequency_hz = static_cast<int>(freq * 1000000.0f);
  cfg.bandwidth_hz = static_cast<int>(bw * 1000.0f);
  cfg.spreading_factor = sf;
  cfg.coding_rate = cr;
  cfg.tx_power_dbm = tx;
  g_cfg = cfg;
  // Apply immediately so begin()/TX uses updated settings.
  this->setConfig(g_cfg);
}

bool radio_init() {
  rtc_clock.begin();
  LittleFS.begin();
  // Apply any config changes that happened before init.
  radio_driver.setConfig(g_cfg);
  radio_driver.begin();
  return true;
}

uint32_t radio_get_rng_seed() {
  static std::mt19937 rng{std::random_device{}()};
  return rng();
}

void radio_set_params(float freq, float bw, uint8_t sf, uint8_t cr) {
  radio_driver.setRuntimeRadio(freq, bw, sf, cr, 22);
}

void radio_set_tx_power(int8_t dbm) {
  radio_driver.setRuntimeRadio(static_cast<float>(g_cfg.frequency_hz) / 1000000.0f,
                               static_cast<float>(g_cfg.bandwidth_hz) / 1000.0f,
                               static_cast<uint8_t>(g_cfg.spreading_factor),
                               static_cast<uint8_t>(g_cfg.coding_rate),
                               dbm);
}

void radio_set_hw_config(int spi_bus, int spi_cs, int spi_speed_hz,
                         int cs_pin,
                         int reset_pin, int busy_pin, int irq_pin,
                         int txen_pin, int rxen_pin,
                         bool use_dio3_tcxo,
                         bool use_dio2_rf_switch) {
  g_cfg.spi_bus = spi_bus;
  g_cfg.spi_cs = spi_cs;
  g_cfg.spi_speed_hz = spi_speed_hz;
  g_cfg.cs_pin = cs_pin;
  g_cfg.reset_pin = reset_pin;
  g_cfg.busy_pin = busy_pin;
  g_cfg.irq_pin = irq_pin;
  g_cfg.txen_pin = txen_pin;
  g_cfg.rxen_pin = rxen_pin;
  g_cfg.use_dio3_tcxo = use_dio3_tcxo;
  g_cfg.use_dio2_rf_switch = use_dio2_rf_switch;
  radio_driver.setConfig(g_cfg);
}

mesh::LocalIdentity radio_new_identity() {
  StdRNG rng;
  rng.begin(static_cast<long>(radio_get_rng_seed()));
  return mesh::LocalIdentity(&rng);
}
