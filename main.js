const { app, BrowserWindow, ipcMain, safeStorage, dialog, clipboard, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
// ssh2 og nøglekonvertering indlæses først, når der forbindes – det gør opstarten hurtigere.
const lazy = (mod) => { let m; return () => (m ??= require(mod)); };
const ssh2 = lazy('ssh2');
const keyconvert = lazy('./keyconvert');
const I18N = require('./renderer/strings.js');
const t = I18N.t;

let win;
const sessions = new Map(); // sessionId -> { conn, stream }

// ---------- Lager ----------
const hostsFile = () => path.join(app.getPath('userData'), 'hosts.json');
const knownFile = () => path.join(app.getPath('userData'), 'known_hosts.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const readHosts = () => readJson(hostsFile(), []);
const writeHosts = (h) => writeJson(hostsFile(), h);

// Adgangskoder krypteres med OS'ets nøglering (DPAPI / Keychain / libsecret).
// Er det ikke tilgængeligt, gemmes de slet ikke.
function enc(s) {
  if (!s || !safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.encryptString(s).toString('base64');
}
function dec(s) {
  if (!s) return '';
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
}
function sanitize(h) {
  const { password, passphrase, ...rest } = h;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---------- Vindue ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 820, minHeight: 500,
    backgroundColor: '#171a26',
    autoHideMenuBar: true,
    title: `Skal ${app.getVersion()}`,
    show: false, // vis først når siden er tegnet – ingen hvid/tom ramme
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Behold versionsnummeret i titellinjen (ellers overskriver sidens <title> det)
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  I18N.setLang(I18N.detect(app.getLocale())); // indtil brugerfladen siger andet
  // Electrons standardmenu har genveje som Ctrl+R (genindlæs) og Ctrl+W (luk vindue),
  // der kan slå igennem fra filhåndteringen og lukke alle sessioner. Den fjernes.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
});
app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.conn.end(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- Hosts ----------
ipcMain.handle('app:canEncrypt', () => safeStorage.isEncryptionAvailable());
// Brugerfladen fortæller hvilket sprog der er valgt, så dialoger og fejl følger med
ipcMain.handle('app:setLang', (_e, l) => { I18N.setLang(l); return I18N.lang; });
ipcMain.handle('app:locale', () => app.getLocale());
ipcMain.handle('hosts:list', () => readHosts().map(sanitize));

ipcMain.handle('hosts:save', (_e, input) => {
  const hosts = readHosts();
  const i = hosts.findIndex((h) => h.id === input.id);
  const prev = i >= 0 ? hosts[i] : {};
  const h = {
    id: input.id || crypto.randomUUID(),
    name: (input.name || '').trim(),
    group: (input.group || '').trim(),
    host: (input.host || '').trim(),
    port: Number(input.port) || 22,
    username: (input.username || '').trim(),
    authType: ['password', 'key', 'agent'].includes(input.authType) ? input.authType : 'password',
    keyPath: (input.keyPath || '').trim(),
    color: input.color || '',
  };
  h.password = input.clearPassword ? '' : input.password ? enc(input.password) : prev.password || '';
  h.passphrase = input.clearPassphrase ? '' : input.passphrase ? enc(input.passphrase) : prev.passphrase || '';
  if (i >= 0) hosts[i] = h; else hosts.push(h);
  writeHosts(hosts);
  return sanitize(h);
});

ipcMain.handle('hosts:duplicate', (_e, id) => {
  const hosts = readHosts();
  const src = hosts.find((h) => h.id === id);
  if (!src) return null;
  const copy = { ...src, id: crypto.randomUUID(), name: (src.name || src.host) + ' (kopi)' };
  hosts.push(copy);
  writeHosts(hosts);
  return sanitize(copy);
});

ipcMain.handle('hosts:delete', (_e, id) => {
  writeHosts(readHosts().filter((h) => h.id !== id));
  return true;
});

ipcMain.handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: t('dlg.pickKey'),
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, t) => { clipboard.writeText(String(t)); return true; });

// ---------- Host key-verifikation (trust on first use) ----------
// interactive=false bruges af baggrundsforbindelser (metrik): de spørger aldrig,
// men accepterer kun servere, du allerede har godkendt.
async function verifyHost(wc, host, port, hashHex, cb, interactive = true, problem = {}) {
  const known = readJson(knownFile(), {});
  const key = `[${host}]:${port}`;
  const fp = 'SHA256:' + Buffer.from(hashHex, 'hex').toString('base64').replace(/=+$/, '');
  if (known[key] === fp) return cb(true);
  if (!interactive) { problem.hostKey = known[key] ? 'changed' : 'unknown'; return cb(false); }
  const parent = (wc && BrowserWindow.fromWebContents(wc)) || win;

  if (!known[key]) {
    const r = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: [t('hk.trust'), t('btn.cancel')],
      defaultId: 0, cancelId: 1,
      title: t('hk.newTitle'),
      message: t('hk.newMsg', { host: `${host}:${port}` }),
      detail: t('hk.newDetail', { fp }),
    });
    if (r.response !== 0) return cb(false);
  } else {
    const r = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: [t('hk.abort'), t('hk.replace')],
      defaultId: 0, cancelId: 0,
      title: t('hk.changedTitle'),
      message: t('hk.changedMsg', { host: `${host}:${port}` }),
      detail: t('hk.changedDetail', { old: known[key], new: fp }),
    });
    if (r.response !== 1) return cb(false);
  }
  known[key] = fp;
  writeJson(knownFile(), known);
  cb(true);
}

