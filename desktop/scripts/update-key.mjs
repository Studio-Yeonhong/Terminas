// 앱 업데이트 서명 키 (보안 검토 F-03). 사람이 터미널에서 직접 돌린다 — 비밀번호를 묻는다.
//
//   npm run update-key:init      처음 한 번: 서명 키를 만들고 비밀번호로 잠가 저장, 공개키를 desktop/update-keys.json 에 넣는다
//   npm run release:sign         배포할 때마다: 빌드된 설치 파일에 서명하고 업데이트 폴더에 올린다
//
// 옵션: --key <잠긴 키 파일>  (기본 %USERPROFILE%\.terminas\update-signing-key.json, 또는 TERMINAS_UPDATE_KEY)
//       --to <업데이트 폴더>   (sign; 기본 TERMINAS_UPDATES_DIR, 없으면 서명만 — 공식 앱은 GitHub 로 배포: internal/github-publish.mjs release)
//
// 잠긴 키 파일: Ed25519 비밀키(PKCS#8)를 scrypt(N=2^17, r=8, p=1) 로 만든 키로 AES-256-GCM 암호화.
// 비밀번호는 어디에도 저장하지 않고, 이 스크립트도 화면에 찍지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { keyIdOf, loadUpdateKeys, sha512Of, signedPayload } from '../src/update-verify.js';
import { defaultUpdatesDir, desktopRoot, publish, releaseDir, releaseFiles } from './publish.mjs';

const require = createRequire(import.meta.url);
const KEYS_FILE = path.join(desktopRoot, 'update-keys.json');
const KDF = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

const args = process.argv;
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const keyPath = () => path.resolve(argValue('--key') ?? process.env.TERMINAS_UPDATE_KEY ?? path.join(os.homedir(), '.terminas', 'update-signing-key.json'));

