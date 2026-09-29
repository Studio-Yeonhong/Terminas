// 서버·앱 버전이 섞일 때와 업데이트 채널 확인 — 격리된 임시 서버(개발 로그인)만 쓴다. 마지막에 개발용 앱 창이 잠깐 뜬다.
//   A) 서버가 받지 않는 오래된 앱(SHELL_MIN_APP_API 로 올려 봄)은 426 — 켤 때 맞춰 보는 주소·웹 화면(쿠키)은 그대로
//   B) 기본 서버는 수준을 알리지 않는 옛 앱(0.3.0 까지)도 받는다
//   C) 항목 형식 수준(_v): 새 앱이 만든 항목은 옛 앱이 고치거나 지우지 않고, 모르는 칸은 고쳐도 남는다
//   D) 게시 채널(베타는 beta/ 에만, 정식은 더 새것이면 beta/ 에도) · 버전 순서(0.4.0-beta.1 < 0.4.0-beta.2 < 0.4.0)
//   E) 화면: 연결된 서버 표시 · 베타 참여(경고 뒤 켜기·끄기)
// 저장소 루트에서: node security-review/verify-compat.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildUi, checker, launchApp, root, seedAccount, sleep, tempServer } from './ui-harness.mjs';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-compat-'));
const OUT = process.env.OUT || path.join(T, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const c = checker();
const bearer = async (server, p, token, headers = {}) => {
  const res = await fetch(server.base + p, { headers: { 'x-shell': '1', authorization: `Bearer ${token}`, ...headers } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let strict = null;
let server = null;
let app = null;
try {
  // ---------- A) 오래된 앱 막기 ----------
  strict = await tempServer(path.join(T, 'strict'), { SHELL_MIN_APP_API: '2' });
  await strict.start();
  const cfg = (await strict.http('GET', '/api/auth/config')).body;
  c.check('켤 때 맞춰 보는 주소는 열려 있고 받아 주는 가장 낮은 앱 수준을 알린다', cfg?.minAppApi === 2, { minAppApi: cfg?.minAppApi });
  const tok = (await strict.http('POST', '/api/auth/dev-login-token', null, { email: 'owner@example.test' })).body.token;
  const legacy = await bearer(strict, '/api/me', tok);
  const lvl1 = await bearer(strict, '/api/me', tok, { 'x-terminas-api': '1' });
  const lvl2 = await bearer(strict, '/api/me', tok, { 'x-terminas-api': '2' });
  c.check('수준을 알리지 않는 옛 앱·수준 1 앱은 426 (업데이트 안내 문장)', legacy.status === 426 && legacy.body?.error === 'app_old' && /업데이트/.test(legacy.body?.message ?? '') && lvl1.status === 426, { legacy: legacy.status, lvl1: lvl1.status });
  c.check('수준 2 앱은 그대로', lvl2.status === 200);
  const latest = await bearer(strict, '/api/app/latest', tok);
  c.check('앱 내려받기 정보는 옛 앱에게도 준다', latest.status !== 426, { status: latest.status });
  const login = await fetch(`${strict.base}/api/auth/dev-login`, { method: 'POST', headers: { 'x-shell': '1', origin: strict.base, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test' }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
  const web = await fetch(`${strict.base}/api/me`, { headers: { 'x-shell': '1', cookie } });
  c.check('웹 화면(쿠키)은 막지 않는다 — 서버가 준 화면이라 늘 맞다', web.status === 200, { status: web.status });
  await strict.stop();
  strict = null;

  // ---------- B) 기본 서버 ----------
  server = await tempServer(path.join(T, 'data'));
  await server.start();
  const PW = 'compat-password-1';
  const { V, E, pv, account, token } = await seedAccount(server, 'owner@example.test', PW);
  c.check('기본 서버는 수준을 알리지 않는 옛 앱(0.3.0 까지)도 받는다', (await bearer(server, '/api/me', token)).status === 200);

  // ---------- C) 항목 형식 수준 ----------
  const key = await E.importKey(await E.unwrapVaultKey(pv.wrappedKey, account, pv.id));
  const rawOf = async (id) => {
    const rows = (await server.http('GET', `/api/vaults/${pv.id}/items`, token)).body;
    const r = rows.find((x) => x.id === id);
    return E.openJson(key, r.data, E.itemAad(pv.id, r.id, r.kind));
  };
  const noAuth = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };
  const plain = await V.vaultApi.createRequest(pv.id, { label: 'plain', method: 'GET', url: 'http://h/', auth: noAuth });
  const withKey = await V.vaultApi.createRequest(pv.id, { label: 'apikey', method: 'GET', url: 'http://h/', auth: { ...noAuth, type: 'apikey', key: 'X-Key', token: 'v' } });
  c.check('새 형식을 쓴 항목에만 _v 를 적는다 (API 키 → 2, 보통 요청 → 없음)', (await rawOf(plain.id))._v === undefined && (await rawOf(withKey.id))._v === 2);
  // 더 새 앱(형식 99)이 만든 항목을 서버에 직접 넣는다
  const put = async (id, data) =>
    server.http('POST', `/api/vaults/${pv.id}/items`, token, { id, kind: 'request', data: await E.sealJson(key, data, E.itemAad(pv.id, id, 'request')) });
  const futureId = crypto.randomUUID();
  await put(futureId, { label: 'future', method: 'GET', url: 'http://h/f', auth: { type: 'oauth9', grant: 'x' }, _v: 99 });
  const keepId = crypto.randomUUID();
  await put(keepId, { label: 'keep', method: 'GET', url: 'http://h/k', futureField: 'keep-me', auth: noAuth });
  await V.loadVault(pv);
  c.check('더 새 앱의 항목도 보이기는 한다', V.itemsOf(pv.id).requests.some((r) => r.id === futureId));
  const upd = await V.vaultApi.updateRequest(futureId, { label: 'changed' }).then(() => null, (e) => e.message);
  const del = await V.vaultApi.deleteRequest(futureId).then(() => null, (e) => e.message);
  const after = await rawOf(futureId);
  c.check('더 새 앱의 항목은 고치거나 지우지 않는다 (모르는 인증 종류가 그대로)', /새 버전 앱에서 만든 항목/.test(upd ?? '') && /새 버전 앱에서 만든 항목/.test(del ?? '') && after.label === 'future' && after.auth.type === 'oauth9', { upd, del });
  await V.vaultApi.updateRequest(keepId, { label: 'keep-2' });
  const kept = await rawOf(keepId);
  c.check('모르는 칸은 고쳐도 남는다', kept.label === 'keep-2' && kept.futureField === 'keep-me', { kept: { label: kept.label, futureField: kept.futureField } });

  // ---------- D) 게시 채널 · 버전 순서 ----------
  const { publishTargets } = await import(pathToFileURL(path.join(root, 'desktop/scripts/publish.mjs')).href);
  const { newerVersion } = await import(pathToFileURL(path.join(root, 'desktop/src/update-verify.js')).href);
  const up = path.join(T, 'updates');
  const rel = (dirs) => dirs.map((d) => path.relative(up, d) || '.').join(',');
  c.check('베타 버전은 베타 채널에만', rel(publishTargets(up, '0.4.0-beta.1')) === 'beta');
  c.check('정식 버전은 정식 + (베타 채널이 비었으면) 베타 채널에도', rel(publishTargets(up, '0.3.1')) === '.,beta');
  fs.mkdirSync(path.join(up, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(up, 'beta', 'latest.yml'), 'version: 0.4.0-beta.1\n');
  c.check('베타 채널에 더 새 베타가 있으면 옛 정식은 정식 채널에만', rel(publishTargets(up, '0.3.2')) === '.');
  c.check('베타보다 새 정식은 베타 채널에도 (베타를 켠 사람도 받게)', rel(publishTargets(up, '0.4.0')) === '.,beta');
  const order = [
    ['0.4.0-beta.2', '0.4.0-beta.1', true],
    ['0.4.0-beta.10', '0.4.0-beta.9', true],
    ['0.4.0', '0.4.0-rc.1', true],
    ['0.4.0-beta.1', '0.3.9', true],
    ['0.3.9', '0.4.0-beta.1', false],
    ['0.4.0-beta.1', '0.4.0-beta.1', false],
  ];
  c.check('버전 순서 (베타끼리·베타와 정식)', order.every(([a, b, want]) => newerVersion(a, b) === want));

  // ---------- E) 화면 ----------
  const uiDir = buildUi(path.join(T, 'ui'));
  const profile = path.join(T, 'profile');
  app = await launchApp({ base: server.base, profile, out: OUT, uiDir });
  c.check('로그인·잠금 해제', await app.signIn('owner@example.test', PW, 'Personal'));
  const info = await app.evaluate('window.studioDesktop.serverInfo()');
  c.check('앱 본체가 공식 서버인지 알려 준다 (시험 서버는 공식 아님)', info?.official === false && info?.url === server.base, { info });
  await app.click('.user-btn');
  await sleep(300);
  await app.clickText('설정', '.menu button');
  const host = new URL(server.base).host;
  c.check('설정에 연결된 서버 (직접 운영하는 서버는 주소만)', await app.waitText(`연결된 서버 · ${host}`));
  const channelOf = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).updateChannel;
    } catch {
      return undefined;
    }
  };
  const betaOn = (v) => app.waitFor(`document.querySelector('[aria-label="베타 버전 받기"]')?.getAttribute('aria-checked') === '${v}'`);
  // 채널을 고른 적이 없으면 앱 버전을 따른다 — 베타 버전(1.0.0-beta.1 처럼)으로 설치한 앱은 베타 채널에서 시작
  const appVersion = JSON.parse(fs.readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')).version;
  const pre = appVersion.includes('-');
  const startOn = await betaOn(pre ? 'true' : 'false');
  c.check('채널을 고른 적 없으면 버전을 따른다 (베타 버전 앱은 베타 채널에서 시작)', startOn && channelOf() === undefined, { appVersion });
  const leave = async () => {
    await app.click('[aria-label="베타 버전 받기"]');
    await app.waitText('베타에서 나가기');
    await app.clickText('나가기', '.modal button');
    c.check('끄면 정식 채널로', (await betaOn('false')) && channelOf() === 'stable');
  };
  if (pre) await leave();
  await app.click('[aria-label="베타 버전 받기"]');
  c.check('베타를 켜면 먼저 안정성 경고', (await app.waitText('베타 버전 참여')) && (await app.waitText('정식 버전을 권합니다')));
  await app.shot('beta-warning');
  await app.clickText('베타 참여', '.modal button');
  c.check('확인하면 베타 채널로 (앱 설정에 저장)', (await betaOn('true')) && channelOf() === 'beta');
  await app.shot('beta-on');
  if (!pre) await leave();
} catch (err) {
  c.check(`예외: ${err?.stack ?? err}`, false);
} finally {
  app?.close();
  await strict?.stop();
  await server?.stop();
  await sleep(500);
  console.log(`shots: ${OUT}`);
  if (!process.env.OUT) fs.rmSync(path.join(T, 'profile'), { recursive: true, force: true });
}
console.log(c.failures ? `\n${c.failures} FAILED` : '\nALL PASS');
process.exit(c.failures ? 1 : 0);
