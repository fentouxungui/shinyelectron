// Runs ZIP extraction on a worker thread so unpacking a large bundle never
// blocks the Electron main (UI) process. Started by appstore.js via
// worker_threads with { zipPath, destDir } in workerData. Reports progress as
// uncompressed bytes processed and finally { type: 'done' } or { type: 'error' }.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workerData, parentPort } = require('worker_threads');

function run() {
  const { zipPath, destDir } = workerData;
  const limits = workerData.limits || {};
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
    fs.mkdirSync(root, { recursive: true });

    // Collect entries and total uncompressed bytes (for a smooth progress bar).
    const list = [];
    let p = 0;
    let totalBytes = 0;
    const maxEntries = limits.maxEntries || 0;
    const maxTotal = limits.maxTotalBytes || 0;
    const maxEntry = limits.maxEntryBytes || 0;
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
      const isDir = name.endsWith('/');
      if (!isDir) {
        if (maxEntry > 0 && uncompSize > maxEntry) throw new Error('bundle entry too large: ' + name);
        totalBytes += uncompSize;
      }
      list.push({ name, method, compSize, lho, isDir });
    }

    if (maxEntries > 0 && list.length > maxEntries) throw new Error('bundle has too many entries (' + list.length + ')');
    if (maxTotal > 0 && totalBytes > maxTotal) throw new Error('bundle expands to too much data (' + Math.round(totalBytes / 1048576) + ' MB)');

    const total = list.length;
    let processed = 0;
    let doneBytes = 0;
    let lastSent = 0;
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastSent < 150) return;
      lastSent = now;
      const percent = totalBytes > 0
        ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
        : (total ? Math.round((processed / total) * 100) : 100);
      parentPort.postMessage({ type: 'progress', percent, processed, total });
    };
    report(true);

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const target = path.resolve(root, it.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('zip-slip entry rejected: ' + it.name);
      if (it.isDir) { fs.mkdirSync(target, { recursive: true }); processed++; continue; }
      const lh = readAt(it.lho, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local file header');
      const dataPos = it.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = readAt(dataPos, it.compSize);
      const data = it.method === 0 ? comp : it.method === 8 ? zlib.inflateRawSync(comp)
        : (() => { throw new Error('unsupported zip compression method ' + it.method); })();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      processed++;
      doneBytes += data.length;
      report(false);
    }
    report(true);
    parentPort.postMessage({ type: 'done' });
  } finally {
    fs.closeSync(fd);
  }
}

try {
  run();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: (err && err.message) || String(err) });
}