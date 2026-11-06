// node logos/compare.mjs [out.png]   All five Krebs concepts on one 1280x720 sheet, cream on black, at true pixels.
// Five rows of 200px marks need 1000px of height, so each concept is a column instead; every size then lines up across
// the sheet. Marks are drawn at deviceScaleFactor 1, so the 24px column of ink is what a 24px logo really looks like.
// Prints each mark's geometry against its box, so a crop shows up as a number and not only by eye.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREAM = '#f0ede6', GROUND = '#0a0a0a';
const WIDTH = 1280, HEIGHT = 720, SIZES = [200, 88, 24];
// seal uses its flat cut: seal.svg's mask id is page-global, and this sheet inlines each mark three times
const CONCEPTS = [['sign', 'sign.svg'], ['crab', 'crab.svg'], ['creep', 'creep.svg'], ['seal', 'seal-flat.svg'], ['pincer', 'pincer.svg']];

const source = Object.fromEntries(CONCEPTS.map(([name, file]) => [name, readFileSync(join(HERE, file), 'utf8')
  .replace(/<title>.*?<\/title>/s, '')
  .replace(/\sid="[^"]*"/g, '')]));

const mark = (name, size) => source[name].replace('<svg ', `<svg data-name="${name}" data-size="${size}" width="${size}" height="${size}" `);
const column = ([name]) => `<section><h2>${name}</h2>${SIZES.map(size => mark(name, size)).join('')}</section>`;

const html = `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; background: ${GROUND}; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; color: ${CREAM}; display: grid; grid-template-columns: repeat(${CONCEPTS.length}, 1fr); }
section { display: flex; flex-direction: column; align-items: center; padding-top: 84px; }
h2 { margin: 0 0 44px; height: 14px; font: 500 12px/14px Arial, sans-serif; letter-spacing: .14em; text-transform: uppercase; opacity: .6; }
svg { display: block; flex: none; color: ${CREAM}; }
svg + svg { margin-top: 88px; }
</style>${CONCEPTS.map(column).join('')}`;

const sheet = join(HERE, 'compare.html');
const out = process.argv[2] ?? join(HERE, 'compare.png');
writeFileSync(sheet, html);

const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:21450/json/version')).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise(ok => { const i = ++id; waiting.set(i, ok); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, s);
await send('Runtime.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, s);
await send('Page.navigate', { url: pathToFileURL(sheet).href }, s);
await new Promise(r => setTimeout(r, 900));

const png = (await send('Page.captureScreenshot', { format: 'png' }, s)).data;
writeFileSync(out, Buffer.from(png, 'base64'));

// the geometry of each mark against its viewBox, and how much ink the real screenshot holds inside and just outside its box
const check = `(async () => {
  const img = new Image();
  img.src = 'data:image/png;base64,${png}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const ink = (x, y, w, h) => {
    const d = g.getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  };
  const rows = [...document.querySelectorAll('svg')].map(el => {
    const r = el.getBoundingClientRect(), b = el.getBBox();
    const x = Math.round(r.left), y = Math.round(r.top), w = Math.round(r.width), h = Math.round(r.height), M = 6;
    const round = n => +n.toFixed(2);
    return {
      name: el.dataset.name, size: +el.dataset.size, x, y,
      geometry: [round(b.x), round(b.y), round(b.x + b.width), round(b.y + b.height)],
      overflow: round(Math.max(-50 - b.x, -50 - b.y, b.x + b.width - 50, b.y + b.height - 50, 0)),
      ink: ink(x, y, w, h),
      outside: ink(x - M, y - M, w + M * 2, h + M * 2) - ink(x, y, w, h),
    };
  });
  return JSON.stringify({ rows, width: img.width, height: img.height, scrolled: document.documentElement.scrollHeight });
})()`;
const { result } = await send('Runtime.evaluate', { expression: check, awaitPromise: true, returnByValue: true }, s);
const report = JSON.parse(result.value);
await send('Target.closeTarget', { targetId });
ws.close();

console.log(`${out}  ${report.width}x${report.height}  page height ${report.scrolled}`);
for (const r of report.rows) console.log(`${r.name.padEnd(7)}${String(r.size).padStart(4)}px at ${String(r.x).padStart(4)},${String(r.y).padStart(4)}  geometry ${r.geometry.join(' ').padEnd(30)} past box ${r.overflow}  ink px ${r.ink}  ink just outside ${r.outside}`);
const bad = report.rows.filter(r => !r.ink || r.overflow > 0.01 || r.outside);
console.log(bad.length ? `PROBLEM: ${bad.map(r => `${r.name}@${r.size}`).join(', ')}` : 'every mark has ink, and none reaches past its box');
process.exit(bad.length ? 1 : 0);
