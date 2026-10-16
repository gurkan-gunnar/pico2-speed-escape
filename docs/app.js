import { parseEquation, parseProgress, QuizGuard } from './recognition.js?v=cycle-4';

const byId = id => document.getElementById(id);
const video = byId('screenVideo');
const preview = byId('preview');
const screenState = byId('screenState');
const picoState = byId('picoState');
const pipState = byId('pipState');
const runState = byId('runState');
const readout = byId('readout');
const logBox = byId('log');
const guard = new QuizGuard();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sentQuestions = new Map();

let stream = null;
let pipWindow = null;
let port = null;
let writer = null;
let armed = false;
let picoVerified = false;
let firmwareVersion = 0;
let worker = null;
let scanTimer = null;
let scanTimerWindow = window;
let handshakeTimer = null;
let lineBuffer = '';
let nextId = 1;
let scanning = false;
let screenError = '';
let picoError = '';
let pipError = '';
let runError = '';
let completedFifthId = '';
let goneSentId = '';
let spaceCheckInFlight = false;
let wakeLock = null;

function log(message) {
  const time = new Date().toLocaleTimeString('sv-SE');
  logBox.textContent = `${time} ${message}\n${logBox.textContent}`.slice(0, 3500);
}

function screenActive() {
  return !!stream && stream.getVideoTracks().some(t => t.readyState === 'live') && video.readyState >= 2;
}

function helperIsUnfocused() {
  // The helper may be in its own visible window or a separate visible window.
  // Never send keystrokes while either helper window has keyboard focus.
  return !document.hasFocus() && !pipWindow?.document.hasFocus();
}

function continuousWindowReady() {
  return (pipWindow && !pipWindow.closed && pipWindow.document.visibilityState === 'visible')
    || (document.visibilityState === 'visible' && !document.hasFocus());
}

async function acquireWakeLock() {
  if (!armed || wakeLock || !pipWindow || pipWindow.closed) return;
  try {
    wakeLock = await pipWindow.navigator.wakeLock?.request('screen') || null;
    wakeLock?.addEventListener('release', () => { wakeLock = null; updateStatus(); }, { once: true });
  } catch (error) { log(`Skärmen kan somna: ${error.message}`); }
  updateStatus();
}

async function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  try { await lock?.release(); } catch {}
}

function updateStatus() {
  const screen = screenActive();
  screenState.textContent = screen ? 'Skärmen delas' : screenError || 'Inte ansluten';
  pipState.textContent = pipWindow && !pipWindow.closed ? 'Öppet – flytta till ett hörn' : pipError || 'Inte öppet';
  picoState.textContent = port ? (!picoVerified ? picoError || 'Väntar på svar från Pico'
    : armed ? 'Ansluten och startad' : 'Ansluten, pausad') : picoError || 'Inte ansluten';
  byId('testButton').disabled = !port || !picoVerified || !armed;
  runState.textContent = runError || (!screen && screenError) || (!picoVerified && picoError)
    || (!screen || !port ? 'Väntar på anslutningar'
    : !picoVerified ? 'Kontrollerar Pico-anslutningen'
    : !worker ? 'Startar avläsningen'
    : armed ? (continuousWindowReady()
      ? firmwareVersion === 3
        ? 'Kör med gammal Pico-version: 90-sekunderstimern kräver version 4'
        : 'Kör – klicka i spelets svarsruta (högst 12 timmar)'
      : 'Öppna lilla hjälpfönstret (steg 3) så att avläsningen fortsätter')
      : 'Redo – öppna hjälpfönstret och tryck BOOTSEL');
}

