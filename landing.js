// The landing page: a rail, a stage and a panel. It draws what /api/lobbies says, once a second, and every action answers
// with the same reply. It runs in a frame on this server, and the client hands it the token it holds for this server.
//
// One bracket is the idea: it closes in on one player's decision, from a seat to a room to a tile, and shuts green each time
// they commit. It follows clicks and never waits for itself, and every screen keeps its one step in the same slot.
import { deployBody, isZip, resolveBot, treeFromDrop, treeFromFileList, treeFromZip } from '/assets/resolve.mjs';

const $ = id => document.getElementById(id);
const root = document.documentElement;

/** The logo in the rail's first module. Change this one word to see the other. It stays still: the rail and the bracket say what it used to. */
const MARK = 'seal';
const MARKS = {
  seal: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"><mask id="krebs-seal" maskUnits="userSpaceOnUse" x="-50" y="-50" width="100" height="100"><circle r="50" fill="#fff"/><g fill="#000"><path d="M-27 0.5A38.636 38.636 0 0 1 27 0.5A49.563 49.563 0 0 1 19.186 4.636A19.261 19.261 0 0 1 19.141 5.077A112.742 112.742 0 0 1 41.249 10.237A42.5 42.5 0 0 1 38.807 17.328A105.242 105.242 0 0 0 17.02 12.372A121.687 121.687 0 0 1 34.41 24.944A42.5 42.5 0 0 1 29.49 30.604A114.187 114.187 0 0 0 12.1 18.178A177.813 177.813 0 0 1 22.561 36.018A42.5 42.5 0 0 1 15.878 39.423A170.313 170.313 0 0 0 5.27 21.462A19.261 19.261 0 0 1 -5.27 21.462A170.313 170.313 0 0 0 -15.878 39.423A42.5 42.5 0 0 1 -22.561 36.018A177.813 177.813 0 0 1 -12.1 18.178A114.187 114.187 0 0 0 -29.49 30.604A42.5 42.5 0 0 1 -34.41 24.944A121.687 121.687 0 0 1 -17.02 12.372A105.242 105.242 0 0 0 -38.807 17.328A42.5 42.5 0 0 1 -41.249 10.237A112.742 112.742 0 0 1 -19.141 5.077A19.261 19.261 0 0 1 -19.186 4.636A49.563 49.563 0 0 1 -27 0.5Z"/><path d="M1.358 9.172A24 24 0 0 0 36.027 -19.495A31 31 0 0 0 24.934 -34.417A42.5 42.5 0 0 0 13.133 -40.42A58.601 58.601 0 0 1 22.215 -18.641A40.468 40.468 0 0 1 7.198 -31.18A25.99 25.99 0 0 0 29.169 -6.894A16.5 16.5 0 0 1 5.108 2.677L1.358 9.172Z"/><path d="M-1.358 9.172A24 24 0 0 1 -36.027 -19.495A31 31 0 0 1 -24.934 -34.417A42.5 42.5 0 0 1 -13.133 -40.42A58.601 58.601 0 0 0 -22.215 -18.641A40.468 40.468 0 0 0 -7.198 -31.18A25.99 25.99 0 0 1 -29.169 -6.894A16.5 16.5 0 0 0 -5.108 2.677L-1.358 9.172Z"/></g></mask><rect x="-50" y="-50" width="100" height="100" mask="url(#krebs-seal)"/></svg>',
  crab: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" fill="currentColor"><path d="M-26.199 6.473A40.585 40.585 0 0 1 26.199 6.473A27.001 27.001 0 0 1 -26.199 6.473Z"/><path d="M-42.682 -13.471A29.381 29.381 0 0 1 -32.95 -14.566A40.756 40.756 0 0 0 -10.713 -30.065A24.454 24.454 0 0 1 -22.284 -2.173A45.476 45.476 0 0 0 -31.534 4.703A27.51 27.51 0 0 1 -42.682 -13.471Z"/><path d="M-10.713 -44.737A28.529 28.529 0 0 0 -32.95 -14.566A6.072 6.072 0 0 1 -42.47 -12.267A27.51 27.51 0 0 1 -10.713 -44.737Z"/><path d="M42.682 -13.471A27.51 27.51 0 0 1 31.534 4.703A45.476 45.476 0 0 0 22.284 -2.173A24.454 24.454 0 0 1 10.713 -30.065A40.756 40.756 0 0 0 32.95 -14.566A29.381 29.381 0 0 1 42.682 -13.471Z"/><path d="M10.713 -44.737A27.51 27.51 0 0 1 42.47 -12.267A6.072 6.072 0 0 1 32.95 -14.566A28.529 28.529 0 0 0 10.713 -44.737Z"/><path d="M-30.435 9.469A31.892 31.892 0 0 0 -26.356 17.897A61.134 61.134 0 0 0 -48.5 15.535A22.416 22.416 0 0 1 -30.435 9.469Z"/><path d="M-23.304 21.713A31.892 31.892 0 0 0 -15.977 27.542A61.134 61.134 0 0 0 -36.958 35.006A22.416 22.416 0 0 1 -23.304 21.713Z"/><path d="M-11.573 29.659A31.892 31.892 0 0 0 -2.443 31.739A61.134 61.134 0 0 0 -18.12 47.555A22.416 22.416 0 0 1 -11.573 29.659Z"/><path d="M30.435 9.469A22.416 22.416 0 0 1 48.5 15.535A61.134 61.134 0 0 0 26.356 17.897A31.892 31.892 0 0 0 30.435 9.469Z"/><path d="M23.304 21.713A22.416 22.416 0 0 1 36.958 35.006A61.134 61.134 0 0 0 15.977 27.542A31.892 31.892 0 0 0 23.304 21.713Z"/><path d="M11.573 29.659A22.416 22.416 0 0 1 18.12 47.555A61.134 61.134 0 0 0 2.443 31.739A31.892 31.892 0 0 0 11.573 29.659Z"/></svg>',
};
$('mark').innerHTML = MARKS[MARK];

/**
 * A lobby's phase mark: the game's own shapes, a creep's circle, a room's square, a controller's octagon. Each is the same
 * number of points, so any one of them morphs into any other with a `clip-path` transition.
 */
const SHAPE_POINTS = 48;

function shape(sides, turn = 0, reach = 1) {
  const points = [];
  for (let i = 0; i < SHAPE_POINTS; i++) {
    const a = (i / SHAPE_POINTS) * Math.PI * 2 - Math.PI / 2;
    // how far out a regular polygon's edge is at this angle
    const wedge = (Math.PI * 2) / (sides || 1);
    const r = sides ? Math.cos(wedge / 2) / Math.cos(((a - turn + Math.PI * 4) % wedge) - wedge / 2) : 1;
    points.push(`${(50 + Math.cos(a) * r * 50 * reach).toFixed(2)}% ${(50 + Math.sin(a) * r * 50 * reach).toFixed(2)}%`);
  }
  return `polygon(${points.join(',')})`;
}

const SHAPES = {
  circle: shape(0),
  square: shape(4, Math.PI / 4, Math.SQRT1_2),
  diamond: shape(4),
  octagon: shape(8, Math.PI / 8),
  hexagon: shape(6),
  triangle: shape(3, -Math.PI / 2, 0.9),
};
for (const [name, value] of Object.entries(SHAPES)) root.style.setProperty(`--s-${name}`, value);

/** The paper: a still tile, half black and half white per pixel, at one constant alpha. It only ever lies on the sheets. */
const GRAIN_ALPHA = 0.03;

function makeGrain() {
  const size = 512, tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const g = tile.getContext('2d'), img = g.createImageData(size, size), alpha = Math.round(255 * GRAIN_ALPHA);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.random() < 0.5 ? 0 : 255;
    img.data[i + 3] = alpha;
  }
  g.putImageData(img, 0, 0);
  root.style.setProperty('--grain', `url(${tile.toDataURL('image/png')})`);
}

makeGrain();

const SEATS = 8;
const COUNTDOWN_MS = 15000;
/** How often the rooms on screen are asked for. */
const ROOMS_MS = 250;
const LEAVE_HOLD_MS = 1000;
const STOP_HOLD_MS = 1500;
/** How long a press too short to count keeps saying so. */
const HOLD_WORD_MS = 1200;
/** Leaving tells the server, and never waits on it longer than this. */
const LEAVE_WAIT_MS = 300;
const CROSS_MS = 800;
const FLIP_MS = 360;
const LIST_OUT_MS = 120;
const ROW_FLIP_MS = 200;
const RANK_MS = 240;
const FLOOD_RISE_MS = 280;
const FLOOD_BACK_MS = 150;
const TILE_FILL_MS = 120;
const PIN_LAND_MS = 200;
const SEAT_OUT_MS = 150;
/** A poll or an overview that takes longer than this has failed: a dead server can hold a connection open for good. */
const POLL_WAIT_MS = 2000;
const ACT_WAIT_MS = 15000;
const MAP_WAIT_MS = 15000;
/** A mono caption's advance: .6em and .06em of tracking. */
const MONO_ADVANCE = 0.66;
const SIGNED_OUT = 'Signed out. Leave the server and connect again.';
const CREAM = '#F2EBDD', GO = '#58D694', BLACK = '#000000';

const style = getComputedStyle(root);
const OUT = style.getPropertyValue('--out').trim(), MOVE = style.getPropertyValue('--move').trim();
/** A size from the current band. */
const px = name => parseFloat(style.getPropertyValue(name));

