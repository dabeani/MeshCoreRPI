#pragma once

#include "Stream.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <random>
#include <string>
#include <thread>

using std::size_t;

inline unsigned long millis() {
  static const auto start = std::chrono::steady_clock::now();
  const auto now = std::chrono::steady_clock::now();
  return static_cast<unsigned long>(
    std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count()
  );
}

inline unsigned long micros() {
  static const auto start = std::chrono::steady_clock::now();
  const auto now = std::chrono::steady_clock::now();
  return static_cast<unsigned long>(
    std::chrono::duration_cast<std::chrono::microseconds>(now - start).count()
  );
}

inline void delay(unsigned long ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

inline long random(long max_v) {
  static std::mt19937 rng{std::random_device{}()};
  if (max_v <= 0) return 0;
  std::uniform_int_distribution<long> dist(0, max_v - 1);
  return dist(rng);
}

inline long random(long min_v, long max_v) {
  if (max_v <= min_v) return min_v;
  static std::mt19937 rng{std::random_device{}()};
  std::uniform_int_distribution<long> dist(min_v, max_v - 1);
  return dist(rng);
}

inline void randomSeed(unsigned long seed) {
  static std::mt19937 rng{std::random_device{}()};
  rng.seed(seed);
}

inline char* ltoa(long value, char* str, int base) {
  if (base < 2 || base > 36 || str == nullptr) {
    return str;
  }

  const bool negative = (value < 0 && base == 10);
  unsigned long v = negative ? static_cast<unsigned long>(-value) : static_cast<unsigned long>(value);

  char tmp[65];
  int i = 0;
  do {
    const int digit = static_cast<int>(v % static_cast<unsigned long>(base));
    tmp[i++] = static_cast<char>(digit < 10 ? ('0' + digit) : ('a' + digit - 10));
    v /= static_cast<unsigned long>(base);
  } while (v != 0);

  int out = 0;
  if (negative) {
    str[out++] = '-';
  }
  while (i > 0) {
    str[out++] = tmp[--i];
  }
  str[out] = '\0';
  return str;
}

template <typename T, typename A, typename B>
inline T constrain(T value, A min_v, B max_v) {
  const T lo = static_cast<T>(min_v);
  const T hi = static_cast<T>(max_v);
  return std::min(hi, std::max(lo, value));
}

template <typename A, typename B>
inline auto min(A a, B b) -> decltype(a < b ? a : b) {
  return a < b ? a : b;
}

template <typename A, typename B>
inline auto max(A a, B b) -> decltype(a > b ? a : b) {
  return a > b ? a : b;
}

class LinuxSerial : public Stream {
  std::mutex write_mutex;

public:
  void begin(unsigned long) {}

  int available() override { return 0; }
  int read() override { return -1; }

  size_t write(uint8_t c) override {
    std::lock_guard<std::mutex> lock(write_mutex);
    return std::fputc(static_cast<int>(c), stdout) == EOF ? 0 : 1;
  }

  size_t write(const uint8_t* src, size_t len) override {
    std::lock_guard<std::mutex> lock(write_mutex);
    return std::fwrite(src, 1, len, stdout);
  }

  int printf(const char* fmt, ...) {
    std::lock_guard<std::mutex> lock(write_mutex);
    va_list args;
    va_start(args, fmt);
    int n = std::vfprintf(stdout, fmt, args);
    va_end(args);
    std::fflush(stdout);
    return n;
  }
};

inline LinuxSerial Serial;
