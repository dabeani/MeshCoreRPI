#include "target.h"

#include <helpers/ArduinoHelpers.h>
#include <helpers/IdentityStore.h>
#include <helpers/SimpleMeshTables.h>

#include "MyMesh.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

#ifdef __linux__
#include <unistd.h>
#endif

StdRNG fast_rng;
SimpleMeshTables tables;
MyMesh the_mesh(board, radio_driver, *new ArduinoMillis(), fast_rng, rtc_clock, tables);

static std::atomic<bool> g_stop{false};

static void sig_handler(int) {
  g_stop.store(true);
}

namespace {

std::string trim(std::string value) {
  size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start])) != 0) {
    ++start;
  }
  size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
    --end;
  }
  return value.substr(start, end - start);
}

void loadEnvFileDefaults(const char* path) {
  std::ifstream file(path);
  if (!file.is_open()) return;

  std::string line;
  while (std::getline(file, line)) {
    const std::string t = trim(line);
    if (t.empty() || t[0] == '#') continue;

    const size_t eq = t.find('=');
    if (eq == std::string::npos || eq == 0) continue;

    const std::string key = trim(t.substr(0, eq));
    std::string value = trim(t.substr(eq + 1));
    if (key.empty()) continue;

    if (value.size() >= 2 &&
        ((value.front() == '"' && value.back() == '"') ||
         (value.front() == '\'' && value.back() == '\''))) {
      value = value.substr(1, value.size() - 2);
    }

    setenv(key.c_str(), value.c_str(), 1);
  }
}

void preloadRoleConfigEnv() {
  const char* override = std::getenv("RPI_CONFIG_FILE");
  if (override && override[0] != '\0') {
    loadEnvFileDefaults(override);
    return;
  }
  loadEnvFileDefaults("/etc/raspberrypimc/repeater.env");
}

void printStartupRadioInfo() {
  const auto cfg = radio_driver.getConfig();
  std::cout << "startup-config: "
            << "driver=" << radio_driver.getDriverName()
            << " freq_hz=" << cfg.frequency_hz
            << " bw_hz=" << cfg.bandwidth_hz
            << " sf=" << cfg.spreading_factor
            << " cr=" << cfg.coding_rate
            << " tx_dbm=" << cfg.tx_power_dbm
            << " spi_prefix=" << cfg.spi_dev_prefix
            << " spi_bus=" << cfg.spi_bus
            << " spi_cs=" << cfg.spi_cs
            << " spi_speed_hz=" << cfg.spi_speed_hz
            << " cs_pin=" << cfg.cs_pin
            << " reset_pin=" << cfg.reset_pin
            << " busy_pin=" << cfg.busy_pin
            << " irq_pin=" << cfg.irq_pin
            << " txen_pin=" << cfg.txen_pin
            << " rxen_pin=" << cfg.rxen_pin
            << " tcxo=" << (cfg.use_dio3_tcxo ? 1 : 0)
            << " dio2_rf=" << (cfg.use_dio2_rf_switch ? 1 : 0)
            << "\n";

  const uint8_t st = radio_driver.debugGetStatus();
  const uint16_t irq = radio_driver.debugGetIrqStatus();
  const uint16_t errs = radio_driver.debugGetDeviceErrors();

  char diag[700]{};
  std::snprintf(diag, sizeof(diag),
                "{\"driver\":\"%s\",\"status\":%u,\"irq\":%u,\"irq_hex\":\"0x%04X\",\"dev_errors\":%u,\"dev_errors_hex\":\"0x%04X\","
                "\"spi_dev_prefix\":\"%s\",\"spi_bus\":%d,\"spi_cs\":%d,\"spi_speed\":%d,"
                "\"freq\":%d,\"bw\":%d,\"sf\":%d,\"cr\":%d,\"tx\":%d,\"pre\":%d,\"sync\":\"0x%04X\","
                "\"cs_pin\":%d,\"reset_pin\":%d,\"busy_pin\":%d,\"irq_pin\":%d,\"txen\":%d,\"rxen\":%d,"
                "\"dio2_rf\":%d,\"tcxo\":%d,\"tcxo_voltage\":%u,\"tcxo_delay_us\":%u,"
                "\"last_rssi\":%.1f,\"last_snr\":%.2f,\"noise_floor\":%d}",
                radio_driver.getDriverName(), st, irq, irq, errs, errs,
                cfg.spi_dev_prefix.c_str(), cfg.spi_bus, cfg.spi_cs, cfg.spi_speed_hz,
                cfg.frequency_hz, cfg.bandwidth_hz, cfg.spreading_factor, cfg.coding_rate, cfg.tx_power_dbm,
                cfg.preamble_len, cfg.sync_word,
                cfg.cs_pin, cfg.reset_pin, cfg.busy_pin, cfg.irq_pin, cfg.txen_pin, cfg.rxen_pin,
                cfg.use_dio2_rf_switch ? 1 : 0, cfg.use_dio3_tcxo ? 1 : 0, cfg.tcxo_voltage, cfg.tcxo_delay_us,
                radio_driver.getLastRSSI(), radio_driver.getLastSNR(), radio_driver.getNoiseFloor());
  std::cout << "radio-diag: " << diag << "\n";
}

