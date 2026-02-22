#include "LinuxTcpSerialInterface.h"
#include "target.h"

#include <helpers/ArduinoHelpers.h>
#include <helpers/SimpleMeshTables.h>

#include "DataStore.h"
#include "MyMesh.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>

StdRNG fast_rng;
SimpleMeshTables tables;
DataStore store(LittleFS, rtc_clock);
MyMesh the_mesh(radio_driver, fast_rng, rtc_clock, tables, store, nullptr);

static std::atomic<bool> g_stop{false};

static void sig_handler(int) {
  g_stop.store(true);
}

int main(int argc, char** argv) {
  int tcp_port = 5000;
  float freq_mhz = 869.525f;
  float bw_khz = 250.0f;
  uint8_t sf = 11;
  uint8_t cr = 5;
  int8_t tx_dbm = 22;
  bool runtime_radio_override = false;
  std::string radio_driver_name = "sx1262";

  int spi_bus = 0;
  int spi_cs = 0;
  int spi_speed_hz = 8000000;
  std::string spi_dev_prefix = "/dev/spidev";
  int cs_pin = 21;
  int reset_pin = 18;
  int busy_pin = 20;
  int irq_pin = 16;
  int txen_pin = -1;
  int rxen_pin = -1;
  bool use_dio3_tcxo = true;
  bool use_dio2_rf_switch = true;

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
    else if (a == "--tcp-port" && i + 1 < argc) tcp_port = std::stoi(argv[++i]);
    else if (a == "--help") {
      std::cout << "Usage: meshcore-rpi-native-companion [--freq HZ] [--sf N] [--bw HZ] [--cr N] [--tx DBM] [--tcp-port N]"
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
    the_mesh.begin(false);

    // begin() loads persisted prefs and may reset radio params; re-apply
    // explicit runtime CLI radio overrides after begin().
    if (runtime_radio_override) {
      radio_set_params(freq_mhz, bw_khz, sf, cr);
      radio_set_tx_power(tx_dbm);
    }

    LinuxTcpSerialInterface serial_interface(tcp_port);
    the_mesh.startInterface(serial_interface);

    while (!g_stop.load()) {
      the_mesh.loop();
      sensors.loop();
      rtc_clock.tick();
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  } catch (const std::exception& ex) {
    std::cerr << "fatal: " << ex.what() << "\n";
    return 1;
  }

  return 0;
}