async function openHelperWindow() {
  try {
    pipError = '';
    if (!window.documentPictureInPicture) throw new Error('Chrome stöder inte det lilla hjälpfönstret här. Öppna hjälpsidan i ett separat fönster bredvid spelet.');
    if (pipWindow && !pipWindow.closed) return;
    pipWindow = await documentPictureInPicture.requestWindow({ width: 280, height: 190 });
    const pipDocument = pipWindow.document;
    pipDocument.title = 'Pico 2 – Speed Escape';
    pipDocument.body.style.cssText = 'margin:8px;font:14px system-ui;background:#f4f8ff;color:#12233b';
    const heading = pipDocument.createElement('strong');
    heading.textContent = 'Pico 2: BOOTSEL startar och pausar';
    pipDocument.body.append(heading);
    const hint = pipDocument.createElement('p');
    hint.textContent = 'Lägg fönstret i ett hörn. Klicka sedan i spelets svarsruta.';
    hint.style.margin = '6px 0';
    pipDocument.body.append(hint);
    video.style.cssText = 'position:static;display:block;width:100%;height:95px;opacity:1;object-fit:contain';
    pipDocument.body.append(video);
    const openedWindow = pipWindow;
    pipWindow.addEventListener('pagehide', () => {
      if (pipWindow === openedWindow) pipWindow = null;
      void releaseWakeLock();
      video.style.cssText = '';
      document.body.append(video);
      scheduleScan(1100);
      updateStatus();
    }, { once: true });
    log('Litet hjälpfönster öppnat. Gå till spelet och klicka i svarsrutan.');
    void acquireWakeLock();
    scheduleScan(200);
  } catch (error) {
    log(`Hjälpfönster: ${error.message}`);
    pipError = error.message;
  }
  updateStatus();
}

async function startScreen() {
  try {
    screenError = '';
    runError = '';
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Skärmdelning stöds inte i denna webbläsare.');
    stream?.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track.getSettings().displaySurface && track.getSettings().displaySurface !== 'monitor') {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      throw new Error('Välj hela skärmen, inte en flik eller ett fönster.');
    }
    track.addEventListener('ended', () => {
      stream = null;
      screenError = 'Skärmdelningen avslutades';
      void releaseWakeLock();
      updateStatus();
      log('Skärmdelningen avslutades.');
    });
    video.srcObject = stream;
    await video.play();
    updateStatus();
    log('Hela skärmen delas lokalt med hjälpsidan.');
    await ensureWorker();
    scheduleScan(300);
  } catch (error) {
    log(`Skärm: ${error.message}`);
    screenError = `Fel: ${error.message}`;
    runError = screenError;
  }
  updateStatus();
}

async function ensureWorker() {
  if (worker) return;
  if (!window.Tesseract) throw new Error('Textavläsningen kunde inte laddas.');
  worker = await Tesseract.createWorker('eng', 1, {
    workerPath: new URL('vendor/worker.min.js', location.href).href,
    corePath: new URL('vendor/core/', location.href).href,
    langPath: new URL('vendor/lang/', location.href).href,
    workerBlobURL: false,
  });
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  log('Textavläsningen är klar.');
  updateStatus();
}

function onSerialLine(line) {
  if (line === 'HELLO,P2SE,1' || line === 'PONG,P2SE,1') {
    picoVerified = true;
    picoError = '';
    runError = '';
    clearTimeout(handshakeTimer);
    log('Pico 2 svarar via USB.');
  } else if (line === 'FW,4') {
    firmwareVersion = 4;
    log('Pico-program version 4 är anslutet.');
  } else if (line === 'FW,3') {
    firmwareVersion = 3;
    log('Pico-program version 3 är anslutet; 90-sekundersfunktionen kräver version 4.');
  } else if (line === 'STATE,ARMED' && picoVerified) {
    armed = true;
    log('BOOTSEL: start.');
    void acquireWakeLock();
    void scan();
  } else if (line === 'STATE,PAUSED' && picoVerified) {
    armed = false;
    void releaseWakeLock();
    log('BOOTSEL: paus.');
  } else if (line === 'STATE,FINISHED' && picoVerified) {
    armed = false;
    void releaseWakeLock();
    log('12 timmars aktiv körning är slut. Tryck BOOTSEL för en ny omgång.');
  } else if (line === 'READY' && picoVerified && armed) {
    void scan();
  } else if (line.startsWith('DONE,')) {
    log(`Pico skrev svar: ${line}`);
    const id = line.split(',')[1];
    const question = sentQuestions.get(id);
    sentQuestions.delete(id);
    if (question === 5) {
      completedFifthId = id;
      goneSentId = '';
    }
    scheduleScan(250);
  } else if (line.startsWith('SPACE_WAIT,')) {
    log('Quizet är klart. Pico väntar 90 sekunder innan Space kan tryckas.');
  } else if (line.startsWith('SPACE_READY,')) {
    void trySpace(line.slice('SPACE_READY,'.length));
  } else if (line.startsWith('SPACE_DONE,')) {
    log('Pico tryckte Space för nästa quiz.');
    completedFifthId = '';
    goneSentId = '';
  } else if (line.startsWith('ERR,')) {
    log(`Pico avbröt: ${line}`);
  }
  updateStatus();
}

