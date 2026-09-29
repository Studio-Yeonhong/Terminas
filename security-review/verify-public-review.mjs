// 공개 전 점검(2026-09-29, OS-01~OS-07) 수정 확인 — 격리된 임시 서버·임시 폴더·가짜 SFTP 로만. 운영 DB·자격증명·실제 SSH 는 쓰지 않는다.
//   OS-01 관리 콘솔: 인코딩한 경로로도 로그인 없이 보호 API 에 닿지 않는다
//   OS-02 비밀번호 로그인: 해시를 기다린 뒤 지금 계정을 다시 읽는다 (소스 확인 — 해시 타이밍은 밖에서 맞출 수 없다)
//   OS-03 관리 콘솔 로그인: 한꺼번에 보내도 5번까지
//   OS-04 SFTP 파일 열기: 서버가 알려 준 크기가 아니라 실제로 받은 양으로 제한 (웹·앱)
//   OS-05 웹 SFTP: 너무 큰 패킷 길이를 적어 보내면 끊는다
//   OS-06 앱 폴더 받기: 받을 곳에 이미 있던 junction·링크를 따라 밖에 쓰지 않는다
//   OS-07 요청 로그: 쿼리(웹 SSH 목적지 등)를 남기지 않는다
// 저장소 루트에서: node security-review/verify-public-review.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// 웹 SSH 엔진은 확장자 없이 서로를 가져오고 생성자 매개변수 속성을 쓴다 → .ts 를 붙이고 변환한다 (verify-sftp-ssh-hardening.mjs 와 같다)
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return n(s + '.ts', c); throw e; } }
export async function load(url, c, n) {
  if (url.startsWith('file:') && url.includes('/web/src/ssh/') && url.endsWith('.ts')) {
    const src = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: stripTypeScriptTypes(src, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
  }
  return n(url, c);
}`),
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-os-'));
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// ---------- 임시 서버 (콘솔 켬, 파일 로그 없음 = 요청 로그가 표준 출력으로) ----------
const port = await freePort();
const consolePort = await freePort();
const base = `http://127.0.0.1:${port}`;
const cbase = `http://127.0.0.1:${consolePort}`;
const data = path.join(tmp, 'data');
fs.mkdirSync(data);
// 콘솔 비밀번호는 서버를 켜기 전에 DB 에 넣는다 (npm run console:password 와 같은 해시)
const { hashPassword } = await import(pathToFileURL(path.join(root, 'server/src/password.ts')).href);
const CONSOLE_PW = `console-${crypto.randomBytes(6).toString('hex')}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  SHELL_PORT: String(port),
  SHELL_HOST: '127.0.0.1',
  SHELL_PUBLIC_URL: base,
  SHELL_DATA_DIR: data,
  SHELL_UPDATES_DIR: path.join(data, 'updates'),
  SHELL_LOG_FILE: '',
  LOG_LEVEL: 'info',
  SHELL_DEV_LOGIN: '1',
  SHELL_BOOTSTRAP_ADMINS: 'owner@example.test',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: String(consolePort),
  SHELL_CONSOLE_HOST: '127.0.0.1',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
let child = null;
let out = '';
async function startServer() {
  out = '';
  child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('server exited: ' + out);
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok && (await fetch(`${cbase}/admin/api/state`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('server did not start: ' + out);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

try {
  await startServer();
  await stopServer();
  const db = new DatabaseSync(path.join(data, 'shell.db'));
  db.prepare("INSERT INTO meta (key, value) VALUES ('console_password', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(await hashPassword(CONSOLE_PW));
  db.close();
  await startServer();

  // ---------- OS-01 ----------
  const noSession = async (method, p) => (await fetch(cbase + p, { method, headers: method === 'GET' ? {} : { 'x-console': '1', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).status;
  const reads = {
    plain: await noSession('GET', '/admin/api/stats'),
    encodedA: await noSession('GET', '/admin/%61pi/stats'),
    encodedB: await noSession('GET', '/%61dmin/api/stats'),
    encodedC: await noSession('GET', '/admin/api/%73tats'),
    users: await noSession('GET', '/admin/%61pi/users'),
  };
  const writes = {
    disable: await noSession('POST', '/admin/%61pi/users/00000000-0000-4000-8000-000000000000/disable'),
    del: await noSession('DELETE', '/admin/%61pi/users/00000000-0000-4000-8000-000000000000'),
  };
  const stillPublic = (await fetch(`${cbase}/admin/api/state`)).status;
  check('OS-01 콘솔: 일반·인코딩한 경로 모두 로그인 없이는 401 (읽기·쓰기), 공개 라우트는 그대로', Object.values(reads).every((s) => s === 401) && Object.values(writes).every((s) => s === 401) && stillPublic === 200, { reads, writes });

  // ---------- OS-03 ----------
  const burst = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${cbase}/admin/api/login`, { method: 'POST', headers: { 'x-console': '1', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-console-password' }) }).then((r) => r.status),
    ),
  );
  const wrong = burst.filter((s) => s === 401).length;
  check('OS-03 콘솔 로그인: 한꺼번에 8개 보내도 비밀번호를 확인하는 것은 5번 이하', wrong <= 5 && burst.every((s) => s === 401 || s === 429), { burst });

  // ---------- OS-07 ----------
  const marker = `dest-${crypto.randomBytes(4).toString('hex')}.example`;
  await fetch(`${base}/api/relay?host=${marker}&port=2222`).catch(() => {});
  await fetch(`${base}/api/auth/google/callback?code=${marker}-code&state=x`, { redirect: 'manual' }).catch(() => {});
  await sleep(300);
  check('OS-07 요청 로그에 쿼리(웹 SSH 목적지·로그인 코드)가 남지 않는다 (경로는 남는다)', !out.includes(marker) && out.includes('/api/relay'), { logged: out.includes('/api/relay') });

  // ---------- OS-02 (소스) ----------
  const auth = fs.readFileSync(path.join(root, 'server/src/auth.ts'), 'utf8');
  const login = auth.slice(auth.indexOf("app.post('/api/auth/password'"), auth.indexOf("app.post('/api/auth/invite-signup'"));
  const reread = login.indexOf("get<User>('SELECT * FROM users WHERE id = ?', user.id)");
  const verify = login.indexOf('await verifyPassword');
  check(
    'OS-02 비밀번호 로그인: 해시를 기다린 뒤 계정을 다시 읽어, 해시가 바뀌었으면 거절하고 지금 상태로 세션을 만든다',
    verify > 0 && reread > verify && login.includes('current.password_hash !== user.password_hash') && login.includes("finishLogin(req, reply, current, 'password'"),
  );
} finally {
  await stopServer();
}

