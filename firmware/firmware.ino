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
static uint32_t lastReadyAt = 0;
static uint32_t lastLoopAt = 0;
static uint32_t activeMillis = 0;
static bool sessionStarted = false;
static bool waitingForSpace = false;
static uint32_t spaceStartedAt = 0;
static uint32_t lastSpaceReadyAt = 0;
static String spaceId;
static String lastGoneId;
static const uint32_t SPACE_DELAY_MS = 90UL * 1000UL;
static const uint32_t MAX_ACTIVE_MS = 12UL * 60UL * 60UL * 1000UL;

void requestQuestion() {
  if (!armed || !Serial) return;
  Serial.println("READY");
  lastReadyAt = millis();
}

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
      if (armed && !sessionStarted) {
        activeMillis = 0;
        sessionStarted = true;
        waitingForSpace = false;
        lastGoneId = "";
      }
      Keyboard.releaseAll();
      announceState();
      if (armed) requestQuestion();
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
    Serial.println("FW,4");
    announceState();
    return;
  }

  if (line.startsWith("GONE,")) {
    const String id = line.substring(5);
    if (!armed || !Serial || !safeId(id) || id != lastId ||
        waitingForSpace || id == lastGoneId) {
      Serial.printf("ERR,%s,GONE\n", safeId(id) ? id.c_str() : "UNKNOWN");
      return;
    }
    lastGoneId = id;
    spaceId = id;
    waitingForSpace = true;
    spaceStartedAt = activeMillis;
    lastSpaceReadyAt = 0;
    Serial.printf("SPACE_WAIT,%s,90\n", id.c_str());
    return;
  }

  if (line.startsWith("SPACE,")) {
    const String id = line.substring(6);
    if (!armed || !Serial || !waitingForSpace || id != spaceId ||
        activeMillis - spaceStartedAt < SPACE_DELAY_MS) {
      Serial.printf("ERR,%s,SPACE\n", safeId(id) ? id.c_str() : "UNKNOWN");
      return;
    }
    Keyboard.write(' ');
    Keyboard.releaseAll();
    waitingForSpace = false;
    Serial.printf("SPACE_DONE,%s\n", id.c_str());
    requestQuestion();
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
  // A new question after the previous quiz cancels its pending Space press.
  waitingForSpace = false;
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
  requestQuestion();
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.begin(115200);
  Keyboard.begin();
  inputLine.reserve(80);
  lastLoopAt = millis();
}

void loop() {
  const uint32_t now = millis();
  if (armed && serialWasOpen) activeMillis += now - lastLoopAt;
  lastLoopAt = now;
  pollButton();
  const bool open = static_cast<bool>(Serial);
  if (open && !serialWasOpen) {
    armed = false;
    sessionStarted = false;
    waitingForSpace = false;
    lastId = "";
    lastGoneId = "";
    lastReadyAt = millis();
    Serial.println("HELLO,P2SE,1");
    Serial.println("FW,4");
    announceState();
  } else if (!open && serialWasOpen) {
    armed = false;
    sessionStarted = false;
    waitingForSpace = false;
    Keyboard.releaseAll();
    digitalWrite(LED_BUILTIN, LOW);
    inputLine = "";
  }
  serialWasOpen = open;

  if (open && armed && activeMillis >= MAX_ACTIVE_MS) {
    armed = false;
    sessionStarted = false;
    waitingForSpace = false;
    Keyboard.releaseAll();
    digitalWrite(LED_BUILTIN, LOW);
    Serial.println("STATE,FINISHED");
  }

  // Keep requesting the next screen reading while BOOTSEL has started us.
  // The helper still checks the shared screen before sending a TYPE command.
  if (open && armed && millis() - lastReadyAt >= 1200) requestQuestion();
  if (open && armed && waitingForSpace &&
      activeMillis - spaceStartedAt >= SPACE_DELAY_MS &&
      (lastSpaceReadyAt == 0 || millis() - lastSpaceReadyAt >= 1200)) {
    Serial.printf("SPACE_READY,%s\n", spaceId.c_str());
    lastSpaceReadyAt = millis();
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
