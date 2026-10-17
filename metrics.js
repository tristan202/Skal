// Serverstatus til Hosts-oversigten.
// Bruger en åben terminalsession til hosten, hvis der er en. Ellers holdes en
// stille baggrundsforbindelse åben, så længe oversigten bliver vist – den lukkes
// automatisk efter 3 minutter uden brug. Baggrundsforbindelser spørger aldrig om
// noget: kun servere med gemt login og en allerede godkendt host-nøgle bruges.
'use strict';
const { t } = require('./renderer/strings.js');

const SCRIPT = `export LC_ALL=C
echo @@os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@ncpu; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@mem; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo @@stat1; head -1 /proc/stat
sleep 1
echo @@stat2; head -1 /proc/stat
echo @@df; df -kPT 2>/dev/null || df -kP
echo @@end`;
const COMMAND = `sh -c '${SCRIPT.replace(/'/g, `'\\''`)}'`;

const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|ramfs|autofs|proc|sysfs|cgroup2?|nsfs|devfs|fuse\.lxcfs|tracefs|debugfs|securityfs|pstore|bpf|mqueue|hugetlbfs|configfs|fusectl|binfmt_misc|rpc_pipefs|nfsd)$/;

function parse(out) {
  const sec = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) { cur = m[1]; sec[cur] = []; } else if (cur && line.trim()) sec[cur].push(line.trim());
  }
  if (!sec.stat1?.length || !sec.mem?.length) {
    const e = new Error('no /proc');
    e.code = 'UNSUPPORTED';
    throw e;
  }

  const r = { os: sec.os?.[0] || '' };
  r.uptime = parseFloat(sec.uptime?.[0]) || 0;
  r.load = (sec.load?.[0] || '').split(/\s+/).slice(0, 3).map(Number);
  r.ncpu = parseInt(sec.ncpu?.[0], 10) || 1;

  const mem = {};
  for (const l of sec.mem) { const [k, v] = l.split(/:\s+/); mem[k] = parseInt(v, 10) * 1024; }
  const avail = mem.MemAvailable ?? (mem.MemFree + (mem.Buffers || 0) + (mem.Cached || 0));
  r.mem = { total: mem.MemTotal, used: mem.MemTotal - avail, pct: mem.MemTotal ? (1 - avail / mem.MemTotal) * 100 : 0 };
  r.swap = { total: mem.SwapTotal || 0, used: (mem.SwapTotal || 0) - (mem.SwapFree || 0) };

  const cpu = (l) => {
    const n = l.split(/\s+/).slice(1, 9).map(Number);
    return { idle: n[3] + (n[4] || 0), total: n.reduce((a, b) => a + (b || 0), 0) };
  };
  if (sec.stat2?.length) {
    const a = cpu(sec.stat1[0]), b = cpu(sec.stat2[0]);
    const dt = b.total - a.total;
    r.cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dt) * 100)) : 0;
  }

  r.disks = [];
  const rows = sec.df || [];
  const typed = /\bType\b/.test(rows[0] || '');
  for (const l of rows.slice(1)) {
    const f = l.split(/\s+/);
    const [fs, type, size, used, , , ...mnt] = typed ? f : [f[0], '', ...f.slice(1)];
    const mount = mnt.join(' ');
    if (!mount || !(+size > 0)) continue;
    if (typed ? SKIP_FS.test(type) : /^(tmpfs|devtmpfs|overlay|none|udev|shm)$/.test(fs)) continue;
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) || mount.startsWith('/snap/')) continue;
    r.disks.push({ mount, total: +size * 1024, used: +used * 1024, pct: (+used / +size) * 100 });
  }
  r.disks.sort((a, b) => (b.mount === '/') - (a.mount === '/') || b.total - a.total);
  r.disks = r.disks.slice(0, 6);
  return r;
}

function register({ ipcMain, sessions, readHosts, buildConfig, ssh2 }) {
  const pool = new Map();     // hostId -> { conn, ready, sig, lastUsed, failed }
  const inflight = new Map(); // hostId -> Promise

  const sigOf = (h) => [h.host, h.port, h.username, h.authType, h.keyPath, h.password, h.passphrase].join('|');

  function liveConn(hostId) {
    for (const s of sessions.values()) if (s.hostId === hostId && s.stream) return s.conn;
    return null;
  }

  function connectPool(h) {
    const entry = { conn: null, sig: sigOf(h), lastUsed: Date.now(), failed: null };
    const problem = {};
    entry.ready = (async () => {
      const { cfg, pw } = await buildConfig(h, { interactive: false, problem });
      cfg.readyTimeout = 10000;
      return new Promise((res, rej) => {
        const conn = new (ssh2().Client)();
        entry.conn = conn;
        conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw || '')));
        conn.on('ready', () => res(conn));
        conn.on('error', (err) => {
          if (problem.hostKey) { err = new Error(problem.hostKey); err.code = 'HOSTKEY_' + problem.hostKey.toUpperCase(); }
          rej(err);
        });
        conn.on('close', () => {
          if (pool.get(h.id) === entry && !entry.failed) pool.delete(h.id);
          rej(new Error(t('err.closed')));
        });
        conn.connect(cfg);
      });
    })();
    entry.ready.catch((err) => {
      // Manglende login tjekkes billigt hver gang; andre fejl venter 30 sek.
      if (err.code === 'NEED_LOGIN' || err.code === 'NEED_PASSPHRASE') pool.delete(h.id);
      else entry.failed = { err, until: Date.now() + 30000 };
      try { entry.conn?.end(); } catch {}
    });
    pool.set(h.id, entry);
    return entry;
  }

  function getConn(h) {
    const live = liveConn(h.id);
    if (live) return Promise.resolve(live);
    let entry = pool.get(h.id);
    if (entry && entry.sig !== sigOf(h)) { try { entry.conn?.end(); } catch {} pool.delete(h.id); entry = null; }
    if (entry?.failed) {
      if (entry.failed.until > Date.now()) return Promise.reject(entry.failed.err);
      pool.delete(h.id); entry = null;
    }
    if (!entry) entry = connectPool(h);
    entry.lastUsed = Date.now();
    return entry.ready;
  }

  function exec(conn) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('ETIMEDOUT')), 15000);
      conn.exec(COMMAND, (err, stream) => {
        if (err) { clearTimeout(timer); return rej(err); }
        let out = '';
        stream.on('data', (d) => { out += d; });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(timer); res(out); });
      });
    });
  }

  // Brugerfladen oversætter msgKey; message er en reserve med den rå fejltekst
  function reasonOf(err) {
    const m = err.message || '';
    switch (err.code) {
      case 'NEED_LOGIN': case 'NEED_PASSPHRASE': return { reason: 'login', msgKey: 'm.needLogin' };
      case 'HOSTKEY_UNKNOWN': return { reason: 'hostkey', msgKey: 'm.hostUnknown' };
      case 'HOSTKEY_CHANGED': return { reason: 'hostkey', msgKey: 'm.hostChanged' };
      case 'UNSUPPORTED': return { reason: 'unsupported', msgKey: 'm.notLinux' };
      default: {
        const msgKey = /auth/i.test(m) ? 'm.authFailed'
          : /ECONNREFUSED/.test(m) ? 'm.refused'
          : /ETIMEDOUT|timed out/i.test(m) ? 'm.timeout'
          : /ENOTFOUND|EAI_AGAIN/.test(m) ? 'm.unknownHost'
          : /EHOSTUNREACH|ENETUNREACH/.test(m) ? 'm.unreachable'
          : null;
        return { reason: 'offline', msgKey, message: m };
      }
    }
  }

  async function fetchOne(h) {
    try {
      const conn = await getConn(h);
      return { ok: true, at: Date.now(), ...parse(await exec(conn)) };
    } catch (err) {
      return { ok: false, at: Date.now(), ...reasonOf(err) };
    }
  }

  ipcMain.handle('metrics:get', async (_e, ids) => {
    const hosts = readHosts().filter((h) => ids.includes(h.id));
    const out = {};
    await Promise.all(hosts.map(async (h) => {
      if (!inflight.has(h.id)) inflight.set(h.id, fetchOne(h).finally(() => inflight.delete(h.id)));
      out[h.id] = await inflight.get(h.id);
    }));
    return out;
  });

  // Luk baggrundsforbindelser, der ikke har været brugt i 3 minutter
  setInterval(() => {
    const cutoff = Date.now() - 3 * 60000;
    for (const [id, e] of pool) if (e.lastUsed < cutoff) { try { e.conn?.end(); } catch {} pool.delete(id); }
  }, 60000).unref();

  return {
    closeAll() { for (const e of pool.values()) { try { e.conn?.end(); } catch {} } pool.clear(); },
  };
}

module.exports = { register, parse };
