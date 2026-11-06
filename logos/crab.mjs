// node logos/crab.mjs   writes logos/crab.svg and logos/crab.png, and prints the construction's checks
//
// The Krebs crab. Crabs are told from everything else by their silhouette, so this is a silhouette and nothing inside it:
// no eyes, no shell pattern. One flat colour, and one width of cut separating every part from the body.
//
//   the centre     one point. The envelope, the belly and the ring round the belly are all circles on it
//   the body       a lens, the belly's circle crossed by the dome's. The sharp lateral points are what keep it a crab's
//                  carapace: an oval read as an emoji, a full circle read as a tick or a target
//   the ring       the lens grown by one gap, G. Every limb's inner edge lies on it, so the gap to the body is G. The two
//                  offset arcs keep the lens's sharp corner, so right at that corner the gap flares to about 1.15 G
//   the claw       five arcs, and two of them are the whole idea:
//                    the back    one arc through the ring's corner, internally tangent to the envelope
//                    the roll    an arc externally tangent to the ring, so the ring rolls into the claw with no corner
//                  Between those two the claw is 2.3 times wider at the palm than at the wrist where it leaves the body. A
//                  claw that swells from a wrist is a chela, and one that only widens towards its base is a horn
//   the legs       one blade, turned about the centre. Exact copies, with their tips on the envelope. Their width is solved so
//                  that claw, legs and gaps fill the ring from its corner to the axis, one gap apart all the way round
//
// G is the module. The bite's mouth is 3 G, with the two finger tips on one vertical, and the palm's neck at the crotch is 2 G.
//
// The only corners are points meant to be points: finger tips, the crotch, leg tips, the claw's tail, the lens's two sides.
//
// Why these shapes. Each of these was drawn and thrown out:
//   the disc       cutting a whole disc into parts reads as a cat's head. The crab has to stick out of the circle
//   the round bite a bite made from a circle reads as an eyeball, so it is a V with a sharp crotch
//   the T          a fixed finger that points sideways makes a Spartan helmet's visor. Here it points up and in, and the void
//                  between the claws is a lyre
//   the skull      fingers that nearly close make a cranium with eye sockets. Here the dactyls stand well apart
//
// Optical corrections, each a named constant below:
//   G         wider than 88px needs, so that it stays a real gap at 24px, where it is a little over a pixel
//   LEG_LOW   much flatter than LEG_UP, so that the blade keeps its width: equal radii pinch it to a thread halfway along
//   DROP      the claws pull the mass high, so the mark sits a little below the centre of its box
//
// Motion: each claw is a group of a palm and a dactyl. They overlap inside the claw, so at rest they are one silhouette with
// no seam. The dactyl turns on its data-pivot, on the claw's back at its thinnest section. data-close is the signed angle that
// brings it down over the fixed finger's tip like a scissor blade: the dactyl is the longer blade, so its own tip ends about
// 9 units further on, with the two dactyls still about 6 apart. Each leg is its own path, for a scuttle.
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAD = Math.PI / 180;

// ---- plane geometry -----------------------------------------------------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = a => Math.hypot(a[0], a[1]);
const unit = a => mul(a, 1 / len(a));
const perp = a => [-a[1], a[0]];
const mid = (a, b) => mul(add(a, b), 0.5);
const dist = (a, b) => len(sub(a, b));
const polar = (c, r, deg) => [c[0] + Math.cos(deg * RAD) * r, c[1] + Math.sin(deg * RAD) * r];
const mirror = p => [-p[0], p[1]];

/** The two points where circles meet. */
function meet(c0, r0, c1, r1) {
  const d = dist(c0, c1), a = (d * d + r0 * r0 - r1 * r1) / (2 * d), h2 = r0 * r0 - a * a;
  if (h2 < 0) throw new Error(`circles miss: d=${d} r0=${r0} r1=${r1}`);
  const h = Math.sqrt(h2), u = unit(sub(c1, c0)), m = add(c0, mul(u, a)), n = perp(u);
  return [add(m, mul(n, h)), add(m, mul(n, -h))];
}
/** The centre of the circle of radius r through a and b. Sweep 1 is clockwise on screen: the centre is right of a to b. */
function centre(a, b, r, sweep) {
  const m = mid(a, b), d = sub(b, a), h = Math.sqrt(Math.max(0, r * r - (len(d) / 2) ** 2));
  return add(m, mul(unit(perp(d)), (sweep ? 1 : -1) * h));
}
const pick = (points, score) => points.reduce((best, p) => (score(p) > score(best) ? p : best));
/** A circle centred on the axis through (0, y) and p. */
const axisCircle = (y, p) => {
  const cy = (p[0] ** 2 + p[1] ** 2 - y * y) / (2 * (p[1] - y));
  return { c: [0, cy], r: Math.abs(cy - y) };
};

