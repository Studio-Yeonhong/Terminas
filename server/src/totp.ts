// 2단계 인증(OTP): TOTP (RFC 6238 — HMAC-SHA1, 30초, 6자리). Google Authenticator·1Password·Authy 등이 그대로 읽는다.
// 서버가 코드를 확인해야 하므로 비밀값을 서버가 갖는다 — DB 파일만 새어 나가서는 못 쓰게 서버 키로 암호화해 둔다
// (SHELL_TOTP_KEY 환경변수, 없으면 데이터 폴더의 totp.key — 이 키를 잃으면 OTP 를 켠 사람은 관리자가 초기화해야 한다).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const currentStep = (at = Date.now()) => Math.floor(at / STEP_MS);

export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

// 앞뒤 한 칸(±30초)까지 받는다. 맞으면 그 칸 번호, 아니면 null. lastStep 이하의 칸은 다시 쓸 수 없다(같은 코드 재사용 방지)
export function verifyTotp(secret: string, code: string, lastStep: number, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Terminas:${account}`)}?secret=${secret}&issuer=Terminas&algorithm=SHA1&digits=6&period=30`;

// ---------- 비밀값 보관 (서버 키로 AES-256-GCM) ----------
let key: Buffer | null = null;
function serverKey() {
  if (key) return key;
  const fromEnv = process.env.SHELL_TOTP_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv, 'base64');
    if (k.length !== 32) throw new Error('SHELL_TOTP_KEY 는 32바이트 base64 여야 합니다');
    return (key = k);
  }
  const file = path.join(config.dataDir, 'totp.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
  }
  const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (k.length !== 32) throw new Error(`${file} 가 올바르지 않습니다`);
  return (key = k);
}

export function sealSecret(secret: string, userId: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', serverKey(), iv);
  c.setAAD(Buffer.from(`totp:${userId}`));
  const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, data, c.getAuthTag()]).toString('base64')}`;
}

export function openSecret(sealed: string, userId: string) {
  const raw = Buffer.from(sealed.replace(/^v1\./, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', serverKey(), raw.subarray(0, 12));
  d.setAAD(Buffer.from(`totp:${userId}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

// ---------- 복구 코드: 휴대폰을 잃었을 때 한 번씩 쓰는 코드 10개 ----------
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const recoveryHash = (code: string) => crypto.createHash('sha256').update(code.toLowerCase().replace(/[\s-]/g, '')).digest('hex');
