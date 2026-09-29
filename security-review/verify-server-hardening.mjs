// 보안 점검(2026-09-29)의 서버 쪽 수정 확인 — 격리된 임시 서버(개발 로그인 + 아이디·비밀번호 로그인)로만.
// 운영 DB·자격증명은 쓰지 않는다. 저장소 루트에서: node security-review/verify-server-hardening.mjs
//   · CSRF: /%61pi/... 처럼 인코딩한 경로·빈 Bearer 로 건너뛰지 못한다
//   · 로그인 제한: 한꺼번에 보내도 아이디당 10번에서 막힌다 (M-2)
//   · 초대: 비밀번호 계정은 초대 코드가 있어야 수락한다 (H-1), 초대는 수락해야 들어간다 (M-3)
//   · 계정 키 증명은 해시로만 저장, 예전 원문도 켤 때 바뀐다
//   · 역할을 내리면 전에 받은 볼트 권한·키가 지워진다, 팀 관리 기록은 관리자만, 마지막 로그인은 관리자만
//   · 2단계 인증 켜기는 방금 로그인한 세션에서만
//   · 볼트 용량(16MB), 기록 폭주는 버린다
//   · 볼트 키 다시 봉하기(PUT key/mine)는 자기 것만
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-hard-'));
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
  SHELL_BOOTSTRAP_ADMINS: 'boss@example.test',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: '0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  SHELL_PASSWORD_LOGIN: '1',
  SHELL_OPEN_SIGNUP: '1',
};

let child = null;
async function startServer() {
  child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('server exited: ' + stderr);
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok) return;
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

