// Preload for the tab bar ONLY. The AI tabs themselves get no preload
// and no Node access — they are just the services' normal websites.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  list: (callback) => ipcRenderer.on('tabs-list', (_event, tabs) => callback(tabs)),
  onActive: (callback) => ipcRenderer.on('active-tab', (_event, tabId) => callback(tabId)),
  onAddError: (callback) => ipcRenderer.on('add-tab-error', (_event, message) => callback(message)),
  switchTo: (tabId) => ipcRenderer.send('switch-tab', tabId),
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),
  add: (label, url) => ipcRenderer.send('add-tab', { label, url }),
  remove: (tabId) => ipcRenderer.send('remove-tab', tabId),
  reload: () => ipcRenderer.send('reload-tab'),
  back: () => ipcRenderer.send('go-back'),
  forward: () => ipcRenderer.send('go-forward'),
});
