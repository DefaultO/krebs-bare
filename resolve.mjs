// Works out what to upload from a dropped bot folder, with no questions asked. One browser ES module, no dependencies.
// It runs in Node too, which is how its tests run. No DOM is touched at import time.
//
//   const tree = treeFromEntry(droppedEntry);      // or treeFromFileList, treeFromHandle, treeFromObject
//   const result = await resolveBot(tree);
//   if (result.stop) show(result.stop); else post(deployBody(result));
//
// The rules below come from the server, not from guesswork:
//   crates/runtime/js/engine/game/game.js   requireFn: only a leading ./ is removed, then the name is looked up as it stands
//                                           a module being loaded is -1 in require.cache, so a circular require throws
//   crates/backend/src/api/user.rs          names starting with $ are dropped; its 5 MiB does not apply in a match (mods/matchrun)
//   a match's upload                        names cannot start with $ . / \ ; main must be text; { binary: base64 } is a binary module
// So ../x never resolves on the server, nested paths must be flattened, and a require of a flattened file must be rewritten.

/** crates/backend/src/http.rs MAX_BODY: bytes on the wire, the one limit on a bot in a match. */
const MAX_BODY = 10 * 1024 * 1024;
/** What mods/bare/src/world.rs wraps the modules in for the match's world. */
const UPLOAD_FRAME = 31;
const BUILT = /(^|\/)(dist|build|out|output)\/main\.js$/;

/** Folders nobody uploads. A file in one still comes along when reachable code requires it. */
const JUNK_DIRS = new Set(['node_modules', 'bower_components', 'jspm_packages', 'test', 'tests', '__tests__', '__mocks__', '__snapshots__', 'spec', 'specs',
  'coverage', 'docs', 'doc', 'example', 'examples', 'typings', 'target', 'tmp', 'temp', 'logs', 'screenshots', 'images', 'img', 'assets', 'media', 'venv',
  '__pycache__', 'gradle', 'cmake-build-debug', 'cmake-build-release']);
const JUNK_FILE = /^\.|\.(test|spec|stories)\.[cm]?[jt]sx?$|^(gruntfile|gulpfile|rollup\.config|webpack\.config|babel\.config|jest\.config|karma\.conf|vite\.config|tsup\.config|eslint\.config|prettier\.config|commitlint\.config)(\.[a-z0-9]+)*\.[cm]?[jt]s$/i;
/** Never read, never sent, whatever asks for them: they hold passwords and tokens. */
const SECRET_FILE = /(^|\/)(screeps\.json|\.screeps\.ya?ml|\.chitin\.json|\.env(\..*)?|credentials\.json)$/i;
const ENTRY_DIRS = ['dist', 'build', 'out', 'output', '', 'src', 'lib', 'scripts', 'default', 'code', 'bot', 'target'];
const NODE_ONLY = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);
/** Names the server gives a meaning of its own: lodash is already in require.cache, team is overwritten in a team match. */
const RESERVED = new Set(['lodash', 'team', '__mainLoop', 'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const LANGUAGES = { ts: 'TypeScript', tsx: 'TypeScript', rs: 'Rust', c: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', kt: 'Kotlin', py: 'Python', go: 'Go', zig: 'Zig', nim: 'Nim', coffee: 'CoffeeScript', java: 'Java', cs: 'C#', cljs: 'ClojureScript', ml: 'OCaml', hx: 'Haxe' };
const SURVEY_LIMIT = 20000;

const ext = path => /\.([^./]+)$/.exec(path)?.[1].toLowerCase() ?? '';
const baseName = path => path.slice(path.lastIndexOf('/') + 1);
const dirName = path => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const join = (a, b) => (a && b ? `${a}/${b}` : a || b);

/** a/b/../c to a/c. Null if it climbs out of the tree. */
function normal(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (!out.length) return null;
    else out.pop();
  }
  return out.join('/');
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/* ---- reading a folder, four ways. A tree is { list(dir), open(path) } with '/' paths and '' as its root ---- */

/** Tests and anything else that holds files in memory: { 'src/main.js': 'text' or Uint8Array }. */
export function treeFromObject(files, times = {}) {
  const encoder = new TextEncoder();
  return {
    async list(dir) {
      const seen = new Map();
      for (const path of Object.keys(files)) {
        if (dir && !path.startsWith(`${dir}/`)) continue;
        const [name, more] = path.slice(dir ? dir.length + 1 : 0).split('/');
        seen.set(name, { name, dir: more !== undefined, modified: times[join(dir, name)] ?? 0 });
      }
      return [...seen.values()];
    },
    async open(path) {
      const v = files[path];
      if (v === undefined) return null;
      return { bytes: typeof v === 'string' ? encoder.encode(v) : v, modified: times[path] ?? 0 };
    },
  };
}

/** A folder input, or loose files. A folder input's paths start with the folder's own name, which is dropped. */
export function treeFromFileList(list) {
  const files = new Map();
  for (const file of list) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    files.set(parts.length > 1 ? parts.slice(1).join('/') : parts[0], file);
  }
  return {
    async list(dir) {
      const seen = new Map();
      for (const [path, file] of files) {
        if (dir && !path.startsWith(`${dir}/`)) continue;
        const [name, more] = path.slice(dir ? dir.length + 1 : 0).split('/');
        seen.set(name, { name, dir: more !== undefined, modified: file.lastModified ?? 0 });
      }
      return [...seen.values()];
    },
    async open(path) {
      const file = files.get(path);
      return file ? { bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified ?? 0 } : null;
    },
  };
}

const call = (fn, ...args) => new Promise((ok, no) => fn(...args, ok, no));

