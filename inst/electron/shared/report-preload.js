// Secure IPC bridge for report.html.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reportApi', {
  getPayload: () => ipcRenderer.invoke('report-get-payload'),
  action: (action, payload) => ipcRenderer.send('report-action', { action, payload }),
  copyText: (text) => ipcRenderer.send('report-copy-text', text),
  onStatus: (callback) => {
    ipcRenderer.on('report-status', (_event, data) => callback(data));
  }
});
