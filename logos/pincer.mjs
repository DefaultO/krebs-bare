// node logos/pincer.mjs   The Krebs mark: a K whose arm and leg are the two fingers of a claw, closing on a creep.
//
// Four shapes and nothing else: one bar, one big disc, one small disc taken out of it, two straight cuts. The box is 4M
// square, so M = 25 fills the viewBox and the stem's edges land on whole pixels at 24, 44 and 88 px (M is 6, 11, 22 px).
//
//   stem    M wide, full height. It never moves
//   back    the disc. Radius 2M, so it touches the top and bottom of the box exactly. Each finger's back is one
//           unbroken arc of it, which gives each finger a single point. The earlier mark had a flat cap and a square
//           corner here, so each claw had two points and read as a block letter with a bite out of it
//   notch   a straight cut at 45 degrees, 3M/2 across. It runs to the exact top of the back, which fixes the back's
//           centre at 3M/2 - M = M/2 right of the mark's centre. The notch is what makes it a K: without it the mark
//           falls apart into the digits 1 and 0. Its depth also keeps the stem standing apart from the arms
//   tip     where the back crosses the right edge of the box, so the tip is the furthest point of its finger
//   creep   the circle through both tips and through the point 9M/10 right of the stem, its centre on the axis.
//           That is three points, so its size is a result and not a choice. It comes out at radius exactly 110/3
//
// Weights: stem 25, neck 23.8, land 22.5, each finger tapering from the neck to nothing. The neck, the shortest way from
// the notch to the creep, is 95 percent of the stem on purpose: that is the usual optical allowance for a diagonal,
// which looks heavier than an upright of the same width, and it is the one optical correction in the drawing. LAND is
// the number that sets it. check() holds the neck between 90 and 100 percent of the stem.
//
// The mouth is deliberately wide. The creep is wrapped by 231 degrees, not the 311 of the earlier mark: past about 270
// the two fingers closed into a C and the mark read KC. The price is a long way to close, 26 degrees, and a full close
// that squeezes the creep into an almond and reads as a fish or an eye. Treat that pose as one to pass through, never to
// rest on. Up to about half way it is still a K with a claw.
//
// Three shapes, one silhouette. The stem is a rectangle. Each claw runs past the axis into the other by OVERLAP and
// back into the stem along the line of the notch, so at rest there is no seam and when a claw turns no gap can open.
// Closing is a rotation of CLOSE degrees about HINGE, the top claw clockwise and the bottom claw anticlockwise about
// HINGE's mirror image. HINGE is on the stem's right edge, level with the tip, so the tip starts by moving straight down
// and no point of a claw ever leaves the box: the svg needs no overflow. Both claws carry their own coordinates, with
// no transform attribute, so a CSS rotate cannot wipe out the mirroring.
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = 'pincer';

export const M = 25;
export const OVERLAP = 4;              // how far each claw runs past the axis, so no seam shows between them
const HALF = 2 * M;
const STEM = -M;                       // the stem's right edge
const NOTCH = 3 * M / 2;               // the 45 degree cut, measured across and down
export const BACK = { x: NOTCH - M, y: 0, r: 2 * M };
const LAND = 9 * M / 10;               // from the stem to the creep, along the axis

const DEG = 180 / Math.PI;
const num = n => { const s = (+n.toFixed(4)).toString(); return s === '-0' ? '0' : s; };

const CORNER = [STEM, -(HALF - NOTCH)];                // the notch's inner corner
const PEAK = [BACK.x, -HALF];                          // the notch meets the top of the back here
export const TIP = [HALF, -Math.sqrt(BACK.r ** 2 - (HALF - BACK.x) ** 2)];
export const HINGE = [STEM, TIP[1]];                   // on the stem, level with the tip: the top claw turns here
const THROAT = STEM + LAND;                            // the creep's left edge
// the circle with its centre on the axis through (THROAT, 0) and through the tip
const CX = (TIP[0] ** 2 + TIP[1] ** 2 - THROAT ** 2) / (2 * (TIP[0] - THROAT));
export const CREEP = { x: CX, y: 0, r: CX - THROAT };
const TAB = [CORNER[0] - 9, CORNER[1] + 9];            // the notch's line carried on inside the stem, out of sight
const LIP = [CREEP.x - Math.sqrt(CREEP.r ** 2 - OVERLAP ** 2), OVERLAP];   // where the creep's edge crosses the overlap
// the turn about the hinge that puts the tip on the axis
export const CLOSE = Math.asin(-HINGE[1] / (TIP[0] - HINGE[0])) * DEG;

/** A claw, walked from inside the stem: the notch, the back to the tip, the creep back past the axis. up = 1 is the top claw, -1 its mirror. */
const claw = up => {
  const y = n => num(up * n), outer = up > 0 ? 1 : 0, inner = up > 0 ? 0 : 1;
  return [
    `M${num(TAB[0])} ${y(TAB[1])}L${num(PEAK[0])} ${y(PEAK[1])}`,
    `A${num(BACK.r)} ${num(BACK.r)} 0 0 ${outer} ${num(TIP[0])} ${y(TIP[1])}`,
    `A${num(CREEP.r)} ${num(CREEP.r)} 0 0 ${inner} ${num(LIP[0])} ${y(LIP[1])}`,
    `H${num(TAB[0])}Z`,
  ].join('');
};
export const CLAW = claw(1), CLAW_BELOW = claw(-1);
export const SHAPES = `<rect id="stem" x="${num(-HALF)}" y="${num(-HALF)}" width="${num(M)}" height="${num(4 * M)}"/><path id="claw-top" d="${CLAW}"/><path id="claw-bottom" d="${CLAW_BELOW}"/>`;

