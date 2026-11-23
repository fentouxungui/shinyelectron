// EPIPE is expected when container log streaming is torn down at shutdown.
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  console.error('Uncaught exception:', err);
  try {
    if (logStream) {
      logStream.write(`[${new Date().toISOString()}] [ERROR] uncaughtException: ${(err && err.stack) || err}\n`);
    }
  } catch { /* logging is best-effort */ }
  // Surface genuine faults instead of silently continuing in a half-broken state.
  process.exit(1);
});

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const backend = require('./backends/{{backend_module}}');
const { createAppStore, cmpVersion, platformKey, downloadUrls } = require('./backends/appstore');

// File logging -- writes to configured log directory or app userData
const LOG_LEVEL = '{{{log_level_js}}}';
const SHELL_R_VERSION = '{{{r_version_js}}}';   // R version the shell bundles
const REPORT_ENDPOINT = '{{{report_endpoint_js}}}';  // empty disables launch-failure reporting
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_THRESHOLD = LOG_LEVEL in LOG_LEVELS ? LOG_LEVELS[LOG_LEVEL] : 1;

const logDir = '{{{log_dir_js}}}' || path.join(app.getPath('userData'), 'logs');
let logStream = null;

function initLogging() {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', function () { /* logging is best-effort */ });
  } catch { /* logging is best-effort */ }
}

// ---- Per-app run logs ------------------------------------------------------
// One file per app launch at <logDir>/apps/<appId>/run-<timestamp>.log, holding
// the backend status phases plus the app child's stdout/stderr. The newest
// APP_LOG_KEEP runs per app are kept; older ones are pruned.
const appLogRoot = path.join(logDir, 'apps');
const APP_LOG_MAX_BYTES = 20 * 1024 * 1024;
const APP_LOG_KEEP = 10;
let appLogStream = null;
let appLogPath = null;
let appLogSize = 0;
let appLogAppId = null;
try { fs.mkdirSync(appLogRoot, { recursive: true }); } catch (e) { /* best effort */ }

function safeLogId(id) {
  return String(id || 'shell').replace(/[^a-zA-Z0-9._-]/g, '_');
}
function pruneAppLogs(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => { const fp = path.join(dir, f); return { p: fp, t: fs.statSync(fp).mtimeMs }; })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(APP_LOG_KEEP)) { try { fs.unlinkSync(f.p); } catch (e) {} }
  } catch (e) { /* best effort */ }
}
function openAppLog(appId) {
  closeAppLog();
  try {
    const dir = path.join(appLogRoot, safeLogId(appId));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    appLogPath = path.join(dir, 'run-' + stamp + '.log');
    appLogStream = fs.createWriteStream(appLogPath, { flags: 'a' });
    appLogStream.on('error', function () { /* logging is best-effort */ });
    appLogSize = 0;
    appLogAppId = appId;
    pruneAppLogs(dir);
    appLogWrite('=== ' + appId + ' run started ' + new Date().toISOString() + ' ===');
  } catch (e) { /* best effort */ }
}
function appLogWrite(line) {
  if (!appLogStream) return;
  if (appLogSize > APP_LOG_MAX_BYTES) return;
  const text = '[' + new Date().toISOString() + '] ' + line + '\n';
  appLogSize += Buffer.byteLength(text);
  if (appLogSize > APP_LOG_MAX_BYTES) {
    try { appLogStream.write('[log truncated: exceeded ' + Math.round(APP_LOG_MAX_BYTES / 1048576) + ' MB]\n'); } catch (e) {}
    return;
  }
  try { appLogStream.write(text); } catch (e) {}
}
function closeAppLog() {
  if (appLogStream) { try { appLogStream.end(); } catch (e) {} }
  appLogStream = null;
  appLogPath = null;
  appLogSize = 0;
  appLogAppId = null;
}
function latestAppLog(appId) {
  const dir = path.join(appLogRoot, safeLogId(appId));
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length) return files[0];
  } catch (e) { /* none */ }
  return null;
}

// ---- User settings (catalog source, local crash reporting) -----------------
const DEFAULT_CATALOG_URL = 'https://fentouxungui.github.io/ShinyApps/catalog.json';
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let appSettings = {};
try { appSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; } catch (e) { appSettings = {}; }
function saveSettings() { try { fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2)); } catch (e) { /* best effort */ } }

// ---- App data location (installed apps + libraries) -----------------------
// Default is a NON-roaming per-user folder so large app bundles are not synced
// by OneDrive / roaming profiles. Users can point it at another drive from
// Settings; the choice is remembered in settings.json (survives a normal
// reinstall, since uninstall does not delete userData).
const DEFAULT_DATA_ROOT = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ShinyApps')
  : app.getPath('userData');
function hasStoreData(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'state.json'))) return true;
    const apps = path.join(dir, 'apps');
    if (fs.existsSync(apps) && fs.readdirSync(apps).length > 0) return true;
  } catch (e) {}
  return false;
}
function resolveDataRoot() {
  let root;
  if (appSettings.dataRoot) {
    root = appSettings.dataRoot;
  } else if (hasStoreData(app.getPath('userData'))) {
    // Existing install: keep the legacy (%APPDATA%) location so its apps stay
    // visible; the user can relocate it from Settings.
    root = app.getPath('userData');
  } else {
    root = DEFAULT_DATA_ROOT;
  }
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
  return root;
}
// Marker inside the data root recording the shell/R versions that created it,
// so a future shell can warn when the R ABI may differ.
function writeRootMarker() {
  try {
    const root = resolveDataRoot();
    const marker = path.join(root, 'root.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) {}
    fs.writeFileSync(marker, JSON.stringify({
      schema: 1, app: 'ShinyApps',
      shellVersion: app.getVersion(), rVersion: SHELL_R_VERSION || '',
      updatedAt: new Date().toISOString()
    }, null, 2));
    if (prev && prev.rVersion && SHELL_R_VERSION && prev.rVersion !== SHELL_R_VERSION) {
      log('warn', 'data root was built with R ' + prev.rVersion + ' but this shell ships R ' + SHELL_R_VERSION + '; installed apps may need reinstalling');
    }
  } catch (e) { log('warn', 'root marker failed:', e && e.message); }
}

// state.json records each install's absolute directory, so after the data root
// moves those paths must be repointed or the migrated apps keep loading from
// the old folder (and break as soon as it is removed).
function rewriteStateDirs(stateFile, fromRoot, toRoot) {
  try {
    if (!fs.existsSync(stateFile)) return;
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const from = path.resolve(fromRoot);
    const to = path.resolve(toRoot);
    let changed = false;
    for (const id of Object.keys(st.apps || {})) {
      const dir = st.apps[id] && st.apps[id].dir;
      if (!dir) continue;
      const resolved = path.resolve(dir);
      if (resolved !== from && resolved.indexOf(from + path.sep) !== 0) continue;
      st.apps[id].dir = path.join(to, path.relative(from, resolved));
      changed = true;
    }
    if (changed) fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  } catch (e) {
    log('warn', 'could not rewrite install paths in ' + stateFile + ':', e && e.message);
  }
}

// Where the shell's bundled R keeps its own library. The store uses this to
// tell which packages the runtime already provides (base + recommended), so
// app bundles never shadow them with binaries built against another R.
function bundledRuntimeLibrary() {
  let base = __dirname;
  const unpacked = base.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== base && fs.existsSync(unpacked)) base = unpacked;
  return path.join(base, 'runtime', 'R', 'library');
}

// Runtime root contains the portable R itself; its library is the sibling
// runtime/R/library. Keeping the root lets appstore locate Rscript and pass the
// exact runtime to a future side-by-side runtime pack.
function bundledRuntimeRoot() {
  return path.dirname(bundledRuntimeLibrary());
}

// Local-only crash capture (opt-in). Uncaught main-process errors are written
// to <logDir>/crashes/. Nothing is ever uploaded.
let crashHandlersInstalled = false;
function installCrashHandlers() {
  if (!appSettings.crashReporting) return;
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  const writeCrash = (kind, err) => {
    if (!appSettings.crashReporting) return;
    try {
      const dir = path.join(logDir, 'crashes');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'crash-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt');
      fs.writeFileSync(f, [
        'ShinyApps crash report',
        'kind: ' + kind,
        'time: ' + new Date().toISOString(),
        'shell: ' + app.getVersion() + '  bundled R: ' + (SHELL_R_VERSION || ''),
        'electron: ' + process.versions.electron + '  node: ' + process.versions.node,
        'os: ' + process.platform + ' ' + process.arch,
        '',
        (err && err.stack) ? err.stack : String(err)
      ].join('\n'));
    } catch (e) { /* best effort */ }
  };
  process.on('uncaughtException', (err) => { writeCrash('uncaughtException', err); log('error', 'uncaughtException:', (err && err.stack) || err); });
  process.on('unhandledRejection', (reason) => { writeCrash('unhandledRejection', reason); });
}

// ---- Launch-failure reporting ---------------------------------------------
// Optional, build-time endpoint (`report.endpoint` in _shinyelectron.yml).
// When set, a failed launch offers to send a redacted diagnostic report.
// Nothing is uploaded without the user choosing "Send report".
const REPORT_TIMEOUT_MS = 20000;
let reportWindow = null;
let reportState = null;
let lastReportKey = '';
let lastReportAt = 0;

function reportEndpoint() {
  return String(appSettings.reportEndpoint || REPORT_ENDPOINT || '').trim();
}

function reportInstallId() {
  if (!appSettings.reportInstallId) {
    try {
      appSettings.reportInstallId = require('crypto').randomUUID();
      saveSettings();
    } catch (e) {
      appSettings.reportInstallId = 'unknown';
    }
  }
  return appSettings.reportInstallId;
}

// Remove the user's home directory, temp directory, and account name from
// log text. Paths stay visible enough to diagnose problems without exposing
// who the user is.
function redactReportText(text) {
  let s = String(text || '');
  const user = process.env.USERNAME || process.env.USER || '';
  const replaceAll = (value, tag) => {
    if (!value) return;
    const forms = [value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')];
    for (const form of forms) {
      if (form) s = s.split(form).join(tag);
    }
  };
  replaceAll(os.homedir(), '<home>');
  replaceAll(os.tmpdir(), '<temp>');
  if (user) {
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('\\b' + escaped + '\\b', 'gi'), '<user>');
  }
  // Common credential shapes. Keep the labels (e.g. "token =") so the log
  // still shows that a secret existed, but never the secret itself.
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>');
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<github-token>');
  s = s.replace(/\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,})\b/g, '<api-key>');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<aws-key>');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '<google-key>');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<slack-token>');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1<token>');
  s = s.replace(/\b(api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*['"]?[A-Za-z0-9._~+/=-]{8,}['"]?/gi, '$1=<redacted>');
  return s;
}

function readLogTail(appId, maxLines = 300) {
  const p = (appLogAppId && String(appLogAppId) === String(appId) && appLogPath)
    ? appLogPath
    : latestAppLog(appId);
  if (!p || !fs.existsSync(p)) return '';
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return lines.slice(-maxLines).join('\n').slice(-200000);
  } catch (e) {
    return '';
  }
}

function reportAppContext(appId) {
  const ins = (appId && appStore && appStore.isInstalled(appId))
    ? appStore.getState().apps[appId]
    : null;
  const ce = (appId && appStore) ? appStore.catalogEntry(appId) : null;
  // Catalog installs do not store the archive hash in state.json; the catalog
  // artifact carries it, so use that as a fallback.
  const artifact = ce && ce.artifacts && ce.artifacts[platformKey()];
  const runtimeId = (ins && ins.runtime) || '';
  const rAbi = (ins && ins.r_abi) || (artifact && artifact.r_abi) || (ce && ce.r_abi) || '';
  let runtimeVersion = '';
  let runtimeSource = '';
  if (appStore && runtimeId && appStore.runtimeInfo) {
    try {
      const rt = appStore.runtimeInfo(runtimeId);
      if (rt) {
        runtimeVersion = rt.version || '';
        runtimeSource = rt.source || '';
      }
    } catch (e) { /* diagnostics are best-effort */ }
  }
  return {
    appVersion: (ins && ins.version) || '',
    catalogVersion: (ce && ce.version) || '',
    bundleSha256: (ins && ins.sha256) || (artifact && artifact.sha256) || '',
    installSource: (ins && ins.source) || '',
    runtimeId: runtimeId,
    rAbi: rAbi,
    runtimeVersion: runtimeVersion,
    runtimeSource: runtimeSource
  };
}

function reportAppChoices() {
  const choices = [];
  if (appStore) {
    const st = appStore.getState();
    for (const id of Object.keys(st.apps || {})) {
      const ctx = reportAppContext(id);
      const ce = appStore.catalogEntry(id);
      const ins = st.apps[id];
      choices.push({
        id: id,
        name: (ce && ce.name) || (ins && ins.meta && ins.meta.name) || id,
        version: ctx.appVersion,
        catalogVersion: ctx.catalogVersion,
        bundleSha256: ctx.bundleSha256,
        installSource: ctx.installSource,
        runtimeId: ctx.runtimeId,
        rAbi: ctx.rAbi,
        runtimeVersion: ctx.runtimeVersion,
        runtimeSource: ctx.runtimeSource
      });
    }
  }
  choices.sort(function (a, b) { return a.name.localeCompare(b.name); });
  choices.push({
    id: 'shinyapps-store',
    name: 'ShinyApps Store itself',
    version: app.getVersion(),
    catalogVersion: '',
    bundleSha256: '',
    installSource: 'shell'
  });
  return choices;
}

const REPORT_CATEGORY_PHASES = {
  launch_failure: 'manual_launch_failure',
  runtime_crash: 'manual_runtime_crash',
  feature_broken: 'manual_feature_broken',
  ui_issue: 'manual_ui_issue',
  other: 'manual_report'
};

function reportFingerprint(payload) {
  return require('crypto').createHash('sha1').update([
    payload.appId,
    payload.appVersion,
    payload.platform,
    payload.runtimeId || '',
    payload.rAbi || '',
    payload.runtimeVersion || '',
    payload.phase,
    String(payload.exitCode ?? ''),
    payload.signal || '',
    String(payload.summary || '').split('\n')[0]
  ].join('|')).digest('hex');
}

function buildLaunchReport(incident) {
  const ctx = reportAppContext(incident.appId);
  const payload = {
    schema: 1,
    installId: reportInstallId(),
    appId: incident.appId || '',
    appVersion: ctx.appVersion,
    catalogVersion: ctx.catalogVersion,
    bundleSha256: ctx.bundleSha256,
    installSource: ctx.installSource,
    shellVersion: app.getVersion(),
    rVersion: SHELL_R_VERSION || '',
    runtimeId: ctx.runtimeId || '',
    rAbi: ctx.rAbi || '',
    runtimeVersion: ctx.runtimeVersion || '',
    runtimeSource: ctx.runtimeSource || '',
    installedRuntimes: (function () {
      try {
        const st = appStore && appStore.getState ? appStore.getState() : null;
        return Object.keys((st && st.runtimes) || {});
      } catch (e) { return []; }
    })(),
    platform: platformKey(),
    os: os.type() + ' ' + os.release() + ' (' + os.arch() + ')',
    phase: incident.phase || 'pre_ready_failure',
    exitCode: incident.exitCode ?? null,
    signal: incident.signal || '',
    summary: redactReportText(incident.summary || 'App failed to start').slice(0, 2000),
    fingerprint: '',
    logTail: redactReportText(incident.logTail || readLogTail(incident.appId)),
    timestamp: new Date().toISOString()
  };
  payload.fingerprint = reportFingerprint(payload);
  return payload;
}

function launchReportText(payload) {
  return [
    'ShinyApps launch report',
    'app: ' + payload.appId + ' ' + (payload.appVersion || ''),
    'platform: ' + payload.platform + '  shell: ' + payload.shellVersion + '  R: ' + payload.rVersion,
    'runtime: ' + (payload.runtimeId || 'unknown') +
      '  ABI: ' + (payload.rAbi || 'unknown') +
      '  R: ' + (payload.runtimeVersion || 'unknown') +
      '  source: ' + (payload.runtimeSource || 'unknown'),
    'installed runtimes: ' + ((payload.installedRuntimes || []).join(', ') || 'unknown'),
    'catalog: ' + (payload.catalogVersion || 'unknown') +
      '  bundle: ' + (payload.bundleSha256 ? String(payload.bundleSha256).slice(0, 12) : 'unknown') +
      '  source: ' + (payload.installSource || 'unknown'),
    'phase: ' + payload.phase + '  exit: ' + (payload.exitCode ?? '') + ' ' + (payload.signal || ''),
    'fingerprint: ' + payload.fingerprint,
    'installId: ' + (payload.installId || 'unknown') + '  time: ' + payload.timestamp,
    'email: ' + (payload.email || '(not provided)'),
    '',
    payload.summary,
    '',
    payload.logTail || '(no log attached)'
  ].join('\n');
}

function closeReportWindow() {
  if (reportWindow && !reportWindow.isDestroyed()) reportWindow.close();
  reportWindow = null;
  reportState = null;
}

function openReportWindow() {
  if (reportWindow && !reportWindow.isDestroyed()) {
    reportWindow.focus();
    return;
  }
  const { BrowserWindow } = require('electron');
  reportWindow = new BrowserWindow({
    width: 780,
    height: 700,
    minWidth: 640,
    minHeight: 520,
    parent: (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined,
    modal: true,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Report a Problem',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'report-preload.js'),
      enableRemoteModule: false,
      webSecurity: true
    }
  });
  reportWindow.on('closed', function () {
    reportWindow = null;
    reportState = null;
  });
  reportWindow.once('ready-to-show', function () {
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.show();
  });
  reportWindow.webContents.on('did-fail-load', function (_event, code, desc) {
    log('warn', 'report window failed to load:', code, desc);
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.show();
  });
  reportWindow.loadFile(path.join(__dirname, 'report.html'), { query: { theme: currentThemeMode } });
}

async function postLaunchReport(payload) {
  const endpoint = reportEndpoint();
  if (!endpoint) throw new Error('No report endpoint configured');
  const { net } = require('electron');
  if (!net || typeof net.fetch !== 'function') throw new Error('net.fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await net.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function pendingReportDir() {
  const dir = path.join(app.getPath('userData'), 'pending-reports');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best effort */ }
  return dir;
}

function prunePendingReports(maxFiles) {
  const keep = maxFiles || 50;
  try {
    const dir = pendingReportDir();
    const files = fs.readdirSync(dir)
      .filter(function (f) { return f.endsWith('.json'); })
      .map(function (f) {
        const p = path.join(dir, f);
        return { p: p, t: fs.statSync(p).mtimeMs };
      })
      .sort(function (a, b) { return b.t - a.t; });
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(f.p); } catch (e) { /* best effort */ }
    }
  } catch (e) { /* best effort */ }
}

function savePendingReport(payload) {
  try {
    // One queued copy per fingerprint; a retry replaces the old file.
    try { removePendingReport(payload.fingerprint); } catch (e) { /* best effort */ }
    const dir = pendingReportDir();
    const safe = String(payload.fingerprint || 'report')
      .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const file = path.join(dir, Date.now() + '-' + safe + '.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 1,
      queuedAt: new Date().toISOString(),
      payload: payload
    }, null, 2));
    prunePendingReports(50);
    log('info', 'queued launch report for retry:', file);
    return file;
  } catch (e) {
    log('warn', 'could not queue launch report:', e && e.message);
    return null;
  }
}

function removePendingReport(fingerprint) {
  if (!fingerprint) return;
  try {
    const dir = pendingReportDir();
    for (const f of fs.readdirSync(dir).filter(function (x) { return x.endsWith('.json'); })) {
      const file = path.join(dir, f);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.payload && data.payload.fingerprint === fingerprint) {
          fs.unlinkSync(file);
        }
      } catch (e) { /* leave unreadable files for manual cleanup */ }
    }
  } catch (e) { /* best effort */ }
}

let pendingFlushInFlight = false;
async function flushPendingReports() {
  if (pendingFlushInFlight || !reportEndpoint()) return;
  pendingFlushInFlight = true;
  try {
    const dir = pendingReportDir();
    const files = fs.readdirSync(dir)
      .filter(function (f) { return f.endsWith('.json'); })
      .map(function (f) { return path.join(dir, f); });
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || !data.payload || !data.payload.appId) {
          fs.unlinkSync(file);
          continue;
        }
        await postLaunchReport(data.payload);
        fs.unlinkSync(file);
        log('info', 'pending launch report sent:', data.payload.fingerprint);
      } catch (e) {
        log('warn', 'pending launch report still failing:', e && e.message);
        // Most likely still offline; stop and retry on the next launch.
        break;
      }
    }
  } catch (e) {
    log('warn', 'pending report flush failed:', e && e.message);
  } finally {
    pendingFlushInFlight = false;
  }
}

