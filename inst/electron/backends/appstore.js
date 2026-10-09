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

async function downloadToFile(url, dest, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const expectedSize = opts.expectedSize || 0;
  const idleMs = opts.idleMs || 60000;
  const attempts = opts.attempts || 5;
  const log = opts.log || (() => {});
  const part = dest + '.part';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
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
        res.on('data', (c) => {
          received += c.length;
          clearTimeout(idle);
          idle = setTimeout(() => res.destroy(new Error('download stalled')), idleMs);
          onProgress(total ? received / total : 0, received, total);
        });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
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

async function unzip(zipPath, destDir) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const readAt = (pos, len) => {
      const b = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, b, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      return b.subarray(0, got);
    };
    const tailLen = Math.min(size, 65557);
    const tail = readAt(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip (no EOCD found)');
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const locPos = (size - tailLen) + eocd - 20;
      if (locPos >= 0) {
        const loc = readAt(locPos, 20);
        if (loc.readUInt32LE(0) === 0x07064b50) {
          const z64 = readAt(Number(loc.readBigUInt64LE(8)), 56);
          if (z64.readUInt32LE(0) === 0x06064b50) {
            entries = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }
    const cd = readAt(cdOffset, cdSize);
    const root = path.resolve(destDir);
    await fsp.mkdir(root, { recursive: true });
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory record');
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let lho = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || lho === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const sz = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + sz;
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
      void uncompSize;
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('zip-slip entry rejected: ' + name);
      if (name.endsWith('/')) { await fsp.mkdir(target, { recursive: true }); continue; }
      const lh = readAt(lho, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local file header');
      const dataPos = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = readAt(dataPos, compSize);
      const data = method === 0 ? comp : method === 8 ? zlib.inflateRawSync(comp)
        : (() => { throw new Error('unsupported zip compression method ' + method); })();
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function platformKey() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return `win-${a}`;
  if (p === 'darwin') return `mac-${a}`;
  return `linux-${a}`;
}

function createAppStore(options) {
  const { userDataDir, catalogUrl, startBackend, log = () => {} } = options;

  const statePath = path.join(userDataDir, 'state.json');
  const appsDir = path.join(userDataDir, 'apps');
  const sharedLib = path.join(userDataDir, 'lib');
  const privateRoot = path.join(userDataDir, 'private');
  const cacheDir = path.join(userDataDir, 'store-cache');
  for (const d of [appsDir, sharedLib, privateRoot, cacheDir]) fs.mkdirSync(d, { recursive: true });

  let state = loadState();
  let catalog = null;
  const running = new Map();

  function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return { schema: 1, apps: {}, shared: {} }; }
  }
  function saveState() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }

  async function fetchCatalog({ force = false } = {}) {
    if (catalog && !force) return catalog;
    log('fetch catalog ' + catalogUrl);
    catalog = JSON.parse(await downloadToString(catalogUrl));
    log('catalog apps: ' + catalog.apps.map((a) => a.id).join(', '));
    return catalog;
  }
  function catalogEntry(id) { return catalog && catalog.apps.find((a) => a.id === id); }

  async function install(id, onProgress = () => {}) {
    const entry = catalogEntry(id);
    if (!entry) { const e = new Error(`unknown app: ${id}`); e.step = 'resolve'; throw e; }
    const plat = platformKey();
    const art = entry.artifacts && entry.artifacts[plat];
    if (!art) { const e = new Error(`no bundle for ${plat} of ${id}`); e.step = 'resolve'; throw e; }

    const zip = path.join(cacheDir, `${id}-${entry.version}-${plat}.zip`);
    let step = 'download';
    try {
      log(`install ${id}@${entry.version} ${plat}: GET ${art.url} (${art.size || '?'} bytes)`);
      onProgress({ phase: 'downloading', percent: 0, statusText: 'downloading' });
      await downloadToFile(art.url, zip, {
        expectedSize: art.size || 0,
        log,
        onProgress: (frac, got, total) => onProgress({
          phase: 'downloading',
          percent: Math.round((frac || 0) * 100),
          statusText: 'downloading ' + Math.round(got / 1048576) + (total ? ' / ' + Math.round(total / 1048576) : '') + ' MB',
        }),
      });
      log(`downloaded ${zip} (${fs.statSync(zip).size} bytes)`);

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
      onProgress({ phase: 'unpacking', percent: 100, statusText: 'unpacking' });
      const staging = path.join(appsDir, id, `.staging-${entry.version}-${Date.now()}`);
      await fsp.rm(staging, { recursive: true, force: true });
      await unzip(zip, staging);

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
      };
      saveState();
      log(`installed ${id}@${manifest.version} (${(manifest.packages || []).length} packages)`);
      onProgress({ phase: 'done', percent: 100, statusText: 'installed' });
      return { id, version: manifest.version };
    } catch (e) {
      if (e && !e.step) e.step = step;
      throw e;
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
    const appPath = path.join(app.dir, 'app');
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
    const out = [];
    for (const [id, app] of Object.entries(state.apps)) {
      const e = catalogEntry(id);
      if (e && cmpVersion(e.version, app.version) > 0) out.push({ id, from: app.version, to: e.version });
    }
    return out;
  }
  async function update(id, onProgress = () => {}) {
    const e = catalogEntry(id);
    const app = state.apps[id];
    if (!e || !app || cmpVersion(e.version, app.version) <= 0) return;
    await stop(id);
    const oldDir = app.dir;
    await install(id, onProgress);
    await pruneRefs(id, state.apps[id].packages);
    // Never delete the freshly installed dir (guards against manifest==catalog mismatch).
    if (oldDir && path.resolve(oldDir) !== path.resolve(state.apps[id].dir)) {
      await fsp.rm(oldDir, { recursive: true, force: true });
    }
    log(`updated ${id} -> ${state.apps[id].version}`);
  }

  return {
    fetchCatalog, catalogEntry,
    install, uninstall, run, stop, stopAll,
    checkUpdates, update,
    isRunning: (id) => running.has(id),
    forget,
    getState: () => state,
  };
}

module.exports = { createAppStore, cmpVersion };
