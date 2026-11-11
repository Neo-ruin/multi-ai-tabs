// Multi-AI Tabs v2.0 — one window, one tab per AI account.
//
// v1: separate login partition per tab, click to switch, no incognito.
// v2 adds two things, both local-only, no accounts, no telemetry:
//   1. Right-click menus in every tab (Cut / Copy / Paste / Paste as
//      plain text / spellcheck suggestions / image and link actions).
//      Electron ships no right-click menu in a WebContentsView, and v1
//      never built one — that is why right-click did nothing at all.
//   2. The Watchtower: a collapsible sidebar showing one row per tab
//      with an honest status light (Working / Done / Idle / Unknown /
//      Needs attention). Status is observed WITHOUT injecting anything
//      into the AI tabs — only what Electron already exposes from the
//      main process (page loads, title changes, network activity on
//      the tab's session, errors). The tabs stay exactly the services'
//      normal websites, untouched.
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
//
// WATCHTOWER STATES (coarse but honest — no false precision):
//   working   — the tab has had network activity running for over
//               ~1.5s, or is loading a page. Short requests (pings,
//               heartbeats) never trigger this.
//   done      — it WAS working and the activity ended, and you have
//               not looked at the tab yet. "Done — check it."
//   idle      — quiet, and you have seen its latest state.
//   unknown   — no activity observed yet (fresh tab, never loaded).
//   attention — the page failed to load, crashed, or stopped
//               responding, OR the site tried to send you a
//               notification (an approval waiting, a reply ready).
//               Cleared when you look at the tab.
// "Waiting on you" is only ever shown where an outside signal
// supports it — a finished tab you have not viewed (done), an
// error, or a notification attempt (attention). The app never
// guesses at message contents.

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, MenuItem, Notification, clipboard, session } = require('electron');
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
const SIDEBAR_WIDTH = 232;      // expanded Watchtower
const SIDEBAR_COLLAPSED = 40;   // collapsed: status lights only
const WORKING_AFTER_MS = 1500;  // a request must run this long to count as "working"

let win = null;
let tabbarView = null;
let sidebarView = null;
let activeTabId = null;
const contentViews = new Map(); // tab id -> WebContentsView

// ---------------------------------------------------------------- settings
// Small JSON file next to custom-tabs.json. Alerts are ON by default
// (Angelo's call); the off switch in the sidebar stays off once set.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      alertsEnabled: parsed.alertsEnabled !== false, // default ON
    };
  } catch {
    return { sidebarCollapsed: false, alertsEnabled: true };
  }
}

let settings = { sidebarCollapsed: false, alertsEnabled: true };

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    // Settings just don't stick this time; the app keeps working.
  }
}

// ---------------------------------------------------------------- tabs list
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

// Add a custom tab from a name + URL. Shared by the + Add Tab form and
// by "Open link in new tab" in the right-click menu. Returns the tab,
// or null when the URL is not usable.
function addCustomTab(label, url) {
  const cleanLabel = String(label || '').trim();
  let cleanUrl = String(url || '').trim();
  if (!cleanLabel || !cleanUrl) return null;
  if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const id = 'custom-' + slugify(cleanLabel);
  const existing = allTabs().find((t) => t.id === id);
  if (existing) return existing; // already there: just switch to it
  const tab = { id, label: cleanLabel, url: parsed.toString(), partition: 'persist:' + id, custom: true };
  customTabs.push(tab);
  saveCustomTabs(customTabs);
  sendTabsList();
  return tab;
}

function openLinkInNewTab(url) {
  let label = 'Link';
  try {
    label = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep the fallback label
  }
  const tab = addCustomTab(label, url);
  if (tab) switchTab(tab.id);
}

// ---------------------------------------------------------------- layout
function sidebarWidth() {
  return settings.sidebarCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH;
}

