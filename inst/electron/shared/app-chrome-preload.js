// Secure IPC bridge for the app window's slim toolbar (app-chrome.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appChrome', {
  info: () => ipcRenderer.invoke('app-window-info'),
  onStatus: (callback) => {
    ipcRenderer.on('app-chrome-status', (_event, data) => callback(data));
  },
  store: () => ipcRenderer.send('lifecycle-action', { type: 'show_store' }),
  stop: (appId) => ipcRenderer.send('lifecycle-action', { type: 'stop_app', appId })
});
