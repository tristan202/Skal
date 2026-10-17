/* global Terminal, FitAddon, Unicode11Addon, Commander, I18N, api */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COLORS = ['#5b8def', '#2bb3a3', '#9b6cf0', '#e0a43a', '#e5534b', '#4caf6a', '#e06aa8', '#6b7894'];
const NO_GROUP = ''; // hosts uden gruppe – vises som tr('group.none')
const tr = (k, v) => I18N.t(k, v);

const state = {
  hosts: [],
  tabs: [],          // { id, host, hostId, adhoc, title, term, fit, el, status, password }
  active: 'home',
  canEncrypt: false,
  filter: '',
  selected: null,
  editing: null,     // host-objekt eller {} for ny
  collapsed: new Set(),
  metrics: {},       // hostId -> seneste serverstatus
  ping: {},          // hostId -> svarer SSH-porten?
  metricsOn: localStorage.getItem('skal.metrics') !== '0',
};

const termTheme = {
  background: '#171a26', foreground: '#dfe3ee', cursor: '#5b8def', cursorAccent: '#171a26',
  selectionBackground: '#5b8def55',
  black: '#1d2131', red: '#e5534b', green: '#57c27a', yellow: '#e0b44a', blue: '#5b8def', magenta: '#b382f0', cyan: '#3ec3c9', white: '#c9cfdd',
  brightBlack: '#5a6280', brightRed: '#ff7b72', brightGreen: '#7ee39b', brightYellow: '#f2cc60', brightBlue: '#82a9ff', brightMagenta: '#d2a8ff', brightCyan: '#76e3ea', brightWhite: '#ffffff',
};

// ---------- Hjælpere ----------
function colorFor(h) {
  if (h.color) return h.color;
  let n = 0; for (const c of h.host || '') n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}
function initials(h) {
  const base = (h.name || h.host || '?').replace(/[^\p{L}\p{N} ._-]/gu, '');
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}
const label = (h) => h.name || h.host;
const sub = (h) => `${h.username ? h.username + '@' : ''}${h.host}${Number(h.port) !== 22 ? ':' + h.port : ''}`;
const avatar = (h, cls = '') => `<span class="avatar ${cls}" style="background:${esc(colorFor(h))}">${esc(initials(h))}</span>`;
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[A-Z_]+: /, '');
const errCode = (e) => (String(e?.message || e).match(/(NEED_PASSPHRASE|BAD_PASSPHRASE)/) || [])[1];
const getTab = (id) => state.tabs.find((t) => t.id === id);
const isLive = (hostId) => state.tabs.some((t) => t.hostId === hostId && t.status === 'connected');

function filteredHosts() {
  const q = state.filter.trim().toLowerCase();
  return state.hosts
    .filter((h) => !q || [h.name, h.host, h.username, h.group].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => label(a).localeCompare(label(b), I18N.locale));
}
function grouped(list) {
  const m = new Map();
  for (const h of list) {
    const g = h.group || NO_GROUP;
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(h);
  }
  return [...m.entries()].sort(([a], [b]) => (a === NO_GROUP) - (b === NO_GROUP) || a.localeCompare(b, I18N.locale));
}
function parseQuick(q) {
  const m = q.trim().match(/^([^@\s]+)@([^\s:@]+)(?::(\d{1,5}))?$/);
  return m ? { username: m[1], host: m[2], port: Number(m[3]) || 22 } : null;
}

// ---------- Rendering ----------
function render() {
  renderSidebar();
  renderHome();
  renderTabs();
}

function renderSidebar() {
  const list = filteredHosts();
  const quick = parseQuick(state.filter);
  let html = '';
  if (quick) {
    html += `<div class="quick">${tr('quick.connect', { host: `<b>${esc(sub({ ...quick }))}</b>` })}</div>`;
  }
  for (const [g, hosts] of grouped(list)) {
    const col = state.collapsed.has(g) && !state.filter;
    html += `<div class="group-head ${col ? 'collapsed' : ''}" data-group="${esc(g)}"><span class="caret">▼</span>${esc(g || tr('group.none'))}<span class="count">${hosts.length}</span></div>`;
    if (col) continue;
    for (const h of hosts) {
      html += `<div class="host-item ${state.selected === h.id ? 'selected' : ''}" data-id="${h.id}" tabindex="0" title="${esc(tr('host.dblclick'))}">
        ${avatar(h)}
        <div class="meta"><div class="name">${esc(label(h))}</div><div class="sub">${esc(sub(h))}</div></div>
        ${isLive(h.id) ? `<span class="live-dot" title="${esc(tr('host.connected'))}"></span>` : ''}
        <button class="edit" data-edit="${h.id}" title="${esc(tr('btn.edit'))}" aria-label="${esc(tr('btn.edit'))}">✎</button>
      </div>`;
    }
  }
  if (!list.length && !quick && state.hosts.length) html += `<div class="quick">${esc(tr('search.noMatch', { q: state.filter }))}</div>`;
  $('#host-list').innerHTML = html;

  const n = state.hosts.length;
  $('#foot').innerHTML = esc(tr('foot.hosts', { n })) +
    (state.canEncrypt ? '' : `<br><span class="warn">${esc(tr('foot.noKeyring'))}</span>`);

  $('#group-list').innerHTML = [...new Set(state.hosts.map((h) => h.group).filter(Boolean))]
    .map((g) => `<option value="${esc(g)}">`).join('');
}