async function readSerial(activePort) {
  try {
    const reader = activePort.readable.getReader();
    try {
      while (activePort === port) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, index).trim();
          lineBuffer = lineBuffer.slice(index + 1);
          if (line) onSerialLine(line);
        }
        if (lineBuffer.length > 256) lineBuffer = '';
      }
    } finally { reader.releaseLock(); }
  } catch (error) {
    log(`USB-läsning stoppade: ${error.message}`);
  } finally {
    if (port === activePort) {
      armed = false;
      void releaseWakeLock();
      picoVerified = false;
      firmwareVersion = 0;
      port = null;
      clearTimeout(handshakeTimer);
      picoError = 'USB-anslutningen bröts';
      writer?.releaseLock();
      writer = null;
      updateStatus();
    }
  }
}

async function send(command) {
  if (!writer || !port) throw new Error('Pico är inte ansluten.');
  await writer.write(encoder.encode(`${command}\n`));
}

async function connectPico() {
  try {
    picoError = '';
    runError = '';
    if (!navigator.serial) throw new Error('Web Serial är blockerad eller saknas i Chrome.');
    if (port) return;
    const selected = await navigator.serial.requestPort();
    await selected.open({ baudRate: 115200 });
    port = selected;
    armed = false;
    picoVerified = false;
    firmwareVersion = 0;
    lineBuffer = '';
    writer = port.writable.getWriter();
    try { await port.setSignals({ dataTerminalReady: true }); }
    catch (error) { log(`USB-signal kunde inte sättas: ${error.message}`); }
    readSerial(port);
    await send('PING');
    handshakeTimer = setTimeout(() => {
      if (port && !picoVerified) {
        picoError = 'Pico svarar inte. Kontrollera att UF2-programmet är installerat.';
        runError = picoError;
        updateStatus();
      }
    }, 4000);
    log('USB-port öppnad. Tryck BOOTSEL när båda anslutningarna är klara.');
  } catch (error) {
    log(`USB: ${error.message}`);
    picoError = `Fel: ${error.message}`;
    runError = picoError;
  }
  updateStatus();
}

function quizModalVisible(source) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  if (!width || !height) return false;
  const x = Math.floor(width * .36), y = Math.floor(height * .37);
  const w = Math.ceil(width * .28), h = Math.ceil(height * .06);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, x, y, w, h, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  // The question panel has a long, nearly black horizontal border here.
  // This is distinct from OCR: unreadable text does not mean the quiz vanished.
  const step = Math.max(1, Math.floor(w / 80));
  for (let row = 0; row < h; row += 2) {
    let dark = 0, count = 0;
    for (let col = 0; col < w; col += step) {
      const i = (row * w + col) * 4;
      if (pixels[i] < 60 && pixels[i + 1] < 60 && pixels[i + 2] < 60) dark++;
      count++;
    }
    if (dark / count >= .8) return true;
  }
  return false;
}

function cropRawFrame(source, x0, y0, x1, y1, scale = 2) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  const canvas = document.createElement('canvas');
  const w = Math.ceil(width * (x1 - x0)), h = Math.ceil(height * (y1 - y0));
  canvas.width = w * scale;
  canvas.height = h * scale;
  canvas.getContext('2d').drawImage(source, Math.floor(width * x0), Math.floor(height * y0), w, h,
    0, 0, canvas.width, canvas.height);
  return canvas;
}

