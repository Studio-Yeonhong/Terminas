// 누구나 가입(SHELL_OPEN_SIGNUP=1)·관리 콘솔(서버 PC 안에서만) 확인 — 격리된 임시 서버(개발 로그인)로만. 운영 DB·자격증명은 쓰지 않는다.
// 저장소 루트에서: node security-review/verify-open-signup-admin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-open-'));
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
const port = await freePort();
const cport = await freePort();
const base = `http://127.0.0.1:${port}`;
const cbase = `http://127.0.0.1:${cport}`;
const baseEnv = (extra = {}) => ({
  ...process.env,
  NODE_ENV: 'development',
  SHELL_PORT: String(port),
  SHELL_HOST: '127.0.0.1',
  SHELL_PUBLIC_URL: base,
  SHELL_DATA_DIR: data,
  SHELL_UPDATES_DIR: path.join(data, 'updates'),
  SHELL_LOG_FILE: path.join(data, 'server.log'),
  SHELL_DEV_LOGIN: '1',
  SHELL_BOOTSTRAP_ADMINS: 'boss@example.test',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  SHELL_PASSWORD_LOGIN: '0',
  SHELL_ADMIN_ID: '',
  SHELL_ADMIN_PASSWORD: '',
  SHELL_OPEN_SIGNUP: '1',
  SHELL_TERMS_URL: 'https://example.test/terms',
  SHELL_PRIVACY_URL: 'https://example.test/privacy',
  SHELL_CONSOLE_PORT: String(cport),
  SHELL_CONSOLE_HOST: '127.0.0.1',
  ...extra,
});
let child = null;
async function start(env) {
  child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (b) => (err += b));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(err);
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok) break;
    } catch {}
    await sleep(50);
  }
  await sleep(300);
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
}
async function api(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (email) => api('POST', '/api/auth/dev-login-token', null, { email });
const tok = async (email) => (await login(email)).body?.token;

// 관리 콘솔 (쿠키를 들고 다닌다)
let jar = '';
async function capi(method, p, body, headers = {}) {
  const res = await fetch(cbase + p, {
    method,
    headers: { 'x-console': '1', ...(jar ? { cookie: jar } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) jar = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
// Host 머리글을 마음대로 넣어 부르기 (fetch 는 Host 를 못 바꾼다)
function rawGet(p, host) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cport, path: p, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}
function cli(args, input) {
  return spawnSync(process.execPath, ['scripts/console-password.ts', ...args], { cwd: path.join(root, 'server'), env: baseEnv(), input, encoding: 'utf8', timeout: 30000 });
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (x) => {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of x.toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) (out.push((value >>> (bits - 8)) & 255), (bits -= 8));
  }
  return Buffer.from(out);
};
const totp = (secret, off = 0) => {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off));
  const mac = crypto.createHmac('sha1', b32(secret)).update(c).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};
// --otp: 키를 읽고 그 키의 지금 코드를 넣는다
function cliOtp() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/console-password.ts', '--otp'], { cwd: path.join(root, 'server'), env: baseEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let secret = '';
    p.stdout.on('data', (b) => {
      out += b;
      const m = /키: ([A-Z2-7 ]+)/.exec(out);
      if (m && !secret) {
        secret = m[1].replace(/\s/g, '');
        p.stdin.end(`${totp(secret)}\n`);
      }
    });
    p.on('exit', (code) => resolve({ code, secret }));
  });
}