function renderHome() {
  const el = $('#home-view');
  if (!state.hosts.length) {
    el.innerHTML = `<div class="empty">
      <h2>${tr('home.emptyTitle')}</h2>
      <p>${tr('home.emptyText')}</p>
      <button class="btn btn-primary" data-action="new">${tr('home.addHost')}</button>
    </div>`;
    return;
  }
  const list = filteredHosts();
  let html = `<div class="home-head"><h1>${tr('home.title')}</h1><span class="muted">${tr('home.count', { n: list.length, total: state.hosts.length })}</span>
    <label class="switch" title="${esc(tr('metrics.toggleTitle'))}">
      <input type="checkbox" id="metrics-toggle" ${state.metricsOn ? 'checked' : ''}/> ${tr('metrics.toggle')}</label></div>`;
  for (const [g, hosts] of grouped(list)) {
    html += `<div class="home-group">${esc(g || tr('group.none'))}</div><div class="grid">`;
    for (const h of hosts) {
      html += `<div class="card ${state.selected === h.id ? 'selected' : ''}" data-id="${h.id}" tabindex="0" role="button" title="${esc(tr('host.dblclick'))}">
        ${avatar(h, 'lg')}
        <div class="meta"><div class="name"><span class="n">${esc(label(h))}</span>${pingDot(h.id)}</div><div class="sub">${esc(sub(h))}</div></div>
        <button class="edit" data-edit="${h.id}" title="${esc(tr('btn.edit'))}" aria-label="${esc(tr('btn.edit'))}">✎</button>
        ${state.metricsOn ? `<div class="metrics" data-metrics="${h.id}">${metricsHtml(state.metrics[h.id])}</div>` : ''}
      </div>`;
    }
    html += '</div>';
  }
  const cs = `${tr('keys.ctrl')}+${tr('keys.shift')}+`;
  html += `<div class="kbd-hints">
    <kbd>${cs}H</kbd><span>${tr('keys.showHosts')}</span>
    <kbd>${tr('keys.ctrl')}+Tab</kbd><span>${tr('keys.nextTab')}</span>
    <kbd>${cs}W</kbd><span>${tr('keys.closeTab')}</span>
    <kbd>${cs}D</kbd><span>${tr('keys.dupSession')}</span>
    <kbd>${cs}F</kbd><span>${tr('keys.toggleView')}</span>
    <kbd>${cs}C / V</kbd><span>${tr('keys.copyPaste')}</span>
    <kbd>${tr('keys.rightClick')}</kbd><span>${tr('keys.paste')}</span>
  </div>`;
  el.innerHTML = html;
}

