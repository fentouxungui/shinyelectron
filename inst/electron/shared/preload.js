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
