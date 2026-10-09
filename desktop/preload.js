'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('swarmApp', {
  chooseRole: role => ipcRenderer.invoke('choose-role', role),
  setAutostart: enabled => ipcRenderer.invoke('set-autostart', !!enabled),
  getRole: () => ipcRenderer.invoke('get-role'),
  quit: () => ipcRenderer.invoke('quit-app'),
  minimize: () => ipcRenderer.invoke('minimize-window'),
  resetRole: () => ipcRenderer.invoke('reset-role'),
  onAgentLog: callback => ipcRenderer.on('agent-log', (_event, line) => callback(line))
});