/** A dragged folder: `item.webkitGetAsEntry()`. Works on plain http, and stays a live view of the folder until the page goes. */
export function treeFromEntry(root) {
  const directory = async dir => {
    let at = root;
    for (const part of dir ? dir.split('/') : []) at = await call(at.getDirectory.bind(at), part, {});
    return at;
  };
  return {
    async list(dir) {
      const at = await directory(dir), reader = at.createReader(), out = [];
      for (;;) {                                   // readEntries answers in batches
        const batch = await call(reader.readEntries.bind(reader));
        if (!batch.length) return out;
        for (const e of batch) out.push({ name: e.name, dir: e.isDirectory, modified: e.isDirectory ? 0 : +(await call(e.getMetadata.bind(e))).modificationTime });
      }
    },
    async open(path) {
      try {
        const at = await directory(dirName(path));
        const entry = await call(at.getFile.bind(at), baseName(path), {});
        const file = await call(entry.file.bind(entry));
        return { bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified };
      } catch { return null; }
    },
  };
}

/** A File System Access handle: `showDirectoryPicker()`. Only on a secure context, so https or localhost, never plain http on a LAN. */
export function treeFromHandle(root) {
  const directory = async dir => {
    let at = root;
    for (const part of dir ? dir.split('/') : []) at = await at.getDirectoryHandle(part);
    return at;
  };
  return {
    async list(dir) {
      const out = [];
      for await (const [name, handle] of (await directory(dir)).entries()) out.push({ name, dir: handle.kind === 'directory', modified: handle.kind === 'file' ? (await handle.getFile()).lastModified : 0 });
      return out;
    },
    async open(path) {
      try {
        const file = await (await (await directory(dirName(path))).getFileHandle(baseName(path))).getFile();
        return { bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified };
      } catch { return null; }
    },
  };
}

/** The dropped thing as a tree, on any origin. `getAsFileSystemHandle` exists on plain http and calling it there kills the tab
 *  (Chrome 156, proved by running it), so this uses the old entry API, which works everywhere Chrome does. */
export function isZip(file) { return /\.zip$/i.test(file?.name ?? '') || file?.type === 'application/zip' || file?.type === 'application/x-zip-compressed'; }

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => u16(b, at) + u16(b, at + 2) * 65536;
const ZIP_FILE_LIMIT = 64 * 1024 * 1024;

/**
 * A dropped .zip. Reads the central directory from the end of the file, then inflates only what the resolver opens, so a
 * node_modules inside costs nothing. DecompressionStream needs no secure context. Throws 'not-a-zip', 'zip64' or 'encrypted'.
 */
export async function treeFromZip(blob) {
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 66000)).arrayBuffer());
  let end = tail.length - 22;
  while (end >= 0 && u32(tail, end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not-a-zip');
  const count = u16(tail, end + 10), dirSize = u32(tail, end + 12), dirAt = u32(tail, end + 16);
  if (count === 0xffff || dirAt === 0xffffffff) throw new Error('zip64');
  const dir = new Uint8Array(await blob.slice(dirAt, dirAt + dirSize).arrayBuffer());
  const words = new TextDecoder(), files = new Map(), folders = new Map([['', new Map()]]);
  const note = (path, isDir, modified) => {
    const up = dirName(path);
    if (!folders.has(up)) { note(up, true, 0); folders.set(up, new Map()); }
    folders.get(up).set(baseName(path), { name: baseName(path), dir: isDir, modified });
  };
  for (let p = 0, i = 0; i < count; i++) {
    if (u32(dir, p) !== 0x02014b50) throw new Error('not-a-zip');
    const flags = u16(dir, p + 8), method = u16(dir, p + 10), time = u16(dir, p + 12), date = u16(dir, p + 14);
    const packed = u32(dir, p + 20), full = u32(dir, p + 24), nameSize = u16(dir, p + 28), extra = u16(dir, p + 30), comment = u16(dir, p + 32), local = u32(dir, p + 42);
    const raw = words.decode(dir.subarray(p + 46, p + 46 + nameSize)).replace(/\\/g, '/'), name = normal(raw);
    p += 46 + nameSize + extra + comment;
    if (!name || raw.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    const modified = Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
    files.set(name, { flags, method, packed, full, local, modified });
    note(name, false, modified);
  }
  return {
    async list(at) { return [...(folders.get(at)?.values() ?? [])]; },
    async open(path) {
      const f = files.get(path);
      if (!f || f.full > ZIP_FILE_LIMIT || (f.method !== 0 && f.method !== 8)) return null;
      if (f.flags & 1) throw new Error('encrypted');
      const head = new Uint8Array(await blob.slice(f.local, f.local + 30).arrayBuffer());
      const start = f.local + 30 + u16(head, 26) + u16(head, 28), raw = blob.slice(start, start + f.packed);
      const stream = f.method === 8 ? raw.stream().pipeThrough(new DecompressionStream('deflate-raw')) : raw.stream();
      return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), modified: f.modified };
    },
  };
}

export function treeFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  return entries.length ? treeFromEntry(entriesRoot(entries)) : treeFromFileList([...dataTransfer.files]);
}

/** One folder as it is, or what someone selected inside a folder and dragged, as a root of its own. Either stays live. */
export function entriesRoot(entries) {
  if (entries.length === 1 && entries[0].isDirectory) return entries[0];
  const child = (want, name, _options, ok, no) => {
    const found = entries.find(e => e.name === name && e.isDirectory === want);
    if (found) ok(found); else no(new Error(`no ${name}`));
  };
  return {
    name: 'my-bot',
    isDirectory: true,
    fullPath: '',
    createReader() { let given = false; return { readEntries(ok) { ok(given ? [] : entries); given = true; } }; },
    getDirectory: (name, options, ok, no) => child(true, name, options, ok, no),
    getFile: (name, options, ok, no) => child(false, name, options, ok, no),
  };
}

/** Names, sizes and times of a dragged folder, with no file text read. A poll compares these, and only a change costs a read.
 *  About 0.1 to 0.3 s per 400 files in headless Chrome. Junk folders are not entered, so node_modules costs nothing. */