try {
  const bad = spawnSync(process.execPath, ['-e', "import('./src/config.ts').then(() => console.log('started'))"], { cwd: path.join(root, 'server'), env: baseEnv({ SHELL_TERMS_URL: 'javascript:alert(1)' }), encoding: 'utf8' });
  check('이용약관 주소가 http(s) 가 아니면 켜지지 않는다', !bad.stdout.includes('started') && /SHELL_TERMS_URL/.test(bad.stderr));

  await start(baseEnv());
  const cfg = (await api('GET', '/api/auth/config')).body;
  check('설정: 누구나 가입, 링크(약관·개인정보·소스 기본값)', cfg?.openSignup === true && cfg.links?.terms === 'https://example.test/terms' && cfg.links?.source === 'https://github.com/Studio-Yeonhong/Terminas', cfg?.links);

  // ---------- 누구나 가입 ----------
  const stranger = await tok('stranger@example.test');
  const sMe = await api('GET', '/api/me', stranger);
  check('초대 없이 들어오고, 팀이 없어도 개인 볼트를 쓰고, 팀을 만들 수 있다', Boolean(stranger) && sMe.status === 200 && sMe.body.teams.length === 0 && sMe.body.vaults.some((v) => v.kind === 'personal') && sMe.body.user.canCreateTeams === true);
  const teams = [];
  for (let i = 0; i < 20; i++) teams.push((await api('POST', '/api/teams', stranger, { name: `T${i}` })).status);
  const over = await api('POST', '/api/teams', stranger, { name: 'T20' });
  check('관리자가 아니면 소유한 팀은 20개까지', teams.every((x) => x === 200) && over.status === 400);
  const teamId = (await api('GET', '/api/me', stranger)).body.teams[0].id;
  const vaults = [];
  for (let i = 0; i < 49; i++) vaults.push((await api('POST', `/api/teams/${teamId}/vaults`, stranger, { name: `V${i}` })).status);
  const vOver = await api('POST', `/api/teams/${teamId}/vaults`, stranger, { name: 'V49' });
  check('팀 볼트는 50개까지', vaults.every((x) => x === 200) && vOver.status === 400);

  // ---------- 공개 서버에는 관리 API 가 없다 ----------
  const boss = await tok('boss@example.test');
  const publicApi = await Promise.all(['/api/admin/stats', '/api/admin/users'].map(async (p) => (await api('GET', p, boss)).status));
  // /admin/... 는 공개 서버에선 웹 화면(index.html)으로 떨어질 뿐 데이터가 아니다
  const publicPage = await Promise.all(['/admin/api/stats', '/admin/api/users'].map(async (p) => {
    const r = await fetch(base + p, { headers: { authorization: `Bearer ${boss}` } });
    const text = await r.text();
    return { type: r.headers.get('content-type') ?? '', data: text.includes('"users"') || text.includes('"email"') };
  }));
  check('공개 서버에는 관리 API 가 없다 (서버 관리자 로그인이어도)', publicApi.every((x) => x === 404) && publicPage.every((x) => x.type.startsWith('text/html') && !x.data), { publicApi, publicPage });

  // ---------- 관리 콘솔: 이 PC 주소로만, 로그인 필요 ----------
  const page = await fetch(`${cbase}/admin`);
  const pageText = await page.text();
  check('콘솔 화면은 따로 뜨고 엄격한 CSP', page.status === 200 && pageText.includes('/admin/console.js') && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-frame-options') === 'DENY');
  const hosts = { evil: await rawGet('/admin/api/state', 'evil.example'), rebind: await rawGet('/admin', 'attacker.example:5282'), local: await rawGet('/admin/api/state', `localhost:${cport}`) };
  check('이 PC 주소가 아닌 Host 로 부르면 거절 (DNS 리바인딩)', hosts.evil === 421 && hosts.rebind === 421 && hosts.local === 200, hosts);
  const st0 = (await capi('GET', '/admin/api/state')).body;
  const noPw = await capi('POST', '/admin/api/login', { password: 'anything-at-all' });
  const noSession = await capi('GET', '/admin/api/stats');
  check('비밀번호를 정하기 전엔 아무도 못 들어오고, 로그인 없이는 데이터가 없다', st0.passwordSet === false && noPw.status === 401 && noSession.status === 401);

  const mismatch = cli([], 'console-pass-111\nconsole-pass-222\n');
  const setPw = cli([], 'console-pass-111\nconsole-pass-111\n');
  check('console:password: 두 번 같아야 정해진다', mismatch.status !== 0 && setPw.status === 0 && (await capi('GET', '/admin/api/state')).body.passwordSet === true);
  const wrong = await capi('POST', '/admin/api/login', { password: 'not-the-password' });
  const noHeader = await fetch(`${cbase}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'console-pass-111' }) });
  const foreign = await capi('POST', '/admin/api/login', { password: 'console-pass-111' }, { origin: 'https://evil.example' });
  const ok = await capi('POST', '/admin/api/login', { password: 'console-pass-111' });
  const cookie = ok.headers.get('set-cookie') ?? '';
  check('로그인: 틀린 비밀번호·머리글 없음·다른 출처는 거절, 맞으면 HttpOnly·SameSite=Strict 쿠키', wrong.status === 401 && noHeader.status === 403 && foreign.status === 403 && ok.status === 200 && /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie) && /Path=\/admin/i.test(cookie));

  // ---------- 관리 작업 ----------
  const stats = (await capi('GET', '/admin/api/stats')).body;
  check('개요: 사람·팀 수, 서버 모드', stats?.users === 2 && stats.teams === 20 && stats.server.openSignup === true, { users: stats?.users, teams: stats?.teams });
  const found = (await capi('GET', '/admin/api/users?q=strang')).body;
  const pct = (await capi('GET', '/admin/api/users?q=%25')).body;
  const sRow = found?.users?.[0];
  check('사용자 목록·검색 (% 는 글자 그대로), 비밀값 없음', found?.total === 1 && sRow?.email === 'stranger@example.test' && pct?.total === 0 && !JSON.stringify(found).includes('password_hash') && !JSON.stringify(found).includes('totp_secret'));
  await capi('POST', `/admin/api/users/${sRow.id}/disable`, { disabled: true });
  const afterDisable = await api('GET', '/api/me', stranger);
  const reLogin = await login('stranger@example.test');
  await capi('POST', `/admin/api/users/${sRow.id}/disable`, { disabled: false });
  const stranger2 = await tok('stranger@example.test');
  check('막으면 로그인이 끊기고 다시 못 들어오며, 풀면 다시 들어온다', afterDisable.status === 401 && reLogin.body?.error === 'disabled' && (await api('GET', '/api/me', stranger2)).status === 200);
  await capi('POST', `/admin/api/users/${sRow.id}/admin`, { admin: true });
  const nowAdmin = (await api('GET', '/api/me', stranger2)).body.user.isAdmin;
  await capi('POST', `/admin/api/users/${sRow.id}/admin`, { admin: false });
  const notAdmin = (await api('GET', '/api/me', stranger2)).body.user.isAdmin;
  check('서버 관리자 지정·해제', nowAdmin === true && notAdmin === false);
  await capi('POST', `/admin/api/users/${sRow.id}/signout`);
  check('모든 기기에서 로그아웃시키기', (await api('GET', '/api/me', stranger2)).status === 401);
  const stranger3 = await tok('stranger@example.test');
  const setup = (await api('POST', '/api/me/mfa/setup', stranger3)).body;
  await api('POST', '/api/me/mfa/enable', stranger3, { code: totp(setup.secret) });
  await capi('POST', `/admin/api/users/${sRow.id}/mfa-reset`);
  check('2단계 인증 초기화', (await api('GET', '/api/me/mfa', stranger3)).body?.enabled === false);
  const friend = await tok('friend@example.test');
  const invited = await api('POST', `/api/teams/${teamId}/invites`, stranger3, { email: 'friend@example.test' });
  const newbie = await api('POST', `/api/teams/${teamId}/invites`, stranger3, { email: 'nobody-yet@example.test' });
  // 초대는 받은 사람이 수락해야 들어간다 (보안 점검 M-3): 계정이 있어도 바로 넣지 않고, 답도 계정이 없을 때와 같다
  const beforeAccept = (await api('GET', `/api/teams/${teamId}`, stranger3)).body?.members?.some((m) => m.email === 'friend@example.test');
  const myInvites = (await api('GET', '/api/me/invites', friend)).body ?? [];
  const accepted = await api('POST', `/api/me/invites/${myInvites[0]?.id}/accept`, friend, {});
  const afterAccept = (await api('GET', `/api/teams/${teamId}`, stranger3)).body?.members?.some((m) => m.email === 'friend@example.test');
  check('초대는 수락해야 팀에 들어가고, 계정 유무와 상관없이 답이 같다', JSON.stringify(invited.body) === JSON.stringify(newbie.body) && invited.body?.invited === true && beforeAccept === false && myInvites.length === 1 && accepted.status === 200 && afterAccept === true, { invited: invited.body, beforeAccept, accepted: accepted.status });
  const wrongConfirm = await capi('DELETE', `/admin/api/users/${sRow.id}`, { confirm: 'nope@example.test' });
  const blocked = await capi('DELETE', `/admin/api/users/${sRow.id}`, { confirm: 'stranger@example.test' });
  const fId = (await api('GET', '/api/me', friend)).body.user.id;
  await api('DELETE', `/api/teams/${teamId}/members/${fId}`, stranger3);
  const deleted = await capi('DELETE', `/admin/api/users/${sRow.id}`, { confirm: 'stranger@example.test' });
  const statsAfter = (await capi('GET', '/admin/api/stats')).body;
  check('지우기: 이메일 확인, 다른 팀원이 있는 팀의 소유자면 막고, 지우면 혼자 있던 팀까지', wrongConfirm.status === 400 && blocked.status === 409 && deleted.status === 200 && statsAfter.teams === 0 && (await api('GET', '/api/me', stranger3)).status === 401);
  const log = (await capi('GET', '/admin/api/audit')).body;
  const actions = new Set(log.map((e) => e.action));
  check('서버 기록: 콘솔 로그인·관리 작업이 남고 행위자는 콘솔', ['console_login', 'admin_user_disable', 'admin_grant', 'admin_signout', 'mfa_reset', 'admin_user_delete'].every((a) => actions.has(a)) && log.find((e) => e.action === 'admin_user_disable')?.detail?.by === 'console');

  // ---------- OTP·비밀번호 바꾸기 ----------
  const otp = await cliOtp();
  const oldSession = await capi('GET', '/admin/api/stats');
  jar = '';
  const noCode = await capi('POST', '/admin/api/login', { password: 'console-pass-111' });
  const withCode = await capi('POST', '/admin/api/login', { password: 'console-pass-111', code: totp(otp.secret) });
  check('OTP 를 켜면: 열려 있던 콘솔 로그인은 끊기고, 코드가 있어야 들어온다', otp.code === 0 && oldSession.status === 401 && noCode.status === 401 && withCode.status === 200, { otp: otp.code, old: oldSession.status });
  cli(['--no-otp'], '');
  cli(['--off'], '');
  jar = '';
  const off = await capi('POST', '/admin/api/login', { password: 'console-pass-111' });
  check('--off 면 아무도 콘솔에 못 들어온다', off.status === 401 && (await capi('GET', '/admin/api/state')).body.passwordSet === false);
  cli([], 'console-pass-333\nconsole-pass-333\n');
  // 앞에서 틀린 횟수는 성공 로그인으로 비우고 센다
  await capi('POST', '/admin/api/login', { password: 'console-pass-333' });
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push((await capi('POST', '/admin/api/login', { password: `wrong-${i}-password` })).status);
  const blockedRight = await capi('POST', '/admin/api/login', { password: 'console-pass-333' });
  check('15분에 5번 틀리면 맞는 비밀번호도 막는다', tries.every((x) => x === 401) && blockedRight.status === 429);
  await stop();

  // ---------- 콘솔 끄기·누구나 가입 끄기 ----------
  await start(baseEnv({ SHELL_OPEN_SIGNUP: '0', SHELL_TERMS_URL: '', SHELL_PRIVACY_URL: '', SHELL_CONSOLE_PORT: '0' }));
  const consoleOff = await fetch(`${cbase}/admin`).then((r) => r.status, () => 0);
  const closed = await login('newcomer@example.test');
  const cfg2 = (await api('GET', '/api/auth/config')).body;
  check('SHELL_CONSOLE_PORT=0 이면 콘솔이 없고, 누구나 가입을 끄면 초대 없는 사람은 거절', consoleOff === 0 && closed.body?.error === 'not_invited' && cfg2.openSignup === false && cfg2.links.terms === '' && cfg2.links.source === 'https://github.com/Studio-Yeonhong/Terminas');
} finally {
  await stop();
  await sleep(300);
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