// ---------- Serverstatus ----------
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(I18N.locale, { maximumFractionDigits: n < 10 && i ? 1 : 0 })} ${u[i]}`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? tr('m.uptimeD', { d, h }) : h ? tr('m.uptimeH', { h, m }) : tr('m.uptimeM', { m });
}
const level = (pct) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');
function meter(label, pct, text, title = '') {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="meter" title="${esc(title)}"><span class="m-label">${label}</span>
    <span class="m-bar"><i class="${level(p)}" style="width:${p.toFixed(1)}%"></i></span>
    <span class="m-val">${esc(text)}</span></div>`;
}
function metricsHtml(m) {
  if (!m) return `<div class="m-skel"><i></i><i></i><i></i></div>`;
  if (!m.ok) {
    const icon = { login: '🔒', hostkey: '🔑', unsupported: 'ⓘ', offline: '●' }[m.reason] || '●';
    return `<div class="m-note ${m.reason}"><span>${icon}</span>${esc(m.msgKey ? tr(m.msgKey) : m.message)}</div>`;
  }
  const root = m.disks[0];
  const of = (a, b) => tr('m.of', { a: fmtBytes(a), b: fmtBytes(b) });
  const disks = m.disks.map((d) => `${d.mount}: ${of(d.used, d.total)} (${Math.round(d.pct)} %)`).join('\n');
  const swap = m.swap.total ? `\nSwap: ${of(m.swap.used, m.swap.total)}` : '';
  return meter('CPU', m.cpu, `${Math.round(m.cpu)} %`, `${tr('m.cores', { n: m.ncpu })} · load ${m.load.join(' / ')}`) +
    meter('RAM', m.mem.pct, `${fmtBytes(m.mem.used)} / ${fmtBytes(m.mem.total)}`, `${tr('m.used', { p: Math.round(m.mem.pct) })}${swap}`) +
    (root ? meter(tr('m.disk'), root.pct, `${Math.round(root.pct)} % ${root.mount}`, disks) : '') +
    `<div class="m-foot" title="${esc(m.os)}"><span>${esc(m.os || 'Linux')}</span><span>${tr('m.up', { t: fmtUptime(m.uptime) })} · load ${m.load[0] ?? '–'}</span></div>`;
}
// ---------- Online-prik ----------
// Grøn hvis serverens SSH-port svarer. Kilder i prioriteret rækkefølge:
// åben session › virkende serverstatus › et let tjek af SSH-porten (hvert 3. min).
function pingInfo(id) {
  const m = state.metricsOn && state.metrics[id];
  if (m?.ok) return { cls: 'ok', title: tr('ping.okMetrics') };
  const p = state.ping[id];
  if (!p) return { cls: 'wait', title: tr('ping.checking') };
  if (p.ok) return { cls: 'ok', title: p.session ? tr('ping.okSession') : tr('ping.ok', { ms: p.ms }) };
  return { cls: 'bad', title: p.msgKey ? tr(p.msgKey) : `${tr('ping.offline')} – ${p.message || ''}` };
}
function pingDot(id) {
  const i = pingInfo(id);
  return `<span class="ping-dot ${i.cls}" data-ping="${id}" title="${esc(i.title)}"></span>`;
}
function updatePingDom(id) {
  const el = document.querySelector(`[data-ping="${id}"]`);
  if (el) el.outerHTML = pingDot(id);
}
const pingBusy = new Set(), pingAt = {};
function pollPing(force) {
  if (state.active !== 'home' || document.hidden) return;
  for (const h of filteredHosts()) {
    if (state.metricsOn && state.metrics[h.id]?.ok) continue; // serverstatus viser det allerede
    if (pingBusy.has(h.id) || (!force && Date.now() - (pingAt[h.id] || 0) < 180000)) continue;
    pingBusy.add(h.id);
    api.ping([h.id]).then((r) => { Object.assign(state.ping, r); updatePingDom(h.id); })
      .catch(() => {}).finally(() => { pingBusy.delete(h.id); pingAt[h.id] = Date.now(); });
  }
}
setInterval(() => pollPing(false), 5000);

// Hver server hentes for sig, så en langsom eller utilgængelig server ikke
// holder de andre tilbage. En server spørges højst hvert 10. sekund.
const metricsBusy = new Set(), metricsAt = {};
function pollMetrics(force) {
  if (!state.metricsOn || state.active !== 'home' || document.hidden) return;
  for (const h of filteredHosts()) {
    if (metricsBusy.has(h.id) || (!force && Date.now() - (metricsAt[h.id] || 0) < 10000)) continue;
    metricsBusy.add(h.id);
    api.metrics([h.id]).then((r) => {
      Object.assign(state.metrics, r);
      const el = document.querySelector(`[data-metrics="${h.id}"]`);
      if (el) el.innerHTML = metricsHtml(state.metrics[h.id]);
      updatePingDom(h.id);
      if (!state.metrics[h.id]?.ok) pollPing(false); // serverstatus fejler: lad SSH-tjekket afgøre prikken
    }).catch(() => {}).finally(() => { metricsBusy.delete(h.id); metricsAt[h.id] = Date.now(); });
  }
}
setInterval(() => pollMetrics(false), 2000);

