// tests/js/appstore-icon-cache.test.js
//
// The store keys its icon cache by URL. A PNG replaced in place (same URL, new
// bytes) must be picked up, so an unchanged URL is revalidated with a
// conditional request: 304 keeps the cached file, 200 replaces it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createAppStore } = require('../../inst/electron/backends/appstore');

const CATALOG_URL = 'https://example.test/catalog.json';
const ICON_URL = 'https://example.test/icon.png';
const CATALOG = {
  schema: 1,
  updated_at: '2026-11-11T00:00:00Z',
  apps: [{ id: 'seurat-explorer', name: 'SeuratExplorer', icon: ICON_URL }]
};

function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      let value;
      try { value = fn(); } catch (e) { value = false; }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('timeout waiting for condition'));
      setTimeout(poll, 25);
    })();
  });
}

test('icon cache revalidates an unchanged URL and replaces changed bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shinyapps-icon-cache-'));
  const originalGet = https.get;
  const indexFile = path.join(root, 'icons', 'index.json');
  let iconRequests = [];
  let nextIconResponse = null;

  https.get = function (url, opts, cb) {
    const headers = (opts && opts.headers) || {};
    const res = new Readable({ read() {} });
    let body = null;
    if (url.indexOf(CATALOG_URL) === 0) {
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      body = Buffer.from(JSON.stringify(CATALOG));
    } else if (url.indexOf(ICON_URL) === 0) {
      iconRequests.push({ url, headers });
      res.statusCode = nextIconResponse.status;
      res.headers = nextIconResponse.headers || {};
      body = nextIconResponse.body || null;
    } else {
      res.statusCode = 404;
      res.headers = {};
    }
    process.nextTick(() => {
      if (body) res.push(body);
      res.push(null);
    });
    cb(res);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };

  const readIndex = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const ageEntry = () => {
    const index = readIndex();
    index['seurat-explorer'].checkedAt = 0;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  };
  const iconBytes = (store) =>
    Buffer.from(store.iconDataUrl('seurat-explorer').split(',')[1], 'base64').toString();
  const makeStore = () => createAppStore({ dataRoot: root, catalogUrl: CATALOG_URL, log: () => {} });

  t.after(() => {
    https.get = originalGet;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1. First fetch downloads the icon and stores its validators.
  nextIconResponse = { status: 200, headers: { 'content-type': 'image/png', etag: '"v1"' }, body: Buffer.from('OLD') };
  iconRequests = [];
  let store = makeStore();
  await store.fetchCatalog({ force: true });
  // The index is persisted after the batch finishes; waiting for it means the
  // next store is guaranteed to see the cached entry.
  await waitFor(() => {
    try { return readIndex()['seurat-explorer'].etag === '"v1"'; } catch (e) { return false; }
  });
  assert.strictEqual(iconRequests.length, 1);
  assert.strictEqual(iconRequests[0].headers['If-None-Match'], undefined);
  assert.strictEqual(iconBytes(store), 'OLD');

  // 2. A fetch inside the revalidation interval makes no icon request.
  iconRequests = [];
  store = makeStore();
  await store.fetchCatalog({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(iconRequests.length, 0);

  // 3. An expired interval sends If-None-Match; 304 keeps the cached bytes.
  ageEntry();
  nextIconResponse = { status: 304, headers: { etag: '"v1"' } };
  iconRequests = [];
  store = makeStore();
  await store.fetchCatalog({ force: true });
  await waitFor(() => readIndex()['seurat-explorer'].checkedAt > 0);
  assert.strictEqual(iconRequests.length, 1);
  assert.strictEqual(iconRequests[0].headers['If-None-Match'], '"v1"');
  assert.strictEqual(iconBytes(store), 'OLD');

  // 4. A 200 at the same URL replaces the cached bytes.
  ageEntry();
  nextIconResponse = { status: 200, headers: { 'content-type': 'image/png', etag: '"v2"' }, body: Buffer.from('NEW') };
  iconRequests = [];
  store = makeStore();
  await store.fetchCatalog({ force: true });
  await waitFor(() => {
    try { return readIndex()['seurat-explorer'].etag === '"v2"'; } catch (e) { return false; }
  });
  assert.strictEqual(iconBytes(store), 'NEW');
});
