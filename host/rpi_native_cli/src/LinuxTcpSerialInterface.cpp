#include "LinuxTcpSerialInterface.h"

#ifdef __linux__
#include <arpa/inet.h>
#include <cerrno>
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
  return !clients.empty();
}

bool LinuxTcpSerialInterface::isWriteBusy() const {
  return false;
}

size_t LinuxTcpSerialInterface::writeFrame(const uint8_t src[], size_t len) {
  if (!enabled || len == 0 || len > MAX_FRAME_SIZE) return 0;
  if (clients.empty()) return len;
  std::vector<uint8_t> frame;
  frame.resize(3 + len);
  frame[0] = '>';
  frame[1] = static_cast<uint8_t>(len & 0xFF);
  frame[2] = static_cast<uint8_t>((len >> 8) & 0xFF);
  std::memcpy(frame.data() + 3, src, len);
  for (auto& c : clients) {
    c.send_buffer.insert(c.send_buffer.end(), frame.begin(), frame.end());
  }
  sendToClients();
  return len;
}

size_t LinuxTcpSerialInterface::checkRecvFrame(uint8_t dest[]) {
  if (!enabled) return 0;
  acceptClientsIfAny();
  recvFromClients();
  sendToClients();
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
  if (::listen(listen_fd, 4) != 0) {
    throw std::runtime_error("failed to listen on tcp socket");
  }
  int flags = fcntl(listen_fd, F_GETFL, 0);
  fcntl(listen_fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

void LinuxTcpSerialInterface::closeAll() {
  clients.clear();
  owner_fd = -1;
#ifdef __linux__
  if (listen_fd >= 0) {
    ::close(listen_fd);
    listen_fd = -1;
  }
#endif
}

void LinuxTcpSerialInterface::acceptClientsIfAny() {
#ifdef __linux__
  if (listen_fd < 0) return;
  while (true) {
    sockaddr_in caddr{};
    socklen_t clen = sizeof(caddr);
    int fd = ::accept(listen_fd, reinterpret_cast<sockaddr*>(&caddr), &clen);
    if (fd < 0) return;
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    ClientState cs;
    cs.fd = fd;
    clients.push_back(std::move(cs));
    if (owner_fd < 0) owner_fd = fd;
  }
#endif
}

void LinuxTcpSerialInterface::dropClient(size_t idx) {
#ifdef __linux__
  if (idx >= clients.size()) return;
  if (clients[idx].fd >= 0) {
    ::close(clients[idx].fd);
  }
#endif
  const int dropped_fd = clients[idx].fd;
  clients.erase(clients.begin() + static_cast<long>(idx));
  if (dropped_fd == owner_fd) {
    owner_fd = -1;
    chooseOwner();
  }
}

void LinuxTcpSerialInterface::chooseOwner() {
  if (clients.empty()) {
    owner_fd = -1;
    return;
  }
  // Prefer a non-webgui client if available.
  for (const auto& c : clients) {
    if (!c.is_webgui) {
      owner_fd = c.fd;
      return;
    }
  }
  owner_fd = clients.front().fd;
}

bool LinuxTcpSerialInterface::shouldAcceptInboundFrom(const ClientState& client) const {
  if (clients.size() <= 1) return true;
  return client.fd == owner_fd;
}

void LinuxTcpSerialInterface::recvFromClients() {
#ifdef __linux__
  uint8_t tmp[1024];
  for (size_t i = 0; i < clients.size(); ) {
    auto& c = clients[i];
    int n = ::recv(c.fd, tmp, sizeof(tmp), 0);
    if (n == 0) {
      dropClient(i);
      continue;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        ++i;
        continue;
      }
      dropClient(i);
      continue;
    }
    c.recv_buffer.insert(c.recv_buffer.end(), tmp, tmp + n);
    parseIncomingFrames(c);
    ++i;
  }
#endif
}

void LinuxTcpSerialInterface::sendToClients() {
#ifdef __linux__
  for (size_t i = 0; i < clients.size(); ) {
    auto& c = clients[i];
    if (c.send_buffer.empty()) {
      ++i;
      continue;
    }
    int n = ::send(c.fd, c.send_buffer.data(), c.send_buffer.size(), 0);
    if (n == 0) {
      dropClient(i);
      continue;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        ++i;
        continue;
      }
      dropClient(i);
      continue;
    }
    c.send_buffer.erase(c.send_buffer.begin(), c.send_buffer.begin() + n);
    ++i;
  }
#endif
}

void LinuxTcpSerialInterface::maybeUpdateClientIdentity(ClientState& client, const std::vector<uint8_t>& payload) {
  // CMD_APP_START: command byte + 7 reserved bytes + app name starting at offset 8.
  // We detect the WebGUI and avoid letting it steal "owner" from real apps.
  if (payload.empty()) return;

  const uint8_t cmd = payload[0];
  // Ownership transfer heuristic: if current owner is webgui and another client starts talking,
  // prefer the other client.
  auto is_owner_webgui = false;
  for (const auto& c : clients) {
    if (c.fd == owner_fd) {
      is_owner_webgui = c.is_webgui;
      break;
    }
  }
  if (!client.is_webgui && is_owner_webgui && (cmd == 1 || cmd == 22)) { // CMD_APP_START or CMD_DEVICE_QUERY
    owner_fd = client.fd;
  }

  if (cmd != 1) return; // CMD_APP_START
  if (payload.size() < 9) return;
  const size_t name_off = 8;
  if (payload.size() <= name_off) return;
  std::string name;
  for (size_t i = name_off; i < payload.size(); ++i) {
    const char ch = static_cast<char>(payload[i]);
    if (ch == '\0') break;
    name.push_back(ch);
  }
  if (name == "mc-webgui") {
    client.is_webgui = true;
  }
  // If the current owner is webgui and a non-webgui client identifies itself, transfer ownership.
  if (!client.is_webgui && (owner_fd < 0 || is_owner_webgui)) {
    owner_fd = client.fd;
  }
}

void LinuxTcpSerialInterface::parseIncomingFrames(ClientState& client) {
  while (client.recv_buffer.size() >= 3) {
    const uint8_t type = client.recv_buffer[0];
    const uint16_t len = static_cast<uint16_t>(client.recv_buffer[1] | (client.recv_buffer[2] << 8));
    if (client.recv_buffer.size() < static_cast<size_t>(3 + len)) return;

    if (type == '<' && len > 0 && len <= MAX_FRAME_SIZE) {
      std::vector<uint8_t> payload(len);
      std::memcpy(payload.data(), client.recv_buffer.data() + 3, len);
      maybeUpdateClientIdentity(client, payload);
      if (shouldAcceptInboundFrom(client)) {
        inbound_frames.push_back(std::move(payload));
      }
    }
    client.recv_buffer.erase(client.recv_buffer.begin(), client.recv_buffer.begin() + 3 + len);
  }
}
