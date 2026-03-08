const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skyware', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Auth
  login:      () => ipcRenderer.invoke('auth-login'),
  logout:     () => ipcRenderer.invoke('auth-logout'),
  authStatus: () => ipcRenderer.invoke('auth-status'),

  // Launcher
  launch:       (opts) => ipcRenderer.invoke('launch', opts),
  checkInstall: ()     => ipcRenderer.invoke('check-install'),

  // Settings
  getSettings:      ()     => ipcRenderer.invoke('get-settings'),
  saveSettings:     (data) => ipcRenderer.invoke('save-settings', data),
  browseJava:       ()     => ipcRenderer.invoke('browse-java'),
  browseBackground: ()     => ipcRenderer.invoke('browse-background'),

  // Screenshots
  getScreenshots:      ()         => ipcRenderer.invoke('get-screenshots'),
  openScreenshot:      (filePath) => ipcRenderer.invoke('open-screenshot', filePath),
  openScreenshotsDir:  ()         => ipcRenderer.invoke('open-screenshots-dir'),
  deleteScreenshot:    (filePath) => ipcRenderer.invoke('delete-screenshot', filePath),

  // Music
  browseMusic:  ()         => ipcRenderer.invoke('browse-music'),
  getMusicUrl:  (filePath) => ipcRenderer.invoke('get-music-url', filePath),

  // Playtime
  getPlaytime:   () => ipcRenderer.invoke('get-playtime'),
  resetPlaytime: () => ipcRenderer.invoke('reset-playtime'),

  // Server
  serverStatus: (opts) => ipcRenderer.invoke('server-status', opts),

  // Pack name
  getPackName: () => ipcRenderer.invoke('get-pack-name'),

  // Events: main → renderer
  onProgress:      (cb) => ipcRenderer.on('progress',        (_, data) => cb(data)),
  onAuthCode:      (cb) => ipcRenderer.on('auth-user-code',  (_, data) => cb(data)),
  onAuthRestored:  (cb) => ipcRenderer.on('auth-restored',   (_, data) => cb(data)),
  onGameLog:       (cb) => ipcRenderer.on('game-log',        (_, data) => cb(data)),
  onMusicFadeOut:  (cb) => ipcRenderer.on('music-fade-out',  ()        => cb()),
  onMusicFadeIn:   (cb) => ipcRenderer.on('music-fade-in',   ()        => cb()),
  onPlaytimeUpdate:(cb) => ipcRenderer.on('playtime-updated',()        => cb()),
  onGameLaunched:  (cb) => ipcRenderer.on('game-launched',   ()        => cb()),
  onGameExited:    (cb) => ipcRenderer.on('game-exited',     ()        => cb()),

  // Auto-updater
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, d) => cb(d)),
  onUpdateProgress:  (cb) => ipcRenderer.on('update-progress',  (_, d) => cb(d)),
  onUpdateDownloaded:(cb) => ipcRenderer.on('update-downloaded', (_, d) => cb(d)),
  installUpdate: () => ipcRenderer.send('install-update'),
});