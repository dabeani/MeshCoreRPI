#pragma once
// Hardware-independent SPI/GPIO contract for a future MeshCoreRPI USB CH341 backend.
// Does not replace upstream source or activate a driver.
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace raspmeshcore {
enum class RadioSignal { ChipSelect, Reset, Busy, Dio1, TxEnable, RxEnable };
class RadioTransport {
public:
  virtual ~RadioTransport() = default;
  virtual void open() = 0;
  virtual void close() noexcept = 0;
  // One complete SX1262 transaction, CS asserted throughout; full duplex.
  // Must throw on short transfer, disconnection, timeout or unsupported length.
  virtual void transfer(const uint8_t* tx, uint8_t* rx, std::size_t size) = 0;
  virtual void write(RadioSignal signal, bool high) = 0;
  virtual bool read(RadioSignal signal) = 0;
};
inline void waitBusyLow(RadioTransport& transport, unsigned maxPolls = 200) {
  for (unsigned i = 0; i < maxPolls; ++i)
    if (!transport.read(RadioSignal::Busy)) return;
  throw std::runtime_error("SX1262 BUSY timeout");
}
}  // namespace raspmeshcore
