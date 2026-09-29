import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const publicUrl = (process.env.SHELL_PUBLIC_URL ?? 'http://localhost:5380').replace(/\/+$/, '');
// 공식 저장소 (AGPL-3.0 소스 안내·앱 받기 기본값)
const OFFICIAL_REPO = 'https://github.com/Studio-Yeonhong/Terminas';
// 비어 있으면(예: SHELL_SOURCE_URL=) 기본값을 쓴다 — 소스 안내는 AGPL 의무라 끌 수 없게
// 앞단 프록시를 어디까지 믿을지 (보내는 사람 IP 를 X-Forwarded-For 에서 읽는다).
// 1 = 같은 PC·사설망에 있는 프록시(터널·nginx·Docker 브리지)만 믿는다 — 그 프록시가 붙인 맨 오른쪽 주소를 쓰고,
//     보내는 사람이 앞에 적어 넣은 주소는 무시한다. 주소·CIDR 목록(쉼표)도 된다. 0(기본) = 믿지 않는다
function trustProxySetting(v = ''): boolean | string {
  const s = v.trim();
  if (!s || s === '0' || s === 'false') return false;
  if (s === '1' || s === 'true') return 'loopback, linklocal, uniquelocal';
  return s;
}

function relayPrivateSetting(v: string | undefined, openSignup: boolean): 'all' | 'admins' | 'none' {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'all' || s === 'admins' || s === 'none') return s;
  return openSignup ? 'admins' : 'all';
}

function url(name: string, fallback = '') {
  const v = (process.env[name]?.trim() || fallback).trim();
  if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error(`${name} must be an http(s) URL`);
  return v;
}
const publicOrigin = new URL(publicUrl).origin;
const isLocalOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicUrl).hostname);

export const config = {
  root,
  port: Number(process.env.SHELL_PORT ?? 5381),
  host: process.env.SHELL_HOST ?? '127.0.0.1',
  publicUrl,
  publicOrigin,
  secureCookies: publicUrl.startsWith('https://'),
  dataDir: path.resolve(root, process.env.SHELL_DATA_DIR ?? 'data'),
  // 데스크톱 앱 자동 업데이트 파일(latest.yml·설치 파일·blockmap)을 /updates/ 로 내보낸다
  updatesDir: path.resolve(root, process.env.SHELL_UPDATES_DIR ?? path.join(process.env.SHELL_DATA_DIR ?? 'data', 'updates')),
  // 비우면 콘솔로, 넣으면 그 파일로 (운영은 예약 작업이라 콘솔이 없다)
  logFile: process.env.SHELL_LOG_FILE ? path.resolve(root, process.env.SHELL_LOG_FILE) : '',
  webDist: path.resolve(root, 'web', 'dist'),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUri: `${publicUrl}/api/auth/google/callback`,
  // 첫 로그인 때 초대 없이 들어올 수 있고 팀을 만들 수 있는 관리자 이메일
  bootstrapAdmins: list(process.env.SHELL_BOOTSTRAP_ADMINS),
  // 구글 없이 이메일만으로 로그인 — 로컬 개발 전용
  devLogin: process.env.SHELL_DEV_LOGIN === '1',
  // 아이디·비밀번호 로그인 (Google 없이 직접 운영할 때). 켜면 로그인 화면에 아이디·비밀번호 칸이 나오고,
  // 초대받은 사람은 초대 코드로 처음 비밀번호를 정한다
  passwordLogin: process.env.SHELL_PASSWORD_LOGIN === '1',
  // 처음 켤 때 만들 서버 관리자 계정. 그 계정에 비밀번호가 아직 없을 때만 쓰인다(바꾸려면 화면이나 user:password)
  adminId: (process.env.SHELL_ADMIN_ID ?? '').trim().toLowerCase(),
  adminPassword: process.env.SHELL_ADMIN_PASSWORD ?? '',
  // 누구나 가입 (Google 로그인 — 이메일이 확인된 계정만). 켜면 초대 없이 들어오고, 팀이 없어도 개인 볼트를 쓰며, 누구나 팀을 만든다.
  // 아이디·비밀번호로는 스스로 가입할 수 없다(이메일을 확인할 수 없어 남의 초대를 가로챌 수 있다) — 초대 코드로만.
  openSignup: process.env.SHELL_OPEN_SIGNUP === '1',
  // 웹의 "앱 받기" 링크: 이 서버에 올려 둔 설치 파일이 없으면 이 주소로 보낸다 (기본: 공식 배포처)
  appDownloadUrl: url('SHELL_APP_DOWNLOAD_URL', `${OFFICIAL_REPO}/releases/latest`),
  // 로그인 화면 아래 링크 (누구나 가입하는 서버라면 이용약관·개인정보처리방침을 두는 것이 좋다)
  termsUrl: url('SHELL_TERMS_URL'),
  privacyUrl: url('SHELL_PRIVACY_URL'),
  // AGPL-3.0 제13조: 이 서버를 쓰는 사람에게 지금 돌고 있는 판의 소스를 받을 곳을 알린다. 고친 판을 돌리면 그 소스 주소로 바꾼다
  sourceUrl: url('SHELL_SOURCE_URL', OFFICIAL_REPO),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  // 기록(audit_log)을 며칠 두는지. 0 이면 지우지 않는다
  auditRetentionDays: Math.max(0, Math.floor(Number(process.env.SHELL_AUDIT_RETENTION_DAYS ?? 365) || 0)),
  trustProxy: trustProxySetting(process.env.SHELL_TRUST_PROXY),
  // 웹 접속 중계가 사설망·CGNAT·ULA(서버 둘레의 내부망)로 가도 되는지: all = 누구나, admins = 서버 관리자만, none = 아무도.
  // 누구나 가입하는 서버는 기본이 admins — 가입만 하면 서버 둘레 내부망의 SSH 에 닿는 통로가 되지 않게
  relayPrivate: relayPrivateSetting(process.env.SHELL_RELAY_PRIVATE, process.env.SHELL_OPEN_SIGNUP === '1'),
  // 관리 콘솔: 서버 PC 안에서만 여는 관리 서버 (console/index.ts). 0 이면 끈다. Docker 는 컨테이너 안 0.0.0.0 + 호스트의 127.0.0.1 로만 내보낸다
  consolePort: Number(process.env.SHELL_CONSOLE_PORT ?? 5282),
  consoleHost: (process.env.SHELL_CONSOLE_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
  // 로컬 개발(localhost 주소)인지 — 중계가 이 서버 자신으로 가는 것을 막을지 정할 때 쓴다
  isLocalOrigin,
};

if (config.devLogin && (!isLocalOrigin || process.env.NODE_ENV === 'production')) {
  throw new Error('SHELL_DEV_LOGIN=1 is only allowed with a localhost SHELL_PUBLIC_URL outside production');
}
if (!Number.isInteger(config.consolePort) || config.consolePort < 0 || config.consolePort > 65535) throw new Error('SHELL_CONSOLE_PORT must be 0-65535');
if (config.adminId) {
  if (!config.passwordLogin) throw new Error('SHELL_ADMIN_ID needs SHELL_PASSWORD_LOGIN=1');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminId) && !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(config.adminId)) {
    throw new Error('SHELL_ADMIN_ID must be an email address or 3-64 characters of a-z 0-9 . _ -');
  }
}
if (config.adminPassword && [...config.adminPassword.normalize('NFC')].length < 10) {
  throw new Error('SHELL_ADMIN_PASSWORD must be at least 10 characters');
}