/** The page's --move on a clock of its own, so what the canvas draws eases as the sheets do. */
const fillCurve = new KeyframeEffect(null, null, { duration: TILE_FILL_MS, easing: MOVE, fill: 'both' });
const fillClock = new Animation(fillCurve);

function filled(ms) {
  fillClock.currentTime = ms;
  return fillCurve.getComputedTiming().progress;
}

// ---- settings ----

const PREFS_KEY = 'krebs.prefs';
const prefs = { animations: true, avatars: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { /* a private window, or nothing saved */ }
const lessMotion = matchMedia('(prefers-reduced-motion: reduce)');

function applyMotion() {
  root.toggleAttribute('data-calm', lessMotion.matches || !prefs.animations);
}

const calm = () => root.hasAttribute('data-calm');

/** Whether the keyboard was the last hand on the page. What it starts lands at once. */
const keys = () => root.hasAttribute('data-keys');

addEventListener('keydown', () => root.setAttribute('data-keys', ''), true);
addEventListener('pointerdown', () => root.removeAttribute('data-keys'), true);
addEventListener('pointermove', () => { if (keys()) root.removeAttribute('data-keys'); }, true);

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* it just won't be remembered */ }
}

function paintPrefs() {
  $('set-anim').firstChild.textContent = `Animations ${prefs.animations ? 'on' : 'off'}`;
  $('set-move').firstChild.textContent = `Avatars ${prefs.avatars ? 'move' : 'still'}`;
}

// ---- talking to the server ----

let token = null;
let last = null;
let busy = 0;
/** Counts actions, so a poll sent before one can tell its answer is older than the action's. */
let acted = 0;

async function call(method, path, body, wait) {
  const headers = token ? { 'X-Token': token, 'X-Username': token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/lobbies${path}`, { method, headers, body, signal: wait ? AbortSignal.timeout(wait) : undefined });
  const fresh = res.headers.get('X-Token');
  if (fresh) token = fresh;
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
}

const get = async (path, wait) => (await call('GET', path, undefined, wait)).json();

/** An error is a cream plate and a word. */
function say(note, words) {
  note.textContent = words;
  note.classList.toggle('on', !!words);
}

/** An action. Its reply is a full poll, or a reason to show in `note`. Says whether it went through. */
async function act(path, body, note) {
  busy++;
  acted++;
  let data = null;
  try {
    data = await (await call('POST', path, body === undefined ? undefined : JSON.stringify(body), ACT_WAIT_MS)).json();
    say(note, data.error ?? '');
  } catch {
    say(note, "That didn't work. Try again.");
  }
  const ok = !!data && !data.error;
  if (ok) await paint(data);
  busy--;
  return ok;
}

// ---- small things ----

function text(tag, value, cls) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (cls) node.className = cls;
  return node;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

/** A figure in fixed boxes: writes only the digits that changed, and never animates. */
function digits(node, value) {
  const figures = String(value);
  while (node.children.length < figures.length) node.append(document.createElement('i'));
  while (node.children.length > figures.length) node.lastChild.remove();
  [...figures].forEach((figure, i) => setText(node.children[i], figure));
}

/**
 * Big Shoulders covers Latin and Latin Extended, except the Vietnamese block, which the shipped files leave out. Anything
 * else sets in Inter, a little smaller, with no change of case.
 */
const LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u;
const VIETNAMESE = /[\u1EA0-\u1EF1]/;

function setName(node, name) {
  if (node.dataset.name === name) return;
  node.dataset.name = name;
  node.textContent = name;
  node.classList.toggle('alien', !LATIN.test(name) || VIETNAMESE.test(name));
}

/**
 * A name too long for its box, cut by hand: the browser's ellipsis leaves the box as wide as ever, and what stands after
 * the name has to stand against its last letter.
 */
function cutName(node) {
  const letters = [...node.dataset.name], upTo = n => `${letters.slice(0, n).join('').trimEnd()}\u2026`;
  let fits = 0, over = letters.length;
  while (fits + 1 < over) {
    const mid = (fits + over) >> 1;
    node.textContent = upTo(mid);
    if (node.scrollWidth > node.clientWidth) over = mid;
    else fits = mid;
  }
  node.textContent = upTo(fits);
}

const initial = name => [...name][0] ?? '';

const seatOf = lobby => lobby?.seats.find(s => s.you) ?? null;
const myRoom = () => seatOf(last?.lobby)?.room ?? null;
const pad2 = n => String(n).padStart(2, '0');
/** A seat you could still take. `joinable` alone is true of every running match too, for watching. */
const seatOpen = l => l.joinable && l.phase !== 'running';
const kilo = n => (n < 1000 ? `${n}` : n < 1000000 ? `${Math.floor(n / 1000)}K` : '1M');
const hostIsMe = lobby => !!lobby?.seats[0]?.you;

// ---- faces ----

const images = new Map();

/** A picture, loaded once however many places show it. */
function loadImage(url) {
  if (!images.has(url)) {
    images.set(url, new Promise(done => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    }));
  }
  return images.get(url);
}

const STILL_PX = 184;

/**
 * A picture's first frame, drawn once, for where nothing may move: every map screen, and the setting. It is drawn
 * at the size it shows at, because a large canvas shrunk by the page speckles thin lines.
 */
function still(url, cls) {
  const canvas = document.createElement('canvas');
  canvas.className = cls;
  loadImage(url).then(img => {
    if (!img) return;
    const side = Math.round((canvas.clientWidth || STILL_PX) * devicePixelRatio), g = canvas.getContext('2d');
    canvas.width = canvas.height = side;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, side, side);
  });
  return canvas;
}

function moving(url, cls) {
  const img = new Image();
  img.className = cls;
  img.alt = '';
  img.src = url;
  return img;
}

/** Puts a seat's picture in a box, moving if that is allowed. Someone with no picture is a cream plate and an initial. */
function picture(box, seat, live) {
  const moves = live && prefs.avatars && !calm(), said = JSON.stringify([seat.avatar, seat.frame, seat.name, moves]);
  if (box.dataset.said === said) return;
  box.dataset.said = said;
  const make = moves ? moving : still;
  box.replaceChildren(seat.avatar ? make(seat.avatar, 'face') : text('span', initial(seat.name), 'initial'));
  if (seat.frame) box.append(make(seat.frame, 'frame'));
}

function face(seat, live, cls) {
  const box = document.createElement('div');
  box.className = cls ? `avatar ${cls}` : 'avatar';
  box.dataset.name = seat.name;
  box.title = seat.name;
  picture(box, seat, live);
  return box;
}

const PIN_PX = 64;
const pins = new Map();

/** A seat's still for the map overlay. */
function pinOf(seat) {
  const key = seat.avatar ?? `:${seat.name}`;
  if (pins.has(key)) return pins.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PIN_PX;
  const g = canvas.getContext('2d');
  g.fillStyle = CREAM;
  g.fillRect(0, 0, PIN_PX, PIN_PX);
  g.fillStyle = BLACK;
  g.font = `700 ${PIN_PX * 0.6}px Display, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initial(seat.name).toUpperCase(), PIN_PX / 2, PIN_PX / 2);
  if (seat.avatar) {
    loadImage(seat.avatar).then(img => {
      if (!img) return;
      g.drawImage(img, 0, 0, PIN_PX, PIN_PX);
      worldMap.changed();
    });
  }
  pins.set(key, canvas);
  return canvas;
}

// ---- the bracket ----

