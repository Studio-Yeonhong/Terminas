// 서버는 비밀값을 암호화·복호화하지 않는다(종단간 암호화). 여기엔 세션 토큰용 도구만 남았다.
import nodeCrypto from 'node:crypto';

export function randomToken(bytes = 32) {
  return nodeCrypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return nodeCrypto.createHash('sha256').update(value).digest('hex');
}

export function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && nodeCrypto.timingSafeEqual(x, y);
}
