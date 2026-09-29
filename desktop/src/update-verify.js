// 자동 업데이트 서명 확인 (보안 검토 F-03).
// 업데이트 서버(= Terminas 게이트웨이)를 장악해도 가짜 앱을 설치시키지 못하게, 설치 파일마다 운영자의
// Ed25519 서명을 요구한다. 서명 키는 게이트웨이 밖에서 비밀번호로 잠겨 있고, 앱은 공개키만 품는다
// (desktop/update-keys.json → 빌드할 때 앱 안에 들어간다).
//
// 서명하는 내용: "terminas-update-v1" · 앱 ID · 버전 · 설치 파일 sha512 — latest.yml 의 terminasSig 에 실린다.
// 앱은 받은 파일의 sha512 를 직접 계산해 확인하고, 지금보다 새 버전일 때만 받는다(서명된 옛 버전으로 되돌리기 방지).
// 서명에 채널(정식/베타)은 들어 있지 않다(옛 앱도 새 릴리스를 확인할 수 있게 형식은 그대로) — 대신 정식 채널 앱은
// 베타 버전(- 가 붙은 버전)이면 서명이 맞아도 받지도 설치하지도 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APP_ID = 'studio.yeonhong.terminas';

export function signedPayload(version, sha512) {
  return Buffer.from(`terminas-update-v1\n${APP_ID}\n${version}\n${sha512}\n`, 'utf8');
}

// 공개키 id: 공개키(SPKI DER) sha256 앞 8바이트
export function keyIdOf(spkiDer) {
  return crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

export function loadUpdateKeys(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const keys = [];
  for (const k of parsed?.keys ?? []) {
    try {
      const der = Buffer.from(String(k.publicKey), 'base64');
      const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') continue;
      keys.push({ id: keyIdOf(der), key });
    } catch {}
  }
  return keys;
}

export async function sha512Of(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

// a 가 b 보다 새 버전인지 — semver 순서: 0.4.0-beta.1 < 0.4.0-beta.2 < 0.4.0-rc.1 < 0.4.0 (베타 채널)
export function newerVersion(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  // 꼬리 없는 정식이 같은 번호의 베타보다 새것
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) > Number(q);
    if (pn !== qn) return !pn; // 숫자보다 글자가 뒤
    if (!pn && p !== q) return p > q;
  }
  return false;
}
export const isPrerelease = (v) => /^\d+\.\d+\.\d+-/.test(String(v).trim());
// 설치를 막을 때는 더 넓게: 빌드 정보(+ 뒤)를 뺀 버전 어디든 - 가 있으면 베타로 본다 (v0.4.0-beta.1 같은 모양도)
const prereleaseLike = (v) => typeof v === 'string' && v.split('+')[0].includes('-');

// 문제가 없으면 null, 있으면 이유 문장. allowPrerelease: 베타 채널에 들어간 앱만 true (기본은 정식 채널 — 베타 버전 거절)
export async function verifyUpdateFile({ file, info, keys, currentVersion, allowPrerelease = false }) {
  if (!keys.length) return '이 앱에 업데이트 확인용 공개키가 없습니다';
  const version = info?.version;
  const sigText = info?.terminasSig;
  const keyId = info?.terminasSigKey;
  if (typeof version !== 'string' || typeof sigText !== 'string' || typeof keyId !== 'string') return '업데이트에 서명이 없습니다';
  if (!allowPrerelease && prereleaseLike(version)) return `정식 채널에서는 베타 버전을 설치하지 않습니다 (${version})`;
  if (!newerVersion(version, currentVersion)) return `지금 버전(${currentVersion})보다 새 버전이 아닙니다 (${version})`;
  const key = keys.find((k) => k.id === keyId);
  if (!key) return `알 수 없는 서명 키입니다 (${keyId})`;
  const sig = Buffer.from(sigText, 'base64');
  if (sig.length !== 64) return '서명 형식이 올바르지 않습니다';
  const sha512 = await sha512Of(file);
  if (!crypto.verify(null, signedPayload(version, sha512), key.key, sig)) return '서명이 맞지 않습니다';
  return null;
}

// electron-updater 에 끼운다. 원래 verifySignature 는 코드 서명 인증서(publisherName)가 없으면 아무것도 확인하지 않는다.
// allowPrerelease: 베타 채널이면 true 를 돌려주는 함수(채널은 앱을 켠 채로 바뀐다) 또는 true/false. 기본은 정식 채널.
export function guardUpdater(autoUpdater, { keys, currentVersion, allowPrerelease = false, log = () => {} }) {
  const betaOk = () => (typeof allowPrerelease === 'function' ? allowPrerelease() === true : allowPrerelease === true);
  // 정식 채널: 피드가 베타 버전을 내밀면 "업데이트 없음"으로 — 내려받지도 않는다 (서명 확인에서 한 번 더 막는다)
  const supported = autoUpdater.isUpdateSupported;
  autoUpdater.isUpdateSupported = (info) => {
    if (!betaOk() && prereleaseLike(info?.version)) {
      log(`update ${info?.version} skipped: prerelease on the stable channel`);
      return false;
    }
    return typeof supported === 'function' ? supported(info) : true;
  };
  autoUpdater.verifySignature = async (tempUpdateFile) => {
    try {
      const problem = await verifyUpdateFile({ file: tempUpdateFile, info: autoUpdater.updateInfoAndProvider?.info, keys, currentVersion, allowPrerelease: betaOk() });
      log(problem ? `update signature rejected: ${problem}` : 'update signature ok');
      return problem;
    } catch (err) {
      log(`update signature check failed: ${err?.message ?? err}`);
      return '서명을 확인하지 못했습니다';
    }
  };
}

// 전에 받아 둔 설치 파일은 서명 확인 없이 다시 쓰일 수 있다(electron-updater 캐시) → 켤 때마다 비운다.
// 받은 업데이트는 앱을 끌 때 설치되므로 보통은 남아 있지 않다.
export function clearPendingUpdates(resourcesPath, localAppData = process.env.LOCALAPPDATA) {
  try {
    if (!localAppData) return;
    const yml = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8');
    const dir = /^updaterCacheDirName:\s*(.+)$/m.exec(yml)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (!dir || /[\\/]|\.\./.test(dir)) return;
    fs.rmSync(path.join(localAppData, dir, 'pending'), { recursive: true, force: true });
  } catch {}
}
