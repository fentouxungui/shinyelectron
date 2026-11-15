'use strict';
/**
 * App-layer store for the ShinyApps shell (Electron main process).
 * Zero npm dependencies (Node built-in zlib for zip extraction).
 *
 * Robust bundle download: optional mirror fallback + four parallel range
 * requests + progress + idle timeout + resume + retry + size/checksum
 * verification. update() forwards install progress.
 *
 * Layout under <userData>: state.json, apps/, lib/<runtime>/, private/<runtime>/,
 * store-cache/. Package libraries are scoped by R ABI (e.g. r-4.6) so a future
 * runtime can coexist without mixing binaries.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const { once } = require('events');

const REDIRECT = [301, 302, 303, 307, 308];

function httpGet(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'ShinyApps' }, headers) }, (res) => {
      if (REDIRECT.includes(res.statusCode) && res.headers.location) {
        if (redirects <= 0) { res.resume(); return reject(new Error('too many redirects')); }
        res.resume();
        return resolve(httpGet(res.headers.location, headers, redirects - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('connection timeout')));
  });
}

async function downloadToString(url) {
  const res = await httpGet(url);
  if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode + ' for ' + url); }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function cancelError() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

async function downloadToFileSingle(url, dest, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const expectedSize = opts.expectedSize || 0;
  const idleMs = opts.idleMs || 60000;
  const attempts = opts.attempts || 5;
  const log = opts.log || (() => {});
  const signal = opts.signal || null;
  const part = dest + '.part';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) throw cancelError();
    let start = 0;
    try { start = fs.statSync(part).size; } catch (e) { start = 0; }
    try {
      const res = await httpGet(url, start > 0 ? { Range: `bytes=${start}-` } : {});
      const status = res.statusCode;
      if (start > 0 && status === 200) start = 0;
      if (status !== 200 && status !== 206) { res.resume(); throw new Error('HTTP ' + status + ' for ' + url); }
      const len = Number(res.headers['content-length'] || 0);
      const total = (status === 206 ? start : 0) + len;
      const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
      let received = start;
      let idle = setTimeout(() => res.destroy(new Error('download stalled')), idleMs);
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(idle);
          const e = cancelError();
          try { res.destroy(e); } catch (x) {}
          try { out.destroy(); } catch (x) {}
          reject(e);
        };
        const done = (fn) => (v) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          clearTimeout(idle);
          fn(v);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        res.on('data', (c) => {
          received += c.length;
          clearTimeout(idle);
          idle = setTimeout(() => res.destroy(new Error('download stalled')), idleMs);
          onProgress(total ? received / total : 0, received, total);
        });
        res.pipe(out);
        out.on('finish', done(resolve));
        out.on('error', done(reject));
        res.on('error', done(reject));
      });
      clearTimeout(idle);
      const size = fs.statSync(part).size;
      const want = total || expectedSize;
      if (want && size < want) throw new Error('incomplete download ' + size + '/' + want);
      await fsp.rm(dest, { force: true });
      await fsp.rename(part, dest);
      return size;
    } catch (e) {
      lastErr = e;
      log(`download attempt ${attempt}/${attempts} failed: ${e.message}`);
      onProgress(0, 0, expectedSize);
    }
  }
  // Every attempt failed: do not leave a partial archive in the cache.
  await fsp.rm(part, { force: true }).catch(() => {});
  throw lastErr || new Error('download failed');
}

// ---- Parallel (range) download -------------------------------------------
// GitHub and most mirrors support HTTP Range. One TCP connection often tops
// out at a few hundred KB/s on high-latency links; four ranges in parallel are
// much faster and need no change to the release pipeline.

function segmentedUnsupported(message) {
  const e = new Error(message || 'server does not support parallel range requests');
  e.code = 'SEGMENTED_UNSUPPORTED';
  return e;
}

// Build download candidates: an optional mirror template first, GitHub last.
// `{url}` is replaced by the original URL; a template without it is a prefix.
// The caller still verifies size and SHA-256, so a mirror cannot alter a bundle.
function downloadUrls(original, mirror) {
  const urls = [];
  const template = String(mirror || '').trim();
  if (template) {
    if (template.includes('{url}')) urls.push(template.split('{url}').join(original));
    else urls.push(template.replace(/\/+$/, '') + '/' + original);
  }
  urls.push(original);
  return Array.from(new Set(urls.filter(Boolean)));
}

async function probeDownloadSize(url, signal) {
  if (signal && signal.aborted) throw cancelError();
  const res = await httpGet(url, { Range: 'bytes=0-0' });
  try {
    if (res.statusCode === 206) {
      const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
      if (m) return Number(m[1]);
    } else if (res.statusCode === 200) {
      const len = Number(res.headers['content-length'] || 0);
      if (len) return len;
    }
  } finally {
    try { res.destroy(); } catch (e) {}
  }
  throw segmentedUnsupported('server did not report the file size');
}

async function fetchRangeToFile(url, start, end, file, opts) {
  const want = end - start + 1;
  const attempts = opts.attempts || 3;
  const idleMs = opts.idleMs || 60000;
  const signal = opts.signal || null;
  const onBytes = opts.onBytes || (() => {});
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) throw cancelError();
    let have = 0;
    try { have = fs.statSync(file).size; } catch (e) { have = 0; }
    if (have >= want) return;
    const from = start + have;
    let res;
    try {
      res = await httpGet(url, { Range: `bytes=${from}-${end}` });
    } catch (e) {
      if (attempt === attempts) throw e;
      continue;
    }
    if (res.statusCode !== 206) {
      res.destroy();
      throw segmentedUnsupported('server ignored the Range request (HTTP ' + res.statusCode + ')');
    }
    const m = /bytes\s+(\d+)-(\d+)\//.exec(String(res.headers['content-range'] || ''));
    if (!m || Number(m[1]) !== from) {
      res.destroy();
      throw segmentedUnsupported('unexpected Content-Range from server');
    }
    const out = fs.createWriteStream(file, { flags: have > 0 ? 'a' : 'w' });
    let idle = setTimeout(() => res.destroy(new Error('download stalled')), idleMs);
    try {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(idle);
          const e = cancelError();
          try { res.destroy(e); } catch (x) {}
          try { out.destroy(); } catch (x) {}
          reject(e);
        };
        const done = (fn) => (v) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          clearTimeout(idle);
          fn(v);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        res.on('data', (c) => {
          onBytes(c.length);
          clearTimeout(idle);
          idle = setTimeout(() => res.destroy(new Error('download stalled')), idleMs);
        });
        res.pipe(out);
        out.on('finish', done(resolve));
        out.on('error', done(reject));
        res.on('error', done(reject));
      });
    } catch (e) {
      try { out.destroy(); } catch (x) {}
      if (e && e.code === 'CANCELLED') throw e;
      if (e && e.code === 'SEGMENTED_UNSUPPORTED') throw e;
      if (attempt === attempts) throw e;
      continue;
    } finally {
      clearTimeout(idle);
    }
    if (fs.statSync(file).size - start >= want) return;
    if (attempt === attempts) throw new Error('incomplete segment');
  }
}

async function downloadToFileSegmented(url, dest, opts) {
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal || null;
  const expectedSize = Number(opts.expectedSize || 0);
  const total = expectedSize || await probeDownloadSize(url, signal);
  if (!total) throw segmentedUnsupported('unknown file size');
  if (total < Number(opts.segmentThreshold || 8 * 1024 * 1024)) {
    throw segmentedUnsupported('file is too small to split');
  }
  if (signal && signal.aborted) throw cancelError();

  const connections = Math.max(1, Math.min(8, Number(opts.connections || 4)));
  const partDir = dest + '.parts';
  const part = dest + '.part';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(partDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(partDir, { recursive: true });

  const base = Math.floor(total / connections);
  const segments = [];
  for (let i = 0; i < connections; i++) {
    const start = i * base;
    const end = i === connections - 1 ? total - 1 : start + base - 1;
    if (start > end) continue;
    segments.push({ start, end, file: path.join(partDir, 'seg-' + i) });
  }

  let received = 0;
  onProgress(0, 0, total);
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    await Promise.all(segments.map((s) => fetchRangeToFile(url, s.start, s.end, s.file, {
      signal: controller.signal,
      idleMs: opts.idleMs,
      attempts: opts.attempts || 3,
      onBytes: (len) => {
        received += len;
        onProgress(total ? Math.min(1, received / total) : 0, received, total);
      },
    })));
  } catch (e) {
    controller.abort();
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }

  // Join the segments into the .part file, then rename it into place.
  await fsp.rm(part, { force: true }).catch(() => {});
  const out = fs.createWriteStream(part);
  try {
    for (const s of segments) {
      const rs = fs.createReadStream(s.file);
      for await (const chunk of rs) {
        if (!out.write(chunk)) await once(out, 'drain');
      }
    }
    await new Promise((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
      out.end();
    });
  } catch (e) {
    try { out.destroy(); } catch (x) {}
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  } finally {
    await fsp.rm(partDir, { recursive: true, force: true }).catch(() => {});
  }

  const size = fs.statSync(part).size;
  if (expectedSize && size !== expectedSize) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw new Error('incomplete download ' + size + '/' + expectedSize);
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return size;
}

async function downloadToFile(url, dest, opts = {}) {
  const expectedSize = Number(opts.expectedSize || 0);
  const connections = Math.max(1, Math.min(8, Number(opts.connections || 4)));
  const threshold = Number(opts.segmentThreshold || 8 * 1024 * 1024);
  if (connections > 1 && (!expectedSize || expectedSize >= threshold)) {
    try {
      return await downloadToFileSegmented(url, dest, Object.assign({}, opts, { connections }));
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      (opts.log || (() => {}))(`parallel download unavailable (${e.message}); using one connection`);
      await fsp.rm(dest + '.parts', { recursive: true, force: true }).catch(() => {});
    }
  }
  return downloadToFileSingle(url, dest, opts);
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}

async function copyDir(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Extract a zip on a worker thread so a large bundle never blocks the main
// (UI) process. Progress is reported as uncompressed bytes processed.
function unzip(zipPath, destDir, onProgress = () => {}, signal = null) {
  return new Promise((resolve, reject) => {
    let workerPath = path.join(__dirname, 'unzip-worker.js');
    // backends/ is asarUnpack-ed, so point the worker at the real file.
    workerPath = workerPath.replace('app.asar', 'app.asar.unpacked');
    let worker;
    try {
      worker = new Worker(workerPath, { workerData: { zipPath, destDir, limits: ZIP_LIMITS } });
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch (e) { /* best effort */ }
      if (err) reject(err); else resolve();
    };
    if (signal) {
      if (signal.aborted) { finish(cancelError()); return; }
      signal.addEventListener('abort', () => finish(cancelError()), { once: true });
    }
    worker.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'progress') {
        onProgress({
          phase: 'unpacking',
          percent: msg.percent,
          statusText: 'Unpacking ' + msg.processed + ' / ' + msg.total + ' files',
        });
      } else if (msg.type === 'done') {
        finish(null);
      } else if (msg.type === 'error') {
        finish(new Error(msg.message || 'unpack failed'));
      }
    });
    worker.on('error', (err) => finish(err));
    worker.on('exit', (code) => { if (code !== 0) finish(new Error('unpack worker exited with code ' + code)); else finish(null); });
  });
}

