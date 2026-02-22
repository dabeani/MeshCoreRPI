#include "SX127xLinuxRadio.h"

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
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
constexpr uint8_t REG_FIFO = 0x00;
constexpr uint8_t REG_OP_MODE = 0x01;
constexpr uint8_t REG_FRF_MSB = 0x06;
constexpr uint8_t REG_FRF_MID = 0x07;
constexpr uint8_t REG_FRF_LSB = 0x08;
constexpr uint8_t REG_PA_CONFIG = 0x09;
constexpr uint8_t REG_LNA = 0x0C;
constexpr uint8_t REG_FIFO_ADDR_PTR = 0x0D;
constexpr uint8_t REG_FIFO_TX_BASE_ADDR = 0x0E;
constexpr uint8_t REG_FIFO_RX_BASE_ADDR = 0x0F;
constexpr uint8_t REG_FIFO_RX_CURRENT_ADDR = 0x10;
constexpr uint8_t REG_IRQ_FLAGS = 0x12;
constexpr uint8_t REG_RX_NB_BYTES = 0x13;
constexpr uint8_t REG_PKT_SNR_VALUE = 0x19;
constexpr uint8_t REG_PKT_RSSI_VALUE = 0x1A;
constexpr uint8_t REG_RSSI_VALUE = 0x1B;
constexpr uint8_t REG_MODEM_CONFIG_1 = 0x1D;
constexpr uint8_t REG_MODEM_CONFIG_2 = 0x1E;
constexpr uint8_t REG_PREAMBLE_MSB = 0x20;
constexpr uint8_t REG_PREAMBLE_LSB = 0x21;
constexpr uint8_t REG_PAYLOAD_LENGTH = 0x22;
constexpr uint8_t REG_MODEM_CONFIG_3 = 0x26;
constexpr uint8_t REG_SYNC_WORD = 0x39;

constexpr uint8_t LONG_RANGE_MODE = 0x80;
constexpr uint8_t MODE_SLEEP = 0x00;
constexpr uint8_t MODE_STDBY = 0x01;
constexpr uint8_t MODE_TX = 0x03;
constexpr uint8_t MODE_RX_CONT = 0x05;

constexpr uint8_t IRQ_RX_TIMEOUT = 0x80;
constexpr uint8_t IRQ_RX_DONE = 0x40;
constexpr uint8_t IRQ_PAYLOAD_CRC_ERROR = 0x20;
constexpr uint8_t IRQ_TX_DONE = 0x08;

std::string gpioPath(int pin, const std::string& node) {
  return "/sys/class/gpio/gpio" + std::to_string(pin) + "/" + node;
}
}

SX127xLinuxRadio::SX127xLinuxRadio(const Config& cfg_) : cfg(cfg_) {}

SX127xLinuxRadio::~SX127xLinuxRadio() {
#ifdef __linux__
  if (spi_fd >= 0) {
    close(spi_fd);
    spi_fd = -1;
  }
#endif
}

