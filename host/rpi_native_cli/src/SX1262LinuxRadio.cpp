#include "SX1262LinuxRadio.h"

#ifdef __linux__
#include <dirent.h>
#include <fcntl.h>
#include <linux/spi/spidev.h>
#include <sys/ioctl.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
constexpr uint16_t IRQ_TX_DONE = 0x0001;
constexpr uint16_t IRQ_RX_DONE = 0x0002;
constexpr uint16_t IRQ_CRC_ERR = 0x0040;
constexpr uint16_t IRQ_TIMEOUT = 0x0200;

std::string gpioPath(int pin, const std::string& node) {
  return "/sys/class/gpio/gpio" + std::to_string(pin) + "/" + node;
}
}

SX1262LinuxRadio::SX1262LinuxRadio(const Config& cfg_) : cfg(cfg_) {}

SX1262LinuxRadio::~SX1262LinuxRadio() {
#ifdef __linux__
  if (spi_fd >= 0) {
    close(spi_fd);
    spi_fd = -1;
  }
#endif
}

int SX1262LinuxRadio::toSysfsPin(int pin) {
  if (pin < 0) return pin;

  if (sysfs_gpio_base < 0) {
    sysfs_gpio_base = 0;
#ifdef __linux__
    int min_base = -1;
    DIR* dir = opendir("/sys/class/gpio");
    if (dir != nullptr) {
      while (const dirent* ent = readdir(dir)) {
        const std::string name(ent->d_name);
        if (name.rfind("gpiochip", 0) != 0) continue;

        std::ifstream base_file("/sys/class/gpio/" + name + "/base");
        int base = -1;
        if (!(base_file >> base)) continue;

        if (base == 0) {
          min_base = 0;
          break;
        }
        if (base > 0 && (min_base < 0 || base < min_base)) {
          min_base = base;
        }
      }
      closedir(dir);
    }
    if (min_base > 0) {
      sysfs_gpio_base = min_base;
    }
#endif
  }

  if (sysfs_gpio_base > 0 && pin < sysfs_gpio_base) {
    return sysfs_gpio_base + pin;
  }
  return pin;
}

std::string SX1262LinuxRadio::gpioNodePath(int pin, const std::string& node) {
  return gpioPath(toSysfsPin(pin), node);
}