// ---- paths of arcs ------------------------------------------------------------------------------------------------
const arc = (c, r, a, b, sweep) => ({ c, r, a, b, sweep });
const bow = (a, b, r, sweep) => arc(centre(a, b, r, sweep), r, a, b, sweep);
const flip = s => arc(mirror(s.c), s.r, mirror(s.b), mirror(s.a), s.sweep);
const mirrored = segs => segs.slice().reverse().map(flip);
const ang = (s, p) => Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
const spanOf = s => {
  const delta = s.sweep ? ang(s, s.b) - ang(s, s.a) : ang(s, s.a) - ang(s, s.b);
  return ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
};
/** The point t of the way along an arc. */
const along = (s, t) => {
  const th = ang(s, s.a) + (s.sweep ? 1 : -1) * spanOf(s) * t;
  return [s.c[0] + Math.cos(th) * s.r, s.c[1] + Math.sin(th) * s.r];
};
/** The direction of travel at either end of an arc. */
const heading = (s, p) => { const r = unit(sub(p, s.c)); return s.sweep ? [-r[1], r[0]] : [r[1], -r[0]]; };

const f = n => { const s = n.toFixed(3).replace(/\.?0+$/, ''); return s === '-0' || s === '' ? '0' : s; };
function pathOf(segs) {
  let d = `M${f(segs[0].a[0])} ${f(segs[0].a[1])}`;
  for (const s of segs) {
    if (spanOf(s) > Math.PI) throw new Error(`major arc from ${s.a} to ${s.b}`);
    d += `A${f(s.r)} ${f(s.r)} 0 0 ${s.sweep} ${f(s.b[0])} ${f(s.b[1])}`;
  }
  return d + 'Z';
}
const sample = (segs, n = 200) => segs.flatMap(s => Array.from({ length: n }, (_, i) => along(s, i / n)));
/** Scale and shift, which keeps every arc an exact arc. */
const placed = (segs, k, dy) => segs.map(s => {
  const m = q => [q[0] * k, q[1] * k + dy];
  return arc(m(s.c), s.r * k, m(s.a), m(s.b), s.sweep);
});
/** Area and centre of mass of a closed outline. */
function moments(points) {
  let area = 0, cx = 0, cy = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length], w = p[0] * q[1] - q[0] * p[1];
    area += w; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w;
  });
  return { area: Math.abs(area / 2), x: cx / (3 * area), y: cy / (3 * area) };
}

// ---- the crab -----------------------------------------------------------------------------------------------------
export const P = {
  E: 50, BELLY: 26.5,             // two circles on the one centre: the envelope and the belly
  SIDE_A: 14, TOP: -3,          // the body: its lateral point, degrees round the belly, and where the dome crosses the axis
  G: 4.8,                       // the one gap, between the body and every limb, and between the limbs along the ring
  BACK_R: 27, TIP_A: -100,      // the claw's back, and the dactyl's tip on it
  MOUTH: 3, RHO: 24,            // the fixed finger's tip stands this many gaps straight below the dactyl's; the radius of the roll
  NECK: 2, X_A: 10,             // the crotch: this many gaps in from the back, at this angle round the back
  BITE_D: 28, BITE_F: 40,       // the radius of the bite's edge along the dactyl, and along the fixed finger
  LEGS: 3,                      // the legs. Their bases are solved to fill the ring from its corner to the axis
  LEAN: -8,                     // how far a tip stands round from the middle of its base. Negative leans outward
  LEG_UP: 22, LEG_LOW: 60,      // the radii of a blade's outer and inner edges
  LAP: .6,                      // how far the palm and the dactyl run past each other along the claw's back
  FIT: 97,                      // the finished mark's width in the 100 unit box
  DROP: 1.2,                    // optical: how far the mark sits below the centre of the box
};

