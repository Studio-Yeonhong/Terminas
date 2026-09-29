// 진짜 Electron 안에서 진짜 electron-updater(NsisUpdater)로 받아 보며, 앱의 서명 확인(guardUpdater)이 끼는지 본다.
// 설치는 하지 않는다(가짜 설치 파일, onQuit 없음). 버리는 키만 쓴다.
// 저장소 루트에서: RESULT_FILE=<결과 파일> node_modules/electron/dist/electron.exe security-review/verify-updater-electron.mjs
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
const { guardUpdater, clearPendingUpdates, loadUpdateKeys, signedPayload, keyIdOf } = await import(pathToFileURL(root + '/desktop/src/update-verify.js').href);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-updater-e2e-'));
const results = [];
let failures = 0;
const progress = (m) => fs.appendFileSync(process.env.RESULT_FILE + '.progress', `${new Date().toISOString()} ${m}
`);
progress('started');
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  progress(results.at(-1));
};

const mine = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const derOf = (k) => k.publicKey.export({ format: 'der', type: 'spki' });
const keysFile = path.join(T, 'update-keys.json');
fs.writeFileSync(keysFile, JSON.stringify({ keys: [{ publicKey: derOf(mine).toString('base64') }] }));
const keys = loadUpdateKeys(keysFile);

// 피드 한 벌: /<case>/latest.yml + 설치 파일
const server = http.createServer((req, res) => {
  const file = path.join(T, 'feeds', decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(path.join(T, 'feeds')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function feed(name, { version, exeBytes, signVersion = version, signBytes = exeBytes, key = mine, signed = true }) {
  const dir = path.join(T, 'feeds', name);
  fs.mkdirSync(dir, { recursive: true });
  const exe = `Terminas-Setup-${version}.exe`;
  fs.writeFileSync(path.join(dir, exe), exeBytes);
  const sha = crypto.createHash('sha512').update(exeBytes).digest('base64');
  const signSha = crypto.createHash('sha512').update(signBytes).digest('base64');
  let yml = `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha}\n    size: ${exeBytes.length}\npath: ${exe}\nsha512: ${sha}\nreleaseDate: '2026-09-27T00:00:00.000Z'\n`;
  if (signed) yml += `terminasSigKey: ${keyIdOf(derOf(key))}\nterminasSig: ${crypto.sign(null, signedPayload(signVersion, signSha), key.privateKey).toString('base64')}\n`;
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
    return '0.2.4';
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

async function attempt(name, url) {
  const adapter = new Adapter(name);
  const u = new NsisUpdater(null, adapter);
  // 실제 앱(기본 어댑터)과 같은 Electron net 기반 HTTP 를 쓴다
  u.httpExecutor = new ElectronHttpExecutor((authInfo, cb) => u.emit('login', authInfo, cb));
  u.setFeedURL({ provider: 'generic', url });
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const log = [];
  u.logger = { info: (m) => progress('info ' + m), warn: (m) => progress('warn ' + m), error: (m) => progress('error ' + m), debug() {} };
  guardUpdater(u, { keys, currentVersion: adapter.version, log: (m) => log.push(m) });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), 20_000);
    u.once('update-downloaded', (info) => (clearTimeout(timer), resolve({ kind: 'downloaded', file: info.downloadedFile })));
    u.once('update-not-available', () => (clearTimeout(timer), resolve({ kind: 'none' })));
    u.once('error', (err) => (clearTimeout(timer), resolve({ kind: 'error', code: err.code, message: String(err.message).split('\n')[0] })));
    u.checkForUpdates().catch(() => {});
  });
  return { ...outcome, log, adapter };
}

// ESM 진입 파일 최상단에서 ready 를 await 하면 Electron 이 멈춘다 → then 으로
app.whenReady().then(async () => {
progress('ready');
try {
  const genuine = crypto.randomBytes(2 * 1024 * 1024);
  const evil = crypto.randomBytes(2 * 1024 * 1024);

  const good = await attempt('good', feed('good', { version: '0.2.5', exeBytes: genuine }));
  check('서명 맞는 새 버전은 받는다', good.kind === 'downloaded' && good.log.includes('update signature ok'), JSON.stringify({ kind: good.kind, log: good.log }));

  const swapped = await attempt('swapped', feed('swapped', { version: '0.2.5', exeBytes: evil, signBytes: genuine }));
  check('설치 파일을 바꿔치기하면(서버가 sha512 까지 맞춰도) 거절', swapped.kind === 'error' && swapped.code === 'ERR_UPDATER_INVALID_SIGNATURE', JSON.stringify({ kind: swapped.kind, code: swapped.code, log: swapped.log }));

  const unsigned = await attempt('unsigned', feed('unsigned', { version: '0.2.5', exeBytes: genuine, signed: false }));
  check('서명 없는 업데이트는 거절', unsigned.kind === 'error' && unsigned.code === 'ERR_UPDATER_INVALID_SIGNATURE', JSON.stringify({ kind: unsigned.kind, log: unsigned.log }));

  const foreign = await attempt('foreign', feed('foreign', { version: '0.2.5', exeBytes: evil, key: other }));
  check('다른 키로 서명한 업데이트는 거절', foreign.kind === 'error' && foreign.code === 'ERR_UPDATER_INVALID_SIGNATURE', JSON.stringify({ kind: foreign.kind, log: foreign.log }));

  const bumped = await attempt('bumped', feed('bumped', { version: '0.2.9', exeBytes: genuine, signVersion: '0.2.5' }));
  check('버전 표시만 올린 업데이트는 거절', bumped.kind === 'error' && bumped.code === 'ERR_UPDATER_INVALID_SIGNATURE', JSON.stringify({ kind: bumped.kind, log: bumped.log }));

  // 켤 때 받아 둔 파일(캐시)을 비우는지
  const pending = path.join(good.adapter.baseCachePath, 'terminas-desktop-updater', 'pending');
  const hadPending = fs.existsSync(pending) && fs.readdirSync(pending).length > 0;
  clearPendingUpdates(path.join(good.adapter.dir, 'resources'), good.adapter.baseCachePath);
  check('켤 때 받아 둔 업데이트 캐시를 비운다', hadPending && !fs.existsSync(pending), `hadPending=${hadPending}`);
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
