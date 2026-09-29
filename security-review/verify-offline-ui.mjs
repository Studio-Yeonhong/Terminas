// 오프라인 사용을 실제 앱 화면으로 확인 — 개발용 앱(Electron, 빌드한 화면 web/dist)을 버리는 프로필로 띄워 CDP 로 조작한다.
// 격리된 임시 서버(개발 로그인)만 쓴다. 창이 잠깐씩 뜬다. 화면 캡처는 결과 폴더(OUT, 기본 임시 폴더)에 남긴다.
// 저장소 루트에서: node security-review/verify-offline-ui.mjs  (화면은 따로 된 폴더에 빌드한다 — 운영 서버가 쓰는 web/dist 는 건드리지 않는다)
//   1) 온라인으로 로그인·잠금 해제 → 이 PC 에 사본이 생기고(OS 보호 저장소로 감쌈) 내용이 그대로 보이지 않는다
//   2) 서버를 끄고 앱을 다시 열면 사본으로 열린다(오프라인 표시) · 팀 볼트는 보기만 · 개인 볼트에 호스트를 더한다
//   3) 서버를 다시 켜면 다시 연결되어 오프라인에서 더한 호스트가 서버에 올라간다
//   4) 사본이 없는 새 프로필 + 서버 꺼짐 → "로컬 터미널·HTTP 요청만 사용하기" → 임시 모드
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUi } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
// web/src 모듈 경로 풀기는 ui-harness.mjs 가 등록한다

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-offline-ui-'));
const OUT = process.env.OUT || path.join(T, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const data = path.join(T, 'server-data');
const uiDir = buildUi(path.join(T, 'ui'));
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
const killTree = (pid) => {
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
  } catch {}
};

