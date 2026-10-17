// Filoverførsel over SFTP. Genbruger terminalsessionens SSH-forbindelse,
// så der ikke skal logges ind igen.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;
const os = require('os');
const { t } = require('./renderer/strings.js');

const call = (sftp, fn, ...args) =>
  new Promise((res, rej) => sftp[fn](...args, (err, v) => (err ? rej(friendly(err)) : res(v))));

function friendly(err) {
  const key = { 2: 'err.notFound', 3: 'err.denied', 4: 'err.failed' }[err?.code];
  const msg = key && t(key);
  const e = new Error(msg || err?.message || String(err));
  e.code = err?.code;
  return e;
}

function register({ ipcMain, sessions, send, dialog, app, shell, getWin }) {
  const session = (sid) => {
    const s = sessions.get(sid);
    if (!s || !s.stream) throw new Error(t('err.notConnected'));
    return s;
  };

  // Ny SFTP-kanal på den eksisterende forbindelse
  const openSftp = (sid) => new Promise((res, rej) => {
    session(sid).conn.sftp((err, sftp) => (err ? rej(new Error(t('err.noSftp', { err: err.message }))) : res(sftp)));
  });

  // Én delt kanal pr. session til at liste, omdøbe osv.
  function getSftp(sid) {
    const s = session(sid);
    if (!s.sftpP) {
      s.sftpP = openSftp(sid).then((sftp) => {
        sftp.on('close', () => { s.sftpP = null; });
        return sftp;
      }, (e) => { s.sftpP = null; throw e; });
    }
    return s.sftpP;
  }

  // ---------- Browse ----------
  ipcMain.handle('sftp:list', async (_e, sid, dir) => {
    const sftp = await getSftp(sid);
    const real = await call(sftp, 'realpath', dir || '.');
    const list = await call(sftp, 'readdir', real);
    const entries = await Promise.all(list.map(async (it) => {
      const a = it.attrs;
      const isLink = a.isSymbolicLink();
      let isDir = a.isDirectory();
      if (isLink) { try { isDir = (await call(sftp, 'stat', posix.join(real, it.filename))).isDirectory(); } catch {} }
      return { name: it.filename, isDir, isLink, size: a.size, mtime: a.mtime, mode: a.mode };
    }));
    return { path: real, entries };
  });

  ipcMain.handle('sftp:mkdir', async (_e, sid, p) => { await call(await getSftp(sid), 'mkdir', p); return true; });
  ipcMain.handle('sftp:rename', async (_e, sid, from, to) => { await call(await getSftp(sid), 'rename', from, to); return true; });
  ipcMain.handle('sftp:delete', async (_e, sid, p) => { await rmrf(await getSftp(sid), p); return true; });
  ipcMain.handle('sftp:existing', async (_e, sid, dir, names) => {
    const list = await call(await getSftp(sid), 'readdir', dir);
    const have = new Set(list.map((x) => x.filename));
    return names.filter((n) => have.has(n));
  });

  async function rmrf(sftp, p) {
    const st = await call(sftp, 'lstat', p);
    if (st.isDirectory()) {
      for (const it of await call(sftp, 'readdir', p)) await rmrf(sftp, posix.join(p, it.filename));
      await call(sftp, 'rmdir', p);
    } else {
      await call(sftp, 'unlink', p);
    }
  }

  // ---------- Overførsler ----------
  const transfers = new Map(); // id -> { sftp, cancelled }

  function reporter(wc, id, total) {
    let last = 0;
    return (done, file, force) => {
      const now = Date.now();
      if (!force && now - last < 120) return;
      last = now;
      send(wc, 'sftp:progress', { id, done, total, file, state: 'running' });
    };
  }

  async function runTransfer(wc, id, work) {
    const t = { sftp: null, cancelled: false };
    transfers.set(id, t);
    try {
      const result = await work(t);
      send(wc, 'sftp:progress', { id, state: 'done', ...result });
      return result;
    } catch (e) {
      const state = t.cancelled ? 'cancelled' : 'error';
      send(wc, 'sftp:progress', { id, state, error: t.cancelled ? '' : e.message });
      return { error: e.message, state };
    } finally {
      transfers.delete(id);
      try { t.sftp?.end(); } catch {}
    }
  }

  const checkCancel = (tr) => { if (tr.cancelled) throw new Error(t('err.cancelled')); };

  ipcMain.handle('sftp:cancel', (_e, id) => {
    const t = transfers.get(id);
    if (t) { t.cancelled = true; try { t.sftp?.end(); } catch {} } // lukker kanalen = stopper midt i en fil
    return true;
  });

  // Upload: lokale filer og mapper -> remoteDir
  ipcMain.handle('sftp:upload', (e, sid, id, localPaths, remoteDir) => runTransfer(e.sender, id, async (t) => {
    const plan = { dirs: [], files: [] };
    async function walk(local, remote, depth = 0) {
      const st = await fsp.lstat(local);
      if (st.isSymbolicLink()) {
        const real = await fsp.stat(local).catch(() => null);
        if (real?.isFile()) plan.files.push({ local, remote, size: real.size });
        return; // links til mapper følges ikke (undgår løkker)
      }
      if (st.isDirectory()) {
        if (depth > 40) return;
        plan.dirs.push(remote);
        for (const n of await fsp.readdir(local)) await walk(path.join(local, n), posix.join(remote, n), depth + 1);
      } else if (st.isFile()) {
        plan.files.push({ local, remote, size: st.size });
      }
    }
    for (const lp of localPaths) await walk(lp, posix.join(remoteDir, path.basename(lp)));

    const total = plan.files.reduce((a, f) => a + f.size, 0);
    const report = reporter(e.sender, id, total);
    report(0, '', true);
    t.sftp = await openSftp(sid);
    checkCancel(t);

    for (const d of plan.dirs) {
      try { await call(t.sftp, 'mkdir', d); }
      catch (err) { const st = await call(t.sftp, 'stat', d).catch(() => null); if (!st?.isDirectory()) throw err; }
    }
    let done = 0;
    for (const f of plan.files) {
      checkCancel(t);
      await call(t.sftp, 'fastPut', f.local, f.remote, { step: (sent) => report(done + sent, path.basename(f.local)) });
      done += f.size;
      report(done, path.basename(f.local), true);
    }
    return { done: total, total, files: plan.files.length };
  }));

  // Download: fjernfiler og -mapper -> localDir (standard: Overførsler)
  ipcMain.handle('sftp:download', (e, sid, id, items, localDir, opts = {}) => runTransfer(e.sender, id, async (t) => {
    const target = localDir || app.getPath('downloads');
    t.sftp = await openSftp(sid);
    const plan = { dirs: [], files: [] };
    const tops = [];

    async function walk(remote, local, depth = 0) {
      checkCancel(t);
      const st = await call(t.sftp, 'stat', remote);
      if (st.isDirectory()) {
        if (depth > 40) return;
        plan.dirs.push(local);
        for (const it of await call(t.sftp, 'readdir', remote)) {
          await walk(posix.join(remote, it.filename), path.join(local, safeName(it.filename)), depth + 1);
        }
      } else {
        plan.files.push({ remote, local, size: st.size });
      }
    }
    for (const it of items) {
      const dest = path.join(target, safeName(posix.basename(it.path)));
      const local = opts.overwrite ? dest : await uniquePath(dest);
      tops.push(local);
      await walk(it.path, local);
    }

    const total = plan.files.reduce((a, f) => a + f.size, 0);
    const report = reporter(e.sender, id, total);
    report(0, '', true);
    for (const d of plan.dirs) await fsp.mkdir(d, { recursive: true });
    let done = 0;
    for (const f of plan.files) {
      checkCancel(t);
      await call(t.sftp, 'fastGet', f.remote, f.local, { step: (got) => report(done + got, posix.basename(f.remote)) });
      done += f.size;
      report(done, posix.basename(f.remote), true);
    }
    return { done: total, total, files: plan.files.length, localPath: tops[0] };
  }));

  // Windows tillader ikke alle tegn i filnavne
  function safeName(n) {
    return process.platform === 'win32' ? n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') : n;
  }
  async function uniquePath(p) {
    const { dir, name, ext } = path.parse(p);
    for (let i = 0; ; i++) {
      const candidate = i ? path.join(dir, `${name} (${i})${ext}`) : p;
      try { await fsp.access(candidate); } catch { return candidate; }
    }
  }

  // ---------- Redigér fjernfil lokalt (som i WinSCP) ----------
  // Filen hentes til en midlertidig mappe og åbnes i standardprogrammet.
  // Hver gang den gemmes, uploades den automatisk tilbage til serveren.
  const edits = new Map(); // lokal sti -> { sid, remote, watcher, timer, mtime, dir }

  ipcMain.handle('sftp:edit', async (e, sid, remote) => {
    // Er filen allerede åben, genbruges den lokale kopi
    for (const [local, ed] of edits) {
      if (ed.sid === sid && ed.remote === remote) { await openLocal(local); return local; }
    }
    const sftp = await getSftp(sid);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skal-'));
    const local = path.join(dir, safeName(posix.basename(remote)));
    await call(sftp, 'fastGet', remote, local);
    const ed = { sid, remote, dir, timer: null, mtime: (await fsp.stat(local)).mtimeMs };
    // Mappen overvåges (ikke filen), fordi mange editorer gemmer ved at erstatte filen
    ed.watcher = fs.watch(dir, () => {
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => pushEdit(e.sender, local, ed), 500);
    });
    edits.set(local, ed);
    await openLocal(local);
    return local;
  });

  async function openLocal(p) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  }

  async function pushEdit(wc, local, ed) {
    let st;
    try { st = await fsp.stat(local); } catch { return; }
    if (st.mtimeMs === ed.mtime) return;
    ed.mtime = st.mtimeMs;
    const name = posix.basename(ed.remote);
    try {
      await call(await getSftp(ed.sid), 'fastPut', local, ed.remote);
      send(wc, 'sftp:edited', { sid: ed.sid, remote: ed.remote, name, ok: true });
    } catch (err) {
      send(wc, 'sftp:edited', { sid: ed.sid, remote: ed.remote, name, ok: false, error: err.message });
    }
  }

  function stopEdits(sid) {
    for (const [local, ed] of edits) {
      if (sid && ed.sid !== sid) continue;
      try { ed.watcher.close(); } catch {}
      clearTimeout(ed.timer);
      fs.rm(ed.dir, { recursive: true, force: true }, () => {});
      edits.delete(local);
    }
  }
  ipcMain.handle('sftp:stopEdits', (_e, sid) => { stopEdits(sid); return true; });
  app.on('before-quit', () => stopEdits(null));

  // ---------- Dialoger ----------
  ipcMain.handle('sftp:pickUpload', async (_e, folders) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: folders ? t('dlg.uploadFolders') : t('dlg.uploadFiles'),
      properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('sftp:pickDir', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: t('dlg.downloadTo'), defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
}

module.exports = { register };