function layout() {
  if (!win) return;
  const bounds = win.getContentBounds();
  if (tabbarView) tabbarView.setBounds({ x: 0, y: 0, width: bounds.width, height: TABBAR_HEIGHT });
  const sw = sidebarWidth();
  if (sidebarView) {
    sidebarView.setBounds({ x: 0, y: TABBAR_HEIGHT, width: sw, height: bounds.height - TABBAR_HEIGHT });
  }
  const active = contentViews.get(activeTabId);
  if (active) {
    active.setBounds({ x: sw, y: TABBAR_HEIGHT, width: bounds.width - sw, height: bounds.height - TABBAR_HEIGHT });
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
    view = createTabView(tab);
    contentViews.set(tabId, view);
  }

  if (!win.contentView.children.includes(view)) {
    win.contentView.addChildView(view);
  }
  activeTabId = tabId;
  // Looking at a tab marks its finished work as seen.
  const activity = tabActivity.get(tabId);
  if (activity && activity.state === 'done') {
    activity.state = 'idle';
  }
  layout();
  if (tabbarView) tabbarView.webContents.send('active-tab', tabId);
  sendWatchtowerUpdate();
}

// ------------------------------------------------------- right-click menu
// Electron ships NO right-click menu in a WebContentsView. This builds
// one from what was clicked. Where the website itself implements a
// custom menu, the page wins and this never fires — that is the
// browser's own rule, not ours.
function showContextMenu(wc, params) {
  const template = [];
  const edit = params.editFlags || {};

  // Spellcheck first: suggestions for the red-underlined word, then
  // Add to dictionary (saved in the app data, survives restarts).
  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions || [];
    suggestions.slice(0, 5).forEach((word) => {
      template.push({
        label: word,
        click: () => wc.replaceMisspelling(word),
      });
    });
    if (suggestions.length) template.push({ type: 'separator' });
    template.push({
      label: 'Add to dictionary',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    template.push({ type: 'separator' });
  }

  if (params.isEditable) {
    template.push({ label: 'Cut', role: 'cut', enabled: !!edit.canCut });
    template.push({ label: 'Copy', role: 'copy', enabled: !!edit.canCopy });
    // Paste covers text AND images: Chromium pastes whatever the
    // clipboard holds into the focused box. This is the fix for
    // pasting text or a picture into a chat box.
    template.push({ label: 'Paste', role: 'paste', enabled: !!edit.canPaste });
    template.push({ label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: !!edit.canPaste });
    template.push({ label: 'Select all', role: 'selectAll', enabled: !!edit.canSelectAll });
  } else if (params.selectionText) {
    template.push({ label: 'Copy', role: 'copy', enabled: !!edit.canCopy });
  }

  if (params.linkURL) {
    template.push({ type: 'separator' });
    template.push({ label: 'Open link in new tab', click: () => openLinkInNewTab(params.linkURL) });
    template.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    template.push({ type: 'separator' });
    template.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    template.push({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
    template.push({ label: 'Open image in new tab', click: () => openLinkInNewTab(params.srcURL) });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() });
  template.push({ label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() });
  template.push({ label: 'Reload', click: () => wc.reload() });
  template.push({ type: 'separator' });
  template.push({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) });

  Menu.buildFromTemplate(template).popup({ window: win });
}

// ------------------------------------------------------------- watchtower
// Per-tab activity, observed from the main process only. No code is
// ever injected into the AI tabs.
const tabActivity = new Map(); // tab id -> { state, inflight, timer, loadedOnce, lastActivity, lastDoneAt }
const hookedSessions = new Set(); // partitions already being watched

function activityFor(tabId) {
  let a = tabActivity.get(tabId);
  if (!a) {
    a = { state: 'unknown', inflight: 0, timer: null, loadedOnce: false, lastActivity: null, lastStartAt: null, lastDoneAt: null };
    tabActivity.set(tabId, a);
  }
  return a;
}

function setState(tabId, state) {
  const a = activityFor(tabId);
  if (a.state === state) return;
  a.state = state;
  sendWatchtowerUpdate();
}

function setDone(tabId) {
  const a = activityFor(tabId);
  a.lastDoneAt = Date.now();
  a.lastActivity = Date.now();
  if (tabId === activeTabId) {
    // You are watching it finish: nothing pending.
    setState(tabId, 'idle');
    return;
  }
  setState(tabId, 'done');
  // Alert: row highlight (the done state) + one Windows notification.
  // No chat content ever goes in it — just the tab's name.
  if (settings.alertsEnabled && Notification.isSupported()) {
    const tab = allTabs().find((t) => t.id === tabId);
    const note = new Notification({
      title: 'Multi-AI Tabs',
      body: (tab ? tab.label : 'A tab') + ' finished — check it',
      silent: true,
    });
    note.on('click', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      switchTab(tabId);
    });
    note.show();
  }
}