/** Where your decision is. `want` is { kind: 'name' | 'room' | 'tile', room, tile, shut }, read fresh from where the thing is now. */
const bracket = (() => {
  const el = $('bracket');
  const corners = ['tl', 'tr', 'bl', 'br'].map(name => {
    const box = el.querySelector(`.${name}`);
    return { box, h: box.querySelector('.h'), v: box.querySelector('.v') };
  });
  let aim = null, at = null;

  function draw({ x, y, w, h }, arm, shut) {
    const across = shut ? w / 2 + 0.5 : Math.min(arm, w / 2), down = shut ? h / 2 + 0.5 : Math.min(arm, h / 2);
    const spots = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    corners.forEach((corner, i) => {
      corner.box.style.transform = `translate(${spots[i][0]}px, ${spots[i][1]}px)`;
      corner.h.style.transform = `scaleX(${across})`;
      corner.v.style.transform = `scaleY(${down})`;
    });
    el.classList.toggle('shut', shut);
  }

  function boxOf(want) {
    if (want.kind === 'name') return nameBox();
    if (!worldMap.rules()) return null;
    const [x, y, side] = want.kind === 'room' ? worldMap.roomBox(want.room) : worldMap.tileBox(want.room, ...want.tile);
    return { x, y, w: side, h: side };
  }

  /** Arms get shorter on small targets, down to 5 px at a tile. */
  function armFor(want, box) {
    const arm = px('--arm');
    return want.kind === 'tile' ? Math.max(5, Math.min(arm, box.w * 0.36)) : want.kind === 'room' ? Math.min(arm, box.w * 0.3) : arm;
  }

  const near = (a, b) => a && b && Math.abs(a.x - b.x) < 0.25 && Math.abs(a.y - b.y) < 0.25 && Math.abs(a.w - b.w) < 0.25 && Math.abs(a.h - b.h) < 0.25;
  const sameTarget = (a, b) => a?.kind === b?.kind && a?.room === b?.room && `${a?.tile}` === `${b?.tile}`;

  /** Which move this is: the table of them is in the page's stylesheet. */
  function moveTo(want) {
    if (!aim) return 'none';
    if (!sameTarget(aim, want)) return want.kind;
    return aim.shut === want.shut ? 'none' : want.shut ? 'shut' : 'open';
  }

  return {
    /** Lands on `want`, or goes if there is none. */
    set(want, how) {
      if (!want) {
        if (aim) el.hidden = true;
        aim = null;
        return;
      }
      const box = boxOf(want);
      if (!box || (sameTarget(aim, want) && aim.shut === want.shut && near(at, box))) return;
      el.dataset.t = keys() ? 'none' : how ?? moveTo(want);
      el.hidden = false;
      draw(box, armFor(want, box), want.shut);
      aim = want;
      at = box;
    },

    /** Starts at a rectangle on the page, open: born on the row you click. */
    born(rect) {
      const stage = $('stage').getBoundingClientRect();
      const box = { x: rect.left - stage.left - px('--b-x'), y: rect.top - stage.top - px('--b-y'), w: rect.width + px('--b-x') * 2, h: rect.height + px('--b-y') * 2 };
      el.dataset.t = 'none';
      el.hidden = false;
      draw(box, px('--arm'), false);
      el.getBoundingClientRect();
      aim = { kind: 'born' };
      at = box;
    },

    /** What sits on the map or a name moved: goes straight there. */
    follow() {
      if (!aim || aim.kind === 'born') return;
      const box = boxOf(aim);
      if (!box || near(at, box)) return;
      el.dataset.t = 'none';
      draw(box, armFor(aim, box), aim.shut);
      at = box;
    },

    /** Nothing is left to decide: it opens outward past the stage's edges and is gone. */
    leave() {
      if (!aim) return;
      aim = null;
      if (calm()) {
        el.hidden = true;
        return;
      }
      const stage = $('stage').getBoundingClientRect(), far = px('--arm') * 2;
      el.dataset.t = 'leave';
      draw({ x: -far, y: -far, w: stage.width + far * 2, h: stage.height + far * 2 }, px('--arm'), false);
      setTimeout(() => { if (!aim) el.hidden = true; }, 280);
    },
  };
})();

/** A rectangle round your own name: its cap box, and a margin that clears the seat number. */
let nameHovered = false;
const NAME_HOVER_SCALE = 1.06;

function nameBox() {
  const who = $('seats').querySelector('.seat.you .who');
  if (!who) return null;
  const stage = $('stage').getBoundingClientRect(), r = who.getBoundingClientRect(), k = nameHovered ? NAME_HOVER_SCALE : 1;
  const padX = px('--b-x'), padY = px('--b-y'), height = r.height * k;
  return { x: r.left - stage.left - padX, y: r.top - stage.top + (r.height - height) / 2 - padY, w: r.width * k + padX * 2, h: height + padY * 2 };
}

// ---- the lobby list ----

const rows = new Map();
const offScreen = new IntersectionObserver(entries => {
  for (const entry of entries) entry.target.classList.toggle('off', !entry.isIntersecting);
}, { root: $('lobbies') });

const PHASE_WORDS = { open: 'Open', preparing: 'Starting', picking: 'Picking', spawning: 'Spawning', finished: 'Finished' };

function phaseWord(l) {
  if (l.phase === 'countdown') return `Starting ${Math.ceil(l.leftMs / 1000)}`;
  if (l.phase === 'running') return `Running ${kilo(l.tick)}`;
  return PHASE_WORDS[l.phase];
}

function seatWord(l) {
  if (l.mine) return 'Rejoin';
  if (l.phase === 'running') return 'Watch';
  if (l.joinable) return 'Join';
  if (l.phase === 'finished') return 'Over';
  return l.players >= l.max ? 'Full' : 'Started';
}

function makeRow() {
  const el = document.createElement('li');
  el.className = 'lobby';
  const stack = document.createElement('div');
  stack.className = 'stack';
  const about = document.createElement('div');
  about.className = 'about';
  const state = document.createElement('div');
  state.className = 'state';
  const mark = document.createElement('i');
  mark.className = 'mark';
  const phase = text('span', '', 'cap');
  state.append(mark, phase);
  const name = text('b', '', 'name');
  about.append(state, name);
  const tally = document.createElement('div');
  tally.className = 'tally';
  const what = text('span', '', 'cap');
  const count = document.createElement('div');
  count.className = 'digits';
  tally.append(what, count);
  const join = text('span', '', 'join');
  el.append(stack, about, tally, join);
  const row = { el, stack, phase, name, what, count, join, faces: new Map(), frees: [], l: null, was: null };
  for (let i = 1; i < SEATS; i++) {
    const free = document.createElement('i');
    free.className = 'free';
    free.style.setProperty('--i', i);
    stack.append(free);
    row.frees[i] = free;
  }
  el.addEventListener('click', () => { if (row.l?.joinable) joinRow(row); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
  offScreen.observe(el);
  return row;
}

/** Everyone in a lobby: the host first and bigger, on top, and each arrival or departure on its own. */
function fillStack(row, seats) {
  const names = new Set(seats.map(s => s.name));
  for (const [name, box] of row.faces) {
    if (names.has(name)) continue;
    row.faces.delete(name);
    box.classList.add('going');
    setTimeout(() => box.remove(), 150);
  }
  seats.forEach((seat, i) => {
    let box = row.faces.get(seat.name);
    const arriving = !box;
    if (arriving) {
      box = face(seat, true);
      row.faces.set(seat.name, box);
      if (row.l) {
        box.style.scale = '0';
        row.stack.append(box);
        requestAnimationFrame(() => requestAnimationFrame(() => { box.style.scale = ''; }));
      } else {
        row.stack.append(box);
      }
    }
    box.classList.toggle('host', i === 0);
    box.style.setProperty('--i', i);
    box.style.setProperty('--size', i === 0 ? 'var(--host)' : 'var(--avatar)');
    picture(box, seat, true);
  });
  row.frees.forEach((free, i) => { free.hidden = i < seats.length; });
  row.stack.classList.toggle('packed', seats.length >= SEATS);
  // the room the others have once the host is clear of them, spread evenly
  const gaps = Math.max(1, seats.length - 2);
  row.stack.style.setProperty('--fan', `min(calc(var(--avatar) + 2px), calc((var(--stack) - var(--host) - 2px - var(--avatar)) / ${gaps}))`);
}

function fillRow(row, l) {
  const { el } = row;
  if (row.was !== l.phase) {
    if (row.was) el.classList.remove(row.was);
    el.classList.add(l.phase);
    row.was = l.phase;
  }
  el.classList.toggle('can', l.joinable);
  el.classList.toggle('dim', !l.joinable);
  if (l.joinable) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
  } else {
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
  }
  setText(row.phase, phaseWord(l));
  setName(row.name, l.name);
  const word = seatWord(l);
  setText(row.what, word);
  setText(row.join, word);
  el.classList.toggle('watch', word === 'Watch');
  // a count is two boxes and a slash, and an empty slash box would make it jump
  if (row.count.dataset.said !== `${l.players}/${l.max}`) {
    row.count.dataset.said = `${l.players}/${l.max}`;
    row.count.replaceChildren(text('i', `${l.players}`), text('b', '/'), text('i', `${l.max}`));
  }
  fillStack(row, l.seats ?? []);
  row.l = l;
}

/** Runs `change`, and slides every row it moved from where it was: one pass, however many changed. */
function flipRows(change) {
  const all = [...$('lobbies').children], before = new Map(all.map(el => [el, el.getBoundingClientRect().top]));
  change();
  if (calm()) return;
  for (const el of $('lobbies').children) {
    const was = before.get(el);
    if (was === undefined) continue;
    const moved = was - el.getBoundingClientRect().top;
    if (moved) el.animate([{ transform: `translateY(${moved}px)` }, { transform: 'none' }], { duration: ROW_FLIP_MS, easing: OUT });
  }
}

function removeRow(id, row) {
  rows.delete(id);
  offScreen.unobserve(row.el);
  row.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: OUT, fill: 'forwards' }).finished.then(() => flipRows(() => row.el.remove()));
}

function paintList(data) {
  // the list fills the stage, so only a row can be under the cursor
  const list = $('lobbies'), held = !!list.querySelector('li:hover');
  const live = new Set(data.lobbies.map(l => l.id));
  for (const [id, row] of rows) {
    if (live.has(id)) continue;
    // Rows under the cursor hold still: one that is gone stays put, unjoinable, until the pointer leaves
    if (held) {
      row.l = { ...row.l, joinable: false, mine: false, phase: 'finished' };
      fillRow(row, row.l);
    } else {
      removeRow(id, row);
    }
  }
  for (const l of data.lobbies) {
    let row = rows.get(l.id);
    if (!row) {
      row = makeRow();
      rows.set(l.id, row);
      fillRow(row, l);
      list.append(row.el);
      row.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: OUT });
    } else {
      fillRow(row, l);
    }
  }
  const open = data.lobbies.filter(l => l.phase === 'open' || l.phase === 'countdown').length;
  digits($('open-count'), pad2(open));
  setText($('n-starting'), `${data.lobbies.filter(l => ['countdown', 'preparing', 'picking', 'spawning'].includes(l.phase)).length}`);
  setText($('n-running'), `${data.lobbies.filter(l => l.phase === 'running').length}`);
  setText($('n-players'), `${data.lobbies.reduce((sum, l) => sum + l.players, 0)}`);
  $('no-lobbies').hidden = rows.size > 0;
  $('list-keys').hidden = !data.lobbies.some(l => l.joinable);
  // nothing will sign this page in by itself, so it says so
  const note = $('list-note');
  if (!data.me && signedIn) say(note, SIGNED_OUT);
  else if (note.textContent === SIGNED_OUT) say(note, '');

  // your own seat in a match that plays on
  const away = data.lobbies.find(l => l.mine && l.away && l.phase === 'running');
  $('give-up').hidden = !away || !data.me;
  if (!data.me) setSlot(null);
  else if (away) setSlot({ label: 'Rejoin', tone: 'go', act: 'rejoin', sub: `${away.name} ${kilo(away.tick)}`, id: away.id });
  else setSlot({ label: 'New lobby', tone: data.lobbies.some(seatOpen) ? 'cream' : 'go', act: 'create' });
}

