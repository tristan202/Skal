const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  canEncrypt: () => ipcRenderer.invoke('app:canEncrypt'),
  setLang: (l) => ipcRenderer.invoke('app:setLang', l),
  locale: () => ipcRenderer.invoke('app:locale'),
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (h) => ipcRenderer.invoke('hosts:save', h),
  duplicateHost: (id) => ipcRenderer.invoke('hosts:duplicate', id),
  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (t) => ipcRenderer.invoke('clip:write', t),

  connect: (opts) => ipcRenderer.invoke('ssh:connect', opts),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  disconnect: (id) => ipcRenderer.send('ssh:disconnect', id),
  onData: (fn) => ipcRenderer.on('ssh:data', (_e, id, data) => fn(id, data)),
  // Filoverførsel
  sftp: {
    list: (sid, dir) => ipcRenderer.invoke('sftp:list', sid, dir),
    mkdir: (sid, p) => ipcRenderer.invoke('sftp:mkdir', sid, p),
    rename: (sid, from, to) => ipcRenderer.invoke('sftp:rename', sid, from, to),
    remove: (sid, p) => ipcRenderer.invoke('sftp:delete', sid, p),
    existing: (sid, dir, names) => ipcRenderer.invoke('sftp:existing', sid, dir, names),
    upload: (sid, id, paths, dir) => ipcRenderer.invoke('sftp:upload', sid, id, paths, dir),
    download: (sid, id, items, dir, opts) => ipcRenderer.invoke('sftp:download', sid, id, items, dir, opts),
    cancel: (id) => ipcRenderer.invoke('sftp:cancel', id),
    pickUpload: (folders) => ipcRenderer.invoke('sftp:pickUpload', folders),
    pickDir: () => ipcRenderer.invoke('sftp:pickDir'),
    onProgress: (fn) => ipcRenderer.on('sftp:progress', (_e, p) => fn(p)),
    edit: (sid, p) => ipcRenderer.invoke('sftp:edit', sid, p),
    stopEdits: (sid) => ipcRenderer.invoke('sftp:stopEdits', sid),
    onEdited: (fn) => ipcRenderer.on('sftp:edited', (_e, p) => fn(p)),
  },
  // Lokalt filsystem (venstre side i fil-commanderen)
  local: {
    info: () => ipcRenderer.invoke('local:info'),
    drives: () => ipcRenderer.invoke('local:drives'),
    list: (dir) => ipcRenderer.invoke('local:list', dir),
    mkdir: (p) => ipcRenderer.invoke('local:mkdir', p),
    rename: (from, to) => ipcRenderer.invoke('local:rename', from, to),
    trash: (paths) => ipcRenderer.invoke('local:trash', paths),
    existing: (dir, names) => ipcRenderer.invoke('local:existing', dir, names),
    open: (p) => ipcRenderer.invoke('local:open', p),
  },
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  pathForFile: (file) => webUtils.getPathForFile(file), // filer trukket ind fra Stifinder

  // Serverstatus
  metrics: (ids) => ipcRenderer.invoke('metrics:get', ids),
  ping: (ids) => ipcRenderer.invoke('ping:check', ids),

  onClosed: (fn) => ipcRenderer.on('ssh:closed', (_e, id, msg, exited) => fn(id, msg, exited)),
});
