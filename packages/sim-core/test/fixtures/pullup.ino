// Button on D2 with the internal pull-up, mirrored to the built-in LED.
// Pressed reads LOW (the button shorts the pin to ground), which lights the LED.
const int BUTTON = 2;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, digitalRead(BUTTON) == LOW ? HIGH : LOW);
}
