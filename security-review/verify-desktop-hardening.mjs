// Windows 앱 보강 확인 (보안 점검 2026-09-29 의 앱 낮음 항목). 저장소 루트에서: node security-review/verify-desktop-hardening.mjs
//   1) 업데이트: 정식 채널은 서명이 맞아도 베타 버전을 받지·설치하지 않는다 (update-verify.js + 진짜 electron-updater)
//   2) main.js 판정 함수: 막는 실행 옵션 목록 · setup.html 판정 · 실행 파일 확장자
//   3) 개발용 앱(CDP): SFTP 로컬 창의 "열기"가 실행 파일이면 먼저 묻는다(취소/열기) · 가짜 setup.html 은 설정 기능을 못 쓴다
//   4) "설치된 앱처럼" 띄운 앱(electron.exe 이름을 바꾼 사본 — app.isPackaged 가 참): 막은 실행 옵션이면 바로 꺼진다 ·
//      STUDIO_SHELL_URL·SSLKEYLOGFILE 을 따르지 않는다(개발용 앱과 비교) · 서버를 고르지 않은 프로필은 setup.html 이 뜬다(캡처)
// 이 PC 안의 시험용 서버(127.0.0.1)와 버리는 프로필만 쓴다. 앱 설정(app-config.json)은 빈 것으로 바꿔 공식 서버·업데이트 주소에 닿지 않는다.
// 화면은 임시 폴더에 빌드한다(web/dist 는 건드리지 않는다). 창이 잠깐씩 뜬다. OUT=<폴더> 면 캡처를 남긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUi, checker, killTree, launchApp, root, sleep } from './ui-harness.mjs';

const c = checker();
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-desktop-hardening-'));
const OUT = process.env.OUT || path.join(T, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const desktopSrc = path.join(root, 'desktop', 'src');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// 이 PC 의 환경 변수 중 앱을 바꾸는 것은 빼고, 시험마다 넣을 것만 더한다
const baseEnv = (extra = {}) => {
  const env = { ...process.env, APPDATA: path.join(T, 'roaming'), LOCALAPPDATA: path.join(T, 'local') };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'STUDIO_SHELL_URL', 'SSLKEYLOGFILE', 'TERMINAS_UI', 'TERMINAS_UI_DIR', 'TERMINAS_PROFILE']) delete env[k];
  return { ...env, ...extra };
};
fs.mkdirSync(path.join(T, 'roaming'), { recursive: true });
fs.mkdirSync(path.join(T, 'local'), { recursive: true });
const runPs = (script) => execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// ---------- 시험용 서버: 받은 요청을 센다 ----------
async function fakeApi(tag) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/api/auth/config')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ google: true, password: false }));
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: tag }));
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { srv, hits, base: `http://127.0.0.1:${srv.address().port}` };
}

