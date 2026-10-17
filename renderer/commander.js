/* global api, I18N */
// Dual-pane filhåndtering i stil med Total Commander / mc:
// venstre side er denne computer, højre side er serveren.
'use strict';

const Commander = (() => {
  const progressHandlers = new Map(); // transfer-id -> fn
  api.sftp.onProgress((p) => progressHandlers.get(p.id)?.(p));
  const editHandlers = new Map();     // session-id -> fn
  api.sftp.onEdited((p) => editHandlers.get(p.sid)?.(p));
  let local = { home: '', sep: '\\', platform: 'win32' };
  const localReady = api.local.info().then((i) => { local = i; });

  // ---------- Hjælpere ----------
  const tr = (k, v) => I18N.t(k, v);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
  const posixJoin = (d, n) => (d.endsWith('/') ? d : d + '/') + n;
  const posixParent = (p) => (p === '/' ? null : p.replace(/\/+[^/]+\/*$/, '') || '/');
  const localJoin = (d, n) => (d.endsWith(local.sep) ? d : d + local.sep) + n;
  const cmpName = (a, b) => a.localeCompare(b, 'da', { numeric: true, sensitivity: 'base' });

  function fmtSize(n) {
    if (!(n >= 0)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toLocaleString(I18N.locale, { maximumFractionDigits: i && n < 10 ? 1 : 0 })} ${u[i]}`;
  }
  const fmtDate = (sec) => new Date(sec * 1000).toLocaleString(I18N.locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  function rights(mode, isDir, isLink) {
    if (mode == null) return '';
    const r = (m) => (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
    return (isLink ? 'l' : isDir ? 'd' : '-') + r((mode >> 6) & 7) + r((mode >> 3) & 7) + r(mode & 7);
  }

  // Indtastning direkte i listen (omdøb / ny mappe)
  function inlineInput(host, initial) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.className = 'inline-input'; input.value = initial; input.spellcheck = false;
      host.replaceChildren(input);
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      };
      input.onblur = () => finish(input.value.trim());
      input.onmousedown = (e) => e.stopPropagation();
    });
  }

  let dragging = null; // { pane, items } mens der trækkes mellem siderne

  function create(tab, { writeToTerminal, showTerminal, showCtx }) {
    const sid = tab.id;
    const root = document.createElement('div');
    root.className = 'cmd';
    root.hidden = true;
    root.innerHTML = `
      <div class="cmd-panes"></div>
      <div class="cmd-transfers"></div>
      <div class="cmd-keys">
        <button data-key="F2"><b>F2</b><span data-i18n="key.rename">${tr('key.rename')}</span></button>
        <button data-key="F4"><b>F4</b><span data-i18n="key.open">${tr('key.open')}</span></button>
        <button data-key="F5"><b>F5</b><span data-i18n="key.copy">${tr('key.copy')}</span></button>
        <button data-key="F6"><b>F6</b><span data-i18n="key.move">${tr('key.move')}</span></button>
        <button data-key="F7"><b>F7</b><span data-i18n="key.mkdir">${tr('key.mkdir')}</span></button>
        <button data-key="F8"><b>F8</b><span data-i18n="key.delete">${tr('key.delete')}</span></button>
        <span class="spacer"></span>
        <span class="cmd-hint" data-i18n-html="cmd.hint">${tr('cmd.hint')}</span>
      </div>
      <div class="cmd-toasts"></div>`;
    const panesEl = root.querySelector('.cmd-panes');
    const transfersEl = root.querySelector('.cmd-transfers');
    const toastsEl = root.querySelector('.cmd-toasts');

    function toast(msg, kind = '') {
      const n = document.createElement('div');
      n.className = 'cmd-toast ' + kind;
      n.textContent = msg;
      toastsEl.appendChild(n);
      setTimeout(() => n.remove(), kind === 'error' ? 8000 : 3500);
    }
    editHandlers.set(sid, (p) => {
      toast(p.ok ? tr('cmd.saved', { name: p.name }) : tr('cmd.saveFailed', { name: p.name, err: p.error }), p.ok ? 'ok' : 'error');
      const r = panes[1];
      if (p.ok && r.st.cwd === posixParent(p.remote)) r.reload(r.st.cursor); // vis ny størrelse/tid
    });

    // Lille dialog med valgfrie knapper. Returnerer knappens indeks (Escape = 0).
    function ask(title, text, buttons, primary = buttons.length - 1) {
      return new Promise((resolve) => {
        const m = document.createElement('div');
        m.className = 'cmd-modal';
        m.innerHTML = `<div class="cmd-dialog" role="dialog"><h3>${esc(title)}</h3><p>${esc(text)}</p>
          <div class="modal-actions">${buttons.map((b, i) => `<button class="btn ${i === primary ? 'btn-primary' : ''}" data-i="${i}">${esc(b)}</button>`).join('')}</div></div>`;
        root.appendChild(m);
        const close = (i) => { m.remove(); resolve(i); active().list.focus(); };
        m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) close(+b.dataset.i); };
        m.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(0); };
        m.querySelector(`[data-i="${primary}"]`).focus();
      });
    }

    // ---------- De to sider ----------
    const remoteKey = 'skal.remotePath.' + (tab.hostId || `${tab.host.username}@${tab.host.host}`);
    const sources = {
      local: {
        kind: 'local',
        title: () => tr('cmd.thisComputer'),
        list: (dir) => api.local.list(dir),
        join: (d, n) => localJoin(d, n),
        mkdir: (p) => api.local.mkdir(p),
        rename: (a, b) => api.local.rename(a, b),
        remove: (paths) => api.local.trash(paths),
        existing: (dir, names) => api.local.existing(dir, names),
        openFile: (p) => api.local.open(p),
        save: (p) => localStorage.setItem('skal.localPath', p),
        initial: () => localStorage.getItem('skal.localPath') || null,
        fallback: null,
      },
      remote: {
        kind: 'remote',
        title: () => tab.title,
        list: async (dir) => { const r = await api.sftp.list(sid, dir); return { ...r, parent: posixParent(r.path) }; },
        join: posixJoin,
        mkdir: (p) => api.sftp.mkdir(sid, p),
        rename: (a, b) => api.sftp.rename(sid, a, b),
        remove: async (paths) => { for (const p of paths) await api.sftp.remove(sid, p); },
        existing: (dir, names) => api.sftp.existing(sid, dir, names),
        openFile: async (p) => { toast(tr('cmd.fetching')); await api.sftp.edit(sid, p); toast(tr('cmd.opened'), 'ok'); },
        save: (p) => localStorage.setItem(remoteKey, p),
        initial: () => localStorage.getItem(remoteKey) || '.',
        fallback: '.',
      },
    };

    const panes = [makePane(sources.local), makePane(sources.remote)];
    let activeIdx = 1;
    const active = () => panes[activeIdx];
    const other = (p) => (p === panes[0] ? panes[1] : panes[0]);
    function setActive(p) {
      activeIdx = panes.indexOf(p);
      panes.forEach((x) => x.el.classList.toggle('active', x === p));
    }

    function makePane(src) {
      const st = {
        cwd: null, parent: null, entries: [], view: [], msg: null,
        sort: 'name', dir: 1, hidden: localStorage.getItem('skal.hidden') === '1',
        cursor: null, marked: new Set(),
      };
      const el = document.createElement('section');
      el.className = `pane ${src.kind}`;
      el.innerHTML = `
        <div class="pane-head">
          <span class="pane-kind" data-i18n="${src.kind === 'local' ? 'cmd.local' : 'cmd.server'}"></span>
          <span class="pane-title"></span>
          ${src.kind === 'local' ? '<select class="pane-drive" data-i18n-title="cmd.drive" hidden></select>' : ''}
          <span class="spacer"></span>
          <button class="icon-btn" data-act="hidden" data-i18n-title="cmd.hidden">.*</button>
          <button class="icon-btn" data-act="refresh" data-i18n-title="cmd.refresh">⟳</button>
        </div>
        <div class="pane-path">
          <button class="icon-btn" data-act="up" data-i18n-title="cmd.up">↑</button>
          <input class="path-input" spellcheck="false" />
        </div>
        <div class="pane-cols">
          <span data-sort="name" data-i18n="col.name"></span><span data-sort="size" data-i18n="col.size"></span><span data-sort="mtime" data-i18n="col.modified"></span>
          ${src.kind === 'remote' ? '<span data-i18n="col.rights"></span>' : ''}
        </div>
        <div class="pane-list" tabindex="0"></div>
        <div class="pane-status"></div>`;
      const list = el.querySelector('.pane-list');
      const input = el.querySelector('.path-input');
      const status = el.querySelector('.pane-status');
      const drive = el.querySelector('.pane-drive');
      el.querySelector('[data-act="hidden"]').classList.toggle('on', st.hidden);

      const p = { src, kind: src.kind, el, list, st };
      const find = (name) => st.entries.find((e) => e.name === name);
      p.pathOf = (name) => src.join(st.cwd, name);

      function rows() {
        const k = st.sort, d = st.dir;
        const v = st.entries.filter((e) => st.hidden || !(e.hidden || e.name.startsWith('.')));
        v.sort((a, b) => (b.isDir - a.isDir)
          || (k === 'size' ? (a.size - b.size) * d : k === 'mtime' ? (a.mtime - b.mtime) * d : 0)
          || cmpName(a.name, b.name) * (k === 'name' ? d : 1));
        return st.parent ? [{ name: '..', up: true, isDir: true }, ...v] : v;
      }

      p.render = () => {
        el.querySelector('.pane-title').textContent = src.title();
        input.value = st.cwd || '';
        if (drive && st.cwd) drive.value = st.cwd.slice(0, 3).toUpperCase();
        el.querySelectorAll('.pane-cols [data-sort]').forEach((c) => {
          c.classList.toggle('sorted', c.dataset.sort === st.sort);
          c.dataset.dir = st.dir > 0 ? '▲' : '▼';
        });
        el.querySelector('.path-input').setAttribute('aria-label', tr('cmd.path'));
        if (st.msg) { list.innerHTML = `<div class="pane-msg">${esc(st.msg === 'NC' ? tr('cmd.notConnected') : st.msg)}</div>`; status.textContent = ''; st.view = []; return; }
        st.view = rows();
        if (!st.view.some((r) => r.name === st.cursor)) st.cursor = st.view[0]?.name ?? null;
        list.innerHTML = st.view.length ? st.view.map((r) => `
          <div class="prow${r.isDir ? ' dir' : ''}${r.up ? ' up' : ''}${r.hidden || r.name.startsWith('.') && !r.up ? ' dim' : ''}" data-name="${esc(r.name)}" draggable="${!r.up}">
            <span class="pn"><i class="ic ${r.up ? 'up' : r.isDir ? 'dir' : 'file'}"></i><span class="t">${esc(r.name)}</span>${r.isLink ? '<span class="ln">→</span>' : ''}</span>
            <span class="ps">${r.up ? '' : r.isDir ? `&lt;${tr('cmd.dirTag')}&gt;` : fmtSize(r.size)}</span>
            <span class="pd">${r.up || !r.mtime ? '' : fmtDate(r.mtime)}</span>
            ${src.kind === 'remote' ? `<span class="pr">${r.up ? '' : rights(r.mode, r.isDir, r.isLink)}</span>` : ''}
          </div>`).join('') : `<div class="pane-msg">${tr('cmd.empty')}</div>`;
        p.paint();
      };

      // Opdatér kun markering/markør (hurtigt ved piletaster)
      p.paint = (scroll) => {
        const kids = list.children;
        st.view.forEach((r, i) => {
          const k = kids[i]; if (!k) return;
          k.classList.toggle('cursor', r.name === st.cursor);
          k.classList.toggle('marked', st.marked.has(r.name));
        });
        if (scroll) kids[p.idx()]?.scrollIntoView({ block: 'nearest' });
        const files = st.entries.filter((e) => !e.isDir), dirs = st.entries.length - files.length;
        const m = [...st.marked].map(find).filter(Boolean);
        const msize = m.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
        status.textContent = m.length
          ? `${tr('cmd.marked', { n: m.length })}${msize ? ' · ' + fmtSize(msize) : ''}`
          : `${tr('cmd.dirs', { n: dirs })}, ${tr('cmd.files', { n: files.length })}`;
      };
      p.idx = () => st.view.findIndex((r) => r.name === st.cursor);

      // Markerede elementer – eller elementet under markøren, hvis intet er markeret
      p.targets = () => {
        const m = [...st.marked].map(find).filter(Boolean);
        if (m.length) return m;
        const c = find(st.cursor);
        return c ? [c] : [];
      };

      p.load = async (dir, keep) => {
        try {
          const r = await src.list(dir);
          const prev = st.cwd;
          const changed = r.path !== prev;
          st.cwd = r.path; st.parent = r.parent; st.entries = r.entries; st.msg = null;
          if (changed) {
            st.marked.clear();
            // Går man op, står markøren på den mappe, man kom fra (som i Total Commander)
            const rest = prev && prev.startsWith(r.path) ? prev.slice(r.path.length).replace(/^[\\/]+/, '') : '';
            st.cursor = rest ? rest.split(/[\\/]/)[0] : (keep ?? null);
            list.scrollTop = 0;
          } else {
            for (const n of st.marked) if (!find(n)) st.marked.delete(n);
            if (keep) st.cursor = keep;
          }
          src.save(r.path);
          p.render();
          p.paint(true);
          return true;
        } catch (e) {
          if (!st.cwd) { st.msg = cleanErr(e); p.render(); } else toast(cleanErr(e), 'error');
          return false;
        }
      };
      p.reload = (keep) => (st.cwd ? p.load(st.cwd, keep) : null);
      p.init = async () => {
        if (src.kind === 'remote' && tab.status !== 'connected') { st.msg = 'NC'; p.render(); return; }
        if (!(await p.load(src.initial()))) await p.load(src.fallback);
        if (drive && local.platform === 'win32') {
          const ds = await api.local.drives();
          drive.innerHTML = ds.map((d) => `<option value="${esc(d)}">${esc(d.slice(0, 2))}</option>`).join('');
          drive.hidden = false;
          if (st.cwd) drive.value = st.cwd.slice(0, 3).toUpperCase();
        }
      };
      p.disconnected = () => { st.msg = 'NC'; p.render(); };

      p.move = (to) => {
        if (!st.view.length) return;
        const page = Math.max(1, Math.floor(list.clientHeight / (list.firstElementChild?.offsetHeight || 24)) - 1);
        let i = p.idx();
        i = to === 'home' ? 0 : to === 'end' ? st.view.length - 1 : to === 'pgup' ? i - page : to === 'pgdn' ? i + page : i + to;
        st.cursor = st.view[Math.max(0, Math.min(st.view.length - 1, i))].name;
        p.paint(true);
      };
      p.toggleMark = (name = st.cursor) => {
        if (!name || name === '..') return;
        st.marked.has(name) ? st.marked.delete(name) : st.marked.add(name);
      };
      p.markRange = (a, b) => {
        const names = st.view.map((r) => r.name);
        const [i, j] = [names.indexOf(a), names.indexOf(b)].sort((x, y) => x - y);
        if (i < 0) return;
        names.slice(i, j + 1).forEach((n) => n !== '..' && st.marked.add(n));
      };
      p.open = (name = st.cursor) => {
        if (name === '..') return p.load(st.parent);
        const e = find(name); if (!e) return;
        if (e.isDir) return p.load(p.pathOf(e.name));
        Promise.resolve(src.openFile(p.pathOf(e.name))).catch((err) => toast(cleanErr(err), 'error'));
      };
      p.rowEl = (name) => [...list.children].find((k) => k.dataset.name === name);

      // ---- Hændelser i siden ----
      el.addEventListener('mousedown', () => setActive(p));
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (b) {
          if (b.dataset.act === 'up' && st.parent) p.load(st.parent);
          if (b.dataset.act === 'refresh') p.reload(st.cursor);
          if (b.dataset.act === 'hidden') { st.hidden = !st.hidden; b.classList.toggle('on', st.hidden); localStorage.setItem('skal.hidden', st.hidden ? '1' : '0'); p.render(); }
          list.focus();
          return;
        }
        const c = e.target.closest('.pane-cols [data-sort]');
        if (c) {
          st.dir = st.sort === c.dataset.sort ? -st.dir : 1;
          st.sort = c.dataset.sort;
          p.render();
          list.focus();
        }
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { p.load(input.value.trim() || (src.kind === 'remote' ? '/' : null)); list.focus(); }
        if (e.key === 'Escape') { input.value = st.cwd || ''; list.focus(); }
      });
      drive?.addEventListener('change', () => { p.load(drive.value); list.focus(); });

      list.addEventListener('mousedown', (e) => {
        if (e.target.closest('input')) return;
        const r = e.target.closest('.prow');
        list.focus();
        if (!r) return;
        const name = r.dataset.name;
        if (e.button === 2) {
          if (st.marked.size && !st.marked.has(name)) st.marked.clear();
          st.cursor = name;
        } else if (e.ctrlKey || e.metaKey) {
          p.toggleMark(name); st.cursor = name;
        } else if (e.shiftKey && st.cursor) {
          p.markRange(st.cursor, name); st.cursor = name;
        } else {
          if (!st.marked.has(name)) st.marked.clear();
          st.cursor = name;
        }
        p.paint();
      });
      list.addEventListener('click', (e) => {
        // Almindeligt klik uden at trække: ryd markering ud over den klikkede
        const r = e.target.closest('.prow');
        if (r && !e.ctrlKey && !e.metaKey && !e.shiftKey && st.marked.size) { st.marked.clear(); p.paint(); }
      });
      list.addEventListener('dblclick', (e) => {
        const r = e.target.closest('.prow');
        if (r && !e.target.closest('input')) p.open(r.dataset.name);
      });
      list.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(p, e); });
      list.addEventListener('keydown', (e) => { if (handleKey(p, e)) { e.preventDefault(); e.stopPropagation(); } });

      // ---- Træk og slip ----
      list.addEventListener('dragstart', (e) => {
        const r = e.target.closest('.prow');
        if (!r || r.classList.contains('up')) return e.preventDefault();
        if (!st.marked.has(r.dataset.name)) { st.marked.clear(); st.cursor = r.dataset.name; p.paint(); }
        dragging = { pane: p, items: p.targets() };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', dragging.items.map((i) => i.name).join('\n'));
      });
      list.addEventListener('dragend', () => { dragging = null; clearDrop(); });
      const accepts = (e) => (dragging && dragging.pane !== p) ||
        (!dragging && src.kind === 'remote' && [...(e.dataTransfer?.types || [])].includes('Files'));
      const dropDir = (e) => {
        const r = e.target.closest?.('.prow');
        const entry = r && !r.classList.contains('up') && find(r.dataset.name);
        return { dir: entry?.isDir ? p.pathOf(entry.name) : st.cwd, row: entry?.isDir ? r : null };
      };
      function clearDrop() { document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target')); }
      el.addEventListener('dragover', (e) => {
        if (!accepts(e) || !st.cwd || st.msg) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.shiftKey && dragging ? 'move' : 'copy';
        clearDrop();
        const { row } = dropDir(e);
        (row || el).classList.add('drop-target');
      });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clearDrop(); });
      el.addEventListener('drop', (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        clearDrop();
        const { dir } = dropDir(e);
        setActive(p);
        if (dragging) {
          const d = dragging; dragging = null;
          transfer(d.pane, p, d.items, { move: e.shiftKey, dir });
        } else {
          const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
          uploadPaths(paths, dir);
        }
      });

      panesEl.appendChild(el);
      return p;
    }

    // ---------- Tastatur ----------
    let typed = '', typedAt = 0;
    function handleKey(p, e) {
      const st = p.st, k = e.key, ctrl = e.ctrlKey || e.metaKey;
      if (k.length !== 1 || ctrl || e.altKey) typed = ''; // andre taster nulstiller skriv-for-at-hoppe
      if (ctrl && e.shiftKey) return false; // appens egne genveje (Ctrl+Shift+…)
      if (k === 'Tab' && !ctrl) { const o = other(p); setActive(o); o.list.focus(); return true; }
      if (k === 'ArrowDown') { if (e.shiftKey) p.toggleMark(); p.move(1); return true; }
      if (k === 'ArrowUp') { if (e.shiftKey) p.toggleMark(); p.move(-1); return true; }
      if (k === 'PageDown') { p.move('pgdn'); return true; }
      if (k === 'PageUp') { p.move('pgup'); return true; }
      if (k === 'Home') { p.move('home'); return true; }
      if (k === 'End') { p.move('end'); return true; }
      if (k === 'Enter') { p.open(); return true; }
      if (k === 'Backspace') { if (st.parent) p.load(st.parent); return true; }
      if (k === ' ' || k === 'Insert') { p.toggleMark(); p.move(1); return true; }
      if (k === 'Escape') { if (!st.marked.size) return false; st.marked.clear(); p.paint(); return true; }
      if (ctrl && k.toLowerCase() === 'a') { st.view.forEach((r) => r.name !== '..' && st.marked.add(r.name)); p.paint(); return true; }
      if (ctrl && k.toLowerCase() === 'r') { p.reload(st.cursor); return true; }
      if (ctrl && k.toLowerCase() === 'h') { p.el.querySelector('[data-act="hidden"]').click(); return true; }
      if (/^F[2-8]$/.test(k) || k === 'Delete') return action(p, k === 'Delete' ? 'F8' : k, e.shiftKey);
      // Skriv for at hoppe til en fil
      if (k.length === 1 && !ctrl && !e.altKey) {
        const now = Date.now();
        typed = (now - typedAt < 900 ? typed : '') + k.toLowerCase();
        typedAt = now;
        const hit = st.view.find((r) => !r.up && r.name.toLowerCase().startsWith(typed));
        if (hit) { st.cursor = hit.name; p.paint(true); }
        return true;
      }
      return false;
    }

    function action(p, key, shift) {
      switch (key) {
        case 'F2': rename(p); return true;
        case 'F4': p.open(); return true;
        case 'F5': transfer(p, other(p), p.targets(), {}); return true;
        case 'F6': shift ? rename(p) : transfer(p, other(p), p.targets(), { move: true }); return true;
        case 'F7': mkdir(p); return true;
        case 'F8': remove(p); return true;
        default: return false;
      }
    }
    root.querySelector('.cmd-keys').addEventListener('click', (e) => {
      const b = e.target.closest('[data-key]');
      if (b) { action(active(), b.dataset.key, false); }
    });

    // ---------- Handlinger ----------
    async function rename(p) {
      const st = p.st;
      const name = st.cursor;
      if (!name || name === '..' || st.msg) return;
      const host = p.rowEl(name)?.querySelector('.t');
      if (!host) return;
      const next = await inlineInput(host, name);
      if (!next || next === name || /[\\/]/.test(next)) { p.render(); p.list.focus(); return; }
      try { await p.src.rename(p.pathOf(name), p.pathOf(next)); await p.reload(next); }
      catch (e) { toast(cleanErr(e), 'error'); p.render(); }
      p.list.focus();
    }

    async function mkdir(p) {
      if (!p.st.cwd || p.st.msg) return;
      const row = document.createElement('div');
      row.className = 'prow dir cursor';
      row.innerHTML = '<span class="pn"><i class="ic dir"></i><span class="t"></span></span>';
      const first = p.list.querySelector('.prow:not(.up)');
      first ? p.list.insertBefore(row, first) : p.list.appendChild(row);
      row.scrollIntoView({ block: 'nearest' });
      const name = await inlineInput(row.querySelector('.t'), tr('cmd.newFolder'));
      row.remove();
      if (name && !/[\\/]/.test(name)) {
        try { await p.src.mkdir(p.pathOf(name)); await p.reload(name); }
        catch (e) { toast(cleanErr(e), 'error'); }
      } else p.paint();
      p.list.focus();
    }

    async function remove(p) {
      const items = p.targets();
      if (!items.length || p.st.msg) return;
      const what = items.length === 1 ? tr(items[0].isDir ? 'cmd.whatDir' : 'cmd.whatOne', { name: items[0].name }) : tr('cmd.items', { n: items.length });
      const isLocal = p.kind === 'local';
      const ok = await ask(isLocal ? tr('cmd.trashTitle') : tr('cmd.delTitle'),
        isLocal ? tr('cmd.trashText', { what }) : tr('cmd.delText', { what }),
        [tr('btn.cancel'), isLocal ? tr('cmd.trashBtn') : tr('btn.delete')]);
      if (ok !== 1) return;
      for (const it of items) {
        try { await p.src.remove([p.pathOf(it.name)]); }
        catch (e) { toast(`${it.name}: ${cleanErr(e)}`, 'error'); }
      }
      p.st.marked.clear();
      p.reload();
    }

    // Kopiér/flyt mellem siderne
    async function transfer(from, to, items, { move = false, dir } = {}) {
      if (!items.length || from === to) return;
      if (from.st.msg || to.st.msg || !to.st.cwd) return toast(tr('cmd.serverNotConnected'), 'error');
      const target = dir || to.st.cwd;
      let list = items;
      try {
        const clash = await to.src.existing(target, list.map((i) => i.name));
        if (clash.length) {
          const text = clash.length === 1 ? tr('cmd.existsOne', { name: clash[0], dir: target }) : tr('cmd.existsMany', { n: clash.length, dir: target });
          const a = await ask(tr(move ? 'cmd.existsMove' : 'cmd.existsCopy'), text, [tr('btn.cancel'), tr('btn.skip'), tr('btn.overwrite')]);
          if (a === 0) return;
          if (a === 1) list = list.filter((i) => !clash.includes(i.name));
          if (!list.length) return;
        }
      } catch (e) { return toast(cleanErr(e), 'error'); }

      const label = list.length === 1 ? list[0].name : tr('cmd.items', { n: list.length });
      const up = from.kind === 'local';
      const id = addTransfer(up ? 'up' : 'down', label, move);
      const paths = list.map((i) => from.pathOf(i.name));
      const r = up
        ? await api.sftp.upload(sid, id, paths, target)
        : await api.sftp.download(sid, id, paths.map((path) => ({ path })), target, { overwrite: true });
      if (!r?.error && move) {
        try { await from.src.remove(paths); } catch (e) { toast(tr('cmd.movedNotDeleted', { err: cleanErr(e) }), 'error'); }
        from.st.marked.clear();
      }
      if (!r?.error && !move) { from.st.marked.clear(); from.paint(); }
      from.reload();
      to.reload(target === to.st.cwd ? list[0]?.name : undefined);
    }

    async function uploadPaths(paths, dir) {
      if (!paths.length) return;
      const remote = panes[1];
      const items = paths.map((path) => ({ name: path.split(/[\\/]/).pop(), path }));
      const pseudo = { kind: 'local', st: { msg: null, marked: new Set() }, pathOf: (n) => items.find((i) => i.name === n).path, src: sources.local, reload() {}, paint() {} };
      await transfer(pseudo, remote, items, { dir });
    }

    // ---------- Overførselsliste ----------
    function addTransfer(kind, label, move) {
      const id = uid();
      const row = document.createElement('div');
      row.className = 'xfer';
      row.innerHTML = `
        <span class="xfer-dir">${kind === 'up' ? '↑' : '↓'}</span>
        <span class="xfer-name">${esc(move ? tr('xfer.move', { name: label }) : label)}</span>
        <span class="bar"><i style="width:0%"></i></span>
        <span class="xfer-info">${tr('xfer.preparing')}</span>
        <button class="icon-btn xfer-x" title="${esc(tr('xfer.cancel'))}">✕</button>`;
      transfersEl.prepend(row);
      const bar = row.querySelector('.bar i'), info = row.querySelector('.xfer-info'), x = row.querySelector('.xfer-x');
      const t0 = Date.now();
      let finished = false;
      x.onclick = () => (finished ? row.remove() : api.sftp.cancel(id));
      progressHandlers.set(id, (pr) => {
        if (pr.state === 'running') {
          const pct = pr.total ? (pr.done / pr.total) * 100 : 0;
          bar.style.width = pct.toFixed(1) + '%';
          const speed = pr.done / Math.max(0.5, (Date.now() - t0) / 1000);
          info.textContent = tr('xfer.progress', { pct: Math.floor(pct), done: fmtSize(pr.done), total: fmtSize(pr.total), speed: fmtSize(speed) });
          info.title = pr.file || '';
          return;
        }
        finished = true;
        progressHandlers.delete(id);
        x.title = tr('xfer.remove');
        row.classList.add(pr.state);
        if (pr.state === 'done') {
          bar.style.width = '100%';
          info.textContent = tr('xfer.done', { files: tr('cmd.files', { n: pr.files }), size: fmtSize(pr.total) });
          setTimeout(() => row.remove(), 6000);
        } else if (pr.state === 'cancelled') {
          info.textContent = tr('xfer.cancelled');
          setTimeout(() => row.remove(), 4000);
        } else {
          info.textContent = tr('xfer.error', { err: pr.error });
          info.title = pr.error;
        }
      });
      return id;
    }

    // ---------- Højrekliksmenu ----------
    function contextMenu(p, e) {
      const items = p.targets().filter((i) => i.name !== '..');
      const one = items.length === 1 ? items[0] : null;
      const o = other(p);
      const menu = [];
      if (one?.isDir) menu.push({ label: tr('cctx.open'), run: () => p.open(one.name) });
      if (one && !one.isDir) menu.push({ label: tr(p.kind === 'remote' ? 'cctx.openEdit' : 'cctx.openF4'), run: () => p.open(one.name) });
      if (items.length) {
        const local = p.kind === 'local';
        menu.push({ label: tr(local ? 'cctx.copyToServer' : 'cctx.copyToLocal'), run: () => transfer(p, o, items, {}) });
        menu.push({ label: tr(local ? 'cctx.moveToServer' : 'cctx.moveToLocal'), run: () => transfer(p, o, items, { move: true }) });
      }
      if (one) menu.push({ label: tr('cctx.rename'), run: () => rename(p) });
      if (one) menu.push({ label: tr('cctx.copyPath'), run: () => api.clipWrite(p.pathOf(one.name)) });
      if (menu.length) menu.push('-');
      menu.push({ label: tr('cctx.mkdir'), run: () => mkdir(p) });
      menu.push({ label: tr('cctx.refresh'), run: () => p.reload(p.st.cursor) });
      if (p.kind === 'remote') {
        const dir = one?.isDir ? p.pathOf(one.name) : p.st.cwd;
        menu.push({ label: tr('cctx.terminal'), run: () => { writeToTerminal(`cd ${shq(dir)}\r`); showTerminal(); } });
      }
      if (items.length) {
        menu.push('-');
        menu.push({ label: tr(p.kind === 'local' ? 'cctx.trash' : 'cctx.delete'), danger: true, run: () => remove(p) });
      }
      showCtx(e.clientX, e.clientY, menu);
    }

    // ---------- Livscyklus ----------
    let started = false;
    async function show() {
      root.hidden = false;
      if (!started) {
        started = true;
        await localReady;
        setActive(panes[activeIdx]);
        await Promise.all(panes.map((p) => p.init()));
      }
      active().list.focus();
    }
    return {
      el: root,
      get open() { return !root.hidden; },
      show,
      hide() { root.hidden = true; },
      focus() { active().list.focus(); },
      relabel() { panes.forEach((p) => p.render()); }, // statiske tekster klares af applyI18n
      onConnected() { if (started) { const r = panes[1]; r.st.cwd ? r.load(r.st.cwd, r.st.cursor) : r.init(); } },
      onDisconnected() { if (started) panes[1].disconnected(); },
      dispose() { editHandlers.delete(sid); api.sftp.stopEdits(sid); },
    };
  }

  return { create };
})();
