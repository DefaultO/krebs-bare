'use strict';
// What is in a room, by the game's own recipes (the *.metadata.js of its renderer): the same sprites, order, sizes, anchors, alphas
// and tints, in the game's units of 100 to a tile, relative to the object's centre. worldmap.js is the host it describes.
//
// One thing is left out on purpose, everywhere: light. No lighting-layer sprite, no glow, no additive blend, no blur. Where the game
// adds a sprite on top of what is under it, this lays it over flat. Where it breathes, flickers or wanders with nothing behind it,
// this holds still on the recipe's base values. What moves is what is happening: a creep going somewhere, a tower turning to its
// target, an extractor on cooldown, the flash a building or a creep gives on a tick.
//
// It is written against a camera rather than a room: every recipe positions itself in absolute world tile coordinates through
// w2sx/w2sy, so drawing forty rooms is the same code as drawing one. The host supplies ctx, cam, w2sx, w2sy, N, DPR, S, OX, OY and T,
// the current tick, and calls drawRoads, drawWalls, drawObj per object and drawRamparts, a room at a time. Below 48 px a room recipes
// would be drawing detail that cannot land anywhere, so it uses the point path at the foot of this file instead.

// Chart's tones, for the ground and for what lies flat on it.
const INK = {
  void: '#000000', s1: '#151310',
  line: '#4A463C', mark: '#6E695D', ink3: '#8C877B',
  plain: '#2A2720', coast: '#5A554A', marsh: '#524B33', tuft: '#7A6F4C', tile: '#3E3A30',
};
const hexOf = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mixed = new Map();
/** `a` over `b` at `t`, as a flat opaque colour. Bounded: 65 steps a pair. */
function mix(a, b, t) {
  const q = Math.round(t * 64), key = a + b + q;
  let m = mixed.get(key);
  if (m) return m;
  const A = hexOf(a), B = hexOf(b), f = q / 64;
  m = '#' + [0, 1, 2].map(i => Math.round(A[i] * f + B[i] * (1 - f)).toString(16).padStart(2, '0')).join('');
  mixed.set(key, m);
  return m;
}
/** 0 at `a`, 1 at `b`, even in log zoom, so a tone changes across a range of scales and never at a threshold. */
const ramp = (v, a, b) => Math.max(0, Math.min(1, Math.log2(v / a) / Math.log2(b / a)));
/** How much of its owner's colour a held room's ground takes: all of it far out, a tint close in. */
const printOf = px => 1 - 0.82 * ramp(px, 1.35, 5);
/** The rock lifts off pure black far out: over a whole world it is a shape to read past, not a pattern to read. */
const rockOf = px => mix(INK.void, INK.s1, ramp(px, 1.1, 2.6));
/** A road settles from chart's light line far out to the game's own #6a6a6a (#aaaaaa under its tint of #a0a0a0) close in. */
const roadTone = px => mix('#6a6a6a', INK.ink3, ramp(px, 3, 20));

const PAL = { neutral: '#BBBBBB' }; // the game's colour for what nobody owns
// Energy to the NEXT level, from the engine's own table. Level 8 has no entry on purpose: there is nothing left to reach.
const CONTROLLER_LEVELS = { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000 };
const PWR_OPERATE_FACTORY = 19;
const CONTROLLER_DOWNGRADE = { 1: 20000, 2: 10000, 3: 20000, 4: 40000, 5: 80000, 6: 120000, 7: 150000, 8: 200000 };

// The game's zIndex for each object moved up two, because the host sorts with `Z[type] || 12` and the game's list starts at -1.
// Ramparts, sites, flags and nukes are on its effects layer, over all of these: see drawRamparts.
const Z = { road: 1, rampart: 2, constructedWall: 2, extractor: 2, deposit: 3, energy: 3, resource: 3, source: 4, mineral: 4, keeperLair: 5, portal: 5, container: 6, controller: 6, ruin: 7, tombstone: 7, creep: 8, extension: 9, storage: 9, nuker: 9, factory: 9, spawn: 10, link: 11, observer: 12, powerBank: 13, powerSpawn: 14, tower: 15, powerCreep: 15, lab: 17, terminal: 18, invaderCore: 19, constructionSite: 20, flag: 21, nuke: 21 };
// Who leaves a line, and how wide (creepActions.js). A melee action is a bite instead, and a creep's transfer or withdraw shows nothing.
const BEAM = { rangedAttack: ['#3c75c7', 12], rangedHeal: ['#2ce328', 12], build: ['#ffe533', 12], repair: ['#ffe533', 12], upgradeController: ['#ffe533', 12], transferEnergy: ['#ffe533', 18], power: ['#cc3d3e', 12] };
const TOWER_BEAM = { attack: ['#3c75c7', 18], heal: ['#2ce328', 18], repair: ['#ffe533', 18] };
const CORE_BEAM = { rangedAttack: ['#3c75c7', 12], transferEnergy: ['#ffe533', 18], build: ['#ffe533', 18], repair: ['#ffe533', 12], upgradeController: ['#ffe533', 18], reserveController: ['#b99cfb', 18] };
const BITES = ['attack', 'harvest', 'reserveController', 'heal'];
// Body parts, from creepBuildBody.js; carry and tough are not on the ring. These are the colours on screen: the game sets each part's
// colour as the line and again as the Graphics tint, so it multiplies by itself. #aab7c5 in that file reads #718398, and so on.
const CREEP_PARTS = {
  move: { color: '#718398', back: true },
  work: { color: '#fbcd34' },
  attack: { color: '#ef0810' },
  ranged_attack: { color: '#3f6dcd' },
  heal: { color: '#1da822' },
  claim: { color: '#865ff7' },
};
// foreground, background. T is this season's own.
const MINERAL = { L: ['#89F4A5', '#3F6147'], U: ['#88D6F7', '#1B617F'], K: ['#9370FF', '#331A80'], Z: ['#F2D28B', '#594D33'], X: ['#FF7A7A', '#4F2626'], O: ['#CCCCCC', '#4D4D4D'], H: ['#CCCCCC', '#4D4D4D'], T: ['#BCFF50', '#67A700'] };
/** A mineral of a type this table does not have. */
const STATIC_MINERAL = ['#D8D8D8', '#555555'];
const DEPOSIT = { biomass: '#84b012', metal: '#956f5c', mist: '#da6bf5', silicon: '#4ca7e5' };
const DROPPED = { energy: ['#ffe56d', 30], power: ['#f41f33', 45], other: ['#ffffff', 45] };
const FLAG = { 1: '#F44336', 2: '#9C27B0', 3: '#2196F3', 4: '#00BCD4', 5: '#4CAF50', 6: '#FFEB3B', 7: '#FF9800', 8: '#795548', 9: '#9E9E9E', 10: '#FFFFFF' };
// The size and pivot of a power creep's badge, which sits where its class's sprite leaves room.
const POWER_BADGE = { commander: { pivot: 30, size: 65 }, executor: { pivot: 30, size: 45 }, operator: { pivot: 15, size: 63 } };

