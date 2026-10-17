/* global api */
// Filpanelet ved siden af terminalen (SFTP). Ét panel pr. fane.
'use strict';

const FilePanels = (() => {
  const handlers = new Map(); // transfer-id -> fn(progress)
  api.sftp.onProgress((p) => handlers.get(p.id)?.(p));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
  const parentOf = (p) => (p === '/' ? '/' : p.replace(/\/+[^/]+\/*$/, '') || '/');
  const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function fmtSize(n) {
    if (!(n >= 0)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toLocaleString('da-DK', { maximumFractionDigits: i && n < 10 ? 1 : 0 })} ${u[i]}`;
  }
  const fmtDate = (sec) => new Date(sec * 1000).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });

  function create(tab, { writeToTerminal, showCtx }) {
    const sid = tab.id;
    const st = { cwd: null, entries: [], hidden: localStorage.getItem('skal.hidden') === '1', sel: new Set(), anchor: null, loading: false };

    const el = document.createElement('aside');
    el.className = 'files';
    el.hidden = true;
    el.innerHTML = `
      <div class="files-head">
        <span class="files-title">Filer</span>
        <button class="icon-btn" data-act="hidden" title="Vis skjulte filer">.*</button>
        <button class="icon-btn" data-act="refresh" title="Opdatér (F5)">⟳</button>
        <button class="icon-btn" data-act="close" title="Luk (Ctrl+Shift+F)">✕</button>
      </div>
      <div class="files-path">
        <button class="icon-btn" data-act="up" title="Op (Backspace)">↑</button>
        <input class="path-input" spellcheck="false" aria-label="Sti" />
      </div>
      <div class="files-actions">
        <button class="btn btn-sm" data-act="upload">Upload filer</button>
        <button class="btn btn-sm" data-act="upload-dir">Upload mappe</button>
        <button class="btn btn-sm" data-act="mkdir">Ny mappe</button>
      </div>
      <div class="files-list" tabindex="0"></div>
      <div class="files-drop" hidden><div>Slip for at uploade til<br><b></b></div></div>
      <div class="files-transfers"></div>`;
    const list = el.querySelector('.files-list');
    const pathInput = el.querySelector('.path-input');
    const drop = el.querySelector('.files-drop');
    const transfersEl = el.querySelector('.files-transfers');
    el.querySelector('[data-act="hidden"]').classList.toggle('on', st.hidden);

    // ---------- Liste ----------
    function visible() {
      return st.entries
        .filter((e) => st.hidden || !e.name.startsWith('.'))
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'da', { numeric: true, sensitivity: 'base' }));
    }
    function render(message) {
      pathInput.value = st.cwd || '';
      if (message) { list.innerHTML = `<div class="files-msg">${message}</div>`; return; }
      const rows = visible();
      list.innerHTML = rows.length ? rows.map((e) => `
        <div class="frow ${st.sel.has(e.name) ? 'selected' : ''} ${e.name.startsWith('.') ? 'dot' : ''}" data-name="${esc(e.name)}" draggable="false">
          <span class="ficon ${e.isDir ? 'dir' : 'file'}"></span>
          <span class="fname">${esc(e.name)}${e.isLink ? ' <span class="flink">→</span>' : ''}</span>
          <span class="fmeta">${e.isDir ? '' : fmtSize(e.size)}</span>
          <span class="fdate">${fmtDate(e.mtime)}</span>
        </div>`).join('') : '<div class="files-msg">Mappen er tom.<br>Træk filer hertil for at uploade.</div>';
    }
    async function load(dir, keepSel) {
      if (tab.status !== 'connected') { render('Ikke forbundet.'); return; }
      st.loading = true;
      if (!st.entries.length) render('Indlæser …');
      try {
        const r = await api.sftp.list(sid, dir ?? st.cwd ?? '.');
        const changed = r.path !== st.cwd;
        st.cwd = r.path; st.entries = r.entries;
        if (changed || !keepSel) { st.sel.clear(); st.anchor = null; }
        render();
        if (changed) list.scrollTop = 0;
      } catch (e) {
        if (!st.cwd) render(esc(cleanErr(e)));
        else flash(cleanErr(e));
      } finally { st.loading = false; }
    }
    const byName = (n) => st.entries.find((e) => e.name === n);
    const selected = () => [...st.sel].map(byName).filter(Boolean);

    function flash(msg) {
      const n = document.createElement('div');
      n.className = 'files-flash'; n.textContent = msg;
      el.appendChild(n); setTimeout(() => n.remove(), 4000);
    }

    function selectRow(name, e) {
      const names = visible().map((x) => x.name);
      if (e?.shiftKey && st.anchor) {
        const [a, b] = [names.indexOf(st.anchor), names.indexOf(name)].sort((x, y) => x - y);
        if (!(e.ctrlKey || e.metaKey)) st.sel.clear();
        names.slice(a, b + 1).forEach((n) => st.sel.add(n));
      } else if (e?.ctrlKey || e?.metaKey) {
        st.sel.has(name) ? st.sel.delete(name) : st.sel.add(name);
        st.anchor = name;
      } else {
        st.sel.clear(); st.sel.add(name); st.anchor = name;
      }
      list.querySelectorAll('.frow').forEach((r) => r.classList.toggle('selected', st.sel.has(r.dataset.name)));
    }

    function open(entry) {
      if (entry.isDir) load(join(st.cwd, entry.name));
      else download([entry]);
    }

    // ---------- Indtastning direkte i listen (omdøb / ny mappe) ----------
    function inlineInput(host, initial) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.className = 'inline-input'; input.value = initial; input.spellcheck = false;
        host.replaceChildren(input);
        input.focus();
        const dot = initial.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
        let done = false;
        const finish = (v) => { if (done) return; done = true; resolve(v); };
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(input.value.trim());
          if (e.key === 'Escape') finish(null);
        };
        input.onblur = () => finish(input.value.trim());
      });
    }
    async function rename(entry) {
      const row = list.querySelector(`.frow[data-name="${CSS.escape(entry.name)}"] .fname`);
      if (!row) return;
      const name = await inlineInput(row, entry.name);
      if (!name || name === entry.name || name.includes('/')) return render();
      try { await api.sftp.rename(sid, join(st.cwd, entry.name), join(st.cwd, name)); st.sel = new Set([name]); }
      catch (e) { flash(cleanErr(e)); }
      load(null, true);
    }
    async function mkdir() {
      const ph = document.createElement('div');
      ph.className = 'frow selected';
      ph.innerHTML = '<span class="ficon dir"></span><span class="fname"></span>';
      list.prepend(ph);
      const name = await inlineInput(ph.querySelector('.fname'), 'Ny mappe');
      ph.remove();
      if (!name || name.includes('/')) return;
      try { await api.sftp.mkdir(sid, join(st.cwd, name)); st.sel = new Set([name]); }
      catch (e) { flash(cleanErr(e)); }
      load(null, true);
    }
    async function remove(entries) {
      if (!entries.length) return;
      const what = entries.length === 1 ? `“${entries[0].name}”${entries[0].isDir ? ' og alt indhold' : ''}` : `${entries.length} elementer`;
      if (!confirm(`Slet ${what} på serveren? Det kan ikke fortrydes.`)) return;
      for (const e of entries) {
        try { await api.sftp.remove(sid, join(st.cwd, e.name)); }
        catch (err) { flash(`${e.name}: ${cleanErr(err)}`); }
      }
      load();
    }

    // ---------- Overførsler ----------
    function addTransfer(kind, label) {
      const id = uid();
      const row = document.createElement('div');
      row.className = 'xfer';
      row.innerHTML = `
        <div class="xfer-top"><span class="xfer-dir">${kind === 'up' ? '↑' : '↓'}</span>
          <span class="xfer-name">${esc(label)}</span>
          <button class="icon-btn xfer-x" title="Annullér">✕</button></div>
        <div class="bar"><i style="width:0%"></i></div>
        <div class="xfer-info">Forbereder …</div>`;
      transfersEl.prepend(row);
      const bar = row.querySelector('.bar i'), info = row.querySelector('.xfer-info'), x = row.querySelector('.xfer-x');
      const t0 = Date.now();
      let finished = false;
      x.onclick = () => (finished ? row.remove() : api.sftp.cancel(id));
      handlers.set(id, (p) => {
        if (p.state === 'running') {
          const pct = p.total ? (p.done / p.total) * 100 : 0;
          bar.style.width = pct.toFixed(1) + '%';
          const speed = p.done / Math.max(0.5, (Date.now() - t0) / 1000);
          info.textContent = `${fmtSize(p.done)} af ${fmtSize(p.total)} · ${fmtSize(speed)}/s${p.file ? ' · ' + p.file : ''}`;
          return;
        }
        finished = true; handlers.delete(id);
        x.title = 'Fjern';
        row.classList.add(p.state);
        if (p.state === 'done') {
          bar.style.width = '100%';
          info.innerHTML = `Færdig · ${p.files} ${p.files === 1 ? 'fil' : 'filer'}, ${fmtSize(p.total)}` +
            (p.localPath ? ' · <a href="#" class="xfer-show">Vis i mappe</a>' : '');
          info.querySelector('.xfer-show')?.addEventListener('click', (e) => { e.preventDefault(); api.showItem(p.localPath); });
          setTimeout(() => row.remove(), p.localPath ? 30000 : 8000);
        } else if (p.state === 'cancelled') {
          info.textContent = 'Annulleret'; setTimeout(() => row.remove(), 5000);
        } else {
          info.textContent = 'Fejl: ' + p.error;
        }
      });
      return id;
    }

    async function upload(paths, dir = st.cwd) {
      if (!paths.length || !dir) return;
      const names = paths.map((p) => p.split(/[\\/]/).pop());
      try {
        const clash = await api.sftp.existing(sid, dir, names);
        if (clash.length && !confirm(`${clash.length === 1 ? `“${clash[0]}” findes` : `${clash.length} elementer findes`} allerede i ${dir}. Overskriv?`)) return;
      } catch (e) { return flash(cleanErr(e)); }
      const id = addTransfer('up', names.length === 1 ? names[0] : `${names.length} elementer`);
      const r = await api.sftp.upload(sid, id, paths, dir);
      if (!r?.error && dir === st.cwd) load(null, true);
    }
    async function download(entries, localDir) {
      if (!entries.length) return;
      const id = addTransfer('down', entries.length === 1 ? entries[0].name : `${entries.length} elementer`);
      api.sftp.download(sid, id, entries.map((e) => ({ path: join(st.cwd, e.name) })), localDir || null);
    }

    // ---------- Hændelser ----------
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      switch (b.dataset.act) {
        case 'close': hide(); tab.term?.focus(); break;
        case 'refresh': load(null, true); break;
        case 'up': load(parentOf(st.cwd || '/')); break;
        case 'hidden': st.hidden = !st.hidden; b.classList.toggle('on', st.hidden); localStorage.setItem('skal.hidden', st.hidden ? '1' : '0'); render(); break;
        case 'mkdir': mkdir(); break;
        case 'upload': upload(await api.sftp.pickUpload(false)); break;
        case 'upload-dir': upload(await api.sftp.pickUpload(true)); break;
      }
    });
    pathInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { load(pathInput.value.trim() || '/'); list.focus(); }
      if (e.key === 'Escape') { pathInput.value = st.cwd || ''; list.focus(); }
    });

    list.addEventListener('mousedown', (e) => {
      const r = e.target.closest('.frow[data-name]');
      if (e.target.closest('input')) return;
      if (!r) { if (e.button === 0) { st.sel.clear(); render(); } return; }
      if (e.button === 2 && st.sel.has(r.dataset.name)) return; // højreklik på markering beholder den
      selectRow(r.dataset.name, e);
    });
    list.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.frow[data-name]'); if (!r || e.target.closest('input')) return;
      const entry = byName(r.dataset.name); if (entry) open(entry);
    });
    list.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      const sel = selected();
      if (e.key === 'Enter' && sel.length === 1) open(sel[0]);
      else if (e.key === 'Enter' && sel.length > 1) download(sel);
      else if (e.key === 'Backspace') load(parentOf(st.cwd || '/'));
      else if (e.key === 'Delete') remove(sel);
      else if (e.key === 'F2' && sel.length === 1) rename(sel[0]);
      else if (e.key === 'F5') load(null, true);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { visible().forEach((x) => st.sel.add(x.name)); render(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    });

    list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = e.target.closest('.frow[data-name]');
      const sel = r ? selected() : [];
      const one = sel.length === 1 ? sel[0] : null;
      const target = one?.isDir ? join(st.cwd, one.name) : st.cwd;
      const items = [];
      if (one?.isDir) items.push({ label: 'Åbn', run: () => open(one) });
      if (sel.length) {
        items.push({ label: sel.length > 1 ? `Hent ${sel.length} elementer` : 'Hent', run: () => download(sel) });
        items.push({ label: 'Hent til …', run: async () => { const d = await api.sftp.pickDir(); if (d) download(sel, d); } });
      }
      if (one) items.push({ label: 'Omdøb', run: () => rename(one) });
      if (one) items.push({ label: 'Kopiér sti', run: () => api.clipWrite(join(st.cwd, one.name)) });
      if (items.length) items.push('-');
      items.push({ label: 'Upload filer hertil …', run: async () => upload(await api.sftp.pickUpload(false), target) });
      items.push({ label: 'Ny mappe', run: mkdir });
      items.push({ label: 'Gå til mappen i terminalen', run: () => { writeToTerminal(`cd ${shq(target)}\r`); tab.term?.focus(); } });
      if (sel.length) { items.push('-'); items.push({ label: sel.length > 1 ? `Slet ${sel.length} elementer` : 'Slet', danger: true, run: () => remove(sel) }); }
      showCtx(e.clientX, e.clientY, items);
    });

    // Træk-og-slip fra Stifinder. Slip på en mappe = upload ind i den.
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const dropTarget = (e) => {
      const r = e.target.closest?.('.frow[data-name]');
      const entry = r && byName(r.dataset.name);
      return entry?.isDir ? join(st.cwd, entry.name) : st.cwd;
    };
    el.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !st.cwd) return; e.preventDefault(); dragDepth++; drop.hidden = false; });
    el.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !st.cwd) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      drop.querySelector('b').textContent = dropTarget(e);
    });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; drop.hidden = true;
      const dir = dropTarget(e);
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      upload(paths, dir);
    });

    // ---------- Åbn / luk ----------
    function show() { el.hidden = false; if (!st.cwd || !st.entries.length) load(st.cwd || '.'); list.focus(); }
    function hide() { el.hidden = true; }
    return {
      el,
      get open() { return !el.hidden; },
      show, hide,
      toggle() { el.hidden ? show() : hide(); },
      onConnected() { if (!el.hidden) load(st.cwd || '.', true); },
      onDisconnected() { if (!el.hidden) render('Ikke forbundet.'); },
    };
  }

  return { create };
})();
