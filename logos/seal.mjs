// node logos/seal.mjs    Krebs, the seal. A kamon: one solid disc with a crab knocked out of it, upright on its axis.
//
// Upright is load-bearing. Any tilt gives the crab a front and a back, and at 44px it becomes a leaping hare or a scorpion. Upright,
// the axis also lands on a pixel boundary at every even size. The upright drawing's old risk, a frowning face, came from a thin arched
// body, loose claws and arched legs, so all three are designed out below: a thick body, claws fused to it, legs fanned to the sides.
//
// The visible outline is a chain of true circular arcs: no beziers. Junctions are circle intersections or computed tangent
// points, and the shapes are merged by an exact arc union, so the crab is one outline.
// Writes seal.svg (claws separate, for animation), seal-flat.svg (one compound path) and seal.png (the sheet),
// and prints the measurements that back all of the above.
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAU = Math.PI * 2, RAD = Math.PI / 180;

/* ---- the system: units are a 100 unit square, so 1px at 24px is 100/24 units ---- */
export const SYSTEM = {
  R: 50,                // the seal fills the box: the rim is expensive at 24px and the disc needs every unit
  LIM: 42.5,            // an invisible circle. Every limb stops exactly on it, so the cream rim is one constant width
  W: 7.5,               // the one stroke weight: every leg, the arm at its neck, and the rim itself (R - LIM). 1.8px at 24px
  // the body: a lens for the dome, thick so it can never be a mouth, with its corners buried in the arms so they never poke
  // out, and below it the circle through the leg crotches, which is computed in build()
  by: .5, bw: 27, bu: 11, bd: 8, CLEAR: .2, BURY: 2,
  // the legs: each is the circle through the hub on the axis that crosses LIM at a right angle where it lands, a geodesic of
  // LIM. So they fan from one point, rise and arch over like a real leg, and each end is square to the rim
  HUB: 8, LEGS: [19, 41, 63],
  // the arm: a ring of the one weight round a point below PHI. Its outer edge reaches LIM through a third circle, tangent to both,
  // so the curve eases from radius 42.5 through EASE_R to RHO with no corner and no sudden knee. That third circle only exists
  // if the arm's circle stands EASE_GAP clear of LIM: a circle between two circles touching at one point must pass through it
  RHO: 24, PHI: -41, EASE_R: 31, EASE_GAP: .8,
  // the claw, in polar coordinates round the seal. sA, sB, sP are signed sagittas: how far each edge bows off its chord
  TIP: -72, MOUTH: [29, -40], INNER: [32, -77], sA: 1.2, sB: 1.2, sP: -6.5, WRIST: [32, -12],
};

/* ---- circle geometry ---- */
const V = (x, y) => ({ x, y }), C = (x, y, r) => ({ x, y, r });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const polar = (r, deg, o = V(0, 0)) => V(o.x + Math.cos(deg * RAD) * r, o.y + Math.sin(deg * RAD) * r);
const nearest = (ps, g) => ps.slice().sort((p, q) => dist(p, g) - dist(q, g))[0];
function isect(a, b) {
  const d = dist(a, b), l = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h2 = a.r * a.r - l * l;
  if (h2 < 0 || d === 0) return [];
  const h = Math.sqrt(h2), ux = (b.x - a.x) / d, uy = (b.y - a.y) / d, mx = a.x + ux * l, my = a.y + uy * l;
  return [V(mx - uy * h, my + ux * h), V(mx + uy * h, my - ux * h)];
}
/** The circle through p and q that bows by sag at the chord's middle. Positive bows to the left of p to q as seen on screen. */
function bow(p, q, sag) {
  const d = dist(p, q), r = (d * d / 4 + sag * sag) / (2 * Math.abs(sag)), nx = (q.y - p.y) / d, ny = -(q.x - p.x) / d, k = Math.sign(sag) * (Math.abs(sag) - r);
  return C((p.x + q.x) / 2 + nx * k, (p.y + q.y) / 2 + ny * k, r);
}
/** The shorter arc on c from p to q. */
const arc = (c, p, q) => {
  const a0 = Math.atan2(p.y - c.y, p.x - c.x), a1 = Math.atan2(q.y - c.y, q.x - c.x);
  let d = ((a1 - a0) % TAU + TAU) % TAU; if (d > Math.PI) d -= TAU;
  return { c, p, q, a0, d };
};
const line = (p, q) => ({ p, q });
const at = (g, t) => g.c ? polar(g.c.r, (g.a0 + g.d * t) / RAD, g.c) : V(g.p.x + (g.q.x - g.p.x) * t, g.p.y + (g.q.y - g.p.y) * t);
const reverse = g => g.c ? { c: g.c, p: g.q, q: g.p, a0: g.a0 + g.d, d: -g.d } : line(g.q, g.p);