$('lobbies').addEventListener('pointerleave', () => { if (last && shown === 'list') paintList(last); });
$('lobbies').addEventListener('scroll', e => $('list').classList.toggle('scrolled', e.target.scrollTop > 0), { passive: true });

/** Set while a join is on its way, so the row's faces can fly to their seats. */
let joining = null;

function joinRow(row) {
  const faces = new Map();
  for (const box of row.faces.values()) faces.set(box.dataset.name, box.getBoundingClientRect());
  joining = { faces, stack: row.stack };
  bracket.born(row.name.getBoundingClientRect());
  act('/join', { id: row.l.id }, $('list-note')).then(ok => {
    if (ok) return;
    joining = null;
    syncBracket();
  });
}

/** The row becomes the room: its faces fly to their seats, the bracket lands round your name, and the rest of the list goes. */
function rowBecomesRoom({ faces, stack }) {
  if (keys()) return;
  const list = $('list');
  list.classList.add('going');
  // its faces are on their way to their seats, so the row they left stays empty
  if (!calm()) stack.style.visibility = 'hidden';
  list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LIST_OUT_MS, easing: OUT }).onfinish = () => {
    list.classList.remove('going');
    stack.style.visibility = '';
  };
  if (calm()) return;
  for (const row of roster) {
    const box = row.el.querySelector(':scope > .avatar');
    if (!box) continue;
    const from = faces.get(box.dataset.name);
    if (!from) {
      seatOpens(box);
      continue;
    }
    const to = box.getBoundingClientRect();
    box.animate(
      [{ transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: FLIP_MS, easing: MOVE },
    );
  }
}

// ---- one lobby ----

const roster = [];
let fitted = '';

function buildRoster() {
  const list = $('seats');
  for (let i = 0; i < SEATS; i++) {
    const el = document.createElement('li');
    el.className = 'seat open';
    el.append(text('span', pad2(i + 1), 'cap idx'));
    list.append(el);
    roster.push({ el, key: null, word: null, st: null, nm: null });
  }
}

buildRoster();

/** Seated names: at Title if they fit, then one step down, then an ellipsis. Nothing in the display face ever wraps. */
function fitName(row) {
  const { nm, el } = row;
  nm.textContent = nm.dataset.name;
  nm.classList.remove('small');
  if (nm.scrollWidth > nm.clientWidth) nm.classList.add('small');
  if (nm.scrollWidth > nm.clientWidth) cutName(nm);
  el.style.setProperty('--w', `${nm.offsetWidth}px`);
}

/** What a seat holds, without its number. A row can hold a leaver's ghost as well, which is not among these. */
const seatParts = el => el.querySelectorAll(':scope > .avatar, :scope > .who, :scope > .st');

/** Whoever left fades where they were, over the open seat that takes their place. */
function seatEmpties(el) {
  const ghost = el.cloneNode(false);
  ghost.classList.add('ghost');
  ghost.classList.remove('you');
  ghost.append(...seatParts(el));
  el.append(ghost);
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SEAT_OUT_MS, easing: OUT }).onfinish = () => ghost.remove();
}

function fillSeat(row, i, seat, you) {
  const { el } = row;
  el.classList.toggle('open', !seat);
  el.classList.toggle('you', !!you);
  for (const part of seatParts(el)) part.remove();
  row.word = null;
  row.nm = row.st = null;
  const who = document.createElement('div');
  who.className = 'who';
  if (!seat) {
    who.append(text('span', 'Open seat', 'cap'));
    el.append(who);
    return;
  }
  row.nm = text('b', '', 'nm');
  setName(row.nm, seat.name);
  who.append(row.nm);
  if (you) {
    // your name scales under the pointer, and the bracket keeps round it
    who.addEventListener('pointerenter', () => { nameHovered = true; syncBracket('scale'); });
    who.addEventListener('pointerleave', () => { nameHovered = false; syncBracket('scale'); });
  }
  row.st = document.createElement('span');
  row.st.className = 'st';
  const box = face(seat, true);
  el.append(box, who, row.st);
  fitName(row);
  return box;
}

function paintSeat(row, seat) {
  picture(row.el.querySelector(':scope > .avatar'), seat, true);
  const word = seat.ready ? 'Ready' : seat.hasCode ? 'Not ready' : 'No code yet';
  if (row.word === word) return;
  const first = row.word === null;
  row.word = word;
  const tag = text('span', word, seat.ready ? 'tag' : 'cap');
  row.st.replaceChildren(tag);
  if (first || !seat.ready || (seat.you && keys())) return;
  if (seat.you) tag.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 120, easing: MOVE });
  else tag.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' });
}

/** Your own seat opens out from a point. */
function seatOpens(box) {
  box.animate([{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }], { duration: 160, easing: OUT });
}

function paintRoster(lobby) {
  const resized = fitted !== `${innerWidth}x${innerHeight}`;
  fitted = `${innerWidth}x${innerHeight}`;
  roster.forEach((row, i) => {
    const seat = lobby.seats[i], key = seat ? seat.name : '';
    if (row.key !== key) {
      const first = row.key === null, left = !seat && !!row.key;
      row.key = key;
      if (left && !joining) seatEmpties(row.el);
      const box = fillSeat(row, i, seat, seat?.you);
      // Someone arriving opens from a point if it is you, and fades in place if it is anyone else
      if (seat?.you && !joining) {
        if (!keys()) seatOpens(box);
      } else if (!first && !joining) {
        for (const part of seatParts(row.el)) part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: seat ? 240 : SEAT_OUT_MS, easing: OUT });
      }
    } else if (seat && resized) {
      fitName(row);
    }
    if (seat) paintSeat(row, seat);
  });
}

/** The countdown's green: it rises from the slot to fill the sheet, and its top edge drains back into the slot as the timer. */
let flooded = false, floodTimer = 0;

function paintFlood(counting, leftMs) {
  const flood = $('flood');
  if (counting === flooded) return;
  flooded = counting;
  clearTimeout(floodTimer);
  if (counting) {
    flood.classList.add('on');
    const gone = calm() ? 0 : (1 - leftMs / COUNTDOWN_MS) * 100;
    flood.style.transition = `clip-path ${FLOOD_RISE_MS}ms ${OUT}`;
    flood.style.clipPath = `inset(${gone}% 0 0 0)`;
    if (!calm()) {
      floodTimer = setTimeout(() => {
        flood.style.transition = `clip-path ${Math.max(0, leftMs - FLOOD_RISE_MS)}ms linear`;
        flood.style.clipPath = 'inset(100% 0 0 0)';
      }, FLOOD_RISE_MS);
    }
  } else {
    // The drain is already heading for this same value, so no new transition would begin: it has to stop where it is first.
    // The value is read before anything changes, because dropping the transition snaps it to its end.
    const at = getComputedStyle(flood).clipPath;
    flood.style.transition = 'none';
    flood.style.clipPath = at;
    flood.getBoundingClientRect();
    flood.style.transition = `clip-path ${FLOOD_BACK_MS}ms ${OUT}`;
    flood.style.clipPath = 'inset(100% 0 0 0)';
    floodTimer = setTimeout(() => flood.classList.remove('on'), FLOOD_BACK_MS);
  }
}

/** Out of the lobby mid-countdown: a drain left running would show in the next lobby this page opens. */
function dropFlood() {
  if (!flooded) return;
  const flood = $('flood');
  flooded = false;
  clearTimeout(floodTimer);
  flood.classList.remove('on');
  flood.style.transition = 'none';
  flood.style.clipPath = 'inset(100% 0 0 0)';
}

let preparedAt = 0;

/** The panel's one number: who still owes a step, the seconds left, or the seconds spent making the map. */
function paintCount(lobby) {
  if (lobby.phase === 'countdown') {
    const seconds = pad2(Math.ceil(lobby.leftMs / 1000));
    setText($('count-word'), 'Starting in');
    digits($('count'), seconds);
    digits($('count-green'), seconds);
  } else if (lobby.phase === 'preparing') {
    preparedAt ||= performance.now();
    setText($('count-word'), 'Making the map');
    digits($('count'), pad2(Math.floor((performance.now() - preparedAt) / 1000)));
  } else {
    setText($('count-word'), 'Not ready');
    digits($('count'), pad2(lobby.seats.filter(s => !s.ready).length));
  }
}

let uploading = null;
/** The server's own note, so one that has gone also goes from the page, and one still there does not cover a newer refusal. */
let serverNote = null;

