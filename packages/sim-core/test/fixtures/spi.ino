// Reads a device ID and two axes from an SPI accelerometer, and deliberately does one transfer
// with chip select left high -- which is the mistake that returns 0xFF forever.
#include <SPI.h>

const int CS = 9;

byte readRegister(byte reg) {
  digitalWrite(CS, LOW);
  SPI.transfer(reg | 0x80);          // top bit set means read
  byte value = SPI.transfer(0x00);   // the data arrives on the *next* byte
  digitalWrite(CS, HIGH);
  return value;
}

void writeRegister(byte reg, byte value) {
  digitalWrite(CS, LOW);
  SPI.transfer(reg & 0x7F);
  SPI.transfer(value);
  digitalWrite(CS, HIGH);
}

void setup() {
  Serial.begin(9600);
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  pinMode(10, OUTPUT);               // hardware SS must be an output for master mode
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE3));

  Serial.print("id=");
  Serial.println(readRegister(0x00), HEX);

  writeRegister(0x2D, 0x08);         // measure mode
  Serial.print("pwr=");
  Serial.println(readRegister(0x2D), HEX);

  // Same read with CS never asserted. On real hardware MISO floats and this returns 0xFF.
  SPI.transfer(0x80);
  Serial.print("nocs=");
  Serial.println(SPI.transfer(0x00), HEX);
}

void loop() {
  Serial.print("z=");
  Serial.println((readRegister(0x36) << 8) | readRegister(0x37));
  delay(50);
}
