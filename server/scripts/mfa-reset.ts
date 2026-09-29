// 2단계 인증 초기화 — 인증 앱과 복구 코드를 모두 잃은 사람을 서버 관리자가 풀어 준다.
//   운영: npm run mfa:reset -w server -- 이메일
// OTP 를 끄고 복구 코드를 지우며, 코드를 기다리던 로그인은 지운다(다시 로그인). 기록(audit_log)에 남는다.
import { get, run, tx } from '../src/db.ts';
import { audit } from '../src/http.ts';

const email = String(process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('사용법: npm run mfa:reset -w server -- 이메일');
  process.exit(1);
}
const user = get<{ id: string; totp_secret: string | null }>('SELECT id, totp_secret FROM users WHERE email = ?', email);
if (!user) {
  console.error(`그 이메일의 사용자가 없습니다: ${email}`);
  process.exit(1);
}
if (!user.totp_secret) {
  console.log(`${email} 은(는) 2단계 인증이 이미 꺼져 있습니다.`);
  process.exit(0);
}
tx(() => {
  run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_pending_at = NULL, totp_enabled_at = NULL, totp_last_step = 0, mfa_fails = 0, mfa_locked_until = 0, mfa_lock_level = 0 WHERE id = ?', user.id);
  run('DELETE FROM totp_recovery WHERE user_id = ?', user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND mfa_ok = 0', user.id);
});
audit({ userId: null, action: 'mfa_reset', target: email, detail: { by: 'server-admin' } });
console.log(`${email} 의 2단계 인증을 껐습니다. 다시 로그인하면 Google 로그인만으로 들어옵니다.`);
