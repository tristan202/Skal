// Tilgængelighed til den grønne/røde prik på Hosts-siden.
// Der logges ikke ind: Skal åbner blot SSH-porten, læser serverens
// identifikation ("SSH-2.0-OpenSSH_9.6 …"), svarer pænt med sin egen og lukker.
'use strict';
const net = require('net');

const errKey = (code) => ({
  ECONNREFUSED: 'm.refused',
  ETIMEDOUT: 'm.timeout',
  ENOTFOUND: 'm.unknownHost',
  EAI_AGAIN: 'm.unknownHost',
  EHOSTUNREACH: 'm.unreachable',
  ENETUNREACH: 'm.unreachable',
}[code] || null);

function probe(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false, buf = '';
    const sock = net.connect({ host, port });
    const finish = (r, graceful) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceful) { sock.end('SSH-2.0-Skal_status\r\n'); setTimeout(() => sock.destroy(), 1000); }
      else sock.destroy();
      resolve({ ...r, at: Date.now() });
    };
    const timer = setTimeout(() => finish({ ok: false, msgKey: 'm.timeout' }), timeout);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const line = buf.split(/\r?\n/).find((l) => l.startsWith('SSH-'));
      if (line) finish({ ok: true, ms: Date.now() - t0, banner: line.trim().slice(0, 80) }, true);
      else if (buf.length > 4096) finish({ ok: false, msgKey: 'ping.notSsh' });
    });
    sock.on('error', (e) => finish({ ok: false, msgKey: errKey(e.code), message: e.message }));
    sock.on('close', () => finish({ ok: false, msgKey: 'ping.notSsh' }));
  });
}

function register({ ipcMain, sessions, readHosts }) {
  const inflight = new Map();
  ipcMain.handle('ping:check', async (_e, ids) => {
    const hosts = readHosts().filter((h) => ids.includes(h.id));
    const out = {};
    await Promise.all(hosts.map(async (h) => {
      // Er der allerede en åben session, er serveren beviseligt oppe
      for (const s of sessions.values()) {
        if (s.hostId === h.id && s.stream) { out[h.id] = { ok: true, session: true, at: Date.now() }; return; }
      }
      if (!inflight.has(h.id)) {
        inflight.set(h.id, probe(h.host, Number(h.port) || 22).finally(() => inflight.delete(h.id)));
      }
      out[h.id] = await inflight.get(h.id);
    }));
    return out;
  });
}

module.exports = { register, probe };