/** A stable number from an id: where a tower that has never fired starts out facing. */
function hue(s) { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
/** Who owns what colour, told by the page. All #rrggbb, because a print is mixed from them. */
const OWNER_HUE = new Map();
function ownerColor(uid) {
  if (uid === '2' || uid === '3') return '#FF7777'; // invaders and keepers: the game's colour for what is not yours
  return OWNER_HUE.get(uid) || PAL.neutral;
}

// ---- draw helpers ----

/** Screen pixels to one of the game's units, this frame. */
let U = 1;
/** Rounds to a whole device pixel. */
const snap = v => Math.round(v * DPR) / DPR;
function discPx(cx, cy, rpx, fill, stroke, lwpx) {
  ctx.beginPath();
  ctx.arc(cx, cy, rpx, 0, 7);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.lineWidth = lwpx || 1; ctx.strokeStyle = stroke; ctx.stroke(); }
}
/** A rectangle in the game's units from the object's centre, cut on whole device pixels so it stays as sharp as the sprites round it. */
function box(cx, cy, x, y, w, h, fill, alpha) {
  const left = snap(cx + x * U), top = snap(cy + y * U);
  if (alpha) ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.fillRect(left, top, Math.max(1 / DPR, snap(cx + (x + w) * U) - left), Math.max(1 / DPR, snap(cy + (y + h) * U) - top));
  if (alpha) ctx.globalAlpha = 1;
}
const square = (cx, cy, side, fill) => box(cx, cy, -side / 2, -side / 2, side, side, fill);
/** A centred rounded square, `side` and `r` in pixels. */
function rounded(cx, cy, side, r, fill, stroke, lw) {
  const half = snap(side / 2);
  ctx.beginPath();
  ctx.roundRect(snap(cx) - half, snap(cy) - half, half * 2, half * 2, Math.min(r, half));
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
}
/** The fraction `f` of a disc, clockwise from twelve o'clock. */
function pie(cx, cy, r, f, fill) {
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, f));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
/** The fraction `f` of a ring, clockwise from twelve o'clock. */
function sweep(cx, cy, r, f, lw, stroke) {
  ctx.lineCap = 'butt';
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, f));
  ctx.stroke();
}
const ring = (cx, cy, r, lw, stroke) => sweep(cx, cy, r, 1, lw, stroke);
/** Lines and a tick's discs go on the game's effects layer, over every building they cross: held here until drawRamparts has done the rest of the room. */
const beamsDue = [], discsDue = [];
const beam = (x1, y1, x2, y2, color, width) => beamsDue.push({ x1, y1, x2, y2, color, width });
const effectDisc = (x, y, r, color, alpha) => discsDue.push({ x, y, r, color, alpha });
function flushEffects() {
  for (const { x, y, r, color, alpha } of discsDue) {
    ctx.globalAlpha = alpha;
    discPx(w2sx(x), w2sy(y), r * U, color);
  }
  ctx.globalAlpha = 1;
  discsDue.length = 0;
  ctx.lineCap = 'butt';
  for (const { x1, y1, x2, y2, color, width } of beamsDue) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * U);
    ctx.beginPath(); ctx.moveTo(w2sx(x1), w2sy(y1)); ctx.lineTo(w2sx(x2), w2sy(y2)); ctx.stroke();
  }
  beamsDue.length = 0;
}
/** The lines an object's action log asks for. The game runs them along their length through a tick; here they stand for the tick. */
function beams(o, x, y, ox, oy, table) {
  const log = o.actionLog;
  if (!log) return;
  for (const k in table) {
    const t = log[k];
    if (t && t.x != null) beam(x, y, ox + t.x + 0.5, oy + t.y + 0.5, table[k][0], table[k][1]);
  }
}
function smoothAngle(cur, target, k) { let d = target - cur; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return cur + d * k; }
/** Everything in a store. Held on the object, which a new state replaces. */
function storeTotal(o) {
  if (o._total === undefined) { let s = 0; const st = o.store; if (st) for (const k in st) s += st[k] || 0; o._total = s; }
  return o._total;
}
/** How full of energy a structure is that counts it against its own capacity. */
function energyFill(o) {
  const cap = o.storeCapacityResource?.energy ?? o.energyCapacity ?? 0, e = o.store?.energy ?? o.energy ?? 0;
  return cap > 0 ? Math.min(1, e / cap) : 0;
}
/** Whether a power creep is operating this factory. Held on the object, which a new state replaces. */
const operated = o => !!o.effects && Object.values(o.effects).some(e => e.power === PWR_OPERATE_FACTORY && e.endTime >= T);
/** How far a spawn is through the creep it is making. */
function spawnedOf(o) {
  const s = o.spawning;
  return s && s.needTime ? Math.max(0, (s.needTime - (s.spawnTime - T)) / s.needTime) : 0;
}
/** The game's stacked store: white for everything, red up to energy and power, yellow for energy, all from one foot. */
function storeBars(cx, cy, o, left, foot, w, h, cap) {
  const total = storeTotal(o);
  if (!total || !cap) return;
  const st = o.store, energy = st.energy || 0, power = st.power || 0, bar = (n, fill) => { const b = h * n / cap; box(cx, cy, left, foot - b, w, b, fill); };
  if (energy + power < total) bar(total, '#ffffff');
  if (power > 0) bar(energy + power, '#f41f33');
  if (energy > 0) bar(energy, '#ffe56d');
}
/** Whether a creep stands in a room where someone else's safe mode is on, which halves it. */
function safeFrom(list, o) {
  const c = list._controller === undefined ? (list._controller = list.find(i => i.type === 'controller') ?? null) : list._controller;
  return !!c && c.safeMode > T && c.user !== o.user;
}

// The game's flashes run through a tick. The host keeps frames coming for 300 ms after each state, so a flash runs through this much.
const FLASH_MS = 260;
let NOW = 0, tickAt = -Infinity, tickSeen = null;
/** A flash's height, 0 to 1, rising through the first `up` of it. 0 once it has run. */
function flash(up = 0.2) {
  const t = (NOW - tickAt) / FLASH_MS;
  return t >= 1 ? 0 : t < up ? t / up : 1 - (t - up) / (1 - up);
}
/** While something on screen is turning, the next frame is due anyway: about fifteen a second, which a four second turn does not need more of. */
let turning = false;
function keepTurning() {
  if (turning) return;
  turning = true;
  setTimeout(() => { turning = false; worldMap.changed(); }, 66);
}

