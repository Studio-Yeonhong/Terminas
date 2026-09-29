// Terminas 데스크톱 앱.
// 화면(React)은 앱 안에 들어 있고(app://terminas), 서버에서 코드를 받아 오지 않는다 — 서버가 화면을 바꿔치기해
// 비밀번호를 빼 가는 일을 막는다. SSH·SFTP·포트 포워딩은 이 PC 에서 서버로 직접 붙는다(ssh.js).
// 게이트웨이(Terminas 서버)에는 로그인·팀·볼트 암호문을 주고받을 때만 간다(API 는 여기서 Bearer 토큰으로 대신 부른다).
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeAll, closeConnectionsOf, registerSsh } from './ssh.js';
import { registerHttp } from './http.js';
import { clearPendingUpdates, guardUpdater, isPrerelease, loadUpdateKeys } from './update-verify.js';
import { MAIN_LANGS, mainLang, pickLang, setMainLang, setupTexts, tm } from './i18n-main.js';

const require = createRequire(import.meta.url);
const pty = require('@lydell/node-pty');
const { autoUpdater } = require('electron-updater');

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = 'http://localhost:5380';
const APP_ORIGIN = 'app://terminas';
const APP_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";

// 설치된 앱은 디버깅·인증서 무시·프록시·주소 바꿔치기 같은 실행 옵션을 받지 않는다 — 다른 프로그램이 이런 옵션으로 띄워 잠금이 풀린
// 볼트 키·비밀번호를 빼 가거나 서버 연결을 가로채지 못하게. (--inspect·NODE_OPTIONS·RunAsNode 는 빌드 퓨즈로도 막는다)
// 막을 것을 적은 목록이라 새로 알게 된 위험한 옵션은 여기에 더한다. --user-data-dir 은 막지 않는다(빌드한 앱을 버리는 프로필로 시험할 때 쓴다).
const BLOCKED_SWITCHES = [
  // 디버깅·개발자 도구
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'auto-open-devtools-for-tabs',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'js-flags',
  // 인증서 확인·보안 끄기
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'ignore-urlfetcher-cert-requests',
  'allow-insecure-localhost',
  'unsafely-treat-insecure-origin-as-secure',
  'disable-web-security',
  // (allow-file-access-from-files 는 넣지 않는다 — Electron 이 스스로 붙여서, 넣으면 앱이 늘 바로 꺼진다)
  'disable-site-isolation-trials',
  'no-sandbox',
  'disable-gpu-sandbox',
  // 연결 가로채기: 프록시·주소 바꿔치기·TLS 키 기록·네트워크 기록
  'proxy-server',
  'proxy-pac-url',
  'proxy-auto-detect',
  'host-rules',
  'host-resolver-rules',
  'ssl-key-log-file',
  'log-net-log',
  'net-log-capture-mode',
  // 다른 코드 끼워 넣기·다른 프로그램으로 하위 프로세스 띄우기
  'load-extension',
  'renderer-cmd-prefix',
  'gpu-launcher',
  'utility-cmd-prefix',
  'browser-subprocess-path',
];
if (app.isPackaged && BLOCKED_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) app.exit(1);
// 환경 변수 SSLKEYLOGFILE 이 있으면 Chromium 이 TLS 키를 그 파일에 적는다(서버 연결을 풀어 볼 수 있다) — 설치된 앱은 지우고 시작한다.
// 네트워크를 쓰기 전(ready 전)에 지워야 먹는다
if (app.isPackaged) delete process.env.SSLKEYLOGFILE;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// 개발: 설치된 앱과 따로 돌도록 설정 폴더를 나눈다 (한 개만 뜨게 하는 잠금도 폴더 기준)
if (!app.isPackaged && process.env.TERMINAS_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `Terminas-${process.env.TERMINAS_PROFILE.replace(/[^\w-]/g, '')}`));
}

// ---------- 설정 ----------
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const bundled = readJson(path.join(here, '..', 'app-config.json'));
let config = {};

