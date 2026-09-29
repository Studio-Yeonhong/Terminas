// update-key.mjs init/sign 를 진짜 터미널(의사 터미널)로 돌려 본다. 버리는 키·가짜 빌드만 쓴다.
// 저장소 루트에서: node security-review/verify-update-signing.mjs   (desktop/update-keys.json 은 끝나면 되돌린다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/package.json');
const pty = require('@lydell/node-pty');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const { verifyUpdateFile, loadUpdateKeys } = await import(pathToFileURL(root + '/desktop/src/update-verify.js').href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-f03-'));
// sign 의 기본 게시 폴더는 운영 업데이트 폴더(data-prod/updates)다. 시험은 어떤 경우에도 그곳에 쓰면 안 된다
// (2026-09-29: --to 를 빠뜨린 줄이 가짜 0.2.8 을 운영에 올렸다) → 기본값을 임시 폴더로 돌리고, 끝에 운영 폴더가 그대로인지 본다.
const SAFE_DEFAULT = path.join(tmp, 'default-updates');
const prodUpdates = path.join(root, 'data-prod', 'updates');
const listing = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .sort()
        .map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}:${fs.statSync(path.join(dir, f)).mtimeMs}`)
        .join('|')
    : '';
const prodBefore = listing(prodUpdates);
const keysFile = root + '/desktop/update-keys.json';
const keysBackup = fs.readFileSync(keysFile);
const PASS = 'throwaway-test-passphrase-42';
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
};
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function run(args, answers, env = {}) {
  return new Promise((resolve) => {
    const p = pty.spawn(process.execPath, ['desktop/scripts/update-key.mjs', ...args], { cwd: root, env: { ...process.env, TERMINAS_UPDATES_DIR: SAFE_DEFAULT, ...env }, cols: 200, rows: 50 });
    let out = '';
    let answered = 0;
    p.onData((d) => {
      out += d;
      const prompts = (strip(out).match(/(비밀번호|한 번 더): /g) ?? []).length;
      while (answered < prompts && answered < answers.length) p.write(answers[answered++] + '\r');
    });
    const timer = setTimeout(() => p.kill(), 60_000);
    p.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ code: exitCode, out: strip(out) });
    });
  });
}

// 가짜 빌드는 지금 desktop/package.json 버전으로 (sign 이 둘이 같은지 확인한다)
const VERSION = JSON.parse(fs.readFileSync(root + '/desktop/package.json', 'utf8')).version;

function fakeRelease(dir, keysJson, version = VERSION) {
  fs.mkdirSync(path.join(dir, 'win-unpacked', 'resources'), { recursive: true });
  const exe = `Terminas-Setup-${version}.exe`;
  const bytes = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(dir, exe), bytes);
  fs.writeFileSync(path.join(dir, `${exe}.blockmap`), crypto.randomBytes(1024));
  const sha = crypto.createHash('sha512').update(bytes).digest('base64');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha}\n    size: ${bytes.length}\npath: ${exe}\nsha512: ${sha}\nreleaseDate: '2026-09-27T00:00:00.000Z'\n`);
  const appDir = path.join(dir, 'app-src');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"fake"}');
  fs.writeFileSync(path.join(appDir, 'update-keys.json'), keysJson);
  return asar.createPackage(appDir, path.join(dir, 'win-unpacked', 'resources', 'app.asar'));
}

