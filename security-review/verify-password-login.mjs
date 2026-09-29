// 아이디·비밀번호 로그인(SHELL_PASSWORD_LOGIN=1)·초대 코드·env 관리자·user:password 확인 — 격리된 임시 서버로만.
// 운영 DB·자격증명은 쓰지 않는다. 저장소 루트에서: node security-review/verify-password-login.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-pw-'));
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'admin';
const ADMIN_PW = `env-${crypto.randomBytes(6).toString('hex')}`;

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
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
  SHELL_BOOTSTRAP_ADMINS: '',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: '0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  SHELL_PASSWORD_LOGIN: '1',
  SHELL_ADMIN_ID: ADMIN,
  SHELL_ADMIN_PASSWORD: ADMIN_PW,
  ...extra,
});

let child = null;
let db = null;
async function startServer(env) {
  child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) return { exited: true, stderr };
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok) return { exited: false };
    } catch {}
    await sleep(50);
  }
  throw new Error('server did not start: ' + stderr);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}
// 설정 오류로 켜지지 않아야 하는 경우
function refusesToStart(extra) {
  const r = spawnSync(process.execPath, ['-e', "import('./src/config.ts').then(() => console.log('started'))"], { cwd: path.join(root, 'server'), env: baseEnv(extra), encoding: 'utf8', timeout: 20000 });
  return !r.stdout.includes('started') && /SHELL_/.test(r.stderr);
}

