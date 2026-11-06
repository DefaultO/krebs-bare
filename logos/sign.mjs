// node logos/sign.mjs   Krebs, "The Sign": the Cancer glyph as two crab fingers, each curled over the other's creep.
//
// Three chosen numbers, on a 24 unit grid so the 24px mark lands on whole pixels: width 24, dot 8, channel 2. All else follows.
//   dot        a true circle, the creep. Two of them, one channel apart side to side, each sitting on the channel from its own side.
//   weight     what the width leaves over: 3 | 8 | 2 | 8 | 3 = 24. The arm leaves the creep at that weight.
//   crown      a straight run from the dot's apex, so a claw's top is one line and the mark is 8 + 2 + 8 = 18 tall.
//   shoulder   one circle tangent to the crown and to the mark's edge. Its centre stands exactly over the other creep, which fixes
//              its radius at 7.
//   tip        the shoulder runs on past the edge's tangent point and stops on the channel line. So each claw stands on the channel
//              at exactly two points, its creep and its tip, and no part of it crosses.
//   inner edge one circle of twice the shoulder's radius, tangent to the arm's underside, through the tip. A crab's finger is
//              convex outside and nearly flat inside: this keeps the arm's weight round the shoulder and puts all the taper at the
//              end, so the point is a sturdy 48 degrees, not a needle that greys out at 24px.
//   claw B     claw A turned a half turn about the origin. Coordinates are negated, not transformed, so it is exact.
//
// No optical corrections. The top is flush with the dot, so there is no overshoot to make, and nothing here is eyeballed.
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = 'sign';
const { hypot, sqrt, atan2, cos, sin, abs, PI } = Math;

const U = 100 / 24;                      // one grid unit, one pixel of the 24px mark
const W = 12 * U;                        // half width. The mark runs edge to edge, so 88px wide means 88px of mark.
const R_DOT = 4 * U;                     // the creep's radius
const G = 2 * U;                         // the channel

const Y = -G / 2;                        // the channel's top edge
const WEIGHT = W - 2 * R_DOT - G / 2;    // 3 | 8 | 2 | 8 | 3
const D = [-(R_DOT + G / 2), Y - R_DOT]; // the creep
const OTHER = [-D[0], -D[1]];
const TOP = Y - 2 * R_DOT;               // the crown line, flush with the creep's apex
const R = W - OTHER[0];                  // the shoulder: centred over the other creep, touching the edge
const C = [OTHER[0], TOP + R];           // the shoulder's centre
const INNER_Y = TOP + WEIGHT;            // the arm's underside
const TIP = [C[0] + sqrt(R * R - (Y - C[1]) ** 2), Y];   // the point, on the channel line
const R2 = 2 * R;                        // the inner edge
const C2 = [TIP[0] - sqrt(R2 * R2 - (TIP[1] - INNER_Y - R2) ** 2), INNER_Y + R2];  // its centre: tangent to the underside, through the tip
const X = [D[0] + sqrt(R_DOT * R_DOT - (INNER_Y - D[1]) ** 2), INNER_Y];  // the crotch