const xfSeg = (g, f, flip) => {
  const p = f(g.p), q = f(g.q);
  if (!g.c) return line(p, q);
  const c = f(g.c); c.r = g.c.r;
  return { c, p, q, a0: Math.atan2(p.y - c.y, p.x - c.x), d: flip ? -g.d : g.d };
};
const mirror = s => s.map(g => xfSeg(g, p => V(-p.x, p.y), true));

/* ---- exact union of arc-bounded shapes: split every edge where it crosses another shape, keep what is outside, restitch ---- */
const sample = (s, n = 48) => s.flatMap(g => g.c ? Array.from({ length: n }, (_, i) => at(g, i / n)) : [g.p]);
const area = s => { const p = sample(s); let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; };
const oriented = s => area(s) > 0 ? s : s.slice().reverse().map(reverse);
const contains = (s, m) => { const p = sample(s, 96); let w = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i].y > m.y) !== (p[j].y > m.y) && m.x < (p[j].x - p[i].x) * (m.y - p[i].y) / (p[j].y - p[i].y) + p[i].x) w = !w; return w; };
const onArc = (g, p) => { let a = Math.atan2(p.y - g.c.y, p.x - g.c.x) - g.a0; a = g.d > 0 ? ((a % TAU) + TAU) % TAU : -(((-a % TAU) + TAU) % TAU); return Math.abs(a) <= Math.abs(g.d) + 1e-9 ? a / g.d : null; };
const onLine = (g, p) => { const dx = g.q.x - g.p.x, dy = g.q.y - g.p.y, t = ((p.x - g.p.x) * dx + (p.y - g.p.y) * dy) / (dx * dx + dy * dy); return t >= -1e-9 && t <= 1 + 1e-9 ? t : null; };
const tOn = (g, p) => g.c ? onArc(g, p) : onLine(g, p);
function crossings(a, b) {
  let pts = [];
  if (a.c && b.c) pts = isect(a.c, b.c);
  else if (!a.c && !b.c) {
    const dax = a.q.x - a.p.x, day = a.q.y - a.p.y, dbx = b.q.x - b.p.x, dby = b.q.y - b.p.y, den = dax * dby - day * dbx;
    if (Math.abs(den) > 1e-12) { const t = ((b.p.x - a.p.x) * dby - (b.p.y - a.p.y) * dbx) / den; pts = [V(a.p.x + dax * t, a.p.y + day * t)]; }
  } else {
    const [ln, ar] = a.c ? [b, a] : [a, b], dx = ln.q.x - ln.p.x, dy = ln.q.y - ln.p.y, fx = ln.p.x - ar.c.x, fy = ln.p.y - ar.c.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), D = B * B - 4 * A * (fx * fx + fy * fy - ar.c.r * ar.c.r);
    if (D >= 0) pts = [-1, 1].map(s => { const t = (-B + s * Math.sqrt(D)) / (2 * A); return V(ln.p.x + dx * t, ln.p.y + dy * t); });
  }
  return pts.filter(p => tOn(a, p) !== null && tOn(b, p) !== null);
}
export function union(shapes) {
  const loops = shapes.map(oriented), kept = [];
  loops.forEach((loop, i) => loop.forEach(g => {
    const cuts = [];
    loops.forEach((other, j) => { if (j !== i) other.forEach(h => crossings(g, h).forEach(p => cuts.push(tOn(g, p)))); });
    const ts = [0, ...cuts.filter(t => t > 1e-9 && t < 1 - 1e-9).sort((a, b) => a - b), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-9) continue;
      const p = at(g, ts[k]), q = at(g, ts[k + 1]);
      const part = g.c ? { c: g.c, p, q, a0: g.a0 + g.d * ts[k], d: g.d * (ts[k + 1] - ts[k]) } : line(p, q);
      if (!loops.some((other, j) => j !== i && contains(other, at(part, .5)))) kept.push(part);
    }
  }));
  const result = [], left = kept.slice();
  while (left.length) {
    const out = [left.shift()];
    for (;;) {
      const end = out[out.length - 1].q;
      if (dist(end, out[0].p) < 1e-6) break;
      const k = left.findIndex(g => dist(g.p, end) < 1e-6);
      if (k < 0) throw new Error('open loop at ' + JSON.stringify(end));
      out.push(left.splice(k, 1)[0]);
    }
    result.push(out);
  }
  return result;
}

