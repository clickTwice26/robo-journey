// The ATmega328P's SS trap: pin 10 reused as an input while SPI is running as master.
// SPI.begin() sets it as an output; taking it back for a button undoes that, and the hardware
// drops out of master mode the moment the pin is pulled low.
#include <SPI.h>

const int CS = 9;

void setup() {
  Serial.begin(9600);
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin();
  // The mistake: pin 10 looks like any other spare pin.
  pinMode(10, INPUT);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE3));
}

void loop() {
  digitalWrite(CS, LOW);
  SPI.transfer(0x80);
  Serial.print("id=");
  Serial.println(SPI.transfer(0x00), HEX);
  digitalWrite(CS, HIGH);
  delay(50);
}
