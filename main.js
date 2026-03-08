const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, protocol, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns');
const { execFile, spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { autoUpdater } = require('electron-updater');

// ─── Discord RPC (optional — won't crash if not installed) ────────────────────
let rpc = null, rpcReady = false;

function setDiscordIdle() {
  console.log('[rpc] setDiscordIdle called, rpcReady:', rpcReady, 'rpc:', !!rpc);
  if (!rpc || !rpcReady) return;
  rpc.setActivity({ details: 'In the launcher', state: 'Skyware Client', largeImageKey: 'skyware_logo', startTimestamp: new Date(), instance: false }).catch(e => console.log('[rpc] setActivity error:', e.message));
}
function setDiscordPlaying(packName) {
  console.log('[rpc] setDiscordPlaying called with:', packName, '| rpcReady:', rpcReady, 'rpc:', !!rpc);
  const activity = () => {
    console.log('[rpc] activity() firing, rpcReady:', rpcReady);
    if (!rpc || !rpcReady) return;
    rpc.setActivity({ details: 'Playing Minecraft', state: 'Skyware Client', largeImageKey: 'skyware_logo', startTimestamp: new Date(), instance: true }).catch(e => console.log('[rpc] setActivity error:', e.message));
  };
  if (rpcReady) {
    activity();
  } else {
    // RPC not ready yet — retry every 500ms for up to 15s
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      console.log('[rpc] retry attempt', attempts, 'rpcReady:', rpcReady);
      if (rpcReady) { activity(); clearInterval(interval); }
      else if (attempts >= 30) { console.log('[rpc] giving up after 30 attempts'); clearInterval(interval); }
    }, 500);
  }
}

// Init RPC after functions are defined so the 'ready' callback can safely call setDiscordIdle
try {
  const DiscordRPC = require('discord-rpc');
  const CLIENT_ID  = '1480210973699870944';
  DiscordRPC.register(CLIENT_ID);
  rpc = new DiscordRPC.Client({ transport: 'ipc' });
  rpc.on('ready', () => { console.log('[rpc] ready fired'); rpcReady = true; setDiscordIdle(); });
  rpc.login({ clientId: CLIENT_ID }).catch(e => { console.log('[rpc] login failed:', e.message); rpc = null; });
} catch (_) {}


const MINECRAFT_DIR        = path.join(os.homedir(), 'AppData', 'Roaming', '.skyware');
const MODS_DIR             = path.join(MINECRAFT_DIR, 'mods');
const MRPACK_PATH          = path.join(__dirname, 'modpack.mrpack');

const MC_VERSION           = '1.21.11';
const FABRIC_LOADER        = '0.18.4';
const FABRIC_INSTALLER_URL =
  'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.1/fabric-installer-1.1.1.jar';

const MS_CLIENT_ID   = '00000000402b5328';
const MS_REDIRECT    = 'https://login.live.com/oauth20_desktop.srf';
const SETTINGS_PATH  = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  ramGb:        4,
  javaPath:     '',
  jvmArgs:      '',
  serverIp:     '',
  serverPort:   25565,
  background:   '',
  accentColor:  '#38bdf8',
  discordRpc:   true,
  fullscreen:   false,
  resWidth:     854,
  resHeight:    480,
  gameLanguage: 'en_us',
  closeLauncher: 'minimize',
  showConsole:  false,
  hotkey:       '',
  playtimeSecs: 0,
  musicTracks:  [],   // array of absolute file paths
  musicVolume:  0.5,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(data) {
  const merged = { ...loadSettings(), ...data };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

let win;
let authSession = null; // { username, uuid, accessToken }

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 560,
    frame: false,
    resizable: false,
    backgroundColor: '#080b10',
    icon: path.join(__dirname, 'skyware.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', () => {
    if (authSession) {
      win.webContents.send('auth-restored', { username: authSession.username });
    }

    // Check for updates after UI is ready (delay so bootsplash can finish)
    if (app.isPackaged) {
      setTimeout(() => initAutoUpdater(), 4000);
    }
  });
}

