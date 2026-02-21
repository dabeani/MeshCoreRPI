#pragma once

#include "Stream.h"

#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

class File : public Stream {
  std::shared_ptr<std::fstream> stream;
  std::filesystem::path path_;
  bool is_dir_ = false;
  std::vector<std::filesystem::directory_entry> entries;
  size_t entry_index = 0;

public:
  File() = default;

  explicit File(const std::filesystem::path& path, std::ios::openmode mode)
      : stream(std::make_shared<std::fstream>(path, mode)), path_(path), is_dir_(false) {}

  explicit File(const std::filesystem::path& dir_path)
      : path_(dir_path), is_dir_(true) {
    for (const auto& e : std::filesystem::directory_iterator(dir_path)) {
      entries.push_back(e);
    }
  }

  explicit operator bool() const {
    if (is_dir_) return std::filesystem::exists(path_);
    return stream && stream->is_open();
  }

  size_t read(uint8_t* dst, size_t len) {
    if (!stream || !stream->is_open()) return 0;
    stream->read(reinterpret_cast<char*>(dst), static_cast<std::streamsize>(len));
    return static_cast<size_t>(stream->gcount());
  }

  int read() override {
    if (!stream || !stream->is_open()) return -1;
    return stream->get();
  }

  int readBytes(uint8_t* dest, int len) override {
    return static_cast<int>(read(dest, static_cast<size_t>(len)));
  }

  size_t write(const uint8_t* src, size_t len) override {
    if (!stream || !stream->is_open()) return 0;
    stream->write(reinterpret_cast<const char*>(src), static_cast<std::streamsize>(len));
    return stream->bad() ? 0 : len;
  }

  size_t write(uint8_t c) override {
    return write(&c, 1);
  }

  size_t write(const char* src) {
    if (!src) return 0;
    return write(reinterpret_cast<const uint8_t*>(src), std::strlen(src));
  }

  void close() {
    if (stream && stream->is_open()) {
      stream->close();
    }
  }

  bool isDirectory() const {
    return is_dir_;
  }

  File openNextFile() {
    if (!is_dir_ || entry_index >= entries.size()) return File();
    const auto& e = entries[entry_index++];
    if (e.is_directory()) {
      return File(e.path());
    }
    return File(e.path(), std::ios::binary | std::ios::in);
  }

  const char* name() const {
    static thread_local std::string name_buf;
    name_buf = path_.filename().string();
    return name_buf.c_str();
  }

  size_t size() {
    if (is_dir_) return 0;
    if (!std::filesystem::exists(path_)) return 0;
    return static_cast<size_t>(std::filesystem::file_size(path_));
  }

  bool seek(size_t pos) {
    if (!stream || !stream->is_open()) return false;
    stream->seekg(static_cast<std::streamoff>(pos), std::ios::beg);
    stream->seekp(static_cast<std::streamoff>(pos), std::ios::beg);
    return !stream->fail();
  }
};

namespace fs {

struct FSInfo {
  uint32_t totalBytes = 0;
  uint32_t usedBytes = 0;
};

class FS {
  std::filesystem::path root;

  static std::filesystem::path choose_root() {
    const char* env_dir = std::getenv("MESHCORE_DATA_DIR");
    if (env_dir && *env_dir) {
      return std::filesystem::path(env_dir);
    }
    return std::filesystem::path("/var/lib/raspberrypimc/userdata");
  }

  std::filesystem::path resolve(const char* p) const {
    if (!p || *p == 0) return root;
    std::string s(p);
    while (!s.empty() && s[0] == '/') s.erase(s.begin());
    return root / s;
  }

public:
  FS() : root(choose_root()) {}

  bool begin() {
    std::error_code ec;
    std::filesystem::create_directories(root, ec);
    if (!ec) return true;

    root = std::filesystem::current_path() / "RaspberryPiMC" / "userdata";
    ec.clear();
    std::filesystem::create_directories(root, ec);
    return !ec;
  }

  bool mkdir(const char* path) {
    std::error_code ec;
    std::filesystem::create_directories(resolve(path), ec);
    return !ec;
  }

  bool exists(const char* path) const {
    return std::filesystem::exists(resolve(path));
  }

  bool remove(const char* path) {
    std::error_code ec;
    return std::filesystem::remove(resolve(path), ec);
  }

  bool format() {
    std::error_code ec;
    std::filesystem::remove_all(root, ec);
    std::filesystem::create_directories(root, ec);
    return !ec;
  }

  bool info(FSInfo& info) const {
    uint64_t used = 0;
    std::error_code ec;
    if (std::filesystem::exists(root, ec)) {
      for (const auto& entry : std::filesystem::recursive_directory_iterator(root, ec)) {
        if (entry.is_regular_file(ec)) {
          used += entry.file_size(ec);
        }
      }
    }
    info.usedBytes = static_cast<uint32_t>(used);
    info.totalBytes = static_cast<uint32_t>(std::max<uint64_t>(used + (16ULL * 1024ULL * 1024ULL), 16ULL * 1024ULL * 1024ULL));
    return true;
  }

  File open(const char* path) {
    auto p = resolve(path);
    if (std::filesystem::is_directory(p)) return File(p);
    return File(p, std::ios::binary | std::ios::in);
  }

  File open(const char* path, const char* mode) {
    auto p = resolve(path);
    if (std::filesystem::is_directory(p)) return File(p);
    std::ios::openmode m = std::ios::binary;
    if (std::strchr(mode, 'r')) m |= std::ios::in;
    if (std::strchr(mode, 'w')) m |= (std::ios::out | std::ios::trunc);
    if (std::strchr(mode, 'a')) m |= (std::ios::out | std::ios::app);
    std::filesystem::create_directories(p.parent_path());
    return File(p, m);
  }

  File open(const char* path, const char* mode, bool) {
    return open(path, mode);
  }
};

}

using FSInfo = fs::FSInfo;
