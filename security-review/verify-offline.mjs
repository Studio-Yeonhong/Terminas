// 오프라인 사용·개인 동기화·팀 오프라인 기간 확인 — 격리된 임시 서버(개발 로그인)로. 운영 DB·자격증명은 쓰지 않는다.
// 화면의 볼트 층(web/src/vault.ts · offline.ts)을 가짜 앱 본체(desktop bridge: 서버 호출 + 사본 저장)에 얹어 Node 로 돌리고,
// 같은 사람의 두 "기기"(A·B)를 따로 띄워 오프라인에서 고친 것과 다른 기기에서 고친 것이 부딪치는 경우까지 본다.
// 저장소 루트에서: node security-review/verify-offline.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// web/src 의 확장자 없는 상대 경로(./api)를 .ts 로 찾고, 부모의 ?dev=… 를 이어 붙여 기기마다 모듈을 따로 둔다
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

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-offline-'));
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

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

// ---------- 가짜 앱 본체 · 기기 ----------
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();

function bridge(token, store) {
  const b = {
    reachable: true,
    calls: [],
    version: 'test',
    platform: process.platform,
    async api(method, p, body) {
      b.calls.push(`${method} ${p}`);
      if (!b.reachable) return { status: 0, data: { error: 'network', message: 'Terminas 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.' } };
      const r = await http(method, p, token, body);
      return { status: r.status, data: r.body };
    },
    // 진짜 앱은 이 값을 OS 보호 저장소로 감싸 파일에 쓴다 (desktop/src/main.js) — 여기서는 메모리
    cache: {
      available: async () => true,
      get: async (n) => store.get(n) ?? null,
      put: async (n, v) => (store.set(n, v), true),
      remove: async (n) => void store.delete(n),
      list: async () => [...store.keys()],
      clear: async () => store.clear(),
    },
  };
  return b;
}

const src = (f, dev) => `${pathToFileURL(path.join(root, 'web/src', f)).href}?dev=${dev}`;
async function device(dev, token, store) {
  const b = bridge(token, store);
  globalThis.window = { studioDesktop: b };
  const V = await import(src('vault.ts', dev));
  const O = await import(src('offline.ts', dev));
  const N = await import(src('net.ts', dev));
  const { api } = await import(src('api.ts', dev));
  await O.offlineAvailable();
  return { b, V, O, N, api };
}
const E = await import(pathToFileURL(path.join(root, 'web/src/e2ee.ts')).href);
const PW = 'offline-test-password-1';
const hostsOf = (d, vaultId) => d.V.itemsOf(vaultId).hosts;
const labels = (d, vaultId) => hostsOf(d, vaultId).map((h) => h.label).sort();
const byLabel = (d, vaultId, label) => hostsOf(d, vaultId).find((h) => h.label === label);
const snapOf = (store, vaultId) => (store.has(`vault.${vaultId}`) ? JSON.parse(store.get(`vault.${vaultId}`)) : null);
const rejects = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return String(err?.message ?? err);
  }
};