// ---------- OS-04 웹: 실제로 받은 양 ----------
{
  globalThis.window = globalThis.window ?? {};
  const { sftpOps, SftpClient } = await import(pathToFileURL(path.join(root, 'web/src/ssh/sftp.ts')).href);
  let reads = 0;
  const liar = {
    stat: async () => ({ mode: 0o100644, size: 1 }),
    open: async () => 'h',
    close: async () => {},
    read: async () => (++reads > 1000 ? null : new Uint8Array(96)),
  };
  let webErr = '';
  try {
    await sftpOps(liar).read('/big', 1000);
  } catch (err) {
    webErr = err.message;
  }
  let exact = 0;
  const honest = { ...liar, read: async (_h, off) => (off === 0 ? new Uint8Array(1000) : null) };
  exact = (await sftpOps(honest).read('/ok', 1000)).length;
  check('OS-04 웹: 크기를 1로 속여도 실제로 받은 양이 제한을 넘으면 멈춘다 (딱 제한까지는 된다)', /너무 커서/.test(webErr) && reads <= 12 && exact === 1000, { reads, exact });

  // ---------- OS-05 웹: 너무 큰 패킷 길이 ----------
  let onData = null;
  let closed = false;
  const sent = [];
  const channel = {
    onDataReceived: (cb) => (onData = cb),
    onClosed: () => {},
    adjustWindow: () => {},
    close: async () => {
      closed = true;
    },
    send: async (buf) => {
      sent.push(Buffer.from(buf));
      const type = buf[4];
      if (type === 1) onData(Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3])); // VERSION 3
      else {
        // 길이를 2^31-1 로 적고 8KB 만 보낸다
        const head = Buffer.alloc(4);
        head.writeUInt32BE(0x7fffffff);
        onData(Buffer.concat([head, Buffer.alloc(8192, 1)]));
      }
    },
  };
  const client = await SftpClient.start(channel);
  let bigErr = '';
  try {
    await Promise.race([client.stat('/x'), sleep(3000).then(() => {
      throw new Error('timeout');
    })]);
  } catch (err) {
    bigErr = err.message;
  }
  check('OS-05 웹: 너무 큰 패킷 길이를 적어 보내면 기다리지 않고 끊는다', /패킷/.test(bigErr) && closed && client.closed, { bigErr });
}