// 처음 켤 때는 비어 있어 서버 고르기 화면(공식 서버 / 직접 운영하는 서버)이 뜬다. 공식 서버는 app-config.json 의 serverUrl
// STUDIO_SHELL_URL 은 개발·시험용 — 설치된 앱은 따르지 않는다(다른 프로그램이 서버 주소를 바꿔치기하지 못하게)
function serverUrl() {
  return (!app.isPackaged && process.env.STUDIO_SHELL_URL) || config.serverUrl || (app.isPackaged ? '' : DEV_URL);
}
// 0.2.8 까지는 고르지 않아도 공식 서버로 붙었다 — 공식 서버에 로그인해 둔 적이 있는 사람은 공식 서버를 고른 것으로 친다
function keepOfficialChoice() {
  if (config.serverUrl || !bundled.serverUrl) return;
  let origin = '';
  try {
    origin = new URL(bundled.serverUrl).origin;
  } catch {
    return;
  }
  const used = Boolean(config.tokens?.[origin]) || Object.keys(config.unlock ?? {}).some((k) => k.startsWith(`${origin}|`));
  if (used) saveConfig({ serverUrl: origin });
}
function serverOrigin() {
  try {
    return new URL(serverUrl()).origin;
  } catch {
    return '';
  }
}
function saveConfig(patch) {
  config = { ...config, ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}
// 내부망·VPN·이 PC 주소 (http 를 허락하는 곳): localhost, 10/8, 172.16/12, 192.168/16, 100.64/10(Tailscale 등), fc00::/7, fe80::/10
function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v6 = h.startsWith('[') ? h.slice(1, -1) : '';
  if (v6) return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
// 서버 주소: 도메인·IP 만 넣어도 된다(내부망 IP·localhost 는 http, 나머지는 https 를 붙인다).
// 인터넷 주소는 https 만 — 로그인 비밀번호·토큰이 그대로 보이지 않게.
function normalizeServer(input) {
  let text = String(input ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split('/')[0].replace(/:\d+$/, '');
    text = `${isPrivateHost(host) ? 'http' : 'https'}://${text}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(tm('badUrl'));
  }
  if (!url.hostname || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname)))) throw new Error(tm('httpsOnly'));
  return url.origin;
}

// ---------- 화면 (앱에 들어 있는 web/dist) ----------
// 개발 중에는 Vite 개발 서버를 띄운다(TERMINAS_UI=dist 면 빌드한 것을 앱과 똑같이 띄운다)
const devUi = () => !app.isPackaged && process.env.TERMINAS_UI !== 'dist';
const uiUrl = () => (devUi() ? process.env.TERMINAS_UI_URL || DEV_URL : `${APP_ORIGIN}/`);
const uiOrigin = () => (devUi() ? new URL(uiUrl()).origin : APP_ORIGIN);
// 설치된 앱: 화면은 app.asar 안(무결성 검사 대상) — 설치 폴더의 화면 파일을 고쳐 끼우지 못하게
// 개발: TERMINAS_UI_DIR 로 다른 빌드 폴더를 줄 수 있다(시험용 — 운영 서버가 쓰는 web/dist 를 건드리지 않으려고)
const uiDir = () => (app.isPackaged ? path.join(app.getAppPath(), 'ui') : process.env.TERMINAS_UI_DIR || path.join(here, '..', '..', 'web', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function serveUi() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'terminas') return new Response('not found', { status: 404 });
    const root = uiDir();
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('not found', { status: 404 });
    const st = await fs.promises.stat(file).catch(() => null);
    // 화면 안의 주소(예: /settings)는 모두 index.html 로 (한 페이지 앱)
    if (!st?.isFile()) {
      if (path.extname(file)) return new Response('not found', { status: 404 });
      file = path.join(root, 'index.html');
    }
    const body = await fs.promises.readFile(file).catch(() => null);
    if (!body) return new Response(tm('uiMissing'), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': APP_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
      },
    });
  });
}

// ---------- 창 ----------
let win = null;

function createWindow() {
  const bounds = config.bounds ?? { width: 1320, height: 840 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Terminas',
    backgroundColor: '#151925',
    icon: path.join(here, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#10131c', symbolColor: '#a9b0c4', height: 46 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // 설치된 앱에서는 개발자 도구를 열 수 없다 — "여기에 이걸 붙여 넣으세요" 식으로 잠금이 풀린 볼트 키를 빼 가지 못하게
      devTools: !app.isPackaged,
    },
  });
  if (config.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    if (!win.isMaximized() && !win.isMinimized()) saveConfig({ bounds: win.getBounds(), maximized: false });
    else saveConfig({ maximized: win.isMaximized() });
  });
  win.on('closed', () => (win = null));

  const wc = win.webContents;
  // 우리 화면(앱 안 화면·설정 페이지)만 창 안에서 연다. 나머지 링크는 시스템 브라우저로.
  wc.on('will-navigate', (e, url) => {
    if (isOurPage(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  // 새로고침·이동하면 그 화면이 열어 둔 SSH 연결을 닫는다
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      closeConnectionsOf(wc);
      killPtysOf(wc);
    }
  });
  wc.on('did-finish-load', () => updateState && wc.send('update:status', updateState));
  wc.on('before-input-event', (e, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });
  loadStart();
}

function loadStart() {
  if (!win) return;
  if (!serverUrl()) return win.loadFile(SETUP_FILE);
  win.loadURL(uiUrl());
}

// 서버 주소 설정 화면(setup.html — setup:save 로 서버를 바꿀 수 있다)인지: 앱 안의 바로 그 파일일 때만.
// 주소에 /setup.html 이 들어 있기만 한 다른 파일·공유 폴더(file://server/...)는 아니다. 앱은 이 화면에 ? 나 # 를 붙이지 않는다
const SETUP_FILE = path.join(here, 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_FILE).href;
function isSetupPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'file:' || u.host || u.search || u.hash) return false;
  if (u.href === SETUP_URL) return true;
  // Chromium 과 Node 가 경로를 퍼센트 인코딩하는 방식이 조금 달라, 같은 파일 경로인지로도 본다 (Windows 는 대소문자 무시)
  try {
    const file = path.resolve(fileURLToPath(u));
    return process.platform === 'win32' ? file.toLowerCase() === SETUP_FILE.toLowerCase() : file === SETUP_FILE;
  } catch {
    return false;
  }
}

function isOurPage(url) {
  if (url.startsWith('file:')) return isSetupPage(url);
  if (url.startsWith(`${APP_ORIGIN}/`)) return !devUi();
  try {
    return devUi() && new URL(url).origin === uiOrigin();
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString());
  } catch {}
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: tm('view'),
      // 개발자 도구는 개발 중에만 (설치된 앱은 메뉴·단축키 모두 없다)
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      label: tm('help'),
      submenu: [
        { label: tm('changeServer'), click: () => win?.loadFile(SETUP_FILE) },
        ...(UPDATES ? [{ label: tm('checkUpdates'), click: () => void checkForUpdates() }] : []),
        { label: `Terminas ${app.getVersion()}`, enabled: false },
      ],
    },
  ]);
}

// ---------- IPC 보안: 앱 화면에서 온 호출만 받는다 ----------
function fromUi(event) {
  const url = event.senderFrame?.url ?? '';
  if (!devUi()) return url.startsWith(`${APP_ORIGIN}/`);
  try {
    return new URL(url).origin === uiOrigin();
  } catch {
    return false;
  }
}
function fromSetupPage(event) {
  return isSetupPage(event.senderFrame?.url ?? '');
}
function handle(channel, fn, check = fromUi) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!check(event)) throw new Error('허용되지 않은 호출입니다');
    return fn(event, ...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromUi(event)) fn(event, ...args);
  });
}
const str = (v, name) => {
  if (typeof v !== 'string' || !v || v.length > 4096 || v.includes('\0')) throw new Error(`${name} 값이 올바르지 않습니다`);
  return v;
};
const absPath = (v) => {
  const p = str(v, 'path');
  if (!path.isAbsolute(p)) throw new Error('절대 경로가 필요합니다');
  return path.normalize(p);
};

// ---------- 로그인 토큰·잠금 해제 기억 (OS 보호 저장소로 암호화해서 설정 파일에) ----------
const canProtect = () => safeStorage.isEncryptionAvailable();
const protect = (value) => safeStorage.encryptString(value).toString('base64');
const unprotect = (value) => {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
};
let memoryToken = null;

function sessionToken() {
  if (memoryToken) return memoryToken;
  const saved = config.tokens?.[serverOrigin()];
  memoryToken = saved && canProtect() ? unprotect(saved) : null;
  return memoryToken;
}
function setSessionToken(token) {
  memoryToken = token;
  const tokens = { ...(config.tokens ?? {}) };
  if (token && canProtect()) tokens[serverOrigin()] = protect(token);
  else delete tokens[serverOrigin()];
  saveConfig({ tokens });
}

const unlockKey = (userId) => `${serverOrigin()}|${userId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- 게이트웨이 API (화면 대신 여기서 부른다) ----------
// apiLevel: 화면(web/src/compat.ts APP_API)의 API 수준 — 서버가 받아 주지 않는 오래된 앱이면 426 으로 돌려보낸다
async function apiCall(method, p, body, apiLevel) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('허용되지 않은 요청입니다');
  if (typeof p !== 'string' || !p.startsWith('/api/') || p.includes('..') || p.length > 2048) throw new Error('잘못된 요청 경로입니다');
  const base = serverUrl();
  if (!base) return { status: 0, data: { error: 'no_server', message: '서버 주소가 없습니다.' } };
  const headers = { 'x-shell': '1', 'x-terminas-app': app.getVersion() };
  if (Number.isInteger(apiLevel) && apiLevel > 0 && apiLevel < 1000) headers['x-terminas-api'] = String(apiLevel);
  const token = sessionToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    // 켤 때 맞춰 보는 요청은 짧게 — 서버에 닿지 않으면 곧바로 오프라인 사본으로 연다
    const ms = p === '/api/auth/config' ? 8_000 : 30_000;
    res = await net.fetch(`${base}${p}`, { method, headers, body: payload, signal: AbortSignal.timeout(ms) });
  } catch {
    return { status: 0, data: { error: 'network', message: 'Terminas 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.' } };
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 300) };
    }
  }
  return { status: res.status, data };
}

