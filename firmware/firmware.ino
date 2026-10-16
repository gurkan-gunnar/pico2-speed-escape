#include <Arduino.h>
#include <Keyboard.h>

// Raspberry Pi Pico 2, Arduino-Pico core, default Pico SDK USB stack.
// USB exports both CDC Serial (for the helper) and HID Keyboard.
static bool armed = false;
static bool serialWasOpen = false;
static bool rawButton = false;
static bool stableButton = false;
static uint32_t buttonChangedAt = 0;
static String inputLine;
static String lastId;
static uint32_t lastScanTickAt = 0;

void announceState() {
  if (Serial) Serial.println(armed ? "STATE,ARMED" : "STATE,PAUSED");
  digitalWrite(LED_BUILTIN, armed ? HIGH : LOW);
}

void pollButton() {
  const bool now = static_cast<bool>(BOOTSEL);
  if (now != rawButton) {
    rawButton = now;
    buttonChangedAt = millis();
  }
  if (now != stableButton && millis() - buttonChangedAt >= 45) {
    stableButton = now;
    if (stableButton && Serial) {
      armed = !armed;
      Keyboard.releaseAll();
      announceState();
    }
  }
}

bool parseUInt(const String &value, int &number) {
  if (value.length() < 1 || value.length() > 2) return false;
  number = 0;
  for (unsigned int i = 0; i < value.length(); ++i) {
    if (value[i] < '0' || value[i] > '9') return false;
    number = number * 10 + value[i] - '0';
  }
  return number >= 1 && number <= 12;
}

bool safeId(const String &id) {
  if (id.length() < 1 || id.length() > 24) return false;
  for (unsigned int i = 0; i < id.length(); ++i) {
    const char c = id[i];
    if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || c == '-')) return false;
  }
  return true;
}

bool waitWhileArmed(uint32_t milliseconds) {
  const uint32_t started = millis();
  while (millis() - started < milliseconds) {
    pollButton();
    if (!armed || !Serial) return false;
    delay(5);
  }
  return true;
}

void handleLine(const String &line) {
  if (line == "PING") {
    Serial.println("PONG,P2SE,1");
    announceState();
    return;
  }

  if (!line.startsWith("TYPE,")) return;
  const int c1 = line.indexOf(',', 5);
  const int c2 = c1 < 0 ? -1 : line.indexOf(',', c1 + 1);
  if (c1 < 0 || c2 < 0 || line.indexOf(',', c2 + 1) >= 0) {
    Serial.println("ERR,UNKNOWN,FORMAT");
    return;
  }
  const String id = line.substring(5, c1);
  int a = 0, b = 0;
  if (!safeId(id) || !parseUInt(line.substring(c1 + 1, c2), a) ||
      !parseUInt(line.substring(c2 + 1), b)) {
    Serial.println("ERR,UNKNOWN,VALUE");
    return;
  }
  if (!armed || !Serial) {
    Serial.printf("ERR,%s,PAUSED\n", id.c_str());
    return;
  }
  if (id == lastId) {
    Serial.printf("ERR,%s,DUPLICATE\n", id.c_str());
    return;
  }

  // Remember before typing: a retried serial packet must not type twice.
  lastId = id;
  const String answer = String(a * b);
  for (unsigned int i = 0; i < answer.length(); ++i) {
    pollButton();
    if (!armed || !Serial) {
      Keyboard.releaseAll();
      Serial.printf("ERR,%s,INTERRUPTED\n", id.c_str());
      return;
    }
    Keyboard.write(answer[i]);
    if (!waitWhileArmed(45)) {
      Keyboard.releaseAll();
      Serial.printf("ERR,%s,INTERRUPTED\n", id.c_str());
      return;
    }
  }
  if (!waitWhileArmed(70)) {
    Keyboard.releaseAll();
    Serial.printf("ERR,%s,INTERRUPTED\n", id.c_str());
    return;
  }
  Keyboard.write(KEY_RETURN);
  Keyboard.releaseAll();
  Serial.printf("DONE,%s,%s\n", id.c_str(), answer.c_str());
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.begin(115200);
  Keyboard.begin();
  inputLine.reserve(80);
}

void loop() {
  pollButton();
  const bool open = static_cast<bool>(Serial);
  if (open && !serialWasOpen) {
    armed = false;
    lastId = "";
    lastScanTickAt = millis();
    Serial.println("HELLO,P2SE,1");
    announceState();
  } else if (!open && serialWasOpen) {
    armed = false;
    Keyboard.releaseAll();
    digitalWrite(LED_BUILTIN, LOW);
    inputLine = "";
  }
  serialWasOpen = open;

  // A serial event wakes the helper even when Chrome delays background timers.
  // This only requests a scan; the helper still checks the screen and the Pico
  // never types until it receives a validated TYPE command.
  if (open && armed && millis() - lastScanTickAt >= 1100) {
    lastScanTickAt = millis();
    Serial.println("TICK");
  }

  while (open && Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      inputLine.trim();
      if (inputLine.length()) handleLine(inputLine);
      inputLine = "";
    } else if (c != '\r') {
      if (inputLine.length() < 80) inputLine += c;
      else inputLine = "";
    }
  }
  delay(5);
}