const dist = (a, b) => hypot(a[0] - b[0], a[1] - b[1]);
const num = v => { const s = v.toFixed(3).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
const pt = (p, k) => `${num(k * p[0])} ${num(k * p[1])}`;
/** Claw A for k = 1, claw B for k = -1: a half turn keeps every sweep flag and negates every coordinate. */
const clawPath = k => `M${pt([D[0] - R_DOT, D[1]], k)}A${num(R_DOT)} ${num(R_DOT)} 0 0 1 ${pt([D[0], TOP], k)}L${pt([C[0], TOP], k)}A${num(R)} ${num(R)} 0 0 1 ${pt(TIP, k)}A${num(R2)} ${num(R2)} 0 0 0 ${pt([C2[0], INNER_Y], k)}L${pt(X, k)}A${num(R_DOT)} ${num(R_DOT)} 0 1 1 ${pt([D[0] - R_DOT, D[1]], k)}Z`;

export const CLAW_A = clawPath(1), CLAW_B = clawPath(-1);
export const PIVOT_A = D, PIVOT_B = OTHER;

/** Claw A's outline as points, for measuring. */
function outline(step = 0.2) {
  const out = [], line = (a, b) => { const n = Math.ceil(dist(a, b) / step); for (let i = 0; i < n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); };
  const arc = (c, r, a0, a1) => { const n = Math.ceil(abs(a1 - a0) * r / step); for (let i = 0; i < n; i++) { const t = a0 + (a1 - a0) * i / n; out.push([c[0] + r * cos(t), c[1] + r * sin(t)]); } };
  const ang = (c, p) => atan2(p[1] - c[1], p[0] - c[0]);
  arc(D, R_DOT, -PI, -PI / 2);
  line([D[0], TOP], [C[0], TOP]);
  arc(C, R, -PI / 2, ang(C, TIP));
  arc(C2, R2, ang(C2, TIP), -PI / 2);
  line([C2[0], INNER_Y], X);
  arc(D, R_DOT, ang(D, X), PI);
  return out;
}
const OUTLINE = outline();

/** How far both claws turn, clockwise on screen, each about its own creep, before they touch. */
function closeAngle() {
  const turned = t => OUTLINE.map(p => { const x = p[0] - D[0], y = p[1] - D[1]; return [D[0] + x * cos(t) - y * sin(t), D[1] + x * sin(t) + y * cos(t)]; });
  const gap = t => { const a = turned(t); let g = Infinity; for (const p of a) for (const q of a) g = Math.min(g, hypot(p[0] + q[0], p[1] + q[1])); return g; };
  let a = 0, b = 0.6;
  for (let i = 0; i < 26; i++) { const m = (a + b) / 2; if (gap(m) < 0.3) b = m; else a = m; }
  return a * 180 / PI;
}
export const CLOSE_DEGREES = closeAngle();

const svg = attrs => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"${attrs ?? ''}><title>Krebs</title><path id="claw-a" data-pivot="${pt(PIVOT_A, 1)}" data-close="${num(CLOSE_DEGREES)}" d="${CLAW_A}"/><path id="claw-b" data-pivot="${pt(PIVOT_B, 1)}" data-close="${num(CLOSE_DEGREES)}" d="${CLAW_B}"/></svg>`;

// Checks. A failure here stops the build rather than shipping an imperfect mark.
const near = (a, b, label, tol = 1e-9) => { if (abs(a - b) > tol) throw new Error(`${label}: ${a} vs ${b}`); };
near(WEIGHT, 3 * U, 'weight is 3 units');
near(R, 7 * U, 'shoulder radius is 7 units');
near(TOP, -9 * U, 'crown on a whole pixel');
near(INNER_Y, -6 * U, 'underside on a whole pixel');
near(D[1] + R_DOT, Y, 'creep sits on the channel');
near(C[1] - R, TOP, 'shoulder tangent to the crown');
near(C[0] + R, W, 'shoulder tangent to the edge');
near(C[0], OTHER[0], 'shoulder stands over the other creep');
near(dist(TIP, C), R, 'tip on the outer circle');
near(dist(TIP, C2), R2, 'tip on the inner circle');
near(C2[1] - R2, INNER_Y, 'inner circle tangent to the underside');
near(TIP[1], Y, 'tip on the channel');
near(dist(X, D), R_DOT, 'crotch on the creep');
near(OTHER[0] - R_DOT - (D[0] + R_DOT), G, 'creeps one channel apart');
if (Math.max(...OUTLINE.map(p => p[1])) > Y + 1e-9) throw new Error('a claw crosses the channel');
if (Math.max(...OUTLINE.map(p => p[0])) > W + 1e-9) throw new Error('a claw leaves the mark');
if (C2[0] <= X[0]) throw new Error('the inner edge has swallowed the crown');

const tangentDeg = (c, p, sweep) => (atan2(p[1] - c[1], p[0] - c[0]) * 180 / PI + sweep + 360) % 360;
const tipAngle = tangentDeg(C, TIP, 90) - tangentDeg(C2, TIP, 90);
const facts = { unit: U, weight: WEIGHT, R, R2, C, C2, tip: TIP, tipAngle, tipGapUnits: (dist(TIP, OTHER) - R_DOT) / U, crotch: X, closeDegrees: CLOSE_DEGREES };
console.log(JSON.stringify(facts, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));
writeFileSync(join(HERE, `${KEY}.svg`), svg() + '\n');

async function render() {
  const sized = n => svg(` width="${n}" height="${n}"`);
  const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0a0a0a; color: #f0ede6; }
  body { display: grid; grid-template-columns: 860px 1fr; height: 720px; width: 1280px; }
  .big { display: flex; align-items: center; justify-content: center; }
  .side { display: flex; flex-direction: column; justify-content: center; gap: 56px; padding-left: 60px; }
  svg { display: block; }
  </style><div class="big">${sized(660)}</div><div class="side">${sized(88)}${sized(44)}${sized(24)}</div>`;
  const page = join(HERE, `${KEY}.sheet.html`);
  writeFileSync(page, html);
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
  await send('Page.navigate', { url: 'file:///' + page.split(String.fromCharCode(92)).join('/') }, s);
  await new Promise(r => setTimeout(r, 900));
  writeFileSync(join(HERE, `${KEY}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'));
  await send('Target.closeTarget', { targetId });
  ws.close();
  unlinkSync(page);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await render();
  console.log('saved');
  process.exit(0);
}
