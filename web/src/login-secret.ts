// 로그인 비밀번호와 암호화 비밀번호가 같지 않게.
// 로그인 비밀번호는 서버가 받는 값이라, 둘이 같으면 서버(또는 서버를 가진 사람)가 볼트를 열 수 있게 된다.
// 비밀번호 로그인으로 들어온 이 화면에서만, 메모리에 "알아볼 수 있는 값"(무작위 소금 + SHA-256)을 들고 있다가
// 암호화 비밀번호를 정할 때 비교한다. 비밀번호 자체는 들고 있지 않고, 새로고침·로그아웃하면 사라진다.
let salt: Uint8Array | null = null;
let digest: string | null = null;

async function hash(pw: string, s: Uint8Array) {
  const text = new TextEncoder().encode(pw.normalize('NFC'));
  const data = new Uint8Array(s.length + text.length);
  data.set(s);
  data.set(text, s.length);
  const out = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function rememberLoginPassword(pw: string) {
  salt = crypto.getRandomValues(new Uint8Array(16));
  digest = await hash(pw, salt);
}

export async function isLoginPassword(pw: string) {
  return Boolean(salt && digest && (await hash(pw, salt)) === digest);
}

export function forgetLoginPassword() {
  salt = null;
  digest = null;
}
