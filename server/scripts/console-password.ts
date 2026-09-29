// 관리 콘솔(서버 PC 안에서만 열리는 관리 화면) 로그인 정하기 — 서버 PC 에서만 돌린다
//   npm run console:password -w server              관리 비밀번호 정하기 (두 번 묻는다, 화면에 안 보인다)
//   npm run console:password -w server -- --otp     OTP 켜기·다시 만들기 (인증 앱에 키를 등록하고 지금 코드로 확인)
//   npm run console:password -w server -- --no-otp  OTP 끄기
//   npm run console:password -w server -- --off     관리 비밀번호 지우기 (콘솔에 아무도 로그인할 수 없다)
// 바꾸면 열려 있던 콘솔 로그인은 모두 끊긴다. 사람 계정·볼트 암호화와는 관계없다.
import { audit } from '../src/http.ts';
import { HttpError } from '../src/http.ts';
import { config } from '../src/config.ts';
import { checkNewPassword, hashPassword } from '../src/password.ts';
import { newSecret, otpauthUri, sealSecret, verifyTotp } from '../src/totp.ts';
import { CONSOLE_PASSWORD, CONSOLE_TOTP, consoleState, setMeta } from '../src/console/auth.ts';
import { ask } from './prompt.ts';

const args = process.argv.slice(2);
const where = `http://127.0.0.1:${config.consolePort}/admin`;

if (args.includes('--off')) {
  setMeta(CONSOLE_PASSWORD, null);
  setMeta(CONSOLE_TOTP, null);
  audit({ action: 'console_password', detail: { off: true } });
  console.log('관리 콘솔 비밀번호와 OTP 를 지웠습니다. 이제 콘솔에 로그인할 수 없습니다.');
  process.exit(0);
}

if (args.includes('--no-otp')) {
  setMeta(CONSOLE_TOTP, null);
  audit({ action: 'console_password', detail: { otp: false } });
  console.log('관리 콘솔 OTP 를 껐습니다.');
  process.exit(0);
}

if (args.includes('--otp')) {
  if (!consoleState().passwordSet) {
    console.error('먼저 관리 비밀번호를 정하세요: npm run console:password -w server');
    process.exit(1);
  }
  const secret = newSecret();
  console.log('\n인증 앱(Google Authenticator·1Password·Authy 등)에 아래 키를 등록하세요:');
  console.log(`  키: ${secret.replace(/(.{4})/g, '$1 ').trim()}`);
  console.log(`  주소: ${otpauthUri(secret, 'console')}\n`);
  const code = await ask('인증 앱의 지금 6자리 코드: ', { hidden: false });
  if (verifyTotp(secret, code.replace(/\s/g, ''), 0) === null) {
    console.error('코드가 맞지 않습니다. OTP 는 바뀌지 않았습니다.');
    process.exit(1);
  }
  setMeta(CONSOLE_TOTP, sealSecret(secret, 'console'));
  audit({ action: 'console_password', detail: { otp: true } });
  console.log(`관리 콘솔 OTP 를 켰습니다. ${where}`);
  process.exit(0);
}

const password = await ask('새 관리 비밀번호: ');
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
setMeta(CONSOLE_PASSWORD, await hashPassword(password));
audit({ action: 'console_password', detail: { set: true } });
console.log(`관리 콘솔 비밀번호를 정했습니다. 서버 PC 에서 ${where} 를 여세요.`);
if (!consoleState().otp) console.log('OTP 도 켜려면: npm run console:password -w server -- --otp');
process.exit(0);