// 화면에 찍지 않고 한 줄 받기
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('터미널에서 직접 실행해 주세요 (비밀번호를 물어야 합니다).'));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          return resolve(value);
        }
        if (ch === '\u0003') {
          cleanup();
          return reject(new Error('취소했습니다.'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function deriveKey(passphrase, salt, kdf) {
  return crypto.scryptSync(passphrase.normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
}

function lockKey(privateKey, publicDer, passphrase) {
  const keyId = keyIdOf(publicDer);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, KDF), iv);
  cipher.setAAD(Buffer.from(`terminas-update-key-v1:${keyId}`));
  const data = Buffer.concat([cipher.update(privateKey.export({ format: 'der', type: 'pkcs8' })), cipher.final()]);
  return {
    v: 1,
    purpose: 'Terminas 앱 업데이트 서명 키 (비밀번호로 잠김)',
    keyId,
    publicKey: publicDer.toString('base64'),
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function unlockKey(locked, passphrase) {
  const kdf = locked.kdf;
  if (locked.v !== 1 || kdf?.alg !== 'scrypt') throw new Error('키 파일 형식을 모릅니다.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(kdf.salt, 'base64'), kdf), Buffer.from(locked.iv, 'base64'));
  decipher.setAAD(Buffer.from(`terminas-update-key-v1:${locked.keyId}`));
  decipher.setAuthTag(Buffer.from(locked.tag, 'base64'));
  let der;
  try {
    der = Buffer.concat([decipher.update(Buffer.from(locked.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('비밀번호가 틀렸습니다 (또는 키 파일이 손상됐습니다).');
  }
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (keyIdOf(publicDer) !== locked.keyId) throw new Error('키 파일의 공개키와 비밀키가 맞지 않습니다.');
  return { privateKey, publicDer };
}

function readLocked(file) {
  if (!fs.existsSync(file)) throw new Error(`서명 키 파일이 없습니다: ${file}\n  처음이면 npm run update-key:init, USB 등에 둔 사본이면 --key <경로> 로 알려 주세요.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------- 처음 한 번: 키 만들기 ----------
export async function init() {
  const file = keyPath();
  if (fs.existsSync(file)) throw new Error(`이미 서명 키가 있습니다: ${file}\n  (지우고 새로 만들면 지금 깔린 앱들은 새 키로 서명한 업데이트를 받지 않습니다.)`);
  console.log('Terminas 앱 업데이트 서명 키를 만듭니다.');
  console.log(`비밀번호는 ${MIN_PASSPHRASE}자 이상 — 이 비밀번호와 키 파일 둘 다 있어야 업데이트를 낼 수 있습니다. 입력하는 글자는 화면에 나오지 않습니다.\n`);
  const pass = await askHidden('서명 키 비밀번호: ');
  if (pass.length < MIN_PASSPHRASE) throw new Error(`${MIN_PASSPHRASE}자 이상으로 정해 주세요.`);
  if ((await askHidden('한 번 더: ')) !== pass) throw new Error('두 번 넣은 비밀번호가 다릅니다.');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const locked = lockKey(privateKey, publicDer, pass);
  // 되풀어 서명해 보고 나서 저장한다
  const check = unlockKey(locked, pass);
  const probe = signedPayload('0.0.0', 'self-test');
  if (!crypto.verify(null, probe, crypto.createPublicKey({ key: check.publicDer, format: 'der', type: 'spki' }), crypto.sign(null, probe, check.privateKey))) throw new Error('자체 확인에 실패했습니다.');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(locked, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const keys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : { keys: [] };
  keys.keys = [...(keys.keys ?? []).filter((k) => k.id !== locked.keyId), { id: locked.keyId, publicKey: locked.publicKey, createdAt: locked.createdAt }];
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n');

  console.log(`\n완료. 키 id ${locked.keyId}`);
  console.log(`  잠긴 키 파일: ${file}`);
  console.log(`  공개키는 desktop/update-keys.json 에 넣었습니다 (다음 빌드부터 앱 안에 들어갑니다).`);
  console.log('\n꼭 해 둘 것:');
  console.log('  1) 위 키 파일을 USB 나 개인 PC 등 이 서버 밖에 한 부 복사해 두세요 (파일만으로는 쓸 수 없습니다 — 비밀번호가 있어야 합니다).');
  console.log('  2) 비밀번호는 비밀번호 관리자에 적어 두세요. 키 파일과 비밀번호를 둘 다 잃으면 깔린 앱이 자동 업데이트를 받지 못하고, 모두 새로 설치해야 합니다.');
}

// ---------- 배포할 때마다: 서명하고 올리기 ----------
export async function sign({ toDir = argValue('--to') ?? defaultUpdatesDir() } = {}) {
  const { version, installer } = releaseFiles();
  const locked = readLocked(keyPath());
  const trusted = loadUpdateKeys(KEYS_FILE).map((k) => k.id);
  if (!trusted.includes(locked.keyId)) throw new Error(`이 키(${locked.keyId})가 desktop/update-keys.json 에 없습니다. 이 키로 서명하면 앱이 받지 않습니다.`);
  // 이번 빌드의 앱 안에도 이 공개키가 들어 있어야 다음 업데이트를 받을 수 있다
  const asar = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asar)) throw new Error('빌드된 앱(win-unpacked)이 없습니다 — 다시 빌드하세요.');
  let bundledKeys = { keys: [] };
  try {
    bundledKeys = JSON.parse(require('@electron/asar').extractFile(asar, 'update-keys.json').toString('utf8'));
  } catch {}
  if (!(bundledKeys.keys ?? []).some((k) => keyIdOf(Buffer.from(k.publicKey, 'base64')) === locked.keyId)) {
    throw new Error('이번 빌드의 앱 안에 이 서명 키의 공개키가 없습니다. update-keys.json 을 확인하고 다시 빌드하세요 (이대로 내보내면 이 버전 다음 업데이트를 못 받습니다).');
  }

  const exe = path.join(releaseDir, installer);
  const sha512 = await sha512Of(exe);
  const ymlFile = path.join(releaseDir, 'latest.yml');
  const yml = fs.readFileSync(ymlFile, 'utf8').replace(/^terminasSig(Key)?: .*\n?/gm, '');
  const listed = [...yml.matchAll(/sha512: (\S+)/g)].map((m) => m[1]);
  if (!listed.length || listed.some((h) => h !== sha512)) throw new Error('latest.yml 의 sha512 가 설치 파일과 다릅니다 — 다시 빌드하세요.');

  console.log(`서명할 것: Terminas ${version}`);
  console.log(`  파일   ${installer} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  sha512 ${sha512.slice(0, 24)}…`);
  console.log(`  키     ${locked.keyId}`);
  console.log(`  올릴 곳 ${toDir ?? '(없음 — 서명만)'}\n`);
  const { privateKey, publicDer } = unlockKey(locked, await askHidden('서명 키 비밀번호: '));
  const payload = signedPayload(version, sha512);
  const sig = crypto.sign(null, payload, privateKey);
  if (!crypto.verify(null, payload, crypto.createPublicKey({ key: publicDer, format: 'der', type: 'spki' }), sig)) throw new Error('서명 자체 확인에 실패했습니다.');
  fs.writeFileSync(ymlFile, `${yml.replace(/\n*$/, '\n')}terminasSigKey: ${locked.keyId}\nterminasSig: ${sig.toString('base64')}\n`);
  console.log('서명했습니다.');
  await publish({ toDir });
}

const cli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (cli) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'init') await init();
    else if (cmd === 'sign') await sign();
    else throw new Error('사용법: node desktop/scripts/update-key.mjs init | sign [--key <파일>] [--to <폴더>]');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}
