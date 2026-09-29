// 앱 안 화면(app://terminas)에만 앱 기능(window.studioDesktop)을 넣는다. 다른 출처의 페이지에는 아무것도 안 넣는다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const origin = ipcRenderer.sendSync('studio:origin');

// "Error invoking remote method 'x': Error: 메시지" 에서 메시지만 남긴다
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((err) => {
    throw new Error(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  });

const listen = (channel, handler) => {
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('studioSetup', {
    get: () => invoke('setup:get'),
    save: (url) => invoke('setup:save', url),
    preview: (url) => invoke('setup:preview', url),
    retry: () => invoke('setup:retry'),
  });
} else if (origin && location.origin === origin) {
  contextBridge.exposeInMainWorld('studioDesktop', {
    version: ipcRenderer.sendSync('studio:version'),
    platform: process.platform,
    api: (method, path, body, apiLevel) => invoke('api:call', method, path, body, apiLevel),
    serverUrl: () => invoke('api:server'),
    serverInfo: () => invoke('api:server-info'),
    login: () => invoke('auth:login'),
    devLogin: (email) => invoke('auth:dev-login', email),
    passwordLogin: (id, password) => invoke('auth:password-login', id, password),
    inviteSignup: (o) => invoke('auth:invite-signup', o),
    setLang: (lang) => invoke('app:set-lang', lang),
    logout: () => invoke('auth:logout'),
    changeServer: () => invoke('auth:change-server'),
    unlock: {
      available: () => invoke('unlock:available'),
      remember: (userId, key) => invoke('unlock:remember', userId, key),
      recall: (userId) => invoke('unlock:recall', userId),
      forget: (userId) => invoke('unlock:forget', userId),
    },
    cache: {
      available: () => invoke('cache:available'),
      get: (name) => invoke('cache:get', name),
      put: (name, value) => invoke('cache:put', name, value),
      remove: (name) => invoke('cache:remove', name),
      list: () => invoke('cache:list'),
      clear: () => invoke('cache:clear'),
    },
    update: {
      check: () => invoke('update:check'),
      channel: () => invoke('update:channel'),
      setChannel: (channel) => invoke('update:set-channel', channel),
      install: () => ipcRenderer.send('update:install'),
      onStatus: (cb) => listen('update:status', (_e, s) => cb(s)),
    },
    pty: {
      shells: () => invoke('pty:shells'),
      spawn: (o) => invoke('pty:spawn', o),
      write: (id, data) => ipcRenderer.send('pty:write', id, data),
      resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
      kill: (id) => ipcRenderer.send('pty:kill', id),
      onData: (id, cb) => listen('pty:data', (_e, pid, data) => pid === id && cb(data)),
      onExit: (id, cb) => listen('pty:exit', (_e, pid, code) => pid === id && cb(code)),
    },
    http: {
      send: (o) => invoke('http:send', o),
      cancel: (id) => ipcRenderer.send('http:cancel', id),
    },
    ssh: {
      open: (o) => invoke('ssh:open', o),
      reply: (id, msg) => ipcRenderer.send('ssh:reply', id, msg),
      write: (id, data) => ipcRenderer.send('ssh:write', id, data),
      resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
      close: (id) => ipcRenderer.send('ssh:close', id),
      onEvent: (id, cb) => listen('ssh:event', (_e, cid, msg) => cid === id && cb(msg)),
      onData: (id, cb) => listen('ssh:data', (_e, cid, data) => cid === id && cb(data)),
      generateKey: (o) => invoke('ssh:keygen', o),
      inspectKey: (o) => invoke('ssh:inspect', o),
    },
    sftp: {
      list: (id, p) => invoke('sftp:list', id, p),
      stat: (id, p) => invoke('sftp:stat', id, p),
      mkdir: (id, p, ignoreExisting) => invoke('sftp:mkdir', id, p, ignoreExisting),
      rename: (id, from, to) => invoke('sftp:rename', id, from, to),
      remove: (id, paths) => invoke('sftp:remove', id, paths),
      chmod: (id, p, mode) => invoke('sftp:chmod', id, p, mode),
      read: (id, p, max) => invoke('sftp:read', id, p, max),
      write: (id, p, data) => invoke('sftp:write', id, p, data),
    },
    fs: {
      home: () => invoke('fs:home'),
      roots: () => invoke('fs:roots'),
      list: (p) => invoke('fs:list', p),
      mkdir: (p) => invoke('fs:mkdir', p),
      rename: (from, to) => invoke('fs:rename', from, to),
      remove: (paths) => invoke('fs:remove', paths),
      copy: (paths, destDir) => invoke('fs:copy', paths, destDir),
      join: (dir, name) => invoke('fs:join', dir, name),
      open: (p) => invoke('fs:open', p),
      pathForFile: (file) => webUtils.getPathForFile(file),
    },
    transfer: {
      upload: (o) => invoke('transfer:upload', o),
      download: (o) => invoke('transfer:download', o),
      copy: (o) => invoke('transfer:copy', o),
      cancel: (jobId) => ipcRenderer.send('transfer:cancel', jobId),
      onProgress: (cb) => listen('transfer:progress', (_e, p) => cb(p)),
    },
    forward: {
      start: (o) => invoke('forward:start', o),
      stop: (ruleId) => invoke('forward:stop', ruleId),
      list: () => invoke('forward:list'),
      onStatus: (cb) => listen('forward:status', (_e, s) => cb(s)),
    },
  });
}