export function build(p = P) {
  const O = [0, 0], g = p.G;

  // the lens, and the ring: the same two circles, grown by one gap
  const side = polar(O, p.BELLY, p.SIDE_A), dome = axisCircle(p.TOP, side);
  const body = [arc(dome.c, dome.r, mirror(side), side, 1), arc(O, p.BELLY, side, mirror(side), 1)];
  const ringD = dome.r + g, ringB = p.BELLY + g;
  const corner = pick(meet(dome.c, ringD, O, ringB), v => v[0]);
  const angleOf = (c, v) => Math.atan2(v[1] - c[1], v[0] - c[0]) / RAD;

  // the claw. The back is internally tangent to the envelope and runs through the ring's corner
  const q = p.BACK_R, tail = corner;
  const Q = pick(meet(O, p.E - q, tail, q), v => -v[1]);
  const T = polar(Q, q, p.TIP_A), T2 = add(T, [0, p.MOUTH * g]), X = polar(Q, q - p.NECK * g, p.X_A);
  const Ci = pick(meet(T2, p.RHO, dome.c, ringD + p.RHO), v => v[0]);     // the roll: through the finger tip, externally tangent to the ring
  const Ji = add(dome.c, mul(unit(sub(Ci, dome.c)), ringD));
  const H = add(Q, mul(unit(sub(X, Q)), q));                              // the hinge: the point of the back nearest the crotch
  const whole = [
    arc(Q, q, T, tail, 1), arc(dome.c, ringD, tail, Ji, 0), arc(Ci, p.RHO, Ji, T2, 1),
    bow(T2, X, p.BITE_F, 0), bow(X, T, p.BITE_D, 0),
  ];
  // the palm stops at the chord from the crotch to the hinge. The dactyl's root runs past that chord, so the two overlap
  // and along the back itself, so there is no notch at the hinge
  const along2 = (deg) => polar(Q, q, angleOf(Q, H) + deg);
  const palmEnd = along2(-p.LAP / q / RAD), rootEnd = along2(p.LAP / q / RAD);
  const palm = [arc(Q, q, palmEnd, tail, 1), whole[1], whole[2], whole[3], bow(X, palmEnd, 3 * dist(X, palmEnd), 1)];
  const dactyl = [arc(Q, q, T, rootEnd, 1), bow(rootEnd, X, dist(X, rootEnd) * .62, 1), whole[4]];

  // the legs: one blade, turned about the centre. The first stands exactly one gap past the ring's corner
  const b0 = pick(meet(tail, g, O, ringB), v => v[1]);
  const first = angleOf(O, b0), run = (90 - first) * RAD * ringB;
  const width = (run - (p.LEGS - .5) * g) / p.LEGS;                       // bases and gaps fill the ring exactly, with half a gap at the axis
  const span = width / ringB / RAD, pitch = (width + g) / ringB / RAD;
  const blade = i => {
    const d = first + i * pitch, a = polar(O, ringB, d), b = polar(O, ringB, d + span), t = polar(O, p.E, d + span / 2 + p.LEAN);
    return [bow(a, t, p.LEG_UP, 1), bow(t, b, p.LEG_LOW, 0), arc(O, ringB, b, a, 0)];
  };
  const legs = Array.from({ length: p.LEGS }, (_, i) => blade(i));

  // the box. Width sets the scale, and the height is centred and then dropped
  const outline = [...body, ...whole, ...mirrored(whole), ...legs.flat(), ...legs.flatMap(mirrored)].flatMap(s => sample([s]));
  const xs = outline.map(v => v[0]), ys = outline.map(v => v[1]);
  const k = p.FIT / (Math.max(...xs) - Math.min(...xs)), dy = -k * (Math.max(...ys) + Math.min(...ys)) / 2 + p.DROP;
  const put = segs => placed(segs, k, dy);

  // the closed pose: the angle about the hinge that takes the dactyl's tip to the fixed finger's
  const turn = v => Math.atan2(v[1] - H[1], v[0] - H[0]);
  const close = (((turn(T2) - turn(T)) / RAD + 540) % 360) - 180;
  return {
    body: put(body), whole: put(whole), wholeL: put(mirrored(whole)),
    palm: put(palm), dactyl: put(dactyl), palmL: put(mirrored(palm)), dactylL: put(mirrored(dactyl)),
    legs: legs.map(put), legsL: legs.map(l => put(mirrored(l))),
    pivot: [H[0] * k, H[1] * k + dy], close, k, dy,
    parts: { Q, q, T, T2, X, H, tail, Ji, Ci, dome, corner, ringD, ringB, b0, whole, legs, body, width },
  };
}

