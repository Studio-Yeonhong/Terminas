// 보안 검토(2026-09-27) 수정 확인. reproduce.mjs 가 닿지 못하는 경우까지 격리 환경에서 확인한다.
// 운영 DB·자격증명·실제 SSH 서버는 쓰지 않는다. 저장소 루트에서: node security-review/verify-fixes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as E from '../web/src/e2ee.ts';

// 웹 SSH 엔진은 확장자 없이 서로를 가져오고(Vite 방식) 생성자 매개변수 속성을 쓴다 → 여기서만 .ts 를 붙이고 변환한다
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]s$/.test(s)) return n(s + '.ts', c); throw e; } }
export async function load(url, c, n) {
  if (url.startsWith('file:') && url.includes('/web/src/ssh/') && url.endsWith('.ts')) {
    const src = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: stripTypeScriptTypes(src, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
  }
  return n(url, c);
}`),
);

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-fixes-'));
const results = [];
const sockets = [];
let child, tcp;
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  results.push({ name, ok, ...evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const placeholder = net.createServer();
const port = await listen(placeholder);
await new Promise((r) => placeholder.close(r));
const base = `http://127.0.0.1:${port}`;

async function start(production) {
  child = spawn(process.execPath, ['src/index.ts'], {
    cwd: path.join(root, 'server'),
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: production ? 'production' : 'development',
      SHELL_PORT: String(port),
      SHELL_HOST: '127.0.0.1',
      SHELL_PUBLIC_URL: base,
      SHELL_DATA_DIR: data,
      SHELL_UPDATES_DIR: path.join(data, 'updates'),
      SHELL_LOG_FILE: path.join(data, 'server.log'),
      SHELL_DEV_LOGIN: production ? '0' : '1',
      SHELL_BOOTSTRAP_ADMINS: 'owner@example.test',
      SHELL_TRUST_PROXY: '0',
      // 운영 모드 시험은 누구나 가입 서버처럼 사설망을 서버 관리자만 (viewer 는 관리자가 아니다)
      SHELL_RELAY_PRIVATE: production ? 'admins' : '',
      SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: '0',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('Test server did not start');
}
async function stop() {
  if (child && child.exitCode === null) {
    const p = once(child, 'exit');
    child.kill();
    await p;
  }
  child = null;
}
async function api(method, p, token, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login(email) {
  const r = await api('POST', '/api/auth/dev-login-token', null, { email });
  if (!r.body?.token) throw new Error('Login failed');
  return r.body.token;
}
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
function relay(token, host, targetPort) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/relay?host=${encodeURIComponent(host)}&port=${targetPort}`, { headers: { origin: base, authorization: `Bearer ${token}` } });
  sockets.push(ws);
  const events = [];
  ws.on('message', (b, binary) => events.push(binary ? { binary: b.toString() } : JSON.parse(b.toString())));
  ws.on('close', (code) => events.push({ close: code }));
  const waitFor = async (pred, ms = 3000) => {
    for (let t = 0; t < ms; t += 25) {
      if (events.some(pred)) return true;
      await sleep(25);
    }
    return false;
  };
  const send = (s) => ws.readyState === WebSocket.OPEN && ws.send(Buffer.from(s));
  return { ws, events, waitFor, send };
}

try {
  // ---------- 개발 모드: 로그아웃·세션 재확인(F-05), 키 초기화(F-06), KDF 범위 ----------
  await start(false);
  tcp = net.createServer((s) => {
    s.write('SSH-2.0-verify-fixture\r\n');
    s.on('data', (b) => s.write(b));
    s.on('error', () => {});
  });
  const sshPort = await listen(tcp);
  const db = new DatabaseSync(path.join(data, 'shell.db'));

  const s1 = await login('owner@example.test');
  const s2 = await login('owner@example.test');
  const r1 = relay(s1, '127.0.0.1', sshPort);
  const r2 = relay(s2, '127.0.0.1', sshPort);
  await r1.waitFor((e) => e.t === 'open');
  await r2.waitFor((e) => e.t === 'open');
  r1.send('before-logout');
  const echoedBefore = await r1.waitFor((e) => e.binary?.includes('before-logout'));
  await api('POST', '/api/auth/logout', s1, {});
  const closed1 = await r1.waitFor((e) => e.close === 4401, 1000);
  r1.send('after-logout');
  await sleep(200);
  r2.send('other-session');
  const otherAlive = await r2.waitFor((e) => e.binary?.includes('other-session'));
  check('F-05 로그아웃하면 그 세션의 중계가 닫힌다', echoedBefore && closed1 && !r1.events.some((e) => e.binary?.includes('after-logout')) && otherAlive, { echoedBefore, closed4401: closed1, otherSessionStillWorks: otherAlive });

  // 세션 행이 사라지면(만료·강제 종료) 주기 재확인(30초)에서 닫힌다
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashOf(s2));
  const t0 = Date.now();
  const closed2 = await r2.waitFor((e) => e.close === 4401, 35_000);
  check('F-05 세션이 없어지면 열린 중계도 30초 안에 닫힌다', closed2, { seconds: Math.round((Date.now() - t0) / 1000) });

  // 팀 볼트 초대 → 보기 전용 멤버
  const owner = await login('owner@example.test');
  const team = (await api('POST', '/api/teams', owner, { name: 'verify fixture' })).body;
  await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'viewer@example.test', role: 'member' });
  const v1 = await login('viewer@example.test');
  const viewerMe = (await api('GET', '/api/me', v1)).body;
  const viewerKeys = await E.createAccount(viewerMe.user.id, 'fixture-password-not-used-elsewhere');
  await api('POST', '/api/me/keys', v1, viewerKeys);
  const pv = viewerMe.vaults.find((v) => v.kind === 'personal').id;
  await api('POST', `/api/vaults/${pv}/items`, v1, { id: crypto.randomUUID(), kind: 'host', data: 'v1.YQ==' });
  const items = async (t) => (await api('GET', `/api/vaults/${pv}/items`, t)).body?.length;

  const freshAllowed = (await api('GET', '/api/me/keys/reset', v1)).body;
  // 로그인한 지 11분 지난 세션으로 만든다
  db.prepare('UPDATE sessions SET created_at = created_at - ? WHERE id_hash = ?').run(11 * 60 * 1000, hashOf(v1));
  const oldAllowed = (await api('GET', '/api/me/keys/reset', v1)).body;
  const newKeys = await E.createAccount(viewerMe.user.id, 'another-fixture-password');
  const refused = await api('POST', '/api/me/keys/reset', v1, { confirm: 'RESET', ...newKeys });
  check('F-06 오래된 세션으로는 초기화가 거절되고 개인 볼트가 그대로다', freshAllowed?.allowed === true && oldAllowed?.allowed === false && refused.status === 403 && refused.body?.error === 'reauth_required' && (await items(v1)) === 1, {
    freshAllowed: freshAllowed?.allowed,
    oldAllowed: oldAllowed?.allowed,
    status: refused.status,
    error: refused.body?.error,
    personalItems: await items(v1),
  });

  const v2 = await login('viewer@example.test');
  const rOld = relay(v1, '127.0.0.1', sshPort);
  await rOld.waitFor((e) => e.t === 'open');
  const accepted = await api('POST', '/api/me/keys/reset', v2, { confirm: 'RESET', ...newKeys });
  const oldSessionAfter = (await api('GET', '/api/me', v1)).status;
  const newSessionAfter = (await api('GET', '/api/me', v2)).status;
  const oldRelayClosed = await rOld.waitFor((e) => e.close === 4401, 1000);
  check('F-06 방금 로그인한 세션으로는 초기화되고, 다른 세션과 그 중계는 끊긴다', accepted.status === 200 && oldSessionAfter === 401 && newSessionAfter === 200 && oldRelayClosed, {
    status: accepted.status,
    oldSession: oldSessionAfter,
    newSession: newSessionAfter,
    oldRelayClosed4401: oldRelayClosed,
  });

  // KDF 값 범위 (서버)
  const put = (kdf) => api('PUT', '/api/me/keys', v2, { bundle: { ...newKeys.bundle, kdf: { ...newKeys.bundle.kdf, ...kdf } }, proof: newKeys.proof, reason: 'fixture' });
  const unchanged = (await put({})).status;
  const tooHeavy = (await put({ m: 4 * 1024 * 1024 })).status;
  const tooLight = (await put({ m: 1024 })).status;
  const zeroT = (await put({ t: 0 })).status;
  check('KDF 범위 밖 묶음은 서버가 받지 않는다', unchanged === 200 && [tooHeavy, tooLight, zeroT].every((s) => s === 400), { sameValues: unchanged, m4GiB: tooHeavy, m1MiB: tooLight, t0: zeroT });
  // KDF 값 범위 (화면)
  let clientRefused = false;
  try {
    await E.deriveKek('x', { ...newKeys.bundle.kdf, m: 4 * 1024 * 1024 });
  } catch {
    clientRefused = true;
  }
  check('KDF 범위 밖 값이면 화면이 계산을 시작하지 않는다', clientRefused);
  db.close();

  // ---------- 운영 모드: 주소 차단(F-04) ----------
  await stop();
  await start(true);
  // 운영 모드는 개발 로그인이 없다 → 같은 DB 의 세션을 그대로 쓴다 (v2 는 살아 있다)
  const own = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => a.address.split('%')[0]);
  const targets = ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::', '::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '169.254.169.254', 'fe80::1', ...own];
  const outcomes = {};
  for (const host of targets) {
    const r = relay(v2, host, sshPort);
    await r.waitFor((e) => e.t === 'error' || e.t === 'open' || e.close);
    const ev = r.events.find((e) => e.t === 'error' || e.t === 'open');
    outcomes[host] = ev?.t === 'open' ? 'OPEN' : ev?.message === '해당 주소로는 연결할 수 없습니다.' ? 'blocked' : (ev?.message ?? JSON.stringify(r.events));
  }
  check('F-04 루프백·매핑·호환·링크 로컬·이 서버 자신의 주소는 모두 막힌다', Object.values(outcomes).every((o) => o === 'blocked'), outcomes);

  // 막으면 안 되는 주소는 통과하는지: 운영 코드의 blockedAddress 를 그대로 떼어 판정만 한다 (연결하지 않는다)
  const relaySrc = fs.readFileSync(path.join(root, 'server/src/relay.ts'), 'utf8');
  const denySrc = relaySrc.slice(relaySrc.indexOf('const deny = new net.BlockList()'), relaySrc.indexOf('\nfunction blocked('));
  const js = denySrc.replace('export function', 'function').replace('(ip: string)', '(ip)');
  const blockedAddress = vm.runInNewContext(`${js}\nblockedAddress`, { net, os, Object });
  const allowed = ['8.8.8.8', '1.1.1.1', '10.99.88.77', '192.0.2.10', '::ffff:8.8.8.8', '2001:4860:4860::8888'].filter((a) => !own.includes(a));
  const allowedOutcomes = Object.fromEntries(allowed.map((a) => [a, blockedAddress(a) ? 'blocked' : 'allowed']));
  check('F-04 일반 주소는 막지 않는다 (판정만, 연결 안 함)', Object.values(allowedOutcomes).every((o) => o === 'allowed'), allowedOutcomes);

  // ---------- 사설망: 관리자가 아닌 사람의 웹 접속은 연결을 시도하기 전에 막힌다 (SHELL_RELAY_PRIVATE=admins) ----------
  const privTargets = ['10.99.88.77', '172.20.1.2', '192.168.77.66', '100.100.1.1', 'fd12:3456::1', '::ffff:10.99.88.77'].filter((a) => !own.includes(a));
  const privOutcomes = {};
  for (const host of privTargets) {
    const r = relay(v2, host, 22);
    await r.waitFor((e) => e.t === 'error' || e.t === 'open' || e.close);
    const ev = r.events.find((e) => e.t === 'error' || e.t === 'open');
    privOutcomes[host] = ev?.message?.startsWith('이 서버에서는 내부망 주소로') ? 'blocked' : (ev?.message ?? ev?.t ?? JSON.stringify(r.events));
  }
  check('사설망 주소는 관리자가 아니면 웹 접속이 막힌다', Object.values(privOutcomes).every((o) => o === 'blocked'), privOutcomes);
  const intSrc = relaySrc.slice(relaySrc.indexOf('const internal = new net.BlockList()'), relaySrc.indexOf('\nfunction internalAllowed('));
  const internalAddress = vm.runInNewContext(`${intSrc.replace('export function', 'function').replace('(ip: string)', '(ip)').replace(/ as const/g, '')}\ninternalAddress`, { net });
  const pub = ['8.8.8.8', '203.0.113.9', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  const pubOutcomes = Object.fromEntries(pub.map((a) => [a, internalAddress(a) ? 'internal' : 'public']));
  check('공인 주소는 사설망으로 보지 않는다 (판정만)', Object.values(pubOutcomes).every((o) => o === 'public'), pubOutcomes);
} finally {
  for (const s of sockets) s.terminate();
  if (tcp) await new Promise((r) => tcp.close(r));
  await stop();
}

// ---------- 웹 엔진: 파일 이름으로 폴더 밖을 건드리지 않는다 (F-02) ----------
globalThis.window = globalThis.window ?? {};
const { sftpOps } = await import(pathToFileURL(path.join(root, 'web/src/ssh/sftp.ts')).href);
const { copyRemote } = await import(pathToFileURL(path.join(root, 'web/src/ssh/transfer.ts')).href);
const file = { mode: 0o100644, size: 1, mtime: 0 };
const dir = { mode: 0o040755, size: 0, mtime: 0 };
const evil = [
  { filename: '.', attrs: dir },
  { filename: '..', attrs: dir },
  { filename: '../../outside.txt', attrs: file },
  { filename: 'a/b', attrs: file },
  { filename: 'nul\u0000x', attrs: file },
  { filename: 'ok.txt', attrs: file },
];
const removed = [];
const mockClient = {
  readdir: async () => evil,
  stat: async (p) => (p === '/src' ? dir : file),
  lstat: async (p) => (p === '/victim' ? dir : file),
  unlink: async (p) => removed.push(p),
  rmdir: async (p) => removed.push(p),
};
const ops = sftpOps(mockClient);
const names = (await ops.listDir('/src')).map((e) => e.name);
check('F-02 웹 목록은 경로가 섞인 이름을 버린다', names.length === 1 && names[0] === 'ok.txt', { names });

let removeError = '';
try {
  await ops.removeRecursive('/victim');
} catch (err) {
  removeError = err.message;
}
check('F-02 웹 폴더 지우기는 이상한 이름을 만나면 멈추고 밖을 지우지 않는다', Boolean(removeError) && !removed.some((p) => !p.startsWith('/victim/')), { removed, stopped: Boolean(removeError) });

// 목록 필터를 누가 우회해도 복사 단계의 경계 확인이 막는지 (listDir 를 직접 흉내)
const written = [];
const job = { signal: { aborted: false }, onBytes() {}, onFile() {} };
const toOps = { client: { exists: async () => false, open: async () => 'h', write: async () => {}, close: async () => {}, renameOver: async (_a, b) => written.push(b), unlink: async () => {} }, mkdir: async () => {} };
const fromWith = (entries) => ({ client: { stat: async (p) => (p === '/src' ? dir : { ...file, size: 0 }), open: async () => 'h', close: async () => {}, read: async () => new Uint8Array(0) }, listDir: async () => entries });
const outcome = async (entries) => {
  try {
    await copyRemote(fromWith(entries), toOps, ['/src'], '/approved', false, false, job);
    return 'copied';
  } catch (err) {
    return err.message;
  }
};
const escapeTry = await outcome([{ name: '../../outside.txt', path: '/src/../../outside.txt', type: 'file' }]);
const backslashTry = await outcome([{ name: '..\\..\\outside.txt', path: '/src/x', type: 'file' }]);
const normal = await outcome([{ name: 'ok.txt', path: '/src/ok.txt', type: 'file' }]);
check('F-02 웹 서버간 복사는 대상 폴더 밖 경로·역슬래시 이름을 거절한다', !written.some((p) => !p.startsWith('/approved/src/')) && escapeTry !== 'copied' && backslashTry !== 'copied' && normal === 'copied', { escapeTry, backslashTry, normal, written });

// ---------- 앱 엔진: 같은 확인 (운영 코드를 그대로 떼어 모의 SFTP 로) ----------
const desktop = fs.readFileSync(path.join(root, 'desktop/src/ssh.js'), 'utf8');
const copyFn = desktop.slice(desktop.indexOf('function copyRemote('), desktop.indexOf('// ---------- 포트 포워딩'));
const removeFn = desktop.slice(desktop.indexOf('async function removeRecursive('), desktop.indexOf('\n// 덮어쓰기까지 되는 이름 바꾸기'));
const appWritten = [];
const appRemoved = [];
const ctx = (entries) => ({
  posix: path.posix,
  call: (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value)))),
  rstat: async (_s, p) => ({ mode: p === '/source/folder' ? 0o040755 : 0o100644, size: 0 }),
  rlstat: async (_s, p) => ({ mode: p === '/victim' ? 0o040755 : 0o100644 }),
  isDir: (a) => (a.mode & 0o170000) === 0o040000,
  listDir: async () => entries,
  sftpOf: () => ({ readdir: (_p, cb) => cb(null, [{ filename: '../outside', attrs: {} }]), unlink: (p, cb) => (appRemoved.push(p), cb()), rmdir: (p, cb) => (appRemoved.push(p), cb()) }),
  text: (v) => v,
  runJob: async (_w, _j, fn) => fn({ signal: { aborted: false }, state: {}, add() {}, fileDone() {} }),
  mkdirp: async () => {},
  rexists: async () => false,
  existsError: (p) => new Error(p),
  tmpName: (d, n) => path.posix.join(d, `.${n}.part`),
  xfer: async () => {},
  renameOver: async (_s, _a, dst) => appWritten.push(dst),
});
const appCopy = async (entries) => {
  try {
    await vm.runInNewContext(`${copyFn}\ncopyRemote`, ctx(entries))({}, { fromConn: 'a', toConn: 'b', toDir: '/approved', paths: ['/source/folder'], overwrite: false, jobId: 'x' });
    return 'copied';
  } catch (err) {
    return err.message;
  }
};
const appEscape = await appCopy([{ name: '../../outside.txt', path: '/source/folder/x' }]);
const appBackslash = await appCopy([{ name: '..\\..\\outside.txt', path: '/source/folder/x' }]);
const appNormal = await appCopy([{ name: 'ok.txt', path: '/source/folder/ok.txt' }]);
check('F-02 앱 서버간 복사는 대상 폴더 밖 경로·역슬래시 이름을 거절한다', !appWritten.some((p) => !p.startsWith('/approved/folder/')) && appEscape !== 'copied' && appBackslash !== 'copied' && appNormal === 'copied', { appEscape, appBackslash, appNormal, appWritten });
let appRemoveError = '';
try {
  await vm.runInNewContext(`${removeFn}\nremoveRecursive`, ctx([]))({ readdir: (_p, cb) => cb(null, [{ filename: '../outside', attrs: {} }]), unlink: (p, cb) => (appRemoved.push(p), cb()), rmdir: (p, cb) => (appRemoved.push(p), cb()) }, '/victim');
} catch (err) {
  appRemoveError = err.message;
}
check('F-02 앱 폴더 지우기는 이상한 이름을 만나면 멈추고 밖을 지우지 않는다', Boolean(appRemoveError) && appRemoved.length === 0, { stopped: Boolean(appRemoveError), removed: appRemoved });

const resolved = fs.realpathSync(data);
if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('terminas-verify-fixes-')) fs.rmSync(resolved, { recursive: true, force: true });
fs.writeFileSync(path.join(root, 'security-review/verify-results.json'), JSON.stringify({ date: new Date().toISOString(), failures, results }, null, 2));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