async function reportLaunchFailure(incident) {
  if (!reportEndpoint()) return;
  const payload = buildLaunchReport(incident);
  const manual = payload.phase === 'manual_report';
  if (!manual) {
    const now = Date.now();
    // Do not ask again for the same failure within five minutes.
    if (payload.fingerprint === lastReportKey && now - lastReportAt < 5 * 60 * 1000) return;
  }
  // A manual report opens every time; an open dialog is just focused.
  if (reportWindow && !reportWindow.isDestroyed()) {
    reportWindow.focus();
    return;
  }
  const choices = manual ? reportAppChoices() : [];
  const preferred = lastSelectedAppId || '';
  const defaultAppId = manual && choices.some(function (c) { return c.id === preferred; })
    ? preferred
    : (manual ? 'shinyapps-store' : payload.appId);
  reportState = {
    mode: manual ? 'manual' : 'failure',
    payload,
    email: appSettings.reportEmail || '',
    apps: choices,
    defaultAppId: defaultAppId
  };
  openReportWindow();
}

ipcMain.handle('report-get-payload', () => reportState);

ipcMain.on('report-action', async (_event, data) => {
  if (!reportState || !reportWindow || reportWindow.isDestroyed()) return;
  const action = data && data.action;
  const incoming = (data && data.payload) || {};
  // The renderer may edit only the summary (manual reports) and whether the
  // log is included; everything else stays the main process's payload.
  const payload = Object.assign({}, reportState.payload);
  if (reportState.mode === 'manual') {
    if (typeof incoming.summary === 'string') {
      payload.summary = incoming.summary.slice(0, 2000);
    }
    if (typeof incoming.category === 'string' && REPORT_CATEGORY_PHASES[incoming.category]) {
      payload.category = incoming.category;
      payload.phase = REPORT_CATEGORY_PHASES[incoming.category];
    } else {
      payload.category = payload.category || 'other';
    }
    if (typeof incoming.selectedAppId === 'string') {
      const chosen = (reportState.apps || []).find(function (a) {
        return a.id === incoming.selectedAppId;
      });
      if (chosen) {
        payload.appId = chosen.id;
        payload.appVersion = chosen.version || '';
        payload.catalogVersion = chosen.catalogVersion || '';
        payload.bundleSha256 = chosen.bundleSha256 || '';
        payload.installSource = chosen.installSource || '';
        payload.runtimeId = chosen.runtimeId || '';
        payload.rAbi = chosen.rAbi || '';
        payload.runtimeVersion = chosen.runtimeVersion || '';
        payload.runtimeSource = chosen.runtimeSource || '';
        payload.logTail = incoming.includeLog === false ? '' : readLogTail(chosen.id);
      }
    } else if (incoming.includeLog === false) {
      payload.logTail = '';
    } else if (!payload.logTail) {
      payload.logTail = readLogTail(payload.appId);
    }
  } else {
    payload.category = payload.category || (
      payload.phase === 'post_ready_failure' ? 'runtime_crash' : 'launch_failure'
    );
    if (typeof incoming.logTail === 'string') {
      payload.logTail = incoming.logTail.slice(0, 200000);
    }
    if (incoming.includeLog === false) payload.logTail = '';
  }
  if (typeof incoming.email === 'string') {
    payload.email = incoming.email.trim().slice(0, 254);
  }
  // These are renderer-to-main hints, not part of the report contract.
  delete payload.selectedAppId;
  delete payload.includeLog;
  payload.fingerprint = reportFingerprint(payload);

  const reply = (message, kind, extra) => {
    if (reportWindow && !reportWindow.isDestroyed()) {
      reportWindow.webContents.send('report-status', Object.assign({ message, kind }, extra || {}));
    }
  };

  if (action === 'cancel') {
    closeReportWindow();
    return;
  }
  // Validate and persist the optional contact address for the next report.
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    reply('Please enter a valid email or leave it blank.', 'err');
    return;
  }
  if (payload.email) appSettings.reportEmail = payload.email;
  else delete appSettings.reportEmail;
  saveSettings();
  if (action === 'copy') {
    const { clipboard } = require('electron');
    clipboard.writeText(launchReportText(payload));
    reply('Diagnostics copied to clipboard', 'info');
    return;
  }
  if (action === 'send') {
    if (reportState.mode === 'manual' && !String(payload.summary || '').trim()) {
      reply('Please describe the problem first.', 'err');
      return;
    }
    try {
      const result = await postLaunchReport(payload);
      lastReportKey = payload.fingerprint;
      lastReportAt = Date.now();
      log('info', 'launch report sent:', result.id);
      removePendingReport(payload.fingerprint);
      reply('Report sent', 'ok', {
        reportId: result.id,
        deduped: !!result.deduped,
        email: payload.email || ''
      });
    } catch (e) {
      log('warn', 'launch report failed:', e && e.message);
      const queued = savePendingReport(payload);
      reply(
        'Could not send the report: ' + (e && e.message ? e.message : String(e)) +
          (queued
            ? '. It has been saved and will be retried next time.'
            : '. You can copy the diagnostics instead.'),
        'err'
      );
    }
  }
});

ipcMain.on('report-copy-text', (_event, text) => {
  try { require('electron').clipboard.writeText(String(text || '')); } catch (e) { /* best effort */ }
});

// ---- Uninstall / reset ----------------------------------------------------
function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb >= 10) return Math.round(mb) + ' MB';
  return mb.toFixed(1) + ' MB';
}
function shellDisplayName() { return '{{{app_name_js}}}'; }
function platformLabelFor(p) {
  switch (p) {
    case 'win-x64': return 'Windows x64';
    case 'win-arm64': return 'Windows arm64';
    case 'mac-arm64': return 'macOS arm64';
    case 'mac-x64': return 'macOS Intel';
    case 'linux-x64': return 'Linux x64';
    default: return p || 'this platform';
  }
}
// Bound a request so an offline/blocked network cannot keep the launcher on a
// skeleton screen for the socket timeout. The request may finish later; its
// result is cached by the caller for the next refresh.
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out after ' + ms + ' ms')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function closeAllLogs() {
  try { if (logStream) { logStream.end(); logStream = null; } } catch (e) {}
  closeAppLog();
}
function findUninstaller() {
  try {
    const dir = path.dirname(app.getPath('exe'));
    const hit = fs.readdirSync(dir).find((f) => /^Uninstall.*\.exe$/i.test(f));
    return hit ? path.join(dir, hit) : null;
  } catch (e) { return null; }
}
// Stop backends, close logs, then remove every local store file (thorough).
// The store data root and a custom log folder can live outside userData (the
// Windows default data root is %LOCALAPPDATA%\<app>), so they are wiped too.
async function wipeAllLocalData(onProgress) {
  const report = (typeof onProgress === 'function') ? onProgress : function () {};
  report(0, 0, 'Stopping apps\u2026');
  if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
  closeAllLogs();
  const userData = app.getPath('userData');
  const dataRoot = resolveDataRoot();
  const storeItems = ['apps', 'lib', 'private', 'store-cache', 'icons', 'catalog-cache.json', 'state.json', 'root.json'];
  const targets = [];
  const addTarget = function (p) {
    try {
      const r = path.resolve(p);
      if (!targets.some(function (t) { return path.resolve(t) === r; })) targets.push(p);
    } catch (e) { /* skip unusable path */ }
  };
  for (const t of ['apps', 'lib', 'private', 'store-cache', 'icons', 'catalog-cache.json', 'state.json', 'root.json', 'settings.json', 'logs', 'crashes', 'window-state.json', 'pending-reports']) {
    addTarget(path.join(userData, t));
  }
  if (path.resolve(dataRoot) !== path.resolve(userData)) {
    for (const t of storeItems) addTarget(path.join(dataRoot, t));
  }
  try {
    const logs = path.resolve(logDir);
    const ud = path.resolve(userData);
    if (logs !== ud && logs.indexOf(ud + path.sep) !== 0) addTarget(logDir);
  } catch (e) { /* logging is best-effort */ }
  let done = 0;
  for (const t of targets) {
    try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {}
    done++;
    report(done, targets.length, 'Removing data\u2026');
  }
  // Do not leave an empty app-data folder behind when everything in it was ours.
  try {
    if (path.resolve(dataRoot) !== path.resolve(userData)) {
      fs.rmdirSync(dataRoot);
    }
  } catch (e) { /* not empty or already gone */ }
}
function runningStoreApps() {
  if (!appStore) return [];
  const out = [];
  try {
    const st = appStore.getState();
    const apps = (st && st.apps) || {};
    for (const id of Object.keys(apps)) {
      if (appStore.isRunning(id)) out.push((apps[id].meta && apps[id].meta.name) || id);
    }
  } catch (e) {}
  return out;
}
async function uninstallShinyApps() {
  const { dialog } = require('electron');
  const name = shellDisplayName();
  const runningUn = runningStoreApps();
  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning', noLink: true,
    title: 'Uninstall ' + name,
    message: 'Uninstall ' + name + '?',
    detail: 'Choose whether to also remove installed applications and all local data.' +
      (runningUn.length ? ('\n\nRunning now: ' + runningUn.join(', ') + ' (will be stopped).') : ''),
    buttons: ['Uninstall', 'Uninstall and remove all apps & data', 'Cancel'],
    defaultId: 2, cancelId: 2
  });
  if (first.response === 2) return;
  const thorough = first.response === 1;
  if (thorough) {
    let n = 0, bytes = 0, ids = '';
    if (appStore) {
      try {
        const u = await appStore.usage();
        n = (u.apps || []).length;
        bytes = u.total || 0;
        ids = (u.apps || []).map((a) => a.id).join(', ');
      } catch (e) {}
    }
    const second = await dialog.showMessageBox(mainWindow, {
      type: 'warning', noLink: true,
      title: 'Remove all apps and data',
      message: 'Delete all installed applications and local data?',
      detail: 'This permanently deletes everything under:\n' + app.getPath('userData') +
        '\n\n' + (n ? ('Installed apps (' + n + '): ' + ids + '\n') : '') +
        'About ' + fmtBytes(bytes) + ' will be freed.\n\nThis cannot be undone.',
      buttons: ['Delete and uninstall', 'Cancel'], defaultId: 1, cancelId: 1
    });
    if (second.response !== 0) return;
  }
  app.isQuitting = true;
  if (thorough) storeCommand({ cmd: 'busy_begin', title: 'Uninstalling ' + name + '\u2026' });
  // Stop in-flight installs before their directories are deleted.
  try { await cancelAllStoreTasks(); } catch (e) { /* best effort */ }
  try {
    if (thorough) {
      await wipeAllLocalData(function (done, total, label) {
        storeCommand({ cmd: 'busy_progress', done: done, total: total, label: label });
      });
    } else if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
  } catch (e) { log('warn', 'uninstall cleanup failed:', e && e.message); }
  const un = findUninstaller();
  if (un) {
    const { spawn } = require('child_process');
    try { const c = spawn(un, [], { detached: true, stdio: 'ignore' }); c.unref(); } catch (e) { log('error', 'uninstaller spawn failed:', e && e.message); }
    app.quit();
  } else {
    storeCommand({ cmd: 'busy_done' });
    await dialog.showMessageBox(mainWindow, {
      type: 'info', noLink: true,
      title: 'Uninstall ' + name,
      message: 'Uninstaller not found',
      detail: 'This copy was not installed from a release. Remove the app folder manually, or uninstall ' + name + ' from Windows Settings > Apps.'
    });
  }
}
async function resetLocalData() {
  const { dialog } = require('electron');
  const runningReset = runningStoreApps();
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning', noLink: true,
    title: 'Reset local data',
    message: 'Remove all installed apps, shared packages, caches and logs?',
    detail: shellDisplayName() + ' stays installed. Your settings (e.g. catalog URL) are kept.' +
      (runningReset.length ? ('\n\nRunning now: ' + runningReset.join(', ') + ' (will be stopped).') : ''),
    buttons: ['Reset', 'Cancel'], defaultId: 1, cancelId: 1
  });
  if (r.response !== 0) return;
  storeCommand({ cmd: 'busy_begin', title: 'Resetting local data\u2026' });
  // Finish/cancel downloads before their staging and cache directories vanish.
  try { await cancelAllStoreTasks(); } catch (e) { /* best effort */ }
  const onResetProgress = function (done, total, label) {
    storeCommand({ cmd: 'busy_progress', done: done, total: total, label: label });
  };
  if (appStore) { try { await appStore.resetLocal(onResetProgress); } catch (e) { log('warn', 'reset failed:', e && e.message); } }
  // resetLocal stopped the apps; close the now-dead app window too.
  closeAppWindow();
  currentAppMeta = null;
  lastSelectedAppId = null;
  closeAllLogs();
  const userData = app.getPath('userData');
  for (const t of ['logs', 'crashes']) {
    try { fs.rmSync(path.join(userData, t), { recursive: true, force: true }); } catch (e) {}
  }
  initLogging();   // re-open the shell log we just deleted
  storeCommand({ cmd: 'busy_done' });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('launcher.html');
}

