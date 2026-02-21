#pragma once

#include <helpers/BaseSerialInterface.h>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <vector>

class LinuxTcpSerialInterface : public BaseSerialInterface {
public:
  explicit LinuxTcpSerialInterface(int port);
  ~LinuxTcpSerialInterface();

  void enable() override;
  void disable() override;
  bool isEnabled() const override;

  bool isConnected() const override;
  bool isWriteBusy() const override;
  size_t writeFrame(const uint8_t src[], size_t len) override;
  size_t checkRecvFrame(uint8_t dest[]) override;

private:
  int port;
  int listen_fd = -1;
  int client_fd = -1;
  bool enabled = false;

  std::deque<std::vector<uint8_t>> inbound_frames;
  std::deque<std::vector<uint8_t>> outbound_frames;
  std::vector<uint8_t> recv_buffer;

  void openServer();
  void closeAll();
  void closeClient();
  void acceptClientIfAny();
  void recvFromClient();
  void sendToClient();
  void parseIncomingFrames();
};
