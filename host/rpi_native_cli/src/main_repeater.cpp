#include "target.h"

#include <helpers/ArduinoHelpers.h>
#include <helpers/IdentityStore.h>
#include <helpers/SimpleMeshTables.h>

#include "MyMesh.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>

StdRNG fast_rng;
SimpleMeshTables tables;
MyMesh the_mesh(board, radio_driver, *new ArduinoMillis(), fast_rng, rtc_clock, tables);

static std::atomic<bool> g_stop{false};

static void sig_handler(int) {
  g_stop.store(true);
}

int main(int argc, char** argv) {
  float freq_mhz = 869.525f;
  float bw_khz = 250.0f;
  uint8_t sf = 11;
  uint8_t cr = 5;
  int8_t tx_dbm = 22;
  bool runtime_radio_override = false;

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
                   " [--spi-bus N] [--spi-cs N] [--spi-speed HZ]"
                   " [--cs-pin N] [--reset-pin N] [--busy-pin N] [--irq-pin N] [--txen-pin N] [--rxen-pin N]"
                   " [--no-tcxo] [--no-dio2-rf]\n";
      return 0;
    }
  }

  radio_set_hw_config(spi_bus, spi_cs, spi_speed_hz, cs_pin, reset_pin, busy_pin, irq_pin, txen_pin, rxen_pin,
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

    std::thread cli([&]() {
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