// Free bytes on the volume holding dir, or null when unsupported.
async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch (e) {
    return null;
  }
}

function platformKey() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return `win-${a}`;
  if (p === 'darwin') return `mac-${a}`;
  return `linux-${a}`;
}

// Bundle safety limits (zip-bomb / disk-exhaustion guards).
const ZIP_LIMITS = {
  maxEntries: 500000,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024 * 1024,
};

// Compact metadata persisted with every install so a sideloaded (non-catalog)
// app can still show its name/homepage/etc. without a catalog entry.
function bundleMeta(m) {
  return {
    name: m.name || m.id,
    description: m.description || '',
    homepage: m.homepage || '',
    author: m.author || '',
    license: m.license || '',
    rVersion: m.r_version || '',
    rAbi: m.r_abi || rAbiFromVersion(m.r_version),
    runtime: m.runtime || '',
    entry: m.entry || '',
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const BUNDLE_PLATFORMS = ['win-x64', 'win-arm64', 'mac-x64', 'mac-arm64', 'linux-x64'];
const CURRENT_STATE_SCHEMA = 2;

function validateManifest(m) {
  const bad = (msg) => { const e = new Error('invalid manifest: ' + msg); e.step = 'install'; return e; };
  if (!m || typeof m !== 'object') throw bad('not an object');
  if (m.schema !== 1) throw bad('unsupported schema ' + m.schema);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw bad('bad id');
  if (typeof m.name !== 'string' || !m.name) throw bad('missing name');
  if (typeof m.version !== 'string' || !m.version) throw bad('missing version');
  if (BUNDLE_PLATFORMS.indexOf(m.platform) === -1) throw bad('bad platform');
  if (typeof m.entry !== 'string' || !m.entry) throw bad('missing entry');
  if (typeof m.r_version !== 'string' || !m.r_version) throw bad('missing r_version');
  if (m.r_abi !== undefined && (typeof m.r_abi !== 'string' || !/^\d+\.\d+$/.test(m.r_abi))) {
    throw bad('bad r_abi');
  }
  if (!Array.isArray(m.packages)) throw bad('packages must be an array');
  for (const p of m.packages) {
    if (!p || typeof p.name !== 'string' || typeof p.version !== 'string' || typeof p.path !== 'string') {
      throw bad('bad package entry');
    }
  }
}

function assertInside(root, rel) {
  const target = path.resolve(root, rel || '');
  if (target !== root && !target.startsWith(root + path.sep)) {
    const e = new Error('manifest path escapes bundle: ' + rel); e.step = 'install'; throw e;
  }
}

function readDescriptionField(dir, field) {
  try {
    const text = fs.readFileSync(path.join(dir, 'DESCRIPTION'), 'utf8');
    const match = text.match(new RegExp('^' + field + ':\\s*(.+)$', 'm'));
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

// Packages the bundled R already provides: base and recommended only. The
// shell's runtime library also holds shiny/zip and their dependencies; those
// are not included here because app bundles may legitimately pin their own
// versions of ordinary packages.
function readRuntimePackages(runtimeLibrary, log) {
  const out = new Map();
  if (!runtimeLibrary) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(runtimeLibrary);
  } catch (e) {
    if (typeof log === 'function') log(`warn: cannot read runtime library ${runtimeLibrary}: ${e && e.message}`);
    return out;
  }
  for (const name of entries) {
    const dir = path.join(runtimeLibrary, name);
    if (!fs.existsSync(path.join(dir, 'DESCRIPTION'))) continue;
    const priority = readDescriptionField(dir, 'Priority').toLowerCase();
    if (priority !== 'base' && priority !== 'recommended') continue;
    out.set(name, {
      version: readDescriptionField(dir, 'Version'),
      priority: priority
    });
  }
  if (typeof log === 'function' && out.size) {
    log(`runtime packages: ${out.size} base/recommended from ${runtimeLibrary}`);
  }
  return out;
}

// ---- Runtime / ABI helpers ------------------------------------------------
// R patch releases share a minor ABI ("4.6"); a new minor ("4.7") needs its own
// runtime and package library. Runtime ids are used in paths and state keys so
// packages built for different R minors can never be mixed.
function rAbiFromVersion(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  return m ? m[1] + '.' + m[2] : '';
}
function runtimeIdFromVersion(version) {
  const abi = rAbiFromVersion(version);
  return abi ? 'r-' + abi : '';
}
function runtimeIdFromAbi(abi) {
  return /^\d+\.\d+$/.test(String(abi || '')) ? 'r-' + abi : '';
}
function splitSharedKey(key) {
  const s = String(key || '');
  const i = s.indexOf('/');
  if (i > 0 && i < s.length - 1) {
    return { runtime: s.slice(0, i), name: s.slice(i + 1) };
  }
  return { runtime: '', name: s };
}
function joinSharedKey(runtimeId, name) {
  return String(runtimeId || '') + '/' + String(name || '');
}
// Find Rscript inside a runtime root: <root>/bin/Rscript,
// <root>/portable-r-.../bin/Rscript, or <root>/<version>/bin/Rscript.
function findRscriptInRuntime(root) {
  if (!root || !fs.existsSync(root)) return '';
  const exe = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript';
  const direct = path.join(root, 'bin', exe);
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return ''; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const first = path.join(root, entry.name, 'bin', exe);
    if (fs.existsSync(first)) return first;
    let subs = [];
    try { subs = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }); } catch (e) { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const second = path.join(root, entry.name, sub.name, 'bin', exe);
      if (fs.existsSync(second)) return second;
    }
  }
  return '';
}

