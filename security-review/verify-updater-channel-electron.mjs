// 업데이트 채널 확인 (보안 점검 2026-09-29, 업데이트 낮음 항목): 진짜 Electron 안에서 진짜 electron-updater(NsisUpdater)로,
// 정식 채널 앱은 서명이 맞는 베타 버전(- 가 붙은 버전)을 받지도 설치하지도 않고, 베타 채널에 들어가면 받는지 본다.
// 설치는 하지 않는다(가짜 설치 파일, onQuit 없음). 버리는 키만 쓴다. 127.0.0.1 시험용 피드만.
// 저장소 루트에서: RESULT_FILE=<결과 파일> node_modules/electron/dist/electron.exe security-review/verify-updater-channel-electron.mjs
// (보통은 security-review/verify-desktop-hardening.mjs 가 띄운다)
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/package.json');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { guardUpdater, loadUpdateKeys, signedPayload, keyIdOf } = await import(pathToFileURL(root + '/desktop/src/update-verify.js').href);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-updater-channel-'));
const results = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
};

const mine = crypto.generateKeyPairSync('ed25519');
const derOf = (k) => k.publicKey.export({ format: 'der', type: 'spki' });
const keysFile = path.join(T, 'update-keys.json');
fs.writeFileSync(keysFile, JSON.stringify({ keys: [{ publicKey: derOf(mine).toString('base64') }] }));
const keys = loadUpdateKeys(keysFile);

const served = []; // 받아 간 설치 파일
const server = http.createServer((req, res) => {
  const file = path.join(T, 'feeds', decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(path.join(T, 'feeds')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  if (file.endsWith('.exe')) served.push(req.url);
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 제대로 서명한 피드 (지금 형식 그대로: terminas-update-v1 · 앱 ID · 버전 · sha512)
function feed(name, version, exeBytes) {
  const dir = path.join(T, 'feeds', name);
  fs.mkdirSync(dir, { recursive: true });
  const exe = `Terminas-Setup-${version}.exe`;
  fs.writeFileSync(path.join(dir, exe), exeBytes);
  const sha = crypto.createHash('sha512').update(exeBytes).digest('base64');
  let yml = `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha}\n    size: ${exeBytes.length}\npath: ${exe}\nsha512: ${sha}\nreleaseDate: '2026-09-29T00:00:00.000Z'\n`;
  yml += `terminasSigKey: ${keyIdOf(derOf(mine))}\nterminasSig: ${crypto.sign(null, signedPayload(version, sha), mine.privateKey).toString('base64')}\n`;
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml);
  return `${base}/${name}`;
}

class Adapter {
  constructor(name) {
    this.dir = path.join(T, 'apps', name);
    fs.mkdirSync(path.join(this.dir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'resources', 'app-update.yml'), 'provider: generic\nurl: http://127.0.0.1/\nupdaterCacheDirName: terminas-desktop-updater\n');
  }
  whenReady() {
    return app.whenReady();
  }
  get version() {
    return '0.3.2';
  }
  get name() {
    return 'terminas-desktop';
  }
  get isPackaged() {
    return true;
  }
  get appUpdateConfigPath() {
    return path.join(this.dir, 'resources', 'app-update.yml');
  }
  get userDataPath() {
    return path.join(this.dir, 'userData');
  }
  get baseCachePath() {
    return path.join(this.dir, 'cache');
  }
  quit() {}
  relaunch() {}
  onQuit() {}
}

// main.js 의 setupUpdater 와 같게: 자동 다운로드 · 웹 설치 프로그램 끔 · 채널을 묻는 함수로 guardUpdater
async function attempt(name, url, channel) {
  const adapter = new Adapter(name);
  const u = new NsisUpdater(null, adapter);
  u.httpExecutor = new ElectronHttpExecutor((authInfo, cb) => u.emit('login', authInfo, cb));
  u.setFeedURL({ provider: 'generic', url });
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.disableWebInstaller = true;
  u.allowPrerelease = channel.value === 'beta';
  u.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const log = [];
  guardUpdater(u, { keys, currentVersion: adapter.version, allowPrerelease: () => channel.value === 'beta', log: (m) => log.push(m) });
  const events = [];
  u.on('update-available', (info) => events.push(`available ${info.version}`));
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), 20_000);
    u.once('update-downloaded', (info) => (clearTimeout(timer), resolve({ kind: 'downloaded', version: info.version })));
    u.once('update-not-available', () => (clearTimeout(timer), resolve({ kind: 'none' })));
    u.once('error', (err) => (clearTimeout(timer), resolve({ kind: 'error', code: err.code, message: String(err.message).split('\n')[0] })));
    u.checkForUpdates().catch(() => {});
  });
  return { ...outcome, log, events, u };
}

