// launcher-worker.js — runs all heavy install/launch work in a worker thread
// Communicates with main.js via parentPort messages
const { workerData, parentPort } = require('worker_threads');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const https    = require('https');
const http     = require('http');
const { execFile, spawn } = require('child_process');
const AdmZip   = require('adm-zip');

const {
  MINECRAFT_DIR, MODS_DIR, MRPACK_PATH,
  MC_VERSION, FABRIC_LOADER, FABRIC_INSTALLER_URL,
  settings, authSession,
} = workerData;

function sendProgress(label, pct) {
  parentPort.postMessage({ type: 'progress', label, pct });
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
    const headers = { ...options.headers, 'Content-Length': Buffer.byteLength(body) };

    const req = client.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', err => reject(new Error(`Network error: ${err.message}`)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function installFabric() {
  const fabricId   = `fabric-loader-${FABRIC_LOADER}-${MC_VERSION}`;
  const fabricJson = path.join(MINECRAFT_DIR, 'versions', fabricId, `${fabricId}.json`);
  if (fs.existsSync(fabricJson)) { sendProgress('Fabric already installed.', 20); return; }

  sendProgress('Downloading Fabric installer...', 10);
  const jarPath = path.join(os.tmpdir(), 'fabric-installer.jar');
  if (!fs.existsSync(jarPath)) await download(FABRIC_INSTALLER_URL, jarPath);

  sendProgress(`Installing Fabric ${FABRIC_LOADER}...`, 16);
  await new Promise(resolve => {
    execFile('java', ['-jar', jarPath, 'client', '-dir', MINECRAFT_DIR, '-mcversion', MC_VERSION, '-loader', FABRIC_LOADER, '-noprofile'],
      (err, _out, stderr) => { if (err) console.warn('Fabric installer:', stderr); resolve(); });
  });

  if (!fs.existsSync(fabricJson)) throw new Error('Fabric installation failed. Is Java 21 installed?');
  sendProgress('Fabric installed.', 20);
}

async function downloadMinecraftJar() {
  const versionDir = path.join(MINECRAFT_DIR, 'versions', MC_VERSION);
  const jarDest    = path.join(versionDir, `${MC_VERSION}.jar`);
  const jsonDest   = path.join(versionDir, `${MC_VERSION}.json`);
  if (fs.existsSync(jarDest) && fs.existsSync(jsonDest)) { sendProgress('Minecraft already downloaded.', 35); return; }

  sendProgress('Fetching version manifest...', 22);
  const manifest     = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json');
  const versionEntry = manifest.versions.find(v => v.id === MC_VERSION);
  if (!versionEntry) throw new Error(`Minecraft ${MC_VERSION} not found in manifest.`);

  const versionMeta = await fetchJson(versionEntry.url);
  fs.mkdirSync(versionDir, { recursive: true });
  if (!fs.existsSync(jsonDest)) fs.writeFileSync(jsonDest, JSON.stringify(versionMeta, null, 2));
  if (!fs.existsSync(jarDest)) { sendProgress(`Downloading Minecraft ${MC_VERSION}...`, 28); await download(versionMeta.downloads.client.url, jarDest); }
  sendProgress('Minecraft downloaded.', 35);
}

async function downloadAssets() {
  const versionJsonPath = path.join(MINECRAFT_DIR, 'versions', MC_VERSION, `${MC_VERSION}.json`);
  if (!fs.existsSync(versionJsonPath)) return;

  const vanillaJson    = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  const assetIndexInfo = vanillaJson.assetIndex;
  if (!assetIndexInfo) return;

  const indexDir  = path.join(MINECRAFT_DIR, 'assets', 'indexes');
  const indexPath = path.join(indexDir, `${assetIndexInfo.id}.json`);
  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(indexPath)) { sendProgress('Downloading asset index...', 38); await download(assetIndexInfo.url, indexPath); }

  const objects    = JSON.parse(fs.readFileSync(indexPath, 'utf8')).objects || {};
  const objectsDir = path.join(MINECRAFT_DIR, 'assets', 'objects');
  fs.mkdirSync(objectsDir, { recursive: true });

  const missing = Object.values(objects).filter(({ hash }) => !fs.existsSync(path.join(objectsDir, hash.slice(0, 2), hash)));
  if (missing.length === 0) { sendProgress('Assets already up to date.', 55); return; }

  const BATCH = 10;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(missing.slice(i, i + BATCH).map(async ({ hash }) => {
      const subdir = hash.slice(0, 2);
      const dest   = path.join(objectsDir, subdir, hash);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await download(`https://resources.download.minecraft.net/${subdir}/${hash}`, dest);
    }));
    const done = Math.min(i + BATCH, missing.length);
    sendProgress(`Downloading assets (${done} / ${missing.length})...`, 38 + Math.round((done / missing.length) * 17));
  }
  sendProgress('Assets downloaded.', 55);
}