function renderTabs() {
  const counts = {};
  $('#tabs').innerHTML = state.tabs.map((t) => {
    counts[t.title] = (counts[t.title] || 0) + 1;
    const n = counts[t.title] > 1 ? ` (${counts[t.title]})` : '';
    return `<button class="tab ${state.active === t.id ? 'active' : ''}" data-id="${t.id}" role="tab" title="${esc(sub(t.host))}">
      <span class="status ${t.status}"></span><span class="title">${esc(t.title + n)}</span>
      <span class="close" data-close="${t.id}" title="${esc(tr('tab.closeTitle'))}">✕</span>
    </button>`;
  }).join('');
  $('.tab-home').classList.toggle('active', state.active === 'home');
  $('#home-view').hidden = state.active !== 'home';
  $('#terms').hidden = state.active === 'home';
  for (const t of state.tabs) t.el.classList.toggle('active', t.id === state.active);
  const at = getTab(state.active);
  $('#view-switch').hidden = !at;
  $('#view-switch').querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === (at?.view || 'terminal')));
  renderSidebar(); // live-prikker
}

// ---------- Faner / sessioner ----------
function activate(id) {
  state.active = id;
  renderTabs();
  if (id === 'home') { pollMetrics(false); pollPing(false); }
  const t = getTab(id);
  if (t?.view === 'files') t.cmd.focus();
  else if (t) { t.term?.focus(); waitForFit(t); }
}

// Tilpas terminalen til sin beholder. Returnerer false, hvis fonten ikke kan
// måles endnu (fx fordi fanen ikke er synlig).
function fitTab(t) {
  if (!t?.term || !t.el.classList.contains('active')) return false;
  if (!t.wrap.offsetWidth || !t.wrap.offsetHeight) return false; // skjult (fx filvisning)
  let d;
  try { d = t.fit.proposeDimensions(); } catch { return false; }
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 2 || d.rows < 1) return false;
  if (t.term.cols !== d.cols || t.term.rows !== d.rows) t.term.resize(d.cols, d.rows);
  // Ved skærmskalering som 125 % eller 150 % kan rækkerne afrundes lidt for højt,
  // så nederste linje skæres af. Fjern rækker, indtil alt er synligt.
  const screen = t.wrap.querySelector('.xterm-screen');
  for (let i = 0; screen && i < 3 && t.term.rows > 1 &&
       screen.getBoundingClientRect().height > t.wrap.getBoundingClientRect().height + 0.5; i++) {
    t.term.resize(t.term.cols, t.term.rows - 1);
  }
  return true;
}
function fitActive() { fitTab(getTab(state.active)); }
// Næste skærmopdatering – men højst 50 ms, så intet hænger, hvis vinduet er minimeret
const nextFrame = () => new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 50); });
async function waitForFit(t) {
  for (let i = 0; i < 30; i++) { await nextFrame(); if (fitTab(t)) return; }
}

async function openSession(host, { adhoc = false, password, passphrase } = {}) {
  if (password === undefined && (host.authType || 'password') === 'password' && !host.hasPassword) {
    const r = await promptPassword(host, !adhoc && state.canEncrypt);
    if (r === null) return;
    password = r.password;
    if (r.remember) {
      const saved = await api.saveHost({ ...host, password: r.password });
      Object.assign(host, saved);
      await loadHosts();
    }
  }

  const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const el = document.createElement('div');
  el.className = 'term-pane';
  const box = document.createElement('div');
  box.className = 'term-box';
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  box.appendChild(wrap);
  el.appendChild(box);
  $('#terms').appendChild(el);

  // Fanen gøres synlig FØR terminalen åbnes, så xterm kan måle fonten korrekt.
  // (Ellers måler den 0, og serveren får standardbredden 80 kolonner.)
  const tab = { id, host, hostId: adhoc ? null : host.id, adhoc: adhoc ? host : null, title: label(host), term: null, fit: null, el, box, wrap, view: 'terminal', status: 'connecting', password, passphrase };
  // Fil-commanderen (lokal | server) – en alternativ visning i samme fane
  tab.cmd = Commander.create(tab, {
    writeToTerminal: (d) => { if (tab.status === 'connected') api.write(id, d); },
    showTerminal: () => setView(tab, 'terminal'),
    showCtx,
  });
  el.appendChild(tab.cmd.el);
  applyI18n(tab.cmd.el); // oversæt commanderens faste tekster
  // Tilpas terminalen, når dens plads ændrer sig
  tab.ro = new ResizeObserver(() => { if (state.active === id) requestAnimationFrame(() => fitTab(tab)); });
  tab.ro.observe(wrap);
  state.tabs.push(tab);
  state.active = id;
  renderTabs();

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 10000,
    theme: termTheme, macOptionIsMeta: true, rightClickSelectsWord: false,
    allowProposedApi: true, // kræves af unicode-API'et
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Brug Unicode 11-bredder som moderne Linux: emoji og mange symboler fylder
  // 2 kolonner. Med xterm.js' standard (Unicode 6) kommer markøren ud af trit
  // med shell'en, når prompten indeholder sådanne tegn.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(wrap);
  tab.term = term;
  tab.fit = fit;

  term.onData((d) => {
    if (tab.status === 'connected') api.write(id, d);
    else if (tab.status === 'closed' && (d === '\r' || d === '\n')) connect(tab);
  });
  term.onResize(({ cols, rows }) => { if (tab.status === 'connected') api.resize(id, cols, rows); });
  term.onSelectionChange(() => { const s = term.getSelection(); if (s) api.clipWrite(s); }); // PuTTY-stil: markér = kopiér
  term.attachCustomKeyEventHandler((e) => !handleShortcut(e));
  el.addEventListener('contextmenu', async (e) => { e.preventDefault(); pasteInto(tab); });

  term.focus();
  connect(tab);
}