// ---------- 임시 서버 (끄고 다시 켤 수 있게) ----------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server = null;
async function startServer() {
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
  server = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  server.stderr.on('data', (b) => (err += b));
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(err);
    try {
      if ((await fetch(`${base}/api/auth/config`)).ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  killTree(server.pid);
  server = null;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/auth/config`);
    } catch {
      return;
    }
    await sleep(100);
  }
}
async function http(method, p, token, body) {
  const res = await fetch(base + p, { method, headers: { 'x-shell': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------- 준비 데이터: 화면의 볼트 층을 Node 로 (E2EE 라 서버에 바로 넣을 수 없다) ----------
const PW = 'offline-ui-password-1';
async function seed() {
  const token = (await http('POST', '/api/auth/dev-login-token', null, { email: 'owner@example.test' })).body.token;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = {
    studioDesktop: {
      version: 'seed',
      platform: process.platform,
      api: async (method, p, body) => {
        const r = await http(method, p, token, body);
        return { status: r.status, data: r.body };
      },
    },
  };
  const src = (f) => `${pathToFileURL(path.join(root, 'web/src', f)).href}?dev=seed`;
  const E = await import(pathToFileURL(path.join(root, 'web/src/e2ee.ts')).href);
  const V = await import(src('vault.ts'));
  const { api } = await import(src('api.ts'));
  let me = await api.get('/api/me');
  const r = await E.createAccount(me.user.id, PW);
  await api.post('/api/me/keys', { publicKey: r.publicKey, bundle: r.bundle, proof: r.proof });
  const team = (await api.post('/api/teams', { name: 'Ops' })).id;
  me = await api.get('/api/me');
  V.setAccount(r.account, { id: me.user.id, name: 'owner' });
  V.setVaults(me.vaults, me.teams);
  await V.initMissingKeys(me.vaults);
  me = await api.get('/api/me');
  V.setVaults(me.vaults, me.teams);
  const pv = me.vaults.find((v) => v.kind === 'personal');
  const tv = me.vaults.find((v) => v.teamId === team);
  await V.loadVault(pv);
  await V.loadVault(tv);
  await V.vaultApi.createHost(pv.id, { label: 'web-1', address: '10.20.0.1', username: 'root' });
  await V.vaultApi.createHost(pv.id, { label: 'db-1', address: '10.20.0.2', username: 'postgres' });
  await V.vaultApi.createHost(tv.id, { label: 'ops-bastion', address: '10.30.0.1', username: 'ops' });
  return { token, pv, tv, team };
}

// ---------- 앱 (개발용 Electron + CDP) ----------
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
async function launchApp(profile) {
  const cdpPort = await freePort();
  const env = { ...process.env, TERMINAS_UI: 'dist', STUDIO_SHELL_URL: base, TERMINAS_UI_DIR: uiDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(electron, [path.join(root, 'desktop'), `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { env, stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://terminas'));
    } catch {}
  }
  if (!target) throw new Error('app page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  let seq = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const text = () => evaluate('document.body ? document.body.innerText : ""');
  const waitText = async (needle, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const body = (await text().catch(() => '')) ?? '';
      if (typeof needle === 'string' ? body.includes(needle) : needle.test(body)) return true;
      await sleep(250);
    }
    return false;
  };
  const clickText = (label, selector = 'button') =>
    evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => [el, (el.innerText ?? '').trim()]); const hit = all.find(([, x]) => x === ${JSON.stringify(label)}) ?? all.find(([, x]) => x.endsWith(${JSON.stringify(label)})); const b = hit?.[0]; if (!b) return false; b.click(); return true; })()`);
  const fill = (selector, value) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const reload = () => evaluate('location.reload()');
  const close = () => {
    try {
      ws.close();
    } catch {}
    killTree(child.pid);
  };
  return { evaluate, text, waitText, clickText, fill, shot, reload, close, profile };
}

const offlineFiles = (profile) => {
  const dir = path.join(profile, 'offline');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)).map((f) => path.join(dir, d, f)));
};

let app = null;
let app2 = null;
try {
  await startServer();
  const { token, pv } = await seed();

  // 1) 온라인
  const profile = path.join(T, 'profile');
  app = await launchApp(profile);
  await app.waitText(/로그인|Google/);
  await app.evaluate(`window.studioDesktop.devLogin('owner@example.test')`);
  await app.reload();
  check('잠금 해제 화면', await app.waitText('잠금 해제'));
  await app.fill('input[type=password]', PW);
  // 잠금 해제 기억은 이제 직접 체크할 때만 (0.3.3 — 기본은 꺼짐)
  const remembered = await app.evaluate(`(() => { const c = document.querySelector('form.lock-form input[type=checkbox]'); if (!c) return null; const was = c.checked; if (!c.checked) c.click(); return was; })()`);
  check('잠금 해제 기억하기는 기본으로 꺼져 있다', remembered === false, { remembered });
  await app.evaluate(`document.querySelector('form.lock-form').requestSubmit()`);
  check('온라인: 개인 볼트가 열린다', await app.waitText('web-1', 30000));
  await sleep(5000); // 켠 뒤 3초에 모든 볼트 사본을 둔다
  const files = offlineFiles(profile);
  const joined = files.map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
  check('이 PC 에 사본 파일이 생긴다 (계정 정보·상태·볼트 2개)', files.some((f) => f.endsWith('me.bin')) && files.filter((f) => /vault\..+\.bin$/.test(f)).length === 2, { files: files.map((f) => path.basename(f)) });
  check('사본 파일은 OS 보호 저장소로 감싸 있다 (JSON·주소·암호문 모양이 보이지 않는다)', !/"rows"|"userId"|10\.20\.0\.1|v1\.[A-Za-z0-9+/]{20}/.test(joined));
  await app.shot('1-online');

  // 2) 서버를 끄고 앱을 다시 연다
  await stopServer();
  await app.reload();
  check('서버가 꺼져도 사본으로 열린다 (기억한 잠금 해제)', await app.waitText('web-1', 30000));
  check('오프라인 표시 (안내 줄 · 위쪽 막대)', await app.waitText('오프라인: 이 PC에 저장된 사본입니다'), {});
  await app.shot('2-offline-personal');
  // 호스트 더하기 (오프라인)
  await app.clickText('새 호스트');
  await sleep(500);
  await app.fill(`input[placeholder="IP 또는 호스트 이름"]`, '10.20.0.9');
  await app.fill(`input[placeholder="이름"]`, 'offline-added');
  await app.fill(`input[placeholder="사용자 이름"]`, 'root');
  await sleep(200);
  await app.clickText('저장');
  check('오프라인에서 개인 볼트에 호스트를 더한다', await app.waitText('offline-added'));
  check('올릴 변경 1개 표시', await app.waitText('올릴 변경 1개'));
  await app.shot('3-offline-added');
  // 팀 볼트로: 보기만
  await app.evaluate(`document.querySelector('.tab-chevron').click()`);
  await sleep(300);
  await app.clickText('Team', '.menu button');
  check('오프라인에서 팀 볼트도 보인다', await app.waitText('ops-bastion'));
  check('팀 볼트는 보기만 (안내 · 새 호스트 단추 없음)', (await app.waitText('팀 볼트는 보기만 됩니다')) && !(await app.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim().endsWith('새 호스트'))`)));
  await app.shot('4-offline-team');

  // 3) 서버를 다시 켜면 다시 연결되어 올린다
  await startServer();
  await app.clickText('다시 연결');
  check('다시 연결되면 오프라인 표시가 사라진다', await app.waitText(/^(?![\s\S]*오프라인:)/, 30000));
  check('올렸다는 알림', await app.waitText('서버에 올렸습니다', 20000));
  await app.shot('5-reconnected');
  const serverItems = (await http('GET', `/api/vaults/${pv.id}/items`, token)).body;
  check('오프라인에서 더한 호스트가 서버에 올라갔다 (개인 볼트 3개)', serverItems.length === 3, { n: serverItems.length });
  // 설정 → 오프라인·동기화
  await app.evaluate(`document.querySelector('.user-btn').click()`);
  await sleep(300);
  await app.clickText('설정', '.menu button');
  await sleep(300);
  await app.clickText('오프라인·동기화', '.settings-nav button');
  check('설정: 오프라인·동기화 화면', await app.waitText('개인 볼트를 서버와 동기화'));
  await app.shot('6-settings-offline');
  // 개인 동기화 끄기 → 서버 사본을 어떻게 할지 묻는다 (여기서는 취소)
  await app.evaluate(`document.querySelector('.settings-body [role=switch]').click()`);
  check('개인 동기화 끄기: 서버 사본 두기·지우기를 묻는다', (await app.waitText('개인 볼트 사본은 어떻게 할까요?')) && (await app.waitText('서버 사본도 지우기')));
  await app.shot('6b-sync-off-dialog');
  await app.clickText('취소', '.modal button');
  check('취소하면 켜진 그대로', await app.evaluate(`document.querySelector('.settings-body [role=switch]').getAttribute('aria-checked') === 'true'`));
  await app.clickText('Ops', '.settings-nav button');
  // 팀 볼트 오프라인 기간은 7일 고정 — 팀 설정에 고르는 칸이 없다
  check('팀 설정에 오프라인 기간 칸이 없다 (7일 고정)', (await app.waitText('팀 삭제')) && !(await app.text()).includes('오프라인 사용'));
  await app.evaluate(`document.querySelector('.settings-body').scrollTop = 99999`);
  await app.shot('7-team-offline');
  app.close();
  app = null;

  // 4) 사본이 없는 새 프로필 + 서버 꺼짐 → 임시 모드
  await stopServer();
  const profile2 = path.join(T, 'profile2');
  app2 = await launchApp(profile2);
  check('사본이 없으면 "서버에 연결할 수 없습니다" + 임시 모드 단추', (await app2.waitText('서버에 연결할 수 없습니다', 30000)) && (await app2.waitText('로컬 터미널·HTTP 요청만 사용하기')));
  await app2.shot('8-no-copy');
  await app2.clickText('로컬 터미널·HTTP 요청만 사용하기');
  check('임시 모드로 열린다', await app2.waitText('임시 모드'));
  await app2.shot('9-local-mode');
  check('임시 모드는 사본을 남기지 않는다', offlineFiles(profile2).length === 0);
} catch (err) {
  failures++;
  console.log('FAIL (예외)', err?.stack ?? err);
} finally {
  app?.close();
  app2?.close();
  await stopServer();
  await sleep(1000);
  console.log(`shots: ${OUT}`);
  if (!process.env.OUT) {
    try {
      fs.rmSync(path.join(T, 'profile'), { recursive: true, force: true });
      fs.rmSync(path.join(T, 'profile2'), { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    } catch {}
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
