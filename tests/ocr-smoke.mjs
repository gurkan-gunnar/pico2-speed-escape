import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEquation, parseProgress } from '../docs/recognition.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'tools', 'package.json'));
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const image = process.argv[2];
if (!image) throw new Error('Supply a screenshot file');

const worker = await createWorker('eng', 1, {
  langPath: path.join(root, 'docs', 'vendor', 'lang'),
  gzip: true,
});
const cases = [
  ['progress', { left: Math.floor(1918 * .40), top: Math.floor(1198 * .335), width: Math.ceil(1918 * .20), height: Math.ceil(1198 * .06) }],
  ['question', { left: Math.floor(1918 * .36), top: Math.floor(1198 * .408), width: Math.ceil(1918 * .28), height: Math.ceil(1198 * .127) }],
];
for (const [name, rectangle] of cases) {
  const { data, info } = await sharp(image).extract(rectangle).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const method of ['original', 'white255', 'white245', 'dark100']) {
    let input;
    if (method === 'original') input = await sharp(image).extract(rectangle).resize({ width: rectangle.width * 3 }).png().toBuffer();
    else {
      const output = Buffer.alloc(info.width * info.height);
      for (let i = 0; i < output.length; i++) {
        const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
        const foreground = method === 'white255' ? r >= 253 && g >= 253 && b >= 253
          : method === 'white245' ? r >= 245 && g >= 245 && b >= 245
          : r < 100 && g < 100 && b < 100;
        output[i] = foreground ? 0 : 255;
      }
      input = await sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } })
        .resize({ width: info.width * 3, kernel: 'nearest' }).png().toBuffer();
    }
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const { data: ocr } = await worker.recognize(input);
    console.log(JSON.stringify({ name, method, text: ocr.text, confidence: ocr.confidence,
      question: parseProgress(ocr.text), equation: parseEquation(ocr.text) }));
  }
}
await worker.terminate();
