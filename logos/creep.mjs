// node creep.mjs        Writes creep.svg and creep.png, and prints a proof of the geometry.
//
// The Creep. A round body with two claws above it and three legs a side, all cut from one circle by one width of black.
// Nothing is placed by eye: a handful of numbers set the design and the rest is solved from them. All outlines are true
// circular arcs and straight lines.
//
// The rules, all checked at the bottom of this file:
//   Rim      The claw discs and the outer end of every leg sit on one circle, centred on the box. The top leg's top edge is
//            that circle's horizontal diameter. Solving this sets the claw's radius.
//   Channel  One width of black separates every neighbouring pair of pieces, except at the Neck (see below).
//   Legs     Three level bars of one height, one channel apart. A level cut stays crisp when the mark is small. A diagonal
//            cut cannot, and a radial cut turns the ring into a gear or a sun.
//   Grid     The legs repeat every 1/8 of the box, 11px at 88 and 3px at 24, and the channel is 4px at 88 and 1.09px at 24.
//            The top leg starts on the box's centre line, so every level edge is on a whole pixel at 88, and at 24 each
//            slot is one black row. At 44 the pitch is 5.5px, so the upper slot falls on a half pixel. That cannot be avoided
//            while 24 and 88 are both exact.
//   Centre   The middle leg is centred on the body, so the stack is symmetrical about the body's equator.
//   Seat     Each claw rests a channel above the top leg and a channel off the body. Solving both sets the body's radius.
//   Corners  One radius on every corner, each a real tangent arc, so no joint has a kink.
//   Mirror   The right half is the left half reflected, exactly.
//
// Optical corrections, both deliberate:
//   Neck     The claws stand NECK apart, more than a channel. Two circles open away from their nearest point, so a channel's
//            width there looks tighter than a channel, and on the centre line at an even pixel width it would go grey.
//   Mouth    The gape's edges are flat arcs, not one circle. A single circle gives a moon and a pair of round holes that
//            read as eyes. The crook is a decisive V, which is what makes it a pincer.
//
// Animating: #claw-left and #claw-right are separate paths, and data-shut on each holds the closed pose with exactly the
// same path commands, so `d` tweens straight from one to the other. The shut pose is an ogive with a slit, not a disc with a
// slit: two discs above a third read as Mickey Mouse. #legs-left and #legs-right are groups, one path per leg.
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const PX = 100 / 24;   // one pixel at 24px
const DESIGN = {
  R: 48,        // the rim: the mark's one circle
  G: 100 / 22,  // the channel: 4px at 88, 2px at 44, 1.09px at 24
  PITCH: 12.5,  // the leg's repeat, 1/8 of the box: 11px at 88, 3px at 24
  NECK: 7,      // the space between the claws at their nearest point
  CORNER: 1,    // the one corner radius
  AXIS: -30,    // the gape's axis, degrees left of straight up: the claws look at each other
  OPEN: 28,     // half the gape's mouth, degrees around the claw disc
  DEEP: 3.5,    // how far past the disc's centre the gape reaches
  ARC: 23,      // the radius of a finger's inner edge
  WRIST: 105,   // shut: how far round the disc, from the gape's axis, each finger's back leaves it
  REACH: 6,     // shut: how far past the disc the fingertips meet
  SLIT: 2,      // shut: the slit left between the fingertips
};

