#pragma once

#include <helpers/BaseSerialInterface.h>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <string>
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
  struct ClientState {
    int fd = -1;
    bool is_webgui = false;
    std::vector<uint8_t> recv_buffer;
    std::vector<uint8_t> send_buffer;
  };

  int port;
  int listen_fd = -1;
  std::deque<ClientState> clients;
  int owner_fd = -1;
  bool enabled = false;

  std::deque<std::vector<uint8_t>> inbound_frames;

  void openServer();
  void closeAll();
  void acceptClientsIfAny();
  void dropClient(size_t idx);
  void chooseOwner();
  void recvFromClients();
  void sendToClients();
  void parseIncomingFrames(ClientState& client);
  bool shouldAcceptInboundFrom(const ClientState& client) const;
  void maybeUpdateClientIdentity(ClientState& client, const std::vector<uint8_t>& payload);
};
