#include "Ch341MeshStickTransport.h"
#include <libusb-1.0/libusb.h>
#include <array>
#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

namespace raspmeshcore {
namespace {
constexpr uint16_t VID=0x1a86, PID=0x5512;
constexpr unsigned TIMEOUT_MS=1000;
uint8_t reverse(uint8_t x) {
  x=((x>>1)&0x55)|((x<<1)&0xaa);
  x=((x>>2)&0x33)|((x<<2)&0xcc);
  return static_cast<uint8_t>((x>>4)|(x<<4));
}
int pin(RadioSignal s) {
  switch(s) {
    case RadioSignal::ChipSelect: return 0;
    case RadioSignal::Reset: return 2;
    case RadioSignal::Busy: return 4;
    case RadioSignal::Dio1: return 6;
    case RadioSignal::TxEnable: case RadioSignal::RxEnable:
      throw std::runtime_error("MeshStick RF switch is controlled by SX1262 DIO2; no separate TXEN/RXEN");
  }
  throw std::runtime_error("Unknown radio signal");
}
void check(int rc, const char* what) {
  if(rc<0) throw std::runtime_error(std::string(what)+": "+libusb_error_name(rc));
}
}
struct Ch341MeshStickTransport::Impl {
  libusb_context* context=nullptr;
  libusb_device_handle* dev=nullptr;
  uint8_t outputs=0; // D0 CS, D2 RESET; BUSY (D4 or D5) and D6 IRQ remain inputs
  uint8_t direction=0x05;
  int busy_pin=4;
  void bulkOut(const uint8_t* buf, int size) {
    int done=0;
    check(libusb_bulk_transfer(dev,0x02,const_cast<unsigned char*>(buf),size,&done,TIMEOUT_MS),"CH341 bulk OUT");
    if(done!=size) throw std::runtime_error("CH341 short bulk OUT");
  }
  void bulkIn(uint8_t* buf, int size) {
    int done=0;
    check(libusb_bulk_transfer(dev,0x82,buf,size,&done,TIMEOUT_MS),"CH341 bulk IN");
    if(done!=size) throw std::runtime_error("CH341 short bulk IN");
  }
  void gpioFlush() {
    const std::array<uint8_t,4> cmd={0xab,static_cast<uint8_t>(0x80|(outputs&0x3f)),
                                      static_cast<uint8_t>(0x40|direction),0x20};
    bulkOut(cmd.data(),static_cast<int>(cmd.size()));
  }
  void gpioSet(int p,bool high) {
    if(high) outputs=static_cast<uint8_t>(outputs|(1u<<p));
    else outputs=static_cast<uint8_t>(outputs&~(1u<<p));
    gpioFlush();
  }
};
Ch341MeshStickTransport::Ch341MeshStickTransport(int busy_pin):p_(new Impl) {
  if(busy_pin!=4 && busy_pin!=5) throw std::invalid_argument("CH341 BUSY must be D4 or D5");
  p_->busy_pin=busy_pin;
}
Ch341MeshStickTransport::~Ch341MeshStickTransport(){close();}
void Ch341MeshStickTransport::open() {
  if(p_->dev) return;
  check(libusb_init(&p_->context),"libusb_init");
  try {
    p_->dev=libusb_open_device_with_vid_pid(p_->context,VID,PID);
    if(!p_->dev) throw std::runtime_error("MeshStick CH341 1a86:5512 not found");
    // Do not detach a driver automatically: fail safely if the USB interface is owned.
    check(libusb_claim_interface(p_->dev,0),"claim CH341 interface 0");
    // Match upstream libpinedio convention: CS inactive low, asserted high.
    p_->outputs=static_cast<uint8_t>(1u<<2); // RESET high; CS inactive
    p_->gpioFlush();
  } catch(...) {close();throw;}
}
void Ch341MeshStickTransport::close() noexcept {
  if(p_->dev) {
    // Leave radio unselected, RESET high, and release interface.
    try {p_->gpioSet(0,false);} catch(...) {}
    libusb_release_interface(p_->dev,0);
    libusb_close(p_->dev);
    p_->dev=nullptr;
  }
  if(p_->context){libusb_exit(p_->context);p_->context=nullptr;}
}
void Ch341MeshStickTransport::transfer(const uint8_t* tx,uint8_t* rx,std::size_t n) {
  if(!p_->dev) throw std::runtime_error("CH341 not open");
  if(n==0)return;
  if(!tx||!rx)throw std::invalid_argument("null SPI buffer");
  if(n>4096)throw std::length_error("SPI transfer exceeds 4096 bytes");
  p_->gpioSet(0,true); // assert CS; do not toggle between chunks
  try {
    for(std::size_t pos=0;pos<n;) {
      const std::size_t len=std::min<std::size_t>(31,n-pos);
      std::array<uint8_t,32> cmd{};
      cmd[0]=0xa8;
      for(std::size_t i=0;i<len;++i)cmd[i+1]=reverse(tx[pos+i]);
      p_->bulkOut(cmd.data(),static_cast<int>(len+1));
      std::array<uint8_t,31> response{};
      p_->bulkIn(response.data(),static_cast<int>(len));
      for(std::size_t i=0;i<len;++i)rx[pos+i]=reverse(response[i]);
      pos+=len;
    }
  }catch(...){
    try{p_->gpioSet(0,false);}catch(...){}
    throw;
  }
  p_->gpioSet(0,false);
}
void Ch341MeshStickTransport::write(RadioSignal s,bool high){
  if(!p_->dev)throw std::runtime_error("CH341 not open");
  const int p=pin(s);
  if(p!=0&&p!=2)throw std::runtime_error("MeshStick signal is input-only");
  p_->gpioSet(p,high);
}
bool Ch341MeshStickTransport::read(RadioSignal s){
  if(!p_->dev)throw std::runtime_error("CH341 not open");
  const int p=(s==RadioSignal::Busy) ? p_->busy_pin : pin(s);
  if(p!=4&&p!=5&&p!=6)throw std::runtime_error("MeshStick signal is output-only");
  uint8_t cmd=0xa0;
  p_->bulkOut(&cmd,1);
  std::array<uint8_t,6> reply{};
  p_->bulkIn(reply.data(),static_cast<int>(reply.size()));
  return (reply[0]&(1u<<p))!=0;
}
} // namespace raspmeshcore