// ---- Exact outlines --------------------------------------------------------------------------------------------------
// Closed chains of lines and arcs, walked clockwise on screen (SVG y-down), so the inside of a shape is always to the right.
const RAD = Math.PI / 180;
const V = (x, y) => ({ x, y });
const add = (a, b) => V(a.x + b.x, a.y + b.y);
const sub = (a, b) => V(a.x - b.x, a.y - b.y);
const mul = (a, k) => V(a.x * k, a.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = a => mul(a, 1 / Math.hypot(a.x, a.y));
const right = d => V(-d.y, d.x);
const polar = (c, r, deg) => V(c.x + Math.cos(deg * RAD) * r, c.y + Math.sin(deg * RAD) * r);
const fromTop = (c, r, deg) => polar(c, r, -90 - deg);      // deg left of straight up
const arc = (c, r, cw = true) => ({ k: 'arc', c, r, cw });
const line = (p, d) => ({ k: 'line', p, d: unit(d) });

function tangentAt(curve, q) {
  if (curve.k === 'line') return curve.d;
  const t = right(unit(sub(q, curve.c)));
  return curve.cw ? t : mul(t, -1);
}
function lineCircle(l, c) {
  const f = sub(l.p, c.c), b = dot(f, l.d), disc = b * b - dot(f, f) + c.r * c.r;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [add(l.p, mul(l.d, -b + s)), add(l.p, mul(l.d, -b - s))];
}
function crossings(a, b) {
  if (a.k === 'line' && b.k === 'line') {
    const den = cross(a.d, b.d);
    return Math.abs(den) < 1e-12 ? [] : [add(a.p, mul(a.d, cross(sub(b.p, a.p), b.d) / den))];
  }
  if (a.k === 'line') return lineCircle(a, b);
  if (b.k === 'line') return lineCircle(b, a);
  const d = dist(a.c, b.c), x = (d * d + a.r * a.r - b.r * b.r) / (2 * d), h2 = a.r * a.r - x * x;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2), e = unit(sub(b.c, a.c)), m = add(a.c, mul(e, x)), n = right(e);
  return [add(m, mul(n, h)), add(m, mul(n, -h))];
}
function meet(a, b, hint) {
  const all = crossings(a, b);
  if (!all.length) throw new Error('curves do not meet');
  return all.sort((p, q) => dist(p, hint) - dist(q, hint))[0];
}
function offset(curve, side, rho) {                         // side +1: towards the inside of the shape
  if (curve.k === 'line') return { ...curve, p: add(curve.p, mul(right(curve.d), side * rho)) };
  return { ...curve, r: curve.r + (curve.cw ? -1 : 1) * side * rho };
}
function foot(curve, f) {
  if (curve.k === 'line') return add(curve.p, mul(curve.d, dot(sub(f, curve.p), curve.d)));
  return add(curve.c, mul(unit(sub(f, curve.c)), curve.r));
}
/** Walk a closed chain of curves, replacing each corner with a true tangent arc of radius rho. A link marked smooth meets the next one tangentially, with no corner. */
function outline(chain, rho) {
  const n = chain.length, corners = [];
  for (let i = 0; i < n; i++) {
    const a = chain[i], b = chain[(i + 1) % n];
    if (a.smooth) { corners.push({ start: a.to, end: a.to, smooth: true }); continue; }
    const v = meet(a.curve, b.curve, a.to);
    const side = cross(tangentAt(a.curve, v), tangentAt(b.curve, v)) > 0 ? 1 : -1;
    const f = meet(offset(a.curve, side, rho), offset(b.curve, side, rho), v);
    corners.push({ start: foot(a.curve, f), end: foot(b.curve, f), f, cw: side > 0 });
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i + n - 1) % n], here_ = corners[i];
    segs.push({ ...chain[i].curve, a: prev.end, b: here_.start });
    if (!here_.smooth) segs.push({ k: 'arc', c: here_.f, r: rho, cw: here_.cw, a: here_.start, b: here_.end });
  }
  return segs;
}
function sweep(s) {
  let d = Math.atan2(s.b.y - s.c.y, s.b.x - s.c.x) - Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
  if (s.cw) { while (d < 0) d += 2 * Math.PI; } else { while (d > 0) d -= 2 * Math.PI; }
  return d;
}
const f3 = n => { const s = n.toFixed(3).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
function pathOf(segs) {
  let d = `M${f3(segs[0].a.x)} ${f3(segs[0].a.y)}`;
  for (const s of segs) {
    if (s.k === 'line') d += `L${f3(s.b.x)} ${f3(s.b.y)}`;
    else d += `A${f3(s.r)} ${f3(s.r)} 0 ${Math.abs(sweep(s)) > Math.PI ? 1 : 0} ${s.cw ? 1 : 0} ${f3(s.b.x)} ${f3(s.b.y)}`;
  }
  return d + 'Z';
}
const flipX = p => V(-p.x, p.y);
const mirrored = segs => [...segs].reverse().map(s => ({ ...s, a: flipX(s.b), b: flipX(s.a), ...(s.c ? { c: flipX(s.c) } : {}), ...(s.p ? { p: flipX(s.p) } : {}) }));
function sample(segs, step = .1) {
  const pts = [];
  for (const s of segs) {
    if (s.k === 'line') {
      const n = Math.max(2, Math.ceil(dist(s.a, s.b) / step));
      for (let i = 0; i < n; i++) pts.push(add(s.a, mul(sub(s.b, s.a), i / n)));
    } else {
      const sw = sweep(s), n = Math.max(2, Math.ceil(Math.abs(sw) * s.r / step)), a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
      for (let i = 0; i < n; i++) pts.push(add(s.c, mul(V(Math.cos(a0 + sw * i / n), Math.sin(a0 + sw * i / n)), s.r)));
    }
  }
  return pts;
}
function worstKink(segs) {
  let worst = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length], q = a.b;
    const t0 = a.k === 'line' ? unit(sub(a.b, a.a)) : tangentAt(a, q), t1 = b.k === 'line' ? unit(sub(b.b, b.a)) : tangentAt(b, q);
    worst = Math.max(worst, Math.abs(Math.atan2(cross(t0, t1), dot(t0, t1))) / RAD);
  }
  return worst;
}
const shoelace = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; };
const area = segs => Math.abs(shoelace(sample(segs)));