function initAutoUpdater() {
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
    if (win && !win.isDestroyed())
      win.webContents.send('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (win && !win.isDestroyed())
      win.webContents.send('update-progress', {
        percent: Math.floor(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info.version);
    if (win && !win.isDestroyed())
      win.webContents.send('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
  });

  autoUpdater.checkForUpdates().catch(err => {
    console.error('[updater] check failed:', err.message);
  });
}

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Register custom protocol for local music file streaming
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'skyware-music',      privileges: { secure: true, standard: true, stream: true } },
  { scheme: 'skyware-screenshot', privileges: { secure: true, standard: true } },
]);

app.whenReady().then(() => {
  // Handle local music file requests
  protocol.handle('skyware-music', (request) => {
    const filePath = decodeURIComponent(request.url.replace('skyware-music://', ''));
    return electronNet.fetch(`file://${filePath}`);
  });

  protocol.handle('skyware-screenshot', (request) => {
    const filePath = decodeURIComponent(request.url.replace('skyware-screenshot://', ''));
    return electronNet.fetch(`file://${filePath}`);
  });

  // Restore saved auth session if present
  try {
    const s = loadSettings();
    if (s._auth && s._auth.username && s._auth.accessToken) {
      authSession = s._auth;
      console.log('[auth] Restored session for', authSession.username);
    }
  } catch (_) {}
  createWindow();
});
app.on('window-all-closed', () => { globalShortcut.unregisterAll(); if (rpc) rpc.destroy().catch(() => {}); app.quit(); });

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close',    () => app.quit());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendProgress(label, pct) {
  if (win && !win.isDestroyed()) win.webContents.send('progress', { label, pct });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp  = dest + '.tmp';
    const file = fs.createWriteStream(tmp);
    const client = url.startsWith('https') ? https : http;

    const doGet = (u) => {
      client.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(tmp); } catch (_) {}
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try { fs.renameSync(tmp, dest); } catch (_) {}
            resolve();
          });
        });
      }).on('error', err => {
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(err);
      });
    };

    doGet(url);
  });
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const client  = parsed.protocol === 'https:' ? https : http;
    const body    = options.body || '';
    const headers = {
      ...options.headers,
      'Content-Length': Buffer.byteLength(body),
    };

    const req = client.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   options.method || 'GET',
        headers,
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          console.log(`[fetchJson] ${options.method || 'GET'} ${parsed.hostname}${parsed.pathname} → ${res.statusCode}`);
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error from ${url}: ${data.slice(0, 300)}`)); }
        });
      }
    );

    req.on('error', err => {
      console.error(`[fetchJson] Failed: ${url}`, err.message);
      reject(new Error(`Network error contacting ${parsed.hostname}: ${err.message}`));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Request timed out: ${url}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ─── Auth: embedded browser OAuth flow (no Azure app registration needed) ────
ipcMain.handle('auth-login', async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width:  520,
      height: 680,
      parent: win,
      modal:  true,
      title:  'Sign in with Microsoft',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const authUrl =
 	 `https://login.live.com/oauth20_authorize.srf` +
  	`?client_id=${MS_CLIENT_ID}` +
  	`&response_type=code` +
  	`&redirect_uri=${encodeURIComponent(MS_REDIRECT)}` +
  	`&scope=XboxLive.signin%20offline_access` +
  	`&prompt=select_account`;

    authWin.loadURL(authUrl);
    authWin.setMenuBarVisibility(false);

    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (!authWin.isDestroyed()) authWin.close();
      resolve(result);
    };

    // Watch for the redirect back to the native client URI containing the code
    authWin.webContents.on('will-redirect', async (event, url) => {
      if (!url.startsWith(MS_REDIRECT)) return;
      event.preventDefault();

      const code = new URL(url).searchParams.get('code');
      if (!code) return finish({ success: false, error: 'Login cancelled or no code returned.' });

      try {
        // Step 1: Exchange code for MS access token
        // Token URL - use login.live.com instead of microsoftonline
const tokenData = await fetchJson(
  	'https://login.live.com/oauth20_token.srf',
 	 {
  	  method: 'POST',
  	  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  	  body:
    	  `client_id=${MS_CLIENT_ID}` +
   	   `&code=${encodeURIComponent(code)}` +
   	   `&redirect_uri=${encodeURIComponent(MS_REDIRECT)}` +
  	    `&grant_type=authorization_code`,
	  }
	);

        if (!tokenData.access_token)
          return finish({ success: false, error: `Failed to get access token: ${tokenData.error_description || tokenData.error}` });

        // Step 2: Xbox Live
        const xblData = await fetchJson('https://user.auth.xboxlive.com/user/authenticate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            Properties:   { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${tokenData.access_token}` },
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType:    'JWT',
          }),
        });
        if (!xblData.Token)
          return finish({ success: false, error: 'Failed to authenticate with Xbox Live.' });

        // Step 3: XSTS
        const xstsData = await fetchJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            Properties:   { SandboxId: 'RETAIL', UserTokens: [xblData.Token] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType:    'JWT',
          }),
        });
        if (!xstsData.Token) {
          if (xstsData.XErr === 2148916233) return finish({ success: false, error: 'No Xbox account. Create one at xbox.com first.' });
          if (xstsData.XErr === 2148916238) return finish({ success: false, error: 'Child accounts are not supported.' });
          return finish({ success: false, error: 'Failed to get XSTS token.' });
        }

        const userHash = xblData.DisplayClaims.xui[0].uhs;

        // Step 4: Minecraft token
        const mcAuth = await fetchJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsData.Token}` }),
        });
        if (!mcAuth.access_token)
          return finish({ success: false, error: 'Failed to get Minecraft token.' });

        // Step 5: Profile
        const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
          headers: { Authorization: `Bearer ${mcAuth.access_token}` },
        });
        if (!profile.name)
          return finish({ success: false, error: 'This account does not own Minecraft Java Edition.' });

        authSession = { username: profile.name, uuid: profile.id, accessToken: mcAuth.access_token };
        // Persist session so it survives launcher restarts
        saveSettings({ _auth: authSession });
        finish({ success: true, username: profile.name });

      } catch (err) {
        console.error('[auth] Error:', err);
        finish({ success: false, error: err.message });
      }
    });

    // Also catch will-navigate for older Electron versions
    authWin.webContents.on('will-navigate', async (event, url) => {
      if (!url.startsWith(MS_REDIRECT)) return;
      authWin.webContents.emit('will-redirect', event, url);
    });

    authWin.on('closed', () => finish({ success: false, error: 'Login window closed.' }));
  });
});

ipcMain.handle('auth-logout', () => { authSession = null; saveSettings({ _auth: null }); return { success: true }; });
ipcMain.handle('auth-status', () =>
  authSession ? { loggedIn: true, username: authSession.username } : { loggedIn: false }
);

// ─── Launch via worker thread (keeps main thread free for Discord RPC + UI) ──
const { Worker } = require('worker_threads');

function launchWorker(settings, authSession) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'launcher-worker.js'), {
      workerData: {
        MINECRAFT_DIR, MODS_DIR, MRPACK_PATH,
        MC_VERSION, FABRIC_LOADER, FABRIC_INSTALLER_URL,
        settings, authSession,
      },
    });

    worker.on('message', msg => {
      switch (msg.type) {
        case 'progress':
          sendProgress(msg.label, msg.pct);
          break;
        case 'game-log':
          if (win && !win.isDestroyed()) win.webContents.send('game-log', msg.data);
          break;
        case 'launched': {
          // Signal renderer to fade out music and pause background
          if (win && !win.isDestroyed()) win.webContents.send('music-fade-out');
          if (win && !win.isDestroyed()) win.webContents.send('game-launched');
          // Start playtime timer
          win._sessionStart = Date.now();
          // Handle launcher visibility
          const cl = settings.closeLauncher;
          if (cl === 'close') {
            setTimeout(() => { if (win && !win.isDestroyed()) win.hide(); }, 2000);
          } else if (cl === 'minimize') {
            setTimeout(() => { if (win && !win.isDestroyed()) win.minimize(); }, 2000);
          }
          break;
        }
        case 'game-exit': {
          // Save playtime
          if (win && win._sessionStart) {
            const elapsed = Math.floor((Date.now() - win._sessionStart) / 1000);
            const s = loadSettings();
            saveSettings({ playtimeSecs: (s.playtimeSecs || 0) + elapsed });
            win._sessionStart = null;
            // Tell renderer to update playtime display and resume music
            if (win && !win.isDestroyed()) win.webContents.send('playtime-updated');
            if (win && !win.isDestroyed()) win.webContents.send('music-fade-in');
            if (win && !win.isDestroyed()) win.webContents.send('game-exited');
          }
          setDiscordIdle();
          if (settings.closeLauncher === 'close') app.quit();
          break;
        }
        case 'pack-name':
          console.log('[rpc] pack-name received:', msg.name, '| discordRpc:', settings.discordRpc);
          if (settings.discordRpc !== false) setDiscordPlaying(msg.name);
          break;
        case 'done':
          resolve({ success: true });
          break;
        case 'error':
          resolve({ success: false, error: msg.message });
          break;
      }
    });

    worker.on('error', err => resolve({ success: false, error: err.message }));
  });
}

// ─── Main launch handler ──────────────────────────────────────────────────────
ipcMain.handle('launch', async () => {
  const settings    = loadSettings();
  const auth        = authSession;
  return await launchWorker(settings, auth);
});

// ─── Check install status ─────────────────────────────────────────────────────
ipcMain.handle('check-install', async () => {
  const modpackInstalled = fs.existsSync(MODS_DIR) && fs.readdirSync(MODS_DIR).length > 0;
  const mrpackExists     = fs.existsSync(MRPACK_PATH);
  const mcJarExists      = fs.existsSync(
    path.join(MINECRAFT_DIR, 'versions', MC_VERSION, `${MC_VERSION}.jar`)
  );
  return { modpackInstalled, mrpackExists, mcJarExists };
});
// ─── Settings IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, d) => {
  const saved = saveSettings(d);
  // Re-register hotkey
  globalShortcut.unregisterAll();
  if (saved.hotkey) {
    try {
      globalShortcut.register(saved.hotkey, () => {
        if (win) { win.show(); win.focus(); }
      });
    } catch (_) {}
  }
  return saved;
});

ipcMain.handle('browse-java', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select java.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('browse-background', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select Background Image',
    filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','webp','gif'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('browse-music', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add Music Tracks',
    filters: [{ name: 'Audio', extensions: ['mp3','ogg','wav','flac','m4a','aac'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('get-playtime', () => {
  const s = loadSettings();
  return s.playtimeSecs || 0;
});

ipcMain.handle('reset-playtime', () => {
  saveSettings({ playtimeSecs: 0 });
  return true;
});

// ─── Serve local music files to renderer via custom protocol ────────────────
// (music files are on disk, we need to allow renderer to play them)
ipcMain.handle('get-music-url', (_, filePath) => {
  // Return a file:// URL — Electron renderer can play these directly
  return 'file:///' + filePath.replace(/\\/g, '/');
});

ipcMain.handle('server-status', async (_, { host, port }) => {
  if (!host) return { online: false };

  function writeVarInt(val) {
    const out = [];
    do {
      let b = val & 0x7f; val >>>= 7;
      if (val) b |= 0x80;
      out.push(b);
    } while (val);
    return Buffer.from(out);
  }
  function writeString(str) {
    const b = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(b.length), b]);
  }
  function readVarInt(b, offset) {
    let val = 0, shift = 0, i = offset;
    while (i < b.length) {
      const byte = b[i++];
      val |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return { value: val, bytesRead: i - offset };
      if (shift >= 35) return null;
    }
    return null;
  }

  // Resolve SRV record first (_minecraft._tcp.<host>) — many servers like Hypixel use these
  let connectHost = host;
  let connectPort = port || 25565;
  try {
    const srvRecords = await new Promise((res, rej) =>
      dns.resolveSrv(`_minecraft._tcp.${host}`, (err, records) =>
        err ? rej(err) : res(records)
      )
    );
    if (srvRecords && srvRecords.length > 0) {
      connectHost = srvRecords[0].name;
      connectPort = srvRecords[0].port;
    }
  } catch (_) {
    // No SRV record — fall back to direct connection, that's fine
  }

  return new Promise(resolve => {
    const start  = Date.now();
    const socket = net.createConnection({ host: connectHost, port: connectPort });
    socket.setTimeout(8000);

    socket.on('connect', () => {
      const latency = Date.now() - start;

      const handshakeData = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(765),          // protocol version (1.20.4)
        writeString(host),         // original host for handshake
        (() => { const b = Buffer.alloc(2); b.writeUInt16BE(connectPort); return b; })(),
        writeVarInt(1),            // next state: status
      ]);
      const handshakePacket = Buffer.concat([writeVarInt(handshakeData.length), handshakeData]);

      // Status request: packet id 0x00, no payload → [len=1][id=0x00]
      const statusRequest = Buffer.from([0x01, 0x00]);

      // Ping packet: [length=9 varint][packetId=0x01][8-byte timestamp]
      const pingPayload = Buffer.alloc(10);
      pingPayload[0] = 0x09;                              // packet length (9 bytes follow)
      pingPayload[1] = 0x01;                              // packet id
      pingPayload.writeBigInt64BE(BigInt(Date.now()), 2); // timestamp at offset 2

      socket.write(Buffer.concat([handshakePacket, statusRequest, pingPayload]));

      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);

        let offset = 0;
        const packetLen = readVarInt(buf, offset);
        if (!packetLen) return;
        offset += packetLen.bytesRead;
        if (buf.length < offset + packetLen.value) return;

        const packetId = readVarInt(buf, offset);
        if (!packetId) return;
        offset += packetId.bytesRead;

        const strLen = readVarInt(buf, offset);
        if (!strLen) return;
        offset += strLen.bytesRead;

        if (buf.length < offset + strLen.value) return;

        try {
          const info = JSON.parse(buf.slice(offset, offset + strLen.value).toString('utf8'));
          socket.destroy();
          resolve({
            online:  true,
            latency,
            players: info.players?.online ?? 0,
            max:     info.players?.max    ?? 0,
            motd:    (() => {
              const d = info.description;
              if (typeof d === 'string') return d;
              if (d?.extra) return d.extra.map(e => e.text || '').join('');
              return d?.text ?? '';
            })(),
            version: info.version?.name ?? '',
          });
        } catch (e) {
          socket.destroy();
          resolve({ online: false, error: 'Bad response' });
        }
      });
    });

    socket.on('timeout', () => { socket.destroy(); resolve({ online: false, error: 'Timeout' }); });
    socket.on('error',   (e) => { socket.destroy(); resolve({ online: false, error: e.code || 'Unreachable' }); });
  });
});

// ─── Read pack name for UI ────────────────────────────────────────────────────
ipcMain.handle('get-pack-name', () => {
  try {
    if (!fs.existsSync(MRPACK_PATH)) return 'Your Modpack';
    const zip   = new AdmZip(MRPACK_PATH);
    const entry = zip.getEntry('modrinth.index.json');
    return entry ? (JSON.parse(entry.getData().toString('utf8')).name || 'Your Modpack') : 'Your Modpack';
  } catch (_) { return 'Your Modpack'; }
});
// ─── Screenshots ──────────────────────────────────────────────────────────────
const SCREENSHOTS_DIR = path.join(MINECRAFT_DIR, 'screenshots');

ipcMain.handle('get-screenshots', () => {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return [];
    return fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => ({
        name: f,
        path: path.join(SCREENSHOTS_DIR, f),
        time: fs.statSync(path.join(SCREENSHOTS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);
  } catch (_) { return []; }
});

ipcMain.handle('open-screenshot', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('open-screenshots-dir', () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  shell.openPath(SCREENSHOTS_DIR);
});

ipcMain.handle('delete-screenshot', (_, filePath) => {
  try { fs.unlinkSync(filePath); return true; }
  catch (_) { return false; }
});