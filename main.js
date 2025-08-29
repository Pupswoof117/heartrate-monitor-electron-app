const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const RPC = require('discord-rpc');
const store = require('./store');

let mainWindow;
let overlayWindow;

// ---------- Discord RPC ----------
let rpc = null;
let rpcReady = false;
let lastRpcUpdate = 0;

function acquirePulsoidTokenImplicit({ clientId, scope = 'data:heart_rate:read' }) {
  return new Promise((resolve) => {
    const state = crypto.randomUUID();
    const redirect = 'http://localhost'; // register this in Pulsoid dev settings
    const url = `https://pulsoid.net/oauth2/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&response_mode=web_page`;

    const checkUrl = (urlStr) => {
      try {
        const u = new URL(urlStr);
        if (u.origin === 'http://localhost' && u.pathname.startsWith('/oauth')) {
          const params = new URLSearchParams((u.hash || '').replace(/^#/, ''));
          const token = params.get('access_token');
          const gotState = params.get('state');
          if (token && gotState === state) {
            resolve({ access_token: token, expires_in: Number(params.get('expires_in')) || null });
            setImmediate(() => { try { win.close(); } catch {} });
          }
        }
      } catch {}
    };
    shell.openExternal(url);
  });
}

function acquirePulsoidTokenWebPage({ clientId, scope = 'data:heart_rate:read' }) {
  const state = crypto.randomUUID();
  const url = `https://pulsoid.net/oauth2/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://localhost')}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&response_mode=web_page`;
  shell.openExternal(url);
  return { copied: true };
}


function ensureDiscordRpc() {
    const enabled = store.get('discordRpcEnabled');
    const clientId = "1284103861388185600";
    if (!enabled || !clientId) {
        teardownDiscordRpc();
        return;
    }
    if (rpc) return; // already up
    rpc = new RPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
        rpcReady = true;
        setDiscordActivity({ state: 'Waiting for data…', details: 'Heart rate' });
    });
    rpc.login({ clientId }).catch((err) => {
        console.error('[rpc] login error', err?.message || err);
        teardownDiscordRpc();
    });
}

function teardownDiscordRpc() {
    rpcReady = false;
    if (rpc) {
        try { rpc.clearActivity(); } catch (_) { }
        try { rpc.destroy(); } catch (_) { }
    }
    rpc = null;
}

function setDiscordActivity({ details, state }) {
    if (!rpc || !rpcReady) return;
    try {
        rpc.setActivity({ details, state, largeImageKey: 'heart', largeImageText: 'Pulsoid' });
    } catch (e) {
        console.error('[rpc] setActivity failed', e?.message || e);
    }
}

// ---------- Pulsoid stream ----------
class PulsoidClient {
    constructor(onHR) {
        this.onHR = onHR;
        this.ws = null;
        this.backoff = 1000; // start 1s
        this.maxBackoff = 30000;
        this.connected = false;
    }
    url() {
        const token = store.get('pulsoidToken');
        return token
            ? `wss://dev.pulsoid.net/api/v1/data/real_time?access_token=${encodeURIComponent(token)}`
            : null;
    }
    start() {
        if (!store.get('realtimeEnabled')) return;
        const url = this.url();
        if (!url) return;
        if (this.ws) return; // already running
        this._connect(url);
    }
    stop() {
        if (this.ws) {
            try { this.ws.close(); } catch (_) { }
        }
        this.ws = null;
        this.connected = false;
    }
    _connect(url) {
        this.ws = new WebSocket(url);
        this.ws.on('open', () => {
            this.connected = true;
            this.backoff = 1000;
            broadcastStatus();
            console.log('[ws] connected');
        });
        this.ws.on('message', (payload) => {
            let hr = null;
            const text = payload.toString().trim();
            if (/^\d+$/.test(text)) {
                hr = parseInt(text, 10);
            } else {
                try { const j = JSON.parse(text); hr = j?.data?.heart_rate ?? null; } catch (_) { }
            }
            if (typeof hr === 'number' && !Number.isNaN(hr)) {
                this.onHR(hr);
            }
        });
        this.ws.on('close', (code) => {
            this.connected = false;
            broadcastStatus();
            console.warn('[ws] closed', code);
            this._scheduleReconnect();
        });
        this.ws.on('error', (err) => {
            console.error('[ws] error', err?.message || err);
            try { this.ws.close(); } catch (_) { }
        });
    }
    _scheduleReconnect() {
        if (!store.get('realtimeEnabled')) return;
        const delay = Math.min(this.backoff, this.maxBackoff);
        setTimeout(() => {
            if (this.ws) return; // already connected
            const url = this.url();
            if (!url) return;
            this._connect(url);
        }, delay);
        this.backoff *= 2;
    }
}