// ---------- 로그인 (시스템 브라우저 → 루프백 → 일회용 코드 교환) ----------
function doneHtml(ok, message) {
  return `<!doctype html><html lang="${mainLang()}"><meta charset="utf-8"><title>Terminas</title>
<body style="font-family:'Segoe UI','Malgun Gothic',sans-serif;background:#151925;color:#e7eaf3;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:44px">${ok ? '✓' : '!'}</div><h2 style="margin:8px 0">${message}</h2><p style="color:#a9b0c4">${tm('closeWindow')}</p></div></body>`;
}

async function desktopLogin() {
  if (!serverUrl()) return { ok: false, error: '서버 주소가 없습니다' };
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const result = new Promise((resolve) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(doneHtml(Boolean(code), code ? tm('loginOk') : tm('loginFail')));
      resolve({ code, error });
    });
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ error: 'timeout' }), 5 * 60 * 1000));
  await shell.openExternal(`${serverUrl()}/api/auth/google/start?desktop_port=${port}&desktop_challenge=${challenge}`);
  const { code, error } = await Promise.race([result, timeout]);
  server.close();
  if (!code) return { ok: false, error: error ?? 'cancelled' };
  const res = await apiCall('POST', '/api/auth/desktop/exchange', { code, verifier });
  if (res.status !== 200 || typeof res.data?.token !== 'string') return { ok: false, error: res.data?.message ?? '로그인하지 못했습니다' };
  setSessionToken(res.data.token);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.reload();
  }
  return { ok: true };
}

