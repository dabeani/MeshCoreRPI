#include "CompanionTcpBridge.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>

#ifdef __linux__
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

CompanionTcpBridge::CompanionTcpBridge(int port_) : port(port_) {}

CompanionTcpBridge::~CompanionTcpBridge() {
#ifdef __linux__
  closeClient();
  if (listen_fd >= 0) {
    ::close(listen_fd);
    listen_fd = -1;
  }
#endif
}

void CompanionTcpBridge::begin() {
#ifdef __linux__
  openServer();
#endif
}

void CompanionTcpBridge::loop() {
#ifdef __linux__
  acceptClientIfAny();
  if (client_fd >= 0) {
    recvFromClient();
    sendToClient();
  }
#endif
}

bool CompanionTcpBridge::hasInboundPacket() const {
  return !inbound_packets.empty();
}

bool CompanionTcpBridge::popInboundPacket(uint8_t* out, size_t out_cap, size_t& out_len) {
  if (inbound_packets.empty()) return false;
  const auto pkt = inbound_packets.front();
  inbound_packets.pop_front();
  out_len = std::min(out_cap, pkt.size());
  std::memcpy(out, pkt.data(), out_len);
  return true;
}

void CompanionTcpBridge::queueOutboundPacket(const uint8_t* data, size_t len) {
  if (len == 0 || len > 255) return;
  std::vector<uint8_t> frame;
  frame.resize(3 + len);
  frame[0] = '>';
  frame[1] = static_cast<uint8_t>(len & 0xFF);
  frame[2] = static_cast<uint8_t>((len >> 8) & 0xFF);
  std::memcpy(frame.data() + 3, data, len);
  outbound_packets.push_back(std::move(frame));
}

bool CompanionTcpBridge::isClientConnected() const {
  return client_fd >= 0;
}

void CompanionTcpBridge::openServer() {
#ifdef __linux__
  listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd < 0) throw std::runtime_error("failed to create TCP socket");

  int one = 1;
  setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(static_cast<uint16_t>(port));

  if (::bind(listen_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    throw std::runtime_error("failed to bind TCP socket");
  }
  if (::listen(listen_fd, 1) != 0) {
    throw std::runtime_error("failed to listen on TCP socket");
  }

  int flags = fcntl(listen_fd, F_GETFL, 0);
  fcntl(listen_fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

void CompanionTcpBridge::closeClient() {
#ifdef __linux__
  if (client_fd >= 0) {
    ::close(client_fd);
    client_fd = -1;
  }
  recv_buffer.clear();
  inbound_packets.clear();
  outbound_packets.clear();
#endif
}

void CompanionTcpBridge::acceptClientIfAny() {
#ifdef __linux__
  if (listen_fd < 0) return;
  sockaddr_in caddr{};
  socklen_t clen = sizeof(caddr);
  int fd = ::accept(listen_fd, reinterpret_cast<sockaddr*>(&caddr), &clen);
  if (fd < 0) return;

  closeClient();
  client_fd = fd;
  int flags = fcntl(client_fd, F_GETFL, 0);
  fcntl(client_fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

void CompanionTcpBridge::recvFromClient() {
#ifdef __linux__
  uint8_t tmp[1024];
  int n = ::recv(client_fd, tmp, sizeof(tmp), 0);
  if (n == 0) {
    closeClient();
    return;
  }
  if (n < 0) return;
  recv_buffer.insert(recv_buffer.end(), tmp, tmp + n);
  parseIncomingFrames();
#endif
}

void CompanionTcpBridge::sendToClient() {
#ifdef __linux__
  while (!outbound_packets.empty() && client_fd >= 0) {
    auto& frame = outbound_packets.front();
    int n = ::send(client_fd, frame.data(), frame.size(), 0);
    if (n < 0) break;
    outbound_packets.pop_front();
  }
#endif
}

void CompanionTcpBridge::parseIncomingFrames() {
  while (recv_buffer.size() >= 3) {
    const uint8_t type = recv_buffer[0];
    const uint16_t len = static_cast<uint16_t>(recv_buffer[1] | (recv_buffer[2] << 8));
    if (recv_buffer.size() < static_cast<size_t>(3 + len)) return;

    if (type == '<' && len > 0 && len <= 255) {
      std::vector<uint8_t> payload(len);
      std::memcpy(payload.data(), recv_buffer.data() + 3, len);
      inbound_packets.push_back(std::move(payload));
    }
    recv_buffer.erase(recv_buffer.begin(), recv_buffer.begin() + 3 + len);
  }
}
