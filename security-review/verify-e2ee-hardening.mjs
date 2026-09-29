// 보안 점검(2026-09-29) 암호화 쪽 수정 확인 — 격리된 임시 서버(개발 로그인)와 화면의 볼트 층(web/src/vault.ts)을 Node 로.
// "서버"가 DB 를 직접 고쳐 볼트 키·항목을 바꿔치기하는 것을 흉내 낸다. 운영 DB·자격증명은 쓰지 않는다.
//   H-2 볼트 키 출처: 새 키·공유는 보낸 사람의 계정 키로 봉한다 / 예전 방식(출처 모름)은 처음 보는 기기에서 저절로 열지 않는다 /
//       서버가 바꿔 넣은 키·다른 사람이 봉한 개인 볼트 키·공개키가 바뀐 공유는 열지 않는다 / 방금 만든 계정은 예전 방식 개인 볼트 키를 받지 않는다
//   M-5 되돌리기: 예전 판·지운 항목을 다시 주면 숨긴다 (받아들이기 가능)
//   M-6 주소가 바뀐 호스트에는 내 개인 접속 정보를 보내지 않는다
// 저장소 루트에서: node security-review/verify-e2ee-hardening.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// web/src 의 확장자 없는 상대 경로를 .ts 로 찾고, 부모의 ?dev=… 를 이어 붙여 기기마다 모듈을 따로 둔다
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (specifier.startsWith('.') && parent.includes('/web/src/')) {
      const u = new URL(specifier, parent);
      let p = u.pathname;
      if (!/\.(ts|tsx|js|mjs|json)$/.test(p)) p += fs.existsSync(fileURLToPath(new URL(`file://${p}.ts`))) ? '.ts' : '.tsx';
      return nextResolve(`file://${p}${new URL(parent).search}`, context);
    }
    return nextResolve(specifier, context);
  },
});

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-e2ee-'));
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 임시 서버 ----------
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
  SHELL_OPEN_SIGNUP: '1',
  SHELL_TRUST_PROXY: '0',
  SHELL_EXIT_WITH_PARENT: '0',
  SHELL_CONSOLE_PORT: '0',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
const child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (b) => (stderr += b));
for (let i = 0; i < 200; i++) {
  if (child.exitCode !== null) throw new Error(stderr);
  try {
    if ((await fetch(`${base}/api/auth/config`)).ok) break;
  } catch {}
  await sleep(50);
}
const db = new DatabaseSync(path.join(data, 'shell.db'));

async function http(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { 'x-shell': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text };
  }
  return { status: res.status, body: parsed };
}
const login = async (email) => (await http('POST', '/api/auth/dev-login-token', null, { email })).body.token;

// ---------- 기기: 모듈·localStorage·sessionStorage 를 기기마다 따로 ----------
const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _m: m };
};
const src = (f, dev) => `${pathToFileURL(path.join(root, 'web/src', f)).href}?dev=${dev}`;
const devices = [];
function on(d) {
  globalThis.window = { studioDesktop: d.b };
  globalThis.localStorage = d.ls;
  globalThis.sessionStorage = d.ss;
}
async function device(name, token) {
  const store = new Map();
  const b = {
    reachable: true,
    version: 'test',
    platform: process.platform,
    async api(method, p, body) {
      const r = await http(method, p, token, body);
      return { status: r.status, data: r.body };
    },
    cache: {
      available: async () => true,
      get: async (n) => store.get(n) ?? null,
      put: async (n, v) => (store.set(n, v), true),
      remove: async (n) => void store.delete(n),
      list: async () => [...store.keys()],
      clear: async () => store.clear(),
    },
  };
  const d = { name, b, ls: memStore(), ss: memStore() };
  on(d);
  d.V = await import(src('vault.ts', name));
  d.O = await import(src('offline.ts', name));
  d.api = (await import(src('api.ts', name))).api;
  await d.O.offlineAvailable();
  devices.push(d);
  return d;
}
// 기기에서 볼트를 새로 열 준비 (메모리의 볼트 키를 비우고 서버의 볼트 목록을 받는다)
async function openOn(d, u) {
  on(d);
  const me = await d.api.get('/api/me');
  d.V.setAccount(u.account, { id: u.id, name: u.email });
  d.V.setVaults(me.vaults);
  return me;
}
const vaultOf = (me, pred) => me.vaults.find(pred);
const loadErr = async (d, v) => {
  on(d);
  try {
    await d.V.loadVault(v);
    return null;
  } catch (err) {
    return err;
  }
};

