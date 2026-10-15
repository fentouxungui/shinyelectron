'use strict';
/**
 * App-layer store for the ShinyApps shell (Electron main process).
 * Zero npm dependencies (Node built-in zlib for zip extraction).
 *
 * Robust bundle download: progress + idle timeout + resume (HTTP Range)
 * + retry + size/checksum verification. update() forwards install progress.
 *
 * Layout under <userData>: state.json, apps/, lib/, private/, store-cache/
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

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

async function downloadToFile(url, dest, opts = {}) {
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
          const e = cancelError();
          try { res.destroy(e); } catch (x) {}
          try { out.destroy(); } catch (x) {}
          reject(e);
        };
        const done = (fn) => (v) => { if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
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
  throw lastErr || new Error('download failed');
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
    runtime: m.runtime || '',
    entry: m.entry || '',
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const BUNDLE_PLATFORMS = ['win-x64', 'win-arm64', 'mac-x64', 'mac-arm64', 'linux-x64'];

function validateManifest(m) {
  const bad = (msg) => { const e = new Error('invalid manifest: ' + msg); e.step = 'install'; return e; };
  if (!m || typeof m !== 'object') throw bad('not an object');
  if (m.schema !== 1) throw bad('unsupported schema ' + m.schema);
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw bad('bad id');
  if (typeof m.name !== 'string' || !m.name) throw bad('missing name');
  if (typeof m.version !== 'string' || !m.version) throw bad('missing version');
  if (BUNDLE_PLATFORMS.indexOf(m.platform) === -1) throw bad('bad platform');
  if (typeof m.entry !== 'string' || !m.entry) throw bad('missing entry');
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

function createAppStore(options) {
  const { userDataDir, startBackend, shellVersion = '', shellRVersion = '', log = () => {} } = options;
  let catalogUrl = options.catalogUrl;

  const statePath = path.join(userDataDir, 'state.json');
  const appsDir = path.join(userDataDir, 'apps');
  const sharedLib = path.join(userDataDir, 'lib');
  const privateRoot = path.join(userDataDir, 'private');
  const cacheDir = path.join(userDataDir, 'store-cache');
  for (const d of [appsDir, sharedLib, privateRoot, cacheDir]) fs.mkdirSync(d, { recursive: true });

  let state = loadState();
  let catalog = null;
  let catalogFetchedAt = 0;
  const CATALOG_TTL_MS = 60000;
  const running = new Map();

  function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return { schema: 1, apps: {}, shared: {} }; }
  }
  function saveState() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }

  async function fetchCatalog({ force = false } = {}) {
    const now = Date.now();
    if (catalog && !force && (now - catalogFetchedAt) < CATALOG_TTL_MS) return catalog;
    // Cache-bust: gh-pages serves catalog.json with Cache-Control max-age=600,
    // so a bare URL can return a stale copy for up to 10 minutes.
    const url = catalogUrl + (catalogUrl.includes('?') ? '&' : '?') + 't=' + now;
    log('fetch catalog ' + url);
    catalog = JSON.parse(await downloadToString(url));
    catalogFetchedAt = now;
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
    }
  }

  async function install(id, onProgress = () => {}, signal = null) {
    const entry = catalogEntry(id);
    if (!entry) { const e = new Error(`unknown app: ${id}`); e.step = 'resolve'; throw e; }
    const plat = platformKey();
    const art = entry.artifacts && entry.artifacts[plat];
    if (!art) { const e = new Error(`no bundle for ${plat} of ${id}`); e.step = 'resolve'; throw e; }

    const zip = path.join(cacheDir, `${id}-${entry.version}-${plat}.zip`);
    let step = 'download';
    let staging = null;
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
      log(`install ${id}@${entry.version} ${plat}: GET ${art.url} (${art.size || '?'} bytes)`);
      onProgress({ phase: 'downloading', percent: 0, statusText: 'downloading' });
      await downloadToFile(art.url, zip, {
        expectedSize: art.size || 0,
        log,
        signal,
        onProgress: (frac, got, total) => onProgress({
          phase: 'downloading',
          percent: Math.round((frac || 0) * 100),
          statusText: 'downloading ' + Math.round(got / 1048576) + (total ? ' / ' + Math.round(total / 1048576) : '') + ' MB',
        }),
      });
      log(`downloaded ${zip} (${fs.statSync(zip).size} bytes)`);
      if (signal && signal.aborted) throw cancelError();

      // Verify against the catalog BEFORE touching anything on disk.
      step = 'verify';
      const gotSize = fs.statSync(zip).size;
      onProgress({ phase: 'verifying', percent: 100, statusText: 'verifying size' });
      if (art.size && gotSize !== art.size) {
        await fsp.rm(zip, { force: true });
        const e = new Error(`size mismatch (catalog ${art.size} bytes, downloaded ${gotSize} bytes)`);
        e.step = 'verify'; e.code = 'SIZE_MISMATCH';
        throw e;
      }
      onProgress({ phase: 'verifying', percent: 100, statusText: 'verifying checksum' });
      const got = await sha256File(zip);
      if (art.sha256 && got !== art.sha256) {
        await fsp.rm(zip, { force: true });
        const e = new Error(`checksum mismatch (catalog ${String(art.sha256).slice(0, 12)}\u2026, downloaded ${got.slice(0, 12)}\u2026)`);
        e.step = 'verify'; e.code = 'CHECKSUM_MISMATCH';
        throw e;
      }

      step = 'install';
      onProgress({ phase: 'unpacking', percent: 0, statusText: 'unpacking' });
      staging = path.join(appsDir, id, `.staging-${entry.version}-${Date.now()}`);
      await fsp.rm(staging, { recursive: true, force: true });
      await unzip(zip, staging, onProgress, signal);

      const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
      if (manifest.platform !== plat) log(`warn: manifest platform ${manifest.platform} != ${plat}`);
      const finalDir = path.join(appsDir, id, manifest.version);
      await fsp.mkdir(path.dirname(finalDir), { recursive: true });
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.rename(staging, finalDir);

      onProgress({ phase: 'linking', percent: 100, statusText: 'linking packages' });
      await reconcilePackages(id, finalDir, manifest.packages || [], onProgress);

      state.apps[id] = {
        version: manifest.version, platform: plat, dir: finalDir,
        packages: (manifest.packages || []).map((p) => p.name),
        source: 'catalog',
        meta: bundleMeta(manifest),
      };
      saveState();
      log(`installed ${id}@${manifest.version} (${(manifest.packages || []).length} packages)`);
      onProgress({ phase: 'done', percent: 100, statusText: 'installed' });
      // The cached archive has served its purpose; reclaim the disk.
      await fsp.rm(zip, { force: true }).catch(() => {});
      return { id, version: manifest.version };
    } catch (e) {
      if (staging) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
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
      if (shellRVersion && manifest.r_version && cmpVersion(shellRVersion, manifest.r_version) < 0) {
        const e = new Error(`bundle needs R ${manifest.r_version}; this build ships R ${shellRVersion}`); e.step = 'install'; throw e;
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
      const old = state.apps[id] || null;
      const finalDir = path.join(appsDir, id, manifest.version);
      await fsp.mkdir(path.dirname(finalDir), { recursive: true });
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.rename(staging, finalDir);
      staging = null;

      onProgress({ phase: 'linking', percent: 100, statusText: 'linking packages' });
      await reconcilePackages(id, finalDir, manifest.packages || [], onProgress);

      state.apps[id] = {
        version: manifest.version, platform: plat, dir: finalDir,
        packages: (manifest.packages || []).map((p) => p.name),
        source: 'local',
        sha256: sha,
        meta: bundleMeta(manifest),
      };
      saveState();
      // Reclaim the previous version's files and shared-library refs.
      await pruneRefs(id, state.apps[id].packages);
      if (old && old.dir && path.resolve(old.dir) !== path.resolve(finalDir)) {
        await fsp.rm(old.dir, { recursive: true, force: true }).catch(() => {});
      }
      log(`installed local bundle ${id}@${manifest.version}`);
      onProgress({ phase: 'done', percent: 100, statusText: 'installed' });
      return { id, version: manifest.version };
    } catch (e) {
      if (staging) { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
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
      return await installFromFile(tmp, opts);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async function reconcilePackages(appId, appDir, packages, onProgress = () => {}) {
    for (const pkg of packages) {
      const src = path.join(appDir, pkg.path);
      const shared = state.shared[pkg.name];
      if (!shared) {
        await copyDir(src, path.join(sharedLib, pkg.name));
        state.shared[pkg.name] = { version: pkg.version, refs: [appId] };
      } else if (shared.version === pkg.version) {
        if (!shared.refs.includes(appId)) shared.refs.push(appId);
      } else {
        log(`conflict: ${pkg.name} shared=${shared.version} wanted=${pkg.version} (${appId})`);
        await copyDir(src, path.join(privateRoot, appId, pkg.name));
      }
      onProgress({ phase: 'linking', percent: 100, statusText: 'linking ' + pkg.name });
    }
    saveState();
  }

  async function pruneRefs(appId, keepNames) {
    const keep = new Set(keepNames);
    for (const [name, entry] of Object.entries(state.shared)) {
      if (keep.has(name) || !entry.refs.includes(appId)) continue;
      entry.refs = entry.refs.filter((x) => x !== appId);
      if (entry.refs.length === 0) {
        await fsp.rm(path.join(sharedLib, name), { recursive: true, force: true });
        delete state.shared[name];
      }
    }
    saveState();
  }

  async function uninstall(id) {
    if (!state.apps[id]) return;
    await stop(id);
    await fsp.rm(path.join(appsDir, id), { recursive: true, force: true });
    await fsp.rm(path.join(privateRoot, id), { recursive: true, force: true });
    await pruneRefs(id, []);
    delete state.apps[id];
    saveState();
    log(`uninstalled ${id}`);
  }

  async function run(id) {
    const app = state.apps[id];
    if (!app) throw new Error(`${id} is not installed`);
    if (running.has(id)) return running.get(id);
    const entry = app.meta && app.meta.entry;
    const appPath = entry ? path.join(app.dir, path.dirname(entry)) : path.join(app.dir, 'app');
    const libPaths = [path.join(privateRoot, id), sharedLib];
    log(`run ${id}: appPath=${appPath} libs=${libPaths.join(path.delimiter)}`);
    const handle = await startBackend({ appId: id, appPath, libPaths });
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
      // Count a newer version only when this platform has a bundle for it;
      // otherwise there is nothing the user could install here.
      if (e.artifacts && !e.artifacts[plat]) continue;
      if (cmpVersion(e.version, app.version) > 0) out.push({ id, from: app.version, to: e.version });
    }
    return out;
  }
  async function update(id, onProgress = () => {}, signal = null) {
    const e = catalogEntry(id);
    const app = state.apps[id];
    if (!e || !app || cmpVersion(e.version, app.version) <= 0) return;
    await stop(id);
    const oldDir = app.dir;
    await install(id, onProgress, signal);
    await pruneRefs(id, state.apps[id].packages);
    // Never delete the freshly installed dir (guards against manifest==catalog mismatch).
    if (oldDir && path.resolve(oldDir) !== path.resolve(state.apps[id].dir)) {
      await fsp.rm(oldDir, { recursive: true, force: true });
    }
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
  async function usage() {
    const apps = [];
    let appsTotal = 0;
    for (const [id, ins] of Object.entries(state.apps)) {
      let bytes = 0;
      try { bytes = await dirSize(path.join(appsDir, id)); } catch (e) {}
      appsTotal += bytes;
      apps.push({ id: id, version: ins.version, source: ins.source || '', bytes: bytes });
    }
    const shared = [];
    let sharedTotal = 0;
    for (const [name, entry] of Object.entries(state.shared || {})) {
      let bytes = 0;
      try { bytes = await dirSize(path.join(sharedLib, name)); } catch (e) {}
      sharedTotal += bytes;
      shared.push({ name: name, version: entry.version, refs: (entry.refs || []).length, bytes: bytes });
    }
    let cacheBytes = 0, cacheFiles = 0;
    try {
      const files = await fsp.readdir(cacheDir);
      for (const f of files) { try { const st = await fsp.stat(path.join(cacheDir, f)); if (st.isFile()) { cacheBytes += st.size; cacheFiles++; } } catch (e) {} }
    } catch (e) {}
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
    return {
      apps: apps.sort((a, b) => b.bytes - a.bytes),
      appsTotal: appsTotal,
      shared: shared.sort((a, b) => b.bytes - a.bytes),
      sharedTotal: sharedTotal,
      cacheBytes: cacheBytes,
      cacheFiles: cacheFiles,
      staleBytes: staleBytes,
      staleDirs: staleDirs,
      diskFree: await freeBytes(appsDir),
      total: appsTotal + sharedTotal + cacheBytes + staleBytes,
    };
  }

  // Reclaim disk: cached archives, unreferenced shared packages, stale dirs.
  async function cleanup() {
    let freed = 0;
    try {
      const files = await fsp.readdir(cacheDir);
      for (const f of files) {
        const fp = path.join(cacheDir, f);
        try { const st = await fsp.stat(fp); if (st.isFile()) { freed += st.size; await fsp.rm(fp, { force: true }); } } catch (e) {}
      }
    } catch (e) {}
    for (const name of Object.keys(state.shared || {})) {
      const entry = state.shared[name];
      if (entry && entry.refs && entry.refs.length === 0) {
        try { const sp = path.join(sharedLib, name); freed += await dirSize(sp); await fsp.rm(sp, { recursive: true, force: true }); delete state.shared[name]; } catch (e) {}
      }
    }
    saveState();
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
    log('cleanup freed ' + Math.round(freed / 1048576) + ' MB');
    return { freed: freed };
  }

  return {
    fetchCatalog, catalogEntry,
    install, installFromFile, uninstall, run, stop, stopAll,
    checkUpdates, update,
    isRunning: (id) => running.has(id),
    forget,
    getState: () => state,
    getCatalog: () => catalog,
    setCatalogUrl, installFromUrl,
    usage, cleanup,
    getDiskFree: () => freeBytes(appsDir),
  };
}

module.exports = { createAppStore, cmpVersion, platformKey };
