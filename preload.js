const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
    getStatus: () => ipcRenderer.invoke('status:get'),
    onHeartRate: (cb) => ipcRenderer.on('hr:update', (_e, payload) => cb(payload)),
    openOverlay: () => ipcRenderer.invoke('overlay:open'),
    closeOverlay: () => ipcRenderer.invoke('overlay:close'),
    acquirePulsoidToken: (opts) => ipcRenderer.invoke('pulsoid:oauth', opts)
});