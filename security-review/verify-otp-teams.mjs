// 2단계 인증(OTP)·팀 삭제 확인 — 격리된 임시 서버(개발 로그인)로. 운영 DB·자격증명은 쓰지 않는다.
// 저장소 루트에서: node security-review/verify-otp-teams.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-otp-'));
let failures = 0;
const results = [];
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  results.push({ name, ok, ...evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = net.createServer();
free.listen(0, '127.0.0.1');
await once(free, 'listening');
const port = free.address().port;
await new Promise((r) => free.close(r));
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  SHELL_PORT: String(port),
  SHELL_HOST: '127.0.0.1',
  SHELL_PUBLIC_URL: base,
  SHELL_DATA_DIR: data,
  SHELL_UPDATES_DIR: path.join(data, 'updates'),
  SHELL_LOG_FILE: path.join(data, 'server.log'),
  SHELL_DEV_LOGIN: '1',
  SHELL_BOOTSTRAP_ADMINS: 'owner@example.test',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: '0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
delete env.SHELL_TOTP_KEY;
const child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (b) => (stderr += b));
for (let i = 0; i < 100; i++) {
  if (child.exitCode !== null) throw new Error(stderr);
  try {
    if ((await fetch(`${base}/api/auth/config`)).ok) break;
  } catch {}
  await sleep(50);
}

async function api(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = async (email) => (await api('POST', '/api/auth/dev-login-token', null, { email })).body.token;

// TOTP (시험 쪽 구현 — 서버와 따로 계산)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s) => {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/[^A-Z2-7]/gi, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) (out.push((value >>> (bits - 8)) & 255), (bits -= 8));
  }
  return Buffer.from(out);
};
const totp = (secret, stepOffset = 0) => {
  const step = Math.floor(Date.now() / 30000) + stepOffset;
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', b32(secret)).update(c).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};
function relayClose(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/relay?host=127.0.0.1&port=1`, { headers: { origin: base, authorization: `Bearer ${token}` } });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

try {
  // ---------- OTP ----------
  const a = await login('owner@example.test');
  const other = await login('owner@example.test'); // 켜기 전에 있던 다른 기기
  check('처음엔 꺼져 있다', (await api('GET', '/api/me/mfa', a)).body?.enabled === false);
  const setup = (await api('POST', '/api/me/mfa/setup', a)).body;
  check('켜기 1단계: 비밀값과 otpauth 주소', /^[A-Z2-7]{32}$/.test(setup?.secret ?? '') && setup.uri.startsWith('otpauth://totp/Terminas%3Aowner%40example.test?secret='), { uriStart: setup?.uri?.slice(0, 40) });
  check('확인 전에는 아직 꺼져 있다', (await api('GET', '/api/me/mfa', a)).body?.enabled === false);
  const wrong = await api('POST', '/api/me/mfa/enable', a, { code: '000000' === totp(setup.secret) ? '111111' : '000000' });
  check('틀린 코드로는 켜지지 않는다', wrong.status === 400 && wrong.body?.error === 'mfa_bad');
  const enabled = await api('POST', '/api/me/mfa/enable', a, { code: totp(setup.secret) });
  const codes = enabled.body?.recoveryCodes ?? [];
  check('맞는 코드로 켜고 복구 코드 10개', enabled.status === 200 && codes.length === 10 && codes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)));
  check('켠 세션은 그대로 쓴다', (await api('GET', '/api/me', a)).status === 200);
  const otherMe = await api('GET', '/api/me', other);
  check('켜기 전 다른 기기는 코드를 다시 넣어야 한다', otherMe.status === 401 && otherMe.body?.error === 'mfa_required');
  const keyFile = path.join(data, 'totp.key');
  const db = new DatabaseSync(path.join(data, 'shell.db'));
  const stored = db.prepare("SELECT totp_secret FROM users WHERE email = 'owner@example.test'").get().totp_secret;
  check('비밀값은 서버 키로 암호화해 저장한다', fs.existsSync(keyFile) && stored.startsWith('v1.') && !stored.includes(setup.secret));

  // 새 로그인: 코드 전에는 아무것도 못 한다
  const b = await login('owner@example.test');
  const bMe = await api('GET', '/api/me', b);
  const bVaults = await api('GET', '/api/me/mfa', b);
  const bRelay = await relayClose(b);
  check('새 로그인은 코드 전엔 막힌다 (API·중계)', bMe.status === 401 && bMe.body?.error === 'mfa_required' && bVaults.status === 401 && bRelay === 4401, { relay: bRelay });
  // 다섯 번 틀리면 세션이 지워진다
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push((await api('POST', '/api/auth/mfa/verify', b, { code: '123456' === totp(setup.secret) ? '654321' : '123456' })).body?.error);
  const bAfter = await api('POST', '/api/auth/mfa/verify', b, { code: totp(setup.secret) });
  check('다섯 번 틀리면 로그아웃되어 맞는 코드도 안 된다', tries.slice(0, 4).every((e) => e === 'mfa_bad') && tries[4] === 'mfa_locked' && bAfter.status === 401, { tries });
  // 사람 단위로 잠긴다: 다시 로그인해도 15분 동안은 맞는 코드도 막힌다 (보안 점검 M-1 — 전에는 세션마다 새로 5번이었다)
  const relog = await login('owner@example.test');
  const locked = await api('POST', '/api/auth/mfa/verify', relog, { code: totp(setup.secret) });
  const lockRow = db.prepare("SELECT mfa_locked_until, mfa_lock_level FROM users WHERE email = 'owner@example.test'").get();
  check('다섯 번 틀리면 사람 단위로 잠겨, 다시 로그인해도 맞는 코드가 막힌다', locked.status === 429 && locked.body?.error === 'mfa_throttled' && lockRow.mfa_locked_until > Date.now() + 14 * 60_000 && lockRow.mfa_lock_level === 1, { status: locked.status, level: lockRow.mfa_lock_level });
  // 시험을 이어 가려고 잠금만 푼다 (15분을 기다리는 대신)
  db.prepare("UPDATE users SET mfa_locked_until = 0 WHERE email = 'owner@example.test'").run();

  // 맞는 코드 → 통과, 같은 코드 재사용은 거절 (다음 칸 코드로 다른 세션 통과)
  const c1 = await login('owner@example.test');
  const code = totp(setup.secret, 1);
  const ok1 = await api('POST', '/api/auth/mfa/verify', c1, { code });
  const c2 = await login('owner@example.test');
  const reuse = await api('POST', '/api/auth/mfa/verify', c2, { code });
  check('맞는 코드로 통과하고, 같은 코드는 다시 못 쓴다', ok1.status === 200 && (await api('GET', '/api/me', c1)).status === 200 && reuse.status === 400);

  // 복구 코드: 한 번만
  const r1 = await api('POST', '/api/auth/mfa/verify', c2, { code: codes[0].toUpperCase() });
  const c3 = await login('owner@example.test');
  const r2 = await api('POST', '/api/auth/mfa/verify', c3, { code: codes[0] });
  const left = (await api('GET', '/api/me/mfa', c2)).body?.recoveryLeft;
  check('복구 코드는 한 번만 쓴다', r1.status === 200 && r1.body?.via === 'recovery' && r2.status === 400 && left === 9, { left });

  // 복구 코드 새로 만들기는 인증 앱 코드로만 (복구 코드 거절)
  const regenByRecovery = await api('POST', '/api/me/mfa/recovery', c2, { code: codes[1] });
  // 앞선 코드들이 now+1 칸까지 썼을 수 있어 다음 칸까지 기다린다
  await sleep(Math.max(0, 30000 - (Date.now() % 30000)) + 31000);
  const regen = await api('POST', '/api/me/mfa/recovery', c2, { code: totp(setup.secret) });
  const oldRecovery = await api('POST', '/api/auth/mfa/verify', c3, { code: codes[1] });
  check('복구 코드 새로 만들기: 앱 코드로만, 예전 코드는 무효', regenByRecovery.status === 400 && regen.status === 200 && regen.body?.recoveryCodes?.length === 10 && oldRecovery.status === 400);

  // 끄기: 코드가 있어야 하고, 코드를 기다리던 로그인은 지운다
  const offWrong = await api('POST', '/api/me/mfa/disable', c2, { code: '000000' === totp(setup.secret) ? '111111' : '000000' });
  const c4 = await login('owner@example.test'); // 코드 기다리는 세션
  const off = await api('POST', '/api/me/mfa/disable', c2, { code: regen.body.recoveryCodes[0] });
  const c4After = await api('GET', '/api/me', c4);
  const fresh = await login('owner@example.test');
  check('끄기: 코드 필요, 기다리던 로그인은 지워지고 새 로그인은 바로 된다', offWrong.status === 400 && off.status === 200 && c4After.status === 401 && c4After.body?.error === 'unauthorized' && (await api('GET', '/api/me', fresh)).status === 200);

  // 서버 관리자 초기화 스크립트
  const s2 = (await api('POST', '/api/me/mfa/setup', fresh)).body;
  await sleep(Math.max(0, 30000 - (Date.now() % 30000)) + 100);
  await api('POST', '/api/me/mfa/enable', fresh, { code: totp(s2.secret) });
  const pending = await login('owner@example.test');
  const out = execFileSync(process.execPath, ['scripts/mfa-reset.ts', 'owner@example.test'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
  const afterReset = await api('GET', '/api/me/mfa', fresh);
  check('서버 관리자 초기화 스크립트로 끈다', afterReset.body?.enabled === false && (await api('GET', '/api/me', pending)).status === 401 && /껐습니다/.test(out));

  // ---------- 팀 삭제 ----------
  const owner = await login('owner@example.test');
  const team = (await api('POST', '/api/teams', owner, { name: '삭제 시험 팀' })).body;
  const team2 = (await api('POST', '/api/teams', owner, { name: '남는 팀' })).body;
  await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'solo@example.test', role: 'member' });
  await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'both@example.test', role: 'admin' });
  await api('POST', `/api/teams/${team2.id}/invites`, owner, { email: 'both@example.test', role: 'member' });
  const solo = await login('solo@example.test');
  const both = await login('both@example.test');
  await api('POST', `/api/vaults/${team.vaultId}/items`, owner, { id: crypto.randomUUID(), kind: 'host', data: 'v1.YQ==' });
  const detail = (await api('GET', `/api/teams/${team.id}`, owner)).body;
  check('소유자에게 이 팀에만 속한 사람 수를 알려 준다', detail?.soleMembers === 1, { soleMembers: detail?.soleMembers });
  const byAdmin = await api('DELETE', `/api/teams/${team.id}`, both, { confirm: '삭제 시험 팀' });
  const wrongName = await api('DELETE', `/api/teams/${team.id}`, owner, { confirm: '삭제 시험' });
  const del = await api('DELETE', `/api/teams/${team.id}`, owner, { confirm: '삭제 시험 팀' });
  const itemsLeft = db.prepare('SELECT COUNT(*) AS n FROM items WHERE vault_id = ?').get(team.vaultId).n;
  const vaultsLeft = db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE team_id = ?').get(team.id).n;
  const logged = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team_delete' AND team_id = ?").get(team.id).n;
  check('팀 삭제: 관리자는 못 하고, 이름이 틀리면 거절, 소유자는 지운다', byAdmin.status === 403 && wrongName.status === 400 && del.status === 200, { byAdmin: byAdmin.status, wrongName: wrongName.status });
  check('팀 볼트·항목이 함께 지워지고 기록은 남는다', itemsLeft === 0 && vaultsLeft === 0 && logged === 1);
  check('이 팀에만 있던 사람은 로그인이 끊기고, 다른 팀이 있는 사람은 그대로', (await api('GET', '/api/me', solo)).status === 401 && (await api('GET', '/api/me', both)).status === 200);
  db.close();
} finally {
  child.kill();
  await once(child, 'exit').catch(() => {});
  await sleep(300);
  try {
    fs.rmSync(data, { recursive: true, force: true });
  } catch {}
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