// ---- the game's textures ----
// Vector sources rasterised per zoom at device resolution, so they stay crisp at any scale; at rest cut at their exact size.
const texImgs = new Map(), texRas = new Map();
let REST = false;
function useScale(atRest) {
  REST = atRest;
  U = cam.scale / 100;
  NOW = performance.now();
  if (T !== tickSeen) { tickSeen = T; tickAt = NOW; }
}
function forgetSprites() { texRas.clear(); }
const bucketOf = px => REST ? Math.min(768, Math.max(1, Math.round(px * DPR))) : Math.min(768, Math.max(8, Math.ceil(px * DPR / 16) * 16));
/** A raster from the bounded cache, painted the first time it is asked for. */
function raster(key, w, h, paint) {
  let c = texRas.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    paint(c.getContext('2d'));
    if (texRas.size > 500) texRas.delete(texRas.keys().next().value);
    texRas.set(key, c);
  }
  return c;
}
function tex(name, px, tint) {
  let img = texImgs.get(name);
  if (!img) {
    img = new Image();
    // what asked for it was left out of that frame, and a still map has no next one
    img.onload = () => worldMap.changed();
    img.src = `/assets/game-assets/${name}.svg`;
    texImgs.set(name, img);
  }
  if (!img.complete || !img.naturalWidth) return null;
  const w = bucketOf(px), h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
  return raster(name + '@' + w + (tint || ''), w, h, g => {
    g.drawImage(img, 0, 0, w, h);
    if (tint) { // PIXI-style tint: multiply color, keep the source alpha
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = tint; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(img, 0, 0, w, h);
    }
  });
}
/** An extension's three layers flattened, a level of energy to a raster: a base has sixty of them, and this makes each one image. */
function extensionStamp(border, size, f, tint) {
  const px = cam.scale, w = bucketOf(px), step = Math.round(f * 32), key = border + size + ':' + step + '@' + w + tint;
  const hit = texRas.get(key);
  if (hit) return hit;
  const ring = tex(border, px, tint), body = tex('extension', px * size / 100);
  if (!ring || !body) return null;
  return raster(key, w, w, g => {
    const b = Math.round(w * size / 100), at = Math.round((w - b) / 2);
    g.drawImage(ring, 0, 0, w, w);
    g.drawImage(body, at, at, b, b);
    if (step) {
      g.beginPath();
      g.arc(w / 2, w / 2, b * 0.32 * step / 32, 0, 7);
      g.fillStyle = '#ffe56d';
      g.fill();
    }
  });
}
/** A mineral's disc and letter: 54 in radius with a stroke of 10, on a square of 118. The letter is the game's Roboto 82 where the page has it. */
function mineralStamp(type, c, px) {
  const w = bucketOf(px);
  return raster('mineral:' + type + '@' + w, w, w, g => {
    g.scale(w / 118, w / 118);
    g.translate(59, 59);
    g.beginPath();
    g.arc(0, 0, 54, 0, 7);
    g.fillStyle = c[1];
    g.fill();
    g.lineWidth = 10;
    g.strokeStyle = c[0];
    g.stroke();
    g.font = 'bold 82px Roboto, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = c[0];
    g.fillText(type ?? '', 0, 29); // half a capital's height under the centre
  });
}
/** The nuke's cross as it reads on screen, where the game's screen copy of the sprite brightens it. The sprite laid twice, as there, then one flat colour. */
function nukeStamp(px) {
  const c = tex('nuke', px);
  return c && raster('nuke:flat@' + c.width, c.width, c.height, g => {
    g.drawImage(c, 0, 0);
    g.drawImage(c, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = '#ff9595';
    g.fillRect(0, 0, c.width, c.height);
  });
}
/** Draws a raster centred on world (x, y), `px` wide; `dy` tiles along its own axis. Unrotated, at rest, on whole device pixels. */
function place(c, px, x, y, rot, alpha, dy) {
  const was = ctx.globalAlpha;
  if (alpha != null) ctx.globalAlpha = was * alpha;
  if (!rot && c.width === Math.round(px * DPR)) {
    // one to one with the raster: the context stays as it is, because a save and a transform a sprite is what a base costs
    const left = Math.round(w2sx(x) * DPR - c.width / 2), top = Math.round((w2sy(y) + (dy || 0) * cam.scale) * DPR - c.height / 2);
    ctx.drawImage(c, left / DPR, top / DPR, c.width / DPR, c.height / DPR);
    ctx.globalAlpha = was;
    return true;
  }
  const ph = px * c.height / c.width;
  ctx.save();
  ctx.translate(w2sx(x), w2sy(y));
  if (rot) ctx.rotate(rot);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(c, -px / 2, -ph / 2 + (dy || 0) * cam.scale, px, ph);
  ctx.restore();
  ctx.globalAlpha = was;
  return true;
}
/** A texture centred on world (x, y), `wTiles` wide, aspect kept. */
function spr(name, x, y, wTiles, rot, alpha, tint, dy) {
  const px = wTiles * cam.scale, c = tex(name, px, tint);
  return c ? place(c, px, x, y, rot, alpha, dy) : false;
}
/** Where the game shows a player's badge: the page has no badge art, so their colour stands in for it. */
const badgeCircle = (uid, cx2, cy2, rpx) => discPx(cx2, cy2, rpx, ownerColor(uid));

/**
 * A creep's parts, whatever shape they arrived in.
 *
 * A body reaches us as an array, but a delta that changed one part is keyed by
 * index - {0: {...}, 1: {...}} - and anything that hands one of those straight
 * to the renderer used to throw "is not iterable" mid-frame. The draw loop is
 * wrapped, so the failure was not a crash: it was every remaining room in that
 * frame silently not being drawn, which reads as stutter.
 *
 * Object.values puts an index-keyed one back in order. That is a guard, not a
 * repair: a delta only mentions the parts that changed, so a creep reduced to
 * one would draw with one part. The fix for that is upstream, where the delta
 * is merged into the array it belongs to; this only makes sure a bad value
 * costs one wrong creep instead of every room left in the frame.
 */
function bodyOf(o) {
  const b = o.body;
  if (Array.isArray(b)) return b;
  return b && typeof b === 'object' ? Object.values(b) : [];
}

// All of a room's roads in one stroked path.
//
// Drawn one at a time - a disc and up to four strokes each - roads were three
// quarters of a frame close in and two thirds at mid zoom: 626 roads meant
// three thousand path operations for the least interesting thing on screen.
// One path with round caps and joins: the caps cover the junctions the discs
// used to, and a tile with no neighbour at all gets a dot of the road's own
// width. Roads never move, so they take x and y rather than the eased pair.
const ROAD_AHEAD = [[1, 0], [0, 1], [1, 1], [1, -1]];
const ROAD_BEHIND = [[-1, 0], [0, -1], [-1, -1], [-1, 1]];
function drawRoads(list, roadSet, ox, oy) {
  ctx.beginPath();
  for (const o of list) {
    if (o.type !== 'road') continue;
    const x = ox + o.x + 0.5, y = oy + o.y + 0.5;
    const cx = w2sx(x), cy = w2sy(y);
    let joined = false;
    for (const [dx, dy] of ROAD_AHEAD) {
      if (!roadSet.has((o.x + dx) + ',' + (o.y + dy))) continue;
      ctx.moveTo(cx, cy); ctx.lineTo(w2sx(x + dx), w2sy(y + dy));
      joined = true;
    }
    if (!joined && !ROAD_BEHIND.some(([dx, dy]) => roadSet.has((o.x + dx) + ',' + (o.y + dy)))) {
      ctx.moveTo(cx - 0.01, cy); ctx.lineTo(cx + 0.01, cy);
    }
  }
  ctx.lineWidth = Math.max(1, 0.3 * cam.scale); ctx.strokeStyle = roadTone(cam.scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke();
}

// One closed path round a set of tiles, 100 units to a tile, its free corners rounded: the game's own (pathHelper.js in its
// renderer), so a run of ramparts or walls has the game's outline. Empty when no object passes `filter`.
function tilePath(objects, filter, diagonalConnect = false) {
  var ROOM_SIZE = N;
  var array = {};
  var visited = {};
  var path = '';
  for (var x = 0; x < ROOM_SIZE; x += 1) {
    array[x] = new Array(ROOM_SIZE);
    visited[x] = {};
  }
  var hasAny;
  for (const object of objects) {
    if (filter(object)) {
      array[object.x][object.y] = object;
      hasAny = true;
    }
    visited[object.x][object.y] = false;
  }
  if (!hasAny) return '';
  function topLeftDownR(x, y) {
    if (x > 0 && y > 0 && !array[x - 1][y]) {
      path += 'a 50 50 0 0 0 -50 -50 h 50 ';
    } else {
      path += 'v -50 ';
    }
  }
  function topLeftUpR(x, y) {
    if (y > 0 && x > 0 && !array[x][y - 1]) {
      path += 'v -50 a 50 50 0 0 0 50 50 ';
    } else {
      path += 'h 50 ';
    }
  }
  function topLeftR(x, y) {
    if (x === 0 || array[x - 1][y] || y === 0 || array[x][y - 1]) {
      path += 'v -50 h 50 ';
    } else {
      path += 'a 50 50 0 0 1 50 -50 ';
    }
  }
  function topRightUpR(x, y) {
    if (y > 0 && x < ROOM_SIZE - 1 && !array[x][y - 1]) {
      path += 'a 50 50 0 0 0 50 -50 v 50 ';
    } else {
      path += 'h 50 ';
    }
  }
  function topRightDownR(x, y) {
    if (x < ROOM_SIZE - 1 && y > 0 && !array[x + 1][y]) {
      path += 'h 50 a 50 50 0 0 0 -50 50 ';
    } else {
      path += 'v 50 ';
    }
  }
  function topRightR(x, y) {
    if (x === ROOM_SIZE - 1 || array[x + 1][y] || y === 0 || array[x][y - 1]) {
      path += 'h 50 v 50 ';
    } else {
      path += 'a 50 50 0 0 1 50 50 ';
    }
  }
  function bottomRightR(x, y) {
    if (x === ROOM_SIZE - 1 || array[x + 1][y] || y === ROOM_SIZE - 1 || array[x][y + 1] || array[x + 1][y + 1] && (array[x + 1][y] || diagonalConnect)) {
      path += 'v 50 h -50 ';
    } else {
      path += 'a 50 50 0 0 1 -50 50 ';
    }
  }
  function bottomLeftR(x, y) {
    if (x === 0 || array[x - 1][y] || y === ROOM_SIZE - 1 || array[x][y + 1] || array[x - 1][y + 1] && (array[x - 1][y] || diagonalConnect)) {
      path += 'h -50 v -50 ';
    } else {
      path += 'a 50 50 0 0 1 -50 -50 ';
    }
  }
  function recurs(x, y, dx) {
    if (visited[x][y]) {
      if (dx) {
        path += 'v 100 ';
      } else {
        path += 'h -100 ';
      }
      return;
    }
    if (dx) {
      // top left
      if (x === 0 || y === 0 || array[x - 1][y - 1] && (diagonalConnect || array[x - 1][y] || array[x][y - 1])) {
        topLeftUpR(x, y);
      } else {
        path += 'h 50 ';
      }
      if (x < ROOM_SIZE - 1 && array[x + 1][y]) {
        // top right
        if (x === ROOM_SIZE - 1 || y === 0 || array[x + 1][y - 1] && (diagonalConnect || array[x + 1][y] || array[x][y - 1])) {
          topRightUpR(x, y);
        } else {
          path += 'h 50 ';
        }
        recurs(x + 1, y, 1, 0);
        path += 'h -100 ';
      } else {
        // top right
        if (x === ROOM_SIZE - 1 || y === 0 || array[x + 1][y - 1] && (diagonalConnect || array[x + 1][y] || array[x][y - 1])) {
          topRightUpR(x, y);
          topRightDownR(x, y);
        } else {
          topRightR(x, y);
        }

        // bottom right
        bottomRightR(x, y);
        path += 'h -50 ';
      }
    } else {
      // top right
      if (x === ROOM_SIZE - 1 || y === 0 || array[x + 1][y - 1] && (diagonalConnect || array[x + 1][y] || array[x][y - 1])) {
        topRightDownR(x, y);
      } else {
        path += 'v 50 ';
      }
      if (y < ROOM_SIZE - 1 && array[x][y + 1]) {
        path += 'v 50 ';
        recurs(x, y + 1, 0, 1);
        path += 'v -50 ';
      } else {
        bottomRightR(x, y);
        bottomLeftR(x, y);
      }
      if (x === 0 || y === 0 || array[x - 1][y - 1]) {
        topLeftDownR(x, y);
      } else {
        path += 'v -50 ';
      }
    }
    if (x < ROOM_SIZE && y < ROOM_SIZE) {
      visited[x][y] = true;
    }
  }
  for (var _x = 0; _x < ROOM_SIZE; _x += 1) {
    for (var y = 0; y < ROOM_SIZE; y += 1) {
      if (array[_x][y] && !visited[_x][y]) {
        path += "M ".concat(_x * 100, " ").concat(y * 100 + 50, " ");
        visited[_x][y] = true;
        var horizontal = 0;
        do {
          horizontal += 1;
        } while (_x + horizontal < ROOM_SIZE && array[_x + horizontal][y]);
        var vertical = 0;
        do {
          vertical += 1;
        } while (y + vertical < ROOM_SIZE && array[_x][y + vertical]);
        if (vertical < horizontal) {
          if (_x === 0 || y === 0 || array[_x - 1][y - 1] && (diagonalConnect || array[_x - 1][y] || array[_x][y - 1])) {
            // top left
            topLeftDownR(_x, y);
            topLeftUpR(_x, y);
          } else {
            topLeftR(_x, y);
          }
          if (_x < ROOM_SIZE - 1 && array[_x + 1][y]) {
            // top right
            if (_x === ROOM_SIZE - 1 || y === 0 || array[_x + 1][y - 1] && (diagonalConnect || array[_x + 1][y] || array[_x][y - 1])) {
              topRightUpR(_x, y);
            } else {
              path += 'h 50 ';
            }
            recurs(_x + 1, y, 1, 0);
            path += 'h -50 ';
          } else {
            // top right
            if (_x === ROOM_SIZE - 1 || y === 0 || array[_x + 1][y - 1] && (diagonalConnect || array[_x + 1][y] || array[_x][y - 1])) {
              topRightUpR(_x, y);
              topRightDownR(_x, y);
            } else {
              topRightR(_x, y);
            }
            bottomRightR(_x, y);
          }
          bottomLeftR(_x, y);
        } else {
          // top left
          if (_x === 0 || y === 0 || array[_x - 1][y - 1] && (diagonalConnect || array[_x - 1][y] || array[_x][y - 1])) {
            topLeftDownR(_x, y);
            topLeftUpR(_x, y);
          } else {
            topLeftR(_x, y);
          }

          // top right
          if (_x === ROOM_SIZE - 1 || y === 0 || array[_x + 1][y - 1] && (diagonalConnect || array[_x + 1][y] || array[_x][y - 1])) {
            topRightUpR(_x, y);
            topRightDownR(_x, y);
          } else {
            topRightR(_x, y);
          }
          if (y < ROOM_SIZE - 1 && array[_x][y + 1]) {
            path += 'v 50 ';
            recurs(_x, y + 1, 0, 1);
            path += 'v -50 ';
          } else {
            bottomRightR(_x, y);
            bottomLeftR(_x, y);
          }
        }
        path += 'Z ';
      }
    }
  }
  return path;
}

/**
 * Constructed walls join the rock, as they join the wall path in the game: one rounded shape with the room's natural walls, only
 * the part on a built tile is painted, in the rock's own colour and line, so it meets the terrain without a seam. Built once a state.
 */
const wallsKept = new Map();
function wallShapes(list, terrain, ox, oy) {
  const built = list.filter(o => o.type === 'constructedWall');
  if (!built.length) return null;
  const key = ox + ',' + oy + ':' + built.map(o => o.x * N + o.y).join();
  let kept = wallsKept.get(key);
  if (!kept) {
    const rock = [...built];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((terrain.charCodeAt(y * N + x) - 48) & 1) rock.push({ x, y });
    const shape = new Path2D(tilePath(rock, () => true)), tiles = new Path2D();
    for (const o of built) tiles.rect(o.x * 100 - 50, o.y * 100 - 50, 200, 200); // half a tile round each, for the fillets where it meets the rock
    if (wallsKept.size >= 64) wallsKept.delete(wallsKept.keys().next().value);
    wallsKept.set(key, kept = { shape, tiles });
  }
  return { ...kept, built };
}

function drawWalls(list, terrain, ox, oy) {
  const walls = list._walls === undefined ? (list._walls = wallShapes(list, terrain, ox, oy)) : list._walls;
  if (!walls) return;
  const k = cam.scale / 100;
  ctx.save();
  ctx.translate(w2sx(ox), w2sy(oy));
  ctx.scale(k, k);
  ctx.clip(walls.tiles);
  const near = cam.scale >= 5; // where the host's rock goes from the chart's tone to black with a coast line
  ctx.fillStyle = near ? INK.void : rockOf(cam.scale);
  ctx.fill(walls.shape);
  ctx.lineWidth = (cam.scale >= 18 ? 1.5 : 1) / k;
  ctx.strokeStyle = near ? INK.coast : INK.line;
  ctx.stroke(walls.shape);
  ctx.restore();
  for (const o of walls.built) {
    const x = ox + o.x + 0.5, y = oy + o.y + 0.5;
    if (cam.scale >= 7) spr('constructedWall', x, y, 1);
    if (o.hits === 1 && o.hitsMax > 1) box(w2sx(x), w2sy(y), -50, -50, 100, 100, '#ff0000', 0.2);
  }
}

/**
 * Ramparts lie over everything else in the room, as they do on the game's effects layer, so what stands under one shows through.
 * A player's are one shape outlined in their colour at .4 with .3 of it for the fill, which is the game's sprite (terrain.js) without
 * its additive blend: a flat tint over the ground, near the same on dark ground. A public rampart is only the + sprite, also on top.
 * The rest of the effects layer comes after them: construction sites, flags and nukes.
 */
function rampartShapes(list) {
  const users = new Set(), open = [], shapes = [], above = [];
  for (const o of list) {
    if (o.type === 'constructionSite' || o.type === 'flag' || o.type === 'nuke') above.push(o);
    if (o.type !== 'rampart') continue;
    if (o.isPublic) open.push(o);
    else users.add(o.user);
  }
  for (const user of users) {
    const shape = new Path2D(tilePath(list, o => o.type === 'rampart' && !o.isPublic && o.user === user)), outside = new Path2D();
    outside.rect(-200, -200, 5400, 5400);
    outside.addPath(shape);
    shapes.push({ user, shape, outside });
  }
  return { shapes, open, above };
}

function drawRamparts(list, ox, oy) {
  const { shapes, open, above } = list._ramparts ?? (list._ramparts = rampartShapes(list));
  if (shapes.length) {
    const k = cam.scale / 100;
    ctx.save();
    ctx.translate(w2sx(ox), w2sy(oy));
    ctx.scale(k, k);
    for (const { user, shape, outside } of shapes) {
      const colour = ownerColor(user);
      // the game's outline is stroked under its fill, so only the half outside the shape shows, and the two never add up;
      // a clip is the dear part of this, and under 7 px a tile that half is less than a pixel
      ctx.save();
      const clipped = cam.scale >= 7;
      if (clipped) ctx.clip(outside, 'evenodd');
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = Math.max(25, (clipped ? 2 : 1) / k);
      ctx.strokeStyle = colour;
      ctx.stroke(shape);
      ctx.restore();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = colour;
      ctx.fill(shape);
    }
    ctx.restore();
  }
  for (const o of open) spr('rampart', ox + o.x + 0.5, oy + o.y + 0.5, 1, 0, 0.5, ownerColor(o.user));
  for (const o of above) drawAbove(o, ox + o.x + 0.5, oy + o.y + 0.5);
  if (beamsDue.length || discsDue.length) flushEffects();
}

/** The effects layer's own objects. A site is the owner's ring and a pie of its progress; the type it will become is not drawn. */
function drawAbove(o, x, y) {
  const cx = w2sx(x), cy = w2sy(y);
  switch (o.type) {
    case 'constructionSite': {
      const colour = ownerColor(o.user);
      ctx.globalAlpha = 0.8; // the blink's high end: the blink says nothing
      ring(cx, cy, 25 * U, 10 * U, colour);
      if (o.progress > 0 && o.progressTotal > 0) pie(cx, cy, 20 * U, o.progress / o.progressTotal, colour);
      ctx.globalAlpha = 1;
      break;
    }
    case 'flag':
      spr('flag', x, y, 2, 0, 1, FLAG[o.color]);
      if (o.secondaryColor) spr('flag-secondary', x, y, 2, 0, 1, FLAG[o.secondaryColor]);
      break;
    case 'nuke': // the red disc and the cross, standing still. The game adds #ff2222 at .5 and brightens the sprite with a screen copy: these are the flat colours that land on the same pixels on the ground, #ad3c3c and #ff8c8c. The ring closing in is blurred, and glow.
      if (o.landTime > T) {
        ctx.globalAlpha = 0.62;
        discPx(cx, cy, 110 * U, '#ff4a4d');
        ctx.globalAlpha = 1;
        const c = nukeStamp(2.6 * cam.scale);
        if (c) place(c, 2.6 * cam.scale, x, y);
      }
      break;
  }
}

/** A ruin or a tombstone: its frame fading with age, and the X in the owner's colour while it still holds something. */
function remains(o, frame, born, x, y) {
  const age = 1 - (T - born) / (o.decayTime - born);
  spr(frame, x, y, 1, 0, age >= 0 && age <= 1 ? age : age < 0 ? 0 : 1);
  spr('tombstone-resource', x, y, 1, 0, 0.8, storeTotal(o) > 0 ? ownerColor(o.user ?? o.structure?.user) : '#000000');
}

/** Which way a creep faces and how far it has lunged, in tiles: a bite turns it to the target, a move to the way it is going. */
function stance(o, moved) {
  const log = o.actionLog;
  let lx = 0, ly = 0, turned = false;
  if (log && !moved) for (const k of BITES) {
    const t = log[k];
    if (!t || t.x == null || (t.x === o.x && t.y === o.y)) continue;
    const reach = 0.1 * flash(0.25), dx = t.x - o.x, dy = t.y - o.y;
    lx = Math.sign(dx) * reach;
    ly = Math.sign(dy) * reach;
    const ta = Math.atan2(dy, dx) + Math.PI / 2;
    o._fa = o._fa == null ? ta : smoothAngle(o._fa, ta, 0.35);
    turned = true;
    break;
  }
  if (!turned && moved) {
    const ta = Math.atan2(o.y - o._dy, o.x - o._dx) + Math.PI / 2;
    o._fa = o._fa == null ? ta : smoothAngle(o._fa, ta, 0.2);
  }
  return { fa: o._fa ?? 0, lx, ly };
}

/**
 * What a tick does to a creep that nothing else shows, flat where the game adds it. Struck, mended or both: its cover sprite, which is a
 * plain disc of 51 units, up to .5. A mass attack: #5d80b2 going out to three tiles as it fades from .4.
 */
function creepFlash(o, x, y) {
  const log = o.actionLog;
  if (!log) return;
  const hit = log.attacked ? (log.healed ? '#ffff33' : '#ff3333') : log.healed ? '#2ce328' : null;
  if (hit) { const a = 0.5 * flash(0.25); if (a > 0) effectDisc(x, y, 51, hit, a); }
  if (log.rangedMassAttack) { const left = flash(0); if (left > 0) effectDisc(x, y, 300 * (1 - left), '#5d80b2', 0.4 * left); }
}

/** The live parts as the game lays them round a creep: by summed hits, smallest first, from the front or, for move, from the back. */
function bodyArcs(o) {
  const merged = {};
  for (const b of bodyOf(o)) if (b.hits > 0 && b.type !== 'tough' && b.type !== 'carry') (merged[b.type] ??= { type: b.type, hits: 0 }).hits += b.hits;
  const arcs = [];
  let front = 0, back = Math.PI;
  for (const p of Object.values(merged).sort((a, b) => a.hits - b.hits)) {
    const part = CREEP_PARTS[p.type];
    if (!part) continue;
    const from = part.back ? back : front, sweep = (Math.PI / 50) * (p.hits / 100);
    arcs.push({ color: part.color, from, sweep });
    if (part.back) back += sweep; else front += sweep;
  }
  return arcs;
}

function drawCreep(o, x, y, ox, oy, list) {
  if (o.spawning) return;
  const moved = o.x !== o._dx || o.y !== o._dy, { fa, lx, ly } = stance(o, moved), npc = o.user === '2' || o.user === '3';
  beams(o, x, y, ox, oy, BEAM);
  creepFlash(o, x + lx, y + ly);
  const calm = safeFrom(list, o) ? 0.5 : 1, cx = w2sx(x + lx), cy = w2sy(y + ly);
  if (npc) { spr('creep-npc', x + lx, y + ly, 1, fa, calm); return; }
  if (cam.scale < 7) { discPx(cx, cy, Math.max(1.8, 50 * U), ownerColor(o.user)); return; }
  ctx.save();
  ctx.globalAlpha = calm;
  ctx.translate(cx, cy);
  ctx.rotate(fa);
  discPx(0, 0, 50 * U, '#202020');
  ctx.lineCap = 'butt';
  ctx.lineWidth = 18 * U;
  for (const { color, from, sweep } of o._arcs ?? (o._arcs = bodyArcs(o))) {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, 41 * U, -Math.PI / 2 + from, -Math.PI / 2 + from + sweep); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 41 * U, -Math.PI / 2 - from, -Math.PI / 2 - from - sweep, true); ctx.stroke();
  }
  if (o._tough ??= bodyOf(o).some(b => b.type === 'tough' && b.hits > 0)) {
    const c = tex('tough', 120 * U);
    if (c) ctx.drawImage(c, -60 * U, -60 * U, 120 * U, 120 * U);
  }
  discPx(0, 0, 32 * U, '#000000');
  badgeCircle(o.user, 0, 0, 26 * U);
  const total = storeTotal(o);
  if (total > 0) {
    const cap = o.storeCapacity || total, st = o.store, energy = st.energy || 0, power = st.power || 0;
    discPx(0, 0, 20 * U * Math.min(1, total / cap), '#ffffff');
    if (power > 0) discPx(0, 0, 20 * U * Math.min(1, (energy + power) / cap), '#f41f33');
    if (energy > 0) discPx(0, 0, 20 * U * Math.min(1, energy / cap), '#ffe56d');
  }
  ctx.restore();
}

