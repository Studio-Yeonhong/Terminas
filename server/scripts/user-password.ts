// 로그인 비밀번호 정하기·초기화 (비밀번호 로그인 서버, 서버 관리자용)
//   npm run user:password -w server -- 아이디                 있는 계정의 비밀번호를 새로 정한다
//   npm run user:password -w server -- 아이디 --create-admin  없으면 서버 관리자 계정으로 만든다
// 비밀번호는 화면에 보이지 않게 두 번 묻는다(터미널이 아니면 표준 입력의 첫 줄·둘째 줄). 그 사람의 로그인은 모두 끊는다.
// 볼트를 여는 암호화 비밀번호와는 별개다 — 그것은 서버가 모르고, 여기서 바꿀 수도 없다.
import { get, newId, now, run, tx } from '../src/db.ts';
import { audit } from '../src/http.ts';
import { ensurePersonalVault } from '../src/access.ts';
import { config } from '../src/config.ts';
import { checkNewPassword, hashPassword } from '../src/password.ts';
import { HttpError } from '../src/http.ts';
import { ask } from './prompt.ts';

const args = process.argv.slice(2);
const id = String(args.find((a) => !a.startsWith('--')) ?? '').trim().toLowerCase();
const createAdmin = args.includes('--create-admin');
if (!id) {
  console.error('사용법: npm run user:password -w server -- 아이디 [--create-admin]');
  process.exit(1);
}

const user = get<{ id: string; password_hash: string | null }>('SELECT id, password_hash FROM users WHERE email = ?', id);
if (!user && !createAdmin) {
  console.error(`그 아이디의 계정이 없습니다: ${id}  (새 서버 관리자로 만들려면 --create-admin)`);
  process.exit(1);
}
if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id) && !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)) {
  console.error('아이디는 이메일이거나 a-z 0-9 . _ - 로 된 3~64자여야 합니다');
  process.exit(1);
}

const password = await ask('새 비밀번호: ');
const again = await ask('한 번 더: ');
if (password !== again) {
  console.error('두 비밀번호가 다릅니다.');
  process.exit(1);
}
try {
  checkNewPassword(password);
} catch (err) {
  console.error(err instanceof HttpError ? err.message : String(err));
  process.exit(1);
}

const hash = await hashPassword(password);
const userId = tx(() => {
  const uid = user?.id ?? newId();
  if (!user) run('INSERT INTO users (id, email, name, is_admin, created_at) VALUES (?, ?, ?, 1, ?)', uid, id, id.split('@')[0], now());
  run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, now(), uid);
  // 비밀번호를 새로 정했으니 모든 기기의 로그인을 끊는다
  run('DELETE FROM sessions WHERE user_id = ?', uid);
  ensurePersonalVault(uid);
  return uid;
});
audit({ userId, action: user?.password_hash ? 'password_change' : 'password_set', target: id, detail: { by: 'server-admin' } });
console.log(`${id} 의 로그인 비밀번호를 정했습니다${user ? '' : ' (새 서버 관리자 계정)'}. 그 계정의 로그인은 모두 끊었습니다.`);
if (!config.passwordLogin) console.log('참고: 이 서버는 아이디·비밀번호 로그인이 꺼져 있습니다 (SHELL_PASSWORD_LOGIN=1 로 켭니다).');
process.exit(0);