async function installModpack() {
  if (!fs.existsSync(MRPACK_PATH)) throw new Error('modpack.mrpack not found next to the launcher.');
  sendProgress('Reading modpack...', 38);
  fs.mkdirSync(MODS_DIR, { recursive: true });

  const zip        = new AdmZip(MRPACK_PATH);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Invalid .mrpack: missing modrinth.index.json');

  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  const files = index.files || [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const dest = path.join(MINECRAFT_DIR, file.path);
    if (!fs.existsSync(dest)) {
      sendProgress(`Downloading mod ${i + 1}/${total}...`, 38 + Math.floor((i / total) * 38));
      await download(file.downloads[0], dest);
    }
  }

  sendProgress('Applying overrides...', 78);
  for (const entry of zip.getEntries().filter(e => e.entryName.startsWith('overrides/') && !e.isDirectory)) {
    const dest = path.join(MINECRAFT_DIR, entry.entryName.replace(/^overrides\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
  sendProgress('Modpack ready.', 82);
}

function findJava() {
  if (settings.javaPath && fs.existsSync(settings.javaPath)) return settings.javaPath;
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
    'C:\\Program Files\\Microsoft\\jdk-21.0.5.11-hotspot\\bin\\java.exe',
    'java',
  ].filter(Boolean);
  for (const j of candidates) {
    if (j === 'java') return j;
    if (fs.existsSync(j)) return j;
  }
  return 'java';
}

async function resolveLibraries(libraries, libDir) {
  const classpath = [];
  for (const lib of libraries) {
    if (!lib.name || lib.natives) continue;
    const [group, artifact, version] = lib.name.split(':');
    const groupPath = group.replace(/\./g, '/');
    const jarName   = `${artifact}-${version}.jar`;
    const libPath   = path.join(libDir, groupPath, artifact, version, jarName);
    if (fs.existsSync(libPath)) { classpath.push(libPath); continue; }
    const artifactUrl = lib.downloads?.artifact?.url ||
      (lib.url ? `${lib.url.replace(/\/$/, '')}/${groupPath}/${artifact}/${version}/${jarName}`
               : `https://libraries.minecraft.net/${groupPath}/${artifact}/${version}/${jarName}`);
    try { await download(artifactUrl, libPath); classpath.push(libPath); }
    catch (e) { console.warn(`Skipping library ${lib.name}: ${e.message}`); }
  }
  return classpath;
}

async function extractNatives(vanillaJson, versionsDir, fabricVersion) {
  const nativesDir = path.join(versionsDir, fabricVersion, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });
  if (fs.readdirSync(nativesDir).length > 0) return nativesDir;

  const libDir = path.join(MINECRAFT_DIR, 'libraries');
  let lwjglVersion = '3.3.3';
  for (const lib of vanillaJson.libraries || []) {
    if (lib.name?.startsWith('org.lwjgl:lwjgl:')) { lwjglVersion = lib.name.split(':')[2]; break; }
  }

  const lwjglModules = ['lwjgl','lwjgl-freetype','lwjgl-glfw','lwjgl-jemalloc','lwjgl-openal','lwjgl-opengl','lwjgl-stb','lwjgl-tinyfd'];
  for (const mod of lwjglModules) {
    const jarName = `${mod}-${lwjglVersion}-natives-windows.jar`;
    const jarPath = path.join(libDir, 'org', 'lwjgl', mod, lwjglVersion, jarName);
    if (!fs.existsSync(jarPath)) {
      try { sendProgress(`Downloading ${mod} natives...`, 88); await download(`https://libraries.minecraft.net/org/lwjgl/${mod}/${lwjglVersion}/${jarName}`, jarPath); }
      catch (e) { console.warn(`Could not download ${jarName}:`, e.message); continue; }
    }
    try {
      new AdmZip(jarPath).getEntries().forEach(entry => {
        if (!entry.isDirectory && entry.entryName.endsWith('.dll') && entry.entryName.startsWith('windows/x64/'))
          fs.writeFileSync(path.join(nativesDir, path.basename(entry.entryName)), entry.getData());
      });
    } catch (e) { console.warn(`Could not extract ${jarName}:`, e.message); }
  }

  const extracted = fs.readdirSync(nativesDir);
  if (extracted.length === 0) throw new Error('Failed to extract LWJGL natives.');
  return nativesDir;
}

async function launchMinecraft() {
  sendProgress('Building classpath...', 86);
  const java        = findJava();
  const versionsDir = path.join(MINECRAFT_DIR, 'versions');
  const libDir      = path.join(MINECRAFT_DIR, 'libraries');

  let fabricVersion = fs.existsSync(versionsDir)
    ? fs.readdirSync(versionsDir).find(d => d.startsWith('fabric-loader') && d.includes(MC_VERSION))
    : null;
  if (!fabricVersion) throw new Error('Fabric version not found after install.');

  const fabricJson  = JSON.parse(fs.readFileSync(path.join(versionsDir, fabricVersion, `${fabricVersion}.json`), 'utf8'));
  const vanillaJson = JSON.parse(fs.readFileSync(path.join(versionsDir, MC_VERSION, `${MC_VERSION}.json`), 'utf8'));

  const classpath = await resolveLibraries([...(vanillaJson.libraries || []), ...(fabricJson.libraries || [])], libDir);
  const mcClientJar = path.join(versionsDir, MC_VERSION, `${MC_VERSION}.jar`);
  if (!fs.existsSync(mcClientJar)) throw new Error(`Minecraft client jar not found: ${mcClientJar}`);
  classpath.push(mcClientJar);

  sendProgress('Extracting natives...', 88);
  const nativesDir = await extractNatives(vanillaJson, versionsDir, fabricVersion);

  const assetIndex  = vanillaJson.assetIndex?.id || MC_VERSION;
  const mainClass   = fabricJson.mainClass || 'net.fabricmc.loader.impl.launch.knot.KnotClient';
  const username    = authSession?.username    || 'Player';
  const uuid        = authSession?.uuid        || '00000000-0000-0000-0000-000000000000';
  const accessToken = authSession?.accessToken || '0';
  const userType    = authSession              ? 'msa' : 'legacy';
  const extraJvm    = (settings.jvmArgs || '').trim().split(/\s+/).filter(Boolean);

  const args = [
    `-Xmx${settings.ramGb || 4}G`, '-Xms512M', ...extraJvm,
    `-Dfabric.gameJarPath=${mcClientJar}`,
    `-Djava.library.path=${nativesDir}`,
    '-Dminecraft.launcher.brand=skyware',
    '-Dminecraft.launcher.version=1.0.0',
    '-cp', classpath.join(';'),
    mainClass,
    '--username', username, '--version', fabricVersion,
    '--gameDir', MINECRAFT_DIR,
    '--assetsDir', path.join(MINECRAFT_DIR, 'assets'),
    '--assetIndex', assetIndex,
    '--uuid', uuid, '--accessToken', accessToken,
    '--userType', userType, '--versionType', 'release',
    '--lang', settings.gameLanguage || 'en_us',
    '--width', String(settings.resWidth || 854),
    '--height', String(settings.resHeight || 480),
  ];
  if (settings.fullscreen) args.push('--fullscreen');

  sendProgress('Launching!', 95);

  const cleanEnv = { ...process.env };
  delete cleanEnv.JAVA_TOOL_OPTIONS;
  delete cleanEnv._JAVA_OPTIONS;
  delete cleanEnv.JDK_JAVA_OPTIONS;

  const stdioMode = settings.showConsole ? 'pipe' : 'ignore';
  const mc = spawn(java, args, { cwd: MINECRAFT_DIR, detached: true, stdio: ['ignore', stdioMode, stdioMode], env: cleanEnv });

  // Send the PID back so main process can track it
  parentPort.postMessage({ type: 'launched', pid: mc.pid, showConsole: settings.showConsole });

  if (settings.showConsole) {
    mc.stdout.on('data', d => parentPort.postMessage({ type: 'game-log', data: d.toString() }));
    mc.stderr.on('data', d => parentPort.postMessage({ type: 'game-log', data: d.toString() }));
  }

  mc.once('exit', () => {
    parentPort.postMessage({ type: 'game-exit' });
    parentPort.postMessage({ type: 'done' });
  });
  mc.unref();

  sendProgress('Launched!', 100);

  // Read pack name for Discord RPC
  try {
    const zip   = new AdmZip(MRPACK_PATH);
    const entry = zip.getEntry('modrinth.index.json');
    const pname = entry ? JSON.parse(entry.getData().toString('utf8')).name : 'Skyware Modpack';
    parentPort.postMessage({ type: 'pack-name', name: pname });
  } catch (_) {
    parentPort.postMessage({ type: 'pack-name', name: 'Skyware Modpack' });
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    fs.mkdirSync(MINECRAFT_DIR, { recursive: true });
    await installFabric();
    await downloadMinecraftJar();
    await downloadAssets();
    await installModpack();
    await launchMinecraft();
    // 'done' is now sent by launchMinecraft after game-exit
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message });
  }
})();