function cropFrame(source, x0, y0, x1, y1, autoFit = false, whiteThreshold = 253) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  const sourceX = Math.floor(width * x0);
  const sourceY = Math.floor(height * y0);
  const sourceW = Math.ceil(width * (x1 - x0));
  const sourceH = Math.ceil(height * (y1 - y0));
  const raw = document.createElement('canvas');
  raw.width = sourceW;
  raw.height = sourceH;
  const rawContext = raw.getContext('2d', { willReadFrequently: true });
  rawContext.drawImage(source, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);
  const pixels = rawContext.getImageData(0, 0, sourceW, sourceH);
  // The quiz letters have a nearly pure white fill. Its pastel background does not.
  // Keeping only that fill avoids the black cartoon outlines confusing OCR.
  let minX = sourceW, minY = sourceH, maxX = 0, maxY = 0, inkCount = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const whiteInk = pixels.data[i] >= whiteThreshold &&
      pixels.data[i + 1] >= whiteThreshold && pixels.data[i + 2] >= whiteThreshold;
    if (whiteInk && autoFit) {
      const pixel = i / 4;
      const x = pixel % sourceW, y = Math.floor(pixel / sourceW);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      inkCount++;
    }
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = whiteInk ? 0 : 255;
    pixels.data[i + 3] = 255;
  }
  rawContext.putImageData(pixels, 0, 0);
  if (autoFit && (inkCount < 100 || maxX - minX > sourceW * .85 || maxY - minY > sourceH * .9)) return null;
  const pad = autoFit ? Math.max(10, Math.round(sourceW * .02)) : 0;
  const trimX = autoFit ? Math.max(0, minX - pad) : 0;
  const trimY = autoFit ? Math.max(0, minY - pad) : 0;
  const trimW = autoFit ? Math.min(sourceW - trimX, maxX - minX + pad * 2) : sourceW;
  const trimH = autoFit ? Math.min(sourceH - trimY, maxY - minY + pad * 2) : sourceH;
  const canvas = document.createElement('canvas');
  const scale = Math.min(3, 1500 / trimW);
  canvas.width = Math.max(1, Math.round(trimW * scale));
  canvas.height = Math.max(1, Math.round(trimH * scale));
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(raw, trimX, trimY, trimW, trimH, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function recognizeQuestion(source = video) {
  const context = preview.getContext('2d');
  context.drawImage(source, 0, 0, preview.width, preview.height);
  const modalVisible = quizModalVisible(source);
  if (!modalVisible) return { modalVisible, result: null };
  // Center regions follow the game modal. They can be adjusted after a real Chromebook capture.
  const progressImage = cropFrame(source, 0.40, 0.335, 0.60, 0.395);
  const questionImage = cropFrame(source, 0.32, 0.42, 0.68, 0.56, true);
  const progressText = (await worker.recognize(progressImage)).data.text;
  const questionText = questionImage ? (await worker.recognize(questionImage)).data.text : '';
  let question = parseProgress(progressText);
  let equation = parseEquation(questionText);
  if (!question) {
    const alternate = cropFrame(source, 0.40, 0.335, 0.60, 0.395, false, 250);
    question = parseProgress((await worker.recognize(alternate)).data.text);
  }
  if (!equation) {
    const alternate = cropFrame(source, 0.32, 0.42, 0.68, 0.56, true, 250);
    if (alternate) equation = parseEquation((await worker.recognize(alternate)).data.text);
  }
  return { modalVisible, result: question && equation ? { question, ...equation } : null };
}

async function trySpace(id) {
  if (spaceCheckInFlight || id !== completedFifthId || id !== goneSentId) return;
  spaceCheckInFlight = true;
  try {
    if (!screenActive() || !picoVerified || !armed || !worker ||
        !continuousWindowReady() || !helperIsUnfocused() || scanning || quizModalVisible(video)) return;
    const hud = cropRawFrame(video, .38, .02, .53, .08);
    const hudText = (await worker.recognize(hud)).data.text;
    if (!/SPEED/i.test(hudText)) return;
    if (!screenActive() || !picoVerified || !armed ||
        !continuousWindowReady() || !helperIsUnfocused() || quizModalVisible(video)) return;
    await send(`SPACE,${id}`);
    log('Bad Pico trycka Space efter kontroll av spelbilden.');
  } catch (error) { log(`Space-kontroll: ${error.message}`); }
  finally { spaceCheckInFlight = false; }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    if (!screenActive() || !port || !picoVerified || !worker || !armed ||
        !continuousWindowReady() || !helperIsUnfocused()) return;
    const { modalVisible, result } = await recognizeQuestion();
    if (!screenActive() || !port || !picoVerified || !armed ||
        !continuousWindowReady() || !helperIsUnfocused()) return;
    readout.textContent = result
      ? `Fråga ${result.question}/5: ${result.a} × ${result.b} = ${result.a * result.b}`
      : 'Ingen säker fråga syns just nu.';
    const candidate = guard.observe(result, Date.now(), modalVisible);
    if (completedFifthId && !goneSentId && guard.readyForNextQuiz && !modalVisible) {
      goneSentId = completedFifthId;
      await send(`GONE,${goneSentId}`);
      log('Quizrutan försvann efter fråga 5. Startade Picos 90-sekunderstimer.');
    }
    if (!candidate) return;
    // The second identical read must still belong to the currently shared screen.
    guard.markSent(candidate); // Never auto-retry a packet that may already type.
    const id = `Q${String(nextId++).padStart(6, '0')}`;
    if (candidate.question === 1 && completedFifthId) {
      completedFifthId = '';
      goneSentId = '';
    }
    sentQuestions.set(id, candidate.question);
    await send(`TYPE,${id},${candidate.a},${candidate.b}`);
    log(`Skickade fråga ${candidate.question}/5 till Pico: ${candidate.a} × ${candidate.b}.`);
  } catch (error) {
    log(`Avläsning: ${error.message}`);
  } finally {
    scanning = false;
    scheduleScan(1100);
  }
}

