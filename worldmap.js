'use strict';
// The world map. One camera over every room of a match, so all of them can be seen at once and any of them looked into without
// leaving the rest. Room pick, spawn placement and watching a run are this one map with different rules.
//
// The ground is chart work: flat vector terrain built once per room from the tile data, rasterised at the size it shows at, with
// held rooms printed flat in their owner's colour. What stands on it is the game's own, by render.js from the game's recipes, and
// far out a point an object. Camera, input and the frame rules are the season map's. At rest every picture is one device pixel
// to one device pixel, so nothing on the map has been resampled.

const N = 50;
const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d', { alpha: false });
let W = 0, H = 0, DPR = 1, T = 0;
const cam = { cx: 0, cy: 0, scale: 1, min: 0.02, max: 56 };
const w2sx = x => (x * S + OX) / DPR;
const w2sy = y => (y * S + OY) / DPR;
const s2wx = sx => (sx - W / 2) / cam.scale + cam.cx;
const s2wy = sy => (sy - H / 2) / cam.scale + cam.cy;
/** Device pixels a tile, and where world 0,0 lands, on a whole device pixel. render.js positions everything through these. */
let S = 1, OX = 0, OY = 0;

const worldMap = (() => {
  /** Rooms a terrain tile at one device pixel a tile. Above it sit half-scale levels, below it finer ones with fewer rooms a tile. */
  const TER_TILE = 20;
  /** The widest canvas a raster tile may be, in device pixels: a size every browser keeps as a texture. */
  const TER_SIDE = 1400;
  /** What the raster cache may hold, in pixels, the base level aside. About 160 MB. */
  const TER_BUDGET = 40e6;
  /** A long tile shows what it has after this many rooms, so a thousand room tile fills as it goes. */
  const TER_SEAL_ROOMS = 96;
  /** The most the base level may hold, however big the world. On a season sized world it goes to a coarser level instead. */
  const TER_BASE_PIXELS = 8e6;
  /** The levels a live gesture draws from, in device pixels a tile. At rest a level is built at exactly the camera's scale. */
  const TER_LEVELS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64];
  /** The coarser level takes over a wheel notch early, as the game's own map does. */
  const TER_EARLY = Math.exp(100 * 0.0016);
  /** How long a frame may spend building terrain. */
  const TER_FRAME_MS = 6;
  /** No zoom for this long and the camera counts as settled: the picture sharpens to exactly its scale. */
  const SETTLE_MS = 140;
  /** Tiles of neighbouring rooms read while building a room's shapes, so rock leaves one room and enters the next unbroken. */
  const M = 6, FW = N + 2 * M, FA = FW * FW;
  /** A room smaller than this draws a point per object from the overview: recipes would be drawing detail that cannot land anywhere. */
  const LOD_PX = 48;
  /** A room this wide has space for its name at the page's 12 px floor. */
  const NAME_PX = 56;
  /** From this many pixels a tile terrain follows the tile edges. Below it the same corners are cut harder and harder. */
  const EXACT_PX = 5;
  /** How many terrain levels are remembered. A level is a few numbers that can be worked out again, so past this they all go. */
  const LEVELS_MAX = 64;
  /** A room with no list of objects has no roads. */
  const NO_ROADS = new Set();
  const FULL_SOURCE = 3000;
  /** How long new objects take to ease to where they are. */
  const EASE_MS = 300;
  const PASSIVE_FRAME_MS = 33;
  /** How far a room fills the view, and how dark a room the rules have no use for goes. */
  const ROOM_MARGIN = 1.02;
  const DIM = 170 / 255;
  /** The camera's move from one view to another: van Wijk and Nuij's smooth zoom and pan, with their rho. */
  const FLIGHT_MS = 800;
  const FLIGHT_RHO = 1.42;
  /** What a tile holds besides terrain. Terrain with the statics stamped in, and terrain with nothing but the three grounds. */
  const STAMPED = 1, BARE = 2;

  const rooms = new Map();
  let world = null, mask = null;
  let mode = null, shown = false, view = null, active = new Set();
  let looping = false, failed = false, stale = true, touched = false, settleUntil = 0, drewAt = 0;
  let drawn = { rooms: 0, objects: 0 };
  let flight = null, afterDraw = null;
  /** The view the camera is keeping as a function of the window, until the player takes the camera. */
  let home = null;
  /** Rooms with a claim on them, and rooms holding a list of objects: walked instead of the whole world. */
  const claims = new Set(), listed = new Set();

  const nameAt = (wx, wy) => `${wx < 0 ? `W${-wx - 1}` : `E${wx}`}${wy < 0 ? `N${-wy - 1}` : `S${wy}`}`;

  function parseName(name) {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return { wx: m[1] === 'W' ? -Number(m[2]) - 1 : Number(m[2]), wy: m[3] === 'N' ? -Number(m[4]) - 1 : Number(m[4]) };
  }

  /** What a room holds before anything has played: all the map knows, and all a room off the bots' paths ever needs. A mineral comes with its type. */
  function staticsOf(room) {
    return room.objects.map(([type, x, y, mineralType]) => ({ type, x, y, _dx: x, _dy: y, ...(type === 'source' ? { energy: FULL_SOURCE, energyCapacity: FULL_SOURCE } : {}), ...(mineralType ? { mineralType } : {}) }));
  }

  function load(list) {
    rooms.clear();
    claims.clear();
    listed.clear();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const room of list) {
      const { wx, wy } = parseName(room.room);
      x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy);
      rooms.set(room.room, { name: room.room, wx, wy, claimable: room.claimable, terrain: room.terrain, statics: staticsOf(room), list: null, roads: NO_ROADS, facts: null, geo: null, owner: null, reserved: null });
    }
    world = { x0, y0, cols: x1 - x0 + 1, rows: y1 - y0 + 1 };
    mode = null;
    mask = null;
    view = null;
    home = null;
    active = new Set();
    resetTerrain();
  }

  // ---- terrain: the geometry, built once a room from the tile data ----

  const edgeA = new Int32Array(2 * FA).fill(-1), edgeB = new Int32Array(2 * FA).fill(-1);
  const crossX = new Float32Array(2 * FA), crossY = new Float32Array(2 * FA);
  const edgesUsed = new Int32Array(8 * FA);

  /**
   * Marching squares over a field: closed lines at `iso`, in room tile coordinates. The field's outer row is held below `iso`
   * by the caller, so every line closes, and the part outside the room is cut off by the room's clip. A saddle goes the way
   * that keeps walkable ground joined, because a creep can pass between two walls that touch at a corner.
   */
  function trace(f, iso) {
    let used = 0;
    const link = (a, b) => {
      if (edgeA[a] < 0) { edgeA[a] = b; edgesUsed[used++] = a; } else edgeB[a] = b;
      if (edgeA[b] < 0) { edgeA[b] = a; edgesUsed[used++] = b; } else edgeB[b] = a;
    };
    const lerp = (a, b) => (iso - a) / (b - a);
    for (let j = 0; j < FW - 1; j++) {
      for (let i = 0; i < FW - 1; i++) {
        const q = j * FW + i;
        const a = f[q], b = f[q + 1], c = f[q + FW + 1], d = f[q + FW];
        const k = (a >= iso ? 1 : 0) | (b >= iso ? 2 : 0) | (c >= iso ? 4 : 0) | (d >= iso ? 8 : 0);
        if (k === 0 || k === 15) continue;
        const top = 2 * q, left = 2 * q + 1, bottom = 2 * (q + FW), right = 2 * (q + 1) + 1;
        if ((k & 1) !== ((k >> 1) & 1)) { crossX[top] = i + lerp(a, b); crossY[top] = j; }
        if (((k >> 3) & 1) !== ((k >> 2) & 1)) { crossX[bottom] = i + lerp(d, c); crossY[bottom] = j + 1; }
        if ((k & 1) !== ((k >> 3) & 1)) { crossX[left] = i; crossY[left] = j + lerp(a, d); }
        if (((k >> 1) & 1) !== ((k >> 2) & 1)) { crossX[right] = i + 1; crossY[right] = j + lerp(b, c); }
        switch (k) {
          case 1: case 14: link(top, left); break;
          case 2: case 13: link(top, right); break;
          case 3: case 12: link(left, right); break;
          case 4: case 11: link(right, bottom); break;
          case 6: case 9: link(top, bottom); break;
          case 7: case 8: link(left, bottom); break;
          case 5: link(top, left); link(right, bottom); break;
          case 10: link(top, right); link(left, bottom); break;
        }
      }
    }
    const lines = [];
    for (let u = 0; u < used; u++) {
      const start = edgesUsed[u];
      if (edgeA[start] < -1) continue;
      const pts = [];
      let prev = -1, at = start;
      do {
        pts.push(crossX[at] - M + 0.5, crossY[at] - M + 0.5);
        const a = edgeA[at], b = edgeB[at];
        edgeA[at] = -2;
        const next = a !== prev && a >= 0 ? a : b;
        prev = at;
        at = next;
      } while (at >= 0 && edgeA[at] >= 0);
      if (pts.length >= 6) lines.push(Float32Array.from(pts));
    }
    for (let u = 0; u < used; u++) { edgeA[edgesUsed[u]] = -1; edgeB[edgesUsed[u]] = -1; }
    return lines;
  }

  /** The area a closed line holds, in tiles. */
  function areaOf(p) {
    let a = 0;
    for (let i = 0, n = p.length; i < n; i += 2) {
      const k = (i + 2) % n;
      a += p[i] * p[k + 1] - p[k] * p[i + 1];
    }
    return Math.abs(a) / 2;
  }

  /**
   * Douglas and Peucker on a closed line. The result is long straight facets: terrain far out is cut with a ruling pen, the same
   * angular hand as the corners close in, so zooming out cuts the corners harder and never turns stairs into blobs.
   */
  function facets(p, tol) {
    const n = p.length >> 1;
    if (n < 5) return p;
    // the two ends: the first vertex and the one furthest from it
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) { const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2; if (d > best) { best = d; far = i; } }
    const keep = new Uint8Array(n);
    keep[0] = keep[far] = 1;
    const spans = [[0, far], [far, n]];
    while (spans.length) {
      const [a, b] = spans.pop();
      if (b - a < 2) continue;
      const ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * (b % n)], by = p[2 * (b % n) + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-6;
      let worst = 0, at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((p[2 * i] - ax) * dy - (p[2 * i + 1] - ay) * dx) / len;
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol) { keep[at] = 1; spans.push([a, at], [at, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
    return out.length >= 6 ? Float32Array.from(out) : p;
  }

  function boxBlur(f, r) {
    const out = new Float32Array(FA), tmp = new Float32Array(FA), w = 2 * r + 1;
    for (let j = 0; j < FW; j++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += f[j * FW + Math.max(0, Math.min(FW - 1, i))];
      for (let i = 0; i < FW; i++) {
        tmp[j * FW + i] = s / w;
        s += f[j * FW + Math.min(FW - 1, i + r + 1)] - f[j * FW + Math.max(0, i - r)];
      }
    }
    for (let i = 0; i < FW; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += tmp[Math.max(0, Math.min(FW - 1, j)) * FW + i];
      for (let j = 0; j < FW; j++) {
        out[j * FW + i] = s / w;
        s += tmp[Math.min(FW - 1, j + r + 1) * FW + i] - tmp[Math.max(0, j - r) * FW + i];
      }
    }
    return out;
  }

  function closeBorder(f) {
    for (let i = 0; i < FW; i++) { f[i] = -1; f[FA - 1 - i] = -1; f[i * FW] = -1; f[i * FW + FW - 1] = -1; }
    return f;
  }

  /** Runs of tiles a row at a time, as [row, from, to, ...]. */
  function runsOf(test) {
    const runs = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!test(x, y)) continue;
        const from = x;
        while (x + 1 < N && test(x + 1, y)) x++;
        runs.push(y, from, x + 1);
      }
    }
    return Int8Array.from(runs);
  }

  /** The tile window a room's shapes are built from: the room and a margin of its neighbours. Held for one room at a time. */
  let windowFor = null;
  function windowOf(room) {
    if (windowFor?.room === room) return windowFor;
    const near = [];
    for (let ry = -1; ry <= 1; ry++) for (let rx = -1; rx <= 1; rx++) near.push(rx || ry ? rooms.get(nameAt(room.wx + rx, room.wy + ry))?.terrain ?? null : room.terrain);
    const wall = new Float32Array(FA), swamp = new Float32Array(FA);
    for (let j = 0; j < FW; j++) {
      const ty = j - M, ry = ty < 0 ? -1 : ty >= N ? 1 : 0;
      for (let i = 0; i < FW; i++) {
        const tx = i - M, rx = tx < 0 ? -1 : tx >= N ? 1 : 0;
        const other = near[(ry + 1) * 3 + rx + 1];
        const t = other ?? room.terrain;
        const lx = other ? tx - rx * N : Math.max(0, Math.min(N - 1, tx)), ly = other ? ty - ry * N : Math.max(0, Math.min(N - 1, ty));
        const c = (t.charCodeAt(ly * N + lx) - 48) & 3;
        wall[j * FW + i] = c & 1;
        swamp[j * FW + i] = c === 2 ? 1 : 0;
      }
    }
    windowFor = { room, wall, swamp };
    return windowFor;
  }

  /**
   * Everything a room's terrain will ever draw, in tile units. Each part is built once, the first time a scale asks for it, so
   * a far view of a thousand rooms builds a thousand coarse coasts and nothing else.
   *
   *   loops    the rock's outline along the tile edges, a vertex at every turn
   *   walls    the wall tiles as runs, for where a tile must be exact to the corner
   *   coast    the rock generalised: 0, 1, 2 and 4 tiles of smoothing, faceted, losing what is smaller than it can carry
   *   swamp    swamp tiles as runs
   *   marsh    swamp generalised for far out
   */
  const geoKept = new Map();
  const GEO_ROOMS = 1500;
  function geometry(room) {
    if (room.geo) return room.geo;
    room.geo = { room, coast: [], marsh: [], loops: null, walls: null, swamp: null };
    geoKept.set(room.name, room);
    if (geoKept.size > GEO_ROOMS) {
      const [name, old] = geoKept.entries().next().value;
      geoKept.delete(name);
      old.geo = null;
    }
    return room.geo;
  }

  const COAST_BLUR = [0, 1, 2, 4], COAST_LEAST = [0, 4, 14, 40], COAST_TOL = [0.08, 0.55, 1.1, 1.8];
  function coastOf(geo, k) {
    if (geo.coast[k]) return geo.coast[k];
    const { wall } = windowOf(geo.room);
    const f = closeBorder(COAST_BLUR[k] ? boxBlur(wall, COAST_BLUR[k]) : Float32Array.from(wall));
    return geo.coast[k] = trace(f, 0.5).filter(l => areaOf(l) >= COAST_LEAST[k]).map(l => facets(l, COAST_TOL[k]));
  }

  const MARSH_BLUR = [0, 1, 2, 3], MARSH_LEAST = [2, 6, 20, 50], MARSH_TOL = [0.08, 0.5, 0.9, 1.4];
  function marshOf(geo, k) {
    if (geo.marsh[k]) return geo.marsh[k];
    const { swamp } = windowOf(geo.room);
    return geo.marsh[k] = trace(closeBorder(MARSH_BLUR[k] ? boxBlur(swamp, MARSH_BLUR[k]) : Float32Array.from(swamp)), 0.5).filter(l => areaOf(l) >= MARSH_LEAST[k]).map(l => facets(l, MARSH_TOL[k]));
  }

  function swampOf(geo) {
    if (geo.swamp) return geo.swamp;
    const t = geo.room.terrain;
    return geo.swamp = runsOf((x, y) => ((t.charCodeAt(y * N + x) - 48) & 3) === 2);
  }

  function wallsOf(geo) {
    if (geo.walls) return geo.walls;
    const t = geo.room.terrain;
    return geo.walls = runsOf((x, y) => ((t.charCodeAt(y * N + x) - 48) & 1) === 1);
  }

  const outs = new Uint8Array((FW + 1) * (FW + 1));
  const STEP = [1, FW + 1, -1, -(FW + 1)];
  /**
   * The rock's edges as closed lines along the tile grid, rock on the right, a vertex at every turn. Where two walls touch at a
   * corner the line turns to stay on one of them, so walkable ground stays joined, as it is for a creep.
   */
  function loopsOf(geo) {
    if (geo.loops) return geo.loops;
    const { wall } = windowOf(geo.room);
    const V = FW + 1;
    outs.fill(0);
    for (let j = 0; j < FW; j++) {
      for (let i = 0; i < FW; i++) {
        const q = j * FW + i;
        if (!wall[q]) continue;
        if (j === 0 || !wall[q - FW]) outs[j * V + i] |= 1;
        if (i === FW - 1 || !wall[q + 1]) outs[j * V + i + 1] |= 2;
        if (j === FW - 1 || !wall[q + FW]) outs[(j + 1) * V + i + 1] |= 4;
        if (i === 0 || !wall[q - 1]) outs[(j + 1) * V + i] |= 8;
      }
    }
    const loops = [];
    for (let v = 0; v < outs.length; v++) {
      while (outs[v]) {
        const first = outs[v] & 1 ? 0 : outs[v] & 2 ? 1 : outs[v] & 4 ? 2 : 3;
        const pts = [];
        let at = v, dir = first;
        outs[at] &= ~(1 << dir);
        at += STEP[dir];
        for (;;) {
          const right = (dir + 1) & 3, left = (dir + 3) & 3;
          let next = -1, closed = false;
          for (const c of [right, dir, left]) {
            if (at === v && c === first) { closed = true; next = c; break; }
            if ((outs[at] >> c) & 1) { next = c; break; }
          }
          if (next < 0) break;
          if (next !== dir) pts.push((at % V) - M, ((at / V) | 0) - M);
          if (closed) break;
          dir = next;
          outs[at] &= ~(1 << dir);
          at += STEP[dir];
        }
        if (pts.length >= 8) loops.push(Int16Array.from(pts));
      }
    }
    return geo.loops = loops;
  }

  // ---- terrain: the raster tiles ----

  /**
   * A tile holds what is in one square of the world at one scale, drawn straight from the geometry, with walkable ground left
   * transparent so what is printed under the rooms shows through. Tile edges fall on whole pixels of that scale, so two
   * neighbours at the same scale meet without a seam, and at rest a tile goes to the screen unscaled.
   */
  const levelCache = new Map();
  const tiles = new Map();
  let terPixels = 0, jobs = [], baseJobs = null, baseP = 1, scaleSeen = 0, scaleAt = 0, rest = true, restLevel = null;

  function resetTerrain() {
    restLevel = null;
    levelCache.clear();
    tiles.clear();
    terPixels = 0;
    jobs = [];
    baseJobs = null;
    baseP = 1;
    if (world) while (baseP > 1 / 8 && world.cols * world.rows * N * N * baseP * baseP > TER_BASE_PIXELS) baseP /= 2;
  }

  function levelOf(P, kind) {
    const key = P + '/' + kind;
    let lv = levelCache.get(key);
    if (lv) return lv;
    let span = TER_TILE * N;
    while (span * P * 2 <= TER_SIDE) span *= 2;
    while (span * P > TER_SIDE) span /= 2;
    lv = { key, P, kind, span, cols: Math.ceil(world.cols * N / span), rows: Math.ceil(world.rows * N / span) };
    if (levelCache.size >= LEVELS_MAX) levelCache.clear();
    levelCache.set(key, lv);
    return lv;
  }

  function tileOf(lv, i, j, make) {
    const key = `${lv.key}/${i}/${j}`;
    let t = tiles.get(key);
    if (t) { tiles.delete(key); tiles.set(key, t); return t; }
    if (!make) return null;
    const x0 = world.x0 * N + i * lv.span, y0 = world.y0 * N + j * lv.span;
    const x1 = Math.min((world.x0 + world.cols) * N, x0 + lv.span), y1 = Math.min((world.y0 + world.rows) * N, y0 + lv.span);
    const ox = Math.round(x0 * lv.P), oy = Math.round(y0 * lv.P);
    const list = [];
    for (let wy = Math.floor(y0 / N); wy < Math.ceil(y1 / N); wy++) {
      for (let wx = Math.floor(x0 / N); wx < Math.ceil(x1 / N); wx++) {
        const room = rooms.get(nameAt(wx, wy));
        if (room) list.push(room);
      }
    }
    // what the camera is on comes first, so a tile of a thousand rooms fills from where the player is looking
    const near = room => Math.abs(room.wx * N + N / 2 - cam.cx) + Math.abs(room.wy * N + N / 2 - cam.cy);
    if (list.length > 1) list.sort((a, b) => near(a) - near(b));
    t = { key, lv, P: lv.P, i, j, x0, y0, x1, y1, ox, oy, list, at: 0, done: false, scratch: null, g: null, cv: null, w: 0, h: 0, fresh: 0 };
    tiles.set(key, t);
    return t;
  }

  /**
   * A tile is drawn on a scratch canvas held on the CPU, so the cost of a room lands inside the room's own turn and not in one lump
   * at the first blit. When it is done it is copied once into a plain canvas, the one upload it will ever need, and the scratch
   * goes. A frame only ever draws the plain canvas, so a frame uploads nothing, in any browser.
   */
  function openTile(t) {
    t.w = Math.max(1, Math.round(t.x1 * t.P) - t.ox);
    t.h = Math.max(1, Math.round(t.y1 * t.P) - t.oy);
    t.scratch = document.createElement('canvas');
    t.scratch.width = t.w; t.scratch.height = t.h;
    t.g = t.scratch.getContext('2d', { willReadFrequently: true });
    terPixels += t.w * t.h;
    // the oldest go first, whatever scale they were at; the base level stays
    for (const old of tiles.values()) {
      if (terPixels <= TER_BUDGET) break;
      if (old === t || old.lv.key === baseKey() || !old.w) continue;
      terPixels -= old.w * old.h;
      tiles.delete(old.key);
    }
  }

  function sealTile(t) {
    if (!t.cv) {
      t.cv = document.createElement('canvas');
      t.cv.width = t.w; t.cv.height = t.h;
    }
    const g = t.cv.getContext('2d');
    g.clearRect(0, 0, t.w, t.h);
    g.drawImage(t.scratch, 0, 0);
    t.fresh = 0;
    if (t.at >= t.list.length) { t.scratch = null; t.g = null; }
  }

  const baseKey = () => baseP + '/' + STAMPED;

  const hatches = new Map();
  /** The fine line screen a surface is printed in: one small tile, repeated. Every pixel is whole, so it never swims or blurs. */
  function hatchOf(pitch, w, colour) {
    const key = pitch + '/' + w + colour;
    let p = hatches.get(key);
    if (p) return p;
    const c = document.createElement('canvas');
    c.width = c.height = pitch;
    const g = c.getContext('2d');
    g.fillStyle = colour;
    for (let i = 0; i < pitch; i++) for (let k = 0; k < w; k++) g.fillRect((i + k) % pitch, pitch - 1 - i, 1, 1);
    p = ctx.createPattern(c, 'repeat');
    hatches.set(key, p);
    return p;
  }

  /** One room's part of one tile. */
  function stampRoom(t, room) {
    const g = t.g, P = t.P, px = P / DPR, geo = geometry(room);
    const bare = !!(t.lv.kind & BARE), stamped = !!(t.lv.kind & STAMPED);
    const E = v => Math.round(v * P);
    const gx0 = room.wx * N, gy0 = room.wy * N;
    const X0 = E(gx0) - t.ox, Y0 = E(gy0) - t.oy, X1 = E(gx0 + N) - t.ox, Y1 = E(gy0 + N) - t.oy;
    const ex = x => E(gx0 + x) - t.ox, ey = y => E(gy0 + y) - t.oy;
    const fx = x => (gx0 + x) * P - t.ox, fy = y => (gy0 + y) * P - t.oy;
    const side = px * N;
    const lw = css => Math.max(1, Math.round(css * DPR));
    g.save();
    g.beginPath(); g.rect(X0, Y0, X1 - X0, Y1 - Y0); g.clip();
    g.lineCap = 'butt'; g.lineJoin = 'miter';

    const exact = bare || px >= EXACT_PX;
    const k = px >= 2.4 ? 0 : px >= 1.8 ? 1 : px >= 1.5 ? 2 : 3;
    const outline = list => {
      g.beginPath();
      for (const p of list) {
        g.moveTo(fx(p[0]), fy(p[1]));
        for (let i = 2; i < p.length; i += 2) g.lineTo(fx(p[i]), fy(p[i + 1]));
        g.closePath();
      }
    };

    // the swamp: a fine line screen, whole pixels, that lies over whatever is printed under it. Close in it stops dead at the
    // swamp's tiles; far out it fills a generalised shape. Either way it has an area and an edge, at every scale
    const pitch = Math.max(2, Math.round((px >= 28 ? 5 : px >= 10 ? 4 : 3) * DPR));
    const screen = hatchOf(pitch, Math.max(1, Math.round(DPR)), INK.marsh);
    screen.setTransform(new DOMMatrix([1, 0, 0, 1, -(t.ox % pitch), -(t.oy % pitch)]));
    if (exact) {
      const r = swampOf(geo);
      if (r.length) {
        g.beginPath();
        for (let i = 0; i < r.length; i += 3) g.rect(ex(r[i + 1]), ey(r[i]), ex(r[i + 2]) - ex(r[i + 1]), ey(r[i] + 1) - ey(r[i]));
        g.fillStyle = screen;
        g.fill();
        // the marsh symbol: a tuft on alternate tiles, so at the top of the zoom a swamp is a place and not a texture
        if (px >= 28) {
          const h = Math.round(0.2 * P), w = lw(1), odd = w % 2 ? 0.5 : 0;
          g.beginPath();
          for (let i = 0; i < r.length; i += 3) {
            for (let x = r[i + 1]; x < r[i + 2]; x++) {
              if ((x + r[i]) % 2) continue;
              const cx = ex(x + 0.5), base = ey(r[i] + 0.62);
              for (const lean of [-0.14, 0, 0.14]) { const q = Math.round(lean * P); g.moveTo(cx + odd + Math.round(q * 0.3), base + odd); g.lineTo(cx + odd + q, base + odd - (lean ? Math.round(h * 0.75) : h)); }
            }
          }
          g.lineWidth = w; g.strokeStyle = INK.tuft; g.stroke();
        }
      }
    } else if (px >= 0.5) {
      const marsh = marshOf(geo, px >= 3.6 ? 0 : px >= 2 ? 1 : px >= 1.5 ? 2 : 3);
      if (marsh.length) { outline(marsh); g.fillStyle = screen; g.fill('evenodd'); }
    }

    // the rock: one flat shape. Exact where a tile is placed on, its corners cut a little from where a tile can spare it, and
    // below that the same outline with its corners cut harder as the scale falls
    if (bare) {
      g.beginPath();
      const r = wallsOf(geo);
      for (let i = 0; i < r.length; i += 3) g.rect(ex(r[i + 1]), ey(r[i]), ex(r[i + 2]) - ex(r[i + 1]), ey(r[i] + 1) - ey(r[i]));
      g.fillStyle = INK.void;
      g.fill();
    } else if (exact) {
      // a sixth of a tile close in, half a tile at the scale where the shape hands over to the facets, which are that same half tile cut
      const c = Math.max(1, Math.round((0.5 - 0.33 * ramp(px, EXACT_PX, 13)) * P));
      const cut = (off) => {
        g.beginPath();
        for (const p of loopsOf(geo)) {
          const n = p.length;
          for (let i = 0; i < n; i += 2) {
            const ax = p[(i + n - 2) % n], ay = p[(i + n - 1) % n], x = p[i], y = p[i + 1], bx = p[(i + 2) % n], by = p[(i + 3) % n];
            const X = ex(x) + off, Y = ey(y) + off;
            if (i) g.lineTo(X + Math.sign(ax - x) * c, Y + Math.sign(ay - y) * c);
            else g.moveTo(X + Math.sign(ax - x) * c, Y + Math.sign(ay - y) * c);
            g.lineTo(X + Math.sign(bx - x) * c, Y + Math.sign(by - y) * c);
          }
          g.closePath();
        }
      };
      cut(0);
      g.fillStyle = INK.void;
      g.fill('evenodd');
      const w = lw(px >= 18 ? 1.5 : 1);
      cut(w % 2 ? 0.5 : 0);
      g.lineWidth = w;
      g.strokeStyle = INK.coast;
      g.stroke();
    } else {
      outline(coastOf(geo, k));
      g.fillStyle = rockOf(px);
      g.fill('evenodd');
      if (px >= 1.5) { g.lineWidth = lw(px >= 2.4 ? 1 : 0.5); g.strokeStyle = INK.line; g.stroke(); }
    }

    // a dot on every tile corner of the ground, so a tile can be counted and picked without a grid over the map
    if (px >= (bare ? 9 : 18)) {
      const d = lw(1), terrain = room.terrain, wallAt = (x, y) => (terrain.charCodeAt(y * N + x) - 48) & 1;
      g.beginPath();
      for (let y = 1; y < N; y++) {
        for (let x = 1; x < N; x++) {
          if (!wallAt(x, y) || !wallAt(x - 1, y) || !wallAt(x, y - 1) || !wallAt(x - 1, y - 1)) g.rect(ex(x), ey(y), d, d);
        }
      }
      g.fillStyle = INK.tile;
      g.fill();
    }

    if (!bare) {
      // the room's edge is only drawn where it can be crossed: a limit line across the exits, nothing along the rock
      if (px >= 2) {
        const terrain = room.terrain, open = (x, y) => !((terrain.charCodeAt(y * N + x) - 48) & 1);
        const d = lw(1), step = px >= 5 ? 1 : 2;
        g.beginPath();
        for (let v = 0; v < N; v += step) {
          const a = ex(v), b = ey(v), ax = ex(v + step) - a, by = ey(v + step) - b;
          const dash = Math.max(1, Math.round(ax * 0.5)), gx = Math.round((ax - dash) / 2), dashY = Math.max(1, Math.round(by * 0.5)), gy = Math.round((by - dashY) / 2);
          if (open(v, 0)) g.rect(a + gx, Y0, dash, d);
          if (open(v, N - 1)) g.rect(a + gx, Y1 - d, dash, d);
          if (open(0, v)) g.rect(X0, b + gy, d, dashY);
          if (open(N - 1, v)) g.rect(X1 - d, b + gy, d, dashY);
        }
        g.fillStyle = INK.mark;
        g.fill();
      }

      // registration crosses on the corners, in place of a box round the room
      const sector = (wx, wy) => wx % 10 === 0 && wy % 10 === 0;
      const big = sector(room.wx, room.wy) || sector(room.wx + 1, room.wy) || sector(room.wx, room.wy + 1) || sector(room.wx + 1, room.wy + 1);
      if (side >= 16 || big) {
        const d = lw(1);
        g.fillStyle = INK.mark;
        // a quarter of a cross: the rooms round the corner draw the rest, and the line itself belongs to the room below and to the right
        const mark = (X, Y, sx, sy, arm) => {
          if (sx > 0 && sy > 0) { g.fillRect(X, Y, arm, d); g.fillRect(X, Y, d, arm); }
          else if (sx > 0) g.fillRect(X, Y - arm, d, arm);
          else if (sy > 0) g.fillRect(X - arm, Y, arm, d);
        };
        const arm = c => Math.round((c ? 10 : side >= 300 ? 7 : side >= 56 ? 4 : 2) * DPR);
        mark(X0, Y0, 1, 1, arm(sector(room.wx, room.wy)));
        mark(X1, Y0, -1, 1, arm(sector(room.wx + 1, room.wy)));
        mark(X0, Y1, 1, -1, arm(sector(room.wx, room.wy + 1)));
        mark(X1, Y1, -1, -1, arm(sector(room.wx + 1, room.wy + 1)));
      }
    }

    // Far out what never moves is part of the terrain: sources, minerals, controllers and lairs are stamped into the tile, and a
    // frame only has to place what moves, so a far view costs what the active rooms cost and not what the world holds
    if (stamped && side >= 12) {
      const lod = new Map(), tiny = side < 36;
      for (const o of room.statics) {
        // an eight player world fits at 32 px a room. There a room keeps its sources, a dim pixel each, and nothing else: more is confetti
        if (tiny) { if (o.type === 'source') point(lod, MARK.sourceFar, gx0 + o.x + 0.5, gy0 + o.y + 0.5); continue; }
        if (o.type === 'source' || o.type === 'mineral' || o.type === 'controller' || o.type === 'keeperLair') point(lod, MARK[o.type], gx0 + o.x + 0.5, gy0 + o.y + 0.5);
      }
      stampPoints(g, lod, P, t.ox, t.oy);
    }
    g.restore();
  }

  /** Spends a frame's allowance on the tiles this view is waiting for, a room at a time. Only those ask for a new frame. */
  function buildTerrain() {
    const until = performance.now() + TER_FRAME_MS;
    let any = false;
    while (performance.now() < until) {
      let t = jobs[0];
      if (t?.done) { jobs.shift(); continue; }
      const seen = !!t;
      if (!t) {
        // nothing is waiting: the base level, a room at a time, so that anywhere the camera goes has something under it
        if (!baseJobs) {
          baseJobs = [];
          const lv = levelOf(baseP, STAMPED);
          for (let j = 0; j < lv.rows; j++) for (let i = 0; i < lv.cols; i++) baseJobs.push([lv, i, j]);
        }
        const next = baseJobs[0];
        if (!next) break;
        t = tileOf(next[0], next[1], next[2], true);
        if (t.done) { baseJobs.shift(); continue; }
      }
      if (!t.scratch) openTile(t);
      if (t.at < t.list.length) { stampRoom(t, t.list[t.at++]); t.fresh++; }
      const finished = t.at >= t.list.length;
      if (finished || t.fresh >= TER_SEAL_ROOMS) { sealTile(t); if (seen) any = true; }
      if (finished) {
        t.done = true;
        if (jobs[0] === t) jobs.shift(); else baseJobs?.shift();
      }
    }
    return any;
  }

  /** The screen's piece of a tile, from wherever the tile is held. */
  function blit(t, bx0, by0, bx1, by1) {
    if (!t.cv) return;
    const dx = Math.round(t.x0 * S) + OX, dy = Math.round(t.y0 * S) + OY;
    if (t.P === S) { ctx.drawImage(t.cv, dx, dy); return; }
    const dw = Math.round(t.x1 * S) + OX - dx, dh = Math.round(t.y1 * S) + OY - dy;
    if (bx0 == null) { ctx.drawImage(t.cv, dx, dy, dw, dh); return; }
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.round(bx0 * S) + OX, Math.round(by0 * S) + OY, Math.round((bx1 - bx0) * S), Math.round((by1 - by0) * S));
    ctx.clip();
    ctx.drawImage(t.cv, dx, dy, dw, dh);
    ctx.restore();
  }

  function paintLevel(chain, at, x0, y0, x1, y1) {
    const lv = chain[at];
    const ox = world.x0 * N, oy = world.y0 * N;
    const i0 = Math.max(0, Math.floor((x0 - ox) / lv.span)), i1 = Math.min(lv.cols - 1, Math.floor((x1 - 1e-6 - ox) / lv.span));
    const j0 = Math.max(0, Math.floor((y0 - oy) / lv.span)), j1 = Math.min(lv.rows - 1, Math.floor((y1 - 1e-6 - oy) / lv.span));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = tileOf(lv, i, j, at === 0);
        if (t?.done) { blit(t, at ? Math.max(x0, t.x0) : null, Math.max(y0, t.y0), Math.min(x1, t.x1), Math.min(y1, t.y1)); continue; }
        if (at === 0 && t) jobs.push(t);
        if (at + 1 < chain.length) {
          const bx = ox + i * lv.span, by = oy + j * lv.span;
          paintLevel(chain, at + 1, Math.max(x0, bx), Math.max(y0, by), Math.min(x1, bx + lv.span), Math.min(y1, by + lv.span));
        }
        if (t?.cv) blit(t);
      }
    }
  }

  /** At rest the level is the camera's exact scale. In a gesture it is a fixed level, scaled for the moment. */
  function drawTerrain(kind) {
    let near = TER_LEVELS.length - 1;
    while (near > 0 && TER_LEVELS[near - 1] * TER_EARLY >= S) near--;
    const chain = [];
    if (rest) { restLevel = levelOf(S, kind); chain.push(restLevel); if (TER_LEVELS[near] !== S) chain.push(levelOf(TER_LEVELS[near], kind)); }
    else {
      chain.push(levelOf(TER_LEVELS[near], kind));
      // what was sharp a moment ago is the best thing to stretch until the level is ready
      if (restLevel && restLevel !== chain[0]) chain.push(restLevel);
    }
    for (let L = near - 1; L >= 0; L--) chain.push(levelOf(TER_LEVELS[L], kind));
    const base = levelOf(baseP, STAMPED);
    if (!(kind & BARE) && !chain.includes(base)) chain.push(base);
    jobs.length = 0;
    paintLevel(chain, 0, s2wx(0), s2wy(0), s2wx(W), s2wy(H));
    jobs.sort((a, b) => Math.hypot(a.x0 + a.lv.span / 2 - cam.cx, a.y0 + a.lv.span / 2 - cam.cy) - Math.hypot(b.x0 + b.lv.span / 2 - cam.cx, b.y0 + b.lv.span / 2 - cam.cy));
    ctx.imageSmoothingEnabled = true;
  }

  /** One pixel a room, painted once: what the current rules have no use for. Drawn at `DIM`, or solid where the rules say `solid`. */
  function buildMask() {
    mask = null;
    if (!mode?.dim) return;
    const cv = document.createElement('canvas');
    cv.width = world.cols; cv.height = world.rows;
    const g = cv.getContext('2d');
    const img = g.createImageData(world.cols, world.rows);
    for (let gy = 0; gy < world.rows; gy++) {
      for (let gx = 0; gx < world.cols; gx++) {
        const room = rooms.get(nameAt(world.x0 + gx, world.y0 + gy));
        if (room && mode.dim(room)) img.data[(gy * world.cols + gx) * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    mask = cv;
  }

  // ---- who holds what ----

  const stripes = new Map();

  /** A claim short of ownership is hatched, the way an atlas hatches a disputed border. One small tile, repeated. */
  function stripeOf(colour) {
    const key = colour + DPR, q = Math.round(9 * DPR);
    let p = stripes.get(key);
    if (!p) {
      const c = document.createElement('canvas');
      c.width = c.height = q;
      const g = c.getContext('2d');
      g.fillStyle = colour;
      const w = Math.max(1, Math.round(DPR));
      for (let i = 0; i < q; i++) for (let k = 0; k < w; k++) g.fillRect((i + k) % q, i, 1, 1);
      p = ctx.createPattern(c, 'repeat');
      stripes.set(key, p);
    }
    p.setTransform(new DOMMatrix([1, 0, 0, 1, OX % q, OY % q]));
    return p;
  }

  /**
   * The rooms printed this frame, as [room, colour, solid]: who holds what, then what the rules name. The rules' list comes from
   * `mode.sheets()`, read once a frame, so this walks the claims and the seats and never the world.
   */
  let held = [];
  const printed = new Map();
  function holdings() {
    held.length = 0;
    printed.clear();
    for (const room of claims) {
      if (room.owner) { held.push([room, ownerColor(room.owner), true]); printed.set(room, ownerColor(room.owner)); }
      else if (room.reserved) held.push([room, ownerColor(room.reserved), false]);
    }
    const ruled = mode?.sheets?.();
    if (ruled) for (const [name, colour, solid] of ruled) {
      const room = rooms.get(name);
      if (!room) continue;
      held.push([room, colour, solid]);
      if (solid) printed.set(room, colour);
    }
  }

  function roomSquare(room) {
    const x = Math.round(room.wx * N * S) + OX, y = Math.round(room.wy * N * S) + OY;
    return [x, y, Math.round((room.wx + 1) * N * S) + OX - x, Math.round((room.wy + 1) * N * S) + OY - y];
  }

  /** Held rooms are printed in their owner's colour, flat and opaque, so far out ownership is a shape. The print falls back across a range of scales. */
  function drawSheets(px) {
    const p = printOf(px);
    for (const [room, colour, solid] of held) {
      const [x, y, w, h] = roomSquare(room);
      if (x > W * DPR || y > H * DPR || x + w < 0 || y + h < 0) continue;
      if (solid) {
        ctx.fillStyle = mix(colour, INK.plain, p);
        ctx.fillRect(x, y, w, h);
      } else if (px < 5) {
        ctx.fillStyle = stripeOf(mix(colour, INK.plain, 0.42));
        ctx.fillRect(x, y, w, h);
      }
    }
  }

  /** The heavy corners on a held room, in place of the small crosses. They sit over the terrain, because a claim outranks the ground it is on. */
  function drawClaimCorners() {
    for (const [room, colour, solid] of held) {
      const [x, y, w, h] = roomSquare(room);
      if (x > W * DPR || y > H * DPR || x + w < 0 || y + h < 0) continue;
      const d = Math.round((solid ? 3 : 2) * DPR), arm = Math.min(Math.round(w / 3), Math.round((solid ? 16 : 7) * DPR));
      ctx.fillStyle = colour;
      for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        ctx.fillRect(sx > 0 ? cx : cx - arm, sy > 0 ? cy : cy - d, arm, d);
        ctx.fillRect(sx > 0 ? cx : cx - d, sy > 0 ? cy : cy - arm, d, arm);
      }
    }
  }

  // ---- names ----

  const nameSprites = new Map();
  /** Text is a texture of its own, cut once for the page's type size, so it lands on whole pixels at any zoom and in any gesture. Bounded. */
  function nameSprite(text, colour, plate) {
    const key = (plate ? '#' : '') + colour + text;
    let c = nameSprites.get(key);
    if (c) return c;
    if (nameSprites.size >= 1024) nameSprites.clear();
    c = document.createElement('canvas');
    const g = c.getContext('2d');
    const font = `500 ${12 * DPR}px Mono, monospace`, pad = plate ? Math.round(3 * DPR) : 0;
    g.font = font;
    c.width = Math.ceil(g.measureText(text).width) + 2 * pad + (plate ? 0 : 2);
    c.height = Math.round((plate ? 15 : 14) * DPR);
    if (plate) { g.fillStyle = INK.void; g.fillRect(0, 0, c.width, c.height); }
    g.font = font;
    g.textBaseline = 'alphabetic';
    g.fillStyle = colour;
    g.fillText(text, pad, Math.round((plate ? 11.5 : 11) * DPR));
    nameSprites.set(key, c);
    return c;
  }

  /**
   * A name sits in the top left of its room, on one row with every other name, so it can never be read as the next room's. If a
   * source, mineral or controller is under it at the smallest scale a name shows at, the name stands further along that row, at
   * a tile of its own: anchored to the world like any label on a map, so nothing hops while the map zooms.
   */
  function nameAlong(room) {
    if (room.nameTile !== undefined) return room.nameTile;
    const w = (room.name.length * 7.3 + 4) / 1.28, h = 14 / 1.28, far = Math.max(0, N - w - 6);
    const clear = at => !room.statics.some(o => o.x + 2 > at && o.x - 2 < at + w && o.y - 2 < h);
    for (const at of [0, Math.round(far / 2), Math.round(far)]) if (clear(at)) return room.nameTile = at;
    return room.nameTile = 0;
  }

  function drawNames(x0, x1, y0, y1, gone) {
    const pad = Math.round(4 * DPR), loud = printOf(cam.scale) > 0.28;
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const room = rooms.get(nameAt(wx, wy));
        if (!room || gone(room)) continue;
        const [x, y] = roomSquare(room), held = printed.get(room);
        // on a loud print the name stands on a black plate in the holder's colour, as the controller's level does, and in the corner
        if (held && loud) ctx.drawImage(nameSprite(room.name, held, true), x + pad, y + pad);
        else ctx.drawImage(nameSprite(room.name, INK.ink3, false), x + (held ? 0 : Math.round(nameAlong(room) * S)) + pad, y + pad);
      }
    }
  }

  // ---- what is in the rooms ----

  /** Far out: every object a point, collected per colour and filled in one batch. What is here comes from the map views, because far out the whole map is on screen. */
  function roomPoints(room, lod) {
    const ox = room.wx * N, oy = room.wy * N;
    const units = view?.rooms[room.name];
    if (!units) return;
    for (const key in units) {
      const tiles = units[key];
      if (key === 'pb' || key === 'p' || key === '2' || key === '3') {
        const mark = key === 'pb' ? MARK.powerBank : key === 'p' ? MARK.portal : MARK.npc;
        for (let i = 0; i < tiles.length; i++) point(lod, mark, ox + tiles[i][0] + 0.5, oy + tiles[i][1] + 0.5);
        continue;
      }
      if (!OWNER_HUE.has(key)) continue;
      const mark = creepMarkFar(key);
      // a black key under each, so a creep stands out on its own owner's print
      for (let i = 0; i < tiles.length; i++) point(lod, MARK.keyFar, ox + tiles[i][0] + 0.5, oy + tiles[i][1] + 0.5);
      for (let i = 0; i < tiles.length; i++) point(lod, mark, ox + tiles[i][0] + 0.5, oy + tiles[i][1] + 0.5);
    }
  }

  /** A creep glides between the states that arrive instead of teleporting. */
  function ease(list) {
    for (const o of list) {
      o._dx += (o.x - o._dx) * 0.34;
      o._dy += (o.y - o._dy) * 0.34;
      if (Math.abs(o.x - o._dx) < 0.003) o._dx = o.x;
      if (Math.abs(o.y - o._dy) < 0.003) o._dy = o.y;
    }
  }

  function roomObjects(room) {
    const ox = room.wx * N, oy = room.wy * N;
    const list = room.list ?? room.statics;
    if (room.list) ease(list);
    if (room.roads.size) drawRoads(list, room.roads, ox, oy);
    drawWalls(list, room.terrain, ox, oy);
    for (const o of list) if (o.type !== 'road') drawObj(o, ox, oy, list);
    drawRamparts(list, ox, oy);
    return list.length;
  }

  /** Puts S, OX and OY on the camera: once a frame, and for anyone who asks where something is between frames. */
  function aim() {
    S = cam.scale * DPR;
    OX = Math.round((W / 2 - cam.cx * cam.scale) * DPR);
    OY = Math.round((H / 2 - cam.cy * cam.scale) * DPR);
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = INK.void;
    ctx.fillRect(0, 0, W * DPR, H * DPR);
    if (!world) { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); return; }
    const side = N * cam.scale;
    aim();
    const now = performance.now();
    if (S !== scaleSeen) { scaleSeen = S; scaleAt = now; settleUntil = Math.max(settleUntil, now + SETTLE_MS + 40); }
    rest = now - scaleAt >= SETTLE_MS;
    useScale(rest);
    const px = cam.scale;
    const bare = !!mode?.solid;

    const x0 = Math.max(world.x0, Math.floor(s2wx(0) / N)), x1 = Math.min(world.x0 + world.cols - 1, Math.floor(s2wx(W) / N));
    const y0 = Math.max(world.y0, Math.floor(s2wy(0) / N)), y1 = Math.min(world.y0 + world.rows - 1, Math.floor(s2wy(H) / N));

    const [bx, by, bw, bh] = [Math.round(world.x0 * N * S) + OX, Math.round(world.y0 * N * S) + OY, Math.round(world.cols * N * S), Math.round(world.rows * N * S)];
    ctx.fillStyle = INK.plain;
    ctx.fillRect(bx, by, bw, bh);
    holdings();
    if (!bare) drawSheets(px);
    drawTerrain((side < LOD_PX ? STAMPED : 0) | (bare ? BARE : 0));
    const gone = room => !room || (mode?.solid && mode.dim(room));
    if (!bare) drawClaimCorners();

    const lod = side < LOD_PX ? new Map() : null;
    drawn = { rooms: (x1 - x0 + 1) * (y1 - y0 + 1), objects: 0 };
    if (side < LOD_PX) {
      // only rooms with someone in them have anything left to place
      for (const name of active) {
        const room = rooms.get(name);
        if (!room || room.wx < x0 || room.wx > x1 || room.wy < y0 || room.wy > y1 || gone(room)) continue;
        roomPoints(room, lod);
      }
    } else {
      // render.js draws in CSS pixels, as the game's recipes were written
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      for (let wy = y0; wy <= y1; wy++) {
        for (let wx = x0; wx <= x1; wx++) {
          const room = rooms.get(nameAt(wx, wy));
          if (gone(room)) continue;
          drawn.objects += roomObjects(room);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (lod) flushPoints(lod);
    // names go over what stands in the rooms, on whole pixels, so a road never crosses a letter
    if (!bare && side >= NAME_PX) drawNames(x0, x1, y0, y1, gone);
    if (mask) {
      ctx.imageSmoothingEnabled = false;
      // solid rules close over the rest of the world as the camera lands, so the flight still shows where it left from
      ctx.globalAlpha = mode.solid ? DIM + (1 - DIM) * (flight ? flight.at : 1) : DIM;
      ctx.drawImage(mask, bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    mode?.overlay?.(ctx);
  }

  /**
   * Nothing is drawn until something changed. A match usually runs on the same machine as whoever is watching it, and a
   * picture that has not changed is not worth a single tick. `settle` keeps frames coming that long for what eases on its own.
   */
  function changed(settle = 0) {
    stale = true;
    settleUntil = Math.max(settleUntil, performance.now() + settle);
  }

  /** The frame callback is the only thing that schedules the next one, so one bad frame must not end them all. */
  function frame(now) {
    if (!shown) { looping = false; return; }
    try {
      // a window dragged to a screen of another scale can keep its size, so the observer never hears of it
      if (devicePixelRatio !== ratio) resize();
      if (flight) stepFlight(now);
    } catch (e) {
      if (!failed) { failed = true; console.error('frame failed; continuing', e); }
    }
    // a picture drawn mid gesture is owed one more frame once the camera has settled, however slow the last frames were
    const loading = [...texImgs.values()].some(img => !img.complete);
    const due = stale || loading || now < settleUntil || (!rest && now - scaleAt >= SETTLE_MS);
    // Your hand on the map gets every frame; a picture easing by itself can wait
    if (due && innerWidth > 0 && (touched || now - drewAt >= PASSIVE_FRAME_MS)) {
      stale = false;
      touched = false;
      drewAt = now;
      try {
        draw();
        afterDraw?.();
      } catch (e) {
        if (!failed) { failed = true; console.error('draw failed; continuing', e); }
      }
    }
    // Terrain is built between frames and only while there is terrain to build, so a still map costs nothing
    if (world && (jobs.length || !baseJobs || baseJobs.length)) {
      try { if (buildTerrain()) stale = true; } catch (e) { if (!failed) { failed = true; console.error('terrain failed; continuing', e); } }
    }
    requestAnimationFrame(frame);
  }

  let ratio = 0;
  function resize() {
    const was = DPR;
    ratio = devicePixelRatio;
    DPR = Math.min(2, ratio || 1);
    if (DPR !== was) { resetTerrain(); forgetSprites(); nameSprites.clear(); }
    const box = canvas.parentElement.getBoundingClientRect();
    W = box.width; H = box.height;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (world) cam.min = wholeView().scale * 0.8;
    if (home && !flight) Object.assign(cam, home());
    changed();
  }

  function show(on) {
    if (on === shown) return;
    shown = on;
    if (!on) return;
    if (!looping) { looping = true; requestAnimationFrame(frame); }
    resize();
  }

  // ---- the camera ----

  /** The world stays in reach: no dragging it off into the dark. */
  function clampCamera() {
    cam.cx = Math.max(world.x0 * N, Math.min((world.x0 + world.cols) * N, cam.cx));
    cam.cy = Math.max(world.y0 * N, Math.min((world.y0 + world.rows) * N, cam.cy));
  }

  /** The whole world in view. */
  function wholeView() {
    const w = world.cols * N, h = world.rows * N;
    return { cx: world.x0 * N + w / 2, cy: world.y0 * N + h / 2, scale: Math.min(W / w, H / h) * 0.98 };
  }

  /** One room filling the view. */
  function roomView(name) {
    const room = rooms.get(name);
    return { cx: room.wx * N + N / 2, cy: room.wy * N + N / 2, scale: Math.min(cam.max, Math.min(W, H) / (N * ROOM_MARGIN)) };
  }

  /** Puts the whole world in view at once, and no further out than a little past that. */
  function fit() {
    endFlight();
    home = wholeView;
    Object.assign(cam, wholeView());
    cam.min = cam.scale * 0.8;
    changed();
  }

  /** Puts one room in view at once. */
  function focus(name) {
    endFlight();
    home = () => roomView(name);
    Object.assign(cam, home());
    changed();
  }

  /** The path between two views as [cx, cy, width] for t from 0 to 1, from van Wijk and Nuij's paper. */
  function zoomPath(from, to) {
    const rho2 = FLIGHT_RHO * FLIGHT_RHO, rho4 = rho2 * rho2;
    const { cx: x0, cy: y0 } = from, w0 = W / from.scale, w1 = W / to.scale;
    const dx = to.cx - x0, dy = to.cy - y0, d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      const span = Math.log(w1 / w0);
      return t => [x0, y0, w0 * Math.exp(span * t)];
    }
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    return t => {
      const r = r0 + (r1 - r0) * t;
      const u = (w0 / (rho2 * d)) * (Math.cosh(r0) * Math.tanh(r) - Math.sinh(r0));
      return [x0 + u * dx, y0 + u * dy, (w0 * Math.cosh(r0)) / Math.cosh(r)];
    };
  }

  /** Flies to one room, or to the whole world. Any input ends it on the spot, because the camera is the player's. `done` runs either way. */
  function fly(name, done) {
    endFlight();
    home = name ? () => roomView(name) : wholeView;
    const to = home();
    if (document.documentElement.hasAttribute('data-calm')) {
      Object.assign(cam, to);
      canvas.animate([{ opacity: 0 }, { opacity: 1 }], 160);
      changed();
      done?.();
      return;
    }
    flight = { path: zoomPath(cam, to), start: performance.now(), done, at: 0 };
    changed();
  }

  function stepFlight(now) {
    const t = Math.min(1, (now - flight.start) / FLIGHT_MS);
    // the ease is on progress along the path, so it leaves and lands gently whatever the distance
    flight.at = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const [cx, cy, w] = flight.path(flight.at);
    cam.cx = cx; cam.cy = cy; cam.scale = W / w;
    touched = true;
    changed();
    if (t >= 1) endFlight();
  }

  function endFlight() {
    if (!flight) return;
    const { done } = flight;
    flight = null;
    changed();
    done?.();
  }

  /** Switches to a set of rules: `dim(room)`, `solid`, `overlay(ctx)`, `hover(room, x, y)`, `tap(room, x, y)`, `sheets()`. */
  function use(next) {
    if (next === mode) return false;
    mode = next;
    buildMask();
    changed();
    return true;
  }

  function bind() {
    const pts = new Map();
    let pinch = 0, moved = 0;
    const at = e => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const held = () => { endFlight(); touched = true; changed(); };
    const zoomAt = (f, sx, sy) => {
      held();
      const bx = s2wx(sx), by = s2wy(sy);
      home = null;
      cam.scale = Math.max(cam.min, Math.min(cam.max, cam.scale * f));
      cam.cx += bx - s2wx(sx);
      cam.cy += by - s2wy(sy);
      clampCamera();
    };
    const spread = () => {
      if (pts.size !== 2) return 0;
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const under = ({ x, y }) => {
      const wx = s2wx(x), wy = s2wy(y), rx = Math.floor(wx / N), ry = Math.floor(wy / N);
      return [rooms.get(nameAt(rx, ry)) ?? null, Math.floor(wx) - rx * N, Math.floor(wy) - ry * N];
    };

    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('selectstart', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      if (e.pointerType !== 'mouse') e.preventDefault();
      endFlight();
      // Capture so a drag that leaves the canvas still pans it. A pointer already gone has nothing to capture and throws.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ }
      pts.set(e.pointerId, at(e));
      pinch = spread();
      moved = 0;
    });
    canvas.addEventListener('pointermove', e => {
      if (!world) return;
      const now = at(e);
      if (!pts.has(e.pointerId)) {
        if (!e.buttons && mode?.hover) {
          mode.hover(...under(now));
          touched = true;
          changed();
        }
        return;
      }
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, now);
      if (pts.size === 1) {
        held();
        home = null;
        cam.cx -= (now.x - prev.x) / cam.scale;
        cam.cy -= (now.y - prev.y) / cam.scale;
        clampCamera();
        moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = spread();
        if (pinch > 0) zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
        moved += 6;
      }
    });
    const release = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; };
    // A pointer that went down and up without travelling is a tap, not a drag.
    canvas.addEventListener('pointerup', e => {
      if (e.button === 2) return;
      const tap = moved < 6 && pts.has(e.pointerId);
      const where = at(e);
      release(e);
      if (tap && world) mode?.tap?.(...under(where));
      held();
    });
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => { mode?.hover?.(null, 0, 0); changed(); });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (!world) return;
      const { x, y } = at(e);
      zoomAt(Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0016), x, y);
    }, { passive: false });
    new ResizeObserver(() => { if (shown) resize(); }).observe(canvas.parentElement);
  }

  // ---- a match in play ----

  /** Who owns what colour: [{ id, color }], colours as #rrggbb. */
  function players(list) {
    for (const p of list) OWNER_HUE.set(p.id, p.color);
  }

  /** The match's overview, a few a second at most: where everyone is, and the clock. */
  function live(overview) {
    view = overview;
    T = overview.tick;
    active = new Set([...Object.keys(overview.rooms), ...overview.owned.map(o => o[0]), ...overview.reserved.map(o => o[0])]);
    // Nobody is there any more, so what was last seen there is not what is there
    for (const room of listed) {
      if (active.has(room.name)) continue;
      room.list = null;
      room.roads = NO_ROADS;
      listed.delete(room);
    }
    for (const room of claims) room.owner = room.reserved = null;
    claims.clear();
    for (const [name, uid] of overview.owned) {
      const room = rooms.get(name);
      if (room) { room.owner = uid; claims.add(room); }
    }
    for (const [name, uid] of overview.reserved) {
      const room = rooms.get(name);
      if (room) { room.reserved = uid; claims.add(room); }
    }
    changed();
  }

  /** Rooms worth asking the match for: on screen, close enough to draw, with someone in them. */
  function wanted() {
    if (!world || !view || N * cam.scale < LOD_PX) return [];
    const x0 = Math.floor(s2wx(0) / N), x1 = Math.floor(s2wx(W) / N), y0 = Math.floor(s2wy(0) / N), y1 = Math.floor(s2wy(H) / N);
    return [...active].filter(name => {
      const { wx, wy } = parseName(name);
      return wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1;
    });
  }

  /** The objects of some rooms, as the world holds them. */
  function objects(reply) {
    T = reply.tick;
    for (const [name, list] of Object.entries(reply.rooms)) {
      const room = rooms.get(name);
      if (!room) continue;
      const before = new Map((room.list ?? []).map(o => [o._id, o]));
      for (const o of list) {
        const old = before.get(o._id);
        o._dx = old ? old._dx : o.x;
        o._dy = old ? old._dy : o.y;
        if (old?._ta != null) o._ta = old._ta;
        if (old?._fa != null) o._fa = old._fa;
        if (old?._spin != null) o._spin = old._spin;
      }
      room.list = list.sort((a, b) => (Z[a.type] || 12) - (Z[b.type] || 12));
      listed.add(room);
      room.roads = new Set(list.filter(o => o.type === 'road').map(o => `${o.x},${o.y}`));
    }
    changed(EASE_MS);
  }

  bind();
  // Names and letters are cut as textures, so what was cut before the face arrived is cut again once it has
  if (document.fonts?.status !== 'loaded') document.fonts?.ready.then(() => { nameSprites.clear(); if (world) { forgetSprites(); changed(); } });

  return {
    load, show, use, fit, focus, fly, players, live, wanted, objects, changed,
    rules: () => mode,
    flying: () => !!flight,
    /** `fn` runs after every frame drawn, so what lies over the map lands on the frame the camera moved in. */
    after(fn) { afterDraw = fn; },
    /** 0 plain, 1 wall, 2 swamp, 3 a wall too. */
    terrainAt(name, x, y) {
      const terrain = rooms.get(name)?.terrain;
      return terrain ? (terrain.charCodeAt(y * N + x) - 48) & 3 : 1;
    },
    /** What the map knows of a room: { sources, mineral, plain, swamp }, the last two in percent. */
    facts(name) {
      const room = rooms.get(name);
      if (!room) return null;
      if (!room.facts) {
        let plain = 0, swamp = 0;
        for (let t = 0; t < room.terrain.length; t++) {
          const c = (room.terrain.charCodeAt(t) - 48) & 3;
          if (c === 0) plain++;
          else if (c === 2) swamp++;
        }
        const has = type => room.statics.filter(o => o.type === type).length;
        room.facts = { sources: has('source'), mineral: has('mineral') > 0, plain: Math.round(plain / 25), swamp: Math.round(swamp / 25) };
      }
      return room.facts;
    },
    /** Where a room is on screen: [left, top, side]. */
    roomBox(name) {
      const room = rooms.get(name);
      aim();
      return [w2sx(room.wx * N), w2sy(room.wy * N), N * cam.scale];
    },
    /** Where one tile of a room is on screen: [left, top, side]. */
    tileBox(name, x, y) {
      const room = rooms.get(name);
      aim();
      return [w2sx(room.wx * N + x), w2sy(room.wy * N + y), cam.scale];
    },
    stats: () => ({ ...drawn, side: N * cam.scale }),
  };
})();