function paintServerNote(lobby, note) {
  if ((lobby.note ?? null) === serverNote) return;
  serverNote = lobby.note ?? null;
  say(note, serverNote ?? '');
}

function paintLobby(lobby) {
  const me = seatOf(lobby), preparing = lobby.phase === 'preparing';
  setText($('lobby-name'), lobby.name);
  paintRoster(lobby);
  paintCount(lobby);
  paintFlood(lobby.phase === 'countdown', lobby.leftMs);
  $('drop').hidden = preparing;
  setText($('drop-title'), uploading ?? (me?.hasCode ? 'Code uploaded' : ''));
  setText($('drop-note'), uploading ? '' : me?.hasCode ? 'Drop a folder to replace it.' : 'A folder or a zip, up to 10 MB. No bot yet? Use the starter-bot folder from the Krebs zip.');
  paintServerNote(lobby, $('lobby-note'));
  // the slot always holds the step you owe, and there is only ever one
  if (uploading || preparing) setSlot(null);
  else if (!me?.hasCode) setSlot({ label: 'Pick folder', tone: 'go', act: 'folder' });
  else if (me.ready) setSlot({ label: 'Not ready', tone: 'line', act: 'unready' });
  else setSlot({ label: 'Ready', tone: 'go', act: 'ready' });
}

// ---- the map's rules ----

/** What is under the pointer on the map: a room's name while picking, a tile's [x, y] while spawning. */
let hovered = null;
/** The tile you clicked, not yet placed. */
let chosenTile = null;
let placedAt = 0;
const pinSeen = new Map();

/** Is this room another seat's? The server refuses those, so the map does not offer them. */
const rivalHas = name => (last?.lobby?.seats ?? []).some(s => s.room === name && !s.you);

/** A room outlined in `color`. */
function outline(g, room, color) {
  const [left, top, side] = worldMap.roomBox(room);
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.strokeRect(left + 1.5, top + 1.5, side - 3, side - 3);
}

/** Someone else's still at the bottom right of their room, under the row a name can stand on, fading in when they land. */
function pinSeat(g, seat, now) {
  const [left, top, side] = worldMap.roomBox(seat.room), size = px('--pin'), at = left + side - size - 2, down = top + side - size - 2;
  const key = `${seat.name}:${seat.room}`;
  if (!pinSeen.has(key)) pinSeen.set(key, now);
  const age = now - pinSeen.get(key);
  g.globalAlpha = Math.min(1, age / PIN_LAND_MS);
  g.fillStyle = BLACK;
  g.fillRect(at, down, size + 2, size + 2);
  g.drawImage(pinOf(seat), at + 1, down + 1, size, size);
  g.globalAlpha = 1;
  if (age < PIN_LAND_MS) worldMap.changed(PIN_LAND_MS);
}

const PICK = {
  dim: room => !room.claimable,
  // the map prints a locked room in its seat's colour and hatches a pick that is not locked yet
  sheets: () => (last?.lobby?.seats ?? []).filter(s => s.room).map(s => [s.room, s.color, s.locked]),
  overlay(g) {
    const now = performance.now();
    if (hovered && hovered !== myRoom()) outline(g, hovered, CREAM);
    for (const s of last?.lobby?.seats ?? []) if (s.room && !s.you) pinSeat(g, s, now);
  },
  hover(room) {
    const next = room?.claimable && !rivalHas(room.name) ? room.name : null;
    if (next === hovered) return;
    hovered = next;
    paintRoomHead();
  },
  async tap(room) {
    const me = seatOf(last?.lobby);
    if (!room?.claimable || !me || me.locked || me.room === room.name) return;
    const was = me.room;
    me.room = room.name;
    paintPick(last.lobby);
    syncBracket();
    if (await act('/pick', { room: room.name }, $('pick-note'))) return;
    const now = seatOf(last?.lobby);
    if (now) now.room = was;
    if (shown === 'pick') {
      paintPick(last.lobby);
      syncBracket();
    }
  },
};

const SPAWN = {
  solid: true,
  dim: room => room.name !== myRoom(),
  overlay(g) {
    const room = myRoom(), me = seatOf(last?.lobby);
    if (!room || !me) return;
    if (me.spawned && me.tile) {
      // a tile fills from its centre: place is the last thing the bracket closes on
      const age = placedAt ? performance.now() - placedAt : TILE_FILL_MS, t = filled(age);
      const [left, top, tile] = worldMap.tileBox(room, ...me.tile), size = tile * t;
      g.fillStyle = GO;
      g.fillRect(left + (tile - size) / 2, top + (tile - size) / 2, size, size);
      if (age < TILE_FILL_MS) worldMap.changed(TILE_FILL_MS);
    } else if (hovered && !isWall(room, hovered)) {
      const [left, top, tile] = worldMap.tileBox(room, ...hovered);
      g.strokeStyle = CREAM;
      g.lineWidth = 2;
      g.strokeRect(left + 1, top + 1, tile - 2, tile - 2);
    }
  },
  hover(room, x, y) {
    const next = room && room.name === myRoom() ? [x, y] : null;
    if (`${next}` === `${hovered}`) return;
    hovered = next;
    paintTile();
  },
  tap(room, x, y) {
    const me = seatOf(last?.lobby);
    if (!room || !me || room.name !== myRoom() || me.spawned) return;
    if (isWall(room.name, [x, y])) {
      say($('spawn-note'), 'A spawn needs open ground.');
      return;
    }
    say($('spawn-note'), '');
    chosenTile = [x, y];
    paintSpawn(last.lobby);
    syncBracket();
  },
};

/** The map prints who holds what by itself, from `worldMap.live`. */
const WATCH = {};

const RULES = { pick: PICK, spawn: SPAWN, over: WATCH };
const TERRAIN = ['Plain', 'Wall', 'Swamp', 'Wall'];

function isWall(room, [x, y]) {
  return (worldMap.terrainAt(room, x, y) & 1) === 1;
}

// ---- pick ----

/** The room name as last fitted, cleared when a face lands or the window changes, since either can change what fits. */
let roomFit = '';

function paintRoomHead() {
  const name = hovered ?? myRoom();
  $('pick').classList.toggle('blank', !name);
  if (!name) return;
  const title = $('room-name'), facts = worldMap.facts(name);
  if (roomFit !== name) {
    roomFit = name;
    title.textContent = name;
    title.classList.remove('tight');
    if (title.scrollWidth > title.parentElement.clientWidth) title.classList.add('tight');
  }
  if (!facts) return;
  setText($('f-sources'), `${facts.sources}`);
  setText($('f-mineral'), facts.mineral ? 'Yes' : 'No');
  setText($('f-plain'), `${facts.plain}%`);
  setText($('f-swamp'), `${facts.swamp}%`);
}

const keptRows = new WeakMap();

/** Puts rows in a list, keeping the ones that have not changed: `entries` are [key, said, make]. */
function paintRows(list, entries) {
  const before = keptRows.get(list) ?? new Map(), after = new Map();
  const made = entries.map(([key, said, make]) => {
    const held = before.get(key);
    const row = held?.said === said ? held.row : make();
    after.set(key, { said, row });
    return row;
  });
  keptRows.set(list, after);
  const now = [...list.children];
  if (made.length !== now.length || made.some((row, i) => row !== now[i])) list.replaceChildren(...made);
}

function pickRow(seat) {
  const row = document.createElement('li');
  const legend = document.createElement('i');
  legend.className = seat.locked ? 'legend' : 'legend waiting';
  legend.style.setProperty('--seat', seat.color);
  const name = text('b', '');
  setName(name, seat.name);
  row.append(legend, name, text('span', seat.locked ? 'Locked' : seat.room ?? '', 'cap'));
  return row;
}

let seatsDrawn = '';

/** A poll comes once a second and usually brings nothing the map shows, and a still map draws nothing. */
function seatsOnMap(lobby) {
  const seats = JSON.stringify(lobby.seats.map(s => [s.name, s.avatar, s.color, s.room, s.locked, s.spawned, s.tile]));
  if (seats === seatsDrawn) return;
  seatsDrawn = seats;
  worldMap.changed();
}

/** What is left of a step that has a deadline. */
function timeLeft(lobby) {
  const seconds = Math.ceil(lobby.leftMs / 1000);
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)} left`;
}

function paintPick(lobby) {
  const me = seatOf(lobby), locked = lobby.seats.filter(s => s.locked).length;
  setText($('pick-count'), `Locked ${locked} of ${lobby.seats.length}, ${timeLeft(lobby)}`);
  paintRows($('pick-seats'), lobby.seats.map(s => [s.name, JSON.stringify([s.color, s.locked, s.room]), () => pickRow(s)]));
  if (hovered && rivalHas(hovered)) hovered = null;
  paintRoomHead();
  if (me?.locked) setSlot({ label: 'Locked', tone: 'done' });
  else if (me?.room) setSlot({ label: 'Lock in', tone: 'go', act: 'lock' });
  else setSlot(null);
  seatsOnMap(lobby);
}

// ---- spawn ----

function paintTile() {
  const me = seatOf(last?.lobby), room = myRoom(), tile = me?.tile ?? hovered ?? chosenTile ?? null;
  $('tile-axes').classList.toggle('blank', !tile);
  if (tile) {
    digits($('tile-x'), pad2(tile[0]));
    digits($('tile-y'), pad2(tile[1]));
  }
  setText($('tile-terrain'), tile && room ? TERRAIN[worldMap.terrainAt(room, ...tile)] : '');
}

function paintSpawn(lobby) {
  const me = seatOf(lobby), placed = lobby.seats.filter(s => s.spawned).length;
  setText($('spawn-count'), `${placed} of ${lobby.seats.length} placed, ${timeLeft(lobby)}`);
  paintTile();
  if (me?.spawned) setSlot({ label: 'Placed', tone: 'done' });
  else if (chosenTile) setSlot({ label: 'Place', tone: 'go', act: 'place' });
  else setSlot(null);
  seatsOnMap(lobby);
}

// ---- the run ----

let live = null;
let pace = [];

function duration(seconds) {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours} h ${minutes} min` : minutes ? `${minutes} min` : `${Math.ceil(seconds)} s`;
}