function scheduleScan(delay) {
  scanTimerWindow.clearTimeout(scanTimer);
  scanTimerWindow = pipWindow && !pipWindow.closed ? pipWindow : window;
  scanTimer = scanTimerWindow.setTimeout(scan, delay);
}

byId('screenButton').addEventListener('click', startScreen);
byId('picoButton').addEventListener('click', connectPico);
byId('pipButton').addEventListener('click', openHelperWindow);
async function runImageTest(file) {
  try {
    await ensureWorker();
    const image = await createImageBitmap(file);
    const { modalVisible, result } = await recognizeQuestion(image);
    readout.textContent = result
      ? `Bildtest: fråga ${result.question}/5: ${result.a} × ${result.b} = ${result.a * result.b}`
      : modalVisible ? 'Bildtest: quizrutan syns men frågan kunde inte läsas säkert.'
        : 'Bildtest: ingen quizruta syns.';
    image.close();
    log('Lokal bild kontrollerad. Inget svar skickades till Pico.');
  } catch (error) { log(`Bildtest: ${error.message}`); }
}
byId('imageTest').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (file) await runImageTest(file);
});
if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('sample')) {
  fetch('./__local-test.png').then(r => r.blob()).then(runImageTest)
    .catch(error => log(`Lokalt bildtest: ${error.message}`));
}
byId('testButton').addEventListener('click', async () => {
  try {
    const field = byId('testField');
    field.value = '';
    field.focus();
    const id = `TEST${String(nextId++).padStart(6, '0')}`;
    await send(`TYPE,${id},2,3`);
    log('Test: Pico ska skriva 6 i testfältet.');
  } catch (error) { log(`Test: ${error.message}`); }
});
window.addEventListener('beforeunload', () => stream?.getTracks().forEach(t => t.stop()));
scheduleScan(1100);
updateStatus();