/* ---- the crab, upright, in its own frame ---- */
/** The carapace's upper half: a lens wide enough to bury its corners in the arms, shallow underneath so it clears the crotches. */
function dome({ by, bw, bu, bd }) {
  const rt = (bw * bw + bu * bu) / (2 * bu), rb = (bw * bw + bd * bd) / (2 * bd);
  const top = C(0, by - bu + rt, rt), bot = C(0, by + bd - rb, rb), l = V(-bw, by), r = V(bw, by);
  return [arc(top, l, r), arc(bot, r, l)];
}
/** The carapace's lower half: the part of the circle below a chord at y, round through the bottom. The chord is buried in the dome. */
const belly = (c, y) => {
  const h = Math.sqrt(c.r * c.r - (y - c.y) ** 2), r = V(h, y), l = V(-h, y), a0 = Math.atan2(y - c.y, h), a1 = Math.atan2(y - c.y, -h);
  return [{ c, p: r, q: l, a0, d: ((a1 - a0) % TAU + TAU) % TAU }, line(l, r)];
};
/** One leg: the circle through hub H that crosses LIM at a right angle at theta, as a band of the one weight, stopped on LIM. */
function leg(S, H, theta) {
  const L = C(0, 0, S.LIM), T = polar(S.LIM, theta), u = V(-Math.sin(theta * RAD), Math.cos(theta * RAD)), d = V(T.x - H.x, T.y - H.y);
  const s = -(d.x * d.x + d.y * d.y) / (2 * (u.x * d.x + u.y * d.y)), c = V(T.x + s * u.x, T.y + s * u.y), r = Math.abs(s);
  const co = C(c.x, c.y, r + S.W / 2), ci = C(c.x, c.y, r - S.W / 2), po = nearest(isect(co, L), T), pi = nearest(isect(ci, L), T);
  const at0 = Math.atan2(T.y - c.y, T.x - c.x) / RAD, sweep = ((Math.atan2(H.y - c.y, H.x - c.x) / RAD - at0) % 360 + 540) % 360 - 180, start = at0 + sweep * .8;
  const so = polar(co.r, start, c), si = polar(ci.r, start, c);
  const shape = [arc(co, so, po), arc(L, po, pi), arc(ci, pi, si), line(si, so)];
  shape.edges = [co, ci];
  return shape;
}
/** Where two neighbouring legs' facing edges cross: the point of the cream gap between them. It is the crossing farthest from
    the hub inside LIM, because all these circles also meet again at the hub's inverse, far outside the disc. */
const crotch = (a, b, H, lim) => a.edges.flatMap(p => b.edges.flatMap(q => isect(p, q))).filter(p => Math.hypot(p.x, p.y) < lim).sort((p, q) => dist(q, H) - dist(p, H))[0];
/** The circle on the axis through two points on the right. */
function axisCircle(p, q) { const y = (q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y) / (2 * (q.y - p.y)); return C(0, y, Math.hypot(p.x, p.y - y)); }
const armCentre = S => polar(S.LIM - S.RHO - S.EASE_GAP, S.PHI);
/** The circle that eases LIM into the arm: internally tangent to LIM at t1, and it holds the arm's outer circle tangent at t2. */
function ease(S) {
  const a = S.LIM - S.EASE_R, b = S.LIM - S.RHO - S.EASE_GAP, c = S.EASE_R - S.RHO, phi = S.PHI - Math.acos((a * a + b * b - c * c) / (2 * a * b)) / RAD;
  const ac = armCentre(S), e = polar(a, phi);
  return { circle: C(e.x, e.y, S.EASE_R), t1: polar(S.LIM, phi), t2: polar(S.EASE_R, Math.atan2(ac.y - e.y, ac.x - e.x) / RAD, e) };
}
/** One gesture from body to fingertip. Outer edge: the arm's circle, the easing circle, then LIM, each on a shared tangent.
    Inner edge: the arm's circle at one stroke weight in, then a sharp wrist, the palm, the inner finger, the forked mouth. */
