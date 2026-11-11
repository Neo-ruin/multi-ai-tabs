// Preload for the Watchtower sidebar ONLY. It shows tab names, status
// lights, and times — never chat content — and asks the main process
// to switch tabs, collapse the sidebar, or flip alerts on/off.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('watchtower', {
  onUpdate: (callback) => ipcRenderer.on('watchtower-update', (_event, data) => callback(data)),
  jump: (tabId) => ipcRenderer.send('watchtower-jump', tabId),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  toggleAlerts: () => ipcRenderer.send('toggle-alerts'),
});
