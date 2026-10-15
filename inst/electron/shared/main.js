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

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const backend = require('./backends/{{backend_module}}');
const { createAppStore, cmpVersion, platformKey } = require('./backends/appstore');

// File logging -- writes to configured log directory or app userData
const LOG_LEVEL = '{{{log_level_js}}}';
const SHELL_R_VERSION = '{{{r_version_js}}}';   // R version the shell bundles
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

// ---- Uninstall / reset ----------------------------------------------------
function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb >= 10) return Math.round(mb) + ' MB';
  return mb.toFixed(1) + ' MB';
}
function shellDisplayName() { return '{{{app_name_js}}}'; }
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
async function wipeAllLocalData() {
  if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
  closeAllLogs();
  const userData = app.getPath('userData');
  const targets = ['apps', 'lib', 'private', 'store-cache', 'state.json', 'settings.json', 'logs', 'crashes', 'window-state.json'];
  for (const t of targets) {
    try { fs.rmSync(path.join(userData, t), { recursive: true, force: true }); } catch (e) {}
  }
}
async function uninstallShinyApps() {
  const { dialog } = require('electron');
  const name = shellDisplayName();
  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning', noLink: true,
    title: 'Uninstall ' + name,
    message: 'Uninstall ' + name + '?',
    detail: 'Choose whether to also remove installed applications and all local data.',
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
  try {
    if (thorough) await wipeAllLocalData();
    else if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
  } catch (e) { log('warn', 'uninstall cleanup failed:', e && e.message); }
  const un = findUninstaller();
  if (un) {
    const { spawn } = require('child_process');
    try { const c = spawn(un, [], { detached: true, stdio: 'ignore' }); c.unref(); } catch (e) { log('error', 'uninstaller spawn failed:', e && e.message); }
    app.quit();
  } else {
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
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning', noLink: true,
    title: 'Reset local data',
    message: 'Remove all installed apps, shared packages, caches and logs?',
    detail: shellDisplayName() + ' stays installed. Your settings (e.g. catalog URL) are kept.',
    buttons: ['Reset', 'Cancel'], defaultId: 1, cancelId: 1
  });
  if (r.response !== 0) return;
  if (appStore) { try { await appStore.resetLocal(); } catch (e) { log('warn', 'reset failed:', e && e.message); } }
  closeAllLogs();
  const userData = app.getPath('userData');
  for (const t of ['logs', 'crashes']) {
    try { fs.rmSync(path.join(userData, t), { recursive: true, force: true }); } catch (e) {}
  }
  initLogging();   // re-open the shell log we just deleted
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
let appStore = null;
// Last loaded URL per catalog app id, so a still-running app can be re-opened.
var storeAppUrls = {};
// Single-flight guard: one install/update/uninstall at a time; extra requests
// are queued, and the running one can be cancelled via AbortController.
let storeBusy = false;
let storeController = null;
const storeQueue = [];

