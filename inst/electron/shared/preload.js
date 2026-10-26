// Secure IPC bridge for lifecycle.html and launcher.html
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lifecycle', {
  // lifecycle page
  onStatus: (callback) => {
    ipcRenderer.on('lifecycle-status', (_event, data) => callback(data));
  },
  retry: () => ipcRenderer.send('lifecycle-action', { type: 'retry' }),
  quit: () => ipcRenderer.send('lifecycle-action', { type: 'quit' }),
  install: (data) => ipcRenderer.send('lifecycle-action', { type: 'install', ...data }),
  skipInstall: () => ipcRenderer.send('lifecycle-action', { type: 'skip_install' }),
  selectRuntime: (data) => ipcRenderer.send('lifecycle-action', { type: 'select_runtime', ...data }),
  selectApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'select_app', appId }),
  backToLauncher: () => ipcRenderer.send('lifecycle-action', { type: 'back_to_launcher' }),

  // app store (launcher.html)
  listApps: () => ipcRenderer.invoke('store-list'),
  onStoreStatus: (callback) => {
    ipcRenderer.on('store-status', (_event, data) => callback(data));
  },
  onStoreCommand: (callback) => {
    ipcRenderer.on('store-command', (_event, data) => callback(data));
  },
  installApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'install_app', appId }),
  uninstallApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'uninstall_app', appId }),
  updateApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'update_app', appId }),
  runApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'run_app', appId }),
  stopApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'stop_app', appId }),
  openApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'open_app', appId }),
  installFromFile: (path) => ipcRenderer.send('lifecycle-action', { type: 'install_bundle', path }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openAppLog: (appId) => ipcRenderer.invoke('open-app-log', appId),
  openAppFolder: (appId) => ipcRenderer.invoke('open-app-folder', appId),
  cancelInstall: () => ipcRenderer.send('lifecycle-action', { type: 'cancel_store' }),
  copyDiagnostics: (appId) => ipcRenderer.invoke('copy-diagnostics', appId),
  getUsage: () => ipcRenderer.invoke('store-usage'),
  cleanupStorage: () => ipcRenderer.invoke('store-cleanup'),
  getDiskFree: () => ipcRenderer.invoke('store-disk-free'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setCatalogUrl: (url) => ipcRenderer.invoke('set-catalog-url', url),
  setCrashReporting: (on) => ipcRenderer.invoke('set-crash-reporting', on),
  installFromUrl: (url) => ipcRenderer.send('lifecycle-action', { type: 'install_bundle', url }),
  changeDataRoot: () => ipcRenderer.invoke('change-data-root'),
  resetLocalData: () => ipcRenderer.invoke('reset-local-data'),
  uninstallShell: () => ipcRenderer.invoke('uninstall-shinyapps'),
  openDataRoot: () => ipcRenderer.invoke('open-data-root'),
  setQuickRunOrder: (data) => ipcRenderer.send('quick-run-order', data),
  notifyTheme: (mode) => ipcRenderer.send('theme-changed', mode)
});

// --- CPU / RAM overlay (app pages only) -----------------------------------
// The main process samples system totals and the running app's process tree
// and pushes them here. Only pages served by the app backend (http/https) get
// the overlay; the shell's own file:// pages (launcher, lifecycle) never do.
(function installMetricsOverlay() {
  let isAppPage = false;
  try { isAppPage = location.protocol === 'http:' || location.protocol === 'https:'; } catch (e) { /* about:blank */ }
  if (!isAppPage) return;

  let overlay = null;
  const fmtGB = (bytes) => (Number(bytes || 0) / 1073741824).toFixed(1) + ' GB';

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__shinyelectron_metrics';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
      'padding:6px 10px', 'border-radius:8px', 'background:rgba(15,23,42,0.78)',
      'color:#f8fafc', 'font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
      'pointer-events:none', 'white-space:pre', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)'
    ].join(';');
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  ipcRenderer.on('app-metrics', (_event, m) => {
    try {
      if (!m) return;
      if (!m.enabled) { if (overlay) overlay.style.display = 'none'; return; }
      if (!m.system) return;
      const node = ensureOverlay();
      node.style.display = '';
      const lines = [
        'CPU ' + Math.round(m.system.cpu) + '%   RAM ' + fmtGB(m.system.memUsed) + ' / ' + fmtGB(m.system.memTotal)
      ];
      if (m.app) {
        const appCpu = m.app.cpu < 10 ? m.app.cpu.toFixed(1) : String(Math.round(m.app.cpu));
        lines.push('app  CPU ' + appCpu + '%   ' + fmtGB(m.app.mem));
      }
      node.textContent = lines.join('\n');
    } catch (e) { /* the overlay is best-effort */ }
  });
})();