app.whenReady().then(async () => {
  try {
    const bytes = crypto.randomBytes(1024 * 1024);
    const betaFeed = feed('beta', '0.4.0-beta.1', bytes);

    served.length = 0;
    const stable = await attempt('stable', betaFeed, { value: 'stable' });
    check('정식 채널: 서명이 맞는 베타 버전도 "업데이트 없음" — 설치 파일을 받지도 않는다', stable.kind === 'none' && served.length === 0 && stable.events.length === 0 && stable.log.some((m) => /prerelease/.test(m)), JSON.stringify({ kind: stable.kind, served, log: stable.log }));

    served.length = 0;
    const beta = await attempt('beta', betaFeed, { value: 'beta' });
    check('베타 채널: 같은 베타 버전을 받고 서명 확인을 통과한다', beta.kind === 'downloaded' && served.length === 1 && beta.log.includes('update signature ok'), JSON.stringify({ kind: beta.kind, log: beta.log }));

    // 받는 사이에 정식으로 돌아간 경우: 확인(isUpdateSupported)은 지나갔어도 서명 확인에서 막힌다
    const switched = await (async () => {
      const adapter = new Adapter('switch2');
      const u = new NsisUpdater(null, adapter);
      u.httpExecutor = new ElectronHttpExecutor((authInfo, cb) => u.emit('login', authInfo, cb));
      u.setFeedURL({ provider: 'generic', url: betaFeed });
      u.autoDownload = true;
      u.autoInstallOnAppQuit = false;
      u.logger = { info() {}, warn() {}, error() {}, debug() {} };
      const ch = { value: 'beta' };
      const log = [];
      guardUpdater(u, { keys, currentVersion: adapter.version, allowPrerelease: () => ch.value === 'beta', log: (m) => log.push(m) });
      u.on('update-available', () => (ch.value = 'stable'));
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timeout', log }), 20_000);
        u.once('update-downloaded', () => (clearTimeout(timer), resolve({ kind: 'downloaded', log })));
        u.once('error', (err) => (clearTimeout(timer), resolve({ kind: 'error', code: err.code, log })));
        u.checkForUpdates().catch(() => {});
      });
    })();
    check('받는 도중 정식 채널로 바꾸면 서명 확인 단계에서 거절', switched.kind === 'error' && switched.code === 'ERR_UPDATER_INVALID_SIGNATURE' && switched.log.some((m) => /베타/.test(m)), JSON.stringify(switched));

    served.length = 0;
    const normal = await attempt('stable-normal', feed('stable-normal', '0.4.0', bytes), { value: 'stable' });
    check('정식 채널: 서명이 맞는 정식 새 버전은 전처럼 받는다', normal.kind === 'downloaded' && normal.log.includes('update signature ok'), JSON.stringify({ kind: normal.kind, log: normal.log }));
    check('웹 설치 프로그램 끔 (disableWebInstaller)', normal.u.disableWebInstaller === true);
  } catch (err) {
    failures++;
    results.push(`FAIL exception ${err.stack}`);
  } finally {
    server.close();
    fs.rmSync(T, { recursive: true, force: true });
    fs.writeFileSync(process.env.RESULT_FILE, results.join('\n') + `\n${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
    app.exit(failures ? 1 : 0);
  }
});
