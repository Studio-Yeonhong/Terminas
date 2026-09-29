// 빌드된 앱(win-unpacked)을 버리는 프로필로 실제로 띄워, 막은 문들이 닫혔는지 본다. 창이 잠깐씩 뜬다.
// 저장소 루트에서, 빌드한 뒤: node security-review/verify-app-hardening.mjs
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(HERE, '..', 'desktop', 'release', 'win-unpacked');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-packaged-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(extra)}`);
};
const baseEnv = () => {
  const env = { ...process.env, APPDATA: path.join(T, 'roaming'), LOCALAPPDATA: path.join(T, 'local') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
};
fs.mkdirSync(path.join(T, 'roaming'), { recursive: true });
fs.mkdirSync(path.join(T, 'local'), { recursive: true });
const listening = (port) => execSync('netstat -ano', { encoding: 'utf8' }).split('\n').some((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
const killTree = (pid) => {
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
  } catch {}
};

async function launch(exe, args = [], env = baseEnv(), { watchPort, ms = 8000, shot } = {}) {
  // 따로 된 프로필 (APPDATA 는 Electron 이 안 따른다 — 사용자가 켜 둔 Terminas 와 겹치지 않게)
  const udd = fs.mkdtempSync(path.join(T, 'udd-'));
  // 서버를 이미 고른 프로필로 — 처음 켜는 프로필은 서버 고르기(setup.html)부터 떠서 앱 화면(app.asar/ui)을 읽지 않는다.
  // 닿지 않는 주소라 어디에도 접속하지 않는다(화면은 "서버에 연결할 수 없습니다" 가 된다)
  fs.writeFileSync(path.join(udd, 'config.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9' }));
  const child = spawn(exe, [...args, `--user-data-dir=${udd}`], { env, stdio: 'ignore' });
  let exitCode = null;
  child.on('exit', (c) => (exitCode = c));
  let portSeen = false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms && exitCode === null) {
    if (watchPort && listening(watchPort)) portSeen = true;
    await sleep(250);
  }
  let shotInfo = null;
  if (shot && exitCode === null) {
    try {
      shotInfo = execFileSync('powershell', ['-NoProfile', '-File', path.join(HERE, 'window-shot.ps1'), '-ProcessId', String(child.pid), '-Out', shot], { encoding: 'utf8' }).trim();
    } catch (e) {
      shotInfo = 'shot failed: ' + String(e.stdout || e.message).trim();
    }
  }
  const alive = exitCode === null;
  killTree(child.pid);
  await sleep(1500);
  return { alive, exitCode, portSeen, seconds: ((Date.now() - t0) / 1000).toFixed(1), shotInfo };
}

try {
  const exe = path.join(built, 'Terminas.exe');
  const normal = await launch(exe, [], baseEnv(), { ms: 9000, shot: path.join(T, 'normal.png') });
  check('보통 실행: 앱이 뜨고 화면이 그려진다', normal.alive && /title=/.test(normal.shotInfo ?? ''), normal);

  const rdp = await launch(exe, ['--remote-debugging-port=9337'], baseEnv(), { watchPort: 9337, ms: 6000 });
  check('--remote-debugging-port 로 띄우면 바로 꺼지고 포트가 안 열린다', !rdp.alive && rdp.exitCode === 1 && !rdp.portSeen, rdp);

  const cert = await launch(exe, ['--ignore-certificate-errors'], baseEnv(), { ms: 5000 });
  check('--ignore-certificate-errors 로 띄우면 바로 꺼진다', !cert.alive && cert.exitCode === 1, cert);

  const inspect = await launch(exe, ['--inspect=9338'], baseEnv(), { watchPort: 9338, ms: 7000 });
  check('--inspect 는 무시된다(디버그 포트 없음)', !inspect.portSeen, inspect);

  const probe1 = path.join(T, 'probe-nodeoptions.txt');
  fs.writeFileSync(path.join(T, 'probe1.cjs'), `require('fs').writeFileSync(${JSON.stringify(probe1)}, 'ran')`);
  const nodeOpts = await launch(exe, [], { ...baseEnv(), NODE_OPTIONS: `--require ${path.join(T, 'probe1.cjs')}` }, { ms: 7000 });
  check('NODE_OPTIONS 로 코드를 끼워 넣을 수 없다', !fs.existsSync(probe1), { ...nodeOpts, probeRan: fs.existsSync(probe1) });

  const probe2 = path.join(T, 'probe-runasnode.txt');
  fs.writeFileSync(path.join(T, 'probe2.cjs'), `require('fs').writeFileSync(${JSON.stringify(probe2)}, 'ran')`);
  const runAsNode = await launch(exe, [path.join(T, 'probe2.cjs')], { ...baseEnv(), ELECTRON_RUN_AS_NODE: '1' }, { ms: 6000 });
  check('ELECTRON_RUN_AS_NODE 로 스크립트를 돌릴 수 없다', !fs.existsSync(probe2), { ...runAsNode, probeRan: fs.existsSync(probe2) });

  // 변조: 사본을 만들어 app.asar 안 화면 파일(index.html) 내용 한 바이트를 바꾼다
  const copy = path.join(T, 'tampered');
  fs.cpSync(built, copy, { recursive: true });
  const asarFile = path.join(copy, 'resources', 'app.asar');
  const buf = fs.readFileSync(asarFile);
  const at = buf.indexOf(Buffer.from('<div id="root">'));
  const headerSize = buf.readUInt32LE(12);
  const ok = at > 16 + headerSize;
  buf[at + 5] = buf[at + 5] === 0x78 ? 0x79 : 0x78; // id="root" → 한 글자 바꿈
  fs.writeFileSync(asarFile, buf);
  const tampered = await launch(path.join(copy, 'Terminas.exe'), [], baseEnv(), { ms: 9000, shot: path.join(T, 'tampered.png') });
  check('app.asar 안 화면 파일을 고치면 실행되지 않는다', ok && (!tampered.alive || !/title=/.test(tampered.shotInfo ?? '')), { contentOffsetBeyondHeader: ok, ...tampered });

  // 변조 2: asar 밖에 app 폴더를 두고 asar 를 치워도 그 폴더를 읽지 않는다
  const copy2 = path.join(T, 'folder-app');
  fs.cpSync(built, copy2, { recursive: true });
  fs.renameSync(path.join(copy2, 'resources', 'app.asar'), path.join(copy2, 'resources', 'app.asar.bak'));
  fs.mkdirSync(path.join(copy2, 'resources', 'app'));
  const probe3 = path.join(T, 'probe-folder.txt');
  fs.writeFileSync(path.join(copy2, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'x', main: 'main.js' }));
  fs.writeFileSync(path.join(copy2, 'resources', 'app', 'main.js'), `require('fs').writeFileSync(${JSON.stringify(probe3)}, 'ran'); require('electron').app.quit();`);
  const folder = await launch(path.join(copy2, 'Terminas.exe'), [], baseEnv(), { ms: 6000 });
  check('asar 대신 넣은 app 폴더의 코드는 실행되지 않는다', !fs.existsSync(probe3), { ...folder, probeRan: fs.existsSync(probe3) });
} finally {
  await sleep(1000);
  try {
    fs.rmSync(T, { recursive: true, force: true });
  } catch (e) {
    console.log('cleanup later:', T, e.code);
  }
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