// ---------- 오프라인 사본 ----------
// 서버에 닿지 않을 때 쓰려고 이 PC 에 두는 계정 정보·볼트 사본. 볼트 내용은 이미 볼트 키로 암호화된 암호문(E2EE)이고,
// 그 위를 OS 보호 저장소(Windows DPAPI 등)로 한 번 더 감싸 이 PC 의 이 Windows 계정에서만 풀린다. 서버마다 폴더가 따로다.
// 무엇을 두고 언제 지울지는 화면(web/src/offline.ts)이 정한다. 로그아웃하면 그 서버의 폴더를 통째로 지운다.
const CACHE_NAME = /^(me|state|audit|vault\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CACHE_MAX = 256 * 1024 * 1024;
const cacheDir = (origin) => path.join(app.getPath('userData'), 'offline', crypto.createHash('sha256').update(origin).digest('hex').slice(0, 24));
function cacheFile(name) {
  if (typeof name !== 'string' || !CACHE_NAME.test(name)) throw new Error('값이 올바르지 않습니다');
  const origin = serverOrigin();
  if (!origin) throw new Error('서버 주소가 없습니다.');
  return path.join(cacheDir(origin), `${name}.bin`);
}
// 같은 이름을 동시에 쓰지 않게 차례로 (앞의 쓰기가 끝난 뒤 다음 것)
const cacheWrites = new Map();
function cacheQueue(file, fn) {
  const next = (cacheWrites.get(file) ?? Promise.resolve()).then(fn, fn);
  cacheWrites.set(file, next);
  return next.finally(() => cacheWrites.get(file) === next && cacheWrites.delete(file));
}
async function cacheGet(name) {
  if (!canProtect()) return null;
  const file = cacheFile(name);
  await cacheWrites.get(file)?.catch(() => {});
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf) return null;
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}
function cachePut(name, value) {
  if (!canProtect()) return false;
  if (typeof value !== 'string' || value.length > CACHE_MAX) throw new Error('값이 올바르지 않습니다');
  const file = cacheFile(name);
  return cacheQueue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, safeStorage.encryptString(value));
    await fs.promises.rename(tmp, file);
    return true;
  });
}
function cacheRemove(name) {
  const file = cacheFile(name);
  return cacheQueue(file, () => fs.promises.rm(file, { force: true }));
}
async function cacheList() {
  const origin = serverOrigin();
  if (!origin) return [];
  const names = await fs.promises.readdir(cacheDir(origin)).catch(() => []);
  return names.filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4)).filter((n) => CACHE_NAME.test(n));
}
async function cacheClear() {
  const origin = serverOrigin();
  if (!origin) return;
  await Promise.all([...cacheWrites.values()].map((p) => p.catch(() => {})));
  await fs.promises.rm(cacheDir(origin), { recursive: true, force: true });
}

async function logout() {
  if (sessionToken()) await apiCall('POST', '/api/auth/logout', {}).catch(() => {});
  setSessionToken(null);
  // 이 서버의 오프라인 사본도 지운다 (올리지 못한 변경이 있으면 화면이 먼저 물어본다)
  await cacheClear().catch(() => {});
  // 이 서버에 대해 기억한 잠금 해제도 지운다
  const unlock = { ...(config.unlock ?? {}) };
  for (const k of Object.keys(unlock)) if (k.startsWith(`${serverOrigin()}|`)) delete unlock[k];
  saveConfig({ unlock });
}

// 아이디·비밀번호 로그인 / 초대 코드로 가입 (서버가 SHELL_PASSWORD_LOGIN=1 일 때). 실패는 던지지 않고 돌려준다
// (IPC 로 던진 오류는 앞에 설명이 붙어 화면이 번역하지 못한다)
async function tokenLogin(p, body) {
  const res = await apiCall('POST', p, { ...body, desktop: true });
  if (res.status !== 200 || typeof res.data?.token !== 'string') return { ok: false, error: res.data?.error ?? 'error', message: res.data?.message ?? '로그인하지 못했습니다' };
  setSessionToken(res.data.token);
  return { ok: true };
}
const passwordLogin = (id, password) => tokenLogin('/api/auth/password', { id: str(id, 'id'), password: str(password, 'password') });
function inviteSignup(o) {
  const v = o && typeof o === 'object' ? o : {};
  return tokenLogin('/api/auth/invite-signup', { email: str(v.email, 'email'), code: str(v.code, 'code'), name: typeof v.name === 'string' ? v.name.slice(0, 80) : '', password: str(v.password, 'password') });
}