try {
  // 저장소의 진짜 공개키 목록은 잠시 비우고 시험한다 (끝나면 되돌린다)
  const b = JSON.parse(keysBackup.toString('utf8'));
  fs.writeFileSync(keysFile, JSON.stringify({ ...b, keys: [] }, null, 2) + '\n');
  const key = path.join(tmp, 'key.json');
  const init = await run(['init', '--key', key], [PASS, PASS]);
  const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8')).keys;
  check('init: 키 파일·공개키 생성', init.code === 0 && fs.existsSync(key) && keys.length === 1, `code=${init.code}`);
  check('init: 비밀번호가 화면에 안 나온다', !init.out.includes(PASS));
  const locked = JSON.parse(fs.readFileSync(key, 'utf8'));
  check('init: 키 파일에 비밀키 평문이 없다', !('privateKey' in locked) && locked.kdf.alg === 'scrypt' && locked.data.length > 40);
  const again = await run(['init', '--key', key], [PASS, PASS]);
  check('init: 있는 키는 덮어쓰지 않는다', again.code !== 0 && again.out.includes('이미 서명 키가 있습니다'));
  const mismatch = await run(['init', '--key', path.join(tmp, 'k2.json')], [PASS, PASS + 'x']);
  check('init: 두 번 입력이 다르면 멈춘다', mismatch.code !== 0 && mismatch.out.includes('다릅니다') && !fs.existsSync(path.join(tmp, 'k2.json')));
  const short = await run(['init', '--key', path.join(tmp, 'k3.json')], ['short', 'short']);
  check('init: 짧은 비밀번호 거절', short.code !== 0 && short.out.includes('자 이상'));

  const rel = path.join(tmp, 'release');
  await fakeRelease(rel, fs.readFileSync(keysFile, 'utf8'));
  const updates = path.join(tmp, 'updates');
  // 베타 버전(1.0.0-beta.1 처럼)은 베타 채널 폴더(<updates>/beta)에만 올라간다 (publish.mjs publishTargets)
  const pub = VERSION.includes('-') ? path.join(updates, 'beta') : updates;
  const env = { TERMINAS_RELEASE_DIR: rel };
  const wrong = await run(['sign', '--key', key, '--to', updates], ['wrong-passphrase-xyz'], env);
  check('sign: 틀린 비밀번호면 올리지 않는다', wrong.code !== 0 && wrong.out.includes('비밀번호가 틀렸습니다') && !fs.existsSync(path.join(pub, 'latest.yml')));
  const ok = await run(['sign', '--key', key, '--to', updates], [PASS], env);
  check('sign: 서명·게시', ok.code === 0 && fs.existsSync(path.join(pub, 'latest.yml')), `code=${ok.code}`);
  check('sign: 비밀번호가 화면에 안 나온다', !ok.out.includes(PASS));
  const info = yaml.load(fs.readFileSync(path.join(pub, 'latest.yml'), 'utf8'));
  const exe = path.join(pub, `Terminas-Setup-${VERSION}.exe`);
  const trusted = loadUpdateKeys(keysFile);
  // 베타 버전이면 베타 채널처럼 확인한다 (정식 채널은 서명이 맞아도 베타를 받지 않는다 — 아래에서 따로 본다)
  const chan = { allowPrerelease: VERSION.includes('-') };
  check('앱 확인: 서명된 새 버전 통과', (await verifyUpdateFile({ file: exe, info, keys: trusted, currentVersion: '0.0.1', ...chan })) === null);
  check('앱 확인: 같은 버전은 거절', (await verifyUpdateFile({ file: exe, info, keys: trusted, currentVersion: VERSION, ...chan })) !== null);
  check('앱 확인: 버전을 부풀리면 거절', (await verifyUpdateFile({ file: exe, info: { ...info, version: '9.9.9' }, keys: trusted, currentVersion: '0.0.1', ...chan })) === '서명이 맞지 않습니다');
  fs.appendFileSync(exe, Buffer.from([0]));
  check('앱 확인: 파일이 바뀌면 거절', (await verifyUpdateFile({ file: exe, info, keys: trusted, currentVersion: '0.0.1', ...chan })) === '서명이 맞지 않습니다');
  check('앱 확인: 서명 없으면 거절', (await verifyUpdateFile({ file: exe, info: { version: VERSION }, keys: trusted, currentVersion: '0.0.1', ...chan })) === '업데이트에 서명이 없습니다');
  if (chan.allowPrerelease) check('앱 확인: 정식 채널은 서명된 베타도 받지 않는다', (await verifyUpdateFile({ file: exe, info, keys: trusted, currentVersion: '0.0.1' }))?.includes('베타') === true);
  check('앱 확인: 공개키 없는 앱은 거절', (await verifyUpdateFile({ file: exe, info, keys: [], currentVersion: '0.0.1', ...chan })) !== null);
  const resign = await run(['sign', '--key', key, '--to', path.join(tmp, 'updates-resign')], [PASS], env);
  const lines = fs.readFileSync(path.join(rel, 'latest.yml'), 'utf8').match(/^terminasSig: /gm)?.length;
  check('sign: 다시 서명해도 서명 줄은 하나', resign.code === 0 && lines === 1);

  const rel2 = path.join(tmp, 'release-nokey');
  await fakeRelease(rel2, JSON.stringify({ keys: [] }));
  const nokey = await run(['sign', '--key', key, '--to', path.join(tmp, 'updates2')], [PASS], { TERMINAS_RELEASE_DIR: rel2 });
  check('sign: 앱 안에 공개키가 없는 빌드는 비밀번호 묻기 전에 거절', nokey.code !== 0 && nokey.out.includes('공개키가 없습니다') && !nokey.out.includes('비밀번호:'));
} finally {
  fs.writeFileSync(keysFile, keysBackup);
  check('운영 업데이트 폴더(data-prod/updates)는 건드리지 않았다', listing(prodUpdates) === prodBefore);
  check('기본 게시 폴더에도 아무것도 올리지 않았다 (모든 sign 이 --to 를 쓴다)', !fs.existsSync(SAFE_DEFAULT));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