const stats = { min: null, max: null, sum: 0, count: 0, avg: null, last: null };

function updateStats(hr) {
    stats.last = hr;
    stats.min = stats.min === null ? hr : Math.min(stats.min, hr);
    stats.max = stats.max === null ? hr : Math.max(stats.max, hr);
    stats.sum += hr;
    stats.count += 1;
    stats.avg = Number((stats.sum / stats.count).toFixed(1));
}

function broadcastHR(hr) {
    const payload = { hr, at: Date.now(), stats };
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('hr:update', payload));
}

function broadcastStatus() {
    const s = {
        realtimeEnabled: store.get('realtimeEnabled'),
        discordRpcEnabled: store.get('discordRpcEnabled'),
        connected: pulsoid.connected,
        last: stats.last,
        avg: stats.avg,
        min: stats.min,
        max: stats.max
    };
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('hr:update', { type: 'status', ...s }));
}

const pulsoid = new PulsoidClient((hr) => {
    updateStats(hr);
    const now = Date.now();
    const interval = store.get('updateIntervalMs');
    broadcastHR(hr);
    if (store.get('discordRpcEnabled') && rpc && rpcReady && now - lastRpcUpdate >= interval) {
        setDiscordActivity({ details: 'Heart rate', state: `❤ ${hr} bpm` });
        lastRpcUpdate = now;
    }
});

// ---------- Windows ----------
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 980,
        height: 680,
        title: 'Pulsoid Dashboard',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff',
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function createOverlayWindow() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.focus();
        return;
    }
    overlayWindow = new BrowserWindow({
        width: 600,
        height: 200,
        frame: false,
        transparent: true,
        resizable: true,
        alwaysOnTop: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay.html'));
}

// ---------- App lifecycle ----------
app.whenReady().then(() => {
    createMainWindow();
    ensureDiscordRpc();
    if (store.get('realtimeEnabled')) pulsoid.start();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => { pulsoid.stop(); teardownDiscordRpc(); });

ipcMain.handle('pulsoid:oauth', async (_e, { clientId, scope }) => {
  try {
    const token = await acquirePulsoidTokenImplicit({ clientId, scope });
    if (token?.access_token) return token;
  } catch {}
  return acquirePulsoidTokenWebPage({ clientId, scope });
});

// ---------- IPC ----------
ipcMain.handle('settings:get', () => ({
    pulsoidToken: store.get('pulsoidToken'),
    discordRpcEnabled: store.get('discordRpcEnabled'),
    realtimeEnabled: store.get('realtimeEnabled'),
    updateIntervalMs: store.get('updateIntervalMs')
}));

ipcMain.handle('settings:save', (_e, data) => {
    const prev = {
        token: store.get('pulsoidToken'),
        rpcEnabled: store.get('discordRpcEnabled'),
        realtime: store.get('realtimeEnabled')
    };
    if (typeof data.pulsoidToken === 'string') store.set('pulsoidToken', data.pulsoidToken.trim());
    if (typeof data.discordRpcEnabled === 'boolean') store.set('discordRpcEnabled', data.discordRpcEnabled);
    if (typeof data.realtimeEnabled === 'boolean') store.set('realtimeEnabled', data.realtimeEnabled);
    if (typeof data.updateIntervalMs === 'number') store.set('updateIntervalMs', Math.max(1000, data.updateIntervalMs));

    // React to changes
    if (prev.rpcEnabled !== store.get('discordRpcEnabled') || prev.clientId !== store.get('discordClientId')) {
        teardownDiscordRpc();
        ensureDiscordRpc();
    }
    if (prev.realtime !== store.get('realtimeEnabled') || prev.token !== store.get('pulsoidToken')) {
        pulsoid.stop();
        if (store.get('realtimeEnabled')) pulsoid.start();
    }
    broadcastStatus();
    return { ok: true };
});

ipcMain.handle('status:get', () => ({
    connected: pulsoid.connected,
    last: stats.last,
    avg: stats.avg,
    min: stats.min,
    max: stats.max,
    realtimeEnabled: store.get('realtimeEnabled'),
    discordRpcEnabled: store.get('discordRpcEnabled')
}));

ipcMain.handle('overlay:open', () => { createOverlayWindow(); return { ok: true }; });
ipcMain.handle('overlay:close', () => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close(); return { ok: true }; });