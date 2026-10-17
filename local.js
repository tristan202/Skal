// Den lokale side af fil-commanderen.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { t } = require('./renderer/strings.js');

// Windows' skjulte/system-filer kan ikke aflæses fra Node, så de mest kendte skjules efter navn
const WIN_HIDDEN = /^(\$.*|desktop\.ini|thumbs\.db|ntuser\..*|system volume information|pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log.*|recovery|config\.msi|documents and settings)$/i;

function register({ ipcMain, shell }) {
  ipcMain.handle('local:info', () => ({ home: os.homedir(), sep: path.sep, platform: process.platform }));

  ipcMain.handle('local:drives', async () => {
    if (process.platform !== 'win32') return ['/'];
    const out = [];
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      try { await fsp.access(c + ':\\'); out.push(c + ':\\'); } catch {}
    }
    return out;
  });

  ipcMain.handle('local:list', async (_e, dir) => {
    const real = path.resolve(dir || os.homedir());
    const dirents = await fsp.readdir(real, { withFileTypes: true });
    const entries = (await Promise.all(dirents.map(async (d) => {
      const full = path.join(real, d.name);
      const hidden = d.name.startsWith('.') || (process.platform === 'win32' && WIN_HIDDEN.test(d.name));
      try {
        const st = await fsp.stat(full);
        return { name: d.name, isDir: st.isDirectory(), isLink: d.isSymbolicLink(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000), hidden };
      } catch {
        // Låste filer (fx pagefile.sys) og døde links vises uden detaljer
        return { name: d.name, isDir: d.isDirectory(), isLink: d.isSymbolicLink(), size: 0, mtime: 0, hidden: true };
      }
    })));
    const parent = path.dirname(real);
    return { path: real, parent: parent === real ? null : parent, entries };
  });

  ipcMain.handle('local:mkdir', async (_e, p) => { await fsp.mkdir(p); return true; });
  ipcMain.handle('local:rename', async (_e, from, to) => {
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(t('err.nameExists'));
    await fsp.rename(from, to);
    return true;
  });
  // Lokale filer slettes aldrig permanent – de lægges i papirkurven
  ipcMain.handle('local:trash', async (_e, paths) => { for (const p of paths) await shell.trashItem(p); return true; });
  ipcMain.handle('local:existing', async (_e, dir, names) => {
    const have = new Set((await fsp.readdir(dir)).map((n) => (process.platform === 'win32' ? n.toLowerCase() : n)));
    return names.filter((n) => have.has(process.platform === 'win32' ? n.toLowerCase() : n));
  });
  ipcMain.handle('local:open', async (_e, p) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });
}

module.exports = { register };
