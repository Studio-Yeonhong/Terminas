// 관리 콘솔 로그인: 관리 비밀번호(scrypt, meta 표) + 선택 OTP. 비밀번호·OTP 는 서버 PC 에서 명령으로만 정한다
//   npm run console:password -w server            비밀번호 정하기
//   npm run console:password -w server -- --otp   OTP 도 켜기(인증 앱에 등록할 키를 보여 준다)
// 세션은 메모리에만 (서버를 다시 켜면 다시 로그인). 사람 계정·Google 로그인과는 별개다.
import { randomToken, sha256 } from '../crypto.ts';
import { get, run } from '../db.ts';
import { Throttle, verifyPassword } from '../password.ts';
import { openSecret, verifyTotp } from '../totp.ts';

const SESSION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
export const loginThrottle = new Throttle(5, 15 * 60 * 1000);

const meta = (key: string) => get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
export function setMeta(key: string, value: string | null) {
  if (value === null) run('DELETE FROM meta WHERE key = ?', key);
  else run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
}
export const CONSOLE_PASSWORD = 'console_password';
export const CONSOLE_TOTP = 'console_totp';
const CONSOLE_TOTP_STEP = 'console_totp_step';

export function consoleState() {
  return { passwordSet: Boolean(meta(CONSOLE_PASSWORD)), otp: Boolean(meta(CONSOLE_TOTP)) };
}

// 맞으면 세션 토큰, 아니면 null (비밀번호가 없으면 늘 null)
export async function consoleLogin(password: string, code: string): Promise<string | null> {
  const hash = meta(CONSOLE_PASSWORD);
  const ok = await verifyPassword(password, hash);
  if (!hash || !ok) return null;
  const sealed = meta(CONSOLE_TOTP);
  if (sealed) {
    const step = verifyTotp(openSecret(sealed, 'console'), code.replace(/\s/g, ''), Number(meta(CONSOLE_TOTP_STEP) ?? 0));
    if (step === null) return null;
    setMeta(CONSOLE_TOTP_STEP, String(step));
  }
  const token = randomToken(32);
  sessions.set(sha256(token), Date.now() + SESSION_MS);
  return token;
}

export function consoleSession(token: string | undefined) {
  if (!token) return false;
  const key = sha256(token);
  const until = sessions.get(key);
  if (!until || until < Date.now()) {
    sessions.delete(key);
    return false;
  }
  return true;
}

export function consoleLogout(token: string | undefined) {
  if (token) sessions.delete(sha256(token));
}

// 비밀번호·OTP 를 바꾸면 열려 있던 콘솔 로그인은 모두 끊는다 (명령은 다른 프로세스라 다음 요청 때 알아챈다)
let seenVersion = '';
export function dropSessionsIfChanged() {
  const version = `${meta(CONSOLE_PASSWORD) ?? ''}|${meta(CONSOLE_TOTP) ?? ''}`;
  if (seenVersion && version !== seenVersion) sessions.clear();
  seenVersion = version;
}