void SX1262LinuxRadio::openSpi() {
#ifdef __linux__
  const std::string dev = "/dev/spidev" + std::to_string(cfg.spi_bus) + "." + std::to_string(cfg.spi_cs);
  spi_fd = open(dev.c_str(), O_RDWR);
  if (spi_fd < 0) {
    throw std::runtime_error("failed to open SPI device: " + dev);
  }

  uint8_t mode = SPI_MODE_0;
  if (cfg.cs_pin >= 0) {
    // We'll assert CS manually with a GPIO.
    mode |= SPI_NO_CS;
  }
  uint8_t bits = 8;
  uint32_t speed = static_cast<uint32_t>(cfg.spi_speed_hz);

  ioctl(spi_fd, SPI_IOC_WR_MODE, &mode);
  ioctl(spi_fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
  ioctl(spi_fd, SPI_IOC_WR_MAX_SPEED_HZ, &speed);
#else
  throw std::runtime_error("SX1262LinuxRadio requires Linux SPI stack");
#endif
}

void SX1262LinuxRadio::spiTransfer(const uint8_t* tx, uint8_t* rx, size_t len) {
#ifdef __linux__
  if (len == 0) return;
  if (spi_fd < 0) throw std::runtime_error("SPI not opened");

  if (cfg.cs_pin >= 0) gpioWrite(cfg.cs_pin, 0);

  spi_ioc_transfer tr{};
  tr.tx_buf = reinterpret_cast<__u64>(tx);
  tr.rx_buf = reinterpret_cast<__u64>(rx);
  tr.len = static_cast<__u32>(len);
  tr.speed_hz = static_cast<__u32>(cfg.spi_speed_hz);
  tr.bits_per_word = 8;
  ioctl(spi_fd, SPI_IOC_MESSAGE(1), &tr);

  if (cfg.cs_pin >= 0) gpioWrite(cfg.cs_pin, 1);
#else
  (void)tx;
  if (rx && len > 0) std::memset(rx, 0, len);
#endif
}

void SX1262LinuxRadio::gpioExport(int pin) {
  if (pin < 0) return;

  const int sysfs_pin = toSysfsPin(pin);
  std::ofstream ex("/sys/class/gpio/export");
  ex << sysfs_pin;

  for (int i = 0; i < 50; ++i) {
    std::ifstream probe(gpioPath(sysfs_pin, "direction"));
    if (probe.good()) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

void SX1262LinuxRadio::gpioDirection(int pin, const char* mode) {
  if (pin < 0) return;

  std::ofstream dir(gpioNodePath(pin, "direction"));
  dir << mode;
}

void SX1262LinuxRadio::gpioWrite(int pin, int value) {
  if (pin < 0) return;

  std::ofstream v(gpioNodePath(pin, "value"));
  v << (value ? "1" : "0");
}

int SX1262LinuxRadio::gpioRead(int pin) {
  if (pin < 0) return 0;

  std::ifstream v(gpioNodePath(pin, "value"));
  int out = 0;
  v >> out;
  return out;
}

void SX1262LinuxRadio::gpioPulseReset() {
  if (cfg.reset_pin < 0) return;
  gpioWrite(cfg.reset_pin, 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  gpioWrite(cfg.reset_pin, 1);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
}

void SX1262LinuxRadio::waitBusyLow() {
  if (cfg.busy_pin < 0) return;
  for (int i = 0; i < 200; ++i) {
    if (gpioRead(cfg.busy_pin) == 0) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

void SX1262LinuxRadio::spiCommand(uint8_t cmd, const uint8_t* payload, int payload_len) {
#ifdef __linux__
  waitBusyLow();
  std::string tx;
  tx.resize(static_cast<size_t>(1 + payload_len));
  tx[0] = static_cast<char>(cmd);
  if (payload_len > 0) {
    std::memcpy(&tx[1], payload, static_cast<size_t>(payload_len));
  }
  std::string rx(tx.size(), '\0');

  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());
#else
  (void)cmd; (void)payload; (void)payload_len;
#endif
}

void SX1262LinuxRadio::spiReadCommand(uint8_t cmd, uint8_t* out, int out_len) {
#ifdef __linux__
  waitBusyLow();
  std::string tx;
  tx.resize(static_cast<size_t>(2 + out_len));
  tx[0] = static_cast<char>(cmd);
  tx[1] = 0x00;
  std::string rx(tx.size(), '\0');

  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());

  if (out_len > 0) {
    std::memcpy(out, rx.data() + 2, static_cast<size_t>(out_len));
  }
#else
  (void)cmd;
  if (out && out_len > 0) {
    std::memset(out, 0, static_cast<size_t>(out_len));
  }
#endif
}

uint8_t SX1262LinuxRadio::spiReadStatusByte(uint8_t cmd) {
#ifdef __linux__
  waitBusyLow();
  uint8_t tx[2] = {cmd, 0x00};
  uint8_t rx[2] = {0, 0};

  spiTransfer(tx, rx, sizeof(tx));
  return rx[1];
#else
  (void)cmd;
  return 0;
#endif
}

void SX1262LinuxRadio::sxSetStandby() {
  uint8_t p = 0x00;
  spiCommand(0x80, &p, 1);
}

void SX1262LinuxRadio::sxSetRegulatorMode(uint8_t mode) {
  spiCommand(0x96, &mode, 1);
}

void SX1262LinuxRadio::sxSetPacketTypeLora() {
  uint8_t p = 0x01;
  spiCommand(0x8A, &p, 1);
}

void SX1262LinuxRadio::sxSetDio2AsRfSwitchCtrl(bool enable) {
  uint8_t p = enable ? 0x01 : 0x00;
  spiCommand(0x9D, &p, 1);
}

void SX1262LinuxRadio::sxSetDio3AsTcxoCtrl(uint8_t voltage, uint32_t delay_us) {
  // delay is in units of 15.625us (= 1/64 ms). Convert microseconds -> units.
  const uint32_t units = std::min<uint32_t>(0xFFFFFFu, (delay_us * 64u + 999u) / 1000u);
  uint8_t p[4] = {
    voltage,
    static_cast<uint8_t>((units >> 16) & 0xFF),
    static_cast<uint8_t>((units >> 8) & 0xFF),
    static_cast<uint8_t>(units & 0xFF),
  };
  spiCommand(0x97, p, 4);
}

void SX1262LinuxRadio::sxSetPaConfig() {
  uint8_t p[4] = {
    0x04, // duty cycle
    0x07, // hp max
    0x00, // deviceSel (SX1262)
    0x01, // paLut
  };
  spiCommand(0x95, p, 4);
}

void SX1262LinuxRadio::sxSetRfFrequency(int hz) {
  uint32_t rf = static_cast<uint32_t>((static_cast<uint64_t>(hz) * 33554432ULL) / 32000000ULL);
  uint8_t p[4] = {
    static_cast<uint8_t>((rf >> 24) & 0xFF),
    static_cast<uint8_t>((rf >> 16) & 0xFF),
    static_cast<uint8_t>((rf >> 8) & 0xFF),
    static_cast<uint8_t>(rf & 0xFF),
  };
  spiCommand(0x86, p, 4);
}

void SX1262LinuxRadio::sxSetBufferBase(uint8_t tx_base, uint8_t rx_base) {
  uint8_t p[2] = {tx_base, rx_base};
  spiCommand(0x8F, p, 2);
}

void SX1262LinuxRadio::sxSetModulation() {
  uint8_t bw = 0x05;
  if (cfg.bandwidth_hz <= 62500) bw = 0x03;
  else if (cfg.bandwidth_hz <= 125000) bw = 0x04;
  else if (cfg.bandwidth_hz <= 250000) bw = 0x05;
  else bw = 0x06;

  uint8_t cr = 0x01;
  if (cfg.coding_rate >= 8) cr = 0x04;
  else if (cfg.coding_rate == 7) cr = 0x03;
  else if (cfg.coding_rate == 6) cr = 0x02;

  const double symbol_ms = (std::pow(2.0, cfg.spreading_factor) / (static_cast<double>(cfg.bandwidth_hz) / 1000.0));
  uint8_t ldro = symbol_ms > 16.0 ? 0x01 : 0x00;

  uint8_t p[4] = {
    static_cast<uint8_t>(cfg.spreading_factor),
    bw,
    cr,
    ldro,
  };
  spiCommand(0x8B, p, 4);
}

void SX1262LinuxRadio::sxSetPacketParams(int payload_len) {
  if (payload_len < 0) payload_len = 0;
  if (payload_len > 255) payload_len = 255;

  uint8_t p[6] = {
    static_cast<uint8_t>((cfg.preamble_len >> 8) & 0xFF),
    static_cast<uint8_t>(cfg.preamble_len & 0xFF),
    0x00, // variable length header
    static_cast<uint8_t>(payload_len),
    0x01, // CRC on
    0x00, // standard IQ
  };
  spiCommand(0x8C, p, 6);
}

void SX1262LinuxRadio::sxSetTxParams(int power_dbm) {
  const int p = std::max(-9, std::min(22, power_dbm));
  uint8_t payload[2] = {static_cast<uint8_t>(p & 0xFF), 0x02};
  spiCommand(0x8E, payload, 2);
}

void SX1262LinuxRadio::sxSetDioIrqMask(uint16_t mask) {
  uint8_t p[8] = {
    static_cast<uint8_t>((mask >> 8) & 0xFF), static_cast<uint8_t>(mask & 0xFF),
    static_cast<uint8_t>((mask >> 8) & 0xFF), static_cast<uint8_t>(mask & 0xFF),
    0x00, 0x00, 0x00, 0x00,
  };
  spiCommand(0x08, p, 8);
}

void SX1262LinuxRadio::sxClearIrq(uint16_t mask) {
  uint8_t p[2] = {static_cast<uint8_t>((mask >> 8) & 0xFF), static_cast<uint8_t>(mask & 0xFF)};
  spiCommand(0x02, p, 2);
}

uint16_t SX1262LinuxRadio::sxGetIrq() {
  uint8_t p[2] = {0, 0};
  spiReadCommand(0x12, p, 2);
  return static_cast<uint16_t>((p[0] << 8) | p[1]);
}

uint16_t SX1262LinuxRadio::sxGetDeviceErrors() {
  uint8_t p[2] = {0, 0};
  spiReadCommand(0x17, p, 2);
  return static_cast<uint16_t>((p[0] << 8) | p[1]);
}

void SX1262LinuxRadio::sxClearDeviceErrors() {
  uint8_t p[2] = {0x00, 0x00};
  spiCommand(0x07, p, 2);
}

void SX1262LinuxRadio::sxSetRxContinuous() {
  uint8_t p[3] = {0xFF, 0xFF, 0xFF};
  spiCommand(0x82, p, 3);
  rx_mode = true;
}

void SX1262LinuxRadio::sxSetTx() {
  uint8_t p[3] = {0xFF, 0xFF, 0xFF};
  spiCommand(0x83, p, 3);
  rx_mode = false;
}

void SX1262LinuxRadio::sxWriteBuffer(const uint8_t* data, int len) {
#ifdef __linux__
  waitBusyLow();
  std::string tx;
  tx.resize(static_cast<size_t>(2 + len));
  tx[0] = static_cast<char>(0x0E);
  tx[1] = 0x00;
  std::memcpy(&tx[2], data, static_cast<size_t>(len));
  std::string rx(tx.size(), '\0');

  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());
#else
  (void)data; (void)len;
#endif
}

int SX1262LinuxRadio::sxReadBuffer(uint8_t* out, int max_len) {
#ifdef __linux__
  uint8_t st[2] = {0, 0};
  spiReadCommand(0x13, st, 2);
  int payload_len = st[0];
  uint8_t offset = st[1];
  if (payload_len <= 0) return 0;
  if (payload_len > max_len) payload_len = max_len;

  waitBusyLow();
  std::string tx;
  tx.resize(static_cast<size_t>(3 + payload_len));
  tx[0] = static_cast<char>(0x1E);
  tx[1] = static_cast<char>(offset);
  tx[2] = 0x00;
  std::string rx(tx.size(), '\0');

  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());

  std::memcpy(out, rx.data() + 3, static_cast<size_t>(payload_len));
  return payload_len;
#else
  (void)out; (void)max_len;
  return 0;
#endif
}

void SX1262LinuxRadio::sxUpdateSignalMetrics() {
  uint8_t st[3] = {0, 0, 0};
  spiReadCommand(0x14, st, 3);
  const float rssi = -0.5f * static_cast<float>(st[0]);
  const int8_t snr_raw = static_cast<int8_t>(st[1]);
  last_rssi = rssi;
  last_snr = static_cast<float>(snr_raw) / 4.0f;
}

void SX1262LinuxRadio::begin() {
#ifndef __linux__
  throw std::runtime_error("RaspberryPiMC_native runtime is Linux-only");
#endif

  // GPIO setup (sysfs) for SX1262 control pins.
  gpioExport(cfg.cs_pin);
  gpioExport(cfg.reset_pin);
  gpioExport(cfg.busy_pin);
  gpioExport(cfg.irq_pin);
  if (cfg.txen_pin >= 0) gpioExport(cfg.txen_pin);
  if (cfg.rxen_pin >= 0) gpioExport(cfg.rxen_pin);

  if (cfg.cs_pin >= 0) gpioDirection(cfg.cs_pin, "out");
  gpioDirection(cfg.reset_pin, "out");
  gpioDirection(cfg.busy_pin, "in");
  gpioDirection(cfg.irq_pin, "in");
  if (cfg.txen_pin >= 0) gpioDirection(cfg.txen_pin, "out");
  if (cfg.rxen_pin >= 0) gpioDirection(cfg.rxen_pin, "out");

  // Inactive high for manual CS.
  if (cfg.cs_pin >= 0) gpioWrite(cfg.cs_pin, 1);

  openSpi();
  gpioPulseReset();

  sxSetStandby();

  if (cfg.use_dio3_tcxo) {
    sxSetDio3AsTcxoCtrl(cfg.tcxo_voltage, cfg.tcxo_delay_us);
    // Guard wait after reset; some boards need a few ms before RF init.
    std::this_thread::sleep_for(std::chrono::microseconds(cfg.tcxo_delay_us));
  }

  sxSetRegulatorMode(0x01);
  sxClearDeviceErrors();

  sxSetPacketTypeLora();
  sxSetDio2AsRfSwitchCtrl(cfg.use_dio2_rf_switch);
  sxSetPaConfig();
  sxSetRfFrequency(cfg.frequency_hz);
  sxSetTxParams(cfg.tx_power_dbm);
  sxSetModulation();
  sxSetPacketParams(0);
  sxSetBufferBase(0x00, 0x80);
  sxSetDioIrqMask(static_cast<uint16_t>(IRQ_TX_DONE | IRQ_RX_DONE | IRQ_CRC_ERR | IRQ_TIMEOUT));
  sxClearIrq();
  sxSetRxContinuous();
}

uint8_t SX1262LinuxRadio::debugGetStatus() {
  return spiReadStatusByte(0xC0);
}

uint16_t SX1262LinuxRadio::debugGetIrqStatus() {
  return sxGetIrq();
}

uint16_t SX1262LinuxRadio::debugGetDeviceErrors() {
  return sxGetDeviceErrors();
}

void SX1262LinuxRadio::debugClearDeviceErrors() {
  sxClearDeviceErrors();
}

int SX1262LinuxRadio::recvRaw(uint8_t* bytes, int sz) {
  const uint16_t irq = sxGetIrq();
  if ((irq & IRQ_RX_DONE) == 0) {
    return 0;
  }

  sxClearIrq();
  if ((irq & IRQ_CRC_ERR) != 0) {
    sxSetRxContinuous();
    return 0;
  }

  const int len = sxReadBuffer(bytes, sz);
  sxUpdateSignalMetrics();
  sxSetRxContinuous();
  return len;
}

uint32_t SX1262LinuxRadio::getEstAirtimeFor(int len_bytes) {
  const double bw = static_cast<double>(cfg.bandwidth_hz);
  const double sf = static_cast<double>(cfg.spreading_factor);
  const double cr = static_cast<double>(cfg.coding_rate);
  const double tsym = std::pow(2.0, sf) / bw;
  const double de = (tsym > 0.016) ? 1.0 : 0.0;
  const double ih = 0.0;
  const double crc = 1.0;
  const double payload_symb_nb = 8.0 + std::max(0.0,
    std::ceil((8.0 * len_bytes - 4.0 * sf + 28.0 + 16.0 * crc - 20.0 * ih) / (4.0 * (sf - 2.0 * de))) * cr);
  const double preamble = (cfg.preamble_len + 4.25) * tsym;
  const double payload = payload_symb_nb * tsym;
  return static_cast<uint32_t>((preamble + payload) * 1000.0);
}

float SX1262LinuxRadio::packetScore(float snr, int packet_len) {
  const float s = std::max(-20.0f, std::min(10.0f, snr));
  const float q = (s + 20.0f) / 30.0f;
  const float penalty = 1.0f - std::min(1.0f, static_cast<float>(packet_len) / 255.0f);
  return std::max(0.0f, std::min(1.0f, q * (0.4f + 0.6f * penalty)));
}

bool SX1262LinuxRadio::startSendRaw(const uint8_t* bytes, int len) {
  if (cfg.txen_pin >= 0) gpioWrite(cfg.txen_pin, 1);
  if (cfg.rxen_pin >= 0) gpioWrite(cfg.rxen_pin, 0);
  sxClearIrq();
  sxSetPacketParams(len);
  sxWriteBuffer(bytes, len);
  sxSetTx();
  tx_pending = true;
  return true;
}

bool SX1262LinuxRadio::isSendComplete() {
  if (!tx_pending) return false;
  const uint16_t irq = sxGetIrq();
  if ((irq & IRQ_TIMEOUT) != 0) {
    sxClearIrq();
    tx_pending = false;
    return false;
  }
  if ((irq & IRQ_TX_DONE) == 0) return false;
  sxClearIrq();
  tx_pending = false;
  return true;
}

void SX1262LinuxRadio::onSendFinished() {
  if (cfg.txen_pin >= 0) gpioWrite(cfg.txen_pin, 0);
  if (cfg.rxen_pin >= 0) gpioWrite(cfg.rxen_pin, 1);
  sxSetRxContinuous();
}

bool SX1262LinuxRadio::isInRecvMode() const {
  return rx_mode && !tx_pending;
}

bool SX1262LinuxRadio::isReceiving() {
  return gpioRead(cfg.busy_pin) != 0;
}

float SX1262LinuxRadio::getLastRSSI() const {
  return last_rssi;
}

float SX1262LinuxRadio::getLastSNR() const {
  return last_snr;
}
