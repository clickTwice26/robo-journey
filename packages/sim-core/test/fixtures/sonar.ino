// Reads an HC-SR04 and prints the distance. The classic 58 us-per-centimetre conversion.
const int TRIG = 9;
const int ECHO = 10;

void setup() {
  Serial.begin(9600);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  long micros = pulseIn(ECHO, HIGH, 40000);
  Serial.println(micros / 58);
  delay(100);
}