export async function folderSignature(root) {
  const rows = [];
  const visit = async dir => {
    const reader = dir.createReader();
    for (;;) {
      const batch = await call(reader.readEntries.bind(reader));
      if (!batch.length) return;
      for (const e of batch) {
        if (e.isDirectory) { if (!JUNK_DIRS.has(e.name) && !e.name.startsWith('.')) await visit(e); }
        else { const m = await call(e.getMetadata.bind(e)); rows.push(`${e.fullPath}:${m.size}:${+m.modificationTime}`); }
      }
    }
  };
  await visit(root);
  return rows.sort().join('\n');
}

/** A bot name the server takes, from a folder's name: letters, numbers and dashes, at most 40. */
export function suggestBotName(folder) {
  const name = String(folder ?? '').normalize('NFKD').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? 'my-bot' : name.toLowerCase();
}

/* ---- finding require calls without being fooled by strings, comments, templates and regular expressions ---- */

const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * sites: every require( in code. A `spec` is a plain string; `prefix` is the literal start of a computed name.
 * `aliased`: require is used as a value, so what it loads cannot be known. `shadowed`: the file has its own require.
 * `esm`: top-level import or export, which the game cannot run.
 */
export function scan(source) {
  const sites = [], n = source.length, braces = [];
  let i = 0, line = 1, prev = '', owner = '', aliased = false, shadowed = false, esm = null;
  const uses = [];
  const parens = [];
  const isId = c => /[\w$]/.test(c) || c > '\x7f';
  const skipSpace = at => {
    for (;;) {
      while (at < n && /\s/.test(source[at])) at++;
      if (source[at] === '/' && source[at + 1] === '/') { while (at < n && source[at] !== '\n') at++; continue; }
      if (source[at] === '/' && source[at + 1] === '*') { const end = source.indexOf('*/', at + 2); at = end < 0 ? n : end + 2; continue; }
      return at;
    }
  };
  const endOfString = (at, quote) => {           // at: the opening quote. Returns the index of the closing one, or -1
    for (let k = at + 1; k < n; k++) {
      if (source[k] === '\\') k++;
      else if (source[k] === quote) return k;
      else if (source[k] === '\n') return -1;
    }
    return -1;
  };
  const template = () => {                       // i: just inside a template. Stops after the closing `, or after ${
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; prev = 'str'; return; }
      if (c === '$' && source[i + 1] === '{') { i += 2; braces.push({ template: true }); prev = '{'; return; }
      i++;
    }
  };
  const regexEnd = () => {                       // i: the opening slash. Returns the index past the flags, or -1 if this is a division
    let k = i + 1, inClass = false;
    for (; k < n; k++) {
      const c = source[k];
      if (c === '\n') return -1;
      if (c === '\\') { k++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { k++; while (k < n && /[a-z]/i.test(source[k])) k++; return k; }
    }
    return -1;
  };
  const requireAt = (at) => {                    // at: the word's first letter
    const open = skipSpace(at + 7);
    if (source[open] !== '(') {
      if (source[open] !== '.' && prev !== 'typeof' && !(source[open] === ':' && (prev === '{' || prev === ','))) aliased = true;
      return;
    }
    const arg = skipSpace(open + 1), quote = source[arg], site = { line, inTry: braces.some(b => b.try) };
    if (quote === "'" || quote === '"' || quote === '`') {
      const close = quote === '`' ? source.indexOf('`', arg + 1) : endOfString(arg, quote);
      const text = close > 0 ? source.slice(arg + 1, close) : '';
      const hole = quote === '`' ? text.indexOf('${') : -1;
      if (close > 0 && hole < 0 && source[skipSpace(close + 1)] === ')') {
        sites.push({ ...site, spec: text, start: arg + 1, end: close });
        return;
      }
      if (close > 0 && hole > 0) { sites.push({ ...site, prefix: text.slice(0, hole), start: arg + 1, end: arg + 1 + hole }); return; }
      if (close > 0 && source[skipSpace(close + 1)] === '+') { sites.push({ ...site, prefix: text, start: arg + 1, end: close }); return; }
    }
    sites.push({ ...site, prefix: '' });
  };
  if (source.startsWith('#!')) { while (i < n && source[i] !== '\n') i++; }
  while (i < n) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2), stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (source[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = endOfString(i, c);
      i = end < 0 ? i + 1 : end + 1;
      prev = 'str';
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/') {
      const end = REGEX_AFTER.has(prev) || (prev === ')' && ['if', 'while', 'for', 'with'].includes(owner)) ? regexEnd() : -1;
      if (end > 0) { i = end; prev = 'regex'; continue; }
      prev = '/';
      i++;
      continue;
    }
    if (isId(c) && !/\d/.test(c)) {
      let k = i + 1;
      while (k < n && isId(source[k])) k++;
      const word = source.slice(i, k);
      if ((word === 'TextDecoder' || word === 'TextEncoder') && prev !== '.' && prev !== 'typeof') uses.push({ name: word, line });
      if ((word === 'instantiate' || word === 'instantiateStreaming') && prev === '.' && /WebAssembly\s*\.\s*$/.test(source.slice(Math.max(0, i - 16), i))) uses.push({ name: 'WebAssembly.instantiate', line });
      if (word === 'require' && (prev !== '.' || /\b(global|globalThis|self|module)\s*\.\s*$/.test(source.slice(Math.max(0, i - 20), i)))) {
        if (prev === 'function' || prev === 'var' || prev === 'let' || prev === 'const') shadowed = true;
        else requireAt(i);
      }
      if ((word === 'import' || word === 'export') && !braces.length && !parens.length && prev !== '.') {
        const next = source[skipSpace(k)];
        if (word === 'export' || (next !== '(' && next !== '.')) esm ??= line;
      }
      prev = word;
      i = k;
      continue;
    }
    if (c === '=' && source[i + 1] === '>') { prev = '=>'; i += 2; continue; }
    if (c === '{') { braces.push({ try: prev === 'try' }); prev = '{'; i++; continue; }
    if (c === '}') {
      const top = braces.pop();
      i++;
      if (top?.template) template();
      else prev = '}';
      continue;
    }
    if ((c === '+' || c === '-') && source[i + 1] === c) { prev = /[\w$)\]]$/.test(prev) && !REGEX_AFTER.has(prev) ? 'value' : c; i += 2; continue; }
    if (c === '(') { parens.push(/^[\w$]+$/.test(prev) ? prev : ''); prev = '('; i++; continue; }
    if (c === ')') { owner = parens.pop() ?? ''; prev = ')'; i++; continue; }
    prev = c;
    i++;
  }
  return { sites, aliased, shadowed, esm, uses };
}