/** The last minute's speed, and what it leaves. */
function paintRate(lobby) {
  const now = performance.now();
  pace.push([now, lobby.tick]);
  while (pace.length > 2 && now - pace[0][0] > 60000) pace.shift();
  const [firstAt, firstTick] = pace[0];
  const speed = ((lobby.tick - firstTick) * 1000) / Math.max(1, now - firstAt);
  const [rate, left] = $('rate').children;
  if (lobby.phase !== 'running' || lobby.tick === firstTick) {
    rate.textContent = left.textContent = '';
  } else {
    rate.textContent = `${speed >= 10 ? Math.round(speed) : speed.toFixed(1)} ticks/s`;
    left.textContent = `${duration((lobby.ticks - lobby.tick) / speed)} left`;
  }
}

/** Everyone by real standing: rooms, then GCL, then CPU. Who is level stays in seat order. */
function standings(lobby) {
  const known = lobby.seats.map(seat => {
    const player = live?.players.find(p => p.name === seat.account) ?? null;
    return { seat, player, rooms: player ? live.owned.filter(o => o[1] === player.id).length : 0 };
  });
  return known.sort((a, b) => b.rooms - a.rooms || (b.player?.gcl ?? 0) - (a.player?.gcl ?? 0) || (b.player?.cpu ?? 0) - (a.player?.cpu ?? 0));
}

const playerLine = ({ seat, player, rooms }, word = 'Rooms') => (player ? `${word} ${rooms} GCL ${player.gcl} CPU ${player.cpu}` : seat.room ?? '');

/** A long match outgrows a row at the smallest band. Every row steps down together, so the column keeps its rhythm and no count is cut. */
function roomsWord(ranked) {
  const width = px('--panel') - px('--strip') - px('--pad') * 2 - px('--live-avatar') - 8;
  const longest = Math.max(...ranked.map(entry => playerLine(entry).length));
  return longest * px('--t-cap') * MONO_ADVANCE > width ? 'RM' : 'Rooms';
}

const liveRows = new Map();

function liveRow(seat) {
  const el = document.createElement('li');
  el.className = 'player';
  const about = document.createElement('div');
  about.className = 'about';
  const line = document.createElement('div');
  line.className = 'line';
  const legend = document.createElement('i');
  legend.className = 'legend';
  legend.style.setProperty('--seat', seat.color);
  const name = text('b', '');
  setName(name, seat.name);
  line.append(legend, name);
  const small = text('small', '');
  about.append(line, small);
  el.append(face(seat, false), about);
  el.classList.toggle('mine', !!seat.you);
  return { el, small };
}

function paintPlayers(lobby) {
  const list = $('over-seats'), ranked = standings(lobby), word = roomsWord(ranked);
  const names = new Set(ranked.map(r => r.seat.name));
  for (const [name, row] of liveRows) {
    if (names.has(name)) continue;
    row.el.remove();
    liveRows.delete(name);
  }
  for (const entry of ranked) {
    let row = liveRows.get(entry.seat.name);
    if (!row) {
      row = liveRow(entry.seat);
      liveRows.set(entry.seat.name, row);
      list.append(row.el);
    }
    setText(row.small, playerLine(entry, word));
  }
  // Rows under the cursor hold still until it leaves
  if (list.matches(':hover')) return;
  const order = ranked.map(r => liveRows.get(r.seat.name).el);
  if (order.every((el, i) => el === list.children[i])) return;
  const before = new Map(order.map(el => [el, el.getBoundingClientRect().top]));
  list.append(...order);
  if (calm()) return;
  for (const el of order) {
    const moved = before.get(el) - el.getBoundingClientRect().top;
    if (moved) el.animate([{ transform: `translateY(${moved}px)` }, { transform: 'none' }], { duration: RANK_MS, easing: MOVE });
  }
}

function paintOver(lobby) {
  const finished = lobby.phase === 'finished', thousands = Math.floor(lobby.tick / 1000);
  const tick = $('thousands');
  digits(tick, thousands);
  tick.classList.toggle('four', thousands > 999);
  setText($('ticks'), `,${String(lobby.tick % 1000).padStart(3, '0')} of ${lobby.ticks.toLocaleString('en')}`);
  $('progress').style.transform = `scaleY(${lobby.tick / lobby.ticks})`;
  paintRate(lobby);
  paintPlayers(lobby);
  $('stop').hidden = lobby.phase !== 'running' || !hostIsMe(lobby);
  setSlot(finished ? { label: 'To list', tone: 'cream', act: 'list' } : null);
  if (finished) paintEnd(lobby);
  paintServerNote(lobby, $('over-note'));
}

/** The end sheet's name, as last fitted. */
let endFit = '';

/** The biggest name on the sheet: at Tick if it fits, then two steps down, then an ellipsis. */
function fitEnd() {
  const name = $('end-name'), over = () => name.scrollWidth > name.clientWidth;
  name.textContent = name.dataset.name;
  name.classList.remove('at-title', 'at-name');
  if (over()) name.classList.add('at-title');
  if (over()) name.classList.replace('at-title', 'at-name');
  if (over()) cutName(name);
}

function paintEnd(lobby) {
  const ranked = standings(lobby), known = ranked.some(r => r.player), name = known ? ranked[0].seat.name : lobby.name;
  setText($('end-tick'), `Match over, tick ${lobby.tick.toLocaleString('en')}`);
  setName($('end-name'), name);
  $('end-tag').hidden = !known;
  $('end-when').hidden = !known;
  if (endFit !== name) {
    endFit = name;
    fitEnd();
  }
  const below = known ? ranked.slice(1) : [];
  paintRows($('end-rows'), below.map(entry => [entry.seat.name, playerLine(entry), () => {
    const row = document.createElement('li');
    const name = text('b', '');
    setName(name, entry.seat.name);
    row.append(name, text('span', playerLine(entry), 'cap'));
    return row;
  }]));
}

function showLive(lobby, fresh) {
  live = fresh;
  worldMap.players(fresh.players.map(p => ({ ...p, color: lobby.seats.find(s => s.account === p.name)?.color ?? CREAM })));
  worldMap.live(fresh);
}

// ---- the rail ----

const VIEWS = ['list', 'lobby', 'pick', 'spawn', 'over'];
const STAGES = [...$('stages').children].map(el => ({ el, word: el.querySelector('.w'), n: el.querySelector('.n'), base: el.querySelector('.w').textContent }));

function setBack(words) {
  const back = $('back'), lab = back.querySelector('.lab'), fill = back.querySelector('.fill');
  back.hidden = !words;
  STAGES[0].n.hidden = STAGES[0].word.hidden = !!words;
  if (words && lab.textContent !== words) lab.textContent = fill.textContent = words;
}

/** Where you are in a match. A stage you have passed shows what you did there; one that does not apply has no control on it. */
function paintRail(data, view) {
  const lobby = data.lobby, me = seatOf(lobby), phase = lobby?.phase, at = VIEWS.indexOf(view);
  $('block').style.transform = `translateY(${at * 100}%)`;
  const inLobby = view === 'lobby' && (phase === 'open' || phase === 'countdown');
  setBack(inLobby ? 'Leave lobby' : view === 'over' ? (me ? 'Back to list' : 'Stop watch') : null);
  const done = me ? [null, `${lobby.seats.length}/${SEATS}`, me.room, me.tile?.join(',')] : [];
  STAGES.forEach((stage, i) => {
    const now = i === at, past = i < at && !!done[i];
    stage.el.classList.toggle('now', now);
    stage.el.classList.toggle('past', past);
    setText(stage.word, i === 4 && phase === 'finished' ? 'End' : past ? done[i] : stage.base);
  });
}

function paintServer() {
  const strip = $('server-name');
  if ($('server').classList.contains('lost')) {
    setText(strip, 'Reconnecting');
    return;
  }
  // truncated from the start, because the end of an address is what tells two apart
  const room = Math.floor((innerHeight - px('--rail') * 8) / (px('--t-cap') * 0.68)), host = location.host;
  setText(strip, host.length > room ? `...${host.slice(host.length - room + 3)}` : host);
}

function paintYou(data) {
  $('you').hidden = !data.me;
  if (!data.me) return;
  const seat = { name: data.me, avatar: data.avatar, frame: data.frame };
  const said = JSON.stringify(seat);
  if ($('you').dataset.said !== said) {
    $('you').dataset.said = said;
    $('you').replaceChildren(face(seat, true));
    setName($('set-name'), data.me);
  }
  picture($('you').firstChild, seat, true);
}

// ---- the slot ----