function log(level, ...args) {
  if ((LOG_LEVELS[level] || 0) < LOG_THRESHOLD) return;
  const msg = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.join(' ')}`;
  if (logStream) logStream.write(msg + '\n');
  if (level === 'error') console.error(...args);
  else console.log(...args);
}

// For multi-app mode, backends are loaded dynamically
let currentBackend = backend;
let appsManifest = null;

// ---- Resource metrics (CPU / RAM overlay) --------------------------------
// System totals from os.cpus()/os.freemem(), plus the running app's process
// tree (R/Python child and its children) read from the OS. Sampling only runs
// while an app is up, so an idle launcher costs nothing.
let metricsTimer = null;
let lastCpuTimes = null;
let procTimeByPid = new Map();
let lastProcSampleAt = 0;
let processTableReader = null;   // 'wmic' | 'powershell' | 'ps' | 'off'
let metricsBusy = false;
let metricsReadFailures = 0;
// True while the window title carries our CPU/RAM suffix, so leaving an app
// page can hand the title back to the page instead of leaving it stale.
let metricsTitleActive = false;

function metricsEnabled() { return appSettings.metricsOverlay !== false; }

function contentWebContents() {
  if (appView && !appView.webContents.isDestroyed()) return appView.webContents;
  var win = contentWindow();
  return (win && !win.webContents.isDestroyed()) ? win.webContents : null;
}

function windowLoading() {
  var wc = contentWebContents();
  try { return !wc || wc.isDestroyed() || wc.isLoading(); }
  catch (e) { return true; }
}

function metricsPageActive() {
  var wc = contentWebContents();
  if (!wc || wc.isDestroyed()) return false;
  try {
    if (wc.isLoading()) return false;
    return /^https?:/i.test(wc.getURL() || '');
  } catch (e) { return false; }
}

// Remove a CPU/RAM title and hand the window back to the page's own <title>.
// `force` is for turning the overlay off when the page is not an app page.
function restorePageTitle(force) {
  var win = contentWindow();
  if (!win || win.isDestroyed()) return;
  if (!metricsTitleActive && !force) return;
  var title = '';
  try { title = String(win.webContents.getTitle() || '').trim(); } catch (e) {}
  win.setTitle(title || '{{{app_name_js}}}');
  metricsTitleActive = false;
}

function systemCpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + (t.idle || 0);
  }
  let percent = 0;
  if (lastCpuTimes && total > lastCpuTimes.total) {
    const dTotal = total - lastCpuTimes.total;
    const dIdle = idle - lastCpuTimes.idle;
    percent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  lastCpuTimes = { idle, total };
  return percent;
}

// "[[dd-]hh:]mm:ss[.frac]" (ps) -> seconds.
function parseCpuClock(text) {
  let s = String(text || '0');
  let days = 0;
  const dash = s.indexOf('-');
  if (dash !== -1) { days = Number(s.slice(0, dash)) || 0; s = s.slice(dash + 1); }
  const parts = s.split(':').map(Number);
  let seconds = 0;
  for (const v of parts) seconds = seconds * 60 + (v || 0);
  return days * 86400 + seconds;
}

function parseWmicCsv(stdout) {
  const rows = [];
  let header = null;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(',');
    if (!header) { header = fields.map((f) => f.trim()); continue; }
    if (fields.length < header.length) continue;
    const rec = {};
    header.forEach((h, i) => { rec[h] = fields[i]; });
    const pid = Number(rec.ProcessId);
    if (!pid) continue;
    rows.push({
      pid,
      ppid: Number(rec.ParentProcessId) || 0,
      rss: Number(rec.WorkingSetSize) || 0,
      // wmic reports 100 ns units
      cpuSeconds: ((Number(rec.UserModeTime) || 0) + (Number(rec.KernelModeTime) || 0)) / 1e7,
    });
  }
  return rows;
}

function parseWmicJson(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch (e) { return []; }
  if (!Array.isArray(data)) data = data ? [data] : [];
  return data.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId) || 0,
    rss: Number(r.WorkingSetSize) || 0,
    cpuSeconds: ((Number(r.UserModeTime) || 0) + (Number(r.KernelModeTime) || 0)) / 1e7,
  })).filter((r) => r.pid);
}

function parseUnixPs(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = Number(f[0]);
    if (!pid) continue;
    rows.push({
      pid,
      ppid: Number(f[1]) || 0,
      rss: (Number(f[2]) || 0) * 1024,   // ps rss is KiB
      cpuSeconds: parseCpuClock(f[3]),
    });
  }
  return rows;
}

function readProcessTableWithPowerShell(done) {
  const { execFile } = require('child_process');
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => done(err || !stdout ? [] : parseWmicJson(stdout)));
}

function readProcessTable(done) {
  const { execFile } = require('child_process');
  if (processTableReader === 'off') return done([]);
  if (process.platform === 'win32') {
    if (processTableReader === 'powershell') return readProcessTableWithPowerShell(done);
    const args = ['process', 'get', 'ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime', '/format:csv'];
    execFile('wmic.exe', args, { timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        // wmic is absent from newer Windows builds; use CIM from then on.
        processTableReader = 'powershell';
        return readProcessTableWithPowerShell(done);
      }
      processTableReader = 'wmic';
      done(parseWmicCsv(stdout));
    });
    return;
  }
  processTableReader = 'ps';
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { timeout: 5000 }, (err, stdout) => {
    done(err || !stdout ? [] : parseUnixPs(stdout));
  });
}

function backendRootPids() {
  const b = currentBackend;
  if (!b) return [];
  const pids = [];
  for (const key of ['rProcess', 'pyProcess']) {
    const child = b[key];
    if (child && child.pid) pids.push(child.pid);
  }
  return pids;
}

function appUsageFromTable(table) {
  const roots = backendRootPids();
  if (!roots.length) { procTimeByPid = new Map(); lastProcSampleAt = 0; return null; }
  const byPid = new Map();
  const children = new Map();
  for (const row of table) {
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seen = new Set();
  const stack = roots.slice();
  const nextTimes = new Map();
  let mem = 0;
  let cpuDelta = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) continue;
    mem += row.rss;
    const prev = procTimeByPid.get(pid);
    if (prev != null && row.cpuSeconds >= prev) cpuDelta += row.cpuSeconds - prev;
    nextTimes.set(pid, row.cpuSeconds);
    for (const child of (children.get(pid) || [])) stack.push(child);
  }
  const now = Date.now();
  const elapsed = lastProcSampleAt ? (now - lastProcSampleAt) / 1000 : 0;
  lastProcSampleAt = now;
  procTimeByPid = nextTimes;
  const cores = (os.cpus() || []).length || 1;
  const cpu = elapsed > 0.2 ? Math.min(100, (cpuDelta / elapsed) * 100 / cores) : 0;
  return { cpu, mem };
}

function fmtGB(bytes) { return (Number(bytes || 0) / 1073741824).toFixed(1) + ' GB'; }
function fmtPct(value) { return value < 10 ? value.toFixed(1) : String(Math.round(value)); }

// Compose the title-bar text: "<App> — CPU 23% · RAM 5.1/15.9 GB (app 4.1% · 1.2 GB)".
// The app part is dropped when the process tree cannot be read, so a narrow
// title bar truncates only the least important part.
function setMetricsTitle(sys, app) {
  var win = contentWindow();
  if (!win || win.isDestroyed()) return;
  var meta = currentAppMeta || (lastSelectedAppId ? appMetaFor(lastSelectedAppId) : null);
  var base = (meta && meta.name) || lastSelectedAppId || '{{{app_name_js}}}';
  var text = base + ' \u2014 CPU ' + Math.round(sys.cpu) + '% \u00b7 RAM ' +
    (sys.memUsed / 1073741824).toFixed(1) + '/' + (sys.memTotal / 1073741824).toFixed(1) + ' GB';
  if (app) text += '  (app ' + fmtPct(app.cpu) + '% \u00b7 ' + fmtGB(app.mem) + ')';
  win.setTitle(text);
  metricsTitleActive = true;
}

function metricsTick() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const enabled = metricsEnabled();
  // Called every tick even when unused so the CPU delta keeps a steady window.
  const sys = {
    cpu: systemCpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
  };
  // A title write during navigation races the incoming page's <title>: wait
  // for the load to finish, then decide from the committed URL.
  if (windowLoading()) {
    procTimeByPid = new Map();
    lastProcSampleAt = 0;
    return;
  }
  // Only an app page shows metrics; on the launcher/lifecycle page, drop any
  // suffix written earlier and let the page's own <title> take over.
  const onAppPage = metricsPageActive();
  if (!enabled || !onAppPage) {
    procTimeByPid = new Map();
    lastProcSampleAt = 0;
    if (!onAppPage) restorePageTitle();
    return;
  }
  if (!backendRootPids().length) {
    procTimeByPid = new Map();
    lastProcSampleAt = 0;
    setMetricsTitle(sys, null);
    return;
  }
  // A slow OS query (large process table, antivirus) must not stack up ticks.
  if (metricsBusy) return;
  metricsBusy = true;
  readProcessTable((table) => {
    metricsBusy = false;
    // The read is asynchronous: the window may have left the app page (or
    // started navigating) while it ran. Never write a stale app title then.
    if (!metricsEnabled() || !metricsPageActive()) {
      procTimeByPid = new Map();
      lastProcSampleAt = 0;
      if (!windowLoading()) restorePageTitle();
      return;
    }
    if (!table || !table.length) {
      // Three empty tables in a row mean the OS query does not work here;
      // stop spawning it and show the system figures only.
      if (++metricsReadFailures >= 3 && processTableReader !== 'off') {
        processTableReader = 'off';
        log('warn', 'process metrics unavailable; showing system totals only');
      }
      table = [];
    } else {
      metricsReadFailures = 0;
    }
    const app = table.length ? appUsageFromTable(table) : null;
    setMetricsTitle(sys, app);
  });
}

function startMetrics() {
  if (metricsTimer) return;
  log('info', '[metrics] CPU/RAM title sampler started (title bar ' + (metricsEnabled() ? 'on' : 'off') + ', reader ' + (process.platform === 'win32' ? 'wmic/CIM' : 'ps') + ')');
  metricsTick();
  metricsTimer = setInterval(metricsTick, 2000);
  if (metricsTimer.unref) metricsTimer.unref();
}

function stopMetrics() {
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
}

// Check if this is a multi-app build
const manifestPath = path.join(__dirname, 'apps-manifest.json');
if (fs.existsSync(manifestPath)) {
  appsManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { checkManifestSchema } = require('./backends/utils');
  checkManifestSchema(appsManifest, 'apps');
}

function getBackendForApp(appType, runtimeStrategy) {
  if (runtimeStrategy === 'shinylive') return require('./backends/shinylive');
  if (runtimeStrategy === 'container') return require('./backends/container');
  if (appType.startsWith('r-')) return require('./backends/native-r');
  return require('./backends/native-py');
}

// A backend start() that stop() or a newer start() superseded rejects with
// this code. It has nothing left to show, so its callers ignore it.
function isSupersededStart(err) {
  return Boolean(err && err.code === 'START_SUPERSEDED');
}

{{#updates_enabled}}
const { autoUpdater } = require('electron-updater');
const updaterLog = require('electron-log');
// True while Help > About > Check for Updates runs; it answers in its own
// dialog, so the update-available notification stays quiet.
let interactiveUpdateCheck = false;
{{/updates_enabled}}

let mainWindow;
let isShuttingDown = false;
let serverRunning = false;
let actualPort = null;
let lastSelectedAppId = null;
let sharedShinyliveServer = null;
let sharedShinylivePort = null;
let isLauncherVisible = true;   // true while the launcher page is shown (multi-app)
// Which window owns the menu bar: the launcher (full store menu) or the app
// window (reduced menu: no Apps/Settings, no User/Developer Guide).
let menuSurface = 'launcher';
// Theme mode chosen in the launcher ('system'|'light'|'dark'); mirrored here for the Settings menu.
let currentThemeMode = 'system';
let appStore = null;
// Last loaded URL per catalog app id, so a still-running app can be re-opened.
var storeAppUrls = {};
// Backend object owned by each catalog app. The single currentBackend global
// is not enough when one app is still exiting as another starts.
const storeBackends = new Map();
// The running catalog app lives in its own window; the launcher stays usable
// in mainWindow. Only one app runs at a time (multi-instance is a later step).
let appWindow = null;
let appWindowAppId = null;
let appView = null;              // WebContentsView holding lifecycle/app content
let appWindowClosePromptOpen = false;
// Set only when the USER closes the app window (not when a failed start or a
// switch closes it). Used to avoid reporting a user-cancelled start as an error.
let appWindowClosedByUser = null;
// Background store tasks: downloads may run concurrently, while appstore.js
// serializes the shared-library commit. Extra requests wait in a priority
// queue instead of blocking the whole UI.
const STORE_TASK_CONCURRENCY = 2;
let storeTaskSeq = 0;
const storeTasks = new Map();   // taskId -> task
// Synchronous guard: an app becomes "running" only after its backend answers,
// so block a second Launch during that window as well.
let launchingAppId = null;
// Quick Run ordering pushed by the launcher (favorites -> usage -> recent).
let quickRunOrder = [];
let quickRunFavorites = {};

function sendStoreStatus(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', ev);
}
function taskIsActive(t) { return !!t && (t.state === 'queued' || t.state === 'running'); }
function storeTaskForApp(appId) {
  for (const t of storeTasks.values()) {
    if (taskIsActive(t) && t.appId === appId && t.op !== 'install_bundle') return t;
  }
  return null;
}
function publicStoreTask(t) {
  return {
    taskId: t.taskId,
    appId: t.appId,
    op: t.op,
    state: t.state === 'running' ? 'installing' : t.state,
    percent: t.percent || 0,
    statusText: t.statusText || '',
    step: t.step || '',
    error: t.error || '',
    cancelled: !!t.cancelled,
  };
}
function activeStoreTasks() {
  return Array.from(storeTasks.values()).filter(taskIsActive).sort(function (a, b) { return a.seq - b.seq; });
}
function emitTaskProgress(task, pp) {
  var now = Date.now();
  if (pp && pp.phase === task.lastPhase && now - task.lastAt < 100) return;
  task.lastAt = now;
  task.lastPhase = pp && pp.phase;
  task.percent = Math.round((pp && pp.percent) || 0);
  task.statusText = (pp && (pp.statusText || pp.phase)) || '';
  task.step = (pp && pp.phase) || '';
  sendStoreStatus({
    id: task.appId, taskId: task.taskId, state: 'installing', op: task.op,
    percent: task.percent, statusText: task.statusText, step: task.step,
    name: task.displayName || '', description: task.displayDescription || '',
  });
}
function launchStoreTask(task) {
  task.state = 'running';
  sendStoreStatus({
    id: task.appId, taskId: task.taskId, state: 'installing', op: task.op,
    statusText: 'starting…', name: task.displayName || '', description: task.displayDescription || '',
  });
  task.promise = Promise.resolve()
    .then(function () { return task.run(task); })
    .then(
      function (result) { finishStoreTask(task, null, result); },
      function (err) { finishStoreTask(task, err || new Error('operation failed')); }
    );
  return task.promise;
}
function pumpStoreTasks() {
  var running = 0;
  storeTasks.forEach(function (t) { if (t.state === 'running') running++; });
  var slots = STORE_TASK_CONCURRENCY - running;
  if (slots <= 0) return;
  var queued = Array.from(storeTasks.values())
    .filter(function (t) { return t.state === 'queued' && !t.cancelled; })
    .sort(function (a, b) { return (b.priority - a.priority) || (a.seq - b.seq); });
  for (var i = 0; i < queued.length && slots > 0; i++) {
    slots--;
    launchStoreTask(queued[i]);
  }
}
function finishStoreTask(task, err, result) {
  if (task.state === 'done' || task.state === 'error' || task.state === 'cancelled') return;
  var cancelled = !!(err && (err.code === 'CANCELLED' || err.cancelled || task.cancelled));
  task.cancelled = cancelled;
  task.state = err ? (cancelled ? 'cancelled' : 'error') : 'done';
  task.error = err ? ((err && err.message) || String(err)) : '';
  task.percent = 100;
  task.statusText = err ? (cancelled ? 'cancelled' : 'failed') : 'done';
  task.step = err ? ((err && err.step) || task.step || '') : 'done';
  if (task.op === 'uninstall_app' || task.op === 'update_app' || task.op === 'install_app') {
    delete storeAppUrls[task.appId];
  }
  sendStoreStatus({
    id: task.appId, taskId: task.taskId, state: err ? 'error' : 'done', op: task.op,
    error: task.error, cancelled: cancelled, step: task.step,
    appId: (result && result.id) || '',
    installedVersion: (result && result.version) || '',
  });
  {{#menu_enabled}}
  try { createMenu(); } catch (e) { /* menu is best-effort */ }
  {{/menu_enabled}}
  // Keep the finished task briefly so a concurrent refresh can still show its
  // final state; the Installing tab only lists queued/running tasks.
  setTimeout(function () {
    if (storeTasks.get(task.taskId) === task) storeTasks.delete(task.taskId);
  }, 60000);
  pumpStoreTasks();
}
function registerStoreTask(opts) {
  var seq = ++storeTaskSeq;
  var taskId = opts.taskId ||
    ((opts.appId === '__bundle__' ? 'bundle' : 'app') + ':' + opts.appId + ':' + seq);
  var controller = new AbortController();
  var task = {
    taskId: taskId, seq: seq, appId: opts.appId, op: opts.op,
    priority: opts.priority || 1,
    state: 'queued', percent: 0, statusText: 'queued', step: 'queued',
    error: '', cancelled: false, controller: controller, signal: controller.signal,
    run: opts.run, promise: null, lastAt: 0, lastPhase: '',
    displayName: opts.displayName || '', displayDescription: opts.displayDescription || '',
  };
  storeTasks.set(taskId, task);
  if (opts.immediate) launchStoreTask(task);
  else {
    sendStoreStatus({
      id: task.appId, taskId: taskId, state: 'queued', op: task.op,
      statusText: 'queued', name: task.displayName || '', description: task.displayDescription || '',
    });
    pumpStoreTasks();
  }
  return task;
}
function cancelStoreTask(taskId) {
  var task = taskId ? storeTasks.get(taskId) : null;
  if (!task) {
    // Backward-compatible cancel: stop the oldest active task.
    var list = activeStoreTasks();
    task = list.length ? list[0] : null;
  }
  if (!task || !taskIsActive(task)) return false;
  task.cancelled = true;
  if (task.state === 'queued') {
    task.state = 'cancelled';
    task.error = 'Cancelled';
    task.statusText = 'cancelled';
    sendStoreStatus({ id: task.appId, taskId: task.taskId, state: 'error', op: task.op, error: 'Cancelled', cancelled: true, step: 'queued' });
    storeTasks.delete(task.taskId);
    pumpStoreTasks();
  } else {
    try { task.controller.abort(); } catch (e) { /* already settled */ }
  }
  return true;
}
async function cancelAllStoreTasks() {
  var active = activeStoreTasks();
  var waits = [];
  active.forEach(function (t) {
    t.cancelled = true;
    try { t.controller.abort(); } catch (e) { /* best effort */ }
    if (t.state === 'queued') {
      // Queued work has no promise; drop it from the map so store-list cannot
      // resurrect a stale "Queued" entry after a reset/uninstall.
      t.state = 'cancelled';
      t.error = 'Cancelled';
      storeTasks.delete(t.taskId);
    } else if (t.promise) {
      waits.push(t.promise);
    }
  });
  await Promise.allSettled(waits);
}
function runStoreAction(actionType, storeId) {
  if (!appStore) return;
  if (actionType !== 'install_app' && actionType !== 'update_app' && actionType !== 'uninstall_app') return;
  if (storeTaskForApp(storeId)) {
    sendStoreStatus({ id: storeId, state: 'busy', message: 'This app already has an operation in progress.' });
    return;
  }
  registerStoreTask({
    appId: storeId,
    op: actionType,
    priority: actionType === 'uninstall_app' ? 3 : 2,
    run: async function (task) {
      if (actionType === 'install_app') return appStore.install(storeId, function (pp) { emitTaskProgress(task, pp); }, task.signal);
      if (actionType === 'update_app') return appStore.update(storeId, function (pp) { emitTaskProgress(task, pp); }, task.signal);
      // Uninstall: close the running window before the files disappear, then
      // close/clear again in case the app was only partially running.
      emitTaskProgress(task, { phase: 'uninstall', percent: 100, statusText: 'removing app files…' });
      if (appStore.isRunning(storeId) || appWindowAppId === storeId) {
        await stopStoreApp(storeId);
      }
      var uninstalled = await appStore.uninstall(storeId);
      if (appWindowAppId === storeId) await stopStoreApp(storeId);
      return uninstalled;
    },
  });
}

// Per-app metadata for Help/About and the in-app update check. Set when an app
// is launched; reset to null on the launcher so Help/About show the shell.
let currentAppMeta = null;

// Launcher close behaviour. The default asks every time; "Do not ask again"
// (or Settings > Close Button) stores the chosen action.
let launcherClosePromptOpen = false;
function showLauncherCloseDialog() {
  if (launcherClosePromptOpen || !mainWindow || mainWindow.isDestroyed()) return;
  const trayAvailable = {{#tray_enabled}}true{{/tray_enabled}}{{^tray_enabled}}false{{/tray_enabled}};
  const buttons = trayAvailable
    ? ['Minimize to Tray', 'Quit', 'Cancel']
    : ['Quit', 'Cancel'];
  const cancelId = buttons.length - 1;
  const { dialog } = require('electron');
  launcherClosePromptOpen = true;
  dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Close ' + shellDisplayName() + '?',
    message: trayAvailable
      ? 'Minimize to the system tray or quit ' + shellDisplayName() + '?'
      : 'Quit ' + shellDisplayName() + '?',
    detail: trayAvailable ? 'You can reopen the window from the tray.' : '',
    buttons: buttons,
    defaultId: 0,
    cancelId: cancelId,
    noLink: true,
    checkboxLabel: 'Do not ask again',
    checkboxChecked: false
  }).then(function(res) {
    launcherClosePromptOpen = false;
    if (res.response === cancelId) return;
    const action = trayAvailable && res.response === 0 ? 'tray' : 'quit';
    if (res.checkboxChecked) {
      appSettings.launcherCloseAction = action;
      saveSettings();
      if (typeof createMenu === 'function') createMenu();
    }
    if (action === 'tray') {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    } else {
      app.isQuitting = true;
      app.quit();
    }
  }).catch(function() {
    launcherClosePromptOpen = false;
  });
}
function setLauncherCloseAction(action) {
  if (action === 'tray' || action === 'quit') appSettings.launcherCloseAction = action;
  else delete appSettings.launcherCloseAction;
  saveSettings();
  if (typeof createMenu === 'function') createMenu();
}

// Merge the runtime sources for "what is running now": a catalog entry (name,
// description, homepage, docs, email, author, copyright), the installed
// manifest version, and the baked apps-manifest entry (fallbacks).
function buildAppMeta(catalogEntry, installedVersion, manifestEntry) {
  if (!catalogEntry && !manifestEntry) return null;
  function pick(k) {
    if (catalogEntry && catalogEntry[k]) return catalogEntry[k];
    if (manifestEntry && manifestEntry[k]) return manifestEntry[k];
    return '';
  }
  return {
    id: (catalogEntry && catalogEntry.id) || (manifestEntry && manifestEntry.id) || null,
    name: pick('name'),
    description: pick('description'),
    homepage: pick('homepage') || pick('homepage_url') || pick('url'),
    docs: pick('docs') || pick('documentation') || pick('help_url'),
    email: pick('email'),
    author: pick('author'),
    copyright: pick('copyright'),
    version: installedVersion || (catalogEntry && catalogEntry.version) || (manifestEntry && manifestEntry.version) || null
  };
}

function appMetaFor(id) {
  var man = appsManifest && appsManifest.apps.find(function (a) { return a.id === id; });
  var ce = null, ins = null;
  if (appStore) {
    try { ce = appStore.catalogEntry(id); } catch (e) {}
    try { ins = appStore.getState().apps[id]; } catch (e) {}
  }
  // A sideloaded (non-catalog) app has no catalog entry: use its bundle meta.
  if (!ce && ins && ins.meta) {
    var lm = ins.meta;
    return {
      id: id,
      name: lm.name || id,
      description: lm.description || '',
      homepage: lm.homepage || '',
      docs: '',
      email: '',
      author: lm.author || '',
      copyright: '',
      version: (ins && ins.version) || null
    };
  }
  return buildAppMeta(ce, ins && ins.version, man);
}

// ---- Separate app window ---------------------------------------------------
// The launcher stays in mainWindow; a running catalog app gets its own window.
// That keeps the store usable while an app runs, and gives a closed app window
// an unambiguous "stop this app" meaning (after an unsaved-work prompt).
function appWindowAlive() {
  return !!(appWindow && !appWindow.isDestroyed());
}
function contentWindow() {
  return appWindowAlive() ? appWindow : mainWindow;
}
function showLauncherWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}
// Keep the lifecycle splash in the same light/dark world as the store.
function loadLifecyclePage(win) {
  if (!win || win.isDestroyed()) return;
  win.loadFile('lifecycle.html', { query: { theme: currentThemeMode } });
}
function loadLifecycleInView(view) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.loadFile(path.join(__dirname, 'lifecycle.html'), { query: { theme: currentThemeMode } });
}
function layoutAppView() {
  if (!appWindowAlive() || !appView || appView.webContents.isDestroyed()) return;
  var size = appWindow.getContentSize();
  var width = Math.max(0, Math.round(size[0]));
  var height = Math.max(0, Math.round(size[1]));
  appView.setBounds({ x: 0, y: 0, width: width, height: height });
}
// Detach and close the app window without treating it as a user close: the
// caller has already stopped (or is about to stop) the backend.
function closeAppWindow() {
  var win = appWindow;
  appWindow = null;
  appWindowAppId = null;
  appView = null;
  metricsTitleActive = false;
  if (win && !win.isDestroyed()) {
    try { win.close(); } catch (e) { /* already gone */ }
  }
  if (menuSurface === 'app') {
    menuSurface = 'launcher';
    {{#menu_enabled}}
    try { createMenu(); } catch (e) { /* menu is best-effort */ }
    {{/menu_enabled}}
  }
}
function ensureAppWindow(appId) {
  if (appWindowAlive()) {
    if (appWindowAppId === appId) return appWindow;
    // Never reuse a window belonging to another app: the title, close handler
    // and Stop menu would all act on the wrong app id.
    log('warn', 'closing the app window for ' + appWindowAppId + ' before starting ' + appId);
    closeAppWindow();
  }
  var meta = appMetaFor(appId) || {};
  var win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: meta.name || '{{{app_name_js}}}',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      enableRemoteModule: false,
      webSecurity: true
    }
  });
  appWindow = win;
  appWindowAppId = appId;

  // The BrowserWindow is an empty shell: the lifecycle page and the app page
  // live in a WebContentsView that fills it, so the app's CSP, layout and
  // z-index cannot affect the shell (window title, menu, close handling).
  var view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      enableRemoteModule: false,
      webSecurity: true,
      partition: 'persist:{{app_slug}}'
    }
  });
  appView = view;
  win.contentView.addChildView(view);
  layoutAppView();
  win.on('show', layoutAppView);
  win.on('resize', layoutAppView);
  win.on('maximize', layoutAppView);
  win.on('unmaximize', layoutAppView);
  win.on('enter-full-screen', layoutAppView);
  win.on('leave-full-screen', layoutAppView);

  // An empty document: the app page in the view below is the only visible
  // content, so the window shows no app name, progress, Store or Stop controls
  // under its title bar. Closing the window is the way back to the store.
  win.loadURL('about:blank');

  // macOS has one application-wide menu bar; Windows/Linux use per-window
  // menus so focus must not change the launcher's menu.
  win.on('focus', function () {
    if (process.platform !== 'darwin') return;
    if (menuSurface === 'app') return;
    menuSurface = 'app';
    {{#menu_enabled}}
    try { createMenu(); } catch (e) { /* menu is best-effort */ }
    {{/menu_enabled}}
  });

  // Stream both surfaces into the app log.
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = (e && e.level !== undefined) ? e.level : level;
    const msg = (e && e.message !== undefined) ? e.message : message;
    const isErr = lvl === 'error' || lvl === 'warning' ||
      (typeof lvl === 'number' && lvl >= 2);
    log(isErr ? 'error' : 'info', `[app-shell] ${msg}`);
  });
  win.webContents.on('did-fail-load', (event, code, desc, url) => {
    log('error', `[app-shell] failed to load ${url}: ${desc} (${code})`);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    log('error', `[app-shell] renderer gone: ${details && details.reason}`);
  });
  view.webContents.on('console-message', (e, level, message) => {
    const lvl = (e && e.level !== undefined) ? e.level : level;
    const msg = (e && e.message !== undefined) ? e.message : message;
    const isErr = lvl === 'error' || lvl === 'warning' ||
      (typeof lvl === 'number' && lvl >= 2);
    log(isErr ? 'error' : 'info', `[app-view] ${msg}`);
  });
  view.webContents.on('did-fail-load', (event, code, desc, url) => {
    log('error', `[app-view] failed to load ${url}: ${desc} (${code})`);
  });
  view.webContents.on('render-process-gone', (event, details) => {
    log('error', `[app-view] renderer gone: ${details && details.reason}`);
  });

  // The app page owns the window title; the empty shell document must not.
  view.webContents.on('page-title-updated', function (event, title) {
    var current = appMetaFor(appId) || {};
    var own = (current.name || appId || '').trim();
    var next = String(title || '').trim();
    if (next && next !== '{{{app_name_js}}}') {
      metricsTitleActive = false;
      if (!win.isDestroyed()) win.setTitle(next);
      return;
    }
    event.preventDefault();
    if (!win.isDestroyed() && own) {
      win.setTitle(own);
      metricsTitleActive = false;
    }
  });
  win.webContents.on('page-title-updated', function (event) { event.preventDefault(); });

  // Ask before closing a running app. The app window is not the launcher, so
  // this is now the only place the old "unsaved work" confirmation can appear.
  win.on('close', function (event) {
    if (isShuttingDown || app.isQuitting) return;
    if (appWindow !== win) return;   // programmatic close by stopStoreApp
    var id = appWindowAppId;
    if (!id) return;
    var current = appMetaFor(id) || {};
    var name = current.name || id;
    var hasBackend = !!(appStore && appStore.isRunning(id)) || !!currentBackend;
    if (!hasBackend) return;
    event.preventDefault();
    if (appWindowClosePromptOpen) return;
    appWindowClosePromptOpen = true;
    var { dialog } = require('electron');
    dialog.showMessageBox(win, {
      type: 'question', noLink: true,
      title: 'Close ' + name + '?',
      message: 'Close ' + name + ' and return to the store?',
      detail: 'Any unsaved work in "' + name + '" will be lost.',
      buttons: ['Close app', 'Cancel'],
      defaultId: 1, cancelId: 1
    }).then(function (res) {
      appWindowClosePromptOpen = false;
      if (res.response !== 0) return;
      appWindowClosedByUser = { id: id, at: Date.now() };
      stopStoreApp(id).catch(function (e) {
        log('warn', 'close app failed:', e && e.message);
      });
    }).catch(function () {
      appWindowClosePromptOpen = false;
    });
  });

  win.on('closed', function () {
    // A programmatic close (or a replacement window) already detached this
    // window; do not clobber the new one.
    if (appWindow !== win) return;
    appWindowClosePromptOpen = false;
    var id = appWindowAppId;
    appWindow = null;
    appView = null;
    metricsTitleActive = false;
    if (isShuttingDown || app.isQuitting) { appWindowAppId = null; return; }
    // Closing the app window stops its app. A user close has already been
    // confirmed above; this also covers a window closed while it was still
    // starting (stopStoreApp handles the backend with no store handle yet).
    if (id) {
      stopStoreApp(id).catch(function (e) {
        log('warn', 'stop after app window close failed:', e && e.message);
      }).then(function () {
        // Report after the stop settles, otherwise the refresh can still see
        // the app as running and leave a stale Running card.
        sendStoreStatus({ id: id, state: 'done', op: 'stop_app' });
      });
    } else {
      appWindowAppId = null;
    }
    menuSurface = 'launcher';
    {{#menu_enabled}}
    try { createMenu(); } catch (e) { /* menu is best-effort */ }
    {{/menu_enabled}}
    showLauncherWindow();
  });

  // Windows/Linux give each window its own menu; assign the reduced app menu
  // now instead of waiting for a focus-driven rebuild (which only macOS needs).
  {{#menu_enabled}}
  try { createMenu(); } catch (e) { /* menu is best-effort */ }
  {{/menu_enabled}}

  return win;
}

// Shiny apps commonly ship no <title>, so after navigation the window keeps
// whatever title the previous page (lifecycle/launcher) set, i.e. the shell
// name. Title it with the running app's name instead; a title the app sets
// itself still wins. `force` sets the name even when the window currently
// carries a title of our own (the CPU/RAM suffix) to drop it.
function setWindowTitleForApp(appId, force) {
  var win = appWindowAlive() ? appWindow : null;
  if (!win || !appId) return;
  var meta = appMetaFor(appId);
  var label = ((meta && meta.name) || appId || '').trim();
  if (!label) return;
  if (force) { win.setTitle(label); metricsTitleActive = false; return; }
  var current = '';
  var wc = contentWebContents();
  try { current = wc ? String(wc.getTitle() || '').trim() : ''; } catch (e) {}
  var shellName = '{{{app_name_js}}}';
  // Keep a real title the app supplied; replace the shell's name or a bare URL.
  if (!current || current === shellName || /^https?:\/\//i.test(current)) {
    win.setTitle(label);
    metricsTitleActive = false;
  }
}

// The single catalog app that is currently running, if any.
function runningStoreAppId() {
  if (!appStore) return null;
  try {
    const st = appStore.getState();
    const ids = Object.keys((st && st.apps) || {});
    for (let i = 0; i < ids.length; i++) {
      if (appStore.isRunning(ids[i])) return ids[i];
    }
  } catch (e) { /* state not ready */ }
  return null;
}

// Stop a catalog app and close its window. Idempotent; used by Stop, app
// switching and maintenance flows.
async function stopStoreApp(appId) {
  if (!appId) return;
  var appBackend = storeBackends.get(appId) || null;
  if (!appBackend && appWindowAppId === appId) appBackend = currentBackend;
  if (appStore && appStore.isRunning(appId)) {
    try { await appStore.stop(appId); }
    catch (e) { log('warn', 'stop ' + appId + ' failed:', e && e.message); }
    // Drop the stopped backend object, but only if it is still the current one:
    // another app may have started while this one was exiting. Keeping a dead
    // backend makes the next start call stop() on it (which can throw before
    // the new backend is created).
    if (appBackend && currentBackend === appBackend) currentBackend = null;
  } else if (appWindowAppId === appId && currentBackend && currentBackend !== sharedShinyliveServer) {
    // Still starting: appStore has no handle yet. Stop the backend this
    // window owns and forget any handle that the pending start might add.
    var b = currentBackend;
    if (currentBackend === b) currentBackend = null;
    try { b.removeAllListeners(); await b.stop(); } catch (e) { /* best effort */ }
    if (appStore) appStore.forget(appId);
  }
  storeBackends.delete(appId);
  delete storeAppUrls[appId];
  if (appWindowAppId === appId || (currentAppMeta && currentAppMeta.id === appId)) {
    closeAppWindow();
  }
  if (lastSelectedAppId === appId) {
    lastSelectedAppId = null;
    currentAppMeta = null;
    {{#menu_enabled}}
    try { createMenu(); } catch (e) { /* menu is best-effort */ }
    {{/menu_enabled}}
  }
}

// Launch an installed store app and reflect it in Help/About and the menu.
// Shared by the launcher's Run button path and the Apps > Quick Run menu.
async function runStoreApp(appId) {
  if (!appStore) return;
  if (launchingAppId) {
    sendStoreStatus({ id: appId, state: 'busy', message: 'An app is already starting; please wait.' });
    return;
  }
  // Only one app runs at a time. The launcher disables the other Run buttons;
  // this guard also covers Quick Run and any stale UI, and never stops the
  // running app implicitly.
  var busyId = runningStoreAppId();
  if (busyId && busyId !== appId) {
    var busyMeta = appMetaFor(busyId) || {};
    sendStoreStatus({
      id: appId, state: 'busy',
      message: 'Stop ' + (busyMeta.name || busyId) + ' before running another app.'
    });
    return;
  }
  launchingAppId = appId;
  appWindowClosedByUser = null;
  lastSelectedAppId = appId;
  var runError = null;
  try { await appStore.fetchCatalog(); } catch (e) { /* entry may already be cached */ }
  currentAppMeta = appMetaFor(appId);
  {{#menu_enabled}}
  createMenu();
  {{/menu_enabled}}
  var wasRunning = appStore.isRunning(appId);
  var openUrl = wasRunning ? storeAppUrls[appId] : null;
  if (openUrl) {
    // Already running: show its window instead of restarting the backend.
    if (appWindowAlive() && appWindowAppId === appId) {
      appWindow.show();
      appWindow.focus();
    } else {
      var win = ensureAppWindow(appId);
      win.show();
      if (appView && !appView.webContents.isDestroyed()) {
        appView.webContents.loadURL(openUrl).then(function () {
          setWindowTitleForApp(appId);
        }).catch(function () {});
      }
    }
  } else if (wasRunning) {
    // Running but its address was lost: recover it from the live backend.
    try {
      var live = await appStore.run(appId);
      var liveUrl = (live && live.url) || storeAppUrls[appId];
      if (liveUrl) storeAppUrls[appId] = liveUrl;
      if (liveUrl) {
        if (!appWindowAlive()) { var recovered = ensureAppWindow(appId); recovered.show(); }
        if (appView && !appView.webContents.isDestroyed()) {
          appView.webContents.loadURL(liveUrl).then(function () {
            setWindowTitleForApp(appId);
          }).catch(function () {});
        }
      }
    } catch (e) {
      log('error', 'run_app failed:', e && e.message);
      runError = e;
    }
  } else {
    try {
      await appStore.run(appId);
      // The user can close the app window while the backend is still starting.
      // In that case stop what just started instead of leaving an invisible
      // "running" app behind.
      if (!appWindowAlive() || appWindowAppId !== appId) {
        await stopStoreApp(appId);
      }
    }
    catch (e) {
      // Closing the app window during startup stops the backend and can reject
      // the pending start; that is not a launch failure the user needs to see.
      // Never swallow NOT_INSTALLED/MISSING_PACKAGES: appStore.run() throws
      // them before any app window exists, so "no window" is expected there and
      // they must stay visible on the card (and in a launch report).
      var preLaunchError = !!(e && (e.code === 'NOT_INSTALLED' || e.code === 'MISSING_PACKAGES'));
      var closedByUser = !!(appWindowClosedByUser && appWindowClosedByUser.id === appId);
      if (!preLaunchError && closedByUser) {
        runError = null;
      } else {
        log('error', 'run_app failed:', e && e.message);
        runError = e;
        // Backend start failures are reported by the status listener above.
        // These codes fail before a backend exists, so report them here.
        if (e && (e.code === 'NOT_INSTALLED' || e.code === 'MISSING_PACKAGES')) {
          reportLaunchFailure({
            appId: appId,
            phase: 'pre_launch_failure',
            summary: e.message,
            exitCode: null,
            signal: '',
            logTail: readLogTail(appId)
          }).catch(function (err) { log('warn', 'launch report failed:', err && err.message); });
        }
        // The launch failed (missing install/packages, or a backend that could
        // not start), so no app page is open: drop the app context set above and
        // let Help/About and the menu describe the shell again.
        closeAppWindow();
        currentAppMeta = null;
        lastSelectedAppId = null;
        {{#menu_enabled}}
        createMenu();
        {{/menu_enabled}}
      }
    }
  }
  launchingAppId = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (runError) {
      mainWindow.webContents.send('store-status', {
        id: appId, state: 'error', op: 'run_app',
        error: (runError && runError.message) || String(runError)
      });
    } else {
      // Include op:'run_app' so the launcher refreshes and shows Running
      // instead of leaving the card on Run / a 0 Running count.
      mainWindow.webContents.send('store-status', { id: appId, state: 'done', op: 'run_app' });
    }
  }
}

// Stop the persistent shinylive server. Called ONLY at quit; the launcher
// teardown sites deliberately leave it running so the origin (and its
// root-scoped service worker) survives app-to-app navigation.
function stopSharedShinyliveServer() {
  if (sharedShinyliveServer) {
    try {
      sharedShinyliveServer.removeAllListeners();
      sharedShinyliveServer.stop();
    } catch (e) { /* best-effort */ }
    sharedShinyliveServer = null;
    sharedShinylivePort = null;
  }
}

// Window state persistence -- remembers size and position between sessions
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    }
  } catch { /* ignore corrupt state file */ }
  return null;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    const isMaximized = mainWindow.isMaximized();
    fs.writeFile(windowStatePath, JSON.stringify({ bounds, isMaximized }), () => {});
  } catch { /* ignore write errors */ }
}

// resize/move fire continuously during a drag; debounce so we write once the
// interaction settles rather than synchronously on every frame.
let saveWindowStateTimer = null;
function scheduleSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(saveWindowState, 400);
}
{{#tray_enabled}}
let tray = null;
let trayMenu = null;
{{/tray_enabled}}

{{#tray_enabled}}
// The tray's default icon, a 32x32 PNG of a window outline.
const DEFAULT_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgklEQVR42u3XMQ6AIAyF4R6CK5hwL4/n2GM5MnRETGhCCDhZyvCGf9GEfouh0nHe5BkBAED3IJa4JKX8c1LPjjPA+yIZDO5LLaIF8ILhGo8AshAgI0Be3L4A608PAAAAAACAfQF6HQfD4eHrOtaF5DJChHr2dCFxX8ncl1L8FwDg0gOu1ddlhApUYgAAAABJRU5ErkJggg==';

function createTray() {
  // The tray shows tray.icon, or else the app icon. Electron reads PNG and
  // JPEG files on every platform and ICO files only on Windows, and cannot
  // read an .icns file. A file it cannot read loads as an empty image, which
  // would leave the tray blank, so the default icon takes its place.
  let trayIcon = nativeImage.createEmpty();
  {{#has_tray_icon}}
  trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', '{{{tray_icon_js}}}'));
  if (trayIcon.isEmpty()) {
    log('warn', 'Cannot read the tray icon {{{tray_icon_js}}} on ' + process.platform + '; showing the default icon');
  }
  {{/has_tray_icon}}
  const useDefault = trayIcon.isEmpty();
  if (useDefault) {
    trayIcon = nativeImage.createFromDataURL(DEFAULT_TRAY_ICON);
  }
  trayIcon = trayIcon.resize({ width: 16, height: 16 });
  // macOS draws a template image in the menu bar's text color. resize()
  // returns an image without the template flag, so set it afterwards.
  if (useDefault && process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('{{{tray_tooltip_js}}}');

  trayMenu = Menu.buildFromTemplate([
    {
      label: 'Status: Starting...',
      enabled: false,
      id: 'status'
    },
    { type: 'separator' },
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(trayMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
{{/tray_enabled}}

{{#menu_enabled}}
// Help > About, shared by both menu templates. Each configured string comes
// from an escaped *_js template variable.
async function showAboutDialog() {
  const { dialog, shell } = require('electron');
  // With the launcher and the app in separate windows, About describes the
  // window it was invoked from: the app only while its window has focus.
  const focused = BrowserWindow.getFocusedWindow();
  const meta = (currentAppMeta && appWindowAlive() && focused === appWindow) ? currentAppMeta : {};
  const name = meta.name || '{{{app_name_js}}}';
  const version = meta.version || '{{{app_version_js}}}';
  const description = meta.description || '{{{app_description_js}}}';
  const author = meta.author || '{{{app_author_js}}}';
  const copyright = meta.copyright || '{{{app_copyright_js}}}';
  const homepage = meta.homepage || '{{{app_homepage_js}}}';
  const email = meta.email || '{{{app_email_js}}}';
  const detailLines = ['Version ' + version];
  if (description) detailLines.push('', description);
  if (author) detailLines.push('', 'Author: ' + author);
  if (copyright) detailLines.push('', copyright);
  detailLines.push('', 'Built with shinyelectron');
  const detail = detailLines.join('\n');
  // buttons[i] runs actions[i]. Every button closes the dialog, so there is no
  // separate OK button: Esc and the window's close control dismiss it, and a
  // build with nothing actionable keeps a plain Close instead.
  const buttons = [];
  const actions = [];
  {{#updates_enabled}}
  // The shell's own check is offered on Windows/Linux (a Mac build ships only
  // a dmg, which electron-updater cannot update); while a catalog app runs it
  // targets that app instead, so it is offered on every platform.
  if (process.platform !== 'darwin' || currentAppMeta) {
    buttons.push('Check for Updates');
    actions.push(checkForUpdatesInteractive);
  }
  {{/updates_enabled}}
  if (homepage) {
    // The homepage is the project's repository, so the button reads as a star
    // action rather than a generic site link. The star is a \u2605 escape, which
    // keeps this template plain ASCII.
    buttons.push('\u2605 Star on GitHub');
    actions.push(() => shell.openExternal(homepage));
  }
  if (email) {
    buttons.push('Email');
    actions.push(() => shell.openExternal('mailto:' + email));
  }
  if (!buttons.length) {
    // Windows labels an empty button list "OK", so keep a real dismissal
    // button rather than letting one reappear.
    buttons.push('Close');
    actions.push(null);
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About ' + name,
    message: name,
    detail,
    buttons,
    // Electron reads -1 as "no such button": neither Enter nor Esc may pick the
    // update check or the browser, since every button here does something.
    defaultId: -1,
    cancelId: -1,
    // Windows would otherwise show the extra buttons as command links.
    noLink: true
  });
  if (response >= 0 && actions[response]) await actions[response]();
}

  // Close the app window and stop its app, returning to the launcher. Used by
  // the lifecycle "back" path; the app window's own close button has its own
  // unsaved-work prompt.
  var leavePromptOpen = false;
  function leaveToLauncher() {
    if (!appsManifest || leavePromptOpen) return;
    var id = appWindowAppId || lastSelectedAppId;
    if (!id) { showLauncherWindow(); return; }
    var cur = appsManifest.apps.find(function(a) { return a.id === id; });
    // Catalog apps are not in the baked suite manifest, so prefer the running
    // app's own metadata over the placeholder lookup.
    var curName = (currentAppMeta && currentAppMeta.name) || (cur && cur.name) || '{{{app_name_js}}}';

    leavePromptOpen = true;
    var { dialog } = require('electron');
    dialog.showMessageBox(appWindowAlive() ? appWindow : mainWindow, {
      type: 'question',
      buttons: ['Leave app', 'Cancel'],
      defaultId: 1, cancelId: 1, noLink: true,
      title: 'Close ' + curName + '?',
      message: 'Close this app and return to the launcher?',
      detail: 'Any unsaved work in "' + curName + '" will be lost.'
    }).then(function(res) {
      leavePromptOpen = false;
      if (res.response !== 0) return;
      stopStoreApp(id).then(showLauncherWindow, function () { showLauncherWindow(); });
    }).catch(function() {
      leavePromptOpen = false;
    });
  }

// ---- Apps menu (multi-app) ------------------------------------------------
// On the launcher: "Quick Run" (installed apps) + "Manage Apps...". While an
// app runs: "Back to Launcher". createMenu() is rebuilt whenever the installed
// set or the launcher/app context changes.
function installedAppMenuItems() {
  var items = [];
  if (!appStore) return items;
  var st;
  try { st = appStore.getState(); } catch (e) { return items; }
  Object.keys(st.apps || {}).forEach(function (id) {
    if (!appStore.isInstalled(id)) return;
    var m = appMetaFor(id) || {};
    var label = m.name || id;
    if (quickRunFavorites[id]) label = '\u2605 ' + label;
    items.push({ id: id, label: label });
  });
  // Order by the launcher-computed Quick Run rank; unknown ids last, by name.
  var rank = {};
  for (var i = 0; i < quickRunOrder.length; i++) rank[quickRunOrder[i]] = i;
  items.sort(function (a, b) {
    var ra = Object.prototype.hasOwnProperty.call(rank, a.id) ? rank[a.id] : 1e9;
    var rb = Object.prototype.hasOwnProperty.call(rank, b.id) ? rank[b.id] : 1e9;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
  return items;
}

function buildAppsSubmenu() {
  var sub = [];
  if (isLauncherVisible) {
    var installed = installedAppMenuItems();
    var MAX_RUN = 8;
    var shown = installed.slice(0, MAX_RUN);
    var runItems = installed.length
      ? shown.map(function (it) {
          return { label: it.label, click: function () { runStoreApp(it.id); } };
        })
      : [{ label: 'No apps installed yet - install one first', enabled: false }];
    if (installed.length > MAX_RUN) {
      runItems = runItems.concat([
        { type: 'separator' },
        { label: 'More\u2026', click: function () { openManagerFromMenu('installed'); } }
      ]);
    }
    sub.push({ label: 'Quick Run', submenu: runItems });
    sub.push({ type: 'separator' });
    var updates = 0;
    try { updates = appStore ? appStore.checkUpdates().length : 0; } catch (e) { updates = 0; }
    sub.push({
      label: 'My Apps\u2026' + (updates ? '  (' + updates + (updates > 1 ? ' updates' : ' update') + ')' : ''),
      accelerator: 'CmdOrCtrl+Shift+M',
      click: function () { openManagerFromMenu(updates ? 'updates' : 'installed'); }
    });
    sub.push({ label: 'Install from Bundle\u2026', click: function () { storeCommand({ cmd: 'install_bundle' }); } });
    sub.push({ label: 'Install from URL\u2026', click: function () { storeCommand({ cmd: 'install_url' }); } });
    sub.push({ type: 'separator' });
    sub.push({ label: 'Refresh Catalog', click: function () {
      log('info', '[store] manual catalog refresh requested');
      storeCommand({ cmd: 'refresh' });
    } });
  } else {
    sub.push({
      label: 'Back to Launcher',
      accelerator: 'CmdOrCtrl+L',
      click: function () { leaveToLauncher(); }
    });
  }
  return sub;
}

// Send a command to the launcher renderer (opens a focused dialog, sets theme, ...).
function storeCommand(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('store-command', payload);
  }
}

// Open the launcher's manager on a given tab (deep link from the Apps menu).
function openManagerFromMenu(tab) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('store-command', { cmd: 'open_manager', tab: tab || 'installed' });
  }
}

// In-app reader window for the bundled user guide (Help > User Guide).
let userGuideWindow = null;
function openUserGuide() {
  const themeMode = (currentThemeMode === 'dark' || currentThemeMode === 'light') ? currentThemeMode : 'system';
  if (userGuideWindow && !userGuideWindow.isDestroyed()) {
    userGuideWindow.loadFile('{{{user_guide_file_js}}}', { query: { theme: themeMode } });
    userGuideWindow.show();
    userGuideWindow.focus();
    return;
  }
  userGuideWindow = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: shellDisplayName() + ' User Guide',
    autoHideMenuBar: true,
    backgroundColor: themeMode === 'dark' ? '#0f172a' : '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  userGuideWindow.setMenuBarVisibility(false);
  userGuideWindow.loadFile('{{{user_guide_file_js}}}', { query: { theme: themeMode } });
  userGuideWindow.on('closed', () => { userGuideWindow = null; });
}

// Rebuild the native menu only when something it shows actually changed
// (launcher/app context, installed set, or update count) -- not on every
// catalog refresh.
var lastMenuSig = '';
function menuSignature() {
  var ids = installedAppMenuItems().map(function (it) { return it.id; }).join(',');
  var updates = 0;
  try { updates = appStore ? appStore.checkUpdates().length : 0; } catch (e) { updates = 0; }
  return (isLauncherVisible ? 'L' : 'A') + '|' + menuSurface + '|' + ids + '|' + updates +
    '|' + (appWindowAlive() ? (appWindowAppId || 'app') : '');
}
function refreshMenuIfChanged() {
  var sig = menuSignature();
  if (sig === lastMenuSig) return;
  createMenu();
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  function buildMenuFor(onAppSurface) {
  // Help/About reflect the running app only while its window owns the menu.
  const meta = onAppSurface ? currentAppMeta : null;
  const appTitle = (meta && meta.name) || '{{{app_name_js}}}';

  {{#menu_minimal}}
  // Minimal menu -- File, Edit, Help only
  const template = [
    ...(isMac ? [{
      // Electron would label these items with app.name, which is the slug.
      label: appTitle,
      submenu: [
        { label: 'About ' + appTitle, click: () => { showAboutDialog().catch((err) => log('error', 'About dialog failed:', err)); } },

        { type: 'separator' },
        { role: 'quit', label: 'Quit ' + appTitle }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {{#is_multi_app}}
    ...(!onAppSurface ? [{
      label: 'Apps',
      submenu: buildAppsSubmenu()
    }] : []),
    {{/is_multi_app}}
    {
      label: 'Help',
      submenu: [
        {{#is_multi_app}}
        ...(onAppSurface ? [] : [
        {{#has_user_guide}}
        {
          label: 'User Guide',
          click: () => {
            try { openUserGuide(); }
            catch (err) { log('error', 'User guide failed:', err && err.message); }
          }
        },
        {{/has_user_guide}}
        {
          label: 'Developer Guide',
          enabled: !!'{{{help_url_js}}}',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        ]),
        ...(meta && meta.docs ? [{
          label: 'App Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal(currentAppMeta.docs);
          }
        }] : []),
        {{/is_multi_app}}
        {{^is_multi_app}}
        {{#has_help_url}}
        {
          label: 'Developer Guide',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        {{/has_help_url}}
        {{/is_multi_app}}
        { type: 'separator' },
        {
          label: 'View Logs',
          click: () => {
            const { shell } = require('electron');
            shell.openPath(appLogRoot);
          }
        },
        ...(reportEndpoint() ? [{
          label: 'Report a Problem…',
          click: function () {
            reportLaunchFailure({
              appId: lastSelectedAppId || 'shinyapps-store',
              phase: 'manual_report',
              summary: 'Manual report from the Help menu',
              exitCode: null,
              signal: '',
              logTail: lastSelectedAppId ? readLogTail(lastSelectedAppId) : ''
            }).catch(function (e) { log('warn', 'launch report failed:', e && e.message); });
          }
        }] : []),
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            showAboutDialog().catch((err) => log('error', 'About dialog failed:', err));
          }
        },

      ]
    }
  ];
  {{/menu_minimal}}
  {{^menu_minimal}}
  // Default menu -- full menu bar
  const template = [
    ...(isMac ? [{
      // Electron would label these items with app.name, which is the slug.
      label: appTitle,
      submenu: [
        { label: 'About ' + appTitle, click: () => { showAboutDialog().catch((err) => log('error', 'About dialog failed:', err)); } },

        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide ' + appTitle },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ' + appTitle }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(onAppSurface ? [{
          label: 'Reload App',
          click: function () { if (appView && !appView.webContents.isDestroyed()) appView.webContents.reload(); }
        }, {
          label: 'Reload App (ignore cache)',
          click: function () { if (appView && !appView.webContents.isDestroyed()) appView.webContents.reloadIgnoringCache(); }
        }] : [
          { role: 'reload' },
          { role: 'forceReload' }
        ]),
        {{#show_dev_tools}}
        { role: 'toggleDevTools' },
        {{/show_dev_tools}}
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    {{#is_multi_app}}
    ...(!onAppSurface ? [{
      label: 'Apps',
      submenu: buildAppsSubmenu()
    }] : []),
    {{/is_multi_app}}
    {
      label: 'Help',
      submenu: [
        {{#is_multi_app}}
        ...(onAppSurface ? [] : [
        {{#has_user_guide}}
        {
          label: 'User Guide',
          click: () => {
            try { openUserGuide(); }
            catch (err) { log('error', 'User guide failed:', err && err.message); }
          }
        },
        {{/has_user_guide}}
        {
          label: 'Developer Guide',
          enabled: !!'{{{help_url_js}}}',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        ]),
        ...(meta && meta.docs ? [{
          label: 'App Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal(currentAppMeta.docs);
          }
        }] : []),
        {{/is_multi_app}}
        {{^is_multi_app}}
        {{#has_help_url}}
        {
          label: 'Developer Guide',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        {{/has_help_url}}
        {{/is_multi_app}}
        { type: 'separator' },
        {
          label: 'View Logs',
          click: () => {
            const { shell } = require('electron');
            shell.openPath(appLogRoot);
          }
        },
        ...(reportEndpoint() ? [{
          label: 'Report a Problem…',
          click: function () {
            reportLaunchFailure({
              appId: lastSelectedAppId || 'shinyapps-store',
              phase: 'manual_report',
              summary: 'Manual report from the Help menu',
              exitCode: null,
              signal: '',
              logTail: lastSelectedAppId ? readLogTail(lastSelectedAppId) : ''
            }).catch(function (e) { log('warn', 'launch report failed:', e && e.message); });
          }
        }] : []),
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            showAboutDialog().catch((err) => log('error', 'About dialog failed:', err));
          }
        },

      ]
    }
  ];
  {{/menu_minimal}}

  return Menu.buildFromTemplate(template);
  }

  const launcherMenu = buildMenuFor(false);
  const appMenu = buildMenuFor(true);
  if (isMac) {
    // macOS has one application-wide menu bar; it follows the focused window.
    Menu.setApplicationMenu(menuSurface === 'app' ? appMenu : launcherMenu);
  } else {
    // Windows/Linux can give each window its own menu: the launcher keeps the
    // store menu, while the app window gets the reduced menu.
    Menu.setApplicationMenu(launcherMenu);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setMenu(launcherMenu);
    if (appWindowAlive()) appWindow.setMenu(appMenu);
  }
  lastMenuSig = menuSignature();
}
{{/menu_enabled}}

{{#updates_enabled}}
function setupAutoUpdater() {
  autoUpdater.logger = updaterLog;
  autoUpdater.logger.transports.file.level = 'info';

  autoUpdater.autoDownload = {{#auto_download}}true{{/auto_download}}{{^auto_download}}false{{/auto_download}};
  autoUpdater.autoInstallOnAppQuit = {{#auto_install}}true{{/auto_install}}{{^auto_install}}false{{/auto_install}};
  // NSIS updater: ship the full installer, not a web installer.
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('checking-for-update', () => {
    updaterLog.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    updaterLog.info('Update available:', info.version);
    // Check for Updates answers in its own dialog.
    if (interactiveUpdateCheck) return;
    // Show non-intrusive notification instead of modal
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      // With autoDownload on, the download has already started.
      const notification = new Notification({
        title: 'Update Available',
        body: autoUpdater.autoDownload
          ? `Version ${info.version} is downloading.`
          : `Version ${info.version} is available. Click to download.`,
        silent: true
      });
      if (!autoUpdater.autoDownload) {
        notification.on('click', () => {
          autoUpdater.downloadUpdate().catch((err) => updaterLog.error('Update download failed:', err));
        });
      }
      notification.show();
    } else {
      // Fallback to log
      updaterLog.info(`Update ${info.version} available; user will be notified on next check`);
    }
  });

  autoUpdater.on('update-not-available', () => {
    updaterLog.info('No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    updaterLog.info(`Download progress: ${progress.percent}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updaterLog.info('Update downloaded');
    const { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart now to apply the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then((result) => {
      if (result.response === 0) {
        // Quit cleanly before handing over to the installer: stop the backend
        // (R/Shiny) and wait for its process to exit so it releases the
        // bundled runtime's files, and suppress the window-close confirmation
        // so the update cannot be cancelled halfway.
        isShuttingDown = true;
        app.isQuitting = true;

        let handedOver = false;
        const handOver = () => {
          if (handedOver) return;
          handedOver = true;
          // quitAndInstall() reports a failed install through 'error' and
          // leaves the app running with its backend already stopped. Undo the
          // shutdown so the window closes normally and tell the user.
          const onInstallError = (err) => {
            isShuttingDown = false;
            app.isQuitting = false;
            const options = {
              type: 'error',
              title: 'Update Failed',
              message: 'The update could not be installed.',
              detail: (err && err.message ? err.message + '\n\n' : '') +
                'Please restart the app manually.',
              buttons: ['OK'],
              noLink: true
            };
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, options);
            } else {
              dialog.showMessageBox(options);
            }
          };
          autoUpdater.once('error', onInstallError);
          try {
            autoUpdater.quitAndInstall();
          } catch (err) {
            autoUpdater.removeListener('error', onInstallError);
            onInstallError(err);
          }
        };

        stopSharedShinyliveServer();
        if (!currentBackend) {
          // No per-app backend is running (launcher or a shinylive app).
          handOver();
          return;
        }
        // Hand over once the backend process has exited, or after
        // shutdown_timeout if it is still running by then.
        let fallback = null;
        const timedOut = new Promise((resolve) => {
          fallback = setTimeout(resolve, {{shutdown_timeout}});
        });
        const exited = Promise.resolve(currentBackend.stop()).catch(() => {});
        Promise.race([exited, timedOut]).then(() => {
          clearTimeout(fallback);
          handOver();
        });
      }
    });
  });

  autoUpdater.on('error', (err) => {
    updaterLog.error('AutoUpdater error:', err);
  });
}