// ---------- OS-04 앱: readLimited ----------
const desktopSsh = await import(pathToFileURL(path.join(root, 'desktop/src/ssh.js')).href);
{
  let reads = 0;
  // ssh2 SFTP 모양: read(h, buf, off, len, pos, cb) → 늘 len 만큼 채워 준다 (끝나지 않는 파일)
  const endless = {
    open: (_p, _f, _o, cb) => cb(null, 'h'),
    read: (_h, buf, off, len, _pos, cb) => {
      reads++;
      buf.fill(1, off, off + len);
      cb(null, len);
    },
    close: (_h, cb) => cb(null),
  };
  let appErr = '';
  try {
    await desktopSsh.readLimited(endless, '/big', 64 * 1024);
  } catch (err) {
    appErr = err.message;
  }
  const small = { ...endless, read: (_h, buf, off, len, pos, cb) => (pos >= 100 ? cb(null, 0) : (buf.fill(2, off, off + 100), cb(null, 100))) };
  const got = await desktopSsh.readLimited(small, '/ok', 64 * 1024);
  check('OS-04 앱: 조각으로 읽으며 실제로 받은 양이 제한을 넘으면 멈춘다', /너무 커서/.test(appErr) && reads <= 4 && got.length === 100, { reads, got: got.length });
}

// ---------- OS-06 앱: 받을 곳의 junction ----------
{
  const chosen = path.join(tmp, 'chosen');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(chosen);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(chosen, 'sub'), 'junction');
  // 받기는 chosen/remote/sub 에 쓴다 → 그 자리에 이미 밖을 가리키는 junction 이 있는 경우
  fs.mkdirSync(path.join(chosen, 'remote'));
  fs.symlinkSync(outside, path.join(chosen, 'remote', 'sub'), 'junction');
  // 운영 코드처럼 fs.promises.realpath 로 (realpathSync 는 짧은 이름 ADMINI~1 을 남겨 둘이 다를 수 있다)
  const real = await fs.promises.realpath(chosen);
  let linkErr = '';
  try {
    await desktopSsh.checkLocalTarget(real, path.join(chosen, 'sub'));
  } catch (err) {
    linkErr = err.message;
  }
  let inner = 'ok';
  try {
    fs.mkdirSync(path.join(chosen, 'plain'));
    await desktopSsh.checkLocalTarget(real, path.join(chosen, 'plain'));
    await desktopSsh.checkLocalTarget(real, path.join(chosen, 'missing.txt'));
  } catch (err) {
    inner = err.message;
  }
  // 운영 코드의 download 를 떼어 모의 SFTP 로: /remote/sub/evil.txt 를 chosen 에 받는다 → sub 는 밖을 가리키는 junction
  const ssh = fs.readFileSync(path.join(root, 'desktop/src/ssh.js'), 'utf8');
  const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
  const downloadFn = between(ssh, 'function download(', '\n// 서버 ↔ 서버');
  const tree = { '/remote': [{ path: '/remote/sub', type: 'dir', link: false }], '/remote/sub': [{ path: '/remote/sub/evil.txt', type: 'file', link: false }] };
  const ctx = {
    posix: path.posix,
    path,
    fs,
    crypto,
    Buffer,
    checkLocalTarget: desktopSsh.checkLocalTarget,
    rstat: async (_s, p) => ({ mode: p.endsWith('.txt') ? 0o100644 : 0o040755, size: 3 }),
    isDir: (a) => (a.mode & 0o170000) === 0o040000,
    listDir: async (_s, p) => tree[p] ?? [],
    sftpOf: () => ({}),
    text: (v) => v,
    absLocal: (v) => v,
    safeName: (n) => n,
    xfer: async (_a, _b, _r, dst) => fs.promises.writeFile(dst, 'x'),
    markOfTheWeb: async () => {},
    runJob: async (_w, _j, fn) => fn({ signal: { aborted: false }, state: {}, add() {}, fileDone() {}, skip() {} }),
  };
  vm.createContext(ctx);
  const download = vm.runInContext(`(${downloadFn.replace('function download(', 'function (')})`, ctx);
  let dlErr = '';
  try {
    await download(null, { connId: 'c', localDir: chosen, remotePaths: ['/remote'], overwrite: false, jobId: 'j' });
  } catch (err) {
    dlErr = err.message;
  }
  const escaped = fs.readdirSync(outside);
  check('OS-06 앱: 받을 곳에 이미 있던 junction 은 따라가지 않는다 (고른 폴더 밖에 파일이 생기지 않는다)', /링크/.test(linkErr) && inner === 'ok' && /링크/.test(dlErr) && escaped.length === 0, { dlErr: dlErr.slice(0, 40), escaped, inner, linkErr: linkErr.slice(0, 30) });
  const tmpNames = ssh.slice(ssh.indexOf('function download('), ssh.indexOf('// 서버 ↔ 서버'));
  check('OS-06 앱: 임시 파일은 무작위 이름으로 새로 만든다 (있으면 실패)', tmpNames.includes("crypto.randomBytes(6).toString('hex')}.studio-part") && tmpNames.includes("{ flag: 'wx' }"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
