// 화면 시험 공용 도구: 격리된 임시 서버(개발 로그인), 화면의 볼트 층을 Node 로 불러 준비 데이터 넣기(E2EE 라 서버에 바로 못 넣는다),
// 개발용 앱(Electron, 빌드한 화면 web/dist)을 버리는 프로필로 띄워 CDP 로 조작하기. 운영 DB·자격증명·실제 호스트는 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// web/src 의 확장자 없는 상대 경로(./api)를 .ts 로 찾고, 부모의 ?dev=… 를 이어 붙여 준비용 모듈을 따로 둔다
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
export function killTree(pid) {
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
  } catch {}
}
export function checker() {
  const c = {
    failures: 0,
    check(name, ok, evidence = {}) {
      if (!ok) c.failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
    },
  };
  return c;
}

// ---------- 임시 서버 (끄고 다시 켤 수 있게) ----------
export async function tempServer(data, extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child = null;
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
    ...extraEnv,
  };
  delete env.SHELL_TOTP_KEY;
  const s = {
    base,
    async start() {
      child = spawn(process.execPath, ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (b) => (err += b));
      for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error(err);
        try {
          if ((await fetch(`${base}/api/auth/config`)).ok) return;
        } catch {}
        await sleep(50);
      }
      throw new Error('server did not start');
    },
    async stop() {
      if (!child) return;
      killTree(child.pid);
      child = null;
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(`${base}/api/auth/config`);
        } catch {
          return;
        }
        await sleep(100);
      }
    },
    async http(method, p, token, body) {
      const res = await fetch(base + p, { method, headers: { 'x-shell': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
  return s;
}

// ---------- 준비 데이터: 화면의 볼트 층(web/src/vault.ts)을 Node 로 ----------
// 계정(암호화 비밀번호 password)을 만들고 볼트 층을 연 채로 돌려준다 — 호출한 쪽이 V.vaultApi 로 항목을 만든다
export async function seedAccount(server, email, password) {
  const token = (await server.http('POST', '/api/auth/dev-login-token', null, { email })).body.token;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = {
    studioDesktop: {
      version: 'seed',
      platform: process.platform,
      api: async (method, p, body) => {
        const r = await server.http(method, p, token, body);
        return { status: r.status, data: r.body };
      },
    },
  };
  const src = (f) => `${pathToFileURL(path.join(root, 'web/src', f)).href}?dev=seed-${email}`;
  const E = await import(pathToFileURL(path.join(root, 'web/src/e2ee.ts')).href);
  const V = await import(src('vault.ts'));
  const { api } = await import(src('api.ts'));
  let me = await api.get('/api/me');
  const r = await E.createAccount(me.user.id, password);
  await api.post('/api/me/keys', { publicKey: r.publicKey, bundle: r.bundle, proof: r.proof });
  me = await api.get('/api/me');
  V.setAccount(r.account, { id: me.user.id, name: email });
  V.setVaults(me.vaults, me.teams);
  await V.initMissingKeys(me.vaults);
  me = await api.get('/api/me');
  V.setVaults(me.vaults, me.teams);
  const pv = me.vaults.find((v) => v.kind === 'personal');
  await V.loadVault(pv);
  // 새 팀·볼트를 만든 뒤 다시 읽을 때
  const refresh = async () => {
    me = await api.get('/api/me');
    V.setVaults(me.vaults, me.teams);
    await V.initMissingKeys(me.vaults);
    me = await api.get('/api/me');
    V.setVaults(me.vaults, me.teams);
    return me;
  };
  return { token, V, E, api, pv, account: r.account, me: () => me, refresh };
}

// ---------- 앱 (개발용 Electron + CDP) ----------
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

// 시험용 화면 빌드: 운영 서버가 쓰는 web/dist 가 아니라 따로 된 폴더에 (web/dist 를 바꾸면 운영 웹 화면이 재시작 전까지 깨진다)
export function buildUi(outDir) {
  const vite = path.join(path.dirname(createRequire(path.join(root, 'web', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  execSync(`"${process.execPath}" "${vite}" build --outDir "${outDir}" --emptyOutDir --logLevel error`, { cwd: path.join(root, 'web'), stdio: 'inherit' });
  return outDir;
}

export async function launchApp({ base, profile, out, uiDir }) {
  const cdpPort = await freePort();
  const env = { ...process.env, TERMINAS_UI: 'dist', STUDIO_SHELL_URL: base, ...(uiDir ? { TERMINAS_UI_DIR: uiDir } : {}) };
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result?.result?.value;
  };
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
  const waitFor = async (expression, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(200);
    }
    return false;
  };
  // 글자가 꼭 같은 것 → 그 글자로 끝나는 것 순서로 찾아 누른다 (svg 등 innerText 없는 요소는 건너뛴다)
  const clickText = (label, selector = 'button') =>
    evaluate(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => [el, (el.innerText ?? '').trim()]); const hit = all.find(([, x]) => x === ${JSON.stringify(label)}) ?? all.find(([, x]) => x.endsWith(${JSON.stringify(label)})); const b = hit?.[0]; if (!b) return false; b.click(); return true; })()`,
    );
  const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  // React 입력칸에 값 넣기 (input·textarea)
  const fill = (selector, value) =>
    evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    );
  const key = (selector, keyName, opts = {}) =>
    evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}) ?? document.activeElement; el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(keyName)}, bubbles: true, ctrlKey: ${Boolean(opts.ctrl)}, shiftKey: ${Boolean(opts.shift)} })); return true; })()`,
    );
  const shot = async (name) => {
    if (!out) return;
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const reload = () => evaluate('location.reload()');
  const close = () => {
    try {
      ws.close();
    } catch {}
    killTree(child.pid);
  };
  // 개발 로그인 → 잠금 해제까지 (볼트 화면이 뜨면 true)
  const signIn = async (email, password, expectText) => {
    await waitText(/로그인|Google/);
    await evaluate(`window.studioDesktop.devLogin(${JSON.stringify(email)})`);
    await reload();
    if (!(await waitText('잠금 해제'))) return false;
    await fill('input[type=password]', password);
    await evaluate(`document.querySelector('form.lock-form').requestSubmit()`);
    return waitText(expectText, 30000);
  };
  return { send, evaluate, text, waitText, waitFor, clickText, click, fill, key, shot, reload, close, signIn, profile };
}