async function api(method, p, token, body, extraHeaders = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const pwLogin = (id, password) => api('POST', '/api/auth/password', null, { id, password, desktop: true });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.toUpperCase()) {
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

try {
  // ---------- 설정 오류는 켜기 전에 막는다 ----------
  check('SHELL_ADMIN_ID 만 있고 비밀번호 로그인이 꺼져 있으면 켜지지 않는다', refusesToStart({ SHELL_PASSWORD_LOGIN: '0' }));
  check('SHELL_ADMIN_PASSWORD 가 10자보다 짧으면 켜지지 않는다', refusesToStart({ SHELL_ADMIN_PASSWORD: 'short' }));

  await startServer(baseEnv());
  const cfg = (await api('GET', '/api/auth/config')).body;
  check('설정: 비밀번호 로그인 켜짐, API 수준 알려 줌', cfg?.password === true && cfg.api >= 2 && cfg.minAppApi === 1, cfg);

  // ---------- env 관리자 ----------
  const a1 = await pwLogin(ADMIN, ADMIN_PW);
  const meA = await api('GET', '/api/me', a1.body?.token);
  check('env 로 만든 관리자 계정으로 로그인(앱 토큰)', a1.status === 200 && typeof a1.body.token === 'string' && meA.body?.user?.isAdmin === true && meA.body.login?.hasPassword === true && meA.body.login.password === true, { status: a1.status, login: meA.body?.login });
  db = new DatabaseSync(path.join(data, 'shell.db'));
  const stored = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(ADMIN).password_hash;
  const logText = fs.existsSync(path.join(data, 'server.log')) ? fs.readFileSync(path.join(data, 'server.log'), 'utf8') : '';
  const auditText = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  check('비밀번호는 scrypt 해시로만 (DB·기록·로그에 원문 없음)', /^scrypt\$32768\$8\$1\$/.test(stored) && !stored.includes(ADMIN_PW) && !auditText.includes(ADMIN_PW) && !logText.includes(ADMIN_PW));

  // ---------- 틀린 비밀번호·없는 아이디 ----------
  const t0 = performance.now();
  const bad = await pwLogin(ADMIN, 'wrong-password-1');
  const t1 = performance.now();
  const ghost = await pwLogin('nobody-here', 'wrong-password-1');
  const t2 = performance.now();
  check('틀린 비밀번호와 없는 아이디는 같은 답(있는 아이디인지 안 알려 줌)', bad.status === 401 && ghost.status === 401 && bad.body?.error === 'bad_password' && ghost.body?.message === bad.body?.message && t2 - t1 > 15 && t1 - t0 > 15, { badMs: Math.round(t1 - t0), ghostMs: Math.round(t2 - t1) });

  // 웹: 쿠키
  const web = await api('POST', '/api/auth/password', null, { id: ADMIN, password: ADMIN_PW });
  const cookie = web.headers.get('set-cookie') ?? '';
  const sid = /ss_sid=([^;]+)/.exec(cookie)?.[1];
  const webMe = await api('GET', '/api/me', null, undefined, { cookie: `ss_sid=${sid}` });
  check('웹 로그인은 HttpOnly 쿠키', web.status === 200 && /HttpOnly/i.test(cookie) && webMe.status === 200 && !('token' in (web.body ?? {})));

  // ---------- 여러 번 틀리면 막기 ----------
  const victim = 'victim@example.test';
  // (관리자가 팀을 만들고 victim 을 초대 → 코드로 가입)
  const team = await api('POST', '/api/teams', a1.body.token, { name: 'Pw Team' });
  const teamId = team.body?.id ?? team.body?.team?.id;
  const inv = await api('POST', `/api/teams/${teamId}/invites`, a1.body.token, { email: victim, role: 'member' });
  const code = inv.body?.code ?? '';
  const invRow = db.prepare('SELECT code_hash, code_expires_at FROM invites WHERE email = ?').get(victim);
  const days = (inv.body?.codeExpiresAt - Date.now()) / 86400000;
  check('초대하면 코드 XXXX-XXXX-XXXX (7일), DB 에는 해시만', /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code) && days > 6.9 && days <= 7 && invRow?.code_hash && !JSON.stringify(invRow).includes(code.replace(/-/g, '')), { code: code.replace(/./g, '*') });

  const signup = (body) => api('POST', '/api/auth/invite-signup', null, { desktop: true, ...body });
  const wrongCode = await signup({ email: victim, code: 'AAAA-BBBB-CCCC', password: 'victim-pass-1' });
  const otherEmail = await signup({ email: 'someone@example.test', code, password: 'victim-pass-1' });
  const weak = await signup({ email: victim, code, password: 'short' });
  check('틀린 코드·다른 이메일·짧은 비밀번호는 거절', wrongCode.body?.error === 'invite_bad' && otherEmail.body?.error === 'invite_bad' && weak.body?.error === 'weak_password', { wrongCode: wrongCode.body?.error, otherEmail: otherEmail.body?.error, weak: weak.body?.error });
  const joined = await signup({ email: victim, code: code.toLowerCase().replace(/-/g, ' '), name: 'Victim', password: 'victim-pass-1' });
  const vMe = await api('GET', '/api/me', joined.body?.token);
  check('맞는 코드(소문자·공백도)로 가입하면 그 팀에 들어간다', joined.status === 200 && vMe.body?.teams?.some((t) => t.id === teamId && t.role === 'member') && vMe.body.user.name === 'Victim' && vMe.body.login.hasPassword === true, { status: joined.status });
  const reuse = await signup({ email: victim, code, password: 'victim-pass-2' });
  check('쓴 코드는 다시 못 쓴다', reuse.status === 400 && reuse.body?.error === 'invite_bad');

  const tries = [];
  for (let i = 0; i < 10; i++) tries.push((await pwLogin(victim, `nope-${i}-password`)).status);
  const lockedOut = await pwLogin(victim, 'victim-pass-1');
  const adminStill = await pwLogin(ADMIN, ADMIN_PW);
  check('한 아이디를 10번 틀리면 맞는 비밀번호도 잠시 막는다 (다른 아이디는 그대로)', tries.every((s) => s === 401) && lockedOut.status === 429 && lockedOut.body?.error === 'too_many' && adminStill.status === 200, { lockedOut: lockedOut.status });

  // ---------- 기한 지난 코드·다시 만든 코드 ----------
  const inv2 = await api('POST', `/api/teams/${teamId}/invites`, a1.body.token, { email: 'late@example.test' });
  db.prepare('UPDATE invites SET code_expires_at = ? WHERE email = ?').run(Date.now() - 1000, 'late@example.test');
  const expired = await signup({ email: 'late@example.test', code: inv2.body.code, password: 'late-pass-123' });
  const inviteId = db.prepare('SELECT id FROM invites WHERE email = ?').get('late@example.test').id;
  const regen = await api('POST', `/api/teams/${teamId}/invites/${inviteId}/code`, a1.body.token);
  const oldAfter = await signup({ email: 'late@example.test', code: inv2.body.code, password: 'late-pass-123' });
  const newOk = await signup({ email: 'late@example.test', code: regen.body?.code, password: 'late-pass-123' });
  check('기한 지난 코드는 거절, 다시 만들면 옛 코드는 무효·새 코드는 된다', expired.body?.error === 'invite_bad' && oldAfter.body?.error === 'invite_bad' && newOk.status === 200, { expired: expired.body?.error, newOk: newOk.status });
  const teamView = await api('GET', `/api/teams/${teamId}`, a1.body.token);
  check('팀 화면의 초대 목록엔 코드 기한만 (코드·해시는 없다)', !JSON.stringify(teamView.body).includes('code_hash') && !JSON.stringify(teamView.body).includes(regen.body?.code ?? '~'));

  // ---------- 비밀번호 바꾸기 ----------
  const late1 = newOk.body.token;
  const late2 = (await pwLogin('late@example.test', 'late-pass-123')).body.token;
  const wrongCur = await api('PUT', '/api/me/password', late1, { current: 'not-it-at-all', password: 'late-pass-456' });
  const changed = await api('PUT', '/api/me/password', late1, { current: 'late-pass-123', password: 'late-pass-456' });
  const otherDevice = await api('GET', '/api/me', late2);
  const sameDevice = await api('GET', '/api/me', late1);
  const oldPw = await pwLogin('late@example.test', 'late-pass-123');
  const newPw = await pwLogin('late@example.test', 'late-pass-456');
  check('바꾸기: 지금 비밀번호가 필요하고, 바꾸면 다른 기기 로그인은 끊긴다', wrongCur.body?.error === 'bad_password' && changed.status === 200 && otherDevice.status === 401 && sameDevice.status === 200 && oldPw.status === 401 && newPw.status === 200, { changed: changed.status, otherDevice: otherDevice.status });

  // 비밀번호로 만든 계정에는 Google(여기선 개발 로그인)이 이메일만 같다고 붙지 않는다 (보안 점검 H-1 — 초대 코드로 남의 이메일 계정을 먼저 만드는 것)
  const linkTry = await api('POST', '/api/auth/dev-login-token', null, { email: victim });
  check('비밀번호 계정에는 Google 로그인이 이메일만으로 붙지 않는다', linkTry.status === 403 && linkTry.body?.error === 'password_account', { status: linkTry.status, error: linkTry.body?.error });

  // 비밀번호 없는 계정(개발 로그인 = Google 로그인 대신)이 처음 정할 때: 방금 로그인한 세션만
  db.prepare('UPDATE users SET password_hash = NULL WHERE email = ?').run(victim);
  const g = (await api('POST', '/api/auth/dev-login-token', null, { email: victim })).body?.token;
  db.prepare("UPDATE sessions SET created_at = created_at - 3600000 WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(victim);
  const oldSession = await api('PUT', '/api/me/password', g, { password: 'fresh-pass-123' });
  const g2 = (await api('POST', '/api/auth/dev-login-token', null, { email: victim })).body?.token;
  const fresh = await api('PUT', '/api/me/password', g2, { password: 'fresh-pass-123' });
  check('비밀번호가 없던 계정은 방금(10분 안) 로그인한 세션에서만 정할 수 있다', oldSession.status === 403 && oldSession.body?.error === 'reauth_required' && fresh.status === 200, { oldSession: oldSession.status, fresh: fresh.status });

  // ---------- 2단계 인증과 함께 ----------
  const setup = (await api('POST', '/api/me/mfa/setup', newPw.body.token)).body;
  await api('POST', '/api/me/mfa/enable', newPw.body.token, { code: totp(setup.secret) });
  const mfaLogin = await pwLogin('late@example.test', 'late-pass-456');
  const before = await api('GET', '/api/me', mfaLogin.body?.token);
  const verify = await api('POST', '/api/auth/mfa/verify', mfaLogin.body?.token, { code: totp(setup.secret, 1) });
  const after = await api('GET', '/api/me', mfaLogin.body?.token);
  check('OTP 를 켠 사람은 비밀번호 뒤에 코드를 넣어야 들어온다', mfaLogin.body?.mfa === true && before.status === 401 && before.body?.error === 'mfa_required' && verify.status === 200 && after.status === 200);

  // ---------- 막힌 계정 ----------
  db.prepare('UPDATE users SET disabled = 1 WHERE email = ?').run('late@example.test');
  const disabled = await pwLogin('late@example.test', 'late-pass-456');
  db.prepare('UPDATE users SET disabled = 0 WHERE email = ?').run('late@example.test');
  db.prepare('DELETE FROM team_members WHERE user_id = (SELECT id FROM users WHERE email = ?)').run('late@example.test');
  const noTeam = await pwLogin('late@example.test', 'late-pass-456');
  const wrongForDisabled = await pwLogin('late@example.test', 'nope-nope-nope');
  check('사용 중지·팀 없음은 비밀번호가 맞을 때만 그 이유를 알려 준다', disabled.body?.error === 'disabled' && noTeam.body?.error === 'no_team' && wrongForDisabled.body?.error === 'bad_password');

  // ---------- 다시 켜도 env 비밀번호가 바꾼 비밀번호를 덮지 않는다 ----------
  const adminNew = 'admin-changed-123';
  const fresh2 = await pwLogin(ADMIN, ADMIN_PW);
  await api('PUT', '/api/me/password', fresh2.body.token, { current: ADMIN_PW, password: adminNew });
  await stopServer();
  await startServer(baseEnv());
  const envAgain = await pwLogin(ADMIN, ADMIN_PW);
  const changedAgain = await pwLogin(ADMIN, adminNew);
  check('다시 켜도 env 비밀번호는 이미 정한 비밀번호를 덮지 않는다', envAgain.status === 401 && changedAgain.status === 200);

  // ---------- user:password (서버 관리자 명령) ----------
  await stopServer();
  const cli = (args, input) => spawnSync(process.execPath, ['scripts/user-password.ts', ...args], { cwd: path.join(root, 'server'), env: baseEnv(), input, encoding: 'utf8', timeout: 30000 });
  const mismatch = cli([ADMIN], 'reset-pass-111\nreset-pass-222\n');
  const reset = cli([ADMIN], 'reset-pass-111\nreset-pass-111\n');
  const created = cli(['ops@example.test', '--create-admin'], 'ops-pass-1234\nops-pass-1234\n');
  const missing = cli(['ghost@example.test'], 'ops-pass-1234\nops-pass-1234\n');
  await startServer(baseEnv());
  const afterReset = await pwLogin(ADMIN, 'reset-pass-111');
  const opsMe = await api('GET', '/api/me', (await pwLogin('ops@example.test', 'ops-pass-1234')).body?.token);
  check('user:password: 두 번 같아야 하고, 없는 계정은 --create-admin 일 때만 만든다', mismatch.status !== 0 && reset.status === 0 && created.status === 0 && missing.status !== 0 && afterReset.status === 200 && opsMe.body?.user?.isAdmin === true, { reset: reset.status, created: created.status });
  await stopServer();

  // ---------- 비밀번호 로그인이 꺼진 서버 ----------
  await startServer(baseEnv({ SHELL_PASSWORD_LOGIN: '0', SHELL_ADMIN_ID: '', SHELL_ADMIN_PASSWORD: '', SHELL_BOOTSTRAP_ADMINS: 'boss@example.test' }));
  const off = (await api('GET', '/api/auth/config')).body;
  const boss = (await api('POST', '/api/auth/dev-login-token', null, { email: 'boss@example.test' })).body.token;
  const offLogin = await pwLogin(ADMIN, 'reset-pass-111');
  const offSignup = await signup({ email: 'x@example.test', code: 'AAAA-BBBB-CCCC', password: 'whatever-123' });
  const offChange = await api('PUT', '/api/me/password', boss, { password: 'whatever-123' });
  const offTeam = await api('POST', '/api/teams', boss, { name: 'Off' });
  const offInvite = await api('POST', `/api/teams/${offTeam.body?.id ?? offTeam.body?.team?.id}/invites`, boss, { email: 'y@example.test' });
  const offMe = await api('GET', '/api/me', boss);
  check('꺼진 서버: 비밀번호 로그인·가입·바꾸기 없음, 초대 코드 없음', off.password === false && offLogin.status === 404 && offSignup.status === 404 && offChange.status === 404 && offInvite.status === 200 && !offInvite.body?.code && offMe.body?.login?.password === false, { offInvite: offInvite.body });
} finally {
  await stopServer();
  db?.close();
  await sleep(300);
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
