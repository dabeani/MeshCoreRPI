#pragma once

#include <cstdint>
#include <ctime>

class DateTime {
  std::tm tm_{};

public:
  explicit DateTime(uint32_t epoch) {
    std::time_t t = static_cast<std::time_t>(epoch);
    auto* out = std::gmtime(&t);
    if (out) tm_ = *out;
  }

  int hour() const { return tm_.tm_hour; }
  int minute() const { return tm_.tm_min; }
  int second() const { return tm_.tm_sec; }
  int day() const { return tm_.tm_mday; }
  int month() const { return tm_.tm_mon + 1; }
  int year() const { return tm_.tm_year + 1900; }
};