async function connect(tab) {
  tab.status = 'connecting';
  renderTabs();
  tab.term.write(`\x1b[90m${tr('term.connecting', { host: sub(tab.host) })}\x1b[0m\r\n`);
  await waitForFit(tab); // korrekt bredde/højde fra start
  try {
    await api.connect({
      sessionId: tab.id, hostId: tab.hostId, adhoc: tab.adhoc,
      cols: tab.term.cols, rows: tab.term.rows, password: tab.password, passphrase: tab.passphrase,
    });
    if (!getTab(tab.id)) return api.disconnect(tab.id); // fanen blev lukket imens
    tab.status = 'connected';
    fitTab(tab);
    api.resize(tab.id, tab.term.cols, tab.term.rows);
    tab.cmd.onConnected();
  } catch (e) {
    if (!getTab(tab.id)) return;
    const code = errCode(e);
    if (code) {
      // Nøglen kræver passphrase: spørg og prøv igen
      const r = await promptPassword(tab.host, !!tab.hostId && state.canEncrypt, {
        title: code === 'BAD_PASSPHRASE' ? tr('pp.wrong') : tr('pp.title'),
        sub: `${tab.host.keyPath || ''}`, button: tr('btn.unlock'), passphrase: true,
      });
      if (r !== null && getTab(tab.id)) {
        tab.passphrase = r.password;
        if (r.remember) { await api.saveHost({ ...tab.host, passphrase: r.password }); await loadHosts(); renderSidebar(); }
        tab.term.write(`\x1b[90m${tr('term.unlocking')}\x1b[0m\r\n`);
        return connect(tab);
      }
    }
    tab.status = 'closed';
    tab.cmd.onDisconnected();
    tab.term.write(`\r\n\x1b[31m✖ ${cleanErr(e)}\x1b[0m\r\n\x1b[90m${tr('term.retry')}\x1b[0m\r\n`);
  }
  renderTabs();
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = state.tabs.splice(i, 1);
  api.disconnect(id);
  t.ro?.disconnect();
  t.cmd.dispose();
  t.term.dispose();
  t.el.remove();
  if (state.active === id) {
    const next = state.tabs[i] || state.tabs[i - 1];
    activate(next ? next.id : 'home');
  } else renderTabs();
}