// A request started on this tab's session.
function noteRequestStart(tabId) {
  const a = activityFor(tabId);
  a.inflight += 1;
  a.lastActivity = Date.now();
  a.lastStartAt = Date.now();
  if (!a.loadedOnce || a.state === 'working' || a.timer) return;
  a.timer = setTimeout(() => {
    a.timer = null;
    if (a.inflight > 0 && a.loadedOnce && a.state !== 'working') {
      setState(tabId, 'working');
    }
  }, WORKING_AFTER_MS);
}

// A request finished (or failed) on this tab's session.
function noteRequestEnd(tabId) {
  const a = activityFor(tabId);
  a.inflight = Math.max(0, a.inflight - 1);
  a.lastActivity = Date.now();
  if (a.inflight === 0) {
    if (a.timer) {
      clearTimeout(a.timer);
      a.timer = null;
    }
    if (a.state === 'working') setDone(tabId);
  }
}

// Watch one tab session's network traffic. Each partition is hooked
// once. onResponseStarted needs no callback (unlike onBeforeRequest,
// which would hang requests if the callback were missed), and it
// stays open for the whole of a streaming answer — which is exactly
// the signal "this tab is still generating".
function hookSession(tab) {
  if (hookedSessions.has(tab.partition)) return;
  hookedSessions.add(tab.partition);
  const ses = session.fromPartition(tab.partition);
  // Spellcheck on, US English, for every tab's chat boxes.
  try {
    ses.setSpellCheckerEnabled(true);
    ses.setSpellCheckerLanguages(['en-US']);
  } catch {
    // Older Electron or a failed language load: menus still work,
    // suggestions just won't appear.
  }
  const filter = { urls: ['*://*/*'] };
  ses.webRequest.onResponseStarted(filter, () => noteRequestStart(tab.id));
  ses.webRequest.onCompleted(filter, () => noteRequestEnd(tab.id));
  ses.webRequest.onErrorOccurred(filter, () => noteRequestEnd(tab.id));
  // Notifications: the moment a site tries to notify you (an approval
  // waiting, a reply ready), Electron asks the app first. That ask is
  // an honest outside signal that the tab needs you — so the row goes
  // red ("Needs attention"), still without injecting anything into
  // the page. The Alerts switch gates the popup itself: off means no
  // notification from any tab, including the site's own.
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'notifications') {
      setState(tab.id, 'attention');
      callback(settings.alertsEnabled);
    } else {
      callback(true);
    }
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'notifications') {
      setState(tab.id, 'attention');
      return settings.alertsEnabled;
    }
    return true;
  });
}

function sendWatchtowerUpdate() {
  if (!sidebarView) return;
  sidebarView.webContents.send('watchtower-update', {
    collapsed: settings.sidebarCollapsed,
    alertsEnabled: settings.alertsEnabled,
    activeTabId,
    tabs: allTabs().map((tab) => {
      const a = activityFor(tab.id);
      return {
        id: tab.id,
        label: tab.label,
        state: a.state,
        lastActivity: a.lastActivity,
      };
    }),
  });
}

// Some tabs keep one background connection open forever (a live
// stream that never closes). Without this, that connection holds
// "Working" forever even when nothing is happening. Every 5s, any
// tab that has shown Working for over ~15s with no NEW request
// starting is dropped back to Idle — NOT Done. "Done — check it"
// is reserved for a real finish (a request burst actually
// completing); a connection merely going quiet means nothing
// finished, so Idle is the honest label.
const WORKING_STALE_MS = 15000;

function startWatchtowerSweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, a] of tabActivity) {
      if (a.state === 'working' && a.lastStartAt && now - a.lastStartAt > WORKING_STALE_MS) {
        a.inflight = 0;
        if (a.timer) {
          clearTimeout(a.timer);
          a.timer = null;
        }
        setState(tabId, 'idle');
      }
    }
  }, 5000);
}