function limb(S) {
  const L = C(0, 0, S.LIM), ac = armCentre(S), Ao = C(ac.x, ac.y, S.RHO), Ai = C(ac.x, ac.y, S.RHO - S.W), e = ease(S);
  const A = polar(S.LIM, S.TIP), M = polar(...S.MOUTH), B = polar(...S.INNER);
  const So = polar(Ao.r, 120, ac), Si = polar(Ai.r, 120, ac);
  const W = polar(...S.WRIST), P = bow(B, W, S.sP), X = nearest(isect(P, Ai), W);
  return [arc(Ao, So, e.t2), arc(e.circle, e.t2, e.t1), arc(L, e.t1, A), arc(bow(A, M, S.sA), A, M), arc(bow(M, B, S.sB), M, B), arc(P, B, X), arc(Ai, X, Si), line(Si, So)];
}
/** How far to rotate a claw about its pivot until its inner fingertip lands on the axis: the mark's closed state. */
function closeAngle(S) {
  const ac = armCentre(S), B = polar(...S.INNER), r = dist(B, ac), now = Math.atan2(B.y - ac.y, B.x - ac.x);
  return (-Math.PI + Math.acos(ac.x / r) - now) / RAD;   // the point of the fingertip's circle at x = 0, on the upper side
}

/* ---- the mark ---- */
const n = v => { const s = (+v.toFixed(3)).toString(); return s === '-0' ? '0' : s; };
export function pathOf(loop) {
  let s = `M${n(loop[0].p.x)} ${n(loop[0].p.y)}`;
  for (const g of loop) s += g.c ? `A${n(g.c.r)} ${n(g.c.r)} 0 ${Math.abs(g.d) > Math.PI ? 1 : 0} ${g.d > 0 ? 1 : 0} ${n(g.q.x)} ${n(g.q.y)}` : `L${n(g.q.x)} ${n(g.q.y)}`;
  return s + 'Z';
}
export function build(over = {}) {
  const S = { ...SYSTEM, ...over }, H = V(0, S.HUB);
  const legs = S.LEGS.map(t => leg(S, H, t));
  // the body's lower edge is the circle through both crotches on each side, a hair inside them, so every cream gap ends in a
  // clean point and no stub of body edge shows between the legs
  const c1 = crotch(legs[0], legs[1], H, S.LIM), c2 = crotch(legs[1], legs[2], H, S.LIM), under = axisCircle(c1, c2); under.r -= S.CLEAR;
  const flesh = [dome(S), belly(under, S.by + S.BURY), ...legs, ...legs.map(mirror)];
  const body = union(flesh);
  const clawA = limb(S), clawB = mirror(clawA), crab = union([...flesh, clawA, clawB]);
  const ac = armCentre(S), pivotA = ac, pivotB = V(-ac.x, ac.y), close = closeAngle(S);
  const disc = `M${-S.R} 0A${S.R} ${S.R} 0 1 1 ${S.R} 0A${S.R} ${S.R} 0 1 1 ${-S.R} 0Z`;
  return { S, disc, crab, under, c1, c2, pivotA, pivotB, close, flat: disc + crab.map(pathOf).join(''), body: body.map(pathOf).join(''), a: pathOf(clawA), b: pathOf(clawB) };
}

/** The claws are separate elements. To close them, rotate each about its data-pivot by its data-close, in degrees, positive
    clockwise: the pivot is the centre of the arm's own ring, so the arm stays exactly where it is and only the hand swings, and at
    data-close the two inner fingertips meet on the axis. The white and black below are mask values, never painted: the only colour
    that reaches the screen is currentColor. */
