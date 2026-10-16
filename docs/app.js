import { parseEquation, parseProgress, QuizGuard } from './recognition.js';

const byId = id => document.getElementById(id);
const video = byId('screenVideo');
const preview = byId('preview');
const screenState = byId('screenState');
const picoState = byId('picoState');
const runState = byId('runState');
const readout = byId('readout');
const logBox = byId('log');
const guard = new QuizGuard();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let stream = null;
let port = null;
let writer = null;
let armed = false;
let worker = null;
let scanTimer = null;
let lineBuffer = '';
let nextId = 1;
let scanning = false;

function log(message) {
  const time = new Date().toLocaleTimeString('sv-SE');
  logBox.textContent = `${time} ${message}\n${logBox.textContent}`.slice(0, 3500);
}

function screenActive() {
  return !!stream && stream.getVideoTracks().some(t => t.readyState === 'live') && video.readyState >= 2;
}

function updateStatus() {
  const screen = screenActive();
  screenState.textContent = screen ? 'Skärmen delas' : 'Inte ansluten';
  picoState.textContent = port ? (armed ? 'Ansluten och startad' : 'Ansluten, pausad') : 'Inte ansluten';
  byId('testButton').disabled = !port || !armed;
  runState.textContent = !screen || !port ? 'Väntar på anslutningar'
    : !worker ? 'Startar avläsningen'
    : armed ? 'Kör – Pico svarar på säkert avlästa frågor' : 'Redo – tryck BOOTSEL på Pico';
}

async function startScreen() {
  try {
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
    screenState.textContent = `Fel: ${error.message}`;
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
    log('Pico 2 svarar via USB.');
  } else if (line === 'STATE,ARMED') {
    armed = true;
    log('BOOTSEL: start.');
  } else if (line === 'STATE,PAUSED') {
    armed = false;
    log('BOOTSEL: paus.');
  } else if (line.startsWith('DONE,')) {
    log(`Pico skrev svar: ${line}`);
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
      port = null;
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
    if (!navigator.serial) throw new Error('Web Serial är blockerad eller saknas i Chrome.');
    if (port) return;
    const selected = await navigator.serial.requestPort();
    await selected.open({ baudRate: 115200 });
    port = selected;
    armed = false;
    lineBuffer = '';
    writer = port.writable.getWriter();
    try { await port.setSignals({ dataTerminalReady: true }); }
    catch (error) { log(`USB-signal kunde inte sättas: ${error.message}`); }
    readSerial(port);
    await send('PING');
    log('USB-port öppnad. Tryck BOOTSEL när båda anslutningarna är klara.');
  } catch (error) {
    log(`USB: ${error.message}`);
    picoState.textContent = `Fel: ${error.message}`;
  }
  updateStatus();
}

function cropFrame(source, x0, y0, x1, y1, autoFit = false) {
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
    const whiteInk = pixels.data[i] >= 253 && pixels.data[i + 1] >= 253 && pixels.data[i + 2] >= 253;
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
  // Center regions follow the game modal. They can be adjusted after a real Chromebook capture.
  const progressImage = cropFrame(source, 0.40, 0.335, 0.60, 0.395);
  const questionImage = cropFrame(source, 0.32, 0.42, 0.68, 0.56, true);
  const progressText = (await worker.recognize(progressImage)).data.text;
  const questionText = questionImage ? (await worker.recognize(questionImage)).data.text : '';
  const question = parseProgress(progressText);
  const equation = parseEquation(questionText);
  if (!question || !equation) return null;
  return { question, ...equation };
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    if (!screenActive() || !port || !worker || !armed || document.visibilityState !== 'hidden') return;
    const result = await recognizeQuestion();
    if (!screenActive() || !port || !armed || document.visibilityState !== 'hidden') return;
    readout.textContent = result
      ? `Fråga ${result.question}/5: ${result.a} × ${result.b} = ${result.a * result.b}`
      : 'Ingen säker fråga syns just nu.';
    const candidate = guard.observe(result, Date.now());
    if (!candidate) return;
    // The second identical read must still belong to the currently shared screen.
    guard.markSent(candidate); // Never auto-retry a packet that may already type.
    const id = `Q${String(nextId++).padStart(6, '0')}`;
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
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

byId('screenButton').addEventListener('click', startScreen);
byId('picoButton').addEventListener('click', connectPico);
async function runImageTest(file) {
  try {
    await ensureWorker();
    const image = await createImageBitmap(file);
    const result = await recognizeQuestion(image);
    readout.textContent = result
      ? `Bildtest: fråga ${result.question}/5: ${result.a} × ${result.b} = ${result.a * result.b}`
      : 'Bildtest: frågan kunde inte läsas säkert.';
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