// ---------------------------------------------------------------- tab view
function createTabView(tab) {
  hookSession(tab);
  const view = new WebContentsView({
    webPreferences: {
      partition: tab.partition,
      contextIsolation: true,
      sandbox: true,
      // No preload, no Node in the AI tabs on purpose: the tab is
      // just that service's normal website, nothing else.
      // Spellcheck is enabled per-session in hookSession, above.
    },
  });
  const wc = view.webContents;
  const a = activityFor(tab.id);

  wc.on('context-menu', (_event, params) => showContextMenu(wc, params));

  // Page loads: first load ends as idle (nothing generated yet);
  // a later navigation counts as working until it settles.
  wc.on('did-start-loading', () => {
    if (a.loadedOnce && a.state !== 'working') setState(tab.id, 'working');
  });
  wc.on('did-stop-loading', () => {
    if (a.loadedOnce && a.state === 'working' && a.inflight === 0) setDone(tab.id);
  });
  wc.on('did-finish-load', () => {
    const first = !a.loadedOnce;
    a.loadedOnce = true;
    if (first && a.state === 'unknown') setState(tab.id, 'idle');
  });
  // A title change after load is usually a fresh chat title landing
  // while an answer streams in — count it as recent activity.
  wc.on('page-title-updated', () => {
    if (a.loadedOnce) a.lastActivity = Date.now();
  });
  // Errors are the one "needs attention" the app can know for sure.
  wc.on('did-fail-load', () => setState(tab.id, 'attention'));
  wc.on('crashed', () => setState(tab.id, 'attention'));
  wc.on('unresponsive', () => setState(tab.id, 'attention'));
  wc.on('responsive', () => {
    if (a.state === 'attention') setState(tab.id, 'idle');
  });

  wc.loadURL(tab.url);
  return view;
}

// ------------------------------------------------------------------ window
function createWindow() {
  settings = loadSettings();
  startWatchtowerSweeper();
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
  tabbarView.webContents.on('context-menu', (_event, params) => {
    showContextMenu(tabbarView.webContents, params);
  });

  // The Watchtower sidebar: its own view, its own tiny preload.
  // It only ever shows tab names, states, and times — never content.
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-watchtower.js'),
      contextIsolation: true,
    },
  });
  win.contentView.addChildView(sidebarView);
  sidebarView.webContents.loadFile(path.join(__dirname, 'sidebar.html'));
  sidebarView.webContents.on('context-menu', (_event, params) => {
    showContextMenu(sidebarView.webContents, params);
  });
  sidebarView.webContents.on('did-finish-load', () => sendWatchtowerUpdate());

  ipcMain.on('switch-tab', (_event, tabId) => switchTab(tabId));

  ipcMain.on('add-tab', (event, { label, url }) => {
    const tab = addCustomTab(label, url);
    if (!tab) {
      event.sender.send('add-tab-error', 'Give the tab a name and a valid https:// website address.');
      return;
    }
    switchTab(tab.id);
  });

  ipcMain.on('remove-tab', (_event, tabId) => {
    const tab = customTabs.find((t) => t.id === tabId);
    if (!tab) return; // built-in tabs cannot be removed
    customTabs = customTabs.filter((t) => t.id !== tabId);
    saveCustomTabs(customTabs);
    const view = contentViews.get(tabId);
    if (view) {
      win.contentView.removeChildView(view);
      view.webContents.destroy();
      contentViews.delete(tabId);
    }
    const a = tabActivity.get(tabId);
    if (a && a.timer) clearTimeout(a.timer);
    tabActivity.delete(tabId);
    sendTabsList();
    sendWatchtowerUpdate();
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

  ipcMain.on('toggle-sidebar', () => {
    settings.sidebarCollapsed = !settings.sidebarCollapsed;
    saveSettings();
    layout();
    sendWatchtowerUpdate();
  });
  ipcMain.on('toggle-alerts', () => {
    settings.alertsEnabled = !settings.alertsEnabled;
    saveSettings();
    sendWatchtowerUpdate();
  });
  ipcMain.on('watchtower-jump', (_event, tabId) => switchTab(tabId));

  tabbarView.webContents.on('did-finish-load', () => {
    sendTabsList();
    switchTab(allTabs()[0].id);
  });

  win.on('resize', layout);
  win.on('closed', () => {
    win = null;
    tabbarView = null;
    sidebarView = null;
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
