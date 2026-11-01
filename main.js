// Multi-AI Tabs v1.1 — one window, one tab per AI account.
//
// HOW IT WORKS (the important part):
// Each tab runs in its own Electron session "partition" (persist:<name>).
// A partition is a separate cookie jar: signing into Muse in the
// "muse-main" partition does NOT sign you out of Muse in the
// "muse-sandbox" partition, and vice versa. That is what kills the
// incognito dance — both accounts stay signed in, permanently, and
// switching is just clicking a tab. Sessions are stored on your PC
// under Electron's userData folder, nowhere else.
//
// BUILT-IN TABS (always present, cannot be removed):
//   Their id and partition names NEVER change — changing a partition
//   name would make that tab forget its login.
// CUSTOM TABS (added with the + Add Tab button in the app):
//   Saved in custom-tabs.json inside Electron's userData folder, so
//   they survive closing and reopening the app. A custom tab's
//   partition is derived from its name, so adding a tab with the
//   same name again later restores its old login. Removing a custom
//   tab only hides it from the tab bar — its login data stays on
//   disk until you add it back or delete the app data yourself.

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_TABS = [
  { id: 'muse-main',    label: 'Muse (Main)',    url: 'https://muse.ai/',            partition: 'persist:muse-main', custom: false },
  { id: 'muse-sandbox', label: 'Muse (Sandbox)', url: 'https://muse.ai/',            partition: 'persist:muse-sandbox', custom: false },
  { id: 'chatgpt',       label: 'ChatGPT',        url: 'https://chatgpt.com/',        partition: 'persist:chatgpt', custom: false },
  { id: 'gemini',        label: 'Gemini',         url: 'https://gemini.google.com/',  partition: 'persist:gemini', custom: false },
  { id: 'copilot',       label: 'Copilot',        url: 'https://copilot.microsoft.com/', partition: 'persist:copilot', custom: false },
];

const TABBAR_HEIGHT = 52;

let win = null;
let tabbarView = null;
let activeTabId = null;
const contentViews = new Map(); // tab id -> WebContentsView

function customTabsPath() {
  return path.join(app.getPath('userData'), 'custom-tabs.json');
}

function loadCustomTabs() {
  try {
    const raw = fs.readFileSync(customTabsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => t && t.id && t.label && t.url && t.partition);
  } catch {
    return []; // first run, or a corrupt file: start with no custom tabs
  }
}

function saveCustomTabs(tabs) {
  try {
    fs.writeFileSync(customTabsPath(), JSON.stringify(tabs, null, 2), 'utf8');
  } catch {
    // If saving fails, the tab still works for this session; it just
    // won't be there next time. Nothing else breaks.
  }
}

let customTabs = [];
function allTabs() {
  return [...DEFAULT_TABS, ...customTabs];
}

function sendTabsList() {
  if (tabbarView) {
    tabbarView.webContents.send(
      'tabs-list',
      allTabs().map(({ id, label, custom }) => ({ id, label, custom }))
    );
  }
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tab';
}

function layout() {
  if (!win) return;
  const bounds = win.getContentBounds();
  if (tabbarView) tabbarView.setBounds({ x: 0, y: 0, width: bounds.width, height: TABBAR_HEIGHT });
  const active = contentViews.get(activeTabId);
  if (active) {
    active.setBounds({ x: 0, y: TABBAR_HEIGHT, width: bounds.width, height: bounds.height - TABBAR_HEIGHT });
  }
}

function switchTab(tabId) {
  const tab = allTabs().find((t) => t.id === tabId);
  if (!tab || !win) return;

  const previous = contentViews.get(activeTabId);
  if (previous && previous !== contentViews.get(tabId)) {
    win.contentView.removeChildView(previous);
  }

  let view = contentViews.get(tabId);
  if (!view) {
    view = new WebContentsView({
      webPreferences: {
        partition: tab.partition,
        contextIsolation: true,
        sandbox: true,
        // No preload, no Node in the AI tabs on purpose: the tab is
        // just that service's normal website, nothing else.
      },
    });
    view.webContents.loadURL(tab.url);
    contentViews.set(tabId, view);
  }

  if (!win.contentView.children.includes(view)) {
    win.contentView.addChildView(view);
  }
  activeTabId = tabId;
  layout();
  if (tabbarView) tabbarView.webContents.send('active-tab', tabId);
}

function createWindow() {
  customTabs = loadCustomTabs();

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Multi-AI Tabs',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // the tab bar view needs IPC; the AI tabs themselves are sandboxed above
    },
  });

  tabbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.contentView.addChildView(tabbarView);
  tabbarView.webContents.loadFile(path.join(__dirname, 'tabbar.html'));

  ipcMain.on('switch-tab', (_event, tabId) => switchTab(tabId));

  ipcMain.on('add-tab', (event, { label, url }) => {
    const cleanLabel = String(label || '').trim();
    let cleanUrl = String(url || '').trim();
    if (!cleanLabel || !cleanUrl) {
      event.sender.send('add-tab-error', 'Give the tab a name and a website address.');
      return;
    }
    if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
    let parsed;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      event.sender.send('add-tab-error', 'That website address does not look valid.');
      return;
    }
    if (parsed.protocol !== 'https:') {
      event.sender.send('add-tab-error', 'Use an https:// address so your login stays secure.');
      return;
    }
    const id = 'custom-' + slugify(cleanLabel);
    if (allTabs().some((t) => t.id === id)) {
      event.sender.send('add-tab-error', 'A tab with that name already exists. Pick a different name.');
      return;
    }
    const tab = { id, label: cleanLabel, url: parsed.toString(), partition: 'persist:' + id, custom: true };
    customTabs.push(tab);
    saveCustomTabs(customTabs);
    sendTabsList();
    switchTab(id);
  });

  ipcMain.on('remove-tab', (_event, tabId) => {
    const tab = customTabs.find((t) => t.id === tabId);
    if (!tab) return; // built-in tabs cannot be removed
    customTabs = customTabs.filter((t) => t.id !== tabId);
    saveCustomTabs(customTabs);
    const view = contentViews.get(tabId);
    if (view) {
      win.contentView.removeChildView(view);
      contentViews.delete(tabId);
    }
    sendTabsList();
    if (activeTabId === tabId) switchTab(allTabs()[0].id);
    // Note: the tab's login data stays on disk under its partition,
    // so adding a tab with the same name again restores its login.
  });

  ipcMain.on('reload-tab', () => {
    const view = contentViews.get(activeTabId);
    if (view) view.webContents.reload();
  });
  ipcMain.on('go-back', () => {
    const view = contentViews.get(activeTabId);
    if (view && view.webContents.canGoBack()) view.webContents.goBack();
  });
  ipcMain.on('go-forward', () => {
    const view = contentViews.get(activeTabId);
    if (view && view.webContents.canGoForward()) view.webContents.goForward();
  });

  tabbarView.webContents.on('did-finish-load', () => {
    sendTabsList();
    switchTab(allTabs()[0].id);
  });

  win.on('resize', layout);
  win.on('closed', () => {
    win = null;
    tabbarView = null;
    activeTabId = null;
    contentViews.clear();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