function cycleTab(dir) {
  const ids = ['home', ...state.tabs.map((t) => t.id)];
  const i = ids.indexOf(state.active);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

async function pasteInto(tab) {
  if (tab.status !== 'connected') return;
  const text = await api.clipRead();
  if (text) tab.term.paste(text);
}

function handleShortcut(e) {
  if (e.type !== 'keydown') return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const t = getTab(state.active);
  if (ctrl && e.key === 'Tab') { cycleTab(e.shiftKey ? -1 : 1); return true; }
  if (!(ctrl && e.shiftKey)) return false;
  switch (e.key.toLowerCase()) {
    case 'w': if (t) closeTab(t.id); return true;
    case 'h': activate('home'); $('#search').focus(); return true;
    case 'd': if (t) openSession(t.host, { adhoc: !!t.adhoc, password: t.password, passphrase: t.passphrase }); return true;
    case 'c': if (t) { const s = t.term.getSelection(); if (s) api.clipWrite(s); } return true;
    case 'v': if (t) pasteInto(t); return true;
    case 'n': openEditor({}); return true;
    case 'f': if (t) setView(t, t.view === 'files' ? 'terminal' : 'files'); return true;
    default: return false;
  }
}

// Skift mellem terminal og fil-commander i en fane
function setView(t, view) {
  t.view = view;
  t.box.hidden = view === 'files';
  if (view === 'files') t.cmd.show();
  else { t.cmd.hide(); t.term?.focus(); waitForFit(t); }
  renderTabs();
}

// ---------- Editor ----------
function openEditor(host) {
  state.editing = host;
  const f = $('#host-form');
  f.reset();
  const isNew = !host.id;
  editorTexts();
  for (const k of ['name', 'group', 'host', 'username', 'keyPath']) f.elements[k].value = host[k] || '';
  f.elements.port.value = host.port || 22;
  f.elements.authType.value = host.authType || 'password';
  f.elements.color.value = host.color || '';
  $('#clear-pw-wrap').hidden = !host.hasPassword;
  $('#clear-pp-wrap').hidden = !host.hasPassphrase;
  f.elements.password.disabled = !state.canEncrypt;
  f.elements.passphrase.disabled = !state.canEncrypt;
  $('#encrypt-hint').hidden = state.canEncrypt;
  $('#btn-delete').hidden = isNew;
  $('#form-error').hidden = true;
  renderSwatches();
  syncAuth();
  $('#editor').hidden = false;
  requestAnimationFrame(() => (isNew ? f.elements.name : f.elements.host).focus());
}
// Editorens tekster, der afhænger af hosten (kaldes også ved sprogskift)
function editorTexts() {
  const host = state.editing || {};
  const f = $('#host-form');
  $('#editor-title').textContent = host.id ? tr('editor.edit') : tr('editor.new');
  f.elements.password.placeholder = host.hasPassword ? tr('ph.savedPassword') : tr('ph.askOnConnect');
  f.elements.passphrase.placeholder = host.hasPassphrase ? tr('ph.savedPassphrase') : tr('ph.askIfNeeded');
}
function closeEditor() { $('#editor').hidden = true; state.editing = null; }
function syncAuth() {
  const v = $('#host-form').elements.authType.value;
  $('.auth-password').hidden = v !== 'password';
  $('.auth-key').hidden = v !== 'key';
}
function renderSwatches() {
  const cur = $('#host-form').elements.color.value;
  $('#swatches').innerHTML = COLORS.map((c) =>
    `<button type="button" class="swatch ${c === cur ? 'selected' : ''}" data-color="${c}" style="background:${c}" aria-label="${esc(tr('field.color'))} ${c}"></button>`).join('');
}

async function saveEditor(andConnect) {
  const f = $('#host-form');
  const v = Object.fromEntries(new FormData(f).entries());
  const err = $('#form-error');
  if (!v.host.trim()) { err.textContent = tr('form.needHost'); err.hidden = false; f.elements.host.focus(); return; }
  if (!v.username.trim()) { err.textContent = tr('form.needUser'); err.hidden = false; f.elements.username.focus(); return; }
  if (v.authType === 'key' && !v.keyPath.trim()) { err.textContent = tr('form.needKey'); err.hidden = false; return; }
  const saved = await api.saveHost({
    ...v, id: state.editing?.id,
    clearPassword: f.elements.clearPassword.checked,
    clearPassphrase: f.elements.clearPassphrase.checked,
  });
  await loadHosts();
  closeEditor();
  state.selected = saved.id;
  render();
  if (andConnect) openSession(state.hosts.find((h) => h.id === saved.id));
}

async function deleteHost(h) {
  if (!confirm(tr('confirm.deleteHost', { name: label(h) }))) return;
  await api.deleteHost(h.id);
  if (state.editing?.id === h.id) closeEditor();
  await loadHosts();
  render();
}

// ---------- Adgangskode-prompt ----------
function promptPassword(host, canRemember, opts = {}) {
  return new Promise((resolve) => {
    const modal = $('#modal'); const input = $('#pw-input');
    $('#pw-title').textContent = opts.title || tr('pw.loginTo', { name: label(host) });
    $('#pw-sub').textContent = opts.sub || sub(host);
    $('#pw-submit').textContent = opts.button || tr('btn.connect');
    $('#pw-remember-text').textContent = opts.passphrase ? tr('pp.remember') : tr('pw.remember');
    $('#pw-remember-wrap').hidden = !canRemember;
    $('#pw-remember').checked = false;
    input.value = '';
    modal.hidden = false;
    input.focus();
    const done = (val) => {
      modal.hidden = true;
      $('#pw-form').onsubmit = null; $('#pw-cancel').onclick = null; modal.onkeydown = null;
      resolve(val);
    };
    $('#pw-form').onsubmit = (e) => { e.preventDefault(); done({ password: input.value, remember: $('#pw-remember').checked }); };
    $('#pw-cancel').onclick = () => done(null);
    modal.onkeydown = (e) => { if (e.key === 'Escape') done(null); };
  });
}

// ---------- Kontekstmenu ----------
function showCtx(x, y, items) {
  const ctx = $('#ctx');
  ctx.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  ctx.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  ctx.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; ctx.hidden = true; items[b.dataset.i].run(); };
}
function hostCtx(e, h) {
  e.preventDefault();
  selectHost(h.id);
  showCtx(e.clientX, e.clientY, [
    { label: tr('ctx.connect'), run: () => openSession(h) },
    { label: tr('btn.edit'), run: () => openEditor(h) },
    { label: tr('ctx.duplicate'), run: async () => { const c = await api.duplicateHost(h.id); await loadHosts(); render(); if (c) openEditor(state.hosts.find((x) => x.id === c.id)); } },
    { label: tr('ctx.copyAddress'), run: () => api.clipWrite(sub(h)) },
    '-',
    { label: tr('btn.delete'), danger: true, run: () => deleteHost(h) },
  ]);
}
function tabCtx(e, t) {
  e.preventDefault();
  showCtx(e.clientX, e.clientY, [
    { label: tr('ctx.reconnect'), run: () => { api.disconnect(t.id); t.status = 'closed'; connect(t); } },
    { label: t.view === 'files' ? tr('ctx.showTerminal') : tr('ctx.showFiles'), run: () => { activate(t.id); setView(t, t.view === 'files' ? 'terminal' : 'files'); } },
    { label: tr('keys.dupSession'), run: () => openSession(t.host, { adhoc: !!t.adhoc, password: t.password, passphrase: t.passphrase }) },
    ...(t.hostId ? [{ label: tr('ctx.editHost'), run: () => { const h = state.hosts.find((x) => x.id === t.hostId); if (h) openEditor(h); } }] : []),
    '-',
    { label: tr('ctx.closeOthers'), run: () => state.tabs.filter((x) => x.id !== t.id).forEach((x) => closeTab(x.id)) },
    { label: tr('btn.close'), danger: true, run: () => closeTab(t.id) },
  ]);
}