function drawPowerCreep(o, x, y, ox, oy, list) {
  const moved = o.x !== o._dx || o.y !== o._dy, { fa, lx, ly } = stance(o, moved), calm = safeFrom(list, o) ? 0.5 : 1;
  beams(o, x, y, ox, oy, BEAM);
  creepFlash(o, x + lx, y + ly);
  spr(`${o.className}-lvl${Math.min(4, Math.ceil((o.level || 0) / 6))}`, x + lx, y + ly, 1.8, fa, calm, '#cc3d3e');
  const b = POWER_BADGE[o.className];
  if (!b) return;
  ctx.save();
  ctx.globalAlpha = calm;
  ctx.translate(w2sx(x + lx), w2sy(y + ly));
  ctx.rotate(fa);
  badgeCircle(o.user, 0, (b.size / 2 - b.pivot) * U, b.size / 2 * U);
  ctx.restore();
}

function drawObj(o, ox, oy, list) {
  const x = ox + o._dx + 0.5, y = oy + o._dy + 0.5, cx = w2sx(x), cy = w2sy(y);
  switch (o.type) {
    case 'rampart': case 'constructedWall': case 'constructionSite': case 'flag': case 'nuke': break; // drawWalls and drawRamparts
    case 'container': {
      box(cx, cy, -30, -35, 60, 70, '#181818');
      box(cx, cy, -20, -25, 40, 50, '#555555');
      storeBars(cx, cy, o, -20, 25, 40, 50, o.storeCapacity || storeTotal(o));
      break;
    }
    case 'extension': {
      const cap = o.storeCapacityResource?.energy ?? 0, size = cap >= 200 ? 100 : cap >= 100 ? 80 : 68;
      const c = extensionStamp(cap >= 200 ? 'extension-border200' : cap >= 100 ? 'extension-border100' : 'extension-border50', size, energyFill(o), ownerColor(o.user));
      if (c) place(c, cam.scale, x, y);
      break;
    }
    case 'extractor': { // turns once in four seconds while on cooldown, and stops where it is
      if (o.cooldown > 0) {
        o._spin = (NOW / 4000 % 1) * 2 * Math.PI;
        if (cam.scale >= 14) keepTurning();
      }
      spr('extractor', x, y, 2, o._spin || 0, 1, ownerColor(o.user));
      break;
    }
    case 'link': {
      spr('link-border', x, y, 1, 0, 1, ownerColor(o.user));
      spr('link', x, y, 1);
      const f = energyFill(o);
      if (f > 0) spr('link-energy', x, y, 0.5 * f);
      beams(o, x, y, ox, oy, BEAM);
      break;
    }
    case 'lab': {
      spr('lab', x, y, 2, 0, 1, ownerColor(o.user));
      if (o.cooldownTime > T) { const a = 0.5 * flash(); if (a > 0) spr('lab-highlight', x, y, 2, 0, a); }
      // the empty vessel is the grey path, the same sprite in white fills it from the foot; the fill is white whatever the mineral
      const SIDE = 0.88; // 128 natural x .6875
      spr('lab-mineral', x, y + 0.25 - SIDE / 2, SIDE, 0, 1, '#777777');
      const st = o.store ?? {}, kind = Object.keys(st).find(k => k !== 'energy' && st[k]);
      if (kind) {
        const room = o.storeCapacityResource ?? {};
        let rest = o.storeCapacity || 0;
        for (const k in room) rest -= room[k] || 0;
        const cap = room[kind] || rest, side = cap > 0 ? SIDE * st[kind] / cap : 0;
        if (side > 0) spr('lab-mineral', x, y + 0.25 - side / 2, side);
      }
      const width = 67 * energyFill(o);
      if (width > 0) box(cx, cy, -width / 2, 32, width, 10, '#ffe56d');
      const r = o.actionLog?.runReaction || o.actionLog?.reverseReaction;
      if (r) { beam(x, y, ox + r.x1 + 0.5, oy + r.y1 + 0.5, '#ffffff', 12); beam(x, y, ox + r.x2 + 0.5, oy + r.y2 + 0.5, '#ffffff', 12); }
      break;
    }
    case 'observer': { // the eye circles the lens with nothing behind it, so it rests in the middle
      const colour = ownerColor(o.user);
      ctx.beginPath(); ctx.ellipse(cx, cy, 45 * U, 40 * U, 0, 0, 7);
      ctx.fillStyle = '#111111'; ctx.fill();
      ctx.lineWidth = Math.max(1, 5 * U); ctx.strokeStyle = colour; ctx.stroke();
      discPx(cx, cy, 20 * U, colour);
      break;
    }
    case 'tower': { // turns to its target and stays there; a tower that has never fired sits where the game's random start put it
      const log = o.actionLog, shot = log && (log.attack || log.heal || log.repair);
      if (o._ta == null) o._ta = hue(o._id) * Math.PI / 180;
      if (shot && shot.x != null) o._ta = smoothAngle(o._ta, Math.atan2(shot.y - o.y, shot.x - o.x) - Math.PI / 2, 0.5);
      spr('tower-base', x, y, 2, 0, 1, ownerColor(o.user));
      const npc = o.user === '2' || o.user === '3', side = 115 * U, c = tex(npc ? 'tower-rotatable-npc' : 'tower-rotatable', side);
      if (c) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(o._ta);
        ctx.drawImage(c, -side / 2, -32 * U, side, side);
        // the bar is a child of the rotating sprite, so it is in that sprite's own units: 128 of them to 115 of ours
        const h = npc ? 0 : 66.7 * energyFill(o), k = (115 / 128) * U;
        if (h > 0) {
          ctx.beginPath();
          ctx.roundRect(-45 * k, -32 * U, 90 * k, h * k, Math.min(12, h / 2) * k);
          ctx.fillStyle = '#ffe56d';
          ctx.fill();
        }
        ctx.restore();
      }
      beams(o, x, y, ox, oy, TOWER_BEAM);
      break;
    }
    case 'storage': {
      spr('storage-border', x, y, 2, 0, 1, ownerColor(o.user));
      spr('storage', x, y, 2);
      storeBars(cx, cy, o, -55, 70, 110, 140, Math.max(o.storeCapacity || 1000000, storeTotal(o)));
      break;
    }
    case 'terminal': {
      spr('terminal-border', x, y, 2, 0, 1, ownerColor(o.user));
      spr('terminal', x, y, 2);
      spr('terminal-arrows', x, y, 2, 0, o.cooldownTime >= T ? 0.1 : 1);
      if (o.cooldownTime >= T) { const a = flash(); if (a > 0) spr('terminal-highlight', x, y, 2, 0, a); }
      const st = o.store ?? {}, cap = o.storeCapacity || 300000, total = storeTotal(o), energy = st.energy || 0, both = energy + (st.power || 0);
      if (total > both) square(cx, cy, Math.min(76, 76 * total / cap), '#ffffff');
      if (both > 0) square(cx, cy, Math.min(76, 76 * both / cap), '#f41f33');
      if (energy > 0) square(cx, cy, Math.min(76, 76 * energy / cap), '#ffe56d');
      break;
    }
    case 'powerSpawn': {
      discPx(cx, cy, 75 * U, '#222222', '#cccccc', Math.max(1, 7 * U));
      discPx(cx, cy, 68 * U, '#222222', '#f41f33', Math.max(1, 10 * U));
      discPx(cx, cy, 59 * U, '#181818');
      badgeCircle(o.user, cx, cy, 38 * U);
      const power = o.storeCapacityResource?.power ? (o.store?.power || 0) / o.storeCapacityResource.power : 0;
      if (power > 0) sweep(cx, cy, 50 * U, power, 10 * U, '#f41f33');
      const f = energyFill(o);
      if (f > 0) discPx(cx, cy, 38 * f * U, '#ffe56d');
      break;
    }
    case 'factory': {
      spr('factory-border', x, y, 2, 0, 1, ownerColor(o.user));
      spr('factory', x, y, 2);
      const a = o.cooldownTime >= T ? flash() : 0.4; // down to nothing for as long as it is working
      if (a > 0) spr('factory-highlight', x, y, 2, 0, a);
      spr('factory-lvl0', x, y, 2);
      // solid while a power creep operates it. The game blinks it 0 to 1 while none does: here that is the blink's middle, so the two stay apart without a pulse
      if (o.level > 0) spr('factory-lvl' + o.level, x, y, 2, 0, (o._operated ??= operated(o)) ? 1 : 0.5);
      box(cx, cy, -25, -25, 50, 50, '#555555');
      const st = o.store ?? {}, total = storeTotal(o), full = o.storeCapacity || total;
      if (full > 0) {
        // the game's own quirk, kept: red is power alone, not power on top of energy, so it hides behind yellow until it passes it
        const bar = (n, colour) => { if (n > 0) { const h = 50 * Math.min(1, n / full); box(cx, cy, -25, 25 - h, 50, h, colour); } };
        bar(total, '#ffffff');
        bar(st.power, '#f41f33');
        bar(st.energy, '#fadf7e');
      }
      break;
    }
    case 'nuker': {
      spr('nuker-border', x, y, 3, 0, 1, ownerColor(o.user), -0.4);
      spr('nuker', x, y, 3, 0, 1, null, -0.4);
      const cap = o.storeCapacityResource ?? {}, k = cap.energy ? (o.store?.energy || 0) / cap.energy : 0;
      if (k > 0) {
        ctx.beginPath();
        ctx.moveTo(cx - 43 * k * U, cy + 10 * U); ctx.lineTo(cx, cy + (10 - 118 * k) * U); ctx.lineTo(cx + 43 * k * U, cy + 10 * U);
        ctx.closePath();
        ctx.fillStyle = '#ffe56d';
        ctx.fill();
      }
      const g = cap.G ? 80 * (o.store?.G || 0) / cap.G : 0;
      if (g > 0) box(cx, cy, -g / 2, 35, g, 15, '#ffffff');
      break;
    }
    case 'keeperLair': { // the game's loop stopped where it reads best: the lair open, red round a closing centre
      if (60 * U < 3) { discPx(cx, cy, 3, '#000000'); discPx(cx, cy, 1.5, '#F93842'); break; } // far out it is a mark
      discPx(cx, cy, 60 * U, '#000000');
      discPx(cx, cy, 50 * U, '#780207');
      discPx(cx, cy, 15 * U, '#000000');
      break;
    }
    case 'portal': { // the same: the blue at full size with the dark centre a third open
      if (45 * U < 3) { discPx(cx, cy, 3, '#111133'); discPx(cx, cy, 1.5, '#9CC4FF'); break; }
      ctx.globalAlpha = 0.5;
      discPx(cx, cy, 45 * U, '#111133');
      discPx(cx, cy, 40 * U, '#61c0ed');
      discPx(cx, cy, 12 * U, '#111133');
      ctx.globalAlpha = 1;
      break;
    }
    case 'invaderCore': {
      spr('invaderCore', x, y, 2);
      const left = Math.floor((o.decayTime - T) / 100) * 100;
      if (left > 0) pie(cx, cy, 23 * U, left / 75000, '#ff0d39');
      const f = spawnedOf(o);
      if (f > 0) sweep(cx, cy, 40 * U, f, 10 * U, '#cccccc');
      beams(o, x, y, ox, oy, CORE_BEAM);
      break;
    }
    case 'powerBank': {
      spr('powerBank', x, y, 2);
      const power = o.store?.power ?? o.power ?? 0;
      if (power > 0) discPx(cx, cy, Math.sqrt((power / 5000) * 3000 / Math.PI) * U, '#f41f33', '#8d000d', Math.max(1, 10 * U));
      break;
    }
    case 'spawn': {
      const u = Math.max(U, 3 / 70);
      discPx(cx, cy, 70 * u, '#cccccc');
      discPx(cx, cy, 59 * u, '#181818');
      badgeCircle(o.user, cx, cy, 38 * u);
      const f = spawnedOf(o);
      if (f > 0) sweep(cx, cy, 50 * u, f, 10 * u, '#cccccc');
      const e = energyFill(o);
      if (e > 0) discPx(cx, cy, 38 * u * e, '#ffe56d');
      break;
    }
    case 'controller': {
      // reserved, blocked or in safe mode: a disc the game breathes between .05 and .4, held in the middle
      const state = o.safeMode > T ? '#ffd180' : o.upgradeBlocked > T ? '#ff3333' : o.reservation ? ownerColor(o.reservation.user) : null;
      if (state) { ctx.globalAlpha = 0.2; discPx(cx, cy, 110 * U, state); }
      if (cam.scale >= 7) { ctx.globalAlpha = 0.05; discPx(cx, cy, 92 * U, '#ffffff'); }
      ctx.globalAlpha = 1;
      spr('controller', x, y, 2, 0, 1, '#000000');
      if (cam.scale < 4 && !o.user && !state) break; // nothing of the rest of a free one is a pixel across
      const level = o.level || 0;
      for (let i = 0; i < level && i < 8; i++) spr('controller-level', x, y, 1, i * Math.PI / 4, 1, null, -0.5);
      if (o.user) badgeCircle(o.user, cx, cy, 37 * U);
      else discPx(cx, cy, 37 * U, '#222222');
      // The level says what it is working towards, should the object not.
      const total = CONTROLLER_LEVELS[level] || o.progressTotal || 0;
      if (o.progress > 0 && total > 0) { ctx.globalAlpha = 0.8; pie(cx, cy, 37 * U, o.progress / total, '#ffffff'); ctx.globalAlpha = 1; }
      discPx(cx, cy, 40 * U, null, '#080808', Math.max(1, 10 * U));
      // each tick it flashes red, the harder the nearer it is to losing a level
      if (o.downgradeTime && level) {
        const a = flash() * (CONTROLLER_DOWNGRADE[level] - (o.downgradeTime - T)) / CONTROLLER_DOWNGRADE[level];
        if (a > 0) spr('controller', x, y, 2, 0, Math.min(1, a), '#ff3333');
      }
      break;
    }
    case 'source': {
      const f = o.energyCapacity ? Math.min(1, (o.energy || 0) / o.energyCapacity) : 1;
      if (60 * U < 3) { // far out it is a mark of three pixels, and there are hundreds of them
        const left = snap(cx) - 1.5, top = snap(cy) - 1.5;
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(left, top, 3, 3);
        if (f > 0.34) { const e = 3 * f; ctx.fillStyle = '#ffe56d'; ctx.fillRect(left + (3 - e) / 2, top + (3 - e) / 2, e, e); }
        break;
      }
      rounded(cx, cy, 40 * U, 15 * U, '#060502', '#595026', 15 * U); // #111111 under the game's tint of #595026
      if (f > 0) rounded(cx, cy, 60 * f * U, 15 * U, '#ffe56d');
      break;
    }
    case 'mineral': {
      const c = MINERAL[o.mineralType] ?? STATIC_MINERAL, u = Math.max(U, 3 / 54);
      if (54 * u <= 7) { discPx(cx, cy, 54 * u, c[1], c[0], Math.max(1.2, 10 * u)); break; }
      place(mineralStamp(o.mineralType, c, 118 * u), 118 * u, x, y);
      break;
    }
    case 'deposit': {
      const c = DEPOSIT[o.depositType], a = Math.max(0, 0.6 - (o.harvested || 0) / 100000);
      if (a > 0) spr(`deposit-${o.depositType}-fill`, x, y, 1.6, 0, a, c);
      spr(`deposit-${o.depositType}`, x, y, 1.6, 0, 1, c);
      break;
    }
    case 'energy': case 'resource': {
      const kind = o.resourceType || 'energy', amount = o[kind] ?? o.amount ?? 0;
      const [colour, r] = DROPPED[kind] ?? DROPPED.other;
      discPx(cx, cy, r * Math.min(1, amount / (o[kind + 'Capacity'] || 1250)) * U, colour);
      break;
    }
    case 'tombstone': remains(o, 'tombstone-border', o.deathTime, x, y); break;
    case 'ruin': remains(o, 'ruin', o.destroyTime, x, y); break;
    case 'creep': drawCreep(o, x, y, ox, oy, list); break;
    case 'powerCreep': drawPowerCreep(o, x, y, ox, oy, list); break;
    default: discPx(cx, cy, 30 * U, PAL.neutral); // nothing the game has a recipe for
  }
  // a building the room's level no longer allows: the game blinks this up to .5 in added red, here it is a flat tint for as long as it lasts
  if (o.off) box(cx, cy, -50, -50, 100, 100, '#ff0000', 0.25);
}