async function runStoreAction(actionType, storeId) {
  const sendStore = function (ev) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', Object.assign({ id: storeId }, ev)); };
  if (storeBusy) {
    storeQueue.push({ type: actionType, appId: storeId });
    sendStore({ state: 'queued', statusText: 'queued' });
    return;
  }
  storeBusy = true;
  storeController = new AbortController();
  const signal = storeController.signal;
  var lastProgAt = 0, lastProgPhase = '';
  const storeProg = function (pp) {
    var now = Date.now();
    if (pp.phase === lastProgPhase && now - lastProgAt < 100) return;
    lastProgAt = now; lastProgPhase = pp.phase;
    sendStore({ state: 'installing', op: actionType, percent: Math.round(pp.percent || 0), statusText: pp.statusText || pp.phase, step: pp.phase });
  };
  try {
    sendStore({ state: 'installing', op: actionType, statusText: 'working...' });
    if (actionType === 'install_app') await appStore.install(storeId, storeProg, signal);
    else if (actionType === 'update_app') await appStore.update(storeId, storeProg, signal);
    else await appStore.uninstall(storeId);
    if (actionType === 'uninstall_app' || actionType === 'update_app') delete storeAppUrls[storeId];
    sendStore({ state: 'done', op: actionType });
  } catch (e) {
    if (e && e.code === 'CANCELLED') sendStore({ state: 'error', op: actionType, error: 'Cancelled', cancelled: true, step: (e.step || '') });
    else sendStore({ state: 'error', op: actionType, error: (e && e.message) || String(e), step: (e && e.step) || '' });
  } finally {
    storeBusy = false;
    storeController = null;
    {{#menu_enabled}}
    createMenu();
    {{/menu_enabled}}
    var next = storeQueue.shift();
    if (next) runStoreAction(next.type, next.appId);
  }
}

// Per-app metadata for Help/About and the in-app update check. Set when an app
// is launched; reset to null on the launcher so Help/About show the shell.
let currentAppMeta = null;

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

// Launch an installed store app and reflect it in Help/About and the menu.
// Shared by the launcher's Run button path and the Apps > Quick Run menu.
async function runStoreApp(appId) {
  if (!appStore) return;
  if (storeBusy) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('store-status', { id: appId, state: 'busy', message: 'A store operation is in progress; please wait until it finishes.' });
    }
    return;
  }
  lastSelectedAppId = appId;
  try { await appStore.fetchCatalog(); } catch (e) { /* entry may already be cached */ }
  currentAppMeta = appMetaFor(appId);
  {{#menu_enabled}}
  createMenu();
  {{/menu_enabled}}
  var openUrl = appStore.isRunning(appId) ? storeAppUrls[appId] : null;
  if (openUrl && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(openUrl);   // already running: switch back, do not restart
  } else {
    try { await appStore.run(appId); } catch (e) { log('error', 'run_app failed:', e && e.message); }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', { id: appId, state: 'done' });
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
  const meta = currentAppMeta || {};
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
  // buttons[i] runs actions[i]; OK only closes the dialog.
  const buttons = ['OK'];
  const actions = [null];
  {{#updates_enabled}}
  // The shell's own check is offered on Windows/Linux (a Mac build ships only
  // a dmg, which electron-updater cannot update); while a catalog app runs it
  // targets that app instead, so it is offered on every platform.
  if (process.platform !== 'darwin' || currentAppMeta) {
    buttons.push(currentAppMeta ? 'Check for Updates' : 'Check for ShinyApps Updates');
    actions.push(checkForUpdatesInteractive);
  }
  {{/updates_enabled}}
  if (homepage) {
    buttons.push('Visit Website');
    actions.push(() => shell.openExternal(homepage));
  }
  if (email) {
    buttons.push('Email');
    actions.push(() => shell.openExternal('mailto:' + email));
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About ' + name,
    message: name,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 0,
    // Windows would otherwise show the extra buttons as command links.
    noLink: true
  });
  if (actions[response]) await actions[response]();
}

  // Return to the launcher: confirm first (unsaved analysis is discarded),
  // then wait for the backend to actually exit before showing the launcher.
  function leaveToLauncher() {
    if (!appsManifest) return;
    var cur = appsManifest.apps.find(function(a) { return a.id === lastSelectedAppId; });
    var curName = (cur && cur.name) || '{{{app_name_js}}}';

    var { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Leave app', 'Cancel'],
      defaultId: 1, cancelId: 1, noLink: true,
      title: 'Return to launcher',
      message: 'Return to the launcher?',
      detail: 'Any unsaved analysis in "' + curName + '" will be lost.'
    }).then(function(res) {
      if (res.response !== 0) return;
      currentAppMeta = null;
      if (currentBackend && currentBackend !== sharedShinyliveServer) {
        var b = currentBackend;
        currentBackend = null;            // prevent a double stop on a later action
        var settled = false;
        var finish = function() {
          if (settled) return; settled = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('launcher.html');
        };
        var fallback = setTimeout(function() { b.removeAllListeners(); finish(); }, {{shutdown_timeout}});
        b.on('status', function(d) {
          if (d && d.phase === 'app_exit') { clearTimeout(fallback); b.removeAllListeners(); finish(); }
        });
        b.stop();
      } else {
        currentBackend = null;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('launcher.html');
      }
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
    var m = appMetaFor(id) || {};
    items.push({ id: id, label: m.name || id });
  });
  items.sort(function (a, b) { return a.label.localeCompare(b.label); });
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
      label: 'Manage Apps\u2026' + (updates ? '  (' + updates + (updates > 1 ? ' updates' : ' update') + ')' : ''),
      accelerator: 'CmdOrCtrl+Shift+M',
      click: function () { openManagerFromMenu(updates ? 'updates' : 'installed'); }
    });
    sub.push({ type: 'separator' });
    sub.push({
      label: 'Install from bundle\u2026',
      click: function () {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('store-command', { cmd: 'install_bundle' });
        }
      }
    });
    sub.push({
      label: 'Settings\u2026',
      click: function () {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('store-command', { cmd: 'settings' });
        }
      }
    });
  } else {
    sub.push({
      label: 'Back to Launcher',
      accelerator: 'CmdOrCtrl+L',
      click: function () { leaveToLauncher(); }
    });
  }
  return sub;
}