/* ---- SHA-256, because crypto.subtle does not exist on plain http ---- */

const K = new Uint32Array(64);
{
  let found = 0;
  for (let p = 2; found < 64; p++) {
    let prime = true;
    for (let d = 2; d * d <= p; d++) if (p % d === 0) { prime = false; break; }
    if (prime) { const r = Math.cbrt(p); K[found++] = Math.floor((r - Math.floor(r)) * 2 ** 32); }
  }
}

export function sha256(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(((bytes.length + 9 + 63) & ~63));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer), w = new Uint32Array(64);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 2 ** 29));
  view.setUint32(padded.length - 4, bytes.length << 3);
  const rot = (x, c) => (x >>> c) | (x << (32 - c));
  for (let at = 0; at < padded.length; at += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(at + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      w[t] = (w[t - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[t - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, i] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (i + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      i = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, i].forEach((v, k) => { h[k] = (h[k] + v) | 0; });
  }
  return [...h].map(v => v.toString(16).padStart(8, '0')).join('');
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function decode(bytes) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), latin: false }; }
  catch { return { text: new TextDecoder('windows-1252').decode(bytes), latin: true }; }
}

/* ---- the folder as a whole ---- */

/** Every file below `from` a bot could be made of, without going near node_modules and friends. */
async function survey(tree, from, keepTarget) {
  const files = [], skippedDirs = new Set(), queue = [from];
  let junkFiles = 0;
  while (queue.length && files.length < SURVEY_LIMIT) {
    const dir = queue.shift();
    for (const e of await tree.list(dir)) {
      const path = join(dir, e.name);
      if (e.dir) {
        if ((JUNK_DIRS.has(e.name) && !(keepTarget && e.name === 'target')) || e.name.startsWith('.')) skippedDirs.add(e.name);
        else queue.push(path);
      } else if (JUNK_FILE.test(e.name)) junkFiles++;
      else files.push({ path, modified: e.modified });
    }
  }
  return { files, skippedDirs: [...skippedDirs].sort(), junkFiles };
}

/** A zip from GitHub unpacks as bot-main/bot-main/...: walks down while a folder is only a wrapper round one other. */
async function unwrap(tree) {
  let at = '';
  for (let depth = 0; depth < 6; depth++) {
    const here = await tree.list(at);
    const dirs = here.filter(e => e.dir && !e.name.startsWith('.') && !JUNK_DIRS.has(e.name));
    if (dirs.length !== 1 || here.some(e => !e.dir && /\.(js|json|wasm)$/i.test(e.name)) || ['src', 'dist', 'build', 'out', 'lib'].includes(dirs[0].name)) break;
    at = join(at, dirs[0].name);
  }
  return at;
}

/** Where a bot could start, best first. */
async function candidates(tree, base, found) {
  const out = [], add = path => { if (path !== null && !out.includes(path)) out.push(path); };
  const opened = await tree.open(join(base, 'package.json'));
  let pkg = null;
  if (opened) { try { pkg = JSON.parse(decode(opened.bytes).text); } catch { /* a broken package.json says nothing */ } }
  const main = typeof pkg?.main === 'string' ? normal(join(base, pkg.main)) : null;
  if (main !== null) for (const path of [main, `${main}.js`, `${main}/index.js`]) if (/\.c?js$/.test(path) && !JUNK_FILE.test(baseName(path)) && await tree.open(path)) add(path);
  const declared = out.length > 0;
  for (const dir of ENTRY_DIRS) add(join(join(base, dir), 'main.js'));
  for (const dir of ['', 'src', 'dist', 'lib']) add(join(join(base, dir), 'index.js'));
  const existing = [];
  for (const path of out) if (await tree.open(path)) existing.push(path);
  const js = found.filter(f => ['js', 'cjs'].includes(ext(f.path))).map(f => f.path).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const path of js) if (baseName(path) === 'main.js' && !existing.includes(path)) existing.push(path);
  return { list: existing, js, pkg, declared };
}

function stopWith(code, title, body, more = {}) {
  return { stop: { code, title, body }, modules: null, files: [], skipped: more.skipped ?? { folders: [], files: 0, unused: [] }, problems: [], rewrites: [], ...more };
}