function createAppStore(options) {
  const { startBackend, shellVersion = '', shellRVersion = '', log = () => {}, getDownloadMirror = () => '', runtimeLibrary = '', runtimeRoot = '' } = options;
  // Data root holds the installed apps + libraries. Defaults to the Electron
  // userData dir for backward compatibility; the shell passes an explicit,
  // user-configurable dataRoot (e.g. %LOCALAPPDATA%\ShinyApps).
  const dataRoot = options.dataRoot || options.userDataDir;
  let catalogUrl = options.catalogUrl;

  const statePath = path.join(dataRoot, 'state.json');
  const appsDir = path.join(dataRoot, 'apps');
  const sharedLib = path.join(dataRoot, 'lib');
  const privateRoot = path.join(dataRoot, 'private');
  const cacheDir = path.join(dataRoot, 'store-cache');
  const catalogCachePath = path.join(dataRoot, 'catalog-cache.json');
  const iconCacheDir = path.join(dataRoot, 'icons');
  const iconIndexPath = path.join(iconCacheDir, 'index.json');

  const runtimeAbi = options.runtimeAbi || rAbiFromVersion(shellRVersion) || '4.6';
  const shellRuntimeId = options.runtimeId || runtimeIdFromAbi(runtimeAbi) || 'r-4.6';
  const shellRuntimeRoot = runtimeRoot || (runtimeLibrary ? path.dirname(runtimeLibrary) : '');
  const shellRuntime = {
    id: shellRuntimeId,
    abi: runtimeAbi,
    version: shellRVersion || '',
    root: shellRuntimeRoot,
    rscript: options.runtimeRscript || findRscriptInRuntime(shellRuntimeRoot),
    library: runtimeLibrary || (shellRuntimeRoot ? path.join(shellRuntimeRoot, 'library') : ''),
    source: 'shell',
  };
  const runtimePackagesByRuntime = new Map();
  runtimePackagesByRuntime.set(shellRuntimeId, readRuntimePackages(shellRuntime.library, log));

  function sharedRoot(runtimeId) {
    return path.join(sharedLib, runtimeId || shellRuntimeId);
  }
  function privateRootFor(runtimeId) {
    return path.join(privateRoot, runtimeId || shellRuntimeId);
  }
  function privateDirFor(runtimeId, appId) {
    return path.join(privateRootFor(runtimeId), appId);
  }
  function runtimePackagesFor(runtimeId) {
    return runtimePackagesByRuntime.get(runtimeId) || new Map();
  }
  function abiForRuntime(runtimeId) {
    if (runtimeId === shellRuntimeId) return shellRuntime.abi;
    const rec = state.runtimes && state.runtimes[runtimeId];
    return (rec && rec.abi) || '';
  }

  for (const d of [appsDir, sharedLib, privateRoot, sharedRoot(shellRuntimeId), privateRootFor(shellRuntimeId), cacheDir, iconCacheDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  let state = loadState();
  let stateChanged = false;
  // Older or hand-edited state files may miss a section; every code path below
  // assumes all maps exist.
  if (!state || typeof state !== 'object') { state = { schema: 2, apps: {}, shared: {}, runtimes: {} }; stateChanged = true; }
  if (!state.apps || typeof state.apps !== 'object') { state.apps = {}; stateChanged = true; }
  if (!state.shared || typeof state.shared !== 'object') { state.shared = {}; stateChanged = true; }
  if (!state.runtimes || typeof state.runtimes !== 'object') { state.runtimes = {}; stateChanged = true; }

  const previousSchema = Number(state.schema) || 1;
  if (previousSchema > CURRENT_STATE_SCHEMA) {
    const e = new Error(
      'This local store was created by a newer ShinyApps (state schema ' +
      previousSchema + '). Downgrading is not supported; install the newer ' +
      'ShinyApps build, or reset local data after backing up your apps.'
    );
    e.code = 'STATE_SCHEMA_TOO_NEW';
    throw e;
  }
  if (previousSchema < 2 && fs.existsSync(statePath)) {
    // One-time safety copy before moving libraries and state keys.
    try { fs.copyFileSync(statePath, statePath + '.v1.bak'); } catch (e) { /* best effort */ }
  }
  for (const rec of Object.values(state.apps)) {
    if (!rec || typeof rec !== 'object') continue;
    const abi = rec.r_abi || rAbiFromVersion(rec.r_version) || runtimeAbi;
    if (!rec.r_abi) { rec.r_abi = abi; stateChanged = true; }
    if (!rec.runtime) { rec.runtime = runtimeIdFromAbi(abi) || shellRuntimeId; stateChanged = true; }
  }

  // Schema 1 predates runtime-scoped libraries. Move its flat entries into the
  // shell runtime and relocate the existing package directories once, so an
  // in-place shell update keeps every installed app runnable.
  if (previousSchema < 2) {
    const migratedShared = {};
    for (const [key, entry] of Object.entries(state.shared)) {
      const parsed = splitSharedKey(key);
      if (parsed.runtime) {
        migratedShared[key] = entry;
        continue;
      }
      const next = Object.assign({}, entry || {});
      next.runtime = shellRuntimeId;
      next.r_abi = runtimeAbi;
      migratedShared[joinSharedKey(shellRuntimeId, parsed.name)] = next;
      stateChanged = true;
    }
    state.shared = migratedShared;

    const runtimes = new Set([shellRuntimeId]);
    for (const rec of Object.values(state.apps)) {
      if (rec && rec.runtime) runtimes.add(rec.runtime);
    }
    for (const runtime of runtimes) {
      const targetLib = sharedRoot(runtime);
      fs.mkdirSync(targetLib, { recursive: true });
      let names = [];
      try { names = fs.readdirSync(sharedLib); } catch (e) { names = []; }
      for (const name of names) {
        // Do not move a runtime directory into itself; only legacy package
        // directories are relocated.
        if (name === runtime || /^r-\d+\.\d+$/.test(name)) continue;
        const src = path.join(sharedLib, name);
        const dst = path.join(targetLib, name);
        if (fs.existsSync(dst)) continue;
        let isDir = false;
        try { isDir = fs.statSync(src).isDirectory(); } catch (e) { isDir = false; }
        if (!isDir) continue;
        try {
          fs.renameSync(src, dst);
          stateChanged = true;
        } catch (e) {
          try {
            fs.cpSync(src, dst, { recursive: true });
            stateChanged = true;
          } catch (e2) { /* keep legacy copy; reconcile will report it */ }
        }
      }
      const targetPrivate = privateRootFor(runtime);
      fs.mkdirSync(targetPrivate, { recursive: true });
      for (const id of Object.keys(state.apps)) {
        const rec = state.apps[id];
        if ((rec.runtime || shellRuntimeId) !== runtime) continue;
        const src = path.join(privateRoot, id);
        const dst = path.join(targetPrivate, id);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        try {
          fs.renameSync(src, dst);
          stateChanged = true;
        } catch (e) {
          try {
            fs.cpSync(src, dst, { recursive: true });
            stateChanged = true;
          } catch (e2) { /* keep legacy copy; reconcile will report it */ }
        }
      }
    }
    state.schema = 2;
    stateChanged = true;
  }

  state.runtimes[shellRuntimeId] = Object.assign({}, state.runtimes[shellRuntimeId], {
    abi: shellRuntime.abi,
    version: shellRuntime.version,
    source: 'shell',
  });
  for (const entry of Object.values(state.shared)) {
    if (entry && !Array.isArray(entry.refs)) entry.refs = [];
  }
  if (stateChanged) {
    try { saveState(); } catch (e) { log('warn: could not save migrated state:', e && e.message); }
  }

  function runtimeInfo(runtimeId) {
    if (!runtimeId || runtimeId === shellRuntimeId) return shellRuntime;
    const rec = state.runtimes && state.runtimes[runtimeId];
    if (!rec) return null;
    const root = rec.path || '';
    const rscript = rec.rscript || findRscriptInRuntime(root);
    const library = rec.library || (root ? path.join(root, 'library') : '');
    if (!rscript || !fs.existsSync(rscript)) return null;
    if (!runtimePackagesByRuntime.has(runtimeId)) {
      runtimePackagesByRuntime.set(runtimeId, readRuntimePackages(library, log));
    }
    return {
      id: runtimeId,
      abi: rec.abi || rAbiFromVersion(rec.version),
      version: rec.version || '',
      root: root,
      rscript: rscript,
      library: library,
      source: rec.source || 'downloaded',
    };
  }
  function runtimeForApp(rec, manifest) {
    const abi = (rec && rec.r_abi) ||
      (manifest && manifest.r_abi) ||
      rAbiFromVersion(manifest && manifest.r_version) ||
      (rec && rAbiFromVersion(rec.r_version)) ||
      shellRuntime.abi;
    const id = (rec && rec.runtime) || runtimeIdFromAbi(abi) || shellRuntimeId;
    return runtimeInfo(id);
  }
  function requireRuntime(rec, manifest) {
    const runtime = runtimeForApp(rec, manifest);
    if (runtime) return runtime;
    const abi = (rec && rec.r_abi) ||
      (manifest && manifest.r_abi) ||
      rAbiFromVersion(manifest && manifest.r_version) || '';
    const e = new Error('app needs the R ' + (abi || 'runtime') +
      ' runtime, but it is not installed');
    e.step = 'resolve';
    e.code = 'RUNTIME_MISSING';
    throw e;
  }

  function artifactAbi(art, entry) {
    return (art && art.r_abi) ||
      (entry && entry.r_abi) ||
      rAbiFromVersion(art && art.r_version) ||
      rAbiFromVersion(entry && entry.r_version) || '';
  }
  // Pick the artifact for a platform. Prefer the requested runtime; otherwise
  // use an installed runtime, then the highest declared runtime. The return
  // value includes the runtime id even when that runtime is not installed, so
  // the caller can report RUNTIME_MISSING instead of "no bundle".
  function chooseArtifact(entry, plat, preferredRuntimeId) {
    const byRuntime = entry && entry.artifacts_by_runtime && entry.artifacts_by_runtime[plat];
    if (byRuntime && typeof byRuntime === 'object') {
      const ids = Object.keys(byRuntime).filter(function (id) { return byRuntime[id]; });
      if (ids.length) {
        if (preferredRuntimeId && byRuntime[preferredRuntimeId]) {
          return { art: byRuntime[preferredRuntimeId], runtimeId: preferredRuntimeId };
        }
        const installed = ids.filter(function (id) { return !!runtimeInfo(id); });
        const pool = installed.length ? installed : ids;
        pool.sort(function (a, b) {
          return cmpVersion(String(b).replace(/^r-/, ''), String(a).replace(/^r-/, ''));
        });
        return { art: byRuntime[pool[0]], runtimeId: pool[0] };
      }
    }
    const legacy = entry && entry.artifacts && entry.artifacts[plat];
    if (legacy) {
      return {
        art: legacy,
        runtimeId: runtimeIdFromAbi(artifactAbi(legacy, entry)) || shellRuntimeId,
      };
    }
    return null;
  }
  function runtimeForEntry(entry, preferredRuntimeId) {
    const picked = chooseArtifact(entry, platformKey(), preferredRuntimeId || '');
    if (!picked) return null;
    const runtime = runtimeInfo(picked.runtimeId);
    if (!runtime) return null;
    return Object.assign({}, runtime, {
      artifactAbi: artifactAbi(picked.art, entry) || runtime.abi,
      artifactRVersion: picked.art.r_version || entry.r_version || '',
    });
  }
  let catalog = null;
  let catalogFetchedAt = 0;
  const CATALOG_TTL_MS = 60000;
  // An unchanged icon URL is revalidated at most once per this interval, so a
  // catalog refresh does not re-download every icon. A changed URL always
  // downloads immediately.
  const ICON_REVALIDATE_MS = 10 * 60 * 1000;
  const running = new Map();
  // Icon cache: catalog icons are remote; cache them so installed cards still
  // show their logo offline. `iconDataCache` holds the base64 data URLs that
  // the launcher receives when the catalog is unavailable.
  let iconIndex = {};
  try { iconIndex = JSON.parse(fs.readFileSync(iconIndexPath, 'utf8')) || {}; } catch (e) { iconIndex = {}; }
  const iconDataCache = new Map();
  let iconCacheRunning = false;
  // Use the last catalog saved on disk until a fresh fetch succeeds.
  loadCatalogCache();

  // Startup self-heal: forget installs and shared entries whose files no
  // longer exist.
  reconcileInstalled();
  reconcileShared();
  cleanupRuntimeShadows();

  function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return { schema: 1, apps: {}, shared: {} }; }
  }
  function saveState() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }

  // Installs may download concurrently, but the shared R library and state.json
  // are global: two workers linking packages at the same time could copy into
  // the same shared/<pkg> directory. Serialize the commit phase (rename +
  // linking + state write) so parallel downloads stay fast while the shared
  // state changes one job at a time. The lock is a simple promise chain; it is
  // not re-entrant, so callers must not nest it.
  let commitChain = Promise.resolve();
  function withCommitLock(fn) {
    const run = commitChain.then(fn, fn);
    commitChain = run.then(function () {}, function () {});
    return run;
  }

  // An install record is only meaningful while its files are still on disk.
  // A record left behind by a partial uninstall, or by a folder deleted by
  // hand, would otherwise be listed by the launcher and fail to start.
  function installedFilesPresent(ins) {
    if (!ins || !ins.dir) return false;
    try {
      if (!fs.existsSync(ins.dir)) return false;
      // A half-removed install can leave the folder but not its contents.
      if (fs.existsSync(path.join(ins.dir, 'app'))) return true;
      return fs.existsSync(path.join(ins.dir, 'manifest.json'));
    } catch (e) { return false; }
  }
  function isInstalled(id) {
    return installedFilesPresent(state.apps && state.apps[id]);
  }
  // An installed R package directory always carries its DESCRIPTION. A folder
  // left half-copied (or deleted) satisfies state.json but cannot be loaded.
  function packagePresent(dir) {
    try { return fs.existsSync(path.join(dir, 'DESCRIPTION')); } catch (e) { return false; }
  }
  // Shared-library records whose folder is gone must not survive: the next
  // install would see a matching version, skip the copy, delete the bundle's
  // own copy, and leave the app unable to load the package.
  function reconcileShared() {
    let changed = false;
    for (const key of Object.keys(state.shared || {})) {
      const parsed = splitSharedKey(key);
      const dir = path.join(sharedRoot(parsed.runtime || shellRuntimeId), parsed.name);
      if (packagePresent(dir)) continue;
      log(`warn: shared package ${key} is missing; dropping its record so the next install restores it`);
      delete state.shared[key];
      changed = true;
    }
    if (!changed) return false;
    try { saveState(); } catch (e) { log('warn: could not save state:', e && e.message); }
    return true;
  }
  // Drop records whose files are gone and release their shared-package refs.
  // Runs at startup so a state.json written by an older/interrupted shell
  // heals itself instead of showing unlaunchable apps forever.
  function reconcileInstalled() {
    let changed = false;
    for (const id of Object.keys(state.apps || {})) {
      if (installedFilesPresent(state.apps[id])) continue;
      log(`warn: ${id} has no installed files; dropping its stale install record`);
      delete state.apps[id];
      changed = true;
    }
    if (!changed) return false;
    for (const entry of Object.values(state.shared || {})) {
      entry.refs = (entry.refs || []).filter((ref) => !!state.apps[ref]);
    }
    try { saveState(); } catch (e) { log('warn: could not save state:', e && e.message); }
    return true;
  }

  // Remove app-layer copies of packages the bundled R already provides.
  // KernSmooth/MASS/... built against a different R.framework otherwise shadow
  // the runtime's own copies at .libPaths() time, which is fatal on macOS.
  function runtimeShadowRemovable(name, dir, runtimeId) {
    const pkg = runtimePackagesFor(runtimeId || shellRuntimeId).get(name);
    if (!pkg) return false;
    if (!fs.existsSync(path.join(dir, 'DESCRIPTION'))) return false;
    if (pkg.priority === 'base') return true;
    const version = readDescriptionField(dir, 'Version');
    return !!pkg.version && version === pkg.version;
  }

  function cleanupRuntimeShadows() {
    let changed = false;
    for (const key of Object.keys(state.shared)) {
      const parsed = splitSharedKey(key);
      const runtimeId = parsed.runtime || shellRuntimeId;
      const dir = path.join(sharedRoot(runtimeId), parsed.name);
      if (!runtimeShadowRemovable(parsed.name, dir, runtimeId)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        delete state.shared[key];
        changed = true;
        log(`removed legacy runtime package ${parsed.name} from the shared library`);
      } catch (e) {
        log(`warn: could not remove shared runtime package ${parsed.name}: ${e && e.message}`);
      }
    }
    for (const id of Object.keys(state.apps)) {
      const rec = state.apps[id];
      const runtimeId = (rec && rec.runtime) || shellRuntimeId;
      for (const name of runtimePackagesFor(runtimeId).keys()) {
        const dir = path.join(privateDirFor(runtimeId, id), name);
        if (!runtimeShadowRemovable(name, dir, runtimeId)) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          changed = true;
          log(`removed legacy runtime package ${name} from ${id} private library`);
        } catch (e) {
          log(`warn: could not remove private runtime package ${name} for ${id}: ${e && e.message}`);
        }
      }
    }
    // A state record may still name a runtime package whose copies are gone
    // (e.g. the user deleted lib/KernSmooth by hand). The bundled R is the only
    // provider left, so stop treating it as an app dependency.
    for (const id of Object.keys(state.apps)) {
      const rec = state.apps[id];
      if (!rec || !Array.isArray(rec.packages)) continue;
      const runtimeId = rec.runtime || shellRuntimeId;
      const runtimePkgs = runtimePackagesFor(runtimeId);
      const kept = rec.packages.filter((name) => {
        if (!runtimePkgs.has(name)) return true;
        if (fs.existsSync(path.join(privateDirFor(runtimeId, id), name, 'DESCRIPTION'))) return true;
        if (fs.existsSync(path.join(sharedRoot(runtimeId), name, 'DESCRIPTION'))) return true;
        return false;
      });
      if (kept.length !== rec.packages.length) {
        rec.packages = kept;
        changed = true;
      }
    }
    if (changed) {
      try { saveState(); } catch (e) { log(`warn: could not save state after runtime cleanup: ${e && e.message}`); }
    }
    return changed;
  }

  // ---- Catalog + icon cache ------------------------------------------------
  // The catalog is small; keep the last successful copy on disk so an offline
  // start still knows every installed app's metadata and can show icons.
  function loadCatalogCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(catalogCachePath, 'utf8'));
      if (cached && cached.url === catalogUrl && cached.catalog && Array.isArray(cached.catalog.apps)) {
        catalog = cached.catalog;
        catalogFetchedAt = Number(cached.fetchedAt) || 0;
        return true;
      }
    } catch (e) { /* no cache yet */ }
    return false;
  }

  function saveCatalogCache() {
    if (!catalog) return;
    try {
      const tmp = catalogCachePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ url: catalogUrl, fetchedAt: catalogFetchedAt, catalog: catalog }));
      fs.renameSync(tmp, catalogCachePath);
    } catch (e) {
      log('warn: could not cache the catalog:', e && e.message);
    }
  }

  function iconDataUrl(id) {
    const key = String(id);
    if (iconDataCache.has(key)) return iconDataCache.get(key);
    const entry = iconIndex[key];
    if (!entry || !entry.file) { iconDataCache.set(key, ''); return ''; }
    try {
      const buf = fs.readFileSync(path.join(iconCacheDir, entry.file));
      const mime = (entry.mime && entry.mime.indexOf('image/') === 0) ? entry.mime : 'image/png';
      const url = 'data:' + mime + ';base64,' + buf.toString('base64');
      iconDataCache.set(key, url);
      return url;
    } catch (e) {
      iconDataCache.set(key, '');
      return '';
    }
  }

  function cacheCatalogIcons(cat) {
    if (iconCacheRunning) return;
    const todo = ((cat && cat.apps) || []).filter((a) => a && a.id && a.icon && /^https:\/\//i.test(a.icon));
    if (!todo.length) return;
    iconCacheRunning = true;
    let next = 0;
    const safe = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const worker = async () => {
      while (next < todo.length) {
        const a = todo[next++];
        try {
          const prev = iconIndex[a.id];
          const sameUrl = !!(prev && prev.url === a.icon && prev.file);
          const cached = sameUrl && fs.existsSync(path.join(iconCacheDir, prev.file));
          if (cached && prev.checkedAt && (Date.now() - Number(prev.checkedAt)) < ICON_REVALIDATE_MS) continue;
          // Same URL, possibly changed bytes: revalidate instead of trusting the
          // cached file. A cached file without validators simply re-downloads.
          const headers = {};
          if (cached) {
            if (prev.etag) headers['If-None-Match'] = prev.etag;
            if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
          }
          const res = await httpGet(a.icon, headers);
          if (res.statusCode === 304) {
            res.resume();
            if (cached) {
              if (res.headers.etag) prev.etag = res.headers.etag;
              if (res.headers['last-modified']) prev.lastModified = res.headers['last-modified'];
              prev.checkedAt = Date.now();
            }
            continue;
          }
          if (res.statusCode !== 200) { res.destroy(); continue; }
          const type = String(res.headers['content-type'] || '').toLowerCase();
          if (type && type.indexOf('image/') !== 0) { res.destroy(); continue; }
          const chunks = [];
          let size = 0;
          for await (const c of res) {
            size += c.length;
            if (size > 2 * 1024 * 1024) { chunks.length = 0; res.destroy(); break; }
            chunks.push(c);
          }
          if (!chunks.length) continue;
          const ext = type.indexOf('svg') !== -1 ? 'svg'
            : (type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1) ? 'jpg' : 'png';
          const file = safe(a.id) + '.' + ext;
          const target = path.join(iconCacheDir, file);
          const tmp = target + '.tmp';
          fs.writeFileSync(tmp, Buffer.concat(chunks));
          try { fs.rmSync(target, { force: true }); } catch (e) {}
          fs.renameSync(tmp, target);
          if (prev && prev.file && prev.file !== file) {
            try { fs.rmSync(path.join(iconCacheDir, prev.file), { force: true }); } catch (e) {}
          }
          iconIndex[a.id] = {
            url: a.icon, file: file, mime: type || 'image/png',
            etag: res.headers.etag || '',
            lastModified: res.headers['last-modified'] || '',
            checkedAt: Date.now()
          };
          iconDataCache.delete(String(a.id));
        } catch (e) {
          log('warn: could not cache icon for ' + a.id + ': ' + e.message);
        }
      }
    };
    Promise.all([worker(), worker(), worker()])
      .then(() => {
        try { fs.writeFileSync(iconIndexPath, JSON.stringify(iconIndex, null, 2)); } catch (e) {}
      })
      .catch(() => {})
      .finally(() => { iconCacheRunning = false; });
  }

  async function fetchCatalog({ force = false } = {}) {
    const now = Date.now();
    if (catalog && !force && (now - catalogFetchedAt) < CATALOG_TTL_MS) return catalog;
    // Cache-bust: gh-pages serves catalog.json with Cache-Control max-age=600,
    // so a bare URL can return a stale copy for up to 10 minutes.
    const url = catalogUrl + (catalogUrl.includes('?') ? '&' : '?') + 't=' + now;
    log('fetch catalog ' + url);
    catalog = JSON.parse(await downloadToString(url));
    catalogFetchedAt = now;
    saveCatalogCache();
    cacheCatalogIcons(catalog);
    log('catalog apps: ' + catalog.apps.map((a) => a.id).join(', '));
    return catalog;
  }
  function catalogEntry(id) { return catalog && catalog.apps.find((a) => a.id === id); }

  // Switch the catalog source at runtime (Settings); resets the cache.
  function setCatalogUrl(url) {
    if (typeof url === 'string' && url) {
      catalogUrl = url;
      catalog = null;
      catalogFetchedAt = 0;
      loadCatalogCache();
    }
  }

  async function install(id, onProgress = () => {}, signal = null, opts = {}) {
    const entry = catalogEntry(id);
    if (!entry) { const e = new Error(`unknown app: ${id}`); e.step = 'resolve'; throw e; }
    const plat = platformKey();
    const picked = chooseArtifact(entry, plat, opts.runtimeId || '');
    if (!picked) { const e = new Error(`no bundle for ${plat} of ${id}`); e.step = 'resolve'; throw e; }
    const art = picked.art;
    const runtimeId = picked.runtimeId;
    const entryAbi = artifactAbi(art, entry) || shellRuntime.abi;
    const entryRVersion = art.r_version || entry.r_version || '';
    const runtime = runtimeInfo(runtimeId);
    if (!runtime) {
      const e = new Error(`app needs the R ${entryAbi} runtime; install that runtime or update ShinyApps`);
      e.step = 'resolve'; e.code = 'RUNTIME_MISSING'; throw e;
    }
    if (runtime.abi && entryAbi && runtime.abi !== entryAbi) {
      const e = new Error(`app needs R ${entryAbi}; this build provides R ${runtime.abi}`);
      e.step = 'resolve'; e.code = 'INCOMPATIBLE'; throw e;
    }
    if (runtime.version && entryRVersion && cmpVersion(runtime.version, entryRVersion) < 0) {
      const e = new Error(`app needs R ${entryRVersion}; the ${runtimeId} runtime is R ${runtime.version}`);
      e.step = 'resolve'; e.code = 'INCOMPATIBLE'; throw e;
    }
    if (shellVersion && entry.min_shell_version && cmpVersion(shellVersion, entry.min_shell_version) < 0) {
      const e = new Error(`app needs a newer ShinyApps (${entry.min_shell_version}); you have ${shellVersion}`);
      e.step = 'resolve'; e.code = 'INCOMPATIBLE'; throw e;
    }

    const zip = path.join(cacheDir, `${id}-${entry.version}-${plat}-${runtimeId}.zip`);
    let step = 'download';
    let staging = null;
    let finalDir = null;
    let committed = false;
    let touchedFinalDir = false;   // did this job delete/create finalDir?
    // Need room for the archive plus its unpacked contents (small margin).
    const free = await freeBytes(cacheDir);
    const need = (art.size || 0) * 3;
    if (free != null && art.size && free < need) {
      const e = new Error(`not enough disk space (need ~${Math.ceil(need / 1048576)} MB free, have ${Math.floor(free / 1048576)} MB)`);
      e.step = 'download';
      e.code = 'NO_SPACE';
      throw e;
    }
    try {
      const sources = downloadUrls(art.url, getDownloadMirror());
      let lastErr = null;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        try {
          step = 'download';
          if (signal && signal.aborted) throw cancelError();
          const via = sources.length > 1 ? (i < sources.length - 1 ? ' (mirror)' : ' (GitHub)') : '';
          log(`install ${id}@${entry.version} ${plat}: GET ${source} (${art.size || '?'} bytes)`);
          onProgress({ phase: 'downloading', percent: 0, statusText: 'downloading' + via });
          await fsp.rm(zip, { force: true }).catch(() => {});
          await downloadToFile(source, zip, {
            expectedSize: art.size || 0,
            log,
            signal,
            onProgress: (frac, got, total) => onProgress({
              phase: 'downloading',
              percent: Math.round(Math.min(1, frac || 0) * 100),
              statusText: 'downloading' + via + ' ' + Math.round(got / 1048576) + (total ? ' / ' + Math.round(total / 1048576) : '') + ' MB',
            }),
          });
          log(`downloaded ${zip} (${fs.statSync(zip).size} bytes)`);
          if (signal && signal.aborted) throw cancelError();

          // Verify against the catalog BEFORE touching anything on disk.
          step = 'verify';
          const gotSize = fs.statSync(zip).size;
          onProgress({ phase: 'verifying', percent: 100, statusText: 'verifying size' });
          if (art.size && gotSize !== art.size) {
            const e = new Error(`size mismatch (catalog ${art.size} bytes, downloaded ${gotSize} bytes)`);
            e.step = 'verify'; e.code = 'SIZE_MISMATCH';
            throw e;
          }
          onProgress({ phase: 'verifying', percent: 100, statusText: 'verifying checksum' });
          const got = await sha256File(zip);
          if (art.sha256 && got !== art.sha256) {
            const e = new Error(`checksum mismatch (catalog ${String(art.sha256).slice(0, 12)}\u2026, downloaded ${got.slice(0, 12)}\u2026)`);
            e.step = 'verify'; e.code = 'CHECKSUM_MISMATCH';
            throw e;
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await fsp.rm(zip, { force: true }).catch(() => {});
          if (signal && signal.aborted) throw e;
          if (i < sources.length - 1) {
            log(`download source failed (${source}): ${e.message}; trying the next source`);
            continue;
          }
          throw e;
        }
      }
      if (lastErr) throw lastErr;

      step = 'install';
      onProgress({ phase: 'unpacking', percent: 0, statusText: 'unpacking' });
      staging = path.join(appsDir, id, `.staging-${entry.version}-${Date.now()}`);
      await fsp.rm(staging, { recursive: true, force: true });
      await unzip(zip, staging, onProgress, signal);

      const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
      if (manifest.platform !== plat) log(`warn: manifest platform ${manifest.platform} != ${plat}`);
      const manifestAbi = manifest.r_abi || rAbiFromVersion(manifest.r_version);
      if (manifestAbi && runtime.abi && manifestAbi !== runtime.abi) {
        const e = new Error(`bundle was built for R ${manifestAbi}; the ${runtimeId} runtime is R ${runtime.abi}`);
        e.step = 'install'; e.code = 'INCOMPATIBLE'; throw e;
      }
      if (runtime.version && manifest.r_version && cmpVersion(runtime.version, manifest.r_version) < 0) {
        const e = new Error(`bundle needs R ${manifest.r_version}; the ${runtimeId} runtime is R ${runtime.version}`);
        e.step = 'install'; e.code = 'INCOMPATIBLE'; throw e;
      }
      finalDir = path.join(appsDir, id, manifest.version);

      // Only the commit touches global state; hold the lock across rename,
      // shared-library linking and the state write. A queued install can be
      // cancelled while it waits for the lock.
      return await withCommitLock(async () => {
        if (signal && signal.aborted) throw cancelError();
        await fsp.mkdir(path.dirname(finalDir), { recursive: true });
        touchedFinalDir = true;
        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.rename(staging, finalDir);
        staging = null;

        onProgress({ phase: 'linking', percent: 100, statusText: 'linking packages' });
        const linkedPackages = await reconcilePackages(id, finalDir, manifest.packages || [], runtimeId, onProgress);
        const old = state.apps[id] || null;
        const oldRuntime = old ? (old.runtime || shellRuntimeId) : null;

        state.apps[id] = {
          version: manifest.version, platform: plat, dir: finalDir,
          packages: linkedPackages,
          runtime: runtimeId,
          r_abi: runtime.abi || manifestAbi || '',
          source: 'catalog',
          meta: bundleMeta(manifest),
        };
        saveState();
        committed = true;
        await pruneRefs(id, linkedPackages, runtimeId);
        if (oldRuntime && oldRuntime !== runtimeId) {
          await pruneRefs(id, [], oldRuntime);
        }
        log(`installed ${id}@${manifest.version} (${(manifest.packages || []).length} packages)`);
        onProgress({ phase: 'done', percent: 100, statusText: 'installed' });
        // The cached archive has served its purpose; reclaim the disk.
        await fsp.rm(zip, { force: true }).catch(() => {});
        return { id, version: manifest.version };
      });
    } catch (e) {
      if (staging) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      if (finalDir && !committed && touchedFinalDir) {
        // A failed install must not leave a version folder that no record
        // points at (it would never be reclaimed). Never remove a folder this
        // job did not touch: an abort while waiting for the commit lock must
        // leave the currently installed version intact.
        await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
        const rec = state.apps[id];
        if (rec && rec.dir && path.resolve(rec.dir) === path.resolve(finalDir)) {
          delete state.apps[id];
          try { saveState(); } catch (err) { /* best effort */ }
        }
      }
      if (e && !e.step) e.step = step;
      throw e;
    }
  }

  // Install an app from a user-supplied bundle (zip) that need not be in the
  // catalog. Validates the manifest and compatibility before touching state.
  async function installFromFile(zipPath, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const confirm = opts.confirm || (async () => true);
    const signal = opts.signal || null;
    const plat = platformKey();
    let step = 'resolve';
    let staging = null;
    let installId = null;
    let finalDir = null;
    let committed = false;
    let touchedFinalDir = false;
    try {
      if (!zipPath || !fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
        const e = new Error('bundle file not found'); e.step = 'resolve'; throw e;
      }

      step = 'download';
      const zipSize = fs.statSync(zipPath).size;
      const free = await freeBytes(appsDir);
      if (free != null && zipSize && free < zipSize * 3) {
        const e = new Error(`not enough disk space (need ~${Math.ceil((zipSize * 3) / 1048576)} MB free, have ${Math.floor(free / 1048576)} MB)`);
        e.step = 'download'; e.code = 'NO_SPACE'; throw e;
      }

      step = 'verify';
      onProgress({ phase: 'verifying', percent: 100, statusText: 'hashing bundle' });
      const sha = await sha256File(zipPath);

      step = 'install';
      staging = path.join(appsDir, '.incoming-' + Date.now());
      await fsp.rm(staging, { recursive: true, force: true });
      onProgress({ phase: 'unpacking', percent: 0, statusText: 'unpacking' });
      await unzip(zipPath, staging, onProgress, signal);

      const manPath = path.join(staging, 'manifest.json');
      if (!fs.existsSync(manPath)) { const e = new Error('bundle has no manifest.json'); e.step = 'install'; throw e; }
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manPath, 'utf8')); }
      catch (err) { const e = new Error('invalid manifest.json: ' + err.message); e.step = 'install'; throw e; }
      validateManifest(manifest);
      if (manifest.platform !== plat) {
        const e = new Error(`bundle is for ${manifest.platform}; this machine is ${plat}`); e.step = 'install'; throw e;
      }
      const manifestAbi = manifest.r_abi || rAbiFromVersion(manifest.r_version) || shellRuntime.abi;
      const runtimeId = runtimeIdFromAbi(manifestAbi) || shellRuntimeId;
      const runtime = requireRuntime(null, manifest);
      if (runtime.abi && manifestAbi && runtime.abi !== manifestAbi) {
        const e = new Error(`bundle was built for R ${manifestAbi}; the ${runtimeId} runtime is R ${runtime.abi}`);
        e.step = 'install'; e.code = 'INCOMPATIBLE'; throw e;
      }
      if (runtime.version && manifest.r_version && cmpVersion(runtime.version, manifest.r_version) < 0) {
        const e = new Error(`bundle needs R ${manifest.r_version}; the ${runtimeId} runtime is R ${runtime.version}`);
        e.step = 'install'; e.code = 'INCOMPATIBLE'; throw e;
      }
      if (shellVersion && manifest.min_shell_version && cmpVersion(shellVersion, manifest.min_shell_version) < 0) {
        const e = new Error(`bundle needs a newer ShinyApps (${manifest.min_shell_version}); you have ${shellVersion}`); e.step = 'install'; throw e;
      }
      const root = path.resolve(staging);
      assertInside(root, manifest.entry);
      for (const pkg of (manifest.packages || [])) assertInside(root, pkg.path);

      const ok = await confirm(manifest);
      if (!ok) { const e = new Error('cancelled'); e.step = 'confirm'; e.cancelled = true; throw e; }

      const id = manifest.id;
      installId = id;
      finalDir = path.join(appsDir, id, manifest.version);

      // See install(): serializes rename + shared-library linking + state.
      return await withCommitLock(async () => {
        if (signal && signal.aborted) throw cancelError();
        const old = state.apps[id] || null;
        const oldRuntime = old ? (old.runtime || shellRuntimeId) : null;
        await fsp.mkdir(path.dirname(finalDir), { recursive: true });
        touchedFinalDir = true;
        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.rename(staging, finalDir);
        staging = null;

        onProgress({ phase: 'linking', percent: 100, statusText: 'linking packages' });
        const linkedPackages = await reconcilePackages(id, finalDir, manifest.packages || [], runtimeId, onProgress);

        state.apps[id] = {
          version: manifest.version, platform: plat, dir: finalDir,
          packages: linkedPackages,
          runtime: runtimeId,
          r_abi: runtime.abi || manifestAbi || '',
          source: 'local',
          // Keep where a sideloaded app came from, so the launcher can offer
          // "Copy download link" (a URL install) or "Copy bundle path" later.
          sourceUrl: opts.sourceUrl || undefined,
          sourcePath: opts.sourceUrl ? undefined : (opts.sourcePath || zipPath),
          sha256: sha,
          meta: bundleMeta(manifest),
        };
        saveState();
        committed = true;
        // Reclaim the previous version's files and shared-library refs. If the
        // replacement changed runtime, release the old runtime's refs too.
        await pruneRefs(id, state.apps[id].packages, runtimeId);
        if (oldRuntime && oldRuntime !== runtimeId) {
          await pruneRefs(id, [], oldRuntime);
        }
        if (old && old.dir && path.resolve(old.dir) !== path.resolve(finalDir)) {
          await fsp.rm(old.dir, { recursive: true, force: true }).catch(() => {});
        }
        log(`installed local bundle ${id}@${manifest.version}`);
        onProgress({ phase: 'done', percent: 100, statusText: 'installed' });
        return { id, version: manifest.version };
      });
    } catch (e) {
      if (staging) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      if (finalDir && !committed && touchedFinalDir) {
        // Roll back the half-installed folder and any record that pointed at it.
        await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
        const rec = installId ? state.apps[installId] : null;
        if (rec && rec.dir && path.resolve(rec.dir) === path.resolve(finalDir)) {
          delete state.apps[installId];
          try { saveState(); } catch (err) { /* best effort */ }
        }
      }
      if (e && !e.step) e.step = step;
      throw e;
    }
  }

  // Install a bundle downloaded from a URL: fetch to the cache, then install it
  // as a local bundle (same validation + confirmation path).
  async function installFromUrl(url, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const signal = opts.signal || null;
    if (!/^https?:\/\//i.test(url || '')) { const e = new Error('invalid URL'); e.step = 'download'; throw e; }
    const tmp = path.join(cacheDir, 'bundle-' + Date.now() + '.zip');
    try {
      onProgress({ phase: 'downloading', percent: 0, statusText: 'downloading' });
      await downloadToFile(url, tmp, {
        signal,
        log,
        onProgress: (frac, got, total) => onProgress({
          phase: 'downloading',
          percent: Math.round((frac || 0) * 100),
          statusText: 'downloading ' + Math.round(got / 1048576) + (total ? ' / ' + Math.round(total / 1048576) : '') + ' MB',
        }),
      });
      return await installFromFile(tmp, Object.assign({}, opts, { sourceUrl: url }));
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async function reconcilePackages(appId, appDir, packages, runtimeId = shellRuntimeId, onProgress = () => {}) {
    const keptRuntime = new Set();
    const runtimePkgs = runtimePackagesFor(runtimeId);
    const runtimeAbi = abiForRuntime(runtimeId);
    const sharedBase = sharedRoot(runtimeId);
    const privateBase = privateDirFor(runtimeId, appId);
    const sharedKeyFor = (name) => joinSharedKey(runtimeId, name);
    for (const pkg of packages) {
      const src = path.join(appDir, pkg.path);
      const sharedDir = path.join(sharedBase, pkg.name);
      const privateDir = path.join(privateBase, pkg.name);
      const haveSrc = packagePresent(src);
      // The bundled R provides base/recommended packages. Never let a bundle
      // copy shadow them: they may be compiled against another R's libraries.
      if (runtimePkgs.has(pkg.name)) {
        const sharedRemovable = runtimeShadowRemovable(pkg.name, sharedDir, runtimeId);
        if (sharedRemovable) {
          try {
            await fsp.rm(sharedDir, { recursive: true, force: true });
            delete state.shared[sharedKeyFor(pkg.name)];
          } catch (e) {
            log(`warn: could not remove shared runtime package ${pkg.name}: ${e && e.message}`);
          }
        }
        // A different-version — or undeletable — shared/private copy is kept
        // (see cleanupRuntimeShadows); keep it in state so refcounts stay honest.
        if (packagePresent(privateDir) || packagePresent(sharedDir)) {
          keptRuntime.add(pkg.name);
        }
        if (!sharedRemovable && packagePresent(sharedDir) && state.shared[sharedKeyFor(pkg.name)] &&
            !state.shared[sharedKeyFor(pkg.name)].refs.includes(appId)) {
          state.shared[sharedKeyFor(pkg.name)].refs.push(appId);
        }
        try { await fsp.rm(src, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        log(`using bundled runtime ${pkg.name} for ${appId}`);
        continue;
      }
      let shared = state.shared[sharedKeyFor(pkg.name)];
      // A record whose folder is gone is worse than no record: the bundle's own
      // copy is deleted below, and a reinstall would skip the copy because the
      // version still "matches". Drop it so this install restores the files.
      if (shared && !packagePresent(sharedDir)) {
        log(`warn: shared copy of ${pkg.name} is missing; restoring it from ${appId}`);
        delete state.shared[sharedKeyFor(pkg.name)];
        shared = undefined;
      }

      let target;
      if (!shared) {
        if (!haveSrc) throw new Error(`package ${pkg.name} is missing from the bundle and the shared library`);
        await copyDir(src, sharedDir);
        if (!packagePresent(sharedDir)) throw new Error(`could not link ${pkg.name} into the shared library`);
        state.shared[sharedKeyFor(pkg.name)] = {
          version: pkg.version,
          refs: [appId],
          runtime: runtimeId,
          r_abi: runtimeAbi,
        };
        target = sharedDir;
      } else if (shared.version === pkg.version) {
        if (!shared.refs.includes(appId)) shared.refs.push(appId);
        target = sharedDir;
      } else {
        log(`conflict: ${pkg.name} shared=${shared.version} wanted=${pkg.version} (${appId})`);
        if (!packagePresent(privateDir)) {
          if (!haveSrc) throw new Error(`package ${pkg.name} ${pkg.version} is missing from the bundle`);
          await copyDir(src, privateDir);
          if (!packagePresent(privateDir)) throw new Error(`could not link ${pkg.name} into the private library`);
        }
        target = privateDir;
      }

      // The app runs with .libPaths = <private>:<shared>, so the bundle's own
      // copy under rlib/ is never loaded. Remove it only after the library that
      // will be used actually holds the package, so a failed link cannot leave
      // the app without it.
      if (packagePresent(target)) {
        await fsp.rm(src, { recursive: true, force: true }).catch(() => {});
      }
      onProgress({ phase: 'linking', percent: 100, statusText: 'linking ' + pkg.name });
    }
    saveState();
    return packages
      .filter((pkg) => !runtimePkgs.has(pkg.name) || keptRuntime.has(pkg.name))
      .map((pkg) => pkg.name);
  }

  async function pruneRefs(appId, keepNames, runtimeId) {
    const runtime = runtimeId || (state.apps[appId] && state.apps[appId].runtime) || shellRuntimeId;
    const keep = new Set(keepNames);
    for (const [key, entry] of Object.entries(state.shared)) {
      const parsed = splitSharedKey(key);
      if ((parsed.runtime || shellRuntimeId) !== runtime) continue;
      if (keep.has(parsed.name) || !entry.refs.includes(appId)) continue;
      entry.refs = entry.refs.filter((x) => x !== appId);
      if (entry.refs.length === 0) {
        await fsp.rm(path.join(sharedRoot(runtime), parsed.name), { recursive: true, force: true });
        delete state.shared[key];
      }
    }
    saveState();
  }

  async function uninstall(id) {
    if (!state.apps[id]) return;
    try { await stop(id); } catch (e) { log(`warn: could not stop ${id} before uninstall: ${e && e.message}`); }
    // Hold the commit lock while refcounts change, so an install linking
    // packages at the same time cannot observe a half-updated shared library.
    await withCommitLock(async () => {
      if (!state.apps[id]) return;
      const runtimeId = state.apps[id].runtime || shellRuntimeId;
      // Forget the install BEFORE touching the filesystem. On Windows a file can
      // still be locked (R shutting down, virus scanner), and a failed rm must
      // not leave a ghost entry that the launcher lists but cannot start.
      delete state.apps[id];
      saveState();
      for (const dir of [path.join(appsDir, id), privateDirFor(runtimeId, id)]) {
        try { await fsp.rm(dir, { recursive: true, force: true }); }
        catch (e) { log(`warn: could not remove ${dir}: ${e && e.message}; it will be left for cleanup`); }
      }
      try { await pruneRefs(id, [], runtimeId); }
      catch (e) { log(`warn: could not release shared packages of ${id}: ${e && e.message}`); }
      saveState();
      log(`uninstalled ${id}`);
    });
  }

  async function run(id) {
    const app = state.apps[id];
    if (!app) throw new Error(`${id} is not installed`);
    if (!installedFilesPresent(app)) {
      // Files were removed behind our back: drop the record so the launcher
      // stops offering an app that cannot start.
      delete state.apps[id];
      try { saveState(); } catch (e) { /* best effort */ }
      const e = new Error(`${id} is not installed: its files are missing (removed it from the launcher)`);
      e.code = 'NOT_INSTALLED';
      throw e;
    }
    if (running.has(id)) return running.get(id);
    const runtime = requireRuntime(app, null);
    const runtimeId = runtime.id;
    const entry = app.meta && app.meta.entry;
    const appPath = entry ? path.join(app.dir, path.dirname(entry)) : path.join(app.dir, 'app');
    const privateBase = privateDirFor(runtimeId, id);
    const sharedBase = sharedRoot(runtimeId);
    const libPaths = [privateBase, sharedBase];
    // A bundle whose packages are gone cannot start; fail with an actionable
    // message instead of a bare "there is no package called ..." from R.
    const runtimePkgs = runtimePackagesFor(runtimeId);
    const missing = (app.packages || []).filter((name) =>
      !runtimePkgs.has(name) &&
      !packagePresent(path.join(privateBase, name)) &&
      !packagePresent(path.join(sharedBase, name)));
    if (missing.length) {
      const e = new Error(`${id} cannot start: missing package${missing.length > 1 ? 's' : ''} ` +
        `${missing.join(', ')}. Uninstall and install the app again to restore them.`);
      e.code = 'MISSING_PACKAGES';
      throw e;
    }
    log(`run ${id}: appPath=${appPath} libs=${libPaths.join(path.delimiter)} runtime=${runtimeId}`);
    const handle = await startBackend({
      appId: id,
      appPath,
      libPaths,
      runtimeId: runtime.id,
      runtimePath: runtime.root,
      runtimeRscript: runtime.rscript,
      runtimeLibrary: runtime.library,
      runtimeAbi: runtime.abi,
      runtimeVersion: runtime.version,
    });
    running.set(id, handle);
    return handle;
  }
  async function stop(id) {
    const h = running.get(id);
    if (!h) return;
    running.delete(id);
    await h.stop();
  }
  async function stopAll() { await Promise.all([...running.keys()].map(stop)); }
  function forget(id) { running.delete(id); }

  function checkUpdates() {
    const plat = platformKey();
    const out = [];
    for (const [id, app] of Object.entries(state.apps)) {
      const e = catalogEntry(id);
      if (!e) continue;
      // Count a newer version only when this platform has some bundle for it;
      // otherwise there is nothing the user could install here.
      const hasPlatformArtifact = !!(
        (e.artifacts && e.artifacts[plat]) ||
        (e.artifacts_by_runtime && e.artifacts_by_runtime[plat] &&
          Object.keys(e.artifacts_by_runtime[plat]).length)
      );
      if (!hasPlatformArtifact) continue;
      // Mirror the launcher's check: an update whose runtime is not installed
      // (or whose shell minimum is newer) is not offered.
      const picked = chooseArtifact(e, plat, app.runtime || shellRuntimeId);
      if (!picked) continue;
      const runtime = runtimeInfo(picked.runtimeId);
      if (!runtime) continue;
      const entryAbi = artifactAbi(picked.art, e);
      const entryRVersion = picked.art.r_version || e.r_version || '';
      if (runtime.abi && entryAbi && runtime.abi !== entryAbi) continue;
      if (runtime.version && entryRVersion && cmpVersion(runtime.version, entryRVersion) < 0) continue;
      if (shellVersion && e.min_shell_version && cmpVersion(shellVersion, e.min_shell_version) < 0) continue;
      if (cmpVersion(e.version, app.version) > 0) out.push({ id, from: app.version, to: e.version });
    }
    return out;
  }
  async function update(id, onProgress = () => {}, signal = null) {
    const e = catalogEntry(id);
    const app = state.apps[id];
    if (!e || !app || cmpVersion(e.version, app.version) <= 0) return;
    // Never install a bundle whose runtime is absent or too old.
    const plat = platformKey();
    const picked = chooseArtifact(e, plat, app.runtime || shellRuntimeId);
    if (!picked) {
      log(`update ${id} skipped: no bundle for ${plat}`);
      return;
    }
    const runtime = runtimeInfo(picked.runtimeId);
    const entryAbi = artifactAbi(picked.art, e);
    const entryRVersion = picked.art.r_version || e.r_version || '';
    if (!runtime) {
      log(`update ${id} skipped: needs the R ${entryAbi} runtime`);
      return;
    }
    if (runtime.abi && entryAbi && runtime.abi !== entryAbi) {
      log(`update ${id} skipped: needs R ${entryAbi}, ${runtime.id} provides ${runtime.abi}`);
      return;
    }
    if (runtime.version && entryRVersion && cmpVersion(runtime.version, entryRVersion) < 0) {
      log(`update ${id} skipped: needs R ${entryRVersion}, ${runtime.id} provides ${runtime.version}`);
      return;
    }
    if (shellVersion && e.min_shell_version && cmpVersion(shellVersion, e.min_shell_version) < 0) {
      log(`update ${id} skipped: needs shell ${e.min_shell_version}, this is ${shellVersion}`);
      return;
    }
    await stop(id);
    const oldDir = app.dir;
    const oldRuntime = app.runtime || shellRuntimeId;
    await install(id, onProgress, signal, { runtimeId: picked.runtimeId });
    await withCommitLock(async () => {
      await pruneRefs(id, state.apps[id].packages, state.apps[id].runtime);
      if (oldRuntime !== state.apps[id].runtime) {
        await pruneRefs(id, [], oldRuntime);
      }
      // Never delete the freshly installed dir (guards against manifest==catalog mismatch).
      if (oldDir && path.resolve(oldDir) !== path.resolve(state.apps[id].dir)) {
        await fsp.rm(oldDir, { recursive: true, force: true });
      }
    });
    log(`updated ${id} -> ${state.apps[id].version}`);
  }

  async function dirSize(dir) {
    let total = 0;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) total += await dirSize(fp);
        else if (ent.isFile()) total += (await fsp.stat(fp)).size;
      } catch (e) { /* skip unreadable */ }
    }
    return total;
  }

  // Storage report for the launcher's Storage panel.
  async function usage(onProgress) {
    const report = (typeof onProgress === 'function') ? onProgress : function () {};
    const appEntries = Object.entries(state.apps);
    const sharedEntries = Object.entries(state.shared || {});
    const total = appEntries.length + sharedEntries.length + 2;   // + cache + leftovers
    let done = 0;
    report(0, total, 'Measuring apps\u2026');
    const apps = [];
    let appsTotal = 0;
    let privateTotal = 0;
    for (const [id, ins] of appEntries) {
      const runtimeId = ins.runtime || shellRuntimeId;
      let bytes = 0;
      try { bytes = await dirSize(path.join(appsDir, id)); } catch (e) {}
      let priv = 0;
      try { priv = await dirSize(privateDirFor(runtimeId, id)); } catch (e) {}
      appsTotal += bytes;
      privateTotal += priv;
      apps.push({ id: id, version: ins.version, runtime: runtimeId, source: ins.source || '', bytes: bytes, privateBytes: priv });
      done++;
      report(done, total, 'Measuring ' + id + '\u2026');
    }
    const shared = [];
    let sharedTotal = 0;
    for (const [key, entry] of sharedEntries) {
      const parsed = splitSharedKey(key);
      const runtimeId = parsed.runtime || shellRuntimeId;
      let bytes = 0;
      try { bytes = await dirSize(path.join(sharedRoot(runtimeId), parsed.name)); } catch (e) {}
      sharedTotal += bytes;
      shared.push({
        name: parsed.name,
        runtime: runtimeId,
        version: entry.version,
        refs: (entry.refs || []).length,
        bytes: bytes,
      });
      done++;
      report(done, total, 'Measuring ' + parsed.name + '\u2026');
    }
    report(done, total, 'Checking cache\u2026');
    let cacheBytes = 0, cacheFiles = 0;
    try {
      const files = await fsp.readdir(cacheDir);
      for (const f of files) { try { const st = await fsp.stat(path.join(cacheDir, f)); if (st.isFile()) { cacheBytes += st.size; cacheFiles++; } } catch (e) {} }
    } catch (e) {}
    done++;
    report(done, total, 'Scanning for leftovers\u2026');
    let staleBytes = 0, staleDirs = 0;
    try {
      const ids = await fsp.readdir(appsDir);
      for (const id of ids) {
        let subs = [];
        try { subs = await fsp.readdir(path.join(appsDir, id)); } catch (e) { continue; }
        for (const s of subs) {
          if (s.indexOf('.staging-') === 0 || s.indexOf('.incoming-') === 0) {
            staleDirs++;
            try { staleBytes += await dirSize(path.join(appsDir, id, s)); } catch (e) {}
          }
        }
      }
    } catch (e) {}
    done++;
    report(done, total, 'Done');
    return {
      apps: apps.sort((a, b) => b.bytes - a.bytes),
      appsTotal: appsTotal,
      privateTotal: privateTotal,
      shared: shared.sort((a, b) => b.bytes - a.bytes),
      sharedTotal: sharedTotal,
      cacheBytes: cacheBytes,
      cacheFiles: cacheFiles,
      staleBytes: staleBytes,
      staleDirs: staleDirs,
      diskFree: await freeBytes(appsDir),
      total: appsTotal + sharedTotal + privateTotal + cacheBytes + staleBytes,
    };
  }

  // Reclaim disk: cached archives, unreferenced shared packages, stale dirs.
  async function cleanup(onProgress) {
    const report = (typeof onProgress === 'function') ? onProgress : function () {};
    let freed = 0;
    let done = 0;
    const cacheFiles = [];
    try {
      const files = await fsp.readdir(cacheDir);
      for (const f of files) {
        try { const st = await fsp.stat(path.join(cacheDir, f)); if (st.isFile()) cacheFiles.push({ name: f, size: st.size }); } catch (e) {}
      }
    } catch (e) {}
    const orphanShared = Object.keys(state.shared || {}).filter(function (key) {
      const e = state.shared[key] || {};
      const parsed = splitSharedKey(key);
      const runtimeId = parsed.runtime || shellRuntimeId;
      // Refs to apps that are no longer installed (or that moved to another
      // runtime) are dead refs, not users.
      const refs = (e.refs || []).filter(function (r) {
        const app = state.apps[r];
        return !!app && (app.runtime || shellRuntimeId) === runtimeId;
      });
      // A record whose folder is gone is unusable even with live refs.
      return refs.length === 0 ||
        !packagePresent(path.join(sharedRoot(runtimeId), parsed.name));
    });
    const total = cacheFiles.length + orphanShared.length;
    report(0, total, total ? 'Cleaning up\u2026' : 'Nothing to clean');
    for (const cf of cacheFiles) {
      try { await fsp.rm(path.join(cacheDir, cf.name), { force: true }); freed += cf.size; } catch (e) {}
      done++;
      report(done, total, 'Removing cache file\u2026');
    }
    for (const key of orphanShared) {
      const parsed = splitSharedKey(key);
      const runtimeId = parsed.runtime || shellRuntimeId;
      try {
        const sp = path.join(sharedRoot(runtimeId), parsed.name);
        freed += await dirSize(sp);
        await fsp.rm(sp, { recursive: true, force: true });
        delete state.shared[key];
      } catch (e) { /* best effort */ }
      done++;
      report(done, total, 'Removing unused package ' + parsed.name + '\u2026');
    }
    saveState();
    report(done, total, 'Finalizing\u2026');
    try {
      const ids = await fsp.readdir(appsDir);
      for (const id of ids) {
        let subs = [];
        try { subs = await fsp.readdir(path.join(appsDir, id)); } catch (e) { continue; }
        for (const s of subs) {
          if (s.indexOf('.staging-') === 0 || s.indexOf('.incoming-') === 0) {
            const sp = path.join(appsDir, id, s);
            try { freed += await dirSize(sp); await fsp.rm(sp, { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
    } catch (e) {}
    // Private libraries for apps that are no longer installed are orphans too.
    // privateRoot now contains one directory per runtime, each with app dirs.
    try {
      const runtimes = await fsp.readdir(privateRoot, { withFileTypes: true });
      for (const rt of runtimes) {
        if (!rt.isDirectory()) continue;
        const runtimeDir = path.join(privateRoot, rt.name);
        const ids = await fsp.readdir(runtimeDir);
        for (const id of ids) {
          const rec = state.apps[id];
          if (rec && (rec.runtime || shellRuntimeId) === rt.name) continue;
          const sp = path.join(runtimeDir, id);
          try { freed += await dirSize(sp); await fsp.rm(sp, { recursive: true, force: true }); } catch (e) {}
        }
      }
    } catch (e) {}
    // App folders with no install record (left behind by a failed uninstall)
    // are orphans as well; removing them lets the next install start clean.
    try {
      const appIds = await fsp.readdir(appsDir);
      for (const id of appIds) {
        if (state.apps[id]) continue;
        const sp = path.join(appsDir, id);
        try { freed += await dirSize(sp); await fsp.rm(sp, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
    log('cleanup freed ' + Math.round(freed / 1048576) + ' MB');
    return { freed: freed };
  }

  // Reset all local store data: stop/cancel everything, remove installed apps,
  // the shared/private libraries and the download cache, and clear state.
  // The shell itself and user settings are untouched.
  async function resetLocal(onProgress) {
    const report = (typeof onProgress === 'function') ? onProgress : function () {};
    report(0, 0, 'Stopping running apps\u2026');
    await stopAll();
    const appIds = Object.keys(state.apps || {});
    const total = appIds.length + 5;   // per-app dirs + 4 sweeps + catalog cache
    let done = 0;
    for (const id of appIds) {
      report(done, total, 'Removing ' + id + '\u2026');
      try { await fsp.rm(path.join(appsDir, id), { recursive: true, force: true }); } catch (e) {}
      done++;
      report(done, total, 'Removed ' + id);
    }
    // Sweep anything still under apps/ (staging/incoming), then recreate the dirs.
    try { await fsp.rm(appsDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.mkdirSync(appsDir, { recursive: true }); } catch (e) {}
    for (const d of [sharedLib, privateRoot, cacheDir, iconCacheDir]) {
      report(done, total, 'Clearing data\u2026');
      try { await fsp.rm(d, { recursive: true, force: true }); } catch (e) {}
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
      done++;
    }
    try { fs.mkdirSync(sharedRoot(shellRuntimeId), { recursive: true }); } catch (e) {}
    try { fs.mkdirSync(privateRootFor(shellRuntimeId), { recursive: true }); } catch (e) {}
    try { await fsp.rm(catalogCachePath, { force: true }); } catch (e) {}
    done++;
    catalog = null;
    catalogFetchedAt = 0;
    iconIndex = {};
    iconDataCache.clear();
    state = { schema: 2, apps: {}, shared: {}, runtimes: {} };
    state.runtimes[shellRuntimeId] = {
      abi: shellRuntime.abi,
      version: shellRuntime.version,
      source: 'shell',
    };
    saveState();
    report(total, total, 'Done');
  }

  return {
    fetchCatalog, catalogEntry,
    install, installFromFile, uninstall, run, stop, stopAll,
    checkUpdates, update,
    isRunning: (id) => running.has(id),
    isInstalled,
    forget,
    getState: () => state,
    getCatalog: () => catalog,
    iconDataUrl,
    setCatalogUrl, installFromUrl,
    runtimeInfo,
    runtimeForEntry,
    artifactForEntry: (entry, plat, preferredRuntimeId) => {
      const picked = chooseArtifact(entry, plat, preferredRuntimeId || '');
      return picked ? picked.art : null;
    },
    usage, cleanup, resetLocal,
    getDiskFree: () => freeBytes(appsDir),
  };
}

module.exports = { createAppStore, cmpVersion, platformKey, downloadUrls };
