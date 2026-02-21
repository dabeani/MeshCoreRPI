#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <vector>

class CompanionTcpBridge {
public:
  explicit CompanionTcpBridge(int port);
  ~CompanionTcpBridge();

  void begin();
  void loop();

  bool hasInboundPacket() const;
  bool popInboundPacket(uint8_t* out, size_t out_cap, size_t& out_len);

  void queueOutboundPacket(const uint8_t* data, size_t len);
  bool isClientConnected() const;

private:
  int port;
  int listen_fd = -1;
  int client_fd = -1;

  std::deque<std::vector<uint8_t>> inbound_packets;
  std::deque<std::vector<uint8_t>> outbound_packets;
  std::vector<uint8_t> recv_buffer;

  void openServer();
  void closeClient();
  void acceptClientIfAny();
  void recvFromClient();
  void sendToClient();
  void parseIncomingFrames();
};