// 개발용 로그인(로컬 개발 서버 전용): 서버가 거절하면 그대로 실패한다
async function devLogin(email) {
  const res = await apiCall('POST', '/api/auth/dev-login-token', { email: str(email, 'email') });
  if (res.status !== 200 || typeof res.data?.token !== 'string') throw new Error(res.data?.message ?? '개발용 로그인에 실패했습니다');
  setSessionToken(res.data.token);
  return { ok: true };
}

// ---------- 로컬 터미널 ----------
const ptys = new Map();

function shells() {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return [{ id: 'default', label: path.basename(sh), file: sh, args: ['-l'] }];
  }
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const list = [];
  const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => fs.existsSync(p));
  if (pwsh) list.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
  list.push({ id: 'powershell', label: 'Windows PowerShell', file: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] });
  list.push({ id: 'cmd', label: tm('cmd'), file: path.join(sys, 'System32', 'cmd.exe'), args: [] });
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
  if (gitBash) list.push({ id: 'gitbash', label: 'Git Bash', file: gitBash, args: ['--login', '-i'] });
  if (fs.existsSync(path.join(sys, 'System32', 'wsl.exe'))) list.push({ id: 'wsl', label: 'WSL', file: path.join(sys, 'System32', 'wsl.exe'), args: [] });
  return list;
}

function spawnPty(event, { cols, rows, shell: shellId }) {
  const all = shells();
  const sh = all.find((s) => s.id === shellId) ?? (config.shell && all.find((s) => s.id === config.shell)) ?? all[0];
  const proc = pty.spawn(sh.file, sh.args, {
    name: 'xterm-256color',
    cols: Math.max(10, Math.min(500, Number(cols) || 80)),
    rows: Math.max(5, Math.min(300, Number(rows) || 24)),
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    // 함께 들어 있는 ConPTY 를 쓴다. OS ConPTY 로 닫을 때는 node-pty 가 앱 실행 파일을 Node 로 다시 띄우는데(fork),
    // 그 기능(RunAsNode)은 빌드 퓨즈로 꺼 두었다.
    useConptyDll: true,
  });
  const id = crypto.randomUUID();
  const wc = event.sender;
  ptys.set(id, { proc, wc });
  proc.onData((data) => !wc.isDestroyed() && wc.send('pty:data', id, data));
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!wc.isDestroyed()) wc.send('pty:exit', id, exitCode);
  });
  return { id, title: sh.label };
}

function killPtysOf(wc) {
  for (const [id, p] of ptys) {
    if (p.wc === wc) {
      try {
        p.proc.kill();
      } catch {}
      ptys.delete(id);
    }
  }
}

