// Secure IPC bridge for lifecycle.html and launcher.html
const { contextBridge, ipcRenderer } = require('electron');

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
  installApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'install_app', appId }),
  uninstallApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'uninstall_app', appId }),
  updateApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'update_app', appId }),
  runApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'run_app', appId }),
  stopApp: (appId) => ipcRenderer.send('lifecycle-action', { type: 'stop_app', appId }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
