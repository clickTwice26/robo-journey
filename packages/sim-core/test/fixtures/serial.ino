// Prints a short line over the hardware USART at 9600 baud.
void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.println("Hi");
  delay(50);
}