const E = await import(pathToFileURL(path.join(root, 'web/src/e2ee.ts')).href);
const PW = 'e2ee-test-password-123';
const senderOf = (wrapped) => Buffer.from(wrapped.slice(3), 'base64').subarray(0, 32).toString('base64');
async function makeUser(email) {
  const token = await login(email);
  const me = (await http('GET', '/api/me', token)).body;
  const r = await E.createAccount(me.user.id, PW);
  await http('POST', '/api/me/keys', token, { publicKey: r.publicKey, bundle: r.bundle, proof: r.proof });
  return { email, token, id: me.user.id, account: r.account, pub: r.publicKey };
}
const myKeyRow = (vaultId, userId) => db.prepare('SELECT wrapped, wrapped_by FROM vault_keys WHERE vault_id = ? AND user_id = ?').get(vaultId, userId);
const setKeyRow = (vaultId, userId, wrapped, by) => db.prepare('UPDATE vault_keys SET wrapped = ?, wrapped_by = ? WHERE vault_id = ? AND user_id = ?').run(wrapped, by, vaultId, userId);

try {
  // ---------- H-2: 새 볼트 키는 내 계정 키로 ----------
  const owner = await makeUser('owner@example.test');
  const D1 = await device('o1', owner.token);
  let me1 = await openOn(D1, owner);
  const pv1 = vaultOf(me1, (v) => v.kind === 'personal');
  await D1.V.loadVault(pv1);
  const row1 = myKeyRow(pv1.id, owner.id);
  const oldAppOpens = (await E.unwrapVaultKey(row1.wrapped, owner.account, pv1.id)).length === 32;
  check('새로 만든 볼트 키는 내 계정 키로 봉한다 (봉한 공개키 = 내 공개키, 옛 앱도 풀 수 있는 같은 형식)', senderOf(row1.wrapped) === owner.pub && row1.wrapped_by === owner.id && oldAppOpens);

  // ---------- 예전 방식(출처 모름) 개인 볼트 키: 처음 보는 기기에서는 묻는다 → 열면 내 키로 다시 봉한다 ----------
  const old = await makeUser('old@example.test');
  const meOld = (await http('GET', '/api/me', old.token)).body;
  const pvOld = vaultOf(meOld, (v) => v.kind === 'personal');
  const legacyRaw = crypto.randomBytes(32);
  await http('POST', `/api/vaults/${pvOld.id}/key`, old.token, { wrapped: await E.wrapVaultKey(legacyRaw, old.pub, pvOld.id, old.id) });
  const D2 = await device('old1', old.token);
  let me2 = await openOn(D2, old);
  const untrusted = await loadErr(D2, vaultOf(me2, (v) => v.kind === 'personal'));
  check('예전 방식 볼트 키를 처음 보는 기기에서는 저절로 열지 않는다', untrusted instanceof D2.V.UntrustedVaultKey, { error: untrusted?.message?.slice(0, 40) });
  D2.V.trustVaultKeyOnce(pvOld.id);
  const afterTrust = await loadErr(D2, vaultOf(me2, (v) => v.kind === 'personal'));
  await sleep(500);
  const rewrapped = myKeyRow(pvOld.id, old.id);
  const sameKey = Buffer.from(await E.unwrapVaultKey(rewrapped.wrapped, old.account, pvOld.id)).equals(legacyRaw);
  check('확인하고 열면 같은 볼트 키를 내 계정 키로 다시 봉해 둔다', afterTrust === null && senderOf(rewrapped.wrapped) === old.pub && sameKey);
  const D2b = await device('old2', old.token);
  const me2b = await openOn(D2b, old);
  check('다시 봉한 뒤에는 다른 기기에서도 묻지 않고 연다', (await loadErr(D2b, vaultOf(me2b, (v) => v.kind === 'personal'))) === null);

  // ---------- 서버가 볼트 키를 바꿔 넣으면 ----------
  setKeyRow(pvOld.id, old.id, await E.wrapVaultKey(crypto.randomBytes(32), old.pub, pvOld.id, old.id), old.id);
  me2 = await openOn(D2, old);
  const swappedKnown = await loadErr(D2, vaultOf(me2, (v) => v.kind === 'personal'));
  const D2c = await device('old3', old.token);
  const me2c = await openOn(D2c, old);
  const swappedFresh = await loadErr(D2c, vaultOf(me2c, (v) => v.kind === 'personal'));
  check('서버가 바꿔 넣은 볼트 키: 전에 본 기기는 막고, 처음 보는 기기도 저절로 열지 않는다', /전에 본 것과 다릅니다/.test(swappedKnown?.message ?? '') && swappedFresh instanceof D2c.V.UntrustedVaultKey, {
    known: swappedKnown?.message?.slice(0, 30),
  });

  // 개인 볼트 키를 다른 사람(의 키)이 봉했다고 하면
  const other = await makeUser('other@example.test');
  setKeyRow(pvOld.id, old.id, await E.wrapVaultKey(crypto.randomBytes(32), old.pub, pvOld.id, old.id, other.account), other.id);
  const D2d = await device('old4', old.token);
  const me2d = await openOn(D2d, old);
  const foreign = await loadErr(D2d, vaultOf(me2d, (v) => v.kind === 'personal'));
  check('다른 사람이 봉한 개인 볼트 키는 열지 않는다', /개인 볼트의 키를 다른 사람이 봉했습니다/.test(foreign?.message ?? ''), { error: foreign?.message?.slice(0, 30) });

  // ---------- 방금 만든 계정: 예전 방식 개인 볼트 키는 받지 않는다 ----------
  const fresh = await makeUser('fresh@example.test');
  const meF = (await http('GET', '/api/me', fresh.token)).body;
  const pvF = vaultOf(meF, (v) => v.kind === 'personal');
  await http('POST', `/api/vaults/${pvF.id}/key`, fresh.token, { wrapped: await E.wrapVaultKey(crypto.randomBytes(32), fresh.pub, pvF.id, fresh.id) });
  const DF = await device('fresh1', fresh.token);
  on(DF);
  DF.V.noteFreshAccount(fresh.id);
  const meF2 = await openOn(DF, fresh);
  DF.V.takeFreshAccount(fresh.id);
  DF.V.trustVaultKeyOnce(pvF.id);
  const freshErr = await loadErr(DF, vaultOf(meF2, (v) => v.kind === 'personal'));
  check('방금 만든 계정은 서버가 먼저 채워 둔 개인 볼트 키를 열지 않는다 (확인해도)', /방금 만든 계정/.test(freshErr?.message ?? ''), { error: freshErr?.message?.slice(0, 30) });

  // ---------- 팀 공유: 보낸 사람이 드러나고, 받은 쪽은 내 키로 다시 봉한다 ----------
  const team = (await http('POST', '/api/teams', owner.token, { name: 'T' })).body;
  await http('POST', `/api/teams/${team.id}/invites`, owner.token, { email: 'm@example.test' });
  const member = await makeUser('m@example.test');
  const inv = (await http('GET', '/api/me/invites', member.token)).body[0];
  await http('POST', `/api/me/invites/${inv.id}/accept`, member.token, {});
  me1 = await openOn(D1, owner);
  const tv = vaultOf(me1, (v) => v.teamId === team.id);
  await D1.V.initMissingKeys(me1.vaults);
  me1 = await openOn(D1, owner);
  await D1.V.loadVault(vaultOf(me1, (v) => v.id === tv.id));
  const pending = await D1.api.get('/api/vault-keys/pending');
  const shared = await D1.V.shareVaultKeys(pending.filter((p) => p.userId === member.id));
  const mRow = myKeyRow(tv.id, member.id);
  check('공유한 볼트 키는 공유한 사람의 계정 키로 봉한다', shared === 1 && senderOf(mRow.wrapped) === owner.pub && mRow.wrapped_by === owner.id);
  const DM = await device('m1', member.token);
  let meM = await openOn(DM, member);
  const mOpen = await loadErr(DM, vaultOf(meM, (v) => v.id === tv.id));
  await sleep(500);
  check('팀원은 공유받은 키를 묻지 않고 열고, 내 계정 키로 다시 봉해 둔다', mOpen === null && senderOf(myKeyRow(tv.id, member.id).wrapped) === member.pub);

  // 공유한 사람의 공개키를 서버가 바꿔치기하고 그 키로 봉한 볼트 키를 주면
  const fakeOwner = (await E.createAccount(owner.id, 'fake-owner-password-1')).account;
  const realPub = db.prepare('SELECT public_key FROM users WHERE id = ?').get(owner.id).public_key;
  db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(E.toB64(fakeOwner.publicKey), owner.id);
  setKeyRow(tv.id, member.id, await E.wrapVaultKey(crypto.randomBytes(32), member.pub, tv.id, member.id, fakeOwner), owner.id);
  meM = await openOn(DM, member);
  const peerSwap = await loadErr(DM, vaultOf(meM, (v) => v.id === tv.id));
  check('공유한 사람의 공개키가 이 기기에서 전에 본 것과 다르면 열지 않는다', /공개키가 이 기기에서 전에 본 것과 다릅니다|전에 본 것과 다릅니다/.test(peerSwap?.message ?? ''), { error: peerSwap?.message?.slice(0, 40) });
  db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(realPub, owner.id);

  // ---------- M-5: 되돌리기 ----------
  me1 = await openOn(D1, owner);
  const pvO = vaultOf(me1, (v) => v.kind === 'personal');
  await D1.V.loadVault(pvO);
  const h = await D1.V.vaultApi.createHost(pvO.id, { label: 'r1', address: '10.9.0.1', username: 'root' });
  const v1 = db.prepare('SELECT data FROM items WHERE id = ?').get(h.id).data;
  await D1.V.vaultApi.updateHost(h.id, { address: '10.9.0.2' });
  await D1.V.loadVault(pvO);
  db.prepare('UPDATE items SET data = ? WHERE id = ?').run(v1, h.id);
  const rolled = await D1.V.loadVault(pvO);
  const hidden = !rolled.items.hosts.some((x) => x.id === h.id);
  D1.V.acceptStale(pvO.id);
  const accepted = await D1.V.loadVault(pvO);
  check('서버가 예전 판을 다시 주면 숨기고 알리며, 받아들이면 다시 보인다', rolled.stale === 1 && hidden && accepted.items.hosts.some((x) => x.id === h.id && x.address === '10.9.0.1'), { stale: rolled.stale });
  const gone = await D1.V.vaultApi.createHost(pvO.id, { label: 'd1', address: '10.9.0.3', username: 'root' });
  const goneRow = db.prepare('SELECT * FROM items WHERE id = ?').get(gone.id);
  await D1.V.vaultApi.deleteHost(gone.id);
  await D1.V.loadVault(pvO);
  db.prepare('INSERT INTO items (id, vault_id, kind, data, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(goneRow.id, goneRow.vault_id, goneRow.kind, goneRow.data, goneRow.created_by, goneRow.updated_by, goneRow.created_at, goneRow.updated_at);
  const back = await D1.V.loadVault(pvO);
  check('지운 항목을 서버가 다시 주면 숨긴다', back.stale === 1 && !back.items.hosts.some((x) => x.id === gone.id), { stale: back.stale });

  // ---------- M-6: 주소가 바뀐 호스트에는 내 개인 접속 정보를 보내지 않는다 ----------
  me1 = await openOn(D1, owner);
  await D1.V.loadVault(vaultOf(me1, (v) => v.id === tv.id));
  // 위에서 바꿔치기한 팀원의 볼트 키를 되돌린다 (관리자가 다시 공유)
  db.prepare('DELETE FROM vault_keys WHERE vault_id = ? AND user_id = ?').run(tv.id, member.id);
  await D1.V.shareVaultKeys((await D1.api.get('/api/vault-keys/pending')).filter((p) => p.userId === member.id));
  const th = await D1.V.vaultApi.createHost(tv.id, { label: 'shared', address: '10.8.8.8', username: '' });
  meM = await openOn(DM, member);
  DM.ls.removeItem(`terminas.vaultpin.${member.id}.${tv.id}`);
  DM.V.trustVaultKeyOnce(tv.id);
  await DM.V.loadVault(vaultOf(meM, (v) => v.id === tv.id));
  const pvM = vaultOf(meM, (v) => v.kind === 'personal');
  await DM.V.loadVault(pvM);
  const idn = await DM.V.vaultApi.createIdentity(pvM.id, { label: 'me', username: 'alice', password: 'alice-secret-1' });
  await DM.V.vaultApi.setMyCredential(th.id, idn.id);
  const okBefore = (await DM.V.resolveCreds(th.id)).creds.password === 'alice-secret-1';
  on(D1);
  await D1.V.vaultApi.updateHost(th.id, { address: '203.0.113.66' });
  on(DM);
  await DM.V.loadVault(vaultOf(meM, (v) => v.id === tv.id));
  let changedErr = null;
  try {
    await DM.V.resolveCreds(th.id);
  } catch (err) {
    changedErr = err;
  }
  check('내 접속 정보를 연결한 뒤 호스트 주소가 바뀌면 보내지 않는다', okBefore && /주소가 바뀌었습니다/.test(changedErr?.message ?? ''), { error: changedErr?.message?.slice(0, 40) });
} finally {
  db.close();
  child.kill();
  await once(child, 'exit').catch(() => {});
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
