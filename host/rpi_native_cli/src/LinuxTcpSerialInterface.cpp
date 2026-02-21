#include "LinuxTcpSerialInterface.h"

#ifdef __linux__
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cstring>
#include <stdexcept>

LinuxTcpSerialInterface::LinuxTcpSerialInterface(int port_) : port(port_) {}

LinuxTcpSerialInterface::~LinuxTcpSerialInterface() {
  closeAll();
}

void LinuxTcpSerialInterface::enable() {
  if (enabled) return;
  enabled = true;
  openServer();
}

void LinuxTcpSerialInterface::disable() {
  enabled = false;
  closeAll();
}

bool LinuxTcpSerialInterface::isEnabled() const {
  return enabled;
}

bool LinuxTcpSerialInterface::isConnected() const {
  return client_fd >= 0;
}

bool LinuxTcpSerialInterface::isWriteBusy() const {
  return false;
}

size_t LinuxTcpSerialInterface::writeFrame(const uint8_t src[], size_t len) {
  if (!enabled || len == 0 || len > MAX_FRAME_SIZE) return 0;
  std::vector<uint8_t> frame;
  frame.resize(3 + len);
  frame[0] = '>';
  frame[1] = static_cast<uint8_t>(len & 0xFF);
  frame[2] = static_cast<uint8_t>((len >> 8) & 0xFF);
  std::memcpy(frame.data() + 3, src, len);
  outbound_frames.push_back(std::move(frame));
  sendToClient();
  return len;
}

size_t LinuxTcpSerialInterface::checkRecvFrame(uint8_t dest[]) {
  if (!enabled) return 0;
  acceptClientIfAny();
  recvFromClient();
  sendToClient();
  if (inbound_frames.empty()) return 0;

  auto frame = inbound_frames.front();
  inbound_frames.pop_front();
  const size_t n = std::min(frame.size(), static_cast<size_t>(MAX_FRAME_SIZE));
  std::memcpy(dest, frame.data(), n);
  return n;
}

void LinuxTcpSerialInterface::openServer() {
#ifdef __linux__
  if (listen_fd >= 0) return;
  listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd < 0) throw std::runtime_error("failed to create tcp socket");

  int one = 1;
  setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(listen_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    throw std::runtime_error("failed to bind tcp socket");
  }
  if (::listen(listen_fd, 1) != 0) {
    throw std::runtime_error("failed to listen on tcp socket");
  }
  int flags = fcntl(listen_fd, F_GETFL, 0);
  fcntl(listen_fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

void LinuxTcpSerialInterface::closeAll() {
  closeClient();
#ifdef __linux__
  if (listen_fd >= 0) {
    ::close(listen_fd);
    listen_fd = -1;
  }
#endif
}

void LinuxTcpSerialInterface::closeClient() {
#ifdef __linux__
  if (client_fd >= 0) {
    ::close(client_fd);
    client_fd = -1;
  }
#endif
  recv_buffer.clear();
  inbound_frames.clear();
  outbound_frames.clear();
}

void LinuxTcpSerialInterface::acceptClientIfAny() {
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

void LinuxTcpSerialInterface::recvFromClient() {
#ifdef __linux__
  if (client_fd < 0) return;
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

void LinuxTcpSerialInterface::sendToClient() {
#ifdef __linux__
  while (client_fd >= 0 && !outbound_frames.empty()) {
    auto& frame = outbound_frames.front();
    int n = ::send(client_fd, frame.data(), frame.size(), 0);
    if (n < 0) return;
    outbound_frames.pop_front();
  }
#endif
}

void LinuxTcpSerialInterface::parseIncomingFrames() {
  while (recv_buffer.size() >= 3) {
    const uint8_t type = recv_buffer[0];
    const uint16_t len = static_cast<uint16_t>(recv_buffer[1] | (recv_buffer[2] << 8));
    if (recv_buffer.size() < static_cast<size_t>(3 + len)) return;

    if (type == '<' && len > 0 && len <= MAX_FRAME_SIZE) {
      std::vector<uint8_t> payload(len);
      std::memcpy(payload.data(), recv_buffer.data() + 3, len);
      inbound_frames.push_back(std::move(payload));
    }
    recv_buffer.erase(recv_buffer.begin(), recv_buffer.begin() + 3 + len);
  }
}