bool hasEnv(const char* name) {
  const char* v = std::getenv(name);
  return v != nullptr && v[0] != '\0';
}

int envInt(const char* name, int fallback) {
  const char* v = std::getenv(name);
  if (!v || v[0] == '\0') return fallback;
  try {
    return std::stoi(v);
  } catch (...) {
    return fallback;
  }
}

std::string envString(const char* name, const char* fallback) {
  const char* v = std::getenv(name);
  if (!v || v[0] == '\0') return std::string(fallback);
  return std::string(v);
}

bool envEnabled(const char* name, bool fallback) {
  const char* v = std::getenv(name);
  if (!v || v[0] == '\0') return fallback;
  return std::string(v) != "0";
}

}

int main(int argc, char** argv) {
  preloadRoleConfigEnv();

  const bool env_radio_override =
    hasEnv("RPI_FREQ_HZ") || hasEnv("RPI_SF") || hasEnv("RPI_BW_HZ") || hasEnv("RPI_CR") || hasEnv("RPI_TX_DBM");

  float freq_mhz = static_cast<float>(envInt("RPI_FREQ_HZ", 869525000)) / 1000000.0f;
  float bw_khz = static_cast<float>(envInt("RPI_BW_HZ", 250000)) / 1000.0f;
  uint8_t sf = static_cast<uint8_t>(envInt("RPI_SF", 11));
  uint8_t cr = static_cast<uint8_t>(envInt("RPI_CR", 5));
  int8_t tx_dbm = static_cast<int8_t>(envInt("RPI_TX_DBM", 22));
  bool runtime_radio_override = env_radio_override;
  std::string radio_driver_name = envString("RPI_RADIO_DRIVER", "sx1262");

  int spi_bus = envInt("RPI_SPI_BUS", 0);
  int spi_cs = envInt("RPI_SPI_CS", 0);
  int spi_speed_hz = envInt("RPI_SPI_SPEED_HZ", 8000000);
  std::string spi_dev_prefix = envString("RPI_SPI_DEV_PREFIX", "/dev/spidev");
  int cs_pin = envInt("RPI_CS_PIN", 21);
  int reset_pin = envInt("RPI_RESET_PIN", 18);
  int busy_pin = envInt("RPI_BUSY_PIN", 20);
  int irq_pin = envInt("RPI_IRQ_PIN", 16);
  int txen_pin = envInt("RPI_TXEN_PIN", -1);
  int rxen_pin = envInt("RPI_RXEN_PIN", -1);
  bool use_dio3_tcxo = envEnabled("RPI_USE_TCXO", false);
  bool use_dio2_rf_switch = envEnabled("RPI_USE_DIO2_RF", false);

  for (int i = 1; i < argc; ++i) {
    const std::string a(argv[i]);
    if (a == "--freq" && i + 1 < argc) {
      freq_mhz = std::stof(argv[++i]) / 1000000.0f;
      runtime_radio_override = true;
    }
    else if (a == "--sf" && i + 1 < argc) {
      sf = static_cast<uint8_t>(std::stoi(argv[++i]));
      runtime_radio_override = true;
    }
    else if (a == "--bw" && i + 1 < argc) {
      bw_khz = std::stof(argv[++i]) / 1000.0f;
      runtime_radio_override = true;
    }
    else if (a == "--cr" && i + 1 < argc) {
      cr = static_cast<uint8_t>(std::stoi(argv[++i]));
      runtime_radio_override = true;
    }
    else if (a == "--tx" && i + 1 < argc) {
      tx_dbm = static_cast<int8_t>(std::stoi(argv[++i]));
      runtime_radio_override = true;
    }
    else if (a == "--radio-driver" && i + 1 < argc) radio_driver_name = argv[++i];
    else if (a == "--spi-dev-prefix" && i + 1 < argc) spi_dev_prefix = argv[++i];
    else if (a == "--spi-bus" && i + 1 < argc) spi_bus = std::stoi(argv[++i]);
    else if (a == "--spi-cs" && i + 1 < argc) spi_cs = std::stoi(argv[++i]);
    else if (a == "--spi-speed" && i + 1 < argc) spi_speed_hz = std::stoi(argv[++i]);
    else if ((a == "--cs-pin" || a == "--spi-cs-pin") && i + 1 < argc) cs_pin = std::stoi(argv[++i]);
    else if (a == "--reset-pin" && i + 1 < argc) reset_pin = std::stoi(argv[++i]);
    else if (a == "--busy-pin" && i + 1 < argc) busy_pin = std::stoi(argv[++i]);
    else if (a == "--irq-pin" && i + 1 < argc) irq_pin = std::stoi(argv[++i]);
    else if (a == "--txen-pin" && i + 1 < argc) txen_pin = std::stoi(argv[++i]);
    else if (a == "--rxen-pin" && i + 1 < argc) rxen_pin = std::stoi(argv[++i]);
    else if (a == "--no-tcxo") use_dio3_tcxo = false;
    else if (a == "--no-dio2-rf") use_dio2_rf_switch = false;
    else if (a == "--help") {
      std::cout << "Usage: meshcore-rpi-native-repeater [--freq HZ] [--sf N] [--bw HZ] [--cr N] [--tx DBM]"
                   " [--radio-driver sx1262|sx127x]"
                   " [--spi-dev-prefix PATH] [--spi-bus N] [--spi-cs N] [--spi-speed HZ]"
                   " [--cs-pin N] [--reset-pin N] [--busy-pin N] [--irq-pin N] [--txen-pin N] [--rxen-pin N]"
                   " [--no-tcxo] [--no-dio2-rf]\n";
      return 0;
    }
  }

  radio_set_driver(radio_driver_name.c_str());
  radio_set_hw_config(spi_dev_prefix.c_str(), spi_bus, spi_cs, spi_speed_hz, cs_pin, reset_pin, busy_pin, irq_pin, txen_pin, rxen_pin,
                      use_dio3_tcxo, use_dio2_rf_switch);
  radio_set_params(freq_mhz, bw_khz, sf, cr);
  radio_set_tx_power(tx_dbm);

  try {
    std::signal(SIGINT, sig_handler);
    std::signal(SIGTERM, sig_handler);

    board.begin();
    if (!radio_init()) {
      std::cerr << "fatal: radio init failed\n";
      return 1;
    }

    fast_rng.begin(static_cast<long>(radio_get_rng_seed()));

    IdentityStore store(LittleFS, "/identity");
    store.begin();
    if (!store.load("_main", the_mesh.self_id)) {
      the_mesh.self_id = radio_new_identity();
      store.save("_main", the_mesh.self_id);
    }

    FILESYSTEM* fs = &LittleFS;
    sensors.begin();
    the_mesh.begin(fs);

    // begin() loads persisted prefs and may reset radio params; re-apply
    // explicit runtime CLI radio overrides after begin().
    if (runtime_radio_override) {
      radio_set_params(freq_mhz, bw_khz, sf, cr);
      radio_set_tx_power(tx_dbm);
    }

    printStartupRadioInfo();

    bool interactive_cli = true;
#ifdef __linux__
    interactive_cli = ::isatty(STDIN_FILENO) != 0;
#endif

    std::thread cli;
    if (interactive_cli) {
      cli = std::thread([&]() {
        std::string line;
        while (!g_stop.load()) {
          std::cout << "meshcore-repeater> " << std::flush;
          if (!std::getline(std::cin, line)) {
            g_stop.store(true);
            break;
          }
          if (line == "quit" || line == "exit") {
            g_stop.store(true);
            continue;
          }
          if (!line.empty()) {
            char reply[200]{};
            the_mesh.handleCommand(0, line.data(), reply);
            if (reply[0]) std::cout << reply << "\n";
          }
        }
      });
    }

    while (!g_stop.load()) {
      the_mesh.loop();
      sensors.loop();
      rtc_clock.tick();
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    if (cli.joinable()) cli.join();
  } catch (const std::exception& ex) {
    std::cerr << "fatal: " << ex.what() << "\n";
    return 1;
  }

  return 0;
}
