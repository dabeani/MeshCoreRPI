#include "SX1262LinuxRadio.h"

#include <Packet.h>
#include <Dispatcher.h>
#include <helpers/StaticPoolPacketManager.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <random>
#include <string>
#include <thread>

class LinuxMillis : public mesh::MillisecondClock {
public:
  unsigned long getMillis() override {
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<unsigned long>(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
  }
};

class NativeRepeater : public mesh::Dispatcher {
  uint8_t seen[128][MAX_HASH_SIZE]{};
  int seen_idx = 0;
public:
  NativeRepeater(mesh::Radio& radio, mesh::MillisecondClock& ms, mesh::PacketManager& mgr)
    : mesh::Dispatcher(radio, ms, mgr) {}

protected:
  mesh::DispatcherAction onRecvPacket(mesh::Packet* pkt) override {
    uint8_t h[MAX_HASH_SIZE];
    pkt->calculatePacketHash(h);
    for (int i = 0; i < 128; ++i) {
      if (std::memcmp(seen[i], h, MAX_HASH_SIZE) == 0) {
        return ACTION_RELEASE;
      }
    }
    std::memcpy(seen[seen_idx], h, MAX_HASH_SIZE);
    seen_idx = (seen_idx + 1) % 128;

    if (pkt->isRouteFlood() || pkt->isRouteDirect()) {
      return ACTION_RETRANSMIT_DELAYED(1, 20);
    }
    return ACTION_RELEASE;
  }
};

static std::atomic<bool> g_stop{false};

static void sig_handler(int) {
  g_stop.store(true);
}

int main(int argc, char** argv) {
  SX1262LinuxRadio::Config cfg;

  for (int i = 1; i < argc; ++i) {
    const std::string a(argv[i]);
    if (a == "--freq" && i + 1 < argc) cfg.frequency_hz = std::stoi(argv[++i]);
    else if (a == "--sf" && i + 1 < argc) cfg.spreading_factor = std::stoi(argv[++i]);
    else if (a == "--bw" && i + 1 < argc) cfg.bandwidth_hz = std::stoi(argv[++i]);
    else if (a == "--cr" && i + 1 < argc) cfg.coding_rate = std::stoi(argv[++i]);
    else if (a == "--tx" && i + 1 < argc) cfg.tx_power_dbm = std::stoi(argv[++i]);
    else if (a == "--help") {
      std::cout << "Usage: meshcore-rpi-native [--freq HZ] [--sf N] [--bw HZ] [--cr N] [--tx DBM]\n";
      return 0;
    }
  }

  try {
    SX1262LinuxRadio radio(cfg);
    LinuxMillis ms;
    StaticPoolPacketManager pool(128);
    NativeRepeater repeater(radio, ms, pool);

    std::signal(SIGINT, sig_handler);
    std::signal(SIGTERM, sig_handler);

    repeater.begin();

    std::thread cli([&]() {
      std::string line;
      while (!g_stop.load()) {
        std::cout << "meshcore-native> " << std::flush;
        if (!std::getline(std::cin, line)) {
          g_stop.store(true);
          break;
        }
        if (line == "quit" || line == "exit") {
          g_stop.store(true);
        } else if (line == "stats") {
          std::cout << "sent_flood=" << repeater.getNumSentFlood()
                    << " recv_flood=" << repeater.getNumRecvFlood()
                    << " sent_direct=" << repeater.getNumSentDirect()
                    << " recv_direct=" << repeater.getNumRecvDirect()
                    << " air_tx_ms=" << repeater.getTotalAirTime()
                    << " air_rx_ms=" << repeater.getReceiveAirTime()
                    << " rssi=" << radio.getLastRSSI()
                    << " snr=" << radio.getLastSNR()
                    << "\n";
        } else if (!line.empty()) {
          std::cout << "commands: stats, quit\n";
        }
      }
    });

    while (!g_stop.load()) {
      repeater.loop();
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    if (cli.joinable()) cli.join();
  } catch (const std::exception& ex) {
    std::cerr << "fatal: " << ex.what() << "\n";
    return 1;
  }

  return 0;
}