// Help > About > Check for Updates. Unlike the startup check, this answers
// every outcome with a dialog.
async function checkForUpdatesInteractive() {
  const { dialog } = require('electron');
  // Multi-app: while the app window is focused, Check for Updates targets that
  // app (same source of truth as the launcher's Update button); from the
  // launcher it keeps checking the shell itself via electron-updater.
  const focused = BrowserWindow.getFocusedWindow();
  if (currentAppMeta && appStore && appWindowAlive() && focused === appWindow) {
    return checkAppUpdateInteractive();
  }
  const show = (type, message, detail) =>
    dialog.showMessageBox(mainWindow, { type, title: 'Check for Updates', message, detail, noLink: true })
      .catch((err) => updaterLog.error('Update dialog failed:', err));
  const reason = (err) => String((err && err.message) || err);
  const downloadFailed = (err) => show('warning', 'Could not download the update', reason(err));

  let result;
  interactiveUpdateCheck = true;
  try {
    result = await autoUpdater.checkForUpdates();
  } catch (err) {
    await show('warning', 'Could not check for updates', reason(err));
    return;
  } finally {
    interactiveUpdateCheck = false;
  }

  // electron-updater answers null when it is inactive, as in a copy that is
  // not an installed build (npm run electron, for example).
  if (!result) {
    await show('info', 'Updates work only in the installed app',
      'This copy was not installed from a release, so it cannot check for updates.');
    return;
  }
  if (!result.isUpdateAvailable) {
    await show('info', 'You are up to date', `Version ${app.getVersion()} is the latest version.`);
    return;
  }

  const version = result.updateInfo.version;
  if (autoUpdater.autoDownload) {
    // The download is already running; the update-downloaded handler asks
    // to restart once it finishes.
    if (result.downloadPromise) result.downloadPromise.catch(downloadFailed);
    await show('info', `Version ${version} is downloading`,
      'You will be asked to restart when it is ready.');
    return;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Check for Updates',
    message: `Version ${version} is available`,
    detail: `You have version ${app.getVersion()}.`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (response === 0) {
    // The update-downloaded handler asks to restart once the download completes.
    autoUpdater.downloadUpdate().catch(downloadFailed);
  }
}

// App-scoped update check for Help > About while a catalog app is running. It
// reuses the store's install/update pipeline, so progress and failures surface
// on the launcher card (store-status), consistent with the Update button.
async function checkAppUpdateInteractive() {
  const { dialog } = require('electron');
  const id = (currentAppMeta && currentAppMeta.id) || lastSelectedAppId;
  const name = (currentAppMeta && currentAppMeta.name) || id || 'this app';
  const show = (type, message, detail) =>
    dialog.showMessageBox(mainWindow, { type, title: 'Check for Updates', message, detail, noLink: true })
      .catch((err) => log('error', 'Update dialog failed:', err));
  try {
    await appStore.fetchCatalog();
  } catch (err) {
    return show('warning', 'Could not check for updates', String((err && err.message) || err));
  }
  const entry = appStore.catalogEntry(id);
  const st = appStore.getState();
  const installed = st.apps[id] && st.apps[id].version;
  if (!entry || !installed) {
    return show('info', 'No update information',
      name + ' was not installed from the catalog, so it has no update channel.');
  }
  if ((SHELL_R_VERSION && entry.r_version && cmpVersion(SHELL_R_VERSION, entry.r_version) < 0) ||
      (entry.min_shell_version && cmpVersion('{{{app_version_js}}}', entry.min_shell_version) < 0)) {
    return show('info', 'Update not available',
      'Version ' + entry.version + ' of ' + name + ' needs a newer build of this app shell' +
      (entry.r_version ? (' (R ' + entry.r_version + ')') : '') + '. Install a newer shell to update it.');
  }
  if (cmpVersion(entry.version, installed) <= 0) {
    return show('info', 'You are up to date', name + ' ' + installed + ' is the latest version.');
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Check for Updates',
    message: 'Version ' + entry.version + ' is available',
    detail: 'You have ' + name + ' ' + installed + '. Updating returns to the launcher and may discard unsaved work.',
    buttons: ['Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (response !== 0) return;

  // Stop the running app and close its window, then update through the same
  // background task pipeline as the launcher's Update button: the card and the
  // Installing tab show progress and any failure.
  await stopStoreApp(id);
  currentAppMeta = null;
  showLauncherWindow();
  runStoreAction('update_app', id);
}
{{/updates_enabled}}

function createWindow() {
  // Restore saved window state or use defaults.
  // Only apply saved x/y when the saved bounds are visible on at least one
  // currently connected display; a disconnected monitor would otherwise hide
  // the window off-screen with no way for the user to recover it.
  const savedState = loadWindowState();
  const windowWidth = (savedState && savedState.bounds) ? savedState.bounds.width : {{window_width}};
  const windowHeight = (savedState && savedState.bounds) ? savedState.bounds.height : {{window_height}};

  let windowX = undefined;
  let windowY = undefined;
  if (savedState && savedState.bounds) {
    const { x, y, width, height } = savedState.bounds;
    try {
      const displays = screen.getAllDisplays();
      const visible = displays.some(d => {
        const wa = d.workArea;
        // Intersection test: both rectangles must overlap by at least 1px
        return x < wa.x + wa.width && x + width > wa.x &&
               y < wa.y + wa.height && y + height > wa.y;
      });
      if (visible) {
        windowX = x;
        windowY = y;
      }
      // If not visible on any display, leave windowX/windowY undefined so
      // Electron centers the window on the primary display.
    } catch {
      // screen API unavailable (should not happen after app.whenReady);
      // fall back to centered window.
    }
  }

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      enableRemoteModule: false,
      webSecurity: true,
      // Isolate each app's session to prevent Service Worker cache
      // cross-contamination between multiple shinyelectron apps
      partition: 'persist:{{app_slug}}'
    },
    {{#has_icon}}icon: path.join(__dirname, 'assets', '{{icon_file}}'),{{/has_icon}}
    show: false
  });

  if (savedState && savedState.isMaximized) {
    mainWindow.maximize();
  }

  // Save window state on resize/move (debounced; these events fire rapidly)
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('close', saveWindowState);
  mainWindow.on('focus', function () {
    if (process.platform !== 'darwin') return;
    if (menuSurface === 'launcher') return;
    menuSurface = 'launcher';
    {{#menu_enabled}}
    try { createMenu(); } catch (e) { /* menu is best-effort */ }
    {{/menu_enabled}}
  });

  // Stream the renderer console (webR / Pyodide / Shiny output and errors, which
  // otherwise surface only in DevTools) into the app log so every log lives in
  // one place. Handles both the newer single-object console-message signature
  // and the classic positional one.
  mainWindow.webContents.on('console-message', (e, level, message) => {
    const lvl = (e && e.level !== undefined) ? e.level : level;
    const msg = (e && e.message !== undefined) ? e.message : message;
    const isErr = lvl === 'error' || lvl === 'warning' ||
      (typeof lvl === 'number' && lvl >= 2);
    log(isErr ? 'error' : 'info', `[renderer] ${msg}`);
  });
  mainWindow.webContents.on('did-fail-load', (event, code, desc, url) => {
    log('error', `[renderer] failed to load ${url}: ${desc} (${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log('error', `[renderer] process gone: ${details && details.reason}`);
  });

  {{#menu_enabled}}
  // Keep the "Apps" menu in sync with what is on screen: it only makes sense
  // while an app is open, so hide it on the launcher.
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL() || '';
    const onLauncher = url.indexOf('launcher.html') !== -1;
    if (onLauncher !== isLauncherVisible) {
      isLauncherVisible = onLauncher;
      createMenu();
    }
  });
  {{/menu_enabled}}

  // Keep the window titled after the running app. Shiny apps often set no
  // <title>, so the title would otherwise stay at the shell name from the
  // lifecycle/launcher page. A title the app itself supplies is kept.
  mainWindow.on('page-title-updated', (event, title) => {
    // Only an app page (http) defers to the running app; the launcher and
    // lifecycle pages always own their title, even if the last app's metadata
    // is still set.
    let onAppPage = false;
    try { onAppPage = /^https?:/i.test(mainWindow.webContents.getURL() || ''); } catch (e) {}
    if (!currentAppMeta || !onAppPage) {
      // A stale CPU/RAM suffix is dropped.
      metricsTitleActive = false;
      return;
    }
    const own = String(currentAppMeta.name || '').trim() || String(lastSelectedAppId || '');
    if (!own) return;
    const next = String(title || '').trim();
    if (next && next !== '{{{app_name_js}}}') {
      // A title the app supplies itself wins over ours.
      metricsTitleActive = false;
      return;
    }
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(own);
      metricsTitleActive = false;
    }
  });

  // A CPU/RAM write can race the incoming page's title during navigation.
  // Once a non-app page finishes loading, its own <title> wins.
  mainWindow.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = mainWindow.webContents.getURL() || ''; } catch (e) {}
    if (!/^https?:/i.test(url)) restorePageTitle();
  });

  // --- App store wiring (multi-app) -------------------------------------
  function storeStartBackend(opts) {
    return new Promise(function (resolve, reject) {
      // Never let a stale outgoing backend abort this start: stop() on an
      // already-stopped process can throw, and that used to reject the whole
      // start before the new backend was even created.
      var outgoing = currentBackend;
      currentBackend = null;
      if (outgoing && outgoing !== sharedShinyliveServer) {
        try {
          outgoing.removeAllListeners();
          outgoing.stop();
        } catch (e) {
          log('warn', 'could not stop outgoing backend:', e && e.message);
        }
      }
      currentBackend = getBackendForApp('r-shiny', 'bundled');
      var win = ensureAppWindow(opts.appId);
      var view = appView;
      openAppLog(opts.appId);
      appLogWrite('[runtime] id=' + (opts.runtimeId || '') +
        ' abi=' + (opts.runtimeAbi || '') +
        ' version=' + (opts.runtimeVersion || '') +
        ' rscript=' + (opts.runtimeRscript || '') +
        ' library=' + (opts.runtimeLibrary || ''));
      var readyAt = 0;
      var reported = false;
      var reportLaunch = function (data, phase, summary, detail) {
        if (reported) return;
        reported = true;
        var postReady = readyAt > 0;
        var finalPhase = (phase === 'server_crashed' || phase === 'error' || phase === 'app_exit_unexpected')
          ? (postReady ? 'post_ready_failure' : 'pre_ready_failure')
          : phase;
        // Let the launcher/lifecycle page settle before opening a modal dialog.
        setTimeout(function () {
          reportLaunchFailure({
            appId: opts.appId,
            phase: finalPhase,
            summary: summary || (data && data.message) || 'App failed to start',
            exitCode: detail && detail.code !== undefined ? detail.code : null,
            signal: detail && detail.signal,
            logTail: readLogTail(opts.appId)
          }).catch(function (e) { log('warn', 'launch report failed:', e && e.message); });
        }, 800);
      };
      currentBackend.on('status', function (data) {
        appLogWrite('[' + data.phase + '] ' + (data.message || ''));
        if (appWindow === win && appView === view && view && !view.webContents.isDestroyed()) {
          view.webContents.send('lifecycle-status', data);
        }
        if (data.phase === 'server_ready') { serverRunning = true; readyAt = Date.now(); }
        if (data.phase === 'error' || data.phase === 'server_crashed') {
          reportLaunch(data, data.phase, data.message, data.detail);
        }
        if (data.phase === 'stopping_server' || data.phase === 'error' || data.phase === 'server_crashed' || data.phase === 'app_exit') serverRunning = false;
      });
      currentBackend.on('output', function (o) { appLogWrite((o && o.stream ? o.stream : 'out') + ': ' + ((o && o.line) || '')); });
      currentBackend.on('error', function (err) {
        appLogWrite('[error] ' + (err && err.message ? err.message : err));
        log('error', 'store backend error:', err && err.message ? err.message : err);
      });
      // Clear the store running flag whenever the backend actually exits
      // (e.g. after Back to Launcher stops it), so the launcher shows Run again.
      currentBackend.on('status', function (d) {
        if (!d) return;
        if (d.phase === 'app_exit') {
          appLogWrite('[app_exit]' + (d.unexpected ? ' (unexpected)' : ''));
          closeAppLog();
          // The process is already gone; clear the running handle instead of
          // calling stop(), whose shutdown listener would wait for an app_exit
          // that has already been emitted.
          if (appStore) appStore.forget(opts.appId);
          storeBackends.delete(opts.appId);
          // The launcher no longer reloads when an app exits (its window is
          // separate), so tell the card that the app stopped.
          sendStoreStatus({ id: opts.appId, state: 'done', op: 'stop_app' });
          // The app ended on its own (not through Back to Launcher or Stop):
          // leave the now-dead page and show the launcher.
          if (d.unexpected) {
            // A clean exit long after startup is usually the app choosing to
            // quit; only a short-lived app looks like a failed launch.
            var uptime = readyAt ? (Date.now() - readyAt) : 0;
            if (!readyAt || uptime < 60 * 1000) {
              reportLaunch(d, 'app_exit_unexpected', d.message || 'App exited unexpectedly', null);
            }
            lastSelectedAppId = null;
            currentAppMeta = null;
            if (currentBackend) { currentBackend.removeAllListeners(); currentBackend = null; }
            if (appWindow === win) closeAppWindow();
            {{#menu_enabled}}
            try { createMenu(); } catch (e) { /* menu is best-effort */ }
            {{/menu_enabled}}
            showLauncherWindow();
          }
        }
        if (d.phase === 'server_crashed') {
          // The R process died. Forget the app and its address, otherwise the
          // launcher keeps showing it as running and "Open" loads a dead URL.
          appLogWrite('[server_crashed]');
          closeAppLog();
          delete storeAppUrls[opts.appId];
          if (appStore) appStore.forget(opts.appId);
          storeBackends.delete(opts.appId);
          lastSelectedAppId = null;
          currentAppMeta = null;
          sendStoreStatus({ id: opts.appId, state: 'done', op: 'stop_app' });
          if (appWindow === win) closeAppWindow();
          {{#menu_enabled}}
          try { createMenu(); } catch (e) { /* menu is best-effort */ }
          {{/menu_enabled}}
          showLauncherWindow();
        }
      });
      lastSelectedAppId = opts.appId;
      loadLifecycleInView(view);
      if (appWindow === win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
      var b = currentBackend;
      storeBackends.set(opts.appId, b);
      b.start({
        appPath: opts.appPath,
        port: port,
        config: Object.assign({}, {{{backend_config_json}}}, {
          app_type: 'r-shiny',
          app_id: opts.appId,
          runtime_strategy: 'bundled',
          extra_lib_paths: opts.libPaths,
          runtime_id: opts.runtimeId || '',
          runtime_abi: opts.runtimeAbi || '',
          runtime_version: opts.runtimeVersion || '',
          runtime_path: opts.runtimePath || '',
          runtime_rscript: opts.runtimeRscript || '',
          runtime_library: opts.runtimeLibrary || ''
        })
      }).then(function (result) {
        actualPort = result.port;
        storeAppUrls[opts.appId] = 'http://localhost:' + actualPort;
        // The app window can be closed by the user while the backend starts;
        // its 'closed' handler stops that backend, so never navigate a dead
        // (or replaced) window here.
        if (appWindow === win && appView === view && view && !view.webContents.isDestroyed()) {
          view.webContents.loadURL('http://localhost:' + actualPort).then(function () {
            setWindowTitleForApp(opts.appId);
          }).catch(function () { /* navigation errors are reported elsewhere */ });
        }
        resolve({
          // The launcher can re-open a still-running app even if its cached
          // address was lost.
          url: 'http://localhost:' + actualPort,
          stop: function () {
            return new Promise(function (done) {
              var settled = false;
              var timer = null;
              var onExit = null;
              var finish = function () {
                if (settled) return;
                settled = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (onExit) b.removeListener('status', onExit);
                done();
              };
              timer = setTimeout(finish, 120000);
              var stopped = null;
              try { stopped = b.stop(); } catch (e) { finish(); return; }
              // The native backend emits app_exit before the child is gone and
              // returns a promise that resolves when it actually exits. Wait
              // for that: uninstall/update delete or replace files right after,
              // and on Windows deleting while R still holds DLLs leaves part
              // of the app behind.
              if (stopped && typeof stopped.then === 'function') {
                stopped.then(finish, finish);
              } else {
                // A backend that reports no completion: the stop was
                // synchronous, so there is nothing more to wait for.
                finish();
              }
            });
          }
        });
      }).catch(function (err) {
        // A pre-start failure leaves no live app page: close the window so the
        // launcher (which reports the error on the card) is the only window.
        if (storeBackends.get(opts.appId) === b) storeBackends.delete(opts.appId);
        if (appWindow === win) closeAppWindow();
        reject(err);
      });
    });
  }

  if (appsManifest) {
    appStore = createAppStore({
      dataRoot: resolveDataRoot(),
      catalogUrl: appSettings.catalogUrl || DEFAULT_CATALOG_URL,
      startBackend: storeStartBackend,
      shellVersion: '{{{app_version_js}}}',
      shellRVersion: SHELL_R_VERSION,
      runtimeLibrary: bundledRuntimeLibrary(),
      runtimeRoot: bundledRuntimeRoot(),
      getDownloadMirror: function () { return appSettings.downloadMirror || ''; },
      log: function (m) { log('info', '[store]', m); }
    });
    ipcMain.handle('store-list', async () => {
      // Force a fresh catalog so a newly registered app appears without restarting.
      let cat;
      let offline = false;
      try {
        const fetching = appStore.fetchCatalog({ force: true });
        fetching.catch(() => { /* handled below or after the timeout */ });
        cat = await withTimeout(fetching, 5000);
      } catch (e) {
        // Offline / catalog outage: fall back to the on-disk cached catalog (or
        // none) so installed and sideloaded apps stay visible and runnable.
        offline = true;
        log('warn', 'catalog fetch failed; using cached/installed data:', e && e.message);
        cat = appStore.getCatalog() || { apps: [] };
      }
      const st = appStore.getState();
      {{#menu_enabled}}
      refreshMenuIfChanged();   // keep the Apps menu (update count / Quick Run) fresh
      {{/menu_enabled}}
      const plat = platformKey();
      const platLabel = platformLabelFor(plat);
      const mirrorOn = !!appSettings.downloadMirror;
      const list = cat.apps.map((a) => {
        // Trust the filesystem, not just state.json: an install whose folder is
        // gone must show as "not installed" instead of an unlaunchable card.
        const ins = appStore.isInstalled(a.id) ? st.apps[a.id] : null;
        const selectedRuntime = (appStore && appStore.runtimeForEntry)
          ? appStore.runtimeForEntry(a, ins && ins.runtime)
          : null;
        // Only a platform with a published bundle for a usable runtime can be
        // installed/updated here; a legacy flat artifact remains a fallback.
        const selectedArtifact = (appStore && appStore.artifactForEntry)
          ? appStore.artifactForEntry(a, plat, ins && ins.runtime)
          : (a.artifacts && a.artifacts[plat]);
        const art = selectedArtifact || (a.artifacts && a.artifacts[plat]);
        const platformOk = (!a.artifacts && !a.artifacts_by_runtime) ? true : !!art;
        const entryAbi = (selectedRuntime && (selectedRuntime.artifactAbi || selectedRuntime.abi)) ||
          a.r_abi ||
          ((a.r_version || '').split('.').slice(0, 2).join('.'));
        const incompatible = !!(
          !selectedRuntime ||
          (selectedRuntime.version && selectedRuntime.artifactRVersion &&
            cmpVersion(selectedRuntime.version, selectedRuntime.artifactRVersion) < 0) ||
          (a.min_shell_version && cmpVersion('{{{app_version_js}}}', a.min_shell_version) < 0)
        );
        // A URL-installed app keeps its original source link; catalog apps use
        // the artifact for this platform.
        const sourceUrl = (ins && ins.sourceUrl) || '';
        const hasCatalogLink = !!(art && art.url);
        const downloadLinkKind = sourceUrl ? 'source' : (hasCatalogLink ? 'catalog' : '');
        return {
          id: a.id, name: a.name, description: a.description,
          // Installed apps use the cached icon (data URL) when available, so
          // their cards render without a network request. Other catalog cards
          // use the remote icon.
          icon: (ins && appStore.iconDataUrl(a.id)) || a.icon || '',
          author: a.author || '',
          homepage: a.homepage || a.homepage_url || a.url || '',
          docs: a.docs || a.documentation || a.help_url || '',
          catalogVersion: a.version,
          installed: !!ins, installedVersion: ins ? ins.version : null,
          updateAvailable: !!ins && cmpVersion(a.version, ins.version) > 0 && platformOk && !incompatible,
          running: appStore.isRunning(a.id),
          tags: Array.isArray(a.tags) ? a.tags : [],
          available: platformOk,
          size: (art && art.size) || 0,
          license: a.license || '',
          rVersion: a.r_version || '',
          rAbi: entryAbi,
          minShellVersion: a.min_shell_version || '',
          incompatible: incompatible,
          hasDownloadLink: !!downloadLinkKind,
          hasMirrorLink: downloadLinkKind === 'catalog' && mirrorOn,
          downloadLinkKind: downloadLinkKind,
          downloadPlatformLabel: downloadLinkKind === 'catalog' ? platLabel : '',
          state: ins ? 'installed' : 'not-installed'
        };
      });
      // Append sideloaded apps: installed ids that are not in the catalog.
      const catIds = {};
      cat.apps.forEach((a) => { catIds[a.id] = true; });
      Object.keys(st.apps).forEach((id) => {
        if (catIds[id] || !appStore.isInstalled(id)) return;
        const lins = st.apps[id];
        const lm = (lins && lins.meta) || {};
        const sourceUrl = (lins && lins.sourceUrl) || '';
        list.push({
          id: id, name: lm.name || id, description: lm.description || '',
          // Sideloaded apps have no catalog icon; use one cached earlier if the
          // app was previously listed (or installed from the catalog).
          icon: (appStore.iconDataUrl(id) || ''),
          author: lm.author || '',
          homepage: lm.homepage || '',
          docs: '',
          catalogVersion: (lins && lins.version) || null,
          installed: true, installedVersion: (lins && lins.version) || null,
          updateAvailable: false,
          running: appStore.isRunning(id),
          tags: [], available: true, size: 0,
          license: lm.license || '', rVersion: lm.rVersion || '',
          rAbi: lm.rAbi || '',
          minShellVersion: '', incompatible: false,
          hasDownloadLink: !!sourceUrl,
          hasMirrorLink: false,
          downloadLinkKind: sourceUrl ? 'source' : '',
          downloadPlatformLabel: '',
          local: !!(lins && lins.source === 'local'),
          state: 'installed'
        });
      });
      // Bundle installs are user-picked files, not catalog entries. Expose the
      // active one as a synthetic transient app so the Installing section can
      // render progress and its own Cancel button. The normal tasks array still
      // carries per-catalog-app progress only.
      const bundleTask = activeStoreTasks().find(function (t) {
        return t.op === 'install_bundle';
      });
      if (bundleTask) {
        list.push({
          id: '__bundle__',
          name: bundleTask.displayName || 'Bundle install',
          description: bundleTask.displayDescription || 'Installing a local bundle',
          icon: '', author: '', homepage: '', docs: '',
          catalogVersion: '', installed: false, installedVersion: null,
          updateAvailable: false, running: false, tags: [],
          available: true, size: 0,
          license: '', rVersion: '', rAbi: '', minShellVersion: '',
          incompatible: false,
          hasDownloadLink: false, hasMirrorLink: false,
          downloadLinkKind: '', downloadPlatformLabel: '',
          transient: true,
          state: bundleTask.state === 'running' ? 'installing' : bundleTask.state,
          taskId: bundleTask.taskId,
          op: bundleTask.op,
          percent: bundleTask.percent,
          statusText: bundleTask.statusText,
          step: bundleTask.step
        });
      }
      // Background tasks let the launcher restore per-catalog-app progress after
      // a reload. Bundle tasks are represented by the synthetic app above.
      const tasks = activeStoreTasks()
        .filter(function (t) { return t.appId !== '__bundle__'; })
        .map(publicStoreTask);
      return { apps: list, offline: offline, tasks: tasks };
    });
  }


  ipcMain.handle('copy-download-link', async (_event, appId, mirror) => {
    try {
      if (!appId) return { ok: false, error: 'No app selected' };
      const { clipboard } = require('electron');
      const st = appStore && appStore.getState ? appStore.getState() : null;
      const ins = (st && st.apps) ? st.apps[appId] : null;
      let url = '';
      let kind = '';
      if (ins && ins.sourceUrl) {
        // A URL-installed app keeps the exact source the user chose.
        if (mirror) return { ok: false, error: 'This app was installed from a URL; use Copy download link' };
        url = ins.sourceUrl;
        kind = 'source';
      } else {
        let entry = appStore ? appStore.catalogEntry(appId) : null;
        if (!entry && appStore) {
          try { await appStore.fetchCatalog(); entry = appStore.catalogEntry(appId); } catch (e) { /* offline */ }
        }
        const art = (entry && appStore.artifactForEntry)
          ? appStore.artifactForEntry(entry, platformKey(), ins && ins.runtime)
          : (entry && entry.artifacts && entry.artifacts[platformKey()]);
        if (!art || !art.url) return { ok: false, error: 'No bundle is published for this platform' };
        if (mirror) {
          if (!appSettings.downloadMirror) return { ok: false, error: 'No download mirror is configured' };
          const urls = downloadUrls(art.url, appSettings.downloadMirror);
          if (urls.length < 2) return { ok: false, error: 'The mirror does not produce a different URL' };
          url = urls[0];
          kind = 'mirror';
        } else {
          url = art.url;
          kind = 'catalog';
        }
      }
      clipboard.writeText(url);
      return { ok: true, url: url, kind: kind };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('copy-diagnostics', async (_event, appId) => {
    try {
      const { clipboard } = require('electron');
      const os = require('os');
      const id = appId || lastSelectedAppId || null;
      const ins = (id && appStore && appStore.isInstalled(id)) ? appStore.getState().apps[id] : null;
      const ce = (id && appStore) ? appStore.catalogEntry(id) : null;
      const L = [];
      L.push('ShinyApps diagnostics');
      L.push('generated: ' + new Date().toISOString());
      L.push('shell: ' + app.getVersion() + '  bundled R: ' + (SHELL_R_VERSION || '(unknown)'));
      L.push('electron: ' + process.versions.electron + '  chrome: ' + process.versions.chrome + '  node: ' + process.versions.node);
      L.push('os: ' + process.platform + ' ' + process.arch + ' (' + (os.release ? os.release() : '') + ')');
      if (id) {
        L.push('');
        L.push('app: ' + id);
        if (ins) {
          L.push('installed: v' + ins.version + '  source: ' + (ins.source || '?') + '  platform: ' + (ins.platform || '?'));
          L.push('runtime: ' + (ins.runtime || '(none)') + '  ABI: ' + (ins.r_abi || '?'));
          const rt = (ins.runtime && appStore && appStore.runtimeInfo) ? appStore.runtimeInfo(ins.runtime) : null;
          if (rt) L.push('runtime version: ' + (rt.version || '?') + '  source: ' + (rt.source || '?'));
          L.push('packages: ' + ((ins.packages || []).join(', ') || '(none)'));
        } else {
          L.push('installed: no');
        }
        if (ce) L.push('catalog: v' + ce.version + (ce.r_version ? '  requires R ' + ce.r_version : ''));
      }
      if (id) {
        const logPath = (appLogAppId && String(appLogAppId) === String(id) && appLogPath) ? appLogPath : latestAppLog(id);
        if (logPath && fs.existsSync(logPath)) {
          L.push('');
          L.push('--- log: ' + path.basename(logPath) + ' (last 200 lines) ---');
          L.push(fs.readFileSync(logPath, 'utf8').split('\n').slice(-200).join('\n'));
        }
      }
      clipboard.writeText(L.join('\n'));
      return true;
    } catch (e) {
      log('warn', 'copy-diagnostics failed:', e && e.message);
      return false;
    }
  });

  ipcMain.handle('store-usage', async () => {
    if (!appStore) return null;
    const onUsageProgress = function (done, total, label) {
      storeCommand({ cmd: 'usage_progress', done: done, total: total, label: label });
    };
    try { return await appStore.usage(onUsageProgress); }
    catch (e) { log('warn', 'store-usage failed:', e && e.message); return null; }
  });

  ipcMain.handle('store-cleanup', async () => {
    if (!appStore) return { freed: 0 };
    // Cleanup deletes staging/cache dirs; never run it while a download or
    // install is using them.
    if (activeStoreTasks().length) return { freed: 0, busy: true };
    storeCommand({ cmd: 'busy_begin', title: 'Cleaning up\u2026' });
    const onCleanupProgress = function (done, total, label) {
      storeCommand({ cmd: 'busy_progress', done: done, total: total, label: label });
    };
    try { return await appStore.cleanup(onCleanupProgress); }
    catch (e) { log('warn', 'store-cleanup failed:', e && e.message); return { freed: 0, error: String((e && e.message) || e) }; }
    finally { storeCommand({ cmd: 'busy_done' }); }
  });

  ipcMain.handle('open-data-root', async () => {
    try {
      const root = resolveDataRoot();
      try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
      await shell.openPath(root);
      return true;
    } catch (e) { return false; }
  });

  ipcMain.handle('store-disk-free', async () => {
    if (!appStore) return null;
    try { return await appStore.getDiskFree(); }
    catch (e) { return null; }
  });

  ipcMain.handle('get-settings', async () => ({
    catalogUrl: appSettings.catalogUrl || DEFAULT_CATALOG_URL,
    defaultCatalogUrl: DEFAULT_CATALOG_URL,
    downloadMirror: appSettings.downloadMirror || '',
    crashReporting: !!appSettings.crashReporting,
    metricsOverlay: appSettings.metricsOverlay !== false,
    launcherCloseAction: appSettings.launcherCloseAction || '',
    trayEnabled: {{#tray_enabled}}true{{/tray_enabled}}{{^tray_enabled}}false{{/tray_enabled}},
    dataRoot: resolveDataRoot(),
    defaultDataRoot: DEFAULT_DATA_ROOT,
  }));

  ipcMain.handle('set-catalog-url', async (_event, url) => {
    const u = String(url || '').trim();
    if (u && !/^https?:\/\//i.test(u)) return { ok: false, error: 'URL must start with http:// or https://' };
    if (u) appSettings.catalogUrl = u; else delete appSettings.catalogUrl;
    saveSettings();
    if (appStore) appStore.setCatalogUrl(appSettings.catalogUrl || DEFAULT_CATALOG_URL);
    return { ok: true, catalogUrl: appSettings.catalogUrl || DEFAULT_CATALOG_URL };
  });

  ipcMain.handle('set-download-mirror', async (_event, value) => {
    const v = String(value || '').trim();
    let valid = '';
    if (v) {
      if (/\s/.test(v)) return { ok: false, error: 'The mirror URL cannot contain spaces' };
      const test = v.includes('{url}') ? v.split('{url}').join(DEFAULT_CATALOG_URL) : v;
      let u;
      try { u = new URL(test); } catch (e) { return { ok: false, error: 'Enter a valid https:// URL (optionally with {url})' }; }
      if (u.protocol !== 'https:') return { ok: false, error: 'The mirror must use https://' };
      valid = v;
    }
    if (valid) appSettings.downloadMirror = valid; else delete appSettings.downloadMirror;
    saveSettings();
    return { ok: true, downloadMirror: valid };
  });

  ipcMain.handle('set-crash-reporting', async (_event, on) => {
    appSettings.crashReporting = !!on;
    saveSettings();
    if (appSettings.crashReporting) installCrashHandlers();
    return { ok: true, crashReporting: !!appSettings.crashReporting };
  });

  ipcMain.handle('set-metrics-overlay', async (_event, on) => {
    appSettings.metricsOverlay = !!on;
    saveSettings();
    if (appSettings.metricsOverlay) {
      metricsTick();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      var wc = contentWebContents();
      var onAppPage = false;
      try { onAppPage = !!(wc && /^https?:/i.test(wc.getURL() || '')); } catch (e) {}
      if (onAppPage) {
        setWindowTitleForApp((currentAppMeta && currentAppMeta.id) || lastSelectedAppId || '', true);
      } else {
        restorePageTitle(true);
      }
    }
    return { ok: true, metricsOverlay: !!appSettings.metricsOverlay };
  });

  ipcMain.handle('set-launcher-close-action', async (_event, action) => {
    setLauncherCloseAction(action === 'tray' || action === 'quit' ? action : '');
    return { ok: true, launcherCloseAction: appSettings.launcherCloseAction || '' };
  });

  ipcMain.handle('reset-local-data', async () => {
    await resetLocalData();
    return true;
  });

  ipcMain.handle('uninstall-shinyapps', async () => {
    await uninstallShinyApps();
    return true;
  });

  ipcMain.handle('change-data-root', async () => {
    const { dialog } = require('electron');
    const cur = resolveDataRoot();
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for ShinyApps apps & data',
      defaultPath: cur,
      properties: ['openDirectory', 'createDirectory']
    });
    if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
    const target = pick.filePaths[0];
    const curAbs = path.resolve(cur);
    const targetAbs = path.resolve(target);
    if (targetAbs === curAbs) return { ok: false, message: 'That is already the current location.' };
    // Nesting one root inside the other would make the copy/cleanup below
    // delete the data it just wrote.
    if (targetAbs.indexOf(curAbs + path.sep) === 0 || curAbs.indexOf(targetAbs + path.sep) === 0) {
      return { ok: false, message: 'Choose a folder outside the current app data location.' };
    }
    let existing = false;
    try {
      existing = fs.existsSync(path.join(target, 'state.json')) ||
        (fs.existsSync(path.join(target, 'apps')) && fs.readdirSync(path.join(target, 'apps')).length > 0);
    } catch (e) {}
    let migrate = false;
    if (existing) {
      const m = await dialog.showMessageBox(mainWindow, {
        type: 'question', noLink: true,
        title: 'App data location',
        message: 'This folder already has ShinyApps data.',
        detail: target + '\n\nUse the existing apps there, or overwrite them with the data from the current location?',
        buttons: ['Use existing data', 'Overwrite with current data', 'Cancel'],
        defaultId: 0, cancelId: 2
      });
      if (m.response === 2) return { ok: false, canceled: true };
      if (m.response === 0) {
        // Keep the apps already in the target: just repoint and restart.
        appSettings.dataRoot = target;
        saveSettings();
        app.relaunch();
        app.exit(0);
        return { ok: true };
      }
      migrate = true;
    } else {
      const m = await dialog.showMessageBox(mainWindow, {
        type: 'question', noLink: true,
        title: 'App data location',
        message: 'Use this folder for apps and data?',
        detail: target + '\n\nMove your installed apps and libraries from the current location?',
        buttons: ['Move existing data', 'Use empty folder', 'Cancel'],
        defaultId: 0, cancelId: 2
      });
      if (m.response === 2) return { ok: false, canceled: true };
      migrate = m.response === 0;
    }
    const sendBusy = function (ev) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', Object.assign({ id: '__bundle__' }, ev)); };
    sendBusy({ state: 'installing', statusText: (migrate ? ('Moving data to ' + target + '\u2026') : ('Updating location to ' + target + '\u2026')), percent: 0 });
    try {
      if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
      await fsp.mkdir(target, { recursive: true });
      if (migrate) {
        const items = ['apps', 'lib', 'private', 'store-cache', 'state.json'];
        const present = items.filter(function (it) { return fs.existsSync(path.join(cur, it)); });
        const totalItems = Math.max(1, present.length);
        let moved = 0;
        for (const it of present) {
          sendBusy({ state: 'installing', statusText: 'Moving ' + it + ' \u2026', percent: Math.round((moved / totalItems) * 100) });
          await fsp.cp(path.join(cur, it), path.join(target, it), { recursive: true, force: true });
          moved++;
          sendBusy({ state: 'installing', statusText: 'Moved ' + it, percent: Math.round((moved / totalItems) * 100) });
        }
        // The copied state.json still holds the old absolute install paths.
        rewriteStateDirs(path.join(target, 'state.json'), cur, target);
        // "Move" must not leave the old copy behind (it would double the disk
        // use and could be picked up again if the location is switched back).
        for (const it of present) {
          try { await fsp.rm(path.join(cur, it), { recursive: true, force: true }); }
          catch (e) { log('warn', 'could not remove old ' + it + ':', e && e.message); }
        }
      }
      appSettings.dataRoot = target;
      saveSettings();
    } catch (e) {
      log('error', 'data root change failed:', e && e.message);
      sendBusy({ state: 'error', error: (e && e.message) || String(e), message: 'Could not change app data location: ' + ((e && e.message) || e) });
      return { ok: false, message: (e && e.message) || String(e) };
    }
    sendBusy({ state: 'done', message: 'App data location updated. Restarting\u2026' });
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.on('theme-changed', (_event, mode) => {
    const m = (mode === 'light' || mode === 'dark') ? mode : 'system';
    if (m === currentThemeMode) return;
    currentThemeMode = m;
    {{#menu_enabled}}
    createMenu();
    {{/menu_enabled}}
  });

  ipcMain.on('quick-run-order', (_event, data) => {
    if (data && Array.isArray(data.order)) quickRunOrder = data.order;
    quickRunFavorites = {};
    if (data && Array.isArray(data.favorites)) { for (const f of data.favorites) quickRunFavorites[f] = true; }
    {{#menu_enabled}}
    createMenu();
    {{/menu_enabled}}
  });

  ipcMain.handle('open-app-folder', async (_event, appId) => {
    try {
      if (!appStore || !appId || !appStore.isInstalled(appId)) return false;
      const ins = appStore.getState().apps[appId];
      if (!ins || !ins.dir) return false;
      const entry = (ins.meta && ins.meta.entry) || 'app/app.R';
      const dir = path.join(ins.dir, path.dirname(entry) || 'app');
      await shell.openPath(dir);
      return true;
    } catch (e) {
      log('warn', 'open-app-folder failed:', e && e.message);
      return false;
    }
  });

  ipcMain.handle('open-app-log', async (_event, appId) => {
    const id = appId || lastSelectedAppId || appLogAppId || 'shell';
    let target = null;
    if (appLogAppId && String(appLogAppId) === String(id) && appLogPath) target = appLogPath;
    else target = latestAppLog(id);
    try {
      if (!target || !fs.existsSync(target)) {
        const dir = path.join(appLogRoot, safeLogId(id));
        fs.mkdirSync(dir, { recursive: true });
        await shell.openPath(dir);
        return false;
      }
      await shell.openPath(target);
      return true;
    } catch (e) {
      log('warn', 'open-app-log failed:', e && e.message);
      return false;
    }
  });

  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // Multi-app: load launcher instead of starting backend immediately
  if (appsManifest) {
    mainWindow.loadFile('launcher.html');
  } else {
  // Load lifecycle page
  loadLifecyclePage(mainWindow);
  }

  // Start backend server
  const port = {{server_port}};

  // Resolve app path -- for native backends, files are unpacked from ASAR
  let appPath = path.join(__dirname, 'src', 'app');
  const unpackedPath = appPath.replace('app.asar', 'app.asar.unpacked');
  if (unpackedPath !== appPath && fs.existsSync(unpackedPath)) {
    appPath = unpackedPath;
  }

  if (!appsManifest) {
  // Forward backend status to lifecycle page
  backend.on('status', (data) => {
    log('info', `[lifecycle] ${data.phase}: ${data.message || ''}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lifecycle-status', data);
    }

    // Track server running state
    if (data.phase === 'server_ready') serverRunning = true;
    if (data.phase === 'stopping_server' || data.phase === 'error' || data.phase === 'server_crashed') serverRunning = false;

    // Update tray status
    {{#tray_enabled}}
    if (tray) {
      let statusText = 'Starting...';
      if (data.phase === 'server_ready') statusText = 'Running';
      else if (data.phase === 'error' || data.phase === 'server_crashed') statusText = 'Error';
      else if (data.phase === 'shutting_down') statusText = 'Shutting down...';
      else if (data.phase === 'finding_runtime') statusText = 'Finding runtime...';
      else if (data.phase === 'installing_packages') statusText = 'Installing packages...';
      else if (data.phase === 'checking_packages') statusText = 'Checking packages...';

      tray.setToolTip('{{{app_name_js}}} - ' + statusText);
      // Also update the Status menu item label so the context menu reflects
      // the current state (guards against older Electron builds missing
      // getMenuItemById by wrapping in try/catch).
      try {
        if (trayMenu) {
          const statusItem = trayMenu.getMenuItemById('status');
          if (statusItem) {
            statusItem.label = 'Status: ' + statusText;
            tray.setContextMenu(trayMenu);
          }
        }
      } catch { /* menu update is best-effort */ }
    }
    {{/tray_enabled}}
  });

  // Defensive: an 'error' event with no listener throws in Node and would
  // crash the main process, so always keep one attached.
  backend.on('error', (err) => {
    log('error', 'Backend error event:', err && err.message ? err.message : err);
  });

  backend.start({
    appPath: appPath,
    port: port,
    config: {{{backend_config_json}}}
  }).then(({ port: p }) => {
    actualPort = p;
    log('info', 'Server ready on port', actualPort);
    mainWindow.loadURL(`http://localhost:${actualPort}`);
  }).catch((err) => {
    if (isSupersededStart(err)) return;
    log('error', 'Backend start failed:', err.message);
  });
  } // end if (!appsManifest)

  // Launch (or re-launch) a selected multi-app sub-app. Shared by the
  // select_app and retry IPC actions so retry re-attempts the SAME app
  // rather than the single-app defaults.
  function startSelectedApp(appId) {
    var selectedApp = appsManifest && appsManifest.apps.find(function(a) { return a.id === appId; });
    if (!selectedApp) return;
    lastSelectedAppId = appId;
    currentAppMeta = appMetaFor(appId);
    {{#menu_enabled}}
    createMenu();
    {{/menu_enabled}}

    // Derive the serve descriptor defensively so an absent/older apps-manifest
    // (no `serve`) degrades to native dispatch instead of throwing. The per-app
    // runtime_strategy comes from the serve descriptor when present.
    var serve = selectedApp.serve || {};
    var serveKind = serve.kind || (
      selectedApp.runtime_strategy === 'shinylive' ? 'shinylive' :
      (selectedApp.runtime_strategy === 'container' ? 'container' : 'native')
    );
    var serveStrategy = serve.runtime_strategy || selectedApp.runtime_strategy || appsManifest.runtime_strategy;

    // Stop the OUTGOING per-app backend and purge its listeners, but NEVER the
    // shared shinylive server -- it is tracked separately (sharedShinyliveServer)
    // and must outlive launcher round-trips and native-backend starts.
    if (currentBackend && currentBackend !== sharedShinyliveServer) {
      currentBackend.removeAllListeners();
      currentBackend.stop();
    }
    currentBackend = null;

    // Shinylive apps share ONE persistent server bound to the site root.
    if (serveKind === 'shinylive') {
      startSharedShinyliveApp(selectedApp, serve);
      return;
    }

    // Native / container: load this app's own backend, keyed on the resolved
    // per-app runtime strategy (mixed-strategy suites).
    var appType = selectedApp.type || appsManifest.default_type;
    currentBackend = getBackendForApp(appType, serveStrategy);
    openAppLog(selectedApp.id);

    // Forward status to lifecycle.html and track running state (so multi-app
    // builds get the same quit-confirmation / shutdown UI as single-app).
    currentBackend.on('status', function(data) {
      appLogWrite('[' + data.phase + '] ' + (data.message || ''));
      log('info', '[lifecycle] ' + data.phase + ': ' + (data.message || ''));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lifecycle-status', data);
      }
      if (data.phase === 'server_ready') serverRunning = true;
      if (data.phase === 'stopping_server' || data.phase === 'error' || data.phase === 'server_crashed') serverRunning = false;
      if (data.phase === 'app_exit') closeAppLog();
      // Update tray status for multi-app mode (mirrors the single-app handler)
      {{#tray_enabled}}
      if (tray) {
        var statusText = 'Starting...';
        if (data.phase === 'server_ready') statusText = 'Running';
        else if (data.phase === 'error' || data.phase === 'server_crashed') statusText = 'Error';
        else if (data.phase === 'shutting_down') statusText = 'Shutting down...';
        else if (data.phase === 'finding_runtime') statusText = 'Finding runtime...';
        else if (data.phase === 'installing_packages') statusText = 'Installing packages...';
        else if (data.phase === 'checking_packages') statusText = 'Checking packages...';
        tray.setToolTip((selectedApp.name || '{{{app_name_js}}}') + ' - ' + statusText);
        try {
          if (trayMenu) {
            var statusItem = trayMenu.getMenuItemById('status');
            if (statusItem) {
              statusItem.label = 'Status: ' + statusText;
              tray.setContextMenu(trayMenu);
            }
          }
        } catch { /* menu update is best-effort */ }
      }
      {{/tray_enabled}}
    });
    currentBackend.on('output', function (o) { appLogWrite((o && o.stream ? o.stream : 'out') + ': ' + ((o && o.line) || '')); });
    // Defensive: never let an 'error' event with no listener crash the process.
    currentBackend.on('error', function(err) {
      appLogWrite('[error] ' + (err && err.message ? err.message : err));
      log('error', 'Backend error event:', err && err.message ? err.message : err);
    });

    // Show lifecycle page during startup
    loadLifecyclePage(mainWindow);

    // Resolve the app path (ASAR-aware). Prefer the serve descriptor's
    // path/site; fall back to the legacy top-level path for older manifests.
    var selectedAppPath = path.join(__dirname, serve.path || serve.site || selectedApp.path);
    var unpackedAppPath = selectedAppPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedAppPath !== selectedAppPath && fs.existsSync(unpackedAppPath)) {
      selectedAppPath = unpackedAppPath;
    }

    // Start the backend
    // app_slug stays as the suite-level slug (for shared venv/runtime);
    // app_id identifies the sub-app (for per-app prefs/caching).
    currentBackend.start({
      appPath: selectedAppPath,
      port: port,
      config: Object.assign({}, {{{backend_config_json}}}, {
        app_type: appType,
        app_id: selectedApp.id,
        runtime_strategy: serveStrategy
      })
    }).then(function(result) {
      actualPort = result.port;
      storeAppUrls[selectedApp.id] = 'http://localhost:' + actualPort;
      mainWindow.loadURL('http://localhost:' + actualPort).then(function () {
        setWindowTitleForApp(selectedApp.id);
      }).catch(function () { /* navigation errors are reported elsewhere */ });
    }).catch(function(err) {
      if (isSupersededStart(err)) return;
      log('error', 'Backend start failed:', err.message);
    });
  }

  // Start (lazily) or reuse the single shared shinylive server. It binds to the
  // SITE ROOT (src/shinylive-site), so every sub-app is reachable at /<subdir>/
  // on ONE stable origin. Reuse means launcher round-trips and native-backend
  // starts never tear it down (the teardown sites skip sharedShinyliveServer).
  function startSharedShinyliveApp(selectedApp, serve) {
    var subdir = serve.subdir || selectedApp.id;
    var navigate = function() {
      // Trailing slash + 127.0.0.1 (never localhost) keeps one origin and one
      // root-scoped service worker across sub-app navigations.
      storeAppUrls[selectedApp.id] = 'http://127.0.0.1:' + sharedShinylivePort + '/' + subdir + '/';
      mainWindow.loadURL('http://127.0.0.1:' + sharedShinylivePort + '/' + subdir + '/');
    };

    if (sharedShinyliveServer && sharedShinylivePort) {
      navigate();
      return;
    }

    // Resolve the site root (ASAR-aware) and start the persistent server once.
    var siteRoot = path.join(__dirname, serve.site || 'src/shinylive-site');
    var unpackedSite = siteRoot.replace('app.asar', 'app.asar.unpacked');
    if (unpackedSite !== siteRoot && fs.existsSync(unpackedSite)) {
      siteRoot = unpackedSite;
    }

    loadLifecyclePage(mainWindow);
    sharedShinyliveServer = require('./backends/shinylive');
    sharedShinyliveServer.on('status', function(data) {
      log('info', '[shinylive] ' + data.phase + ': ' + (data.message || ''));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lifecycle-status', data);
      }
      if (data.phase === 'server_ready') serverRunning = true;
    });
    sharedShinyliveServer.on('error', function(err) {
      log('error', 'Shinylive server error:', err && err.message ? err.message : err);
    });
    sharedShinyliveServer.start({
      appPath: siteRoot,
      port: port,
      config: Object.assign({}, {{{backend_config_json}}}, {
        app_type: selectedApp.type,
        app_id: selectedApp.id
      })
    }).then(function(result) {
      sharedShinylivePort = result.port;
      navigate();
    }).catch(function(err) {
      log('error', 'Shinylive server start failed:', err.message);
      // Reset the singleton so a subsequent selection gets a clean server
      // with no accumulated duplicate listeners.
      sharedShinyliveServer.removeAllListeners();
      sharedShinyliveServer = null;
      // sharedShinylivePort is already null (start never completed)
    });
  }

  // Handle IPC actions from lifecycle.html and launcher.html (retry, quit, select_app, etc.)
  // Wrapped in try/catch: a backend emit or getBackendForApp throwing
  // should not crash the Electron main process silently.
  ipcMain.on('lifecycle-action', async (_event, action) => {
    try {
    var actionType = typeof action === 'string' ? action : action.type;

    if (actionType === 'retry') {
      if (appsManifest) {
        // Multi-app: re-attempt the last selected app, or return to launcher.
        // Catalog apps are not in the baked suite manifest, so retry them
        // through the store launcher instead.
        var retryBaked = lastSelectedAppId && appsManifest.apps.some(function (a) { return a.id === lastSelectedAppId; });
        if (lastSelectedAppId && retryBaked) {
          startSelectedApp(lastSelectedAppId);
        } else if (lastSelectedAppId && appStore) {
          runStoreApp(lastSelectedAppId);
        } else {
          showLauncherWindow();
        }
      } else {
        loadLifecyclePage(mainWindow);
        backend.start({ appPath, port, config: {{{backend_config_json}}} }).then(({ port: p }) => {
          actualPort = p;
          mainWindow.loadURL(`http://localhost:${actualPort}`);
        }).catch((err) => {
          if (isSupersededStart(err)) return;
          log('error', 'Backend retry failed:', err.message);
        });
      }
    } else if (actionType === 'quit') {
      app.quit();
    } else if (actionType === 'report_problem') {
      var reportAppId = lastSelectedAppId || (currentAppMeta && currentAppMeta.id) || 'shinyapps-store';
      reportLaunchFailure({
        appId: reportAppId,
        phase: 'manual_report',
        summary: 'Manual report from the lifecycle error screen',
        exitCode: null,
        signal: '',
        logTail: reportAppId !== 'shinyapps-store' ? readLogTail(reportAppId) : ''
      }).catch(function (e) { log('warn', 'launch report failed:', e && e.message); });
    } else if (actionType === 'install') {
      (currentBackend || backend).emit('install-packages', {
        libPath: action.libPath || 'system'
      });
    } else if (actionType === 'skip_install') {
      (currentBackend || backend).emit('skip-install');
    } else if (actionType === 'select_runtime') {
      (currentBackend || backend).emit('runtime-selected', { runtimePath: action.runtimePath });
    } else if (actionType === 'select_app') {
      lastSelectedAppId = action.appId;
      startSelectedApp(action.appId);

    } else if (actionType === 'show_store') {
      showLauncherWindow();

    } else if (actionType === 'back_to_launcher') {
      leaveToLauncher();

    } else if (actionType === 'install_app' || actionType === 'uninstall_app' || actionType === 'update_app') {
      if (!appStore) return;
      await runStoreAction(actionType, action.appId);

    } else if (actionType === 'cancel_store') {
      cancelStoreTask(action.taskId);

    } else if (actionType === 'install_bundle') {
      if (!appStore) return;
      const { dialog } = require('electron');
      let bundlePath = action.path;
      const bundleUrl = action.url;
      if (!bundlePath && !bundleUrl) {
        const res = await dialog.showOpenDialog(mainWindow, {
          title: 'Install app bundle',
          properties: ['openFile'],
          filters: [{ name: 'ShinyApps bundle', extensions: ['zip', 'bundle'] }]
        });
        if (res.canceled || !res.filePaths.length) return;
        bundlePath = res.filePaths[0];
      }
      var activeBundle = Array.from(storeTasks.values()).find(function (t) {
        return taskIsActive(t) && t.op === 'install_bundle';
      });
      if (activeBundle) {
        sendStoreStatus({ id: '__bundle__', state: 'busy', message: 'A bundle install is already in progress; please wait.' });
        return;
      }
      // Bundles install immediately (they are user-picked files) but still go
      // through the task registry for progress and cancellation. Catalog
      // installs keep running in parallel.
      registerStoreTask({
        appId: '__bundle__', op: 'install_bundle', priority: 3, immediate: true,
        displayName: 'Bundle install',
        displayDescription: bundleUrl ? 'Downloading a bundle from URL' : 'Installing a local bundle',
        run: async function (task) {
          const confirmBundle = async function (m) {
            task.displayName = (m.name || m.id) + (m.version ? ' ' + m.version : '');
            task.displayDescription = (bundleUrl ? 'URL bundle · ' : 'Local bundle · ') +
              (m.id || '') + (m.version ? ' ' + m.version : '');
            sendStoreStatus({
              id: '__bundle__', taskId: task.taskId, state: 'installing',
              op: 'install_bundle', statusText: 'awaiting confirmation',
              name: task.displayName, description: task.displayDescription,
            });
            const detail = [
              'Platform: ' + m.platform,
              m.r_version ? 'Requires R ' + m.r_version : '',
              m.author ? 'Author: ' + m.author : '',
              m.license ? 'License: ' + m.license : '',
              '',
              'This bundle is NOT from the ShinyApps catalog.',
              'Install only if you trust its source.'
            ].filter(Boolean).join('\n');
            const r = await dialog.showMessageBox(mainWindow, {
              type: 'warning', noLink: true,
              title: 'Install app bundle',
              message: 'Install ' + (m.name || m.id) + ' ' + m.version + '?',
              detail: detail,
              buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1
            });
            return r.response === 0;
          };
          const onProg = function (pp) { emitTaskProgress(task, pp); };
          if (bundleUrl) return await appStore.installFromUrl(bundleUrl, { onProgress: onProg, confirm: confirmBundle, signal: task.signal });
          return await appStore.installFromFile(bundlePath, { onProgress: onProg, confirm: confirmBundle, signal: task.signal });
        },
      });

    } else if (actionType === 'run_app') {
      await runStoreApp(action.appId);

    } else if (actionType === 'open_app') {
      // Re-open a still-running app without restarting it.
      if (!appStore) return;
      lastSelectedAppId = action.appId;
      currentAppMeta = appMetaFor(action.appId);
      {{#menu_enabled}}
      createMenu();
      {{/menu_enabled}}
      var openUrl = storeAppUrls[action.appId];
      if (openUrl) {
        if (appWindowAlive() && appWindowAppId === action.appId) {
          appWindow.show();
          appWindow.focus();
          setWindowTitleForApp(action.appId);
        } else {
          var reopen = ensureAppWindow(action.appId);
          reopen.show();
          if (appView && !appView.webContents.isDestroyed()) {
            appView.webContents.loadURL(openUrl).then(function () {
              setWindowTitleForApp(action.appId);
            }).catch(function () {});
          }
        }
      } else {
        await runStoreApp(action.appId);
      }

    } else if (actionType === 'stop_app') {
      if (!appStore) return;
      try {
        await stopStoreApp(action.appId);
        sendStoreStatus({ id: action.appId, state: 'done', op: 'stop_app' });
      } catch (e) {
        log('error', 'stop_app failed:', e && e.message);
        sendStoreStatus({
          id: action.appId, state: 'error', op: 'stop_app',
          error: (e && e.message) || String(e)
        });
      }
    }
    } catch (err) {
      log('error', 'IPC action failed:', err && err.message ? err.message : err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lifecycle-status', {
          phase: 'error',
          message: 'Internal error handling action: ' + (err && err.message ? err.message : 'unknown')
        });
      }
    }
  });

  {{#menu_enabled}}
  createMenu();
  {{/menu_enabled}}
  {{^menu_enabled}}
  // Hide menu bar when menus are disabled
  mainWindow.setMenuBarVisibility(false);
  {{/menu_enabled}}

  // Clear Service Worker cache to prevent shinylive apps from serving
  // stale content when multiple apps share the same localhost origin
  mainWindow.webContents.session.clearStorageData({
    storages: ['serviceworkers', 'cachestorage']
  }).catch(() => {});

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.ELECTRON_DEV_TOOLS === 'true') {
      mainWindow.webContents.openDevTools();
    }
  });

  // Retry reports queued while offline or while the Worker was down.
  setTimeout(function () {
    flushPendingReports().catch(function () { /* best effort */ });
  }, 5000);

  {{#tray_enabled}}
  {{#minimize_to_tray}}
  // Minimize to tray instead of taskbar
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });
  {{/minimize_to_tray}}
  {{/tray_enabled}}

  // Shutdown flow
  mainWindow.on('close', (event) => {
    // Multi-app store: closing the app page returns to the launcher; closing
    // the launcher asks whether to hide to the tray or quit.
    if (appsManifest) {
      if (isShuttingDown || app.isQuitting) return;
      let url = '';
      try { url = mainWindow.webContents.getURL() || ''; } catch (e) {}
      const onLauncher = url.indexOf('launcher.html') !== -1 ||
        (!url && isLauncherVisible);
      if (!onLauncher) {
        event.preventDefault();
        if (typeof leaveToLauncher === 'function') {
          leaveToLauncher();
        } else {
          // Menu-less multi-app build: still return to the launcher rather
          // than closing the shell.
          if (currentBackend) { currentBackend.removeAllListeners(); currentBackend.stop(); }
          currentBackend = null;
          currentAppMeta = null;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('launcher.html');
        }
        return;
      }

      event.preventDefault();
      const trayAvailable = {{#tray_enabled}}true{{/tray_enabled}}{{^tray_enabled}}false{{/tray_enabled}};
      if (appSettings.launcherCloseAction === 'quit') {
        app.isQuitting = true;
        app.quit();
        return;
      }
      if (appSettings.launcherCloseAction === 'tray' && trayAvailable) {
        mainWindow.hide();
        return;
      }
      showLauncherCloseDialog();
      return;
    }

    {{#tray_enabled}}
    {{#close_to_tray}}
    if (!app.isQuitting && !isShuttingDown) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    {{/close_to_tray}}
    {{/tray_enabled}}
    {{^tray_enabled}}
    if (!isShuttingDown && !app.isQuitting && hasActiveStoreWork()) {
      event.preventDefault();
      confirmQuitWithActiveWork().then(function (ok) {
        if (!ok) return;
        isShuttingDown = true;
        app.isQuitting = true;
        var closeNow = function () { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); };
        if (appStore) { appStore.stopAll().catch(function () {}).then(closeNow); } else { closeNow(); }
      }).catch(function () { /* keep the window open if the dialog fails */ });
      return;
    }
    if (!isShuttingDown && serverRunning) {
      event.preventDefault();
      const { dialog } = require('electron');
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        title: 'Close {{{app_name_js}}}',
        message: 'Are you sure you want to quit?'
      });

      if (choice === 0) {
        isShuttingDown = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Wait until the lifecycle page has loaded and subscribed, then show
          // the headline and START the backend teardown there, so the backend's
          // own status (stopping container, removing container, ...) reaches the
          // renderer and is shown as a breakdown under "Closing application...".
          mainWindow.webContents.once('did-finish-load', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('lifecycle-status', {
                phase: 'shutting_down', message: 'Closing application...'
              });
            }
            if (currentBackend) {
              // Quit shortly after the backend reports teardown is complete;
              // the shutdown_timeout below is the hard fallback.
              const onExit = (d) => {
                if (d && d.phase === 'app_exit') {
                  currentBackend.removeListener('status', onExit);
                  setTimeout(() => app.quit(), 700);
                }
              };
              currentBackend.on('status', onExit);
              currentBackend.stop();
            } else {
              // No per-app backend is running (shinylive uses the shared
              // server, which is stopped in before-quit). Proceed immediately
              // instead of waiting the full shutdown_timeout.
              setTimeout(() => app.quit(), 0);
            }
          });
          loadLifecyclePage(mainWindow);
        } else if (currentBackend) {
          currentBackend.stop();
        }
        setTimeout(() => app.quit(), {{shutdown_timeout}});
      }
      return;
    }
    {{/tray_enabled}}
    if (!isShuttingDown) {
      isShuttingDown = true;
      if (currentBackend) currentBackend.stop();
      // Don't preventDefault -- let the window close immediately
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App event handlers
app.whenReady().then(() => {
  initLogging();
  installCrashHandlers();
  writeRootMarker();
  log('info', 'App starting');
  log('info', 'Version: {{{app_version_js}}}');
  log('info', 'App type: {{app_type}}');
  log('info', 'Backend: {{backend_module}}');
  log('info', 'Platform:', process.platform, process.arch);
  log('info', 'Preferred port: {{server_port}}');

  // The native About panel, which the macOS App menu opens, shows the same
  // metadata as Help > About. Electron shows credits on macOS and Windows,
  // and website and authors on Linux.
  app.setAboutPanelOptions({
    applicationName: '{{{app_name_js}}}',
    applicationVersion: '{{{app_version_js}}}',
    {{#has_app_copyright}}
    copyright: '{{{app_copyright_js}}}',
    {{/has_app_copyright}}
    {{#has_about_credits}}
    credits: [
      {{#has_app_description}}'{{{app_description_js}}}',{{/has_app_description}}
      {{#has_app_author}}'Author: {{{app_author_js}}}',{{/has_app_author}}
    ].join('\n'),
    {{/has_about_credits}}
    {{#has_app_homepage}}
    website: '{{{app_homepage_js}}}',
    {{/has_app_homepage}}
    {{#has_app_author}}
    authors: ['{{{app_author_js}}}'],
    {{/has_app_author}}
  });

  createWindow();

  // Start the CPU/RAM sampler after the window exists; it samples system-wide
  // figures always and the app process tree only while an app is running.
  startMetrics();

  {{#tray_enabled}}
  createTray();
  {{/tray_enabled}}

  {{#updates_enabled}}
  setupAutoUpdater();
  {{#check_on_startup}}
  // Check for updates after app is ready
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 3000);
  {{/check_on_startup}}
  {{/updates_enabled}}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      startMetrics();
    }
  });
});

app.on('window-all-closed', () => {
  if (currentBackend) currentBackend.stop();
  // Always quit when window closes -- keeping a Shiny server running
  // in the background with no window doesn't make sense.
  // (Tray-enabled apps handle this differently via close-to-tray.)
  app.quit();
});

// ---- Quit guard -------------------------------------------------------------
// Quitting the store must never silently kill a running app or an install in
// progress. Every quit path (menu Quit, tray Quit, the launcher's close dialog,
// the lifecycle error screen, window-all-closed) ends in app.quit(), so one
// before-quit handler covers them all. It is registered here, above the teardown
// handlers at the end of this file, so a cancelled quit leaves the session
// exactly as it was.
let quitConfirmed = false;    // the user accepted losing the listed work
let quitPromptOpen = false;   // the confirmation dialog is on screen

// What the user would lose by quitting: running apps and the store tasks that
// are still queued or installing. Labels are what the store shows, not ids.
function activeStoreWork() {
  var running = [];
  var installing = [];
  function pushName(list, label) {
    label = String(label || '').trim();
    if (label && list.indexOf(label) === -1) list.push(label);
  }
  function appName(id) {
    if (!id) return '';
    var meta = {};
    try { meta = appMetaFor(id) || {}; } catch (e) { meta = {}; }
    return meta.name || id;
  }
  if (appStore) {
    try {
      const st = appStore.getState() || {};
      const apps = st.apps || {};
      Object.keys(apps).forEach(function (id) {
        var up = false;
        try { up = appStore.isRunning(id); } catch (e) { up = false; }
        if (up) pushName(running, appName(id));
      });
    } catch (e) { /* state not ready yet: nothing to report */ }
  }
  // A start that is still in flight has no store handle yet, but its backend
  // process is just as much work to lose.
  if (launchingAppId) pushName(running, appName(launchingAppId));
  activeStoreTasks().forEach(function (t) {
    var label = String(t.displayName || t.appId || '').trim();
    if (!label) return;
    var verb = t.op === 'update_app' ? 'updating'
      : t.op === 'uninstall_app' ? 'uninstalling'
      : 'installing';
    if (typeof t.percent === 'number' && t.percent > 0) verb += ' ' + t.percent + '%';
    pushName(installing, label + ' (' + verb + ')');
  });
  return { running: running, installing: installing };
}
function hasActiveStoreWork() {
  var work = activeStoreWork();
  return !!(work.running.length || work.installing.length);
}
// Running and installing are reported separately: they need different words
// from the user ("stops" versus "cancels").
function activeStoreWorkDetail(work) {
  var rows = [];
  if (work.running.length) {
    rows.push('Running now:');
    work.running.forEach(function (n) { rows.push('  - ' + n); });
  }
  if (work.installing.length) {
    rows.push('Installing now:');
    work.installing.forEach(function (n) { rows.push('  - ' + n); });
  }
  return rows.join('\n');
}
// The dialog belongs to the app window when one is open, else the launcher.
function quitDialogParent() {
  if (appWindowAlive()) return appWindow;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}
// Lists the work in progress and asks for an explicit force-quit confirmation.
function confirmQuitWithActiveWork() {
  var work = activeStoreWork();
  var count = work.running.length + work.installing.length;
  if (!count) return Promise.resolve(true);
  const { dialog } = require('electron');
  var appTitle = shellDisplayName();
  var options = {
    type: 'warning',
    noLink: true,
    title: 'Quit ' + appTitle + '?',
    message: count === 1 ? '1 task is still in progress.' : count + ' tasks are still in progress.',
    detail: activeStoreWorkDetail(work) +
      '\n\nForce quitting stops the running apps, cancels the installs in progress and discards unsaved work.',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  };
  var parent = quitDialogParent();
  var answer = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  return answer.then(function (res) { return !!res && res.response === 0; })
    .catch(function () { return false; });
}
// Undo what the caller set before app.quit() so the store keeps running. If the
// last window is already gone, bring one back instead of leaving a windowless
// process the user cannot reach.
function restoreWindowAfterCancelledQuit() {
  isShuttingDown = false;
  app.isQuitting = false;
  if (mainWindow && !mainWindow.isDestroyed()) { showLauncherWindow(); return; }
  if (appWindowAlive()) { appWindow.show(); appWindow.focus(); return; }
  try { createWindow(); } catch (e) { log('warn', 'could not reopen the window after a cancelled quit:', e && e.message); }
}
// Confirmed force quit: abort installs first so their child processes and
// half-written directories are not abandoned, but never let a slow abort hold
// the quit - the process is going away either way.
function finishPendingQuit() {
  var aborted = null;
  try { aborted = cancelAllStoreTasks(); } catch (e) { aborted = null; }
  var cap = new Promise(function (resolve) { setTimeout(resolve, 3000); });
  var proceed = function () {
    try { if (appStore) appStore.stopAll(); } catch (e) { /* before-quit stops them too */ }
    app.isQuitting = true;
    app.quit();
  };
  if (aborted && typeof aborted.then === 'function') Promise.race([aborted, cap]).then(proceed, proceed);
  else proceed();
}
app.on('before-quit', function (event) {
  if (quitConfirmed || isShuttingDown) return;   // a confirmed shutdown is already under way
  if (!hasActiveStoreWork()) return;
  event.preventDefault();
  if (quitPromptOpen) return;
  quitPromptOpen = true;
  confirmQuitWithActiveWork().then(function (ok) {
    quitPromptOpen = false;
    if (!ok) { restoreWindowAfterCancelledQuit(); return; }
    quitConfirmed = true;
    finishPendingQuit();
  });
});

{{#tray_enabled}}
{{#close_to_tray}}
app.on('before-quit', (event) => {
  if (event && event.defaultPrevented) return;
  app.isQuitting = true;
});
{{/close_to_tray}}
{{/tray_enabled}}

app.on('before-quit', (event) => {
  if (event && event.defaultPrevented) return;
  // Quitting must not trigger the per-window "unsaved work" prompt.
  app.isQuitting = true;
  stopMetrics();
  if (currentBackend) currentBackend.stop();
  // The shared shinylive server is stopped ONLY here, at quit.
  stopSharedShinyliveServer();
});

// Multi-app: always stop running store apps on quit so no Shiny processes orphan.
app.on('before-quit', (event) => {
  if (event && event.defaultPrevented) return;
  if (appStore) { try { appStore.stopAll(); } catch (e) {} }
});
