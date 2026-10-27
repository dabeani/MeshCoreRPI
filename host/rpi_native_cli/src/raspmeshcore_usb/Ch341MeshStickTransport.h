#pragma once
#include "RadioTransport.h"
#include <cstdint>
#include <memory>
namespace raspmeshcore {
// USB VID/PID and pins from markbirss/MESHSTICK; requires libusb-1.0.
class Ch341MeshStickTransport final : public RadioTransport {
public:
  explicit Ch341MeshStickTransport(int busy_pin = 4);
  ~Ch341MeshStickTransport() override;
  void open() override;
  void close() noexcept override;
  void transfer(const uint8_t* tx, uint8_t* rx, std::size_t size) override;
  void write(RadioSignal signal, bool high) override;
  bool read(RadioSignal signal) override;
private:
  struct Impl;
  std::unique_ptr<Impl> p_;
};
} // namespace raspmeshcore
