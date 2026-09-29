// 데스크톱 앱 배포: 빌드 → 서명 → 업데이트 파일을 게이트웨이 폴더(/updates)와/또는 Cloudflare R2 에 올린다.
//   node scripts/release.mjs [--to <게이트웨이 updates 폴더>] [--skip-build]
// 버전은 desktop/package.json 의 version — 올리기 전에 올려 둘 것 (같은 버전이면 앱이 업데이트로 보지 않는다).
// 서명에는 사람의 비밀번호가 필요하다(update-key.mjs). 터미널이 아니면(자동 실행) 빌드까지만 하고 멈춘다 —
// 그 다음은 사람이 `npm run release:sign` 으로 서명·게시한다.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { desktopRoot, releaseFiles } from './publish.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!args.includes('--skip-build')) {
  // 화면(web/dist)은 앱 안에 들어간다 → 앱을 만들기 전에 항상 새로 빌드
  execSync('npm run build', { cwd: path.join(desktopRoot, '..', 'web'), stdio: 'inherit' });
  execSync('node scripts/icon.mjs', { cwd: desktopRoot, stdio: 'inherit' });
  execSync('npx electron-builder --win --x64 --publish never', { cwd: desktopRoot, stdio: 'inherit' });
}

const { version } = releaseFiles();
if (process.stdin.isTTY) {
  const { sign } = await import('./update-key.mjs');
  await sign(argValue('--to') ? { toDir: argValue('--to') } : undefined);
} else {
  console.log(`\n${version} 빌드 완료 — 아직 올리지 않았습니다. 서명·게시는 터미널에서: npm run release:sign`);
}