function languageOf(found) {
  const counts = {};
  for (const { path } of found) { const name = /\.d\.ts$/.test(path) ? null : LANGUAGES[ext(path)]; if (name) counts[name] = (counts[name] ?? 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Module names for every included file. Keeps a name stable, and only moves what the server would refuse or overwrite. */
function assignNames(paths, entry, root, base, sep) {
  const names = new Map(), taken = new Set(['main']), renamed = [];
  names.set(entry, 'main');
  for (const path of paths) {
    if (path === entry) continue;
    const inPackage = path.includes('node_modules/') ? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length) : null;
    const relative = inPackage ?? (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path);
    const stem = relative.replace(/\.(c?js|wasm)$/i, '');
    const flat = stem.replace(/[/\\]/g, sep).replace(/\$/g, '_').replace(/^[.@]+/, '') || 'module';
    let name = RESERVED.has(flat) || flat === 'main' ? `${flat}_bot` : flat;
    for (let i = 2; taken.has(name); i++) name = `${flat}_${i}`;
    if (name !== flat) renamed.push({ path, from: flat, to: name });
    taken.add(name);
    names.set(path, name);
  }
  return { names, renamed };
}

/** Which modules are in a require cycle, over Tarjan's strongly connected components. */
function cycles(edges) {
  const index = new Map(), low = new Map(), on = new Set(), stack = [], groups = [];
  let next = 0;
  const visit = v => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const group = [];
      let w;
      do { w = stack.pop(); on.delete(w); group.push(w); } while (w !== v);
      if (group.length > 1 || (edges.get(v) ?? []).includes(v)) groups.push(group);
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return groups;
}

/** Where a cycle's one line can go without undoing a 'use strict' above it. */
function afterDirectives(text) {
  const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:(?:'[^'\n]*'|"[^"\n]*")\s*;?[ \t]*)+/.exec(text);
  return m ? m[0].length : 0;
}

/**
 * tree: see above. Returns:
 *   stop      null, or { code, title, body } when nothing can be uploaded
 *   modules   { name: text | { binary } }, ready for the server
 *   entry     the file that became main, root the folder it was in
 *   files     [{ module, from, kind, bytes, sha256 }], the list the page shows and keeps
 *   skipped   { folders, files, unused }
 *   rewrites  [{ file, line, from, to }]
 *   problems  [{ level: 'warn' | 'note', code, text, file?, line? }]
 *   units     the size as the server measures it, hash the server's own hash of the same modules
 *   summary   what happened, in plain sentences
 */
export async function resolveBot(tree, { entry: chosen = null } = {}) {
  const base = await unwrap(tree);
  const keepTarget = !!(await tree.open(join(base, 'target/main.js')));
  const { files: found, skippedDirs, junkFiles } = await survey(tree, base, keepTarget);
  const skipped = { folders: skippedDirs, files: junkFiles, unused: [] };
  const language = languageOf(found);
  const texts = new Map();
  const read = async path => {
    if (SECRET_FILE.test(path)) return null;
    if (!texts.has(path)) {
      const opened = await tree.open(path);
      if (!opened) { texts.set(path, null); return null; }
      const { text, latin } = decode(opened.bytes);
      const clean = text.replace(/^﻿/, '').replace(/^#!/, '//');
      const scanned = scan(clean);
      // a second, plain look: a scanner that lost its place must not cost a module. It can only add, never remove.
      if (!scanned.shadowed && /\.c?js$/i.test(path)) {
        for (const m of clean.matchAll(/\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
          const start = m.index + m[0].indexOf(m[1]) + 1;
          if (!scanned.sites.some(s => s.start === start)) scanned.sites.push({ spec: m[2], start, end: start + m[2].length, line: clean.slice(0, m.index).split('\n').length, inTry: false, plain: true });
        }
      }
      texts.set(path, { text: clean, latin, bytes: opened.bytes, modified: opened.modified, scan: scanned });
    }
    return texts.get(path);
  };

  const { list, js, pkg, declared } = await candidates(tree, base, found);
  let entry = null, esmEntry = null, blank = null;
  for (const path of chosen ? [chosen] : list) {
    const file = await read(path);
    if (!file) continue;
    if (!file.text.trim()) { blank ??= path; continue; }
    if (file.scan.esm) { esmEntry ??= path; continue; }
    if (esmEntry && !BUILT.test(path)) break;      // past a modern main.js only to a build of it, never to an old copy
    entry = path;
    break;
  }
  const inBuilt = p => /(^|\/)(dist|build|out|output)\//.test(p);
  if (!entry) {                                    // no conventional name: the file that exports loop is the bot
    for (const path of js) {
      if (esmEntry && !inBuilt(path)) continue;
      const file = await read(path);
      if (file?.scan.esm) { esmEntry ??= path; continue; }
      if (file && file.text.trim() && /\b(module\.)?exports\.loop\b/.test(file.text)) { entry = path; break; }
    }
  }
  if (!entry) {                                    // one built file, however minified, is the build
    const only = js.filter(inBuilt);
    if (only.length === 1) { const f = await read(only[0]); if (f?.text.trim() && !f.scan.esm) entry = only[0]; }
  }
  if (!entry && js.length === 1 && !esmEntry && !blank) entry = js[0];
  if (entry && !chosen && !declared) {             // two bots, side by side: one click's worth of question
    const mains = [];
    for (const path of js) if (baseName(path) === 'main.js') { const f = await read(path); if (f && f.text.trim() && !f.scan.esm && baseName(dirName(path)) !== 'sim') mains.push(path); }
    const project = p => dirName(p).replace(/(^|\/)(src|dist|build|out|output|lib|scripts|code|bot|default)$/, '');
    const built = new Set(mains.filter(p => BUILT.test(p)).map(project));
    const rivals = mains.filter(p => BUILT.test(p) || !built.has(project(p)));
    if (rivals.length > 1) {
      const times = new Map(found.map(f => [f.path, f.modified]));
      const choices = rivals.sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0)).slice(0, 4);
      return stopWith('which', 'Which bot?', `There are ${plural(rivals.length, 'bot')} in this folder. Pick the one to upload.`, { skipped, choices });
    }
  }
  if (!entry) {
    if (esmEntry && !language) {
      return stopWith('esm', 'This bot still needs building', `${esmEntry} uses import and export, which the game cannot run. It needs its build step once on your computer, usually npm install and then npm run build. Then drop the folder here again.`, { skipped });
    }
    if (language) {
      const how = language === 'TypeScript' ? 'usually npm install and then npm run build, which makes a dist folder' : language === 'Rust' ? 'usually cargo screeps build, or the command in its README' : 'the steps are in its README';
      return stopWith('needs-build', 'This bot still needs building', `It is written in ${language}, and the game only runs JavaScript and WebAssembly. There is no built copy in this folder. Build it once on your computer (${how}), then drop the folder here again.`, { skipped, language });
    }
    if (blank) return stopWith('blank', 'Your main file is empty', `${blank} has nothing in it.`, { skipped });
    if (found.some(f => ext(f.path) === 'wasm')) return stopWith('wasm-alone', 'This WebAssembly needs a main.js', 'The game starts every bot from JavaScript. Add a main.js that loads your .wasm file, or drop the folder that already has one.', { skipped });
    if (js.length) return stopWith('no-entry', 'Which file starts your bot?', `There are ${plural(js.length, 'JavaScript file')} here, but none is called main.js and none exports loop. Rename the one that starts your bot to main.js, then drop the folder here again.`, { skipped });
    return stopWith('empty', 'No bot in this folder', 'There is no JavaScript or WebAssembly here. Drop the folder that holds main.js. No bot yet? Use the starter-bot folder from the Krebs zip.', { skipped });
  }

  const root = dirName(entry);
  const inRoot = found.filter(f => !root || f.path === root || f.path.startsWith(`${root}/`));
  const flat = new Map(), stems = new Map();
  const index = (key, path) => { if (!flat.has(key)) flat.set(key, path); };
  for (const { path } of [...inRoot, ...found]) {
    if (!/\.(c?js|wasm|map)$/i.test(path)) continue;
    const from = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
    const stem = from.replace(/\.(c?js|wasm)$/i, '');
    index(stem, path); index(stem.replace(/\//g, '.'), path); index(stem.replace(/\//g, '_'), path); index(from, path);
    const short = baseName(stem);
    stems.set(short, [...(stems.get(short) ?? []), path]);
  }
  const unique = spec => (stems.get(spec)?.length === 1 ? stems.get(spec)[0] : null);

  const exists = async path => !!path && !SECRET_FILE.test(path) && !!(await tree.open(path));
  const asFile = async path => {
    for (const p of [path, `${path}.js`, `${path}.cjs`, `${path}.json`, `${path}.wasm`, `${path}/index.js`]) if (await exists(p)) return p;
    return null;
  };
  const inPackage = async (spec, from) => {
    const parts = spec.split('/'), name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
    const places = [];
    for (let d = dirName(from); ; d = dirName(d)) { places.push(join(d, `node_modules/${name}`)); if (!d) break; }
    if (!places.includes(join(base, `node_modules/${name}`))) places.push(join(base, `node_modules/${name}`));
    for (const place of places) {
      if (sub) { const f = await asFile(join(place, sub)); if (f) return f; continue; }
      const opened = await tree.open(`${place}/package.json`);
      if (opened) {
        let main = 'index.js';
        try { main = JSON.parse(decode(opened.bytes).text).main ?? main; } catch { /* the default stands */ }
        const f = await asFile(normal(join(place, main)) ?? place);
        if (f) return f;
      }
      const f = await asFile(`${place}/index`);
      if (f) return f;
    }
    return null;
  };
  const relative = spec => /^\.{1,2}(\/|$)/.test(spec);
  const resolve = async (spec, from) => {
    const to = await resolveName(spec, from);
    if (to.path === from) { const twin = from.replace(/\.c?js$/i, '.wasm'); if (await exists(twin)) return { path: twin }; }
    return to;
  };
  const resolveName = async (spec, from) => {
    if (SECRET_FILE.test(normal(join(dirName(from), spec)) ?? spec)) return { secret: true };
    if (relative(spec) || spec.startsWith('/')) {
      const path = spec.startsWith('/') ? normal(spec) : normal(join(dirName(from), spec));
      if (path !== null) { const f = await asFile(path); if (f) return { path: f }; }
    }
    const bare = spec.replace(/^(\.\/)+/, '').replace(/\.js$/, '');
    if (relative(bare)) return { none: true };
    if (bare === 'lodash' && !relative(spec)) return { builtin: true };
    if (flat.has(bare)) return { path: flat.get(bare) };
    if (unique(bare)) return { path: unique(bare), guessed: true };
    if (bare === 'team') return { builtin: true };
    if (!relative(spec)) {
      const f = await inPackage(bare, from);
      if (f) return { path: f, fromPackage: true };
      if (NODE_ONLY.has(bare.replace(/^node:/, ''))) return { node: true };
    }
    return { none: true };
  };

  // Everything reachable from the entry, then everything else if a computed require means reach cannot be known
  const edges = new Map(), resolved = new Map(), problems = [];
  const walk = async start => {
    const queue = [start];
    while (queue.length) {
      const path = queue.shift();
      if (edges.has(path)) continue;
      edges.set(path, []);
      if (/\.(wasm|json|map)$/i.test(path)) continue;
      const file = await read(path);
      if (!file) continue;
      for (const site of file.scan.sites) {
        if (site.spec === undefined) continue;
        const to = file.scan.shadowed ? { self: true } : await resolve(site.spec, path);
        resolved.set(`${path}:${site.start}`, to);
        if (to.path) { edges.get(path).push(to.path); queue.push(to.path); }
      }
    }
  };
  await walk(entry);
  const hard = new Set(edges.keys());
  const files = new Map(), computed = [];
  for (const path of edges.keys()) { const f = /\.(wasm)$/i.test(path) ? null : await read(path); if (f && (f.scan.aliased || f.scan.sites.some(s => s.spec === undefined))) computed.push(path); }
  // The whole of the bot's folder goes up, used or not: not every require can be seen from here
  for (const { path } of inRoot) {
    if (['js', 'cjs', 'wasm', 'map'].includes(ext(path))) await walk(path);
  }
  const paths = [];
  for (const path of edges.keys()) {
    const f = /\.wasm$/i.test(path) ? null : await read(path);
    if (f?.scan.esm && !/\.(json|map)$/i.test(path)) {
      if (hard.has(path)) return stopWith('esm', 'This bot still needs building', `${path} uses import and export on line ${f.scan.esm}, which the game cannot run. It needs its build step once on your computer, usually npm install and then npm run build. Then drop the folder here again.`, { skipped });
      problems.push({ level: 'note', code: 'left-out-esm', file: path, text: `${path} uses import and export, and nothing here needs it, so it stayed behind.` });
      skipped.unused.push(path);
      continue;
    }
    paths.push(path);
  }
  // Quorum and friends flatten with _ and build names at run time: the prefix says which, and the literal requires follow it
  const tops = new Set(found.map(f => (root && f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : f.path).split('/')[0]));
  const underscore = computed.some(p => texts.get(p)?.scan.sites.some(s => s.spec === undefined && s.prefix?.endsWith('_') && tops.has(s.prefix.slice(0, -1))));
  const sep = underscore ? '_' : '.';
  const { names, renamed } = assignNames(paths, entry, root, base, sep);
  for (const path of computed) {
    const f = await read(path);
    for (const site of f.scan.sites) {
      if (site.spec !== undefined) continue;
      const want = site.prefix?.endsWith('/') && relative(site.prefix) ? (normal(join(dirName(path), site.prefix)) ?? '').replace(new RegExp(`^${root ? `${root}/` : ''}`), '').replace(/\//g, sep) : (site.prefix ?? '').replace(/^\.\//, '');
      const sure = want && [...names.values()].some(n => n.startsWith(want));
      problems.push(sure
        ? { level: 'note', code: 'computed', file: path, line: site.line, text: `${path} line ${site.line} builds a module name while it runs. Modules starting ${want} are all here.` }
        : { level: 'warn', code: 'computed', file: path, line: site.line, text: `${path} line ${site.line} builds a module name while it runs, so we could not check it. Nothing was left out.` });
    }
    if (f.scan.aliased) problems.push({ level: 'note', code: 'aliased', file: path, text: `${path} passes require around, so nothing was left out.` });
  }
  for (const [path, file] of texts) {
    if (!file || !edges.has(path) || !paths.includes(path)) continue;
    for (const use of file.scan.uses) {
      if (use.name === 'WebAssembly.instantiate') problems.push({ level: 'warn', code: 'wasm-async', file: path, line: use.line, text: `${path} line ${use.line} uses WebAssembly.instantiate, which does not finish in the game. Use new WebAssembly.Instance.` });
      else if (![...texts.values()].some(t => t && new RegExp(`(global|globalThis|self)\\.${use.name}\\s*=|class ${use.name}\\b|function ${use.name}\\b`).test(t.text))) problems.push({ level: 'warn', code: 'no-text-coder', file: path, line: use.line, text: `${path} line ${use.line} needs ${use.name}, which the game does not have. Your bot will crash when it reaches that line.` });
    }
  }
  for (const { path, from, to } of renamed) {
    if (RESERVED.has(from)) problems.push({ level: 'note', code: 'reserved', file: path, text: `${path} became the module ${to}, because the server keeps the name ${from} for itself.` });
    else if (from !== to && from !== 'main') problems.push({ level: 'note', code: 'renamed', file: path, text: `${path} became the module ${to}, because another file already had the name ${from}.` });
  }

  const inCycle = new Set(), cycleGroups = cycles(edges);
  for (const group of cycleGroups) group.forEach(p => inCycle.add(p));

  // Rewrites, right to left within a file so the positions stay good
  const rewrites = [], modules = new Map();
  for (const path of paths) {
    const name = names.get(path), kind = ext(path);
    if (kind === 'wasm') {
      const opened = await tree.open(path);
      modules.set(name, { binary: base64(opened.bytes) });
      files.set(name, { module: name, from: path, kind: 'wasm', bytes: opened.bytes.length, sha256: sha256(opened.bytes) });
      continue;
    }
    const file = await read(path);
    if (!file) continue;
    if (kind === 'json' || kind === 'map') {
      try { JSON.parse(file.text); }
      catch { problems.push({ level: 'warn', code: 'bad-json', file: path, text: `${path} is not valid JSON, so the code that needs it will fail.` }); }
      const text = `module.exports = ${file.text.trim() || 'null'};\n`;
      modules.set(name, text);
      files.set(name, { module: name, from: path, kind: kind === 'map' ? 'map' : 'json', bytes: text.length, sha256: sha256(new TextEncoder().encode(text)) });
      continue;
    }
    let text = file.text;
    const edits = [];
    for (const site of file.scan.sites) {
      if (site.spec === undefined) {
        if (site.prefix?.endsWith('/') && relative(site.prefix)) {
          const dir = normal(join(dirName(path), site.prefix));
          if (dir !== null) {
            const to = (root && (dir === root || dir.startsWith(`${root}/`)) ? dir.slice(root.length + 1) : dir).replace(/\//g, sep);
            edits.push({ start: site.start, end: site.end, line: site.line, from: site.prefix, to: to ? `${to}${sep}` : '' });
          }
        }
        continue;
      }
      const to = resolved.get(`${path}:${site.start}`) ?? { none: true };
      if (to.self) continue;
      if (to.path) {
        const target = names.get(to.path);
        if (to.guessed) problems.push({ level: 'note', code: 'guessed', file: path, line: site.line, text: `${path} line ${site.line} asks for ${site.spec}. The only file of that name is ${to.path}, so that is what it gets.` });
        if (SECRET_FILE.test(to.path)) continue;
        if (site.spec.replace(/^\.\//, '') !== target) edits.push({ start: site.start, end: site.end, line: site.line, from: site.spec, to: target });
      } else if (to.builtin) {
        if (site.spec.replace(/^\.\//, '') !== site.spec) edits.push({ start: site.start, end: site.end, line: site.line, from: site.spec, to: site.spec.replace(/^\.\//, '') });
      } else if (to.secret) {
        problems.push({ level: site.inTry ? 'note' : 'warn', code: 'secret', file: path, line: site.line, text: `${path} line ${site.line} asks for ${site.spec}. That file can hold passwords, so it stayed on your computer.` });
      } else if (site.plain) {
        continue;
      } else if (to.node) {
        problems.push({ level: site.inTry ? 'note' : 'warn', code: 'node-only', file: path, line: site.line, text: `${path} line ${site.line} needs ${site.spec}, which exists in Node but not in the game. Your bot may crash when it reaches that line.` });
      } else {
        problems.push({ level: site.inTry ? 'note' : 'warn', code: 'unresolved', file: path, line: site.line, text: `${path} line ${site.line} needs ${site.spec}, which is not in this folder. ${site.inTry ? 'It is inside a try, so the bot should carry on without it.' : 'Your bot will crash when it reaches that line.'}` });
      }
    }
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.to + text.slice(e.end);
      rewrites.unshift({ file: path, line: e.line, from: e.from, to: e.to });
    }
    if (inCycle.has(path)) {                       // the server throws on a module that is still loading; with this it returns what is there, as Node does
      const at = afterDirectives(text);
      text = `${text.slice(0, at)}require.cache[${JSON.stringify(name)}]=module.exports;${text.slice(at)}`;
    }
    if (file.latin) problems.push({ level: 'note', code: 'encoding', file: path, text: `${path} was not saved as UTF-8. It was read as Windows-1252, so check any accented letters.` });
    try { new Function('module', 'exports', 'require', text); }
    catch (e) {
      if (e?.name !== 'SyntaxError') { /* a page's CSP, say: that says nothing about the code */ }
      else if (hard.has(path)) return stopWith('syntax', 'There is a mistake in your code', `${path} cannot be read: ${e.message}. Fix that file.`, { skipped, problems });
      else { problems.push({ level: 'note', code: 'left-out-broken', file: path, text: `${path} cannot be read, and nothing here needs it, so it stayed behind.` }); skipped.unused.push(path); continue; }
    }
    modules.set(name, text);
    files.set(name, { module: name, from: path, kind: 'js', bytes: file.bytes.length, sha256: sha256(new TextEncoder().encode(text)) });
  }

  if (cycleGroups.length) {
    const pairs = cycleGroups.map(g => g.map(baseName).sort().join(', ')).join('; ');
    problems.push({ level: 'note', code: 'circular', text: `These files need each other: ${pairs}. The game refuses that, so each got one small line that makes it work the way Node does.` });
  }
  if (!/\.loop\s*=|exports\[["']loop["']\]|module\.exports\s*=/.test(modules.get('main') ?? '')) problems.push({ level: 'warn', code: 'no-loop', file: entry, text: `${entry} has no loop function, so the game runs the whole file every tick.` });
  if (language && /\.js$/.test(entry)) {
    const sources = found.filter(f => !f.path.startsWith(`${root}/`) && !/\.d\.ts$/.test(f.path) && (LANGUAGES[ext(f.path)] || ext(f.path) === 'js')).sort((a, b) => b.modified - a.modified);
    const built = texts.get(entry)?.modified ?? 0;
    if (built && sources[0]?.modified > built) problems.push({ level: 'warn', code: 'stale-build', file: sources[0].path, text: `You changed ${sources[0].path}, but your bot runs ${entry}. Build it again.` });
  }
  if (pkg?.dependencies?.lodash && !paths.some(p => /node_modules\/lodash\//.test(p)) && [...texts.values()].some(f => f?.scan.sites.some(s => s.spec === 'lodash'))) {
    problems.push({ level: 'note', code: 'lodash', text: 'Your bot gets the game\'s own lodash, version 3.10.1, not the one in node_modules.' });
  }

  // The size, as the server will measure it
  const body = packed(modules);
  const wire = new TextEncoder().encode(body).length;
  if (wire + UPLOAD_FRAME > MAX_BODY) {
    const largest = [...files.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 2).map(f => `${f.from} (${size(f.bytes)})`).join(', ');
    return stopWith('too-large', 'This bot is too big', `It comes to ${size(wire)}, and the limit is 10 MB. The biggest files are ${largest}.`, { skipped, problems });
  }

  const result = {
    stop: null,
    entry, root, base,
    modules: Object.fromEntries(modules),
    files: [...files.values()].sort((a, b) => (a.module === 'main' ? -1 : b.module === 'main' ? 1 : a.module.localeCompare(b.module))),
    skipped, rewrites, problems,
    units: body.length,
    hash: sha256(new TextEncoder().encode(body)),
    language: language && language !== 'TypeScript' ? language : null,
  };
  result.summary = sentences(result);
  return result;
}

/** The modules as the server stores and hashes them: keys sorted, one JSON object. */
function packed(modules) {
  const keys = [...modules.keys()].sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(modules.get(k))}`).join(',')}}`;
}

function size(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

function sentences(r) {
  const out = [`Your bot starts at ${r.entry}.`];
  const wasm = r.files.filter(f => f.kind === 'wasm').length;
  out.push(`${plural(r.files.length, 'file')} ${r.files.length === 1 ? 'makes' : 'make'} up your bot${wasm ? `, ${wasm} of them WebAssembly` : ''}.`);
  const left = [...r.skipped.folders];
  const others = r.skipped.files + r.skipped.unused.length;
  if (left.length) out.push(`Left out ${left.join(', ')}.`);
  if (others) out.push(`Left out ${plural(others, 'other file')} your bot does not use.`);
  if (r.rewrites.length) out.push(`Changed ${plural(r.rewrites.length, 'require line')} so nested folders still work on the server. Your files on disk are not touched.`);
  return out;
}

/** What the upload route takes. */
export function deployBody(result) {
  return JSON.stringify({ modules: result.modules });
}

/** True if nothing that matters changed since `last`: this is what makes a re-drop or a poll send nothing. */
export const sameBot = (result, last) => !!last && result.hash === last.hash;