// Open the launcher's manager on a given tab (deep link from the Apps menu).
function openManagerFromMenu(tab) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('store-command', { cmd: 'open_manager', tab: tab || 'installed' });
  }
}

// Rebuild the native menu only when something it shows actually changed
// (launcher/app context, installed set, or update count) -- not on every
// catalog refresh.
var lastMenuSig = '';
function menuSignature() {
  var ids = installedAppMenuItems().map(function (it) { return it.id; }).join(',');
  var updates = 0;
  try { updates = appStore ? appStore.checkUpdates().length : 0; } catch (e) { updates = 0; }
  return (isLauncherVisible ? 'L' : 'A') + '|' + ids + '|' + updates;
}
function refreshMenuIfChanged() {
  var sig = menuSignature();
  if (sig === lastMenuSig) return;
  createMenu();
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  // Multi-app: Help/About and the App menu reflect the running app.
  const meta = currentAppMeta;
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
        { label: 'Uninstall {{{app_name_js}}}\u2026', click: () => { uninstallShinyApps().catch((err) => log('error', 'uninstall failed:', err)); } },
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
    {
      label: 'Apps',
      submenu: buildAppsSubmenu()
    },
    {{/is_multi_app}}
    {
      label: 'Help',
      submenu: [
        {{#is_multi_app}}
        {
          label: 'Documentation',
          enabled: !!((meta && meta.docs) || '{{{help_url_js}}}'),
          click: async () => {
            const { shell } = require('electron');
            const url = (currentAppMeta && currentAppMeta.docs) || '{{{help_url_js}}}';
            if (url) await shell.openExternal(url);
          }
        },
        {{/is_multi_app}}
        {{^is_multi_app}}
        {{#has_help_url}}
        {
          label: 'Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        {{/has_help_url}}
        {{/is_multi_app}}
        {
          label: 'View Logs',
          click: () => {
            const { shell } = require('electron');
            shell.openPath(appLogRoot);
          }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            showAboutDialog().catch((err) => log('error', 'About dialog failed:', err));
          }
        },
        { type: 'separator' },
        { label: 'Reset local data\u2026', click: () => { resetLocalData().catch((err) => log('error', 'reset failed:', err)); } },
        { label: 'Uninstall {{{app_name_js}}}\u2026', click: () => { uninstallShinyApps().catch((err) => log('error', 'uninstall failed:', err)); } }
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
        { label: 'Uninstall {{{app_name_js}}}\u2026', click: () => { uninstallShinyApps().catch((err) => log('error', 'uninstall failed:', err)); } },
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
        { role: 'reload' },
        { role: 'forceReload' },
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
    {
      label: 'Apps',
      submenu: buildAppsSubmenu()
    },
    {{/is_multi_app}}
    {
      label: 'Help',
      submenu: [
        {{#is_multi_app}}
        {
          label: 'Documentation',
          enabled: !!((meta && meta.docs) || '{{{help_url_js}}}'),
          click: async () => {
            const { shell } = require('electron');
            const url = (currentAppMeta && currentAppMeta.docs) || '{{{help_url_js}}}';
            if (url) await shell.openExternal(url);
          }
        },
        {{/is_multi_app}}
        {{^is_multi_app}}
        {{#has_help_url}}
        {
          label: 'Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('{{{help_url_js}}}');
          }
        },
        {{/has_help_url}}
        {{/is_multi_app}}
        {
          label: 'View Logs',
          click: () => {
            const { shell } = require('electron');
            shell.openPath(appLogRoot);
          }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            showAboutDialog().catch((err) => log('error', 'About dialog failed:', err));
          }
        },
        { type: 'separator' },
        { label: 'Reset local data\u2026', click: () => { resetLocalData().catch((err) => log('error', 'reset failed:', err)); } },
        { label: 'Uninstall {{{app_name_js}}}\u2026', click: () => { uninstallShinyApps().catch((err) => log('error', 'uninstall failed:', err)); } }
      ]
    }
  ];
  {{/menu_minimal}}

  // The Apps menu is always present for multi-app builds; buildAppsSubmenu()
  // decides its contents (Quick Run / Manage Apps on the launcher, Back to
  // Launcher while an app runs).
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
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
  // Multi-app: while a catalog app runs, Check for Updates targets that app
  // (same source of truth as the launcher's Update button); on the launcher
  // it keeps checking the shell itself via electron-updater.
  if (currentAppMeta && appStore) {
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

  // Stop the running app and return to the launcher, then update; the launcher
  // card shows progress and any failure via store-status.
  if (currentBackend && currentBackend !== sharedShinyliveServer) {
    const b = currentBackend;
    currentBackend = null;
    try { b.removeAllListeners(); await b.stop(); } catch (e) { /* best effort */ }
  } else {
    currentBackend = null;
  }
  currentAppMeta = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('launcher.html');

  const sendStore = function (ev) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', Object.assign({ id: id }, ev)); };
  const onProg = function (pp) { sendStore({ state: 'installing', percent: Math.round(pp.percent || 0), statusText: pp.statusText || pp.phase, step: pp.phase }); };
  try {
    sendStore({ state: 'installing', statusText: 'working...' });
    await appStore.update(id, onProg);
    sendStore({ state: 'done', op: 'update_app' });
  } catch (err) {
    sendStore({ state: 'error', error: (err && err.message) || String(err), step: (err && err.step) || '' });
  }
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

  // --- App store wiring (multi-app) -------------------------------------
  function storeStartBackend(opts) {
    return new Promise(function (resolve, reject) {
      if (currentBackend && currentBackend !== sharedShinyliveServer) {
        currentBackend.removeAllListeners();
        currentBackend.stop();
      }
      currentBackend = getBackendForApp('r-shiny', 'bundled');
      openAppLog(opts.appId);
      currentBackend.on('status', function (data) {
        appLogWrite('[' + data.phase + '] ' + (data.message || ''));
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lifecycle-status', data);
        if (data.phase === 'server_ready') serverRunning = true;
        if (data.phase === 'stopping_server' || data.phase === 'error' || data.phase === 'server_crashed') serverRunning = false;
      });
      currentBackend.on('output', function (o) { appLogWrite((o && o.stream ? o.stream : 'out') + ': ' + ((o && o.line) || '')); });
      currentBackend.on('error', function (err) {
        appLogWrite('[error] ' + (err && err.message ? err.message : err));
        log('error', 'store backend error:', err && err.message ? err.message : err);
      });
      // Clear the store running flag whenever the backend actually exits
      // (e.g. after Back to Launcher stops it), so the launcher shows Run again.
      currentBackend.on('status', function (d) {
        if (d && d.phase === 'app_exit') { appLogWrite('[app_exit]'); closeAppLog(); }
        if (d && d.phase === 'app_exit' && appStore) appStore.stop(opts.appId).catch(function () {});
      });
      lastSelectedAppId = opts.appId;
      mainWindow.loadFile('lifecycle.html');
      var b = currentBackend;
      b.start({
        appPath: opts.appPath,
        port: port,
        config: Object.assign({}, {{{backend_config_json}}}, {
          app_type: 'r-shiny',
          app_id: opts.appId,
          runtime_strategy: 'bundled',
          extra_lib_paths: opts.libPaths
        })
      }).then(function (result) {
        actualPort = result.port;
        storeAppUrls[opts.appId] = 'http://localhost:' + actualPort;
        mainWindow.loadURL('http://localhost:' + actualPort);
        resolve({
          stop: function () {
            return new Promise(function (done) {
              var onExit = function (d) { if (d && d.phase === 'app_exit') { b.removeListener('status', onExit); done(); } };
              b.on('status', onExit);
              b.stop();
              setTimeout(done, 120000);
            });
          }
        });
      }).catch(reject);
    });
  }

  if (appsManifest) {
    appStore = createAppStore({
      dataRoot: resolveDataRoot(),
      catalogUrl: appSettings.catalogUrl || DEFAULT_CATALOG_URL,
      startBackend: storeStartBackend,
      shellVersion: '{{{app_version_js}}}',
      shellRVersion: SHELL_R_VERSION,
      log: function (m) { log('info', '[store]', m); }
    });
    ipcMain.handle('store-list', async () => {
      // Force a fresh catalog so a newly registered app appears without restarting.
      let cat;
      try {
        cat = await appStore.fetchCatalog({ force: true });
      } catch (e) {
        // Offline / catalog outage: fall back to the cached catalog (or none)
        // so installed and sideloaded apps stay visible and runnable.
        log('warn', 'catalog fetch failed; using cached/installed data:', e && e.message);
        cat = appStore.getCatalog() || { apps: [] };
      }
      const st = appStore.getState();
      {{#menu_enabled}}
      refreshMenuIfChanged();   // keep the Apps menu (update count / Quick Run) fresh
      {{/menu_enabled}}
      const plat = platformKey();
      const list = cat.apps.map((a) => {
        const ins = st.apps[a.id];
        // Only a platform with a published bundle can be installed/updated here.
        const art = a.artifacts && a.artifacts[plat];
        const platformOk = !a.artifacts || !!art;
        const incompatible = !!(
          (SHELL_R_VERSION && a.r_version && cmpVersion(SHELL_R_VERSION, a.r_version) < 0) ||
          (a.min_shell_version && cmpVersion('{{{app_version_js}}}', a.min_shell_version) < 0)
        );
        return {
          id: a.id, name: a.name, description: a.description, icon: a.icon, author: a.author || '',
          homepage: a.homepage || a.homepage_url || a.url || '',
          catalogVersion: a.version,
          installed: !!ins, installedVersion: ins ? ins.version : null,
          updateAvailable: !!ins && cmpVersion(a.version, ins.version) > 0 && platformOk && !incompatible,
          running: appStore.isRunning(a.id),
          tags: Array.isArray(a.tags) ? a.tags : [],
          available: platformOk,
          size: (art && art.size) || 0,
          license: a.license || '',
          rVersion: a.r_version || '',
          minShellVersion: a.min_shell_version || '',
          incompatible: incompatible,
          state: ins ? 'installed' : 'not-installed'
        };
      });
      // Append sideloaded apps: installed ids that are not in the catalog.
      const catIds = {};
      cat.apps.forEach((a) => { catIds[a.id] = true; });
      Object.keys(st.apps).forEach((id) => {
        if (catIds[id]) return;
        const lins = st.apps[id];
        const lm = (lins && lins.meta) || {};
        list.push({
          id: id, name: lm.name || id, description: lm.description || '', icon: '', author: lm.author || '',
          homepage: lm.homepage || '',
          catalogVersion: (lins && lins.version) || null,
          installed: true, installedVersion: (lins && lins.version) || null,
          updateAvailable: false,
          running: appStore.isRunning(id),
          tags: [], available: true, size: 0,
          license: lm.license || '', rVersion: lm.rVersion || '',
          minShellVersion: '', incompatible: false,
          local: !!(lins && lins.source === 'local'),
          state: 'installed'
        });
      });
      return list;
    });
  }

  ipcMain.handle('copy-diagnostics', async (_event, appId) => {
    try {
      const { clipboard } = require('electron');
      const os = require('os');
      const id = appId || lastSelectedAppId || null;
      const ins = (id && appStore) ? appStore.getState().apps[id] : null;
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
    try { return await appStore.usage(); }
    catch (e) { log('warn', 'store-usage failed:', e && e.message); return null; }
  });

  ipcMain.handle('store-cleanup', async () => {
    if (!appStore) return { freed: 0 };
    if (storeBusy) return { freed: 0, busy: true };
    storeBusy = true;
    try { return await appStore.cleanup(); }
    catch (e) { log('warn', 'store-cleanup failed:', e && e.message); return { freed: 0, error: String((e && e.message) || e) }; }
    finally {
      storeBusy = false;
      const nq = storeQueue.shift();
      if (nq) runStoreAction(nq.type, nq.appId);
    }
  });

  ipcMain.handle('store-disk-free', async () => {
    if (!appStore) return null;
    try { return await appStore.getDiskFree(); }
    catch (e) { return null; }
  });

  ipcMain.handle('get-settings', async () => ({
    catalogUrl: appSettings.catalogUrl || DEFAULT_CATALOG_URL,
    defaultCatalogUrl: DEFAULT_CATALOG_URL,
    crashReporting: !!appSettings.crashReporting,
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

  ipcMain.handle('set-crash-reporting', async (_event, on) => {
    appSettings.crashReporting = !!on;
    saveSettings();
    if (appSettings.crashReporting) installCrashHandlers();
    return { ok: true, crashReporting: !!appSettings.crashReporting };
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
    if (path.resolve(target) === path.resolve(cur)) return { ok: false, message: 'That is already the current location.' };
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
    sendBusy({ state: 'installing', statusText: 'Moving data to ' + target + '\u2026' });
    try {
      if (appStore) { try { await appStore.stopAll(); } catch (e) {} }
      await fsp.mkdir(target, { recursive: true });
      if (migrate) {
        for (const it of ['apps', 'lib', 'private', 'store-cache', 'state.json']) {
          const src = path.join(cur, it);
          if (!fs.existsSync(src)) continue;
          await fsp.cp(src, path.join(target, it), { recursive: true, force: true });
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
  mainWindow.loadFile('lifecycle.html');
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
    mainWindow.loadFile('lifecycle.html');

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
      mainWindow.loadURL('http://localhost:' + actualPort);
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

    mainWindow.loadFile('lifecycle.html');
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
        if (lastSelectedAppId) {
          startSelectedApp(lastSelectedAppId);
        } else {
          mainWindow.loadFile('launcher.html');
        }
      } else {
        mainWindow.loadFile('lifecycle.html');
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

    } else if (actionType === 'back_to_launcher') {
      leaveToLauncher();

    } else if (actionType === 'install_app' || actionType === 'uninstall_app' || actionType === 'update_app') {
      if (!appStore) return;
      await runStoreAction(actionType, action.appId);

    } else if (actionType === 'cancel_store') {
      if (storeController) storeController.abort();

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
      const sendBundle = function (ev) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', Object.assign({ id: '__bundle__' }, ev)); };
      if (storeBusy) { sendBundle({ state: 'busy', message: 'Another operation is in progress; please wait until it finishes.' }); return; }
      storeBusy = true;
      try {
        sendBundle({ state: 'installing', statusText: 'reading bundle\u2026' });
        const confirmBundle = async function (m) {
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
        let lastProgAt = 0;
        let lastProgPhase = '';
        const onProg = function (pp) {
          const now = Date.now();
          if (pp.phase === lastProgPhase && now - lastProgAt < 100) return;
          lastProgAt = now;
          lastProgPhase = pp.phase;
          sendBundle({ state: 'installing', percent: Math.round(pp.percent || 0), statusText: pp.statusText || pp.phase, step: pp.phase });
        };
        if (bundleUrl) await appStore.installFromUrl(bundleUrl, { onProgress: onProg, confirm: confirmBundle });
        else await appStore.installFromFile(bundlePath, { onProgress: onProg, confirm: confirmBundle });
        sendBundle({ state: 'done', op: 'install_bundle' });
      } catch (e) {
        if (!(e && e.cancelled)) sendBundle({ state: 'error', error: (e && e.message) || String(e), step: (e && e.step) || '' });
        else sendBundle({ state: 'done' });
      } finally {
        storeBusy = false;
        // A bundle install also owns storeBusy: run anything that queued behind it.
        const nextQueued = storeQueue.shift();
        if (nextQueued) runStoreAction(nextQueued.type, nextQueued.appId);
      }
      {{#menu_enabled}}
      createMenu();
      {{/menu_enabled}}

    } else if (actionType === 'run_app') {
      await runStoreApp(action.appId);

    } else if (actionType === 'open_app') {
      // Re-open a still-running app without restarting it.
      if (!appStore) return;
      if (storeBusy) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('store-status', { id: action.appId, state: 'busy', message: 'A store operation is in progress; please wait until it finishes.' });
        }
        return;
      }
      lastSelectedAppId = action.appId;
      currentAppMeta = appMetaFor(action.appId);
      {{#menu_enabled}}
      createMenu();
      {{/menu_enabled}}
      var openUrl = storeAppUrls[action.appId];
      if (openUrl && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(openUrl);
      } else {
        await runStoreApp(action.appId);
      }

    } else if (actionType === 'stop_app') {
      if (!appStore) return;
      try { await appStore.stop(action.appId); } catch (e) { log('error', 'stop_app failed:', e && e.message); }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('store-status', { id: action.appId, state: 'done' });
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
          mainWindow.loadFile('lifecycle.html');
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

{{#tray_enabled}}
{{#close_to_tray}}
app.on('before-quit', () => {
  app.isQuitting = true;
});
{{/close_to_tray}}
{{/tray_enabled}}

app.on('before-quit', () => {
  if (currentBackend) currentBackend.stop();
  // The shared shinylive server is stopped ONLY here, at quit.
  stopSharedShinyliveServer();
});