try {
  const cfg = await http('GET', '/api/auth/config');
  check('서버 API 수준 3', cfg.body.api === 3, { api: cfg.body.api });

  // ---------- 준비: 계정·암호화 ----------
  const tokA = await login('owner@example.test');
  const tokB = await login('owner@example.test');
  const me0 = (await http('GET', '/api/me', tokA)).body;
  const r = await E.createAccount(me0.user.id, PW);
  check('암호화 설정', (await http('POST', '/api/me/keys', tokA, { publicKey: r.publicKey, bundle: r.bundle, proof: r.proof })).status === 200);
  const user = { id: me0.user.id, name: 'owner' };

  // ---------- 기기 A: 온라인 ----------
  const storeA = new Map();
  const A = await device('a', tokA, storeA);
  let me = await A.api.get('/api/me');
  await A.O.bindUser(me.user.id);
  await A.O.saveMe(me);
  A.V.setAccount(await E.unlockWithPassword(me.user.id, me.crypto.publicKey, me.crypto.bundle, PW), user);
  A.V.setVaults(me.vaults, me.teams);
  const pv = me.vaults.find((v) => v.kind === 'personal');
  await A.V.loadVault(pv);
  const hosts = {};
  for (const n of ['h1', 'h2', 'h3', 'h4']) hosts[n] = await A.V.vaultApi.createHost(pv.id, { label: n, address: `10.0.0.${n.slice(1)}`, username: 'root', password: n === 'h1' ? 'S3cret-pass-XYZ' : null });
  await A.V.vaultApi.createGroup(pv.id, { name: 'g1', parentId: null });
  await A.V.flushPersist();
  const snap1 = snapOf(storeA, pv.id);
  const raw1 = storeA.get(`vault.${pv.id}`) ?? '';
  check('온라인: 개인 볼트 사본을 이 PC 에 둔다 (항목 5개)', snap1?.rows.length === 5 && Object.keys(snap1.dirty).length === 0, { rows: snap1?.rows.length });
  // 주소의 점(.)·비밀번호의 하이픈(-)·JSON 키는 base64 암호문에 나올 수 없다
  check('사본에는 암호문만 (주소·비밀번호·항목 내용이 보이지 않는다)', !/10\.0\.0\.1|S3cret-pass-XYZ|"address"|"password"|"username"/.test(raw1) && snap1.rows.every((x) => x.data.startsWith('v1.')));
  const meSnap = storeA.get('me') ?? '';
  check('계정 정보 사본: 잠긴 키 묶음만 (계정 키·비밀번호 없음)', meSnap.includes('"bundle"') && !meSnap.includes(PW) && !meSnap.includes('accountKey'));

  // 팀
  const team = (await A.api.post('/api/teams', { name: 'T1' })).id;
  me = await A.api.get('/api/me');
  A.V.setVaults(me.vaults, me.teams);
  await A.O.saveMe(me);
  const tv = me.vaults.find((v) => v.teamId === team);
  // 팀에 들지 않은 사람은 이 서버에 로그인할 수 없다 — 먼저 팀에 넣는다
  await http('POST', `/api/teams/${team}/invites`, tokA, { email: 'member@example.test', role: 'admin' });
  await http('POST', `/api/teams/${team}/invites`, tokA, { email: 'stranger@example.test', role: 'member' });
  const tokM = await login('member@example.test');
  await A.V.initMissingKeys(me.vaults);
  me = await A.api.get('/api/me');
  A.V.setVaults(me.vaults, me.teams);
  await A.O.saveMe(me);
  await A.V.loadVault(me.vaults.find((v) => v.id === tv.id));
  await A.V.vaultApi.createHost(tv.id, { label: 't1', address: '10.1.0.1', username: 'ops' });
  await A.V.syncAll();
  await A.V.flushPersist();
  check('팀 볼트 사본도 둔다', snapOf(storeA, tv.id)?.rows.length === 1);

  // ---------- A: 오프라인에서 고치기 ----------
  A.b.reachable = false;
  const offLoad = await A.V.loadVault(pv);
  check('서버에 닿지 않으면 오프라인으로 바뀌고 사본으로 연다', !A.N.isOnline() && offLoad.state === 'ready' && offLoad.items.hosts.length === 4);
  await A.V.vaultApi.createHost(pv.id, { label: 'h5', address: '10.0.0.5', username: 'root' });
  await A.V.vaultApi.updateHost(hosts.h1.id, { label: 'h1-offline' });
  await A.V.vaultApi.updateHost(hosts.h2.id, { label: 'h2-offline' });
  await A.V.vaultApi.deleteHost(hosts.h3.id);
  await A.V.vaultApi.deleteHost(hosts.h4.id);
  const teamErr = await rejects(() => A.V.vaultApi.createHost(tv.id, { label: 't2', address: '10.1.0.2', username: 'ops' }));
  check('오프라인에서 팀 볼트는 고칠 수 없다', Boolean(teamErr?.includes('오프라인에서는 팀 볼트를 수정할 수 없습니다')), { teamErr });
  // 받은 적 없는 만든 것을 오프라인에서 곧바로 지우면 올릴 것도 없다
  const tmp = await A.V.vaultApi.createHost(pv.id, { label: 'tmp', address: '10.0.0.99', username: 'x' });
  await A.V.vaultApi.deleteHost(tmp.id);
  await A.V.report(pv.id, 'ssh_connect', 'h1-offline', { hostId: hosts.h1.id, via: 'app' });
  await A.V.report(tv.id, 'ssh_connect', 't1', { via: 'app' });
  await A.V.flushPersist();
  const offCalls = A.b.calls.length;
  const snap2 = snapOf(storeA, pv.id);
  check('오프라인 변경 5개를 사본에 "올릴 것"으로 적는다 (만들고 바로 지운 것은 빠짐)', Object.keys(snap2.dirty).length === 5, { dirty: Object.values(snap2.dirty).map((d) => d.op) });
  check('오프라인 접속 기록 2개를 모아 둔다', A.O.queuedAudits() === 2);
  check('사본에 저장된 오프라인 변경도 암호문', !/h1-offline|10\.0\.0\.5/.test(storeA.get(`vault.${pv.id}`)));

  // ---------- 기기 B (온라인): 그사이 서버에서 고친다 ----------
  const storeB = new Map();
  const B = await device('b', tokB, storeB);
  const meB = await B.api.get('/api/me');
  await B.O.bindUser(meB.user.id);
  B.V.setAccount(await E.unlockWithPassword(meB.user.id, meB.crypto.publicKey, meB.crypto.bundle, PW), user);
  B.V.setVaults(meB.vaults, meB.teams);
  await B.V.loadVault(meB.vaults.find((v) => v.id === pv.id));
  await B.V.vaultApi.updateHost(hosts.h1.id, { label: 'h1-B' });
  await B.V.vaultApi.updateHost(hosts.h3.id, { label: 'h3-B' });
  await B.V.vaultApi.deleteHost(hosts.h2.id);

  // ---------- A 를 오프라인으로 다시 켠다 (앱 재시작) ----------
  const A2 = await device('a2', tokA, storeA);
  A2.b.reachable = false;
  const cached = await A2.O.loadMe();
  check('오프라인으로 켤 때: 이 PC 의 계정 정보를 읽는다', cached?.user.id === me.user.id && Boolean(cached.crypto));
  const offVaults = await A2.O.offlineVaults(cached);
  check('오프라인 볼트 목록: 개인 + 기한 안의 팀 볼트', offVaults.length === 2);
  A2.N.setOnline(false);
  const acct2 = await E.unlockWithPassword(cached.user.id, cached.crypto.publicKey, cached.crypto.bundle, PW);
  check('오프라인에서도 암호화 비밀번호로 잠금 해제된다', acct2.userId === me.user.id);
  A2.V.setAccount(acct2, user);
  A2.V.setVaults(offVaults, cached.teams);
  const l2 = await A2.V.loadVault(offVaults.find((v) => v.id === pv.id));
  check('다시 켜도 오프라인 변경이 보인다', JSON.stringify(labels(A2, pv.id)) === JSON.stringify(['h1-offline', 'h2-offline', 'h5']), { labels: labels(A2, pv.id), state: l2.state });
  await A2.V.loadVault(offVaults.find((v) => v.id === tv.id));
  check('팀 볼트도 사본으로 보인다', JSON.stringify(labels(A2, tv.id)) === '["t1"]');
  check('모아 둔 접속 기록도 남아 있다', A2.O.queuedAudits() === 2);
  check('오프라인 동안 서버에 아무것도 보내지 않았다 (A 는 끊긴 채 호출만 실패)', A.b.calls.length === offCalls);

  // ---------- 다시 연결: 올리기·충돌 ----------
  A2.b.reachable = true;
  A2.N.setOnline(true);
  await A2.V.flushAudits();
  const results = [];
  const off = A2.V.onSyncResult((x) => results.push(x));
  const sum = await A2.V.syncAll();
  off();
  check('다시 연결되면 올린다: 새로 만든 것 1·지운 것 1 올림, 충돌 1, 지우지 않고 둔 것 1, 되살린 것 1', sum.pushed === 2 && sum.conflicts === 1 && sum.kept === 1 && sum.restored === 1 && sum.failed === 0, sum);
  await B.V.loadVault(meB.vaults.find((v) => v.id === pv.id));
  const serverLabels = labels(B, pv.id);
  check('서버 결과: 서버에서 고친 h1-B 는 그대로 + 내 것은 "충돌 사본", 지워진 h2 는 내 것으로 되살림, 고쳐진 h3 는 남김, h4 지움, h5 올림', JSON.stringify(serverLabels) === JSON.stringify(['h1-B', 'h1-offline (충돌 사본)', 'h2-offline', 'h3-B', 'h5']), { serverLabels });
  check('A 의 화면도 서버와 같아진다', JSON.stringify(labels(A2, pv.id)) === JSON.stringify(serverLabels));
  await A2.V.flushPersist();
  check('올린 뒤 사본의 "올릴 것"이 비었다', Object.keys(snapOf(storeA, pv.id).dirty).length === 0);
  const conflictHost = byLabel(B, pv.id, 'h1-offline (충돌 사본)');
  check('충돌 사본에도 비밀번호가 그대로 (다시 암호화됨)', conflictHost?.hasPassword === true && B.V.hostPassword(conflictHost.id) === 'S3cret-pass-XYZ');
  const logs = (await http('GET', `/api/vaults/${pv.id}/logs`, tokA)).body;
  const offlineLog = logs.find((l) => l.action === 'ssh_connect');
  check('오프라인 접속 기록이 올라가고, 실제로 한 때(offlineAt)가 남는다', typeof offlineLog?.detail?.offlineAt === 'number' && offlineLog.detail.offlineAt <= offlineLog.ts, { detail: offlineLog?.detail });
  check('모아 둔 기록을 비웠다', A2.O.queuedAudits() === 0);

  // ---------- 서버: 지우기 충돌 확인·서버 사본 비우기 ----------
  const h5 = byLabel(B, pv.id, 'h5');
  const del409 = await http('DELETE', `/api/items/${h5.id}`, tokA, { baseUpdatedAt: 1 });
  check('지울 때 기준 판이 다르면 409 (지우지 않는다)', del409.status === 409, { status: del409.status });
  const clearTeam = await http('DELETE', `/api/vaults/${tv.id}/items`, tokA, { confirm: 'CLEAR' });
  const clearNoConfirm = await http('DELETE', `/api/vaults/${pv.id}/items`, tokA, {});
  check('서버 사본 비우기: 팀 볼트는 안 된다 · 확인 값 없으면 안 된다', clearTeam.status === 400 && clearNoConfirm.status === 400, { team: clearTeam.status, noConfirm: clearNoConfirm.status });
  const other = await login('stranger@example.test');
  const otherClear = await http('DELETE', `/api/vaults/${pv.id}/items`, other, { confirm: 'CLEAR' });
  check('남의 개인 볼트는 비울 수 없다', otherClear.status === 404, { status: otherClear.status });

  // ---------- 개인 동기화 끄기 (서버 사본 지우기) → 켜기 ----------
  const localCount = A2.V.itemsOf(pv.id).hosts.length + A2.V.itemsOf(pv.id).groups.length;
  await A2.V.disablePersonalSync(true);
  const serverAfterOff = (await http('GET', `/api/vaults/${pv.id}/items`, tokA)).body.length;
  check('개인 동기화 끄기 + 서버 사본 지우기: 서버는 비고 이 PC 에는 그대로', serverAfterOff === 0 && A2.V.itemsOf(pv.id).hosts.length + A2.V.itemsOf(pv.id).groups.length === localCount && !A2.O.personalSync(), { serverAfterOff, localCount });
  const before = A2.b.calls.length;
  await A2.V.vaultApi.createHost(pv.id, { label: 'h6-local', address: '10.0.0.6', username: 'root' });
  await A2.V.report(pv.id, 'ssh_connect', 'h6-local', {});
  await A2.V.loadVault(offVaults.find((v) => v.id === pv.id));
  const sent = A2.b.calls.slice(before);
  check('끈 동안: 개인 볼트는 서버와 주고받지 않고, 접속 기록도 보내지 않는다', sent.length === 0 && A2.O.queuedAudits() === 0, { sent });
  const on = await A2.V.enablePersonalSync();
  const serverAfterOn = (await http('GET', `/api/vaults/${pv.id}/items`, tokA)).body.length;
  check('다시 켜면 이 PC 의 것을 모두 올린다', serverAfterOn === localCount + 1 && on.pushed === localCount + 1, { serverAfterOn, pushed: on.pushed });

  // 끄기(서버 사본 두기) → 그사이 다른 기기가 고침 → 켜면 충돌 사본
  await A2.V.disablePersonalSync(false);
  const h6 = byLabel(A2, pv.id, 'h6-local');
  await A2.V.vaultApi.updateHost(h6.id, { label: 'h6-mine' });
  await B.V.loadVault(meB.vaults.find((v) => v.id === pv.id));
  await B.V.vaultApi.updateHost(h6.id, { label: 'h6-theirs' });
  const on2 = await A2.V.enablePersonalSync();
  await B.V.loadVault(meB.vaults.find((v) => v.id === pv.id));
  check('끈 동안 양쪽에서 고친 것: 켜면 서버 것 + 내 충돌 사본', on2.conflicts === 1 && Boolean(byLabel(B, pv.id, 'h6-theirs')) && Boolean(byLabel(B, pv.id, 'h6-mine (충돌 사본)')), on2);

  // ---------- 팀 볼트 사본 기한: 마지막 동기화부터 7일 (고정 — 팀마다 정하지 않는다) ----------
  const detail = (await http('GET', `/api/teams/${team}`, tokA)).body;
  me = await A2.api.get('/api/me');
  const setDays = await http('PATCH', `/api/teams/${team}`, tokA, { offlineDays: 3 });
  check('팀 오프라인 기간은 서버 설정이 아니다 (팀·내 정보에 없고, 바꾸는 요청은 받지 않는다)', detail.team.offlineDays === undefined && me.teams.every((t) => t.offlineDays === undefined) && setDays.status === 400, { setDays: setDays.status });
  A2.V.setVaults(me.vaults);
  await A2.O.saveMe(me);
  await A2.V.syncAll();
  await A2.V.flushPersist();
  // 마지막 동기화를 8일 전으로 → 7일이 지났다
  const ts = snapOf(storeA, tv.id);
  storeA.set(`vault.${tv.id}`, JSON.stringify({ ...ts, syncedAt: Date.now() - 8 * DAY }));
  const A3 = await device('a3', tokA, storeA);
  A3.b.reachable = false;
  const cached3 = await A3.O.loadMe();
  const off3 = await A3.O.offlineVaults(cached3);
  check('7일이 지난 팀 볼트는 오프라인에서 안 보이고 사본을 지운다', off3.length === 1 && off3[0].kind === 'personal' && !storeA.has(`vault.${tv.id}`), { vaults: off3.map((v) => v.kind) });

  // 6일 전 → 기간 안
  await A2.V.syncAll();
  await A2.V.flushPersist();
  storeA.set(`vault.${tv.id}`, JSON.stringify({ ...snapOf(storeA, tv.id), syncedAt: Date.now() - 6 * DAY }));
  const A4 = await device('a4', tokA, storeA);
  A4.b.reachable = false;
  const cached4 = await A4.O.loadMe();
  check('7일 안(6일 전 동기화)이면 보인다', (await A4.O.offlineVaults(cached4)).length === 2);
  // 시계를 뒤로 돌렸으면(마지막으로 본 시각보다 하루 앞) 팀 사본을 쓰지 않는다
  const st = JSON.parse(storeA.get('state'));
  storeA.set('state', JSON.stringify({ ...st, lastSeen: Date.now() + DAY }));
  const A5 = await device('a5', tokA, storeA);
  const cached5 = await A5.O.loadMe();
  check('시계를 되돌린 흔적이 있으면 팀 사본을 쓰지 않는다', (await A5.O.offlineVaults(cached5)).length === 1);
  storeA.set('state', JSON.stringify(st));
  await A2.V.syncAll();
  await A2.V.flushPersist();
  check('다시 맞추면 팀 사본을 다시 둔다', storeA.has(`vault.${tv.id}`));

  // 끊겨 있는 동안 7일이 지나면 메모리에서도 지운다: 7일에서 1.5초 모자란 사본으로 오프라인으로 연 뒤 2초 기다린다
  storeA.set(`vault.${tv.id}`, JSON.stringify({ ...snapOf(storeA, tv.id), syncedAt: Date.now() - 7 * DAY + 1500 }));
  const A6 = await device('a6', tokA, storeA);
  A6.b.reachable = false;
  const cached6 = await A6.O.loadMe();
  const off6 = await A6.O.offlineVaults(cached6);
  A6.N.setOnline(false);
  A6.V.setAccount(await E.unlockWithPassword(cached6.user.id, cached6.crypto.publicKey, cached6.crypto.bundle, PW), user);
  A6.V.setVaults(off6);
  const tLoad = await A6.V.loadVault(off6.find((v) => v.id === tv.id));
  await sleep(2000);
  const gone = await A6.V.expireCopies();
  const goneErr = await rejects(() => A6.V.vaultApi.createHost(tv.id, { label: 'x', address: '1.1.1.1', username: 'x' }));
  check('끊겨 있는 동안 7일이 지난 팀 볼트는 메모리와 이 PC 에서 지운다', off6.length === 2 && tLoad.state === 'ready' && gone.includes(tv.id) && A6.V.itemsOf(tv.id).hosts.length === 0 && Boolean(goneErr) && !storeA.has(`vault.${tv.id}`), { gone, goneErr });
  await A2.V.syncAll();
  await A2.V.flushPersist();

  // 팀에서 빠지면 사본을 지운다: 다른 팀에는 남아 있으면 새 목록에서 빠진 볼트만, 어느 팀에도 없으면(로그인 끝남) 팀 사본 모두
  const team2 = (await http('POST', '/api/teams', tokA, { name: 'T2' })).body.id;
  await http('POST', `/api/teams/${team2}/invites`, tokA, { email: 'member@example.test', role: 'member' });
  // 이미 계정이 있는 사람은 초대를 수락해야 들어간다 (보안 점검 M-3)
  const mInv = (await http('GET', '/api/me/invites', tokM)).body.find((i) => i.teamId === team2);
  await http('POST', `/api/me/invites/${mInv.id}/accept`, tokM, {});
  const meM = (await http('GET', '/api/me', tokM)).body;
  const storeM = new Map();
  const M = await device('m', tokM, storeM);
  await M.O.bindUser(meM.user.id);
  await M.O.saveMe(meM);
  const mv1 = meM.vaults.find((v) => v.teamId === team);
  const mv2 = meM.vaults.find((v) => v.teamId === team2);
  const mp = meM.vaults.find((v) => v.kind === 'personal');
  for (const v of [mv1, mv2, mp]) await M.O.saveVaultSnap(v.id, Date.now(), [], {});
  await http('DELETE', `/api/teams/${team}/members/${meM.user.id}`, tokA);
  const meM2 = (await http('GET', '/api/me', tokM)).body;
  await M.O.pruneSnaps(meM2);
  check('한 팀에서 빠지면 다시 연결될 때 그 팀 볼트 사본만 지운다', !storeM.has(`vault.${mv1.id}`) && storeM.has(`vault.${mv2.id}`) && storeM.has(`vault.${mp.id}`));
  await http('DELETE', `/api/teams/${team2}/members/${meM.user.id}`, tokA);
  const meM3 = await http('GET', '/api/me', tokM);
  // 앱은 401/403 을 받으면 팀 볼트 사본을 모두 지운다 (App.tsx 켤 때 · store.tsx 다시 연결할 때)
  if (meM3.status === 401 || meM3.status === 403) await M.O.dropTeamSnaps();
  const cachedM = await M.O.loadMe();
  check('어느 팀에도 없어 로그인이 끝나면 팀 볼트 사본을 모두 지우고 개인 볼트만 남긴다', meM3.status === 401 && !storeM.has(`vault.${mv2.id}`) && storeM.has(`vault.${mp.id}`) && cachedM.teams.length === 0 && cachedM.vaults.every((v) => v.kind === 'personal'), { status: meM3.status });

  // ---------- 다른 사람이 로그인하면 전 사람의 사본을 지운다 ----------
  const sizeBefore = storeA.size;
  await A2.O.bindUser('00000000-0000-4000-8000-00000000abcd');
  check('같은 서버에 다른 사람이 로그인하면 전 사람의 사본을 모두 지운다', sizeBefore > 2 && storeA.size === 1 && JSON.parse(storeA.get('state')).userId.endsWith('abcd'), { sizeBefore, after: [...storeA.keys()] });

  // ---------- 임시 모드 ----------
  const storeE = new Map();
  const T = await device('e', null, storeE);
  T.b.reachable = false;
  T.V.startEphemeral({ id: '00000000-0000-4000-8000-000000000000', name: 'local' });
  const lv = { id: '00000000-0000-4000-8000-000000000001', kind: 'personal', name: 'Personal', teamId: null, teamName: null, perm: 'edit', isDefault: true, wrappedKey: null, keyed: true };
  T.V.setVaults([lv], []);
  T.N.setOnline(false);
  await T.V.loadVault(lv);
  await T.V.vaultApi.createHost(lv.id, { label: 'e1', address: '127.0.0.1', username: 'me' });
  await T.V.report(lv.id, 'ssh_connect', 'e1', {});
  await T.V.flushPersist();
  check('임시 모드: 메모리에서만 쓰고 서버·사본에 아무것도 남기지 않는다', labels(T, lv.id)[0] === 'e1' && T.b.calls.length === 0 && storeE.size === 0, { calls: T.b.calls });
} catch (err) {
  failures++;
  console.log('FAIL (예외)', err?.stack ?? err);
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
