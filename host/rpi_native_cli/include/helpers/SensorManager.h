#pragma once

#include <cstdint>
#include <cstring>
#include <CayenneLPP.h>

#define TELEM_PERM_BASE         0x01
#define TELEM_PERM_LOCATION     0x02
#define TELEM_PERM_ENVIRONMENT  0x04

#ifndef TELEM_CHANNEL_SELF
#define TELEM_CHANNEL_SELF   1
#endif

class SensorManager {
public:
  double node_lat = 0.0;
  double node_lon = 0.0;
  double node_altitude = 0.0;

  bool begin() { return false; }
  void loop() {}

  bool querySensors(uint8_t, CayenneLPP&) { return false; }

  int getNumSettings() const { return 0; }
  const char* getSettingName(int) const { return ""; }
  const char* getSettingValue(int) const { return ""; }
  bool setSettingValue(const char*, const char*) { return false; }

  const char* getSettingByKey(const char* key) const {
    const int num = getNumSettings();
    for (int i = 0; i < num; i++) {
      const char* name = getSettingName(i);
      if (name && key && std::strcmp(name, key) == 0) {
        return getSettingValue(i);
      }
    }
    return nullptr;
  }
};