// ---------- Markering og dobbeltklik ----------
// Dobbeltklik registreres selv i stedet for via 'dblclick', fordi listen kan blive
// gentegnet mellem to klik (fx når en forbindelse skifter status), og så når
// browserens dblclick-hændelse aldrig frem.
let lastClick = { id: null, t: 0 };
function selectHost(id) {
  state.selected = id;
  document.querySelectorAll('.host-item, .card').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
}
function clickHost(h) {
  const now = Date.now();
  if (lastClick.id === h.id && now - lastClick.t < 450) {
    lastClick = { id: null, t: 0 };
    openSession(h);
  } else {
    lastClick = { id: h.id, t: now };
    selectHost(h.id);
  }
}

// ---------- Sprog ----------
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = tr(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = tr(el.dataset.i18nTitle);
    if (!el.dataset.i18n && el.matches('button')) el.setAttribute('aria-label', el.title); // ikonknapper
  });
}
async function setLanguage(lang) {
  I18N.setLang(lang);
  document.documentElement.lang = I18N.lang;
  localStorage.setItem('skal.lang', I18N.lang);
  $('#lang-select').value = I18N.lang;
  await api.setLang(I18N.lang); // dialoger og fejl fra hovedprocessen
  applyI18n();
  render();
  state.tabs.forEach((t) => t.cmd.relabel());
  if (state.editing) editorTexts();
}

// ---------- Data ----------
async function loadHosts() { state.hosts = await api.listHosts(); }