// ---- the point path ----

// A mark is a colour and a size. Points collect per mark and each mark fills once, so three thousand objects are a handful of
// fills. Every one is a square of whole pixels, because a mark this small has nothing to spare for a soft edge.
const mark = (c, d) => ({ c, d });
const MARK = {
  source: mark('#ffe66b', 2), sourceFar: mark('#A99A43', 1), mineral: mark('#9aa0a6', 2), controller: mark('#8a93a6', 2),
  keeperLair: mark('#f93842', 2), powerBank: mark('#F93842', 2), portal: mark('#9CC4FF', 2), npc: mark('#F93842', 2), keyFar: mark('#000000', 3),
};
const creepFar = new Map();
const creepMarkFar = uid => { let m = creepFar.get(uid); if (!m) creepFar.set(uid, m = mark('#000000', 2)); m.c = ownerColor(uid); return m; };
function point(lod, m, x, y) {
  let a = lod.get(m);
  if (!a) lod.set(m, a = []);
  a.push(x, y);
}
/** Fills each mark once, on `g`, at `P` device pixels a tile, with world 0,0 at `ox`, `oy`. */
function fillPoints(g, lod, P, ox, oy) {
  for (const [m, a] of lod) {
    const d = Math.max(1, Math.round(m.d * DPR)), half = d >> 1;
    g.fillStyle = m.c;
    g.beginPath();
    for (let i = 0; i < a.length; i += 2) g.rect(Math.round(ox + a[i] * P) - half, Math.round(oy + a[i + 1] * P) - half, d, d);
    g.fill();
  }
}
function flushPoints(lod) { fillPoints(ctx, lod, S, OX, OY); }
function stampPoints(g, lod, P, tx, ty) { fillPoints(g, lod, P, -tx, -ty); }