// ---- The mark --------------------------------------------------------------------------------------------------------
function build() {
  const { R, G, PITCH, NECK, CORNER, AXIS, OPEN, DEEP, ARC, WRIST, REACH, SLIT } = DESIGN;
  const bar = PITCH - G, rails = [0, 1, 2].map(i => [i * PITCH, i * PITCH + bar]);   // Grid: the first leg starts on the box's centre line

  const BY = (rails[1][0] + rails[1][1]) / 2;               // Centre: the middle leg sits on the body's equator
  // Rim: with the rim on the box's centre and the claw a channel above the top leg, (R - H)^2 = (H + n)^2 + (H + G)^2.
  const n = NECK / 2, b = n + G + R, H = Math.sqrt(b * b + R * R - n * n - G * G) - b;
  const clawX = H + n, clawY = rails[0][0] - G - H;         // Seat: a channel above the top leg
  const CLAW = V(-clawX, clawY), BODY = V(0, BY);
  const RB = dist(CLAW, BODY) - H - G;                      // Seat: and a channel off the body
  const RIM = V(0, 0);
  const RI = RB + G;                                        // the channel's outer edge around the body

  // A claw at rest is one disc with a gape. Its outline has two joints, invisible at rest because every arc there lies on the
  // disc. To shut, the fingertips meet at a point beyond the disc on the gape's axis, and each finger's back leaves the disc on
  // a tangent arc, so the silhouette closes to an ogive tip instead of a full circle. Both poses use the same path commands.
  function clawSegs(shut) {
    const heelA = fromTop(CLAW, H, AXIS + WRIST), heelB = fromTop(CLAW, H, AXIS - WRIST), apex = fromTop(CLAW, DEEP, AXIS + 180);
    const tip = fromTop(CLAW, H + REACH, AXIS), across = right(unit(sub(tip, apex)));
    const T1 = shut ? add(tip, mul(across, -SLIT / 2)) : fromTop(CLAW, H, AXIS + OPEN);
    const T2 = shut ? add(tip, mul(across, SLIT / 2)) : fromTop(CLAW, H, AXIS - OPEN);
    const r = shut ? 120 : ARC, mouth = mul(add(T1, T2), .5), inside = add(mouth, mul(unit(sub(apex, mouth)), 5));
    const through = (a, b) => {
      const m = mul(add(a, b), .5), h = Math.sqrt(r * r - (dist(a, b) / 2) ** 2), n = right(unit(sub(b, a)));
      const c1 = add(m, mul(n, h)), c2 = add(m, mul(n, -h));
      return arc(dist(c1, inside) < dist(c2, inside) ? c1 : c2, r, false);
    };
    const leave = (heel, q) => {                            // the circle tangent to the disc at the heel, through q
      if (!shut) return arc(CLAW, H, true);
      const w = sub(q, heel), u = unit(sub(CLAW, heel)), rho = dot(w, w) / (2 * dot(w, u));
      return arc(add(heel, mul(u, rho)), rho, true);
    };
    return outline([
      { curve: arc(CLAW, H, true), to: heelA, smooth: true },
      { curve: leave(heelA, T1), to: T1 },
      { curve: through(T1, apex), to: apex },
      { curve: through(apex, T2), to: T2 },
      { curve: leave(heelB, T2), to: heelB, smooth: true },
    ], CORNER);
  }

  // A leg: a level bar cut from the space between the rim and the channel round the body.
  const rim = arc(RIM, R, true), inner = arc(BODY, RI, false);
  const rimAt = y => V(-Math.sqrt(R * R - (y - RIM.y) ** 2), y), innerAt = y => V(-Math.sqrt(RI * RI - (y - BY) ** 2), y);
  const legSegs = ([top, bottom]) => outline([
    { curve: rim, to: rimAt(top) },
    { curve: line(V(0, top), V(1, 0)), to: innerAt(top) },
    { curve: inner, to: innerAt(bottom) },
    { curve: line(V(0, bottom), V(-1, 0)), to: rimAt(bottom) },
  ], CORNER);

  return { H, CLAW, BODY, BY, RB, RIM, rails, bar, claw: clawSegs(false), clawShut: clawSegs(true), legs: rails.map(legSegs) };
}

const mark = build();
const { H, CLAW, BODY, BY, RB, RIM, rails, bar, claw, clawShut, legs } = mark;
const { R, G } = DESIGN;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"><title>Krebs</title>`
  + `<circle id="body" cx="0" cy="${f3(BY)}" r="${f3(RB)}"/>`
  + `<path id="claw-left" d="${pathOf(claw)}" data-shut="${pathOf(clawShut)}"/>`
  + `<path id="claw-right" d="${pathOf(mirrored(claw))}" data-shut="${pathOf(mirrored(clawShut))}"/>`
  + `<g id="legs-left">${legs.map(l => `<path d="${pathOf(l)}"/>`).join('')}</g>`
  + `<g id="legs-right">${legs.map(l => `<path d="${pathOf(mirrored(l))}"/>`).join('')}</g>`
  + `</svg>`;