// ---------- Fælles forbindelsesopsætning ----------
// Bygger ssh2-konfigurationen for en host. Bruges af terminalen og af metrik.
async function buildConfig(h, { password, passphrase, wc, interactive = true, problem = {} } = {}) {
  const port = Number(h.port) || 22;
  const pw = password ?? dec(h.password);
  const cfg = {
    host: h.host, port, username: h.username,
    readyTimeout: 20000, keepaliveInterval: 15000, tryKeyboard: true,
    hostHash: 'sha256',
    hostVerifier: (hash, cb) => { verifyHost(wc, h.host, port, hash, cb, interactive, problem); },
  };
  if (h.authType === 'key') {
    let buf;
    try { buf = fs.readFileSync(expandHome(h.keyPath)); }
    catch (err) { throw new Error(t('err.keyRead', { err: err.message })); }
    // PPK v2/v3, PKCS#8, OpenSSH og PEM konverteres efter behov
    const k = await keyconvert().loadPrivateKey(buf, passphrase ?? dec(h.passphrase));
    cfg.privateKey = k.key;
    if (k.passphrase) cfg.passphrase = k.passphrase;
    if (pw) cfg.password = pw; // fallback hvis serveren også vil have adgangskode
  } else if (h.authType === 'agent') {
    cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined);
    if (!cfg.agent) throw new Error(t('err.noAgent'));
  } else {
    if (!pw && !interactive) { const e = new Error(t('err.needPassword')); e.code = 'NEED_LOGIN'; throw e; }
    cfg.password = pw;
  }
  return { cfg, pw };
}

// ---------- SSH ----------
function send(wc, channel, ...args) {
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
}

ipcMain.handle('ssh:connect', async (e, { sessionId, hostId, adhoc, cols, rows, password, passphrase }) => {
  const h = hostId ? readHosts().find((x) => x.id === hostId) : adhoc;
  if (!h) throw new Error(t('err.hostGone'));
  const wc = e.sender;
  const { cfg, pw } = await buildConfig(h, { password, passphrase, wc });

  return new Promise((resolve, reject) => {
    const old = sessions.get(sessionId);
    if (old) { try { old.conn.end(); } catch {} sessions.delete(sessionId); }

    const conn = new (ssh2().Client)();
    let settled = false;
    sessions.set(sessionId, { conn, stream: null, hostId: hostId || null });

    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw || '')));

    conn.on('ready', () => {
      // Bed serveren om UTF-8-tegnsæt. Uden det tæller zsh/bash fx "⬡" som 3 tegn
      // (3 bytes) i stedet for 1, og så havner markøren forkert efter prompten.
      // Kun LC_CTYPE sættes, så sprog og datoformat på serveren ikke ændres.
      conn.shell({ term: 'xterm-256color', cols, rows }, { env: { LC_CTYPE: 'C.UTF-8' } }, (err, stream) => {
        if (err) { settled = true; conn.end(); return reject(err); }
        const s = sessions.get(sessionId);
        if (!s || s.conn !== conn) { conn.end(); return; }
        s.stream = stream;
        const out = new StringDecoder('utf8');
        const errOut = new StringDecoder('utf8');
        stream.on('data', (d) => send(wc, 'ssh:data', sessionId, out.write(d)));
        stream.stderr.on('data', (d) => send(wc, 'ssh:data', sessionId, errOut.write(d)));
        // 'exit' kommer kun, når shellen selv afslutter (fx 'exit' eller Ctrl+D) –
        // ikke når netværket falder ud. Det bruges til at lukke fanen automatisk.
        stream.on('exit', () => { s.exited = true; });
        stream.on('close', () => conn.end());
        settled = true;
        resolve(true);
      });
    });

    // Kun den aktuelle forbindelse for sessionId må melde lukning til UI'et –
    // ellers kan en gammel, bevidst afbrudt forbindelse lukke en ny genforbindelse.
    const isCurrent = () => sessions.get(sessionId)?.conn === conn;
    let lastError = '';

    conn.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
      else lastError = err.message;
    });

    conn.on('close', () => {
      const current = isCurrent();
      const exited = !!sessions.get(sessionId)?.exited;
      if (current) sessions.delete(sessionId);
      if (!settled) { settled = true; reject(new Error(t('err.closed'))); }
      else if (current) send(wc, 'ssh:closed', sessionId, lastError, exited);
    });

    conn.connect(cfg);
  });
});

ipcMain.on('ssh:write', (_e, id, data) => { sessions.get(id)?.stream?.write(data); });
ipcMain.on('ssh:resize', (_e, id, cols, rows) => { sessions.get(id)?.stream?.setWindow(rows, cols, 0, 0); });
ipcMain.on('ssh:disconnect', (_e, id) => {
  const s = sessions.get(id);
  if (s) { sessions.delete(id); try { s.conn.end(); } catch {} }
});

// ---------- Filoverførsel og metrik ----------
require('./sftp').register({ ipcMain, sessions, send, dialog, app, shell, getWin: () => win });
require('./local').register({ ipcMain, shell });
const metrics = require('./metrics').register({ ipcMain, sessions, readHosts, buildConfig, ssh2 });
require('./ping').register({ ipcMain, sessions, readHosts });
app.on('before-quit', () => metrics.closeAll());
