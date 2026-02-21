#include "target.h"

#include <random>

LinuxBoard board;

static SX1262LinuxRadio::Config g_cfg{};
LinuxRadioDriver radio_driver(g_cfg);
LinuxRTCClock rtc_clock;
SensorManager sensors;

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