const ACTIONS = {
  create: () => act('/create', undefined, $('list-note')),
  rejoin: id => act('/join', { id }, $('list-note')),
  folder: () => $('folder').click(),
  ready: () => setReady(true),
  unready: () => setReady(false),
  lock,
  place,
  list: () => act('/leave', undefined, noteHere()),
};

/** Where a refusal shows on the screen that is up. */
const noteHere = () => $({ list: 'list-note', lobby: 'lobby-note', pick: 'pick-note', spawn: 'spawn-note', over: 'over-note' }[shown]);

/** The one primary action on a screen, in the one place it always is. A step that does not apply is removed, never disabled. */
function setSlot(spec) {
  const slot = $('slot');
  slot.hidden = !spec;
  if (!spec) return;
  slot.dataset.tone = spec.tone;
  slot.dataset.act = spec.act ?? '';
  slot.dataset.id = spec.id ?? '';
  setText($('slot-label'), spec.label);
  $('slot-sub').hidden = !spec.sub;
  setText($('slot-sub'), spec.sub ?? '');
}

// The slot's word changes under the pointer, so the second half of a double click would press the step after the one you meant
$('slot').addEventListener('click', e => {
  const { act: step, id } = $('slot').dataset;
  if (step && e.detail < 2) ACTIONS[step](Number(id));
});
$('give-up').addEventListener('click', e => { if (e.detail < 2) act('/give-up', undefined, $('list-note')); });

/** A step lands on the click: the page shows it done, and the reply either agrees or puts it back. */
function setReady(ready) {
  const me = seatOf(last?.lobby);
  if (!me) return;
  me.ready = ready;
  paintLobby(last.lobby);
  syncBracket();
  act('/ready', { ready }, $('lobby-note')).then(ok => {
    if (ok) return;
    const now = seatOf(last?.lobby);
    if (now) now.ready = !ready;
    if (shown === 'lobby' && now) {
      paintLobby(last.lobby);
      syncBracket();
    }
    poll();
  });
}

function lock() {
  const me = seatOf(last?.lobby);
  if (!me?.room) return;
  me.locked = true;
  paintPick(last.lobby);
  syncBracket();
  act('/lock', undefined, $('pick-note')).then(ok => {
    if (ok) return;
    const now = seatOf(last?.lobby);
    if (now) now.locked = false;
    if (shown === 'pick' && now) {
      paintPick(last.lobby);
      syncBracket();
    }
    poll();
  });
}

async function place() {
  const me = seatOf(last?.lobby), tile = chosenTile;
  if (!me || !tile) return;
  me.spawned = true;
  me.tile = tile;
  placedAt = keys() ? 0 : performance.now();
  paintSpawn(last.lobby);
  syncBracket();
  if (await act('/spawn', { x: tile[0], y: tile[1] }, $('spawn-note'))) return;
  const now = seatOf(last?.lobby);
  if (now) {
    now.spawned = false;
    now.tile = null;
  }
  placedAt = 0;
  if (shown === 'spawn') {
    paintSpawn(last.lobby);
    syncBracket();
  }
}

// ---- painting ----

/** Which screen a move is on its way to, and which one is actually up. They differ only while the cream sheet crosses. */
let screen = 'list';
let shown = 'list';
let crossing = false;
let mapOf = null, mapLoad = null;

const viewOf = lobby => (!lobby ? 'list' : { picking: 'pick', spawning: 'spawn', running: 'over', finished: 'over' }[lobby.phase] ?? 'lobby');

function loadMap(id) {
  if (mapLoad?.id === id) return mapLoad.done;
  const done = get('/map', MAP_WAIT_MS).then(found => {
    if (found.rooms) {
      worldMap.load(found.rooms);
      mapOf = id;
    }
  }).catch(() => {}).finally(() => { mapLoad = null; });
  mapLoad = { id, done };
  return done;
}

function wantedBracket() {
  const me = seatOf(last?.lobby);
  if (crossing || !me) return null;
  if (shown === 'lobby') return { kind: 'name', shut: !!me.ready };
  if (shown === 'pick') return me.room ? { kind: 'room', room: me.room, shut: !!me.locked } : null;
  if (shown === 'spawn') {
    const tile = me.tile ?? chosenTile;
    if (tile) return { kind: 'tile', room: me.room, tile, shut: !!me.spawned };
    return { kind: 'room', room: me.room, shut: worldMap.flying() };
  }
  return null;
}

function syncBracket(how) {
  if (joining) return;
  bracket.set(wantedBracket(), how);
}

/** Paints the screen that is up. A screen waiting for the sheet to cover it keeps what it had. */
function paintScreen(data) {
  if (screen !== shown) return;
  const lobby = data.lobby;
  document.body.dataset.phase = lobby?.phase ?? '';
  if (shown === 'list') paintList(data);
  else if (shown === 'lobby') paintLobby(lobby);
  else if (shown === 'pick') paintPick(lobby);
  else if (shown === 'spawn') paintSpawn(lobby);
  else paintOver(lobby);
  paintRail(data, shown);
  syncBracket();
}

/** Sets the camera for the screen that is up. It flies only between the two screens where the player's place in the world moves. */
function enterMap(from) {
  const rules = RULES[shown];
  if (!rules || mapOf !== last.lobby?.id || worldMap.rules() === rules) return;
  worldMap.use(rules);
  hovered = null;
  if (shown === 'pick') {
    worldMap.fit();
  } else if (shown === 'spawn') {
    if (from === 'pick') {
      worldMap.fly(myRoom(), () => syncBracket());
    } else {
      worldMap.fit();
      worldMap.focus(myRoom());
    }
  } else if (from === 'spawn') {
    bracket.leave();
    worldMap.fly(null);
  } else {
    worldMap.fit();
  }
}

function arrive(next, from) {
  shown = next;
  document.body.dataset.view = next;
  if (from === 'lobby' && next === 'pick' && calm()) $('stage').animate([{ opacity: 0 }, { opacity: 1 }], 160);
  worldMap.show(!!RULES[next]);
  worldMap.changed();
  enterMap(from);
  const flying = joining;
  if (screen === shown && last) paintScreen(last);
  if (next === 'lobby' && flying) {
    rowBecomesRoom(flying);
    joining = null;
    syncBracket('fly');
  } else {
    joining = null;
    syncBracket();
  }
}

/** The cream sheet crosses the stage with the new screen arriving under it. */
function crossSheet(next, from) {
  const sheet = $('sheet');
  crossing = true;
  syncBracket();
  sheet.classList.add('cross');
  setTimeout(() => arrive(screen, from), CROSS_MS / 2);
  setTimeout(() => {
    sheet.classList.remove('cross');
    crossing = false;
    syncBracket();
  }, CROSS_MS);
}

function forgetMatch() {
  mapOf = null;
  hovered = null;
  chosenTile = null;
  placedAt = 0;
  preparedAt = 0;
  live = null;
  pace = [];
  pinSeen.clear();
  for (const row of roster) row.key = null;
  for (const row of liveRows.values()) row.el.remove();
  liveRows.clear();
  $('stop').hidden = true;
  dropFlood();
}

async function paint(data) {
  last = data;
  const lobby = data.lobby, next = viewOf(lobby);
  // a match that could not start comes back to its lobby under the same id, and its next try is a different map
  if (!lobby || (lobby.phase === 'open' && mapOf !== null)) forgetMatch();
  if (next !== 'list' && next !== 'lobby' && mapOf !== lobby.id) {
    await loadMap(lobby.id);
    if (last !== data) return;
    // picking and spawning are nothing without the map, but a run's panel is still worth having
    if (mapOf !== lobby.id && next !== 'over') return;
  }
  if (lobby?.phase === 'running') {
    const fresh = await get('/live', POLL_WAIT_MS).catch(() => null);
    if (fresh?.players) showLive(lobby, fresh);
    if (last !== data) return;
  }
  paintYou(data);
  if (next !== screen) {
    const from = screen;
    screen = next;
    if (from === 'lobby' && next === 'pick' && !calm()) crossSheet(next, from);
    else arrive(next, from);
    if (crossing) return;
  } else {
    paintScreen(data);
    enterMap(shown);
  }
}

let failures = 0;
/** One at a time: a slow overview must not keep being overtaken by the next poll, or nothing ever paints. */
let polling = false;
/** Whether this page has been signed in, and whether it has asked the client to do it again since. */
let signedIn = false;
let signInAsked = false;

async function poll() {
  // zero wide means the frame is hidden: the client went to its server list, so this player is no longer here
  if (busy || polling || innerWidth === 0) return;
  polling = true;
  const asked = acted;
  try {
    let data;
    try {
      data = await get('', POLL_WAIT_MS);
    } catch {
      // Two in a row is a lost connection, and that is the server's state, so it shows where the server's name is
      if (++failures >= 2) {
        $('server').classList.add('lost');
        paintServer();
      }
      return;
    }
    if (failures >= 2) {
      $('server').classList.remove('lost');
      paintServer();
      // what failed while the server was gone is not the news any more
      for (const note of document.querySelectorAll('.note')) say(note, '');
    }
    failures = 0;
    if (data.me) {
      signedIn = true;
      signInAsked = false;
    }
    // An answer sent before an action is older than the action's own: painting it would put the screen back a step
    if (asked === acted) await paint(data);
    if (!data.me) parent.postMessage('token', '*');
  } finally {
    polling = false;
  }
}

// ---- uploading ----

