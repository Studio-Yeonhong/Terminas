// 빌드 결과(desktop/release)를 게이트웨이 업데이트 폴더와/또는 Cloudflare R2 에 올린다.
// 서명(update-key.mjs sign)을 거친 latest.yml 만 올린다 — 서명 없는 업데이트는 앱이 받지 않는다.
// 순서가 중요하다: 설치 파일·blockmap 을 먼저 올리고 latest.yml 을 마지막에 바꾼다 (앱이 없는 파일을 가리키지 않게).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrerelease, newerVersion } from '../src/update-verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(desktopRoot, '..');
// TERMINAS_RELEASE_DIR: 시험용 (가짜 빌드 결과로 서명·게시 흐름을 돌려 볼 때)
export const releaseDir = process.env.TERMINAS_RELEASE_DIR ? path.resolve(process.env.TERMINAS_RELEASE_DIR) : path.join(desktopRoot, 'release');

export function packageInfo() {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
}

// 이번 버전의 설치 파일·blockmap·latest.yml (있는지, 버전이 맞는지 확인)
export function releaseFiles() {
  const pkg = packageInfo();
  const installer = pkg.build.artifactName.replace('${version}', pkg.version).replace('${ext}', 'exe');
  const files = [installer, `${installer}.blockmap`, 'latest.yml'];
  for (const f of files) if (!fs.existsSync(path.join(releaseDir, f))) throw new Error(`빌드 결과가 없습니다: ${f} — 먼저 npm run release:desktop 으로 빌드하세요.`);
  const yml = fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version: ${pkg.version.replaceAll('.', '\\.')}$`, 'm').test(yml)) throw new Error('latest.yml 버전이 desktop/package.json 과 다릅니다 — 다시 빌드하세요.');
  return { version: pkg.version, installer, files };
}

// 공식 앱은 GitHub Releases 에서만 업데이트를 받는다(1.0.0-beta.1 부터) — 서명만 하고 서버 폴더에는 올리지 않는다.
// 서버 폴더(/updates)로 배포하려면(직접 운영하는 서버) TERMINAS_UPDATES_DIR 이나 --to 로 준다
export function defaultUpdatesDir() {
  return process.env.TERMINAS_UPDATES_DIR || undefined;
}

// 채널: 베타 버전(0.4.0-beta.1 처럼 - 가 붙은 것)은 베타 채널(<폴더>/beta)에만.
// 정식 버전은 정식 채널(<폴더>)에, 그리고 베타 채널에 있는 것보다 새것이면 베타 채널에도 (베타를 켠 사람도 정식을 받게)
const ymlVersion = (dir) => {
  try {
    return /^version: (.+)$/m.exec(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};
export function publishTargets(toDir, version) {
  const beta = path.join(toDir, 'beta');
  if (isPrerelease(version)) return [beta];
  const cur = ymlVersion(beta);
  return !cur || newerVersion(version, cur) ? [toDir, beta] : [toDir];
}

function copyInto(dir, installer, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(releaseDir, f), path.join(dir, f));
  // 예전 설치 파일은 둘까지만 남긴다 (차등 업데이트는 blockmap 으로 한다)
  const olds = fs
    .readdirSync(dir)
    .filter((f) => /^Terminas-Setup-.+\.exe$/.test(f) && f !== installer)
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(1);
  for (const { f } of olds) {
    fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, `${f}.blockmap`), { force: true });
  }
}

export async function publish({ toDir }) {
  const { version, installer, files } = releaseFiles();
  const yml = fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8');
  if (!/^terminasSig: /m.test(yml)) throw new Error('latest.yml 에 서명이 없습니다 — npm run release:sign 으로 서명하세요.');

  if (toDir) {
    for (const dir of publishTargets(toDir, version)) {
      copyInto(dir, installer, files);
      console.log(`게이트웨이 업데이트 폴더에 ${version} 을 올렸습니다 (${path.basename(dir) === 'beta' ? '베타 채널' : '정식 채널'}): ${dir}`);
    }
  }

  const r2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].every((k) => process.env[k]);
  if (r2) {
    const { AwsClient } = await import('aws4fetch');
    const client = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
    // 베타 버전은 beta/ 아래에 (정식 채널과 따로)
    const prefix = (process.env.R2_PREFIX ?? 'terminas/').replace(/^\/+/, '') + (isPrerelease(version) ? 'beta/' : '');
    const base = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${prefix}`;
    for (const f of files) {
      const body = fs.readFileSync(path.join(releaseDir, f));
      const type = f.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
      const res = await client.fetch(`${base}${encodeURIComponent(f)}`, {
        method: 'PUT',
        body,
        headers: { 'content-type': type, 'cache-control': f.endsWith('.yml') ? 'no-cache' : 'public, max-age=3600' },
      });
      if (!res.ok) throw new Error(`R2 업로드 실패 ${f}: ${res.status} ${await res.text()}`);
      console.log(`R2 ← ${prefix}${f}`);
    }
  }
  if (!toDir && !r2) console.log('올릴 곳이 없습니다. --to <폴더> 나 R2_* 환경변수를 주세요.');
}