export function markSvg(size, m = build(), angle = 0) {
  const dims = size ? `width="${size}" height="${size}" ` : '';
  const [x, y] = m.pivot;
  const pose = s => (angle ? ` transform="rotate(${f(s * angle)} ${f(s * x)} ${f(y)})"` : '');
  const side = (name, s, palm, dactyl) => `<g id="claw-${name}"><path id="palm-${name}" d="${pathOf(palm)}"/><path id="dactyl-${name}" data-pivot="${f(s * x)} ${f(y)}" data-close="${f(s * m.close)}" d="${pathOf(dactyl)}"${pose(s)}/></g>`;
  const legs = (name, list) => list.map((l, i) => `<path id="leg-${name}-${i + 1}" d="${pathOf(l)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" ${dims}viewBox="-50 -50 100 100" fill="currentColor"><path id="body" d="${pathOf(m.body)}"/>${side('left', -1, m.palmL, m.dactylL)}${side('right', 1, m.palm, m.dactyl)}${legs('left', m.legsL)}${legs('right', m.legs)}</svg>`;
}

// ---- proof --------------------------------------------------------------------------------------------------------
function report(m, p = P) {
  const { parts: g, k } = m;
  const px = v => (v * k * 24 / 100).toFixed(2);
  const kink = (a, b, at) => Math.acos(Math.min(1, heading(a, at)[0] * heading(b, at)[0] + heading(a, at)[1] * heading(b, at)[1])) / RAD;
  const [back, ring, roll, biteF, biteD] = g.whole;
  console.log('tangency:');
  console.log(`  ring into roll, degrees of kink   ${kink(ring, roll, g.Ji).toFixed(6)}`);
  console.log(`  back to envelope, off by          ${(len(g.Q) + g.q - p.E).toFixed(6)}`);
  console.log(`  roll to ring, off by              ${(dist(g.Ci, g.dome.c) - g.ringD - p.RHO).toFixed(6)}`);

  const lens = sample(g.body, 1500);
  const nearest = (q, pts) => Math.min(...pts.map(v => dist(q, v)));
  const gaps = sample([ring, ...g.legs.map(l => l[2])], 60).map(v => nearest(v, lens));
  console.log(`gap, limbs to body: ${Math.min(...gaps).toFixed(3)} to ${Math.max(...gaps).toFixed(3)} (wanted ${p.G}), tail to first leg ${dist(g.tail, g.b0).toFixed(3)}`);
  const legGaps = g.legs.slice(1).map((l, i) => dist(l[0].a, g.legs[i][1].b));
  console.log(`leg base ${g.width.toFixed(3)}; gap, leg to leg at the base: ${legGaps.map(v => v.toFixed(3)).join(' ')}, across the axis ${(2 * g.legs[2][1].b[0]).toFixed(3)}`);
  const shape = l => [dist(l[0].a, l[0].b), dist(l[1].a, l[1].b), dist(l[0].a, l[1].b)].map(v => v.toFixed(6)).join(' ');
  console.log(`legs identical: ${new Set(g.legs.map(shape)).size === 1 ? 'yes' : 'NO'}, tips round the centre: ${g.legs.map(l => len(l[0].b).toFixed(3)).join(' ')} (wanted ${p.E})`);

  const numbers = d => d.match(/-?[0-9.]+/g).map(Number);
  const ends = d => d.split(/[MAZ]/).filter(Boolean).map(c => numbers(c).slice(-2));
  const mirrorOf = (a, b) => ends(pathOf(a)).every(v => ends(pathOf(b)).some(w => w[0] === -v[0] && w[1] === v[1]));
  const bodyOk = ends(pathOf(m.body)).every((v, _, all) => all.some(w => w[0] === -v[0] && w[1] === v[1]));
  const sym = mirrorOf(m.palm, m.palmL) && mirrorOf(m.dactyl, m.dactylL) && m.legs.every((l, i) => mirrorOf(l, m.legsL[i])) && bodyOk;
  console.log(`symmetry of the published numbers: ${sym ? 'exact' : 'BROKEN'}`);
  const box = [...m.body, ...m.whole, ...m.wholeL, ...m.legs.flat(), ...m.legsL.flat()].flatMap(s => sample([s], 80));
  const ext = i => [Math.min(...box.map(v => v[i])).toFixed(2), Math.max(...box.map(v => v[i])).toFixed(2)];
  console.log(`box: x ${ext(0).join(' to ')}, y ${ext(1).join(' to ')}`);

  const width = (a, t, other) => nearest(along(a, t), sample([other], 400));
  const leg = g.legs[1];
  console.log('at 24px, in pixels:');
  console.log(`  dactyl, 15 33 50 75% from its tip  ${[.85, .67, .5, .25].map(t => px(width(biteD, t, back))).join(' ')}`);
  console.log(`  fixed finger, the same             ${[.15, .33, .5, .75].map(t => px(width(biteF, t, roll))).join(' ')}`);
  console.log(`  leg, 25 50 75% from its base       ${[.25, .5, .75].map(t => px(width(leg[0], t, leg[1]))).join(' ')}`);
  console.log(`  the gap ${px(p.G)}, the bite at its widest ${px(Math.max(...[.2, .35, .5, .65, .8].map(t => width(biteD, t, biteF))))}, the mouth ${px(dist(g.T, g.T2))}`);
  console.log(`  dactyl tips apart ${px(2 * g.T[0])}, rear legs apart at the belly ${px(2 * g.legs[2][1].b[0])}`);

  const mass = segs => moments(sample(segs, 300));
  const b = mass(m.body), c = mass(m.whole), l = m.legs.map(mass);
  const area = b.area + 2 * c.area + 2 * l.reduce((n, v) => n + v.area, 0);
  const y = (b.y * b.area + 2 * c.y * c.area + 2 * l.reduce((n, v) => n + v.y * v.area, 0)) / area;
  console.log(`scale ${k.toFixed(4)}; centre of mass y ${y.toFixed(2)}; ink ${(area / 100).toFixed(1)}% of the box: claws ${(2 * c.area / area * 100).toFixed(0)}%, body ${(b.area / area * 100).toFixed(0)}%, legs ${(100 - (2 * c.area + b.area) / area * 100).toFixed(0)}%`);
  console.log(`closed pose: dactyl-right by ${m.close.toFixed(3)} degrees and dactyl-left by ${(-m.close).toFixed(3)} about (+-${f(m.pivot[0])} ${f(m.pivot[1])})`);
}

// ---- output -------------------------------------------------------------------------------------------------------
export async function shoot(html, out, { width = 1280, height = 720, name = 'crab' } = {}) {
  const page = join(HERE, `${name}.html`);
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
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: 'file:///' + page.split('\\').join('/') }, s);
  await new Promise(r => setTimeout(r, 900));
  writeFileSync(out, Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'));
  await send('Target.closeTarget', { targetId });
  ws.close();
  rmSync(page);
}

const STYLE = 'html,body{margin:0;background:#0a0a0a;color:#f0ede6}svg{display:block}';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mark = build();
  report(mark);
  writeFileSync(join(HERE, 'crab.svg'), markSvg(0, mark) + '\n');
  const sheet = `<!doctype html><meta charset="utf-8"><title>crab</title><style>${STYLE}
body { display: grid; grid-template-columns: 900px 1fr; align-items: center; justify-items: center; height: 720px; overflow: hidden; }
.side { display: flex; flex-direction: column; align-items: center; gap: 56px; }
</style><div>${markSvg(680, mark)}</div><div class="side">${markSvg(88, mark)}${markSvg(44, mark)}${markSvg(24, mark)}</div>`;
  await shoot(sheet, join(HERE, 'crab.png'));
  console.log('saved');
  process.exit(0);
}
