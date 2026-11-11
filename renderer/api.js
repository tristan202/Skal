/* global I18N */
// Broen mellem brugerfladen og Rust-backenden (afløser Electrons preload.js).
// Giver samme window.api som før, så resten af brugerfladen er uændret.
'use strict';

(() => {
  const T = window.__TAURI__;
  const { invoke, Channel } = T.core;
  const on = (name, fn) => T.event.listen(name, (e) => fn(e.payload));
  const tr = (k, v) => I18N.t(k, v);

  // Fejl fra Rust er { code, key, params, message }. key oversættes her, så fejlen
  // vises på brugerens sprog. Koden står forrest ("NEED_PASSPHRASE: …"), så
  // errCode/cleanErr i renderer.js virker som før.
  const errText = (e) => (e && typeof e === 'object' ? (e.key ? tr(e.key, e.params) : e.message) : String(e ?? ''));
  const toError = (e) => new Error((e?.code ? e.code + ': ' : '') + errText(e));
  const call = (cmd, args) => invoke(cmd, args).catch((e) => { throw toError(e); });
  const withErrText = (r) => (r?.error && typeof r.error === 'object' ? { ...r, error: errText(r.error) } : r);

  let home = '';
  invoke('local_info').then((i) => { home = i.home; });

  // ---------- Host key-verifikation (trust on first use) ----------
  on('hostkey-ask', async ({ id, host, fp, old }) => {
    const ok = old
      ? await T.dialog.ask(`${tr('hk.changedMsg', { host })}\n\n${tr('hk.changedDetail', { old, new: fp })}`, {
        title: tr('hk.changedTitle'), kind: 'warning', okLabel: tr('hk.replace'), cancelLabel: tr('hk.abort'),
      })
      : await T.dialog.ask(`${tr('hk.newMsg', { host })}\n\n${tr('hk.newDetail', { fp })}`, {
        title: tr('hk.newTitle'), kind: 'info', okLabel: tr('hk.trust'), cancelLabel: tr('btn.cancel'),
      });
    invoke('hostkey_answer', { id, ok });
  });

  // ---------- Serverstatus ----------
  // Backenden returnerer det rå output fra serveren; det fortolkes her.
  const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|ramfs|autofs|proc|sysfs|cgroup2?|nsfs|devfs|fuse\.lxcfs|tracefs|debugfs|securityfs|pstore|bpf|mqueue|hugetlbfs|configfs|fusectl|binfmt_misc|rpc_pipefs|nfsd)$/;

  function parse(out) {
    const sec = {};
    let cur = null;
    for (const line of out.split('\n')) {
      const m = line.match(/^@@(\w+)$/);
      if (m) { cur = m[1]; sec[cur] = []; } else if (cur && line.trim()) sec[cur].push(line.trim());
    }
    if (!sec.stat1?.length || !sec.mem?.length) return null;

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

  // Brugerfladen oversætter msgKey; message er en reserve med den rå fejltekst
  function reasonOf(e) {
    switch (e?.code) {
      case 'NEED_LOGIN': case 'NEED_PASSPHRASE': return { reason: 'login', msgKey: 'm.needLogin' };
      case 'HOSTKEY_UNKNOWN': return { reason: 'hostkey', msgKey: 'm.hostUnknown' };
      case 'HOSTKEY_CHANGED': return { reason: 'hostkey', msgKey: 'm.hostChanged' };
      case 'UNSUPPORTED': return { reason: 'unsupported', msgKey: 'm.notLinux' };
      default: return { reason: 'offline', msgKey: e?.key?.startsWith('m.') ? e.key : null, message: errText(e) };
    }
  }

  async function metrics(ids) {
    const res = await invoke('metrics_get', { ids });
    const out = {};
    for (const [id, r] of Object.entries(res)) {
      const m = r.ok && parse(r.raw);
      out[id] = m ? { ok: true, at: r.at, ...m } : { ok: false, at: r.at, ...reasonOf(r.ok ? { code: 'UNSUPPORTED' } : r.error) };
    }
    return out;
  }

  // ---------- Terminal ----------
  let dataFn = () => {};
  // IPC-kald kan ellers overhale hinanden, og så bytter tastetryk plads
  let writes = Promise.resolve();

  window.api = {
    canEncrypt: () => call('can_encrypt'),
    setLang: async (l) => l, // dialoger og fejl oversættes i brugerfladen
    locale: async () => navigator.language,
    listHosts: () => call('hosts_list'),
    saveHost: (h) => call('hosts_save', { input: h }),
    duplicateHost: (id) => call('hosts_duplicate', { id }),
    deleteHost: (id) => call('hosts_delete', { id }),
    pickKey: () => T.dialog.open({ title: tr('dlg.pickKey'), defaultPath: home ? `${home}\\.ssh` : undefined }),
    clipRead: () => T.clipboardManager.readText().catch(() => ''),
    clipWrite: (t) => T.clipboardManager.writeText(String(t)).then(() => true),

    connect: (opts) => {
      const onData = new Channel();
      onData.onmessage = (d) => dataFn(opts.sessionId, d);
      return call('ssh_connect', { ...opts, onData });
    },
    write: (id, data) => { writes = writes.then(() => invoke('ssh_write', { id, data })).catch(() => {}); },
    resize: (id, cols, rows) => { invoke('ssh_resize', { id, cols, rows }); },
    disconnect: (id) => { invoke('ssh_disconnect', { id }); },
    onData: (fn) => { dataFn = fn; },
    onClosed: (fn) => on('ssh-closed', (p) => fn(p.id, p.msg, p.exited)),

    // Filoverførsel
    sftp: {
      list: (sid, dir) => call('sftp_list', { sid, dir }),
      mkdir: (sid, path) => call('sftp_mkdir', { sid, path }),
      rename: (sid, from, to) => call('sftp_rename', { sid, from, to }),
      remove: (sid, path) => call('sftp_delete', { sid, path }),
      existing: (sid, dir, names) => call('sftp_existing', { sid, dir, names }),
      upload: (sid, id, paths, dir) => call('sftp_upload', { sid, id, paths, dir }).then(withErrText),
      download: (sid, id, items, dir, opts) => call('sftp_download', { sid, id, items, dir, opts }).then(withErrText),
      cancel: (id) => call('sftp_cancel', { id }),
      pickUpload: async (folders) => (await T.dialog.open({
        title: tr(folders ? 'dlg.uploadFolders' : 'dlg.uploadFiles'), directory: !!folders, multiple: true,
      })) || [],
      pickDir: () => T.dialog.open({ title: tr('dlg.downloadTo'), directory: true }),
      onProgress: (fn) => on('sftp-progress', (p) => fn(withErrText(p))),
      edit: (sid, path) => call('sftp_edit', { sid, path }),
      stopEdits: (sid) => call('sftp_stop_edits', { sid }),
      onEdited: (fn) => on('sftp-edited', (p) => fn(withErrText(p))),
    },
    // Lokalt filsystem (venstre side i fil-commanderen)
    local: {
      info: () => call('local_info'),
      drives: () => call('local_drives'),
      list: (dir) => call('local_list', { dir }),
      mkdir: (path) => call('local_mkdir', { path }),
      rename: (from, to) => call('local_rename', { from, to }),
      trash: (paths) => call('local_trash', { paths }),
      existing: (dir, names) => call('local_existing', { dir, names }),
      open: (path) => call('local_open', { path }),
    },
    showItem: (path) => call('show_item', { path }),
    // Filer trukket ind fra Stifinder: { type: 'enter'|'over'|'drop'|'leave', paths, x, y }
    onFileDrop: (fn) => T.webview.getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      const r = window.devicePixelRatio || 1;
      fn({ type: p.type, paths: p.paths || [], x: (p.position?.x ?? 0) / r, y: (p.position?.y ?? 0) / r });
    }),

    // Serverstatus
    metrics,
    ping: (ids) => call('ping_check', { ids }),

    // Import, SSH-nøgle og snippets
    importScan: () => call('hosts_import_scan'),
    importHosts: (items) => call('hosts_import', { items }),
    keySetup: (hostId, password) => call('key_setup', { hostId, password }),
    snippetsGet: () => call('snippets_get'),
    snippetsSet: (list) => call('snippets_set', { list }),

    // Windows-notifikation (advarsler)
    notify: async (title, body) => {
      const n = T.notification;
      if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== 'granted') return;
      n.sendNotification({ title, body });
    },
    // Ny version på GitHub? null hvis ikke (eller hvis tjekket fejler, fx uden net)
    checkUpdate: () => T.updater.check().catch(() => null),
  };

  // WebView2's egne genveje (genindlæs, udskriv, søg, ny side …) må ikke slå igennem –
  // en genindlæsning ville lukke alle sessioner. Lyttes der på window, har terminalen
  // og filhåndteringen allerede fået tasten.
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (['f3', 'f5', 'f7', 'f12', 'browserback', 'browserforward'].includes(k)
      || (ctrl && 'rpfgusjohntl'.includes(k) && k.length === 1)
      || (e.altKey && (k === 'arrowleft' || k === 'arrowright'))) e.preventDefault();
  });
  // Browserens egen højrekliksmenu giver ingen mening i en app (undtagen i tekstfelter)
  window.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });
})();
