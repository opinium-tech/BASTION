'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'Computer Swarm';
let mainWindow = null;
let tray = null;
let currentRole = null;
let agentStarted = false;
let allowWindowClose = false;
let agentAutostart = false;
let serverLoaded = false;
const userDir = () => app.getPath('userData');
const rolePath = () => path.join(userDir(), 'role.json');
const readRole = () => { try { const r = JSON.parse(fs.readFileSync(rolePath(), 'utf8')); return ['operator','agent'].includes(r.role) ? r.role : null; } catch { return null; } };
const saveRole = role => { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(rolePath(), JSON.stringify({ role, chosenAt: new Date().toISOString() }, null, 2)); };

function createWindow(opts = {}) {
  mainWindow = new BrowserWindow({
    width: opts.width || 1180, height: opts.height || 780, minWidth: 760, minHeight: 560,
    title: APP_NAME, show: true, autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}
function showRolePicker() {
  currentRole = null;
  const win = createWindow({ width: 760, height: 600 });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'role-picker.html'));
}
async function startOperator() {
  currentRole = 'operator';
  process.env.SWARM_OPEN_BROWSER = '0';
  try { require(path.join(__dirname, '..', 'operator', 'server.js')); serverLoaded = true; }
  catch (e) { dialog.showErrorBox('Operator could not start', `${e.message}\n\nCheck the application package and try again.`); return; }
  const win = createWindow({ width: 1400, height: 900 });
  win.setTitle('Computer Swarm — Operator');
  win.webContents.on('did-fail-load', () => {
    if (win.isDestroyed()) return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL('http://127.0.0.1:3000'); }, 1000);
  });
  let attempts = 0;
  const load = async () => {
    if (win.isDestroyed()) return;
    try {
      const res = await fetch('http://127.0.0.1:3000/api/config');
      if (res.ok) { win.loadURL('http://127.0.0.1:3000'); return; }
    } catch {}
    if (++attempts < 30) setTimeout(load, 350);
    else dialog.showErrorBox('Operator startup timed out', 'The local dashboard did not start on port 3000. Check whether another application is using that port.');
  };
  load();
}
function createTray() {
  if (tray) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#243244"/><path d="M8 10h16v12H8zM12 14h8M12 18h5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
  tray = new Tray(nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')));
  tray.setToolTip('Computer Swarm Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Agent window', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Exit Agent', click: () => { allowWindowClose = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}
function startAgent() {
  currentRole = 'agent';
  const win = createWindow({ width: 760, height: 640 });
  win.setTitle('Computer Swarm — Agent');
  win.loadFile(path.join(__dirname, 'agent-window.html'));
  win.on('close', e => {
    if (!allowWindowClose && agentAutostart) { e.preventDefault(); win.hide(); }
  });
  // Agent is run transparently in this app process; close/quit remains available from the tray.
  if (!agentStarted) {
    agentStarted = true;
    try {
      process.on('swarm-log', line => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent-log', String(line)); });
      require(path.join(__dirname, '..', 'agent', 'agent.js'));
    } catch (e) { dialog.showErrorBox('Agent could not start', `${e.message}\n\nCheck the application package and try again.`); }
  }
}

ipcMain.handle('get-role', () => currentRole || readRole());
ipcMain.handle('choose-role', async (_event, role) => {
  if (!['operator','agent'].includes(role)) throw new Error('Invalid role');
  if (readRole()) return { ok: false, message: 'A role has already been selected on this Windows account.' };
  saveRole(role);
  const picker = mainWindow; mainWindow = null;
  if (picker && !picker.isDestroyed()) picker.destroy();
  if (role === 'operator') await startOperator(); else startAgent();
  return { ok: true };
});
ipcMain.handle('set-autostart', (_event, enabled) => {
  if (currentRole !== 'agent') return { ok: false };
  agentAutostart = !!enabled;
  try { app.setLoginItemSettings({ openAtLogin: agentAutostart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--autostart-agent'] }); }
  catch (e) { return { ok: false, message: e.message }; }
  if (agentAutostart) createTray();
  return { ok: true, enabled: agentAutostart };
});
ipcMain.handle('quit-app', () => { allowWindowClose = true; app.quit(); return true; });
ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); return true; });
ipcMain.handle('reset-role', async () => {
  const result = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancel','Reset role'], defaultId: 0, cancelId: 0, title: 'Reset role selection', message: 'Reset the saved role for this Windows account?', detail: 'The app will close. The next launch will show Operator / Agent selection again.' });
  if (result.response === 1) { try { fs.unlinkSync(rolePath()); } catch {} allowWindowClose = true; app.quit(); return true; }
  return false;
});

app.whenReady().then(() => {
  app.setAppUserModelId('in.dmpsaiclub.computerswarm');
  const saved = readRole();
  const autoStartArg = process.argv.includes('--autostart-agent');
  if (!saved) showRolePicker();
  else {
    currentRole = saved;
    if (saved === 'operator') startOperator();
    else {
      // Autostart only occurs after the user explicitly enables it in the Agent window.
      agentAutostart = app.getLoginItemSettings().openAtLogin;
      startAgent();
      if (autoStartArg && agentAutostart && mainWindow) mainWindow.hide();
      if (agentAutostart) createTray();
    }
  }
  app.on('activate', () => { if (mainWindow) mainWindow.show(); else if (!readRole()) showRolePicker(); else if (readRole()==='agent') startAgent(); else startOperator(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || currentRole === 'agent') { if (!agentAutostart || allowWindowClose) app.quit(); } });
app.on('before-quit', () => { allowWindowClose = true; if (tray) { tray.destroy(); tray = null; } });
