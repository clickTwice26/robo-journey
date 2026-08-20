// Reads a 16-bit temperature register from an I2C sensor at 0x48 and prints it.
// Also scans the bus first, which is how you find out what is actually connected.
#include <Wire.h>

const int SENSOR = 0x48;

void setup() {
  Serial.begin(9600);
  Wire.begin();

  Serial.print("found:");
  for (byte address = 8; address < 120; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.print(" 0x");
      Serial.print(address, HEX);
    }
  }
  Serial.println();
}

void loop() {
  // Point at register 0, then read two bytes back.
  Wire.beginTransmission(SENSOR);
  Wire.write(0x00);
  Wire.endTransmission();

  Wire.requestFrom(SENSOR, 2);
  if (Wire.available() >= 2) {
    int hi = Wire.read();
    int lo = Wire.read();
    Serial.print("t=");
    Serial.println((hi << 8) | lo);
  }
  delay(100);
}