async function api(method, p, token, body, extraHeaders = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
const devToken = async (email) => (await api('POST', '/api/auth/dev-login-token', null, { email })).body?.token;
// 웹처럼 쿠키로 로그인한 세션 (CSRF 시험용)
async function cookieLogin(email) {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shell': '1', origin: base }, body: JSON.stringify({ email }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const sealedLike = (bytes) => `v1.${b64(bytes)}`;

await startServer();
const db = new DatabaseSync(path.join(data, 'shell.db'));
try {
  // ---------- CSRF ----------
  const cookie = await cookieLogin('csrf@example.test');
  const cross = async (url, headers = {}) =>
    (await fetch(base + url, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json', ...headers }, body: '{}' })).status;
  const plain = await cross('/api/auth/logout');
  const encoded = await cross('/%61pi/auth/logout');
  const emptyBearer = await cross('/api/auth/logout', { authorization: 'Bearer ' });
  const stillIn = (await fetch(`${base}/api/me`, { headers: { cookie } })).status;
  check('CSRF: 다른 출처는 인코딩한 경로·빈 Bearer 로도 막힌다', plain === 403 && encoded === 403 && emptyBearer === 403 && stillIn === 200, { plain, encoded, emptyBearer, stillIn });

  // ---------- 로그인 제한: 한꺼번에 40개 ----------
  const owner = await devToken('owner@example.test');
  const team = (await api('POST', '/api/teams', owner, { name: 'T' })).body;
  const inv = await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'pw@example.test' });
  const signup = await api('POST', '/api/auth/invite-signup', null, { email: 'pw@example.test', code: inv.body.code, password: 'right-pass-123', desktop: true });
  const burst = await Promise.all(Array.from({ length: 40 }, () => api('POST', '/api/auth/password', null, { id: 'pw@example.test', password: 'wrong-pass-000', desktop: true })));
  const codes = burst.map((r) => r.status);
  const bad = codes.filter((s) => s === 401).length;
  check('로그인 제한: 한꺼번에 보내도 틀릴 기회는 아이디당 10번까지', signup.status === 200 && bad <= 10 && codes.every((s) => s === 401 || s === 429), { bad, limited: codes.filter((s) => s === 429).length });

  // ---------- 초대: 비밀번호 계정은 코드가 있어야 수락 ----------
  const pwToken = (await api('POST', '/api/auth/password', null, { id: 'pw@example.test', password: 'right-pass-123', desktop: true })).body?.token;
  // 위의 연속 실패로 아이디가 막혔을 수 있다 → 막혔으면 DB 로 계정을 새로 하나 만든다 (초대 코드 가입)
  let pwUser = pwToken;
  if (!pwUser) {
    const inv2 = await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'pw2@example.test' });
    pwUser = (await api('POST', '/api/auth/invite-signup', null, { email: 'pw2@example.test', code: inv2.body.code, password: 'right-pass-123', desktop: true })).body?.token;
  }
  const pwEmail = pwToken ? 'pw@example.test' : 'pw2@example.test';
  const team2 = (await api('POST', '/api/teams', owner, { name: 'T2' })).body;
  const inv3 = await api('POST', `/api/teams/${team2.id}/invites`, owner, { email: pwEmail });
  const pending = (await api('GET', '/api/me/invites', pwUser)).body ?? [];
  const mine = pending.find((i) => i.teamId === team2.id);
  const noCode = await api('POST', `/api/me/invites/${mine?.id}/accept`, pwUser, {});
  const withCode = await api('POST', `/api/me/invites/${mine?.id}/accept`, pwUser, { code: inv3.body.code });
  check('비밀번호 계정은 초대 코드가 있어야 초대를 수락한다 (H-1)', mine?.needsCode === true && noCode.status === 400 && noCode.body?.error === 'invite_bad' && withCode.status === 200, { noCode: noCode.status, withCode: withCode.status });
  // Google(개발 로그인) 계정은 코드 없이 수락
  const g = await devToken('g@example.test');
  await devToken('g@example.test');
  await api('POST', `/api/teams/${team2.id}/invites`, owner, { email: 'g@example.test' });
  const gInv = ((await api('GET', '/api/me/invites', g)).body ?? [])[0];
  const gBefore = (await api('GET', `/api/teams/${team2.id}`, g)).status;
  const gAccept = await api('POST', `/api/me/invites/${gInv?.id}/accept`, g, {});
  const gAfter = (await api('GET', `/api/teams/${team2.id}`, g)).status;
  check('초대는 수락해야 팀에 들어간다 (M-3)', gInv?.needsCode === false && gBefore === 404 && gAccept.status === 200 && gAfter === 200, { gBefore, gAfter });
  const declineTeam = (await api('POST', '/api/teams', owner, { name: 'T3' })).body;
  await api('POST', `/api/teams/${declineTeam.id}/invites`, owner, { email: 'g@example.test' });
  const dInv = ((await api('GET', '/api/me/invites', g)).body ?? []).find((i) => i.teamId === declineTeam.id);
  const declined = await api('DELETE', `/api/me/invites/${dInv?.id}`, g);
  check('초대를 거절하면 없어진다', declined.status === 200 && ((await api('GET', '/api/me/invites', g)).body ?? []).length === 0);
  const bossTry = await api('POST', '/api/auth/invite-signup', null, { email: 'boss@example.test', code: 'AAAA-BBBB-CCCC', password: 'boss-pass-1234', desktop: true });
  check('서버 관리자가 될 이메일은 초대 코드로 가입할 수 없다', bossTry.status === 403, { status: bossTry.status });

  // ---------- 계정 키 증명: 해시로만 ----------
  const proof = crypto.randomBytes(32).toString('hex');
  const bundle = { v: 1, kdf: { alg: 'argon2id', salt: b64(16), m: 65536, t: 3, p: 1 }, encPrivateKey: sealedLike(60), wrapPw: sealedLike(60), wrapRecovery: sealedLike(60) };
  const setKeys = await api('POST', '/api/me/keys', g, { publicKey: b64(32), bundle, proof });
  const storedProof = db.prepare("SELECT key_proof FROM users WHERE email = 'g@example.test'").get().key_proof;
  const replaceWithStored = await api('PUT', '/api/me/keys', g, { bundle, proof: storedProof.slice(3) });
  const replaceWithReal = await api('PUT', '/api/me/keys', g, { bundle, proof, reason: 'password' });
  check('계정 키 증명은 해시로만 저장하고, DB 의 값으로는 묶음을 바꿀 수 없다', setKeys.status === 200 && storedProof.startsWith('h1:') && !storedProof.includes(proof) && replaceWithStored.status === 403 && replaceWithReal.status === 200, { stored: storedProof.slice(0, 8) });

  // ---------- 역할 내림: 전에 받은 볼트 권한·키 정리 ----------
  const m = await devToken('m@example.test');
  await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'm@example.test' });
  const mInv = ((await api('GET', '/api/me/invites', m)).body ?? [])[0];
  await api('POST', `/api/me/invites/${mInv.id}/accept`, m, {});
  const mId = (await api('GET', '/api/me', m)).body.user.id;
  const secret = (await api('POST', `/api/teams/${team.id}/vaults`, owner, { name: 'Secret' })).body.id;
  await api('PATCH', `/api/teams/${team.id}/members/${mId}`, owner, { role: 'admin' });
  db.prepare("INSERT INTO vault_members (vault_id, user_id, permission) VALUES (?, ?, 'edit') ON CONFLICT DO NOTHING").run(secret, mId);
  await api('PATCH', `/api/teams/${team.id}/members/${mId}`, owner, { role: 'member' });
  const left = db.prepare('SELECT v.name, vm.permission FROM vault_members vm JOIN vaults v ON v.id = vm.vault_id WHERE vm.user_id = ?').all(mId).map((r) => `${r.name}:${r.permission}`);
  check('관리자에서 멤버로 내리면 기본 볼트 보기만 남는다', left.length === 1 && left[0] === 'Team:view', { left });

  // ---------- 팀 관리 기록·마지막 로그인은 관리자만 ----------
  const defVault = (await api('GET', `/api/teams/${team.id}`, owner)).body.vaults.find((v) => v.isDefault).id;
  await api('PUT', `/api/vaults/${defVault}/members/${mId}`, owner, { permission: 'edit' });
  const mLogs = (await api('GET', `/api/vaults/${defVault}/logs`, m)).body ?? [];
  const oLogs = (await api('GET', `/api/vaults/${defVault}/logs`, owner)).body ?? [];
  const teamActions = (l) => l.filter((e) => /^(invite_|member_|team_)/.test(e.action)).length;
  const mView = (await api('GET', `/api/teams/${team.id}`, m)).body.members;
  check('팀 관리 기록(초대·팀원 IP)과 마지막 로그인은 팀 관리자에게만', teamActions(mLogs) === 0 && teamActions(oLogs) > 0 && mView.filter((x) => x.email !== 'm@example.test').every((x) => x.lastLoginAt === null), { member: teamActions(mLogs), owner: teamActions(oLogs) });

  // ---------- 2단계 인증 켜기는 방금 로그인한 세션에서만 ----------
  const old = await devToken('otp@example.test');
  db.prepare("UPDATE sessions SET created_at = created_at - 3600000 WHERE user_id = (SELECT id FROM users WHERE email = 'otp@example.test')").run();
  const lateSetup = await api('POST', '/api/me/mfa/setup', old);
  const fresh = await devToken('otp@example.test');
  const freshSetup = await api('POST', '/api/me/mfa/setup', fresh);
  check('2단계 인증 켜기는 로그인한 지 10분 안의 세션에서만', lateSetup.status === 403 && lateSetup.body?.error === 'reauth_required' && freshSetup.status === 200, { late: lateSetup.status, fresh: freshSetup.status });

  // ---------- 볼트 용량 16MB ----------
  const personal = (await api('GET', '/api/me', owner)).body.vaults.find((v) => v.kind === 'personal').id;
  const chunk = sealedLike(45 * 1024); // 약 60KB 암호문
  let full = null;
  let stored = 0;
  for (let i = 0; i < 400 && !full; i++) {
    const r = await api('POST', `/api/vaults/${personal}/items`, owner, { id: crypto.randomUUID(), kind: 'snippet', data: chunk });
    if (r.status === 200) stored++;
    else full = r;
  }
  check('볼트 하나는 16MB 까지', full?.status === 400 && /16MB/.test(full.body?.message ?? '') && stored > 200 && stored < 300, { stored, message: full?.body?.message });

  // ---------- 기록 폭주는 버린다 ----------
  let dropped = false;
  for (let i = 0; i < 1250 && !dropped; i++) {
    const r = await api('POST', `/api/vaults/${personal}/audit`, owner, { action: 'ssh_connect', detail: {} });
    if (r.body?.dropped) dropped = i;
  }
  check('앱이 알리는 기록은 사람마다 10분에 1200개까지 (넘으면 버림)', dropped === 1200, { droppedAt: dropped });

  // ---------- 볼트 키 다시 봉하기는 자기 것만 ----------
  const gMe = (await api('GET', '/api/me', g)).body;
  const gPersonal = gMe.vaults.find((v) => v.kind === 'personal').id;
  await api('POST', `/api/vaults/${gPersonal}/key`, g, { wrapped: sealedLike(92) });
  const selfRewrap = await api('PUT', `/api/vaults/${gPersonal}/key/mine`, g, { wrapped: sealedLike(92) });
  const otherRewrap = await api('PUT', `/api/vaults/${gPersonal}/key/mine`, owner, { wrapped: sealedLike(92) });
  const by = (await api('GET', '/api/me', g)).body.vaults.find((v) => v.id === gPersonal).wrappedBy;
  check('볼트 키 다시 봉하기는 그 볼트 키를 가진 본인만, 봉한 사람이 목록에 나온다', selfRewrap.status === 200 && otherRewrap.status === 404 && by?.userId === gMe.user.id, { self: selfRewrap.status, other: otherRewrap.status });

  // ---------- 예전 원문 증명은 켤 때 해시로 바뀐다 ----------
  db.prepare("UPDATE users SET key_proof = ? WHERE email = 'g@example.test'").run(proof);
  await stopServer();
  await startServer();
  const migrated = db.prepare("SELECT key_proof FROM users WHERE email = 'g@example.test'").get().key_proof;
  const stillWorks = await api('PUT', '/api/me/keys', g, { bundle, proof, reason: 'password' });
  check('예전에 원문으로 둔 증명도 켤 때 해시로 바뀌고 그대로 통한다', migrated.startsWith('h1:') && stillWorks.status === 200, { migrated: migrated.slice(0, 8) });
} finally {
  db.close();
  await stopServer();
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