try {
  // ================= 1) 업데이트 채널 =================
  const U = await import(pathToFileURL(path.join(desktopSrc, 'update-verify.js')).href);
  const kp = crypto.generateKeyPairSync('ed25519');
  const der = kp.publicKey.export({ format: 'der', type: 'spki' });
  fs.writeFileSync(path.join(T, 'keys.json'), JSON.stringify({ keys: [{ publicKey: der.toString('base64') }] }));
  const keys = U.loadUpdateKeys(path.join(T, 'keys.json'));
  const exe = path.join(T, 'setup.exe');
  fs.writeFileSync(exe, crypto.randomBytes(4096));
  const sha = await U.sha512Of(exe);
  const info = (version) => ({ version, terminasSigKey: U.keyIdOf(der), terminasSig: crypto.sign(null, U.signedPayload(version, sha), kp.privateKey).toString('base64') });
  const stableBeta = await U.verifyUpdateFile({ file: exe, info: info('0.4.0-beta.1'), keys, currentVersion: '0.3.2' });
  const betaBeta = await U.verifyUpdateFile({ file: exe, info: info('0.4.0-beta.1'), keys, currentVersion: '0.3.2', allowPrerelease: true });
  const stableStable = await U.verifyUpdateFile({ file: exe, info: info('0.4.0'), keys, currentVersion: '0.3.2' });
  c.check('서명 확인: 정식 채널(기본)은 서명된 베타를 거절 · 베타 채널은 통과 · 정식 새 버전은 통과', /베타/.test(stableBeta ?? '') && betaBeta === null && stableStable === null, { stableBeta });
  c.check('서명하는 내용(형식)은 그대로 — 옛 앱도 새 릴리스를 확인한다', U.signedPayload('1.2.3', 'abc').toString('utf8') === 'terminas-update-v1\nstudio.yeonhong.terminas\n1.2.3\nabc\n');
  const fake = { isUpdateSupported: () => 'default' };
  let channel = 'stable';
  U.guardUpdater(fake, { keys, currentVersion: '0.3.2', allowPrerelease: () => channel === 'beta' });
  const onStable = [fake.isUpdateSupported({ version: '0.4.0-beta.1' }), fake.isUpdateSupported({ version: '0.4.0' })];
  channel = 'beta';
  const onBeta = fake.isUpdateSupported({ version: '0.4.0-beta.1' });
  c.check('업데이트 확인 단계: 정식 채널이면 베타는 "업데이트 없음"(받지 않음), 채널을 바꾸면 바로 따른다', onStable[0] === false && onStable[1] === 'default' && onBeta === 'default', { onStable, onBeta });
  const resultFile = path.join(T, 'updater-channel.txt');
  await new Promise((resolve) => {
    const child = spawn(path.join(electronDist, 'electron.exe'), [path.join(root, 'security-review', 'verify-updater-channel-electron.mjs')], { env: baseEnv({ RESULT_FILE: resultFile }), stdio: 'ignore' });
    const timer = setTimeout(() => killTree(child.pid), 120_000);
    child.on('exit', () => (clearTimeout(timer), resolve()));
  });
  const lines = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').split('\n').filter((l) => /^(PASS|FAIL) /.test(l)) : [];
  c.check(`진짜 electron-updater 로 (${lines.length}개): ${lines.map((l) => l.replace(/ \{.*$/, '')).join(' / ')}`, lines.length >= 5 && lines.every((l) => l.startsWith('PASS')), { lines: lines.filter((l) => l.startsWith('FAIL')) });

  // ================= 2) main.js 판정 함수 (소스에서 떼어 와 돌려 본다) =================
  const src = fs.readFileSync(path.join(desktopSrc, 'main.js'), 'utf8');
  const between = (from, to) => {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error(`main.js 에서 ${from} 을 찾지 못했습니다`);
    return src.slice(i, j);
  };
  const blocked = new Function(`${between('const BLOCKED_SWITCHES', 'if (app.isPackaged && BLOCKED_SWITCHES')} return BLOCKED_SWITCHES;`)();
  const need = ['remote-debugging-port', 'proxy-server', 'proxy-pac-url', 'host-rules', 'host-resolver-rules', 'ssl-key-log-file', 'auto-open-devtools-for-tabs', 'remote-allow-origins', 'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'disable-web-security', 'load-extension', 'inspect', 'inspect-brk'];
  c.check('막는 실행 옵션: 요구한 것 모두 · --user-data-dir 은 막지 않는다', need.every((s) => blocked.includes(s)) && !blocked.includes('user-data-dir'), { missing: need.filter((s) => !blocked.includes(s)) });
  c.check('STUDIO_SHELL_URL 은 개발 중에만 · SSLKEYLOGFILE 은 설치된 앱에서 지운다 (소스)', /\(!app\.isPackaged && process\.env\.STUDIO_SHELL_URL\)/.test(src) && /if \(app\.isPackaged\) delete process\.env\.SSLKEYLOGFILE/.test(src));
  const { isSetupPage, SETUP_FILE } = new Function('path', 'pathToFileURL', 'fileURLToPath', 'here', 'process', `${between('const SETUP_FILE', 'function isOurPage')} return { isSetupPage, SETUP_FILE };`)(path, pathToFileURL, fileURLToPath, desktopSrc, process);
  const real = pathToFileURL(SETUP_FILE).href;
  const drive = real.replace(/^file:\/\/\/([A-Z]):/, (m, d) => `file:///${d.toLowerCase()}:`);
  const setupCases = {
    [real]: true,
    [drive]: true,
    'file:///C:/Users/evil/Downloads/setup.html': false,
    [`file:///C:/x${real.slice('file://'.length)}`]: false,
    'file://attacker/share/desktop/src/setup.html': false,
    [`${real}?x=1`]: false,
    [`${real}#x`]: false,
    [real.replace('setup.html', 'setup.html.evil/setup.html')]: false,
    'app://terminas/setup.html': false,
    'https://evil.example/setup.html': false,
  };
  const setupBad = Object.entries(setupCases).filter(([u, want]) => isSetupPage(u) !== want);
  c.check('setup.html 판정: 앱 안의 바로 그 파일만 (다른 폴더·공유 폴더·?·# 는 아님, 드라이브 문자 대소문자는 같게)', setupBad.length === 0, { bad: setupBad });
  const riskyToOpen = new Function('path', 'process', `${between('const RISKY_EXT', 'async function openLocal')} return riskyToOpen;`)(path, process);
  const riskyCases = { 'a.exe': true, 'B.EXE': true, 'c.cmd': true, 'd.bat': true, 'e.ps1': true, 'f.lnk': true, 'g.url': true, 'h.vbs': true, 'i.js': true, 'j.hta': true, 'k.msi': true, 'l.docm': true, 'm.xlsm': true, 'n.jar': true, 'o.reg': true, 'p.scr': true, 'q.appref-ms': true, 'r.exe.': true, 's.exe  ': true, 't.txt:evil.exe': true, 'u.iso': true, 'v.txt': false, 'w.pdf': false, 'x.png': false, 'y.tar.gz': false, 'z.docx': false, noext: false, '.bashrc': false };
  const riskyBad = Object.entries(riskyCases).filter(([n, want]) => riskyToOpen(path.join('C:\\x', n)) !== want);
  c.check('열기 전에 물을 파일: 실행·스크립트·바로 가기·설치·매크로 문서 (끝의 점·공백·: 도) / 보통 파일은 아님', riskyBad.length === 0, { bad: riskyBad });

  // 화면 빌드 (임시 폴더) — 개발용 앱과 "설치된 앱처럼" 띄운 앱이 같이 쓴다
  const appDir = path.join(T, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const uiDir = buildUi(path.join(appDir, 'ui'));

  // ================= 3) 개발용 앱 (CDP) =================
  const api = await fakeApi('dev');
  const profile = path.join(T, 'profile-dev');
  const dev = await launchApp({ base: api.base, profile, out: OUT, uiDir });
  try {
    await dev.waitFor(`Boolean(window.studioDesktop?.fs)`);
    // 실행 파일 열기: 창이 떠 있는 동안 실행되지 않는다 → 취소하면 열리지 않는다 → 다시 열고 "열기"를 누르면 실행된다
    const work = path.join(T, 'open');
    fs.mkdirSync(work);
    const marker = path.join(work, 'ran.txt');
    const cmdFile = path.join(work, 'run-me.cmd');
    fs.writeFileSync(cmdFile, `@echo ran> "${marker}"\r\n`);
    // Electron 의 대화상자(TaskDialog)를 찾아 단추를 누른다: 단추 id = 100 + 순서 (열기=100, 취소=101), TDM_CLICK_BUTTON=0x466
    const dialogs = (click = -1) =>
      runPs(
        String.raw`
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<IntPtr> Find(uint[] pids) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(pids, p) >= 0 && IsWindowVisible(h)) { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == "#32770") r.Add(h); } return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$pids = [uint32[]]@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*PROFILE*' } | ForEach-Object { $_.ProcessId })
$found = [W]::Find($pids)
foreach ($h in $found) { $t = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText($h, $t, 256); "title=" + $t.ToString(); if (CLICK -ge 0) { [void][W]::PostMessage($h, 0x466, [IntPtr]CLICK, [IntPtr]::Zero) } }
"count=" + $found.Count
`
          .replace('PROFILE', path.basename(profile))
          .replaceAll('CLICK', String(click)),
      );
    const startOpen = (p) => dev.evaluate(`(window.__open = 'pending', window.studioDesktop.fs.open(${JSON.stringify(p)}).then(() => (window.__open = 'resolved'), (e) => (window.__open = 'error: ' + e.message)), 'started')`);
    await startOpen(cmdFile);
    await sleep(2500);
    const d1 = dialogs();
    const pending = await dev.evaluate('window.__open');
    c.check('실행 파일(.cmd) 열기: 확인 창이 뜨고, 답하기 전에는 실행되지 않는다', /count=1/.test(d1) && /title=Terminas/.test(d1) && pending === 'pending' && !fs.existsSync(marker), { d1: d1.trim(), pending });
    dialogs(101);
    await sleep(1500);
    const afterCancel = await dev.evaluate('window.__open');
    c.check('취소하면 열지 않고 오류 없이 끝난다', afterCancel === 'resolved' && !fs.existsSync(marker) && /count=0/.test(dialogs()), { afterCancel });
    await startOpen(cmdFile);
    await sleep(2500);
    dialogs(100);
    for (let i = 0; i < 20 && !fs.existsSync(marker); i++) await sleep(250);
    c.check('"열기"를 누르면 그때 연다', fs.existsSync(marker) && (await dev.evaluate('window.__open')) === 'resolved');

    // setup.html: 진짜 설정 화면은 설정 기능을 쓰고, 이름만 같은 다른 파일·? 붙은 주소는 못 쓴다
    await dev.evaluate('window.studioDesktop.changeServer()');
    const realOk = await dev.waitFor(`location.protocol === 'file:' && document.getElementById('sub')?.textContent.length > 0`);
    const realGet = await dev.evaluate(`window.studioSetup.get().then(() => 'ok', (e) => 'refused: ' + e.message)`);
    c.check('진짜 setup.html: 설정 기능(setup:get)을 쓴다', realOk && realGet === 'ok', { realGet, href: await dev.evaluate('location.href') });
    const evilDir = path.join(T, 'evil', 'desktop', 'src');
    fs.mkdirSync(evilDir, { recursive: true });
    fs.copyFileSync(path.join(desktopSrc, 'setup.html'), path.join(evilDir, 'setup.html'));
    const tryPage = async (url) => {
      await dev.send('Page.navigate', { url });
      await dev.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, 10000);
      const href = await dev.evaluate('location.href');
      const get = await dev.evaluate(`window.studioSetup.get().then(() => 'ok', (e) => 'refused: ' + e.message)`);
      const save = await dev.evaluate(`window.studioSetup.save('http://127.0.0.1:9').then(() => 'ok', (e) => 'refused: ' + e.message)`);
      return { href, get, save };
    };
    const evil = await tryPage(pathToFileURL(path.join(evilDir, 'setup.html')).href);
    const query = await tryPage(`${pathToFileURL(path.join(desktopSrc, 'setup.html')).href}?x=1`);
    c.check('다른 폴더의 setup.html · ? 붙은 주소는 설정 기능(get·save)을 못 쓴다', /^refused/.test(evil.get) && /^refused/.test(evil.save) && /^refused/.test(query.get) && /^refused/.test(query.save), { evil, query });
    const cfg = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    c.check('설정 파일의 서버 주소는 바뀌지 않았다', !cfg.serverUrl, { serverUrl: cfg.serverUrl });
  } finally {
    dev.close();
    api.srv.close();
    await sleep(1000);
  }

  // ================= 4) "설치된 앱처럼" (app.isPackaged = true) =================
  // 앱 폴더: desktop/src 사본 + package.json + 빈 app-config.json(공식 서버·업데이트 주소 없음) + 임시 화면 + node_modules 연결
  fs.cpSync(desktopSrc, path.join(appDir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'desktop', 'package.json'), path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(root, 'desktop', 'update-keys.json'), path.join(appDir, 'update-keys.json'));
  fs.writeFileSync(path.join(appDir, 'app-config.json'), '{}');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
  // Electron 사본: 파일은 하드 링크, electron.exe 만 Terminas.exe 로 (Electron 은 실행 파일 이름이 electron.exe 가 아니면 isPackaged)
  const exeDir = path.join(T, 'electron');
  const linkTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name === 'electron.exe' && from === electronDist ? 'Terminas.exe' : e.name);
      if (e.isDirectory()) linkTree(a, b);
      else {
        try {
          fs.linkSync(a, b);
        } catch {
          fs.copyFileSync(a, b);
        }
      }
    }
  };
  linkTree(electronDist, exeDir);
  const packagedExe = path.join(exeDir, 'Terminas.exe');
  const devExe = path.join(electronDist, 'electron.exe');

  async function launch(exeFile, args = [], { env = {}, config = null, ms = 8000, shot = null } = {}) {
    const udd = fs.mkdtempSync(path.join(T, 'udd-'));
    if (config) fs.writeFileSync(path.join(udd, 'config.json'), JSON.stringify(config));
    const child = spawn(exeFile, [appDir, `--user-data-dir=${udd}`, ...args], { env: baseEnv(env), stdio: 'ignore' });
    let exitCode = null;
    child.on('exit', (code) => (exitCode = code));
    const t0 = Date.now();
    while (Date.now() - t0 < ms && exitCode === null) await sleep(250);
    let shotInfo = null;
    if (shot && exitCode === null) {
      try {
        shotInfo = execFileSync(psExe, ['-NoProfile', '-File', path.join(root, 'security-review', 'window-shot.ps1'), '-ProcessId', String(child.pid), '-Out', shot], { encoding: 'utf8' }).trim();
      } catch (e) {
        shotInfo = `shot failed: ${String(e.stdout || e.message).trim()}`;
      }
    }
    const alive = exitCode === null;
    killTree(child.pid);
    await sleep(1200);
    return { alive, exitCode, seconds: ((Date.now() - t0) / 1000).toFixed(1), shotInfo };
  }

  // 서버 주소: 설정 파일(A) vs STUDIO_SHELL_URL(B)
  const A = await fakeApi('A');
  const B = await fakeApi('B');
  const pk = await launch(packagedExe, [], { env: { STUDIO_SHELL_URL: B.base }, config: { serverUrl: A.base } });
  const pkHits = { A: A.hits.length, B: B.hits.length };
  A.hits.length = 0;
  B.hits.length = 0;
  const dv = await launch(devExe, [], { env: { STUDIO_SHELL_URL: B.base, TERMINAS_UI: 'dist', TERMINAS_UI_DIR: uiDir }, config: { serverUrl: A.base } });
  const dvHits = { A: A.hits.length, B: B.hits.length };
  c.check('설치된 앱처럼: 보통 실행(--user-data-dir 포함)은 뜨고, STUDIO_SHELL_URL 은 무시하고 설정한 서버로 간다', pk.alive && pkHits.A > 0 && pkHits.B === 0, { pk, pkHits });
  c.check('(대조) 개발용 앱은 STUDIO_SHELL_URL 을 따른다', dv.alive && dvHits.B > 0 && dvHits.A === 0, { dvHits });
  A.srv.close();
  B.srv.close();

  // 막은 실행 옵션: 바로 꺼진다 (exit 1)
  const switches = [
    '--proxy-server=127.0.0.1:9',
    '--proxy-pac-url=http://127.0.0.1:9/p.pac',
    '--host-rules=MAP * 127.0.0.1',
    '--host-resolver-rules=MAP * 127.0.0.1',
    `--ssl-key-log-file=${path.join(T, 'switch-keys.log')}`,
    '--auto-open-devtools-for-tabs',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    '--ignore-certificate-errors-spki-list=AAAA',
    '--disable-web-security',
    `--load-extension=${T}`,
    '--inspect=0',
    '--no-sandbox',
    '--renderer-cmd-prefix=cmd /c',
    `--log-net-log=${path.join(T, 'net.json')}`,
    '--js-flags=--expose-gc',
  ];
  const exits = [];
  for (const s of switches) {
    const r = await launch(packagedExe, [s], { config: { serverUrl: 'http://127.0.0.1:9' }, ms: 8000 });
    exits.push([s.split('=')[0], r.exitCode, r.alive]);
  }
  c.check(`설치된 앱처럼: 막은 실행 옵션 ${switches.length}개는 모두 바로 꺼진다 (exit 1)`, exits.every(([, code, alive]) => code === 1 && !alive), { notBlocked: exits.filter(([, code, alive]) => code !== 1 || alive) });
  c.check('(키 기록 옵션으로 파일이 생기지 않았다)', !fs.existsSync(path.join(T, 'switch-keys.log')) && !fs.existsSync(path.join(T, 'net.json')));

  // SSLKEYLOGFILE: https 서버(자체 서명)에 붙을 때 TLS 키를 적는지 — 개발용 앱은 적고(대조), 설치된 앱처럼 띄운 앱은 적지 않는다
  const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || fs.existsSync(p));
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=terminas-test'], { stdio: 'ignore' });
  let handshakes = 0;
  const tls = https.createServer({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')) }, (req, res) => res.end('{}'));
  tls.on('connection', () => handshakes++);
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const tlsBase = `https://127.0.0.1:${tls.address().port}`;
  const devKeys = path.join(T, 'keys-dev.log');
  const pkKeys = path.join(T, 'keys-packaged.log');
  await launch(devExe, [], { env: { SSLKEYLOGFILE: devKeys, TERMINAS_UI: 'dist', TERMINAS_UI_DIR: uiDir }, config: { serverUrl: tlsBase } });
  const devHandshakes = handshakes;
  handshakes = 0;
  const pkTls = await launch(packagedExe, [], { env: { SSLKEYLOGFILE: pkKeys }, config: { serverUrl: tlsBase } });
  const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  c.check('(대조) 개발용 앱은 SSLKEYLOGFILE 에 TLS 키를 적는다 — 이 환경 변수가 실제로 먹힌다', devHandshakes > 0 && size(devKeys) > 0, { devHandshakes, bytes: size(devKeys) });
  c.check('설치된 앱처럼: SSLKEYLOGFILE 이 있어도 TLS 키를 적지 않는다', pkTls.alive && handshakes > 0 && size(pkKeys) === 0, { handshakes, bytes: size(pkKeys) });
  tls.close();

  // 서버를 고르지 않은 프로필: setup.html (설치된 앱의 경로로) — 캡처해서 글자가 채워졌는지(설정 기능이 됨) 눈으로 본다
  const setupShot = path.join(OUT, 'packaged-setup.png');
  const setup = await launch(packagedExe, [], { config: {}, ms: 7000, shot: setupShot });
  c.check(`설치된 앱처럼: 처음 켜면 서버 고르기 화면 (캡처: ${setupShot})`, setup.alive && /title=/.test(setup.shotInfo ?? ''), { shot: setup.shotInfo });
} catch (err) {
  c.check(`예외: ${err?.stack ?? err}`, false);
} finally {
  await sleep(500);
  console.log(`shots: ${OUT}`);
  // node_modules 는 저장소의 것을 가리키는 연결(junction) — 폴더를 통째로 지우기 전에 연결만 먼저 떼고, 떼어졌는지 확인한다
  const link = path.join(T, 'app', 'node_modules');
  let linkGone = true;
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch (e) {
    if (e.code !== 'ENOENT') console.log('junction unlink failed:', e.code);
  }
  try {
    fs.lstatSync(link);
    linkGone = false;
  } catch {}
  if (!linkGone) console.log('node_modules 연결을 떼지 못해 임시 폴더를 남깁니다:', T);
  else if (!process.env.OUT) {
    try {
      fs.rmSync(T, { recursive: true, force: true });
    } catch (e) {
      console.log('cleanup later:', T, e.code);
    }
  }
}
console.log(c.failures ? `\n${c.failures} FAILED` : '\nALL PASS');
process.exit(c.failures ? 1 : 0);