export const animatedSvg = (m, size) => `<svg ${size ? `width="${size}" height="${size}" ` : ''}xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"><title>Krebs</title><mask id="krebs-seal" maskUnits="userSpaceOnUse" x="-50" y="-50" width="100" height="100"><circle r="${m.S.R}" fill="#fff"/><g fill="#000"><path id="krebs-body" d="${m.body}"/><path id="krebs-claw-a" data-pivot="${n(m.pivotA.x)} ${n(m.pivotA.y)}" data-close="${n(m.close)}" d="${m.a}"/><path id="krebs-claw-b" data-pivot="${n(m.pivotB.x)} ${n(m.pivotB.y)}" data-close="${n(-m.close)}" d="${m.b}"/></g></mask><rect x="-50" y="-50" width="100" height="100" mask="url(#krebs-seal)"/></svg>`;
export const flatSvg = (m, size) => `<svg ${size ? `width="${size}" height="${size}" ` : ''}xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"><title>Krebs</title><path fill-rule="evenodd" d="${m.flat}"/></svg>`;

/* ---- proof ---- */
export function check(m) {
  const loops = m.crab, segs = loops.flat(), length = g => g.c ? Math.abs(g.d) * g.c.r : dist(g.p, g.q);
  const heading = (g, end) => g.c ? g.a0 + (end ? g.d : 0) + (g.d > 0 ? 1 : -1) * Math.PI / 2 : Math.atan2(g.q.y - g.p.y, g.q.x - g.p.x);
  const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
  const corners = loops.flatMap(l => l.map((g, i) => Math.abs(wrap(heading(l[(i + 1) % l.length], false) - heading(g, true))) / RAD));
  const pts = sample(segs, 60);
  let A = 0, cx = 0, cy = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length], c = p.x * q.y - q.x * p.y; A += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c; });
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  const reflect = p => V(-p.x, p.y);
  const nodes = segs.map(g => g.p), reach = Math.max(...pts.map(p => Math.hypot(p.x, p.y)));
  return {
    outlines: loops.length, arcs: segs.filter(g => g.c).length, straightEdges: segs.filter(g => !g.c).length,
    shortestArc: +Math.min(...segs.map(length)).toFixed(2),
    tangentJoins: corners.filter(a => a < 1e-6).length, sharpestSoftCorner: +Math.min(...corners.filter(a => a >= 1e-6)).toFixed(1),
    mirrorError: Math.max(...nodes.map(p => { const r = reflect(p); return Math.min(...nodes.map(q => dist(q, r))); })).toExponential(1),
    closeDegrees: +m.close.toFixed(2), rimWidth: +(m.S.R - reach).toFixed(4), inkShare: +(Math.abs(A) / (Math.PI * m.S.R ** 2) * 100).toFixed(1), centroidOffset: +Math.hypot(cx, cy).toFixed(2),
  };
}

/* ---- the sheet, through the headless Chrome that is already running ---- */
export async function shot(html, png, w = 1280, h = 720) {
  const file = join(HERE, 'seal-sheet.html');
  writeFileSync(file, html);
  const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:21450/json/version')).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(ok => { const i = ++id; waiting.set(i, ok); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: 'file:///' + file.split(String.fromCharCode(92)).join('/') }, s);
  await new Promise(r => setTimeout(r, 700));
  writeFileSync(png, Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'));
  await send('Target.closeTarget', { targetId });
  ws.close();
  rmSync(file);
}

if (process.argv[1] && process.argv[1].endsWith('seal.mjs')) {
  const m = build();
  writeFileSync(join(HERE, 'seal.svg'), animatedSvg(m) + '\n');
  writeFileSync(join(HERE, 'seal-flat.svg'), flatSvg(m) + '\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0a0a0a;color:#f0ede6;display:grid;grid-template-columns:740px 1fr;height:720px}
  .big{display:flex;align-items:center;justify-content:center}.side{display:flex;align-items:center;gap:56px;padding:0 40px}
  </style><div class="big">${animatedSvg(m, 660)}</div><div class="side">${animatedSvg(m, 88)}${animatedSvg(m, 44)}${animatedSvg(m, 24)}</div>`;
  await shot(html, join(HERE, 'seal.png'));
  console.log(check(m));
  process.exit(0);
}