// ---------- 내 컴퓨터 파일 ----------
// 열면 곧바로 실행되는 파일 (프로그램·스크립트·바로 가기·설치 파일·레지스트리·매크로가 든 문서·디스크 이미지 등) —
// SFTP 로컬 창에서 더블클릭하면 묻고 연다 (받은 파일을 모르고 실행하지 않게)
const RISKY_EXT = new Set(
  (
    '.exe .com .scr .pif .cpl .msc .msi .msp .mst .msix .msixbundle .appx .appxbundle .application .appref-ms .gadget .xbap ' +
    '.bat .cmd .ps1 .psm1 .psd1 .ps1xml .psc1 .pssc .vb .vbs .vbe .js .jse .wsf .wsh .wsc .ws .sct .hta .jar .py .pyw .pyz .sh ' +
    '.lnk .url .website .scf .library-ms .search-ms .searchconnector-ms .settingcontent-ms .inf .ins .isp .reg .rdp .theme .themepack .diagcab .chm .hlp ' +
    '.docm .dotm .xlsm .xltm .xlam .xll .pptm .potm .ppam .ppsm .sldm .mdb .mde .accde .ade .adp ' +
    '.iso .img .vhd .vhdx .command .app .desktop'
  ).split(' '),
);
function riskyToOpen(file) {
  const name = path.basename(file);
  // Windows 는 이름 끝의 점·공백을 떼고 연다 (a.exe. → a.exe). 이름에 : 가 있으면 대체 데이터 스트림 — 묻는다
  if (process.platform === 'win32' && name.includes(':')) return true;
  return RISKY_EXT.has(path.extname(name.replace(/[. ]+$/, '')).toLowerCase());
}
async function openLocal(event, input) {
  const file = absPath(input);
  const st = await fs.promises.stat(file).catch(() => null);
  if (st && !st.isDirectory() && riskyToOpen(file)) {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? win;
    const options = {
      type: 'warning',
      title: 'Terminas',
      message: tm('openRiskyMessage'),
      detail: `${path.basename(file)}\n\n${tm('openRiskyDetail')}`,
      buttons: [tm('openAnyway'), tm('cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response !== 0) return;
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
}
const safeName = (name) => {
  const n = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return !n || n === '.' || n === '..' ? '_' : n;
};

function roots() {
  if (process.platform !== 'win32') return ['/'];
  return 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map((l) => `${l}:\\`).filter((r) => fs.existsSync(r));
}

async function listLocal(input) {
  // Windows 에서 '' 는 드라이브 목록("내 PC")
  if (input === '' && process.platform === 'win32') {
    return { path: '', parent: null, entries: roots().map((r) => ({ name: r.slice(0, 2), path: r, type: 'dir', size: 0, mtime: 0, link: false })) };
  }
  const dir = absPath(input);
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = (
    await Promise.all(
      dirents.map(async (d) => {
        const full = path.join(dir, d.name);
        try {
          const st = await fs.promises.stat(full);
          return { name: d.name, path: full, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs, link: d.isSymbolicLink() };
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  const up = path.dirname(dir);
  return { path: dir, parent: up !== dir ? up : process.platform === 'win32' ? '' : null, entries };
}

// ---------- 자동 업데이트 ----------
// 업데이트는 고른 서버와 상관없이 공식 배포처에서만 받는다 — 직접 운영하는 서버를 골라도 공식 앱은 공식 업데이트를 받는다.
// app-config.json 의 updateUrl(공식 배포처 — GitHub Releases). 설치 파일은 공식 키로 서명돼 있어야 설치된다(update-verify.js).
let updateState = null;
// 자동 업데이트는 Windows 만 — 설치 파일 서명 확인(update-verify.js)이 Windows 설치 프로그램(NSIS)에만 끼워져 있다.
// 다른 OS 는 업데이트를 확인·다운로드하지 않는다(새 버전은 직접 내려받아 설치)
const UPDATES = process.platform === 'win32';
// 업데이트는 GitHub Releases 에서만 받는다(1.0.0-beta.1 부터): 정식은 updateUrl(releases/latest),
// 베타 채널은 betaUpdateUrl(GitHub 의 고정 'beta' 릴리스). 공식 서버의 /updates 는 더 보지 않는다.
// app-config 에 updateFallbackUrl·betaFallbackUrl 을 적으면(직접 빌드하는 사람) 그다음에 본다.
// 베타 채널에는 정식 버전도 올라가므로(더 새것일 때) 베타를 켠 사람도 정식 업데이트를 받는다.
// 채널을 고른 적이 없으면: 베타 버전으로 설치한 앱은 베타 채널, 정식 버전은 정식 채널
const updateChannel = () => {
  if (config.updateChannel === 'beta' || config.updateChannel === 'stable') return config.updateChannel;
  return isPrerelease(app.getVersion()) ? 'beta' : 'stable';
};
const updateFeeds = () =>
  [
    ...new Set(
      (updateChannel() === 'beta' ? [bundled.betaUpdateUrl, ...[].concat(bundled.betaFallbackUrl ?? [])] : [bundled.updateUrl, ...[].concat(bundled.updateFallbackUrl ?? [])]).filter(Boolean),
    ),
  ];
// GitHub 에 아직 그 채널의 릴리스가 없으면(정식 릴리스 전 releases/latest 등) 404 — 오류가 아니라 "새 버전 없음"으로 본다
const noReleaseYet = (err) => /\b404\b|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/.test(`${err?.code ?? ''} ${err?.message ?? err}`);
// 앞 배포처를 확인하다 난 오류는 뒤 배포처를 볼 것이라 화면에 띄우지 않는다
let quietUpdateErrors = false;

function sendUpdate(status) {
  updateState = status;
  if (win && !win.webContents.isDestroyed()) win.webContents.send('update:status', status);
}

function setupUpdater() {
  const logFile = path.join(app.getPath('userData'), 'updater.log');
  const log = (level) => (...args) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`);
    } catch {}
  };
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} };
  // 새 버전은 뒤에서 받아 두기만 하고, 설치는 사람이 "다시 시작해 업데이트"를 눌러 확인했을 때만 한다.
  // (0.3.1 까지는 앱을 끌 때 저절로 설치했다 — 누르지 않았는데 버전이 바뀌어 놀랄 수 있어 끈다)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // 웹 설치 프로그램(설치 파일이 다른 곳에서 패키지를 또 받아 오는 방식)은 쓰지 않는다 — 받은 파일 그대로만 서명을 확인해 설치
  autoUpdater.disableWebInstaller = true;
  // 운영자 서명이 맞는 설치 파일만 설치한다 (update-verify.js). 전에 받아 둔 파일은 확인 없이 쓰일 수 있어 비운다.
  // 베타 버전(0.4.0-beta.1 처럼 - 가 붙은 것)은 베타 채널에 들어간 사람만 — 정식 채널 피드가 서명된 베타를 내밀어도 받지 않는다
  guardUpdater(autoUpdater, {
    keys: loadUpdateKeys(path.join(here, '..', 'update-keys.json')),
    currentVersion: app.getVersion(),
    allowPrerelease: () => updateChannel() === 'beta',
    log: log('info'),
  });
  if (app.isPackaged) clearPendingUpdates(process.resourcesPath);
  let pending = '';
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    pending = info.version;
    sendUpdate({ state: 'available', version: info.version, percent: 0 });
  });
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', version: pending, percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) =>
    !quietUpdateErrors &&
    !noReleaseYet(err) &&
    sendUpdate({
      state: 'error',
      message: err?.code === 'ERR_UPDATER_INVALID_SIGNATURE' ? '업데이트 서명이 맞지 않아 설치하지 않았습니다. 관리자에게 알려 주세요.' : String(err?.message ?? err).split('\n')[0],
    }),
  );
}

async function checkForUpdates() {
  const feeds = updateFeeds();
  if (!UPDATES || !app.isPackaged || !feeds.length) return;
  if (updateState?.state === 'downloading' || updateState?.state === 'downloaded') return;
  // 확인할 때마다 전에 받아 둔 설치 파일을 비운다 — 켤 때는 방금 끝난 설치 프로그램이 아직 그 파일을 쥐고 있어 못 지울 수 있다
  clearPendingUpdates(process.resourcesPath);
  autoUpdater.allowPrerelease = updateChannel() === 'beta';
  for (let i = 0; i < feeds.length; i++) {
    const last = i === feeds.length - 1;
    autoUpdater.setFeedURL({ provider: 'generic', url: feeds[i] });
    quietUpdateErrors = !last;
    try {
      await autoUpdater.checkForUpdates();
      quietUpdateErrors = false;
      return;
    } catch (err) {
      quietUpdateErrors = false;
      const message = String(err?.message ?? err).split('\n')[0];
      autoUpdater.logger?.warn?.(`update feed ${feeds[i]} failed: ${message}`);
      if (last) sendUpdate(noReleaseYet(err) ? { state: 'none' } : { state: 'error', message });
    }
  }
}

// ---------- 등록 ----------
function registerIpc() {
  ipcMain.on('studio:origin', (e) => (e.returnValue = uiOrigin()));
  ipcMain.on('studio:version', (e) => (e.returnValue = app.getVersion()));

  handle('api:call', (_e, method, p, body, apiLevel) => apiCall(method, p, body, apiLevel));
  handle('api:server', () => serverUrl());
  handle('api:server-info', () => {
    let official = false;
    try {
      official = Boolean(bundled.serverUrl) && new URL(bundled.serverUrl).origin === new URL(serverUrl()).origin;
    } catch {}
    return { url: serverUrl(), official };
  });
  handle('auth:login', () => desktopLogin());
  handle('auth:dev-login', (_e, email) => devLogin(email));
  handle('auth:password-login', (_e, id, password) => passwordLogin(id, password));
  handle('auth:invite-signup', (_e, o) => inviteSignup(o));
  handle('auth:logout', () => logout());
  // (setTimeout 의 반환값은 IPC 로 보낼 수 없어 void — 돌려주면 화면 쪽 약속이 "could not be cloned" 로 실패한다)
  handle('auth:change-server', () => void setTimeout(() => win?.loadFile(SETUP_FILE), 50));

  // 잠금 해제 기억: 계정 키를 OS 보호 저장소(Windows DPAPI 등)로 감싸 이 PC 에만 둔다
  handle('unlock:available', () => canProtect());
  handle('unlock:remember', (_e, userId, keyB64) => {
    if (!UUID.test(String(userId)) || !/^[A-Za-z0-9+/]{43}=$/.test(String(keyB64))) throw new Error('값이 올바르지 않습니다');
    if (!canProtect()) throw new Error('이 PC에서는 안전하게 기억할 수 없습니다');
    saveConfig({ unlock: { ...(config.unlock ?? {}), [unlockKey(userId)]: protect(keyB64) } });
  });
  handle('unlock:recall', (_e, userId) => {
    const saved = config.unlock?.[unlockKey(String(userId))];
    return saved && canProtect() ? unprotect(saved) : null;
  });
  handle('unlock:forget', (_e, userId) => {
    const unlock = { ...(config.unlock ?? {}) };
    delete unlock[unlockKey(String(userId))];
    saveConfig({ unlock });
  });

  // 오프라인 사본 (위의 "오프라인 사본" 참고)
  handle('cache:available', () => canProtect());
  handle('cache:get', (_e, name) => cacheGet(name));
  handle('cache:put', (_e, name, value) => cachePut(name, value));
  handle('cache:remove', (_e, name) => cacheRemove(name));
  handle('cache:list', () => cacheList());
  handle('cache:clear', () => cacheClear());

  handle('update:check', () => checkForUpdates());
  // 업데이트 채널: 정식 / 베타 (설정 화면이 경고를 보여 준 뒤 바꾼다)
  handle('update:channel', () => ({ channel: updateChannel(), prerelease: /-/.test(app.getVersion()) }));
  handle('update:set-channel', (_e, next) => {
    if (next !== 'beta' && next !== 'stable') throw new Error('값이 올바르지 않습니다');
    if (updateChannel() === next) return;
    saveConfig({ updateChannel: next });
    // 베타에서 받아 둔 베타 설치 파일은 정식으로 돌아가면 설치하지 않는다
    if (next === 'stable' && updateState?.state === 'downloaded' && /-/.test(String(updateState.version ?? ''))) {
      clearPendingUpdates(process.resourcesPath);
      sendUpdate({ state: 'none' });
    }
    if (updateState?.state !== 'downloading' && updateState?.state !== 'downloaded') void checkForUpdates();
  });
  // 화면이 언어를 바꾸면 메뉴·설정 화면·로그인 끝 화면도 따라간다
  handle('app:set-lang', (_e, next) => {
    if (!MAIN_LANGS.includes(next)) return;
    setMainLang(next);
    if (config.lang !== next) saveConfig({ lang: next });
    Menu.setApplicationMenu(buildMenu());
  });
  on('update:install', () => {
    if (updateState?.state === 'downloaded') setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  handle('pty:shells', () => shells().map(({ id, label }) => ({ id, label })));
  handle('pty:spawn', (e, o) => spawnPty(e, o ?? {}));
  on('pty:write', (_e, id, data) => typeof data === 'string' && ptys.get(id)?.proc.write(data));
  on('pty:resize', (_e, id, cols, rows) => {
    const p = ptys.get(id);
    if (p && cols > 0 && rows > 0) p.proc.resize(Math.min(500, cols), Math.min(300, rows));
  });
  on('pty:kill', (_e, id) => {
    const p = ptys.get(id);
    if (!p) return;
    ptys.delete(id);
    try {
      p.proc.kill();
    } catch {}
  });

  handle('fs:home', () => os.homedir());
  handle('fs:roots', () => roots());
  handle('fs:list', (_e, p) => listLocal(p));
  handle('fs:mkdir', async (_e, p) => void (await fs.promises.mkdir(absPath(p))));
  handle('fs:rename', async (_e, from, to) => {
    if (fs.existsSync(absPath(to))) throw new Error('같은 이름이 이미 있습니다.');
    await fs.promises.rename(absPath(from), absPath(to));
  });
  // 지울 때는 휴지통으로 (실수해도 되살릴 수 있게)
  handle('fs:remove', async (_e, paths) => {
    for (const p of paths ?? []) await shell.trashItem(absPath(p));
  });
  handle('fs:copy', async (_e, paths, destDir) => {
    for (const p of paths ?? []) {
      const src = absPath(p);
      const dst = path.join(absPath(destDir), path.basename(src));
      if (dst === src || dst.startsWith(src + path.sep)) throw new Error('폴더를 자기 안으로 복사할 수 없습니다');
      await fs.promises.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    }
  });
  handle('fs:join', (_e, dir, name) => path.join(absPath(dir), safeName(name)));
  handle('fs:open', (e, p) => openLocal(e, p));

  registerSsh({ handle, on });
  // HTTP 요청 도구: 이 PC 에서 바로 보낸다 (http.js)
  registerHttp({ handle, on });

  // 설정 화면(로컬 파일)
  handle('setup:get', () => ({ serverUrl: serverUrl(), official: bundled.serverUrl ?? '', texts: setupTexts() }), fromSetupPage);
  // 입력 중인 주소가 http(암호화 안 됨)로 붙는지 — 설정 화면이 경고를 보여 준다
  handle(
    'setup:preview',
    (_e, input) => {
      try {
        return { origin: normalizeServer(input), error: '' };
      } catch (err) {
        return { origin: '', error: String(err.message ?? err) };
      }
    },
    fromSetupPage,
  );
  handle(
    'setup:save',
    async (_e, input) => {
      const origin = normalizeServer(input);
      const res = await net.fetch(`${origin}/api/auth/config`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (!data || typeof data.google !== 'boolean') throw new Error(tm('notTerminas'));
      memoryToken = null;
      saveConfig({ serverUrl: origin });
      setTimeout(loadStart, 50);
      return { ok: true };
    },
    fromSetupPage,
  );
  handle('setup:retry', () => void setTimeout(loadStart, 50), fromSetupPage);
}

// ---------- 시작 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    config = readJson(configFile());
    keepOfficialChoice();
    setMainLang(pickLang(config.lang, app.getLocale()));
    app.setAppUserModelId('studio.yeonhong.terminas');
    Menu.setApplicationMenu(buildMenu());
    serveUi();
    // 권한: 앱 화면의 클립보드·알림만
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      cb(allowed.has(permission) && isOurPage(details.requestingUrl ?? ''));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && origin === uiOrigin());
    registerIpc();
    if (UPDATES) {
      setupUpdater();
      setTimeout(checkForUpdates, 15_000);
      setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
    }
    app.on('web-contents-created', (_e, contents) => {
      contents.on('destroyed', () => {
        killPtysOf(contents);
        closeConnectionsOf(contents);
      });
      // 설치된 앱: 어떤 길로든 개발자 도구가 열리면 바로 닫는다 (창 설정 devTools: false 에 더해)
      if (app.isPackaged) contents.on('devtools-opened', () => contents.closeDevTools());
    });
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on('window-all-closed', () => {
    closeAll();
    for (const p of ptys.values()) {
      try {
        p.proc.kill();
      } catch {}
    }
    if (process.platform !== 'darwin') app.quit();
  });
}