export const svg = (size = null) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"${size ? ` width="${size}" height="${size}"` : ''} role="img" aria-label="Krebs">${SHAPES}</svg>`;

/** Turn p clockwise on screen about the hinge. */
const turn = ([x, y], a) => { const ux = x - HINGE[0], uy = y - HINGE[1], c = Math.cos(a), s = Math.sin(a); return [HINGE[0] + ux * c - uy * s, HINGE[1] + ux * s + uy * c]; };

// Every claim above, checked against the numbers rather than trusted.
function check() {
  const near = (a, b, why) => { if (Math.abs(a - b) > 1e-9) throw new Error(`${why}: ${a} is not ${b}`); };
  near(BACK.y - BACK.r, -HALF, 'the back touches the top of the box');
  near(BACK.y + BACK.r, HALF, 'the back touches the bottom of the box');
  near(PEAK[1] - CORNER[1], -(PEAK[0] - CORNER[0]), 'the notch runs at exactly 45 degrees');
  near((TAB[1] - CORNER[1]) / (TAB[0] - CORNER[0]), -1, 'the tab is on the line of the notch');
  near(Math.hypot(TIP[0] - BACK.x, TIP[1] - BACK.y), BACK.r, 'the tip is on the back');
  near(Math.hypot(TIP[0] - CREEP.x, TIP[1] - CREEP.y), CREEP.r, 'the tip is on the creep');
  near(CREEP.x - CREEP.r, THROAT, 'the creep passes through the throat');
  near(CREEP.r, 110 / 3, 'the creep is radius 110/3');
  near(turn(TIP, CLOSE / DEG)[1], 0, 'closing puts the tip on the axis');

  const neck = Math.hypot(CREEP.x - CORNER[0], CORNER[1]) - CREEP.r;
  if (neck < 0.9 * M || neck > M) throw new Error(`the neck ${neck} is outside the diagonal allowance`);

  // Through the whole close: the tab stays in the stem, and the claw never leaves the box.
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const a = t * CLOSE / DEG;
    for (const p of [TAB, [TAB[0], OVERLAP]]) {
      const [x] = turn(p, a);
      if (x < -HALF || x > STEM) throw new Error(`the tab leaves the stem at ${x}`);
    }
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {           // points along the back, peak to tip
      const a0 = Math.atan2(PEAK[1] - BACK.y, PEAK[0] - BACK.x), a1 = Math.atan2(TIP[1] - BACK.y, TIP[0] - BACK.x);
      const th = a0 + (a1 - a0) * u, p = [BACK.x + BACK.r * Math.cos(th), BACK.y + BACK.r * Math.sin(th)];
      const [x, y] = turn(p, a);
      if (x > HALF + 1e-9 || y < -HALF - 1e-9) throw new Error(`the claw leaves the box at ${x} ${y}`);
    }
  }
  // every stem edge lands on a whole pixel at each size the mark is shown
  for (const px of [24, 44, 88]) near((M * px / 100) % 1, 0, `M is whole pixels at ${px}`);

  // the angle inside the tip, between the two arcs
  const D = CREEP.x - BACK.x;
  const tipAngle = Math.acos((BACK.r ** 2 + CREEP.r ** 2 - D ** 2) / (2 * BACK.r * CREEP.r)) * DEG;
  const wrap = 360 - 2 * Math.atan2(-TIP[1], TIP[0] - CREEP.x) * DEG;
  return { tip: TIP.map(num), mouth: num(-2 * TIP[1]), creep: [num(CREEP.x), num(CREEP.r)], neck: num(neck), land: LAND, tipAngle: num(tipAngle), wrap: num(wrap), close: num(CLOSE), closedTip: turn(TIP, CLOSE / DEG).map(num) };
}

async function sheet() {
  const INK = '#f0ede6', GROUND = '#0a0a0a';
  const place = (size, x, y) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px">${svg(size)}</div>`;
  const page = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${GROUND};color:${INK};width:1280px;height:720px;overflow:hidden}svg{display:block}</style>${place(600, 60, 60)}${place(88, 800, 234)}${place(44, 800, 370)}${place(24, 800, 462)}`;
  const file = join(HERE, `${KEY}-sheet.html`);
  writeFileSync(file, page);

  const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:21450/json/version')).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(ok => { const i = ++id; waiting.set(i, ok); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: pathToFileURL(file).href }, s);
  await new Promise(r => setTimeout(r, 700));
  writeFileSync(join(HERE, `${KEY}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'));
  await send('Target.closeTarget', { targetId });
  ws.close();
  rmSync(file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(check());
  const note = `<!-- Close: rotate #claw-top ${num(CLOSE)}deg about (${HINGE.map(num).join(' ')}) and #claw-bottom -${num(CLOSE)}deg about (${num(HINGE[0])} ${num(-HINGE[1])}). Pass through the full close, do not rest on it. Fade the svg, not the shapes: they overlap. -->`;
  writeFileSync(join(HERE, `${KEY}.svg`), `${svg().replace('>', `>${note}`)}\n`);
  await sheet();
  console.log('saved');
  process.exit(0);
}
