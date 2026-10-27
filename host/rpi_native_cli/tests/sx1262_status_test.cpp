#include "SX1262Status.h"
#include <cassert>

int main() {
  assert(!sx1262StatusPlausible(0xff)); // MISO pulled high, not an SX1262 reply
  assert(!sx1262StatusPlausible(0x00)); // bus stuck low
  assert(sx1262StatusPlausible(0x22));  // standby RC with command status
  assert(sx1262StatusPlausible(0x54));  // RX with command status
}