// ---------- Hændelser ----------
function bindUI() {
  $('#btn-new').onclick = () => openEditor({});
  $('#lang-select').innerHTML = Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#lang-select').onchange = (e) => setLanguage(e.target.value);
  $('#editor-close').onclick = closeEditor;
  $('#host-form').onsubmit = (e) => { e.preventDefault(); saveEditor(false); };
  $('#btn-save-connect').onclick = () => saveEditor(true);
  $('#btn-delete').onclick = () => state.editing?.id && deleteHost(state.editing);
  $('#host-form').elements.authType.onchange = syncAuth;
  $('#pick-key').onclick = async () => { const p = await api.pickKey(); if (p) $('#host-form').elements.keyPath.value = p; };
  $('#swatches').onclick = (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    const f = $('#host-form').elements.color;
    f.value = f.value === b.dataset.color ? '' : b.dataset.color;
    renderSwatches();
  };

  const search = $('#search');
  search.oninput = () => { state.filter = search.value; renderSidebar(); renderHome(); if (state.filter) activate('home'); };
  search.onkeydown = (e) => {
    if (e.key === 'Escape') { search.value = ''; state.filter = ''; render(); return; }
    if (e.key !== 'Enter') return;
    const quick = parseQuick(search.value);
    const list = filteredHosts();
    if (quick) openSession({ ...quick, name: '', authType: 'password' }, { adhoc: true });
    else if (list.length === 1) openSession(list[0]);
    else return;
    search.value = ''; state.filter = ''; renderSidebar(); renderHome();
  };

  const hostFromEvent = (e) => {
    const el = e.target.closest('[data-id]');
    return el ? state.hosts.find((h) => h.id === el.dataset.id) : null;
  };
  const editFromEvent = (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b) return false;
    e.stopPropagation();
    openEditor(state.hosts.find((h) => h.id === b.dataset.edit));
    return true;
  };

  const list = $('#host-list');
  list.onclick = (e) => {
    if (editFromEvent(e)) return;
    const g = e.target.closest('.group-head');
    if (g) { const n = g.dataset.group; state.collapsed.has(n) ? state.collapsed.delete(n) : state.collapsed.add(n); renderSidebar(); return; }
    const h = hostFromEvent(e); if (h) clickHost(h);
  };
  list.onkeydown = (e) => { if (e.key === 'Enter') { const h = hostFromEvent(e); if (h) openSession(h); } };
  list.oncontextmenu = (e) => { const h = hostFromEvent(e); if (h) hostCtx(e, h); };

  const home = $('#home-view');
  home.onclick = (e) => {
    if (e.target.closest('[data-action="new"]')) return openEditor({});
    if (editFromEvent(e)) return;
    const h = hostFromEvent(e); if (h) clickHost(h);
  };
  home.onkeydown = (e) => { if (e.key === 'Enter' && e.target.classList.contains('card')) { const h = hostFromEvent(e); if (h) openSession(h); } };
  home.oncontextmenu = (e) => { const h = hostFromEvent(e); if (h) hostCtx(e, h); };

  const tabbar = $('#tabbar');
  tabbar.onclick = (e) => {
    const c = e.target.closest('[data-close]');
    if (c) { e.stopPropagation(); return closeTab(c.dataset.close); }
    const t = e.target.closest('.tab'); if (t) activate(t.dataset.id);
  };
  tabbar.onauxclick = (e) => { if (e.button === 1) { const t = e.target.closest('.tab[data-id]'); if (t && t.dataset.id !== 'home') closeTab(t.dataset.id); } };
  tabbar.oncontextmenu = (e) => { const el = e.target.closest('.tab[data-id]'); const t = el && getTab(el.dataset.id); if (t) tabCtx(e, t); };

  $('#view-switch').onclick = (e) => {
    const b = e.target.closest('[data-view]'); const t = getTab(state.active);
    if (b && t && t.view !== b.dataset.view) setView(t, b.dataset.view);
  };
  // Filer sluppet uden for filpanelet må ikke få vinduet til at åbne dem
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  $('#home-view').addEventListener('change', (e) => {
    if (e.target.id !== 'metrics-toggle') return;
    state.metricsOn = e.target.checked;
    localStorage.setItem('skal.metrics', state.metricsOn ? '1' : '0');
    renderHome();
    if (state.metricsOn) pollMetrics(true);
  });

  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#ctx').hidden = true; if (!$('#editor').hidden && $('#modal').hidden) closeEditor(); }
    if (e.target.closest('.xterm')) return; // terminalen håndterer selv sine genveje
    if (handleShortcut(e)) e.preventDefault();
  });

  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitActive); }).observe($('#terms'));
}

// ---------- Start ----------
(async function init() {
  state.canEncrypt = await api.canEncrypt();
  await loadHosts();
  api.onData((id, data) => getTab(id)?.term.write(data));
  api.onClosed((id, msg, exited) => {
    const t = getTab(id);
    if (!t || t.status !== 'connected') return;
    if (exited) return closeTab(id); // brugeren skrev 'exit' – luk fanen
    // Ellers er forbindelsen faldet ud: behold fanen, så man kan genforbinde
    t.status = 'closed';
    t.cmd.onDisconnected();
    t.term.write(`\r\n\x1b[90m── ${tr('term.closed', { msg: msg ? ': ' + msg : '' })} ──\x1b[0m\r\n`);
    renderTabs();
  });
  bindUI();
  // Sprog: tidligere valg, ellers styresystemets sprog (engelsk hvis det ikke findes)
  await setLanguage(localStorage.getItem('skal.lang') || I18N.detect(await api.locale()));
})();