// ---- Files -----------------------------------------------------------------------------------------------------------
async function shot(htmlPath, pngPath) {
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
  await send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` }, s);
  await new Promise(r => setTimeout(r, 700));
  writeFileSync(pngPath, Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'));
  await send('Target.closeTarget', { targetId });
  ws.close();
}

writeFileSync(join(here, 'creep.svg'), svg + '\n');
const sized = n => svg.replace('<svg ', `<svg width="${n}" height="${n}" `);
const sheet = join(here, 'creep.sheet.html');
writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0a0a0a;color:#f0ede6;height:720px;overflow:hidden}
body{display:grid;grid-template-columns:760px 1fr}
.big{display:flex;align-items:center;justify-content:center}
.side{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px}
svg{display:block}
</style><div class="big">${sized(620)}</div><div class="side">${sized(88)}${sized(44)}${sized(24)}</div>`);
await shot(sheet, join(here, 'creep.png'));
unlinkSync(sheet);

// ---- Proof, measured on the finished outlines ----------------------------------------------------------------------
const parts = [['claw', claw], ...legs.map((l, i) => [`leg${i + 1}`, l])];
const say = (...a) => console.log(...a);
const n3 = v => v.toFixed(3);
say(`solved    claw (${n3(CLAW.x)}, ${n3(CLAW.y)}) r ${n3(H)}, body (0, ${n3(BY)}) r ${n3(RB)}, rim (0, ${n3(RIM.y)}) r ${R}`);
say(`tangency  claw to rim ${(R - H - dist(CLAW, RIM)).toExponential(1)}, claw to body ${(dist(CLAW, BODY) - H - RB).toFixed(6)}, neck ${(-2 * CLAW.x - 2 * H).toFixed(6)}`);
say(`legs      rails ${rails.map(r => r.map(n3).join('..')).join('  ')}, height ${n3(bar)}, areas ${legs.map(l => n3(area(l))).join(' ')}`);
say(`grid      level edges at 88px ${rails.flat().map(y => n3((y + 50) * .88)).join(' ')}, at 24px ${rails.flat().map(y => n3((y + 50) / PX)).join(' ')}`);
for (const [name, s] of [...parts, ['claw shut', clawShut]]) say(`joints    ${name}: ${s.length} segments, worst kink ${worstKink(s).toFixed(4)} deg`);
const shape = d => d.replace(/A[^AZL]*/g, m => { const n = m.slice(1).split(/[ ]/); return `A${n[3]}${n[4]}`; }).replace(/[-0-9.]+ [-0-9.]+/g, 'p');
say(`tween     rest and shut share one command list: ${shape(pathOf(claw)) === shape(pathOf(clawShut))}`);
const pts = parts.map(([name, s]) => [name, sample(s, .15)]);
const all = [...pts, ...pts.map(([name, p]) => [`${name} mirrored`, p.map(flipX)])];
for (let i = 0; i < pts.length; i++) {
  let m = Infinity; for (const p of pts[i][1]) m = Math.min(m, dist(p, BODY) - RB);
  say(`channel   ${pts[i][0]} to body ${n3(m)}`);
  for (let j = i + 1; j < all.length; j++) {
    let d = Infinity; for (const p of pts[i][1]) for (let q = 0; q < all[j][1].length; q += 2) d = Math.min(d, dist(p, all[j][1][q]));
    if (d < 9) say(`channel   ${pts[i][0]} to ${all[j][0]} ${n3(d)}`);
  }
}
const ys = pts.flatMap(([, p]) => p.map(q => q.y)), xs = pts.flatMap(([, p]) => p.map(q => q.x));
const top = Math.min(...ys), bottom = Math.max(...ys, BY + RB);
let mass = Math.PI * RB * RB, moment = mass * BY;
for (const [, s] of parts) {
  const p = sample(s); let a = 0, cy = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], c = p[i].x * q.y - q.x * p[i].y; a += c; cy += (p[i].y + q.y) * c; }
  mass += 2 * Math.abs(a / 2); moment += 2 * Math.abs(a / 2) * (cy / (3 * a));
}
say(`placed    ink y ${n3(top)} to ${n3(bottom)}, centre of extent ${n3((top + bottom) / 2)}, centre of mass ${n3(moment / mass)}, x ${n3(Math.min(...xs))} to ${n3(-Math.min(...xs))}`);
process.exit(0);