int SX127xLinuxRadio::toSysfsPin(int pin) {
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

std::string SX127xLinuxRadio::gpioNodePath(int pin, const std::string& node) {
  return gpioPath(toSysfsPin(pin), node);
}

void SX127xLinuxRadio::openSpi() {
#ifdef __linux__
  const std::string dev = cfg.spi_dev_prefix + std::to_string(cfg.spi_bus) + "." + std::to_string(cfg.spi_cs);
  spi_fd = open(dev.c_str(), O_RDWR);
  if (spi_fd < 0) {
    throw std::runtime_error("failed to open SPI device: " + dev);
  }

  uint8_t mode = SPI_MODE_0;
  if (cfg.cs_pin >= 0) {
    mode |= SPI_NO_CS;
  }
  uint8_t bits = 8;
  uint32_t speed = static_cast<uint32_t>(cfg.spi_speed_hz);

  ioctl(spi_fd, SPI_IOC_WR_MODE, &mode);
  ioctl(spi_fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
  ioctl(spi_fd, SPI_IOC_WR_MAX_SPEED_HZ, &speed);
#else
  throw std::runtime_error("SX127xLinuxRadio requires Linux SPI stack");
#endif
}

void SX127xLinuxRadio::spiTransfer(const uint8_t* tx, uint8_t* rx, size_t len) {
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

void SX127xLinuxRadio::gpioExport(int pin) {
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

void SX127xLinuxRadio::gpioDirection(int pin, const char* mode) {
  if (pin < 0) return;

  std::ofstream dir(gpioNodePath(pin, "direction"));
  dir << mode;
}

void SX127xLinuxRadio::gpioWrite(int pin, int value) {
  if (pin < 0) return;

  std::ofstream v(gpioNodePath(pin, "value"));
  v << (value ? "1" : "0");
}

int SX127xLinuxRadio::gpioRead(int pin) {
  if (pin < 0) return 0;

  std::ifstream v(gpioNodePath(pin, "value"));
  int out = 0;
  v >> out;
  return out;
}

void SX127xLinuxRadio::gpioPulseReset() {
  if (cfg.reset_pin < 0) return;
  gpioWrite(cfg.reset_pin, 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  gpioWrite(cfg.reset_pin, 1);
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

uint8_t SX127xLinuxRadio::readReg(uint8_t reg) {
  uint8_t tx[2] = {static_cast<uint8_t>(reg & 0x7F), 0x00};
  uint8_t rx[2] = {0, 0};
  spiTransfer(tx, rx, sizeof(tx));
  return rx[1];
}

void SX127xLinuxRadio::writeReg(uint8_t reg, uint8_t val) {
  uint8_t tx[2] = {static_cast<uint8_t>(reg | 0x80), val};
  uint8_t rx[2] = {0, 0};
  spiTransfer(tx, rx, sizeof(tx));
}

void SX127xLinuxRadio::writeBurst(uint8_t reg, const uint8_t* data, int len) {
  std::string tx;
  tx.resize(static_cast<size_t>(len + 1));
  tx[0] = static_cast<char>(reg | 0x80);
  if (len > 0) {
    std::memcpy(&tx[1], data, static_cast<size_t>(len));
  }
  std::string rx(tx.size(), '\0');
  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());
}

void SX127xLinuxRadio::readBurst(uint8_t reg, uint8_t* data, int len) {
  std::string tx;
  tx.resize(static_cast<size_t>(len + 1));
  tx[0] = static_cast<char>(reg & 0x7F);
  std::string rx(tx.size(), '\0');
  spiTransfer(reinterpret_cast<const uint8_t*>(tx.data()), reinterpret_cast<uint8_t*>(rx.data()), tx.size());
  if (len > 0) {
    std::memcpy(data, rx.data() + 1, static_cast<size_t>(len));
  }
}

void SX127xLinuxRadio::setMode(uint8_t mode) {
  writeReg(REG_OP_MODE, static_cast<uint8_t>(LONG_RANGE_MODE | mode));
}

void SX127xLinuxRadio::setFrequency(int hz) {
  const uint64_t frf = (static_cast<uint64_t>(hz) << 19) / 32000000ULL;
  writeReg(REG_FRF_MSB, static_cast<uint8_t>((frf >> 16) & 0xFF));
  writeReg(REG_FRF_MID, static_cast<uint8_t>((frf >> 8) & 0xFF));
  writeReg(REG_FRF_LSB, static_cast<uint8_t>(frf & 0xFF));
}

void SX127xLinuxRadio::setTxPower(int8_t dbm) {
  int p = std::clamp(static_cast<int>(dbm), 2, 17);
  writeReg(REG_PA_CONFIG, static_cast<uint8_t>(0x80 | (p - 2)));
}

uint8_t SX127xLinuxRadio::bwToReg(int bandwidth_hz) {
  if (bandwidth_hz <= 7800) return 0;
  if (bandwidth_hz <= 10400) return 1;
  if (bandwidth_hz <= 15600) return 2;
  if (bandwidth_hz <= 20800) return 3;
  if (bandwidth_hz <= 31250) return 4;
  if (bandwidth_hz <= 41700) return 5;
  if (bandwidth_hz <= 62500) return 6;
  if (bandwidth_hz <= 125000) return 7;
  if (bandwidth_hz <= 250000) return 8;
  return 9;
}

void SX127xLinuxRadio::setBandwidthAndCodingRate(int bandwidth_hz, int coding_rate) {
  const uint8_t bw = bwToReg(bandwidth_hz);
  const int cr = std::clamp(coding_rate, 5, 8) - 4;
  const uint8_t mc1 = static_cast<uint8_t>((bw << 4) | (cr << 1));
  writeReg(REG_MODEM_CONFIG_1, mc1);
}

void SX127xLinuxRadio::setSpreadingFactor(int sf) {
  const uint8_t sfv = static_cast<uint8_t>(std::clamp(sf, 6, 12));
  uint8_t mc2 = readReg(REG_MODEM_CONFIG_2);
  mc2 = static_cast<uint8_t>((mc2 & 0x0F) | (sfv << 4) | 0x04);
  writeReg(REG_MODEM_CONFIG_2, mc2);
}

void SX127xLinuxRadio::setPreamble(int preamble) {
  const uint16_t p = static_cast<uint16_t>(std::max(6, preamble));
  writeReg(REG_PREAMBLE_MSB, static_cast<uint8_t>((p >> 8) & 0xFF));
  writeReg(REG_PREAMBLE_LSB, static_cast<uint8_t>(p & 0xFF));
}

void SX127xLinuxRadio::setSyncWord(uint8_t sync_word) {
  writeReg(REG_SYNC_WORD, sync_word);
}

float SX127xLinuxRadio::readInstantRssi() {
  const int raw = readReg(REG_RSSI_VALUE);
  return static_cast<float>(raw) - 157.0f;
}

void SX127xLinuxRadio::updateNoiseFloor(float rssi_dbm) {
  if (rssi_dbm > static_cast<float>(noise_threshold)) {
    return;
  }
  noise_floor = (noise_floor * 0.9f) + (rssi_dbm * 0.1f);
}

void SX127xLinuxRadio::begin() {
#ifdef __linux__
  openSpi();

  gpioExport(cfg.reset_pin);
  gpioExport(cfg.irq_pin);
  if (cfg.cs_pin >= 0) gpioExport(cfg.cs_pin);
  if (cfg.txen_pin >= 0) gpioExport(cfg.txen_pin);
  if (cfg.rxen_pin >= 0) gpioExport(cfg.rxen_pin);

  gpioDirection(cfg.reset_pin, "out");
  gpioDirection(cfg.irq_pin, "in");
  if (cfg.cs_pin >= 0) {
    gpioDirection(cfg.cs_pin, "out");
    gpioWrite(cfg.cs_pin, 1);
  }
  if (cfg.txen_pin >= 0) {
    gpioDirection(cfg.txen_pin, "out");
    gpioWrite(cfg.txen_pin, 0);
  }
  if (cfg.rxen_pin >= 0) {
    gpioDirection(cfg.rxen_pin, "out");
    gpioWrite(cfg.rxen_pin, 0);
  }

  gpioPulseReset();

  setMode(MODE_SLEEP);
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  setMode(MODE_STDBY);
  std::this_thread::sleep_for(std::chrono::milliseconds(2));

  setFrequency(cfg.frequency_hz);
  setTxPower(static_cast<int8_t>(cfg.tx_power_dbm));
  setBandwidthAndCodingRate(cfg.bandwidth_hz, cfg.coding_rate);
  setSpreadingFactor(cfg.spreading_factor);
  setPreamble(cfg.preamble_len);
  setSyncWord(static_cast<uint8_t>(cfg.sync_word & 0xFF));

  writeReg(REG_LNA, static_cast<uint8_t>(readReg(REG_LNA) | 0x03));
  writeReg(REG_MODEM_CONFIG_3, 0x04);
  writeReg(REG_FIFO_TX_BASE_ADDR, 0x00);
  writeReg(REG_FIFO_RX_BASE_ADDR, 0x00);
  writeReg(REG_IRQ_FLAGS, 0xFF);

  setMode(MODE_RX_CONT);
  rx_mode = true;
#else
  throw std::runtime_error("SX127xLinuxRadio requires Linux runtime");
#endif
}

int SX127xLinuxRadio::recvRaw(uint8_t* bytes, int sz) {
  const uint8_t irq = readReg(REG_IRQ_FLAGS);
  if ((irq & IRQ_RX_DONE) == 0) {
    updateNoiseFloor(readInstantRssi());
    return 0;
  }

  writeReg(REG_IRQ_FLAGS, irq);

  if ((irq & IRQ_PAYLOAD_CRC_ERROR) != 0 || (irq & IRQ_RX_TIMEOUT) != 0) {
    recv_error_events++;
    return 0;
  }

  const uint8_t curr = readReg(REG_FIFO_RX_CURRENT_ADDR);
  const uint8_t len = readReg(REG_RX_NB_BYTES);
  if (len == 0) {
    return 0;
  }

  writeReg(REG_FIFO_ADDR_PTR, curr);
  const int out_len = std::min<int>(len, sz);
  readBurst(REG_FIFO, bytes, out_len);

  const int8_t snr_raw = static_cast<int8_t>(readReg(REG_PKT_SNR_VALUE));
  last_snr = static_cast<float>(snr_raw) / 4.0f;
  const uint8_t rssi_raw = readReg(REG_PKT_RSSI_VALUE);
  last_rssi = static_cast<float>(rssi_raw) - 157.0f;
  updateNoiseFloor(readInstantRssi());

  return out_len;
}

uint32_t SX127xLinuxRadio::getEstAirtimeFor(int len_bytes) {
  const int sf = std::clamp(cfg.spreading_factor, 6, 12);
  const float bw = static_cast<float>(std::max(7800, cfg.bandwidth_hz));
  const float cr = static_cast<float>(std::clamp(cfg.coding_rate, 5, 8) - 4);
  const float tsym = std::pow(2.0f, static_cast<float>(sf)) / bw;
  const float de = (sf >= 11 && bw <= 125000.0f) ? 1.0f : 0.0f;
  const float ih = 0.0f;
  const float crc = 1.0f;
  const float payload_sym = 8.0f + std::max(
    std::ceil((8.0f * len_bytes - 4.0f * sf + 28.0f + 16.0f * crc - 20.0f * ih) /
              (4.0f * (sf - 2.0f * de))) * (cr + 4.0f),
    0.0f);
  const float preamble_sym = static_cast<float>(cfg.preamble_len) + 4.25f;
  return static_cast<uint32_t>((preamble_sym + payload_sym) * tsym * 1000.0f);
}

float SX127xLinuxRadio::packetScore(float snr, int packet_len) {
  return snr * 100.0f - static_cast<float>(packet_len);
}

bool SX127xLinuxRadio::startSendRaw(const uint8_t* bytes, int len) {
  if (len <= 0) return false;

  if (cfg.rxen_pin >= 0) gpioWrite(cfg.rxen_pin, 0);
  if (cfg.txen_pin >= 0) gpioWrite(cfg.txen_pin, 1);

  setMode(MODE_STDBY);
  writeReg(REG_IRQ_FLAGS, 0xFF);
  writeReg(REG_FIFO_ADDR_PTR, 0x00);
  writeReg(REG_PAYLOAD_LENGTH, static_cast<uint8_t>(len));
  writeBurst(REG_FIFO, bytes, len);
  setMode(MODE_TX);

  tx_pending = true;
  rx_mode = false;
  return true;
}

bool SX127xLinuxRadio::isSendComplete() {
  if (!tx_pending) return false;

  const uint8_t irq = readReg(REG_IRQ_FLAGS);
  if ((irq & IRQ_TX_DONE) == 0) return false;

  writeReg(REG_IRQ_FLAGS, IRQ_TX_DONE);
  tx_pending = false;

  if (cfg.txen_pin >= 0) gpioWrite(cfg.txen_pin, 0);
  if (cfg.rxen_pin >= 0) gpioWrite(cfg.rxen_pin, 1);
  setMode(MODE_RX_CONT);
  rx_mode = true;
  return true;
}

void SX127xLinuxRadio::onSendFinished() {
}

bool SX127xLinuxRadio::isInRecvMode() const {
  return rx_mode;
}

bool SX127xLinuxRadio::isReceiving() {
  return false;
}

void SX127xLinuxRadio::loop() {
  updateNoiseFloor(readInstantRssi());
}

float SX127xLinuxRadio::getLastRSSI() const {
  return last_rssi;
}

float SX127xLinuxRadio::getLastSNR() const {
  return last_snr;
}

int SX127xLinuxRadio::getNoiseFloor() const {
  return static_cast<int>(noise_floor);
}

void SX127xLinuxRadio::triggerNoiseFloorCalibrate(int threshold) {
  noise_threshold = static_cast<int16_t>(threshold);
}

void SX127xLinuxRadio::resetAGC() {
}

uint8_t SX127xLinuxRadio::debugGetStatus() {
  return readReg(REG_OP_MODE);
}

uint16_t SX127xLinuxRadio::debugGetIrqStatus() {
  return readReg(REG_IRQ_FLAGS);
}

uint16_t SX127xLinuxRadio::debugGetDeviceErrors() {
  return 0;
}