async function send(tree) {
  const note = $('lobby-note');
  uploading = 'Reading';
  say(note, '');
  paintScreen(last);
  try {
    const result = await resolveBot(await tree);
    if (result.stop) {
      say(note, `${result.stop.title}. ${result.stop.body}`);
      return;
    }
    uploading = 'Uploading';
    paintScreen(last);
    await call('POST', '/upload', deployBody(result));
  } catch (e) {
    const refused = e?.message === '400' || e?.message === '409';
    say(note, refused ? 'The server refused it. Check your code and try again.' : uploading === 'Reading' ? "That couldn't be read. Drop the folder instead." : 'Check your connection and drop the folder again.');
  } finally {
    uploading = null;
    paintScreen(last);
    await poll();
  }
}

/** The whole window is the drop target, on the one screen that takes code. */
const canDrop = () => {
  const phase = last?.lobby?.phase;
  return shown === 'lobby' && (phase === 'open' || phase === 'countdown');
};

// Refused or not, a file dragged in is this page's to handle: left alone, the browser would open it in place of the page
addEventListener('dragover', e => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  if (canDrop()) document.body.classList.add('over');
  else e.dataTransfer.dropEffect = 'none';
});
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('over'); });
addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('over');
  if (!canDrop()) return;
  const file = e.dataTransfer.files.length === 1 ? e.dataTransfer.files[0] : null;
  send(file && isZip(file) ? treeFromZip(file) : treeFromDrop(e.dataTransfer));
});
$('folder').addEventListener('change', e => {
  if (e.target.files.length) send(treeFromFileList(e.target.files));
  e.target.value = '';
});

// ---- holding down ----

/** A flat cream plate that slides out and says what letting the hold finish will do. */
function slidePlate(plate, place) {
  let timer = 0;
  return {
    show(words, anchor, ms = 0) {
      place?.(anchor);
      plate.textContent = words;
      plate.classList.add('on');
      clearTimeout(timer);
      if (ms) timer = setTimeout(() => plate.classList.remove('on'), ms);
    },
    hide() {
      clearTimeout(timer);
      plate.classList.remove('on');
    },
  };
}

const railPlate = slidePlate($('plate'), anchor => {
  const clip = $('plate-clip'), box = anchor.closest('.mod').getBoundingClientRect();
  clip.style.top = `${box.top}px`;
  clip.style.height = `${box.height}px`;
  clip.style.bottom = 'auto';
});
const stopPlate = slidePlate($('stop-plate'));

/**
 * What cannot be undone is held, and the fill is the time left to change your mind. `stake` says what is at stake, or nothing
 * when nothing is, and then a click does it. Any early release costs nothing, and a press too short to count says so.
 */
function holdable(button, ms, stake, done, plate) {
  let timer = 0, held = false, firedAt = -1000;
  button.style.setProperty('--hold', `${ms}ms`);
  const press = () => {
    const words = stake();
    if (!words || held) return;
    held = true;
    button.classList.add('held');
    plate.show(words, button);
    timer = setTimeout(() => {
      held = false;
      firedAt = performance.now();
      plate.hide();
      done();
    }, ms);
  };
  const release = clicked => {
    button.classList.remove('held');
    if (!held) return;
    held = false;
    clearTimeout(timer);
    if (clicked) plate.show('Hold', button, HOLD_WORD_MS);
    else plate.hide();
  };
  button.addEventListener('pointerdown', e => { if (e.button === 0) press(); });
  button.addEventListener('pointerup', () => release(true));
  button.addEventListener('pointerleave', () => release(false));
  button.addEventListener('pointercancel', () => release(false));
  // focus gone means the key will come up somewhere else, and this hold would never hear of it
  button.addEventListener('blur', () => release(false));
  button.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) press(); });
  button.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') release(true); });
  button.addEventListener('click', () => { if (!stake() && performance.now() - firedAt > 500) done(); });
}

function leaveStake() {
  const lobby = last?.lobby;
  if (!lobby || lobby.phase === 'finished' || !seatOf(lobby)) return null;
  if (lobby.phase === 'running') return 'Seat stays. Ends if all leave';
  return lobby.phase === 'picking' || lobby.phase === 'spawning' ? 'You are out of this match' : 'Gives up your seat and code';
}

/** Leaving is the client's to do. Polls stopping would give the seat up 15 s later, so the server is told first. */
function leaveServer() {
  if (!last?.lobby) {
    parent.postMessage('leave', '*');
    return;
  }
  const headers = token ? { 'X-Token': token, 'X-Username': token } : {};
  const told = fetch('/api/lobbies/leave', { method: 'POST', headers, keepalive: true }).catch(() => {});
  const waited = new Promise(done => setTimeout(done, LEAVE_WAIT_MS));
  Promise.race([told, waited]).then(() => parent.postMessage('leave', '*'));
}

holdable($('leave'), LEAVE_HOLD_MS, leaveStake, leaveServer, railPlate);
holdable($('back'), LEAVE_HOLD_MS, () => (last?.lobby?.phase === 'countdown' ? 'Gives up your seat and code' : null), () => act('/leave', undefined, noteHere()), railPlate);
const stopStake = () => {
  const players = last?.lobby?.seats.length ?? 0;
  return `Ends the match for ${players} ${players === 1 ? 'player' : 'players'}`;
};
holdable($('stop'), STOP_HOLD_MS, stopStake, () => act('/stop', undefined, $('over-note')), stopPlate);

// ---- the rest of the controls ----

$('you').addEventListener('click', e => {
  e.stopPropagation();
  $('settings').classList.toggle('on');
});
$('settings').addEventListener('click', e => e.stopPropagation());
addEventListener('click', () => $('settings').classList.remove('on'));
$('set-anim').addEventListener('click', () => {
  prefs.animations = !prefs.animations;
  savePrefs();
  applyMotion();
  paintPrefs();
  if (last) paintScreen(last);
});
$('set-move').addEventListener('click', () => {
  prefs.avatars = !prefs.avatars;
  savePrefs();
  paintPrefs();
  if (last) paintScreen(last);
});

function clearRoom() {
  const me = seatOf(last?.lobby);
  if (!me?.room || me.locked) return;
  me.room = null;
  paintPick(last.lobby);
  syncBracket();
  act('/pick', { room: '' }, $('pick-note'));
}

function clearTile() {
  if (!chosenTile || seatOf(last?.lobby)?.spawned) return;
  chosenTile = null;
  paintSpawn(last.lobby);
  syncBracket();
}

// Arrows walk the lobbies, Enter joins. Esc steps back one level, except in a lobby, where one level back gives up a seat.
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('settings').classList.contains('on')) $('settings').classList.remove('on');
    else if (shown === 'pick') clearRoom();
    else if (shown === 'spawn') clearTile();
    else if (shown === 'over') $('back').click();
    return;
  }
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || shown !== 'list') return;
  const can = [...$('lobbies').querySelectorAll('.can')];
  if (!can.length) return;
  e.preventDefault();
  const at = can.indexOf(document.activeElement), down = e.key === 'ArrowDown';
  can[at < 0 ? (down ? 0 : can.length - 1) : (at + (down ? 1 : -1) + can.length) % can.length].focus();
});

// The countdown runs here, between polls. Its digits cut hard each second, and only the flood moves.
setInterval(() => {
  const lobby = last?.lobby;
  if (shown !== 'lobby' || !lobby) return;
  if (lobby.phase === 'countdown') lobby.leftMs = Math.max(0, lobby.leftMs - 100);
  if (lobby.phase === 'countdown' || lobby.phase === 'preparing') paintCount(lobby);
}, 100);

// The client hands over the token it holds for this server when this page has loaded, and whenever `poll` finds it signed
// out: the client's sign-in usually ends just after that first one. One that changes nothing is a stale token it still has,
// and if this page was signed in with it, a server restart ended it: nothing but the client can start another.
addEventListener('message', event => {
  if (event.source !== window.parent || window.parent === window || typeof event.data !== 'string') return;
  let fresh;
  try { fresh = JSON.parse(event.data); } catch { fresh = event.data; }
  if (fresh === token) {
    if (signedIn && !last?.me && !signInAsked) {
      signInAsked = true;
      parent.postMessage('signin', '*');
    }
    return;
  }
  token = fresh;
  poll();
});

/** The rooms on screen, as fast as they come within `ROOMS_MS`. Far out there are none: the overview's dots are the map. */
async function watchRooms() {
  try {
    const rooms = last?.lobby?.phase === 'running' && innerWidth > 0 && !document.hidden ? worldMap.wanted() : [];
    if (rooms.length) {
      const reply = await get(`/rooms?rooms=${rooms.join(',')}`, POLL_WAIT_MS).catch(() => null);
      if (reply?.rooms) worldMap.objects(reply);
    }
  } finally {
    setTimeout(watchRooms, ROOMS_MS);
  }
}

function onResize() {
  root.style.setProperty('--dpr', devicePixelRatio);
  roomFit = endFit = '';
  paintServer();
  if (last) paintScreen(last);
  bracket.follow();
}

addEventListener('resize', onResize);
lessMotion.addEventListener('change', () => {
  applyMotion();
  if (last) paintScreen(last);
});
worldMap.after(() => bracket.follow());
// A name is measured in the face it will show in, and that may land after the first paint
document.fonts.addEventListener('loadingdone', () => {
  fitted = '';
  onResize();
});

applyMotion();
paintPrefs();
onResize();
poll();
setInterval(poll, 1000);
watchRooms();
