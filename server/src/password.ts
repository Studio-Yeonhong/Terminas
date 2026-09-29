// 아이디·비밀번호 로그인(SHELL_PASSWORD_LOGIN=1)용. 비밀번호는 scrypt 해시로만 보관한다.
// 로그인 비밀번호는 서버가 받는 값이라 볼트를 여는 "암호화 비밀번호"와 달라야 한다 — 같은지는 화면이 확인한다(서버는 알 수 없다).
import nodeCrypto from 'node:crypto';
import { HttpError } from './http.ts';

const N = 1 << 15;
const R = 8;
const P = 1;
const LEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

function scrypt(password: string, salt: Buffer, len: number, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) =>
    nodeCrypto.scrypt(password.normalize('NFC'), salt, len, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string) {
  const salt = nodeCrypto.randomBytes(16);
  const hash = await scrypt(password, salt, LEN, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// 계정이 없거나 비밀번호가 없을 때도 같은 시간이 걸리게 가짜 해시로 한 번 계산한다 (있는 아이디인지 시간으로 알아내지 못하게)
const DUMMY = `scrypt$${N}$${R}$${P}$${nodeCrypto.randomBytes(16).toString('base64')}$${Buffer.alloc(LEN).toString('base64')}`;

export async function verifyPassword(password: string, stored: string | null | undefined) {
  const parts = (stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > 1 << 20 || (n & (n - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || expected.length < 16) return false;
  const actual = await scrypt(password, salt, expected.length, n, r, p);
  return Boolean(stored) && nodeCrypto.timingSafeEqual(actual, expected);
}

// 요청 본문의 비밀번호 (앞뒤 공백도 비밀번호의 일부라 자르지 않는다)
export function passwordField(b: Record<string, unknown>, key: string) {
  const v = b[key];
  if (typeof v !== 'string' || !v.length) throw new HttpError(400, 'bad_request', `${key} 값이 필요합니다`);
  if (v.length > 1024) throw new HttpError(400, 'bad_request', `${key} 값이 너무 깁니다`);
  return v;
}

// 새로 정하는 비밀번호의 규칙
export function checkNewPassword(password: string) {
  const length = [...password.normalize('NFC')].length;
  if (length < PASSWORD_MIN) throw new HttpError(400, 'weak_password', `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`);
  if (length > PASSWORD_MAX) throw new HttpError(400, 'bad_request', `비밀번호는 ${PASSWORD_MAX}자까지입니다`);
  if (!password.trim()) throw new HttpError(400, 'weak_password', `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`);
}

// 틀린 횟수 세기 (서버 한 개가 도는 구조라 메모리로 충분하다). 창 안에서 max 번 틀리면 창이 끝날 때까지 막는다
export class Throttle {
  private hits = new Map<string, { n: number; until: number }>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    setInterval(() => {
      const t = Date.now();
      for (const [k, v] of this.hits) if (v.until < t) this.hits.delete(k);
    }, 60_000).unref();
  }
  blocked(key: string) {
    const h = this.hits.get(key);
    return Boolean(h && h.until > Date.now() && h.n >= this.max);
  }
  fail(key: string) {
    const t = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < t) this.hits.set(key, { n: 1, until: t + this.windowMs });
    else h.n++;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
  // 성공한 시도는 센 것에서 뺀다 (시도를 계산 전에 먼저 세므로)
  undo(key: string) {
    const h = this.hits.get(key);
    if (h && h.n > 0) h.n--;
  }
}

// scrypt 는 무거워서 동시에 도는 개수를 제한한다 — 로그인 폭주로 서버 전체가 멈추지 않게. 같은 아이디는 한 번에 하나만 (보안 점검 M-2)
const MAX_HASHING = 4;
let hashing = 0;
const hashingKeys = new Set<string>();
export function hashSlot(key: string) {
  if (hashing >= MAX_HASHING || hashingKeys.has(key)) throw busy();
  hashing++;
  hashingKeys.add(key);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    hashing--;
    hashingKeys.delete(key);
  };
}
export const busy = () => new HttpError(429, 'busy', '요청이 많아 잠시 처리하지 못했습니다. 잠시 뒤에 다시 시도해 주세요.');

export const tooMany = () => new HttpError(429, 'too_many', '여러 번 틀려서 잠시 막았습니다. 15분 뒤에 다시 시도해 주세요.');

// 초대 코드: 헷갈리는 글자(0 O 1 I L)를 뺀 대문자·숫자 12자리, XXXX-XXXX-XXXX 로 보여 준다
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newInviteCode() {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += CODE_ALPHABET[nodeCrypto.randomInt(CODE_ALPHABET.length)];
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}
export const normalizeInviteCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
