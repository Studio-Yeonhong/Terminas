// 종단간 암호화의 바탕. 비밀번호·키는 여기서만 암호화·복호화되고, 서버에는 암호문만 간다.
//
//   암호화 비밀번호 ──argon2id──▶ KEK ─┐
//   복구 키(160비트) ──HKDF────▶ RKEK ─┴▶ 계정 키(AK, 32바이트) ─▶ 내 X25519 개인키
//   볼트 키(32바이트) ── 사람마다 그 사람 X25519 공개키로 봉함(sealed box) ──▶ vault_keys
//   볼트 항목(호스트·키·프리셋…) ── 볼트 키로 AES-256-GCM, AAD = item:<볼트>:<항목>:<종류>
import { argon2id } from 'hash-wasm';
import { x25519 } from '@noble/curves/ed25519.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// 화면에 나가는 오류 문구는 한국어 키 그대로 던지고, 보여 줄 때 errorMessage()/tMsg() 가 번역한다.
// 이 파일은 보안 시험이 Node 로 바로 불러서(확장자 없는 import 를 못 푼다) i18n-core 도 가져오지 않는다 — tk 는 키 표시만.
const tk = (ko: string) => ko;

// ---------- 바이트 ----------
export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str: string): Uint8Array<ArrayBuffer> {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const own = (u: Uint8Array) => new Uint8Array(u) as Uint8Array<ArrayBuffer>;
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
export function wipe(u: Uint8Array | null | undefined) {
  u?.fill(0);
}

export class DecryptError extends Error {}

// ---------- AES-256-GCM:  v1.<base64(iv 12 | 암호문+태그)> ----------
export type SymKey = CryptoKey;

export function importKey(raw: Uint8Array): Promise<SymKey> {
  return crypto.subtle.importKey('raw', own(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key: SymKey | Uint8Array, plain: Uint8Array | string, aad: string): Promise<string> {
  const k = key instanceof Uint8Array ? await importKey(key) : key;
  const iv = randomBytes(12);
  const data = typeof plain === 'string' ? enc.encode(plain) : own(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, k, data));
  return `v1.${toB64(concat(iv, ct))}`;
}

export async function open(key: SymKey | Uint8Array, sealed: string, aad: string): Promise<Uint8Array> {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1.')) throw new DecryptError(tk('알 수 없는 암호문 형식입니다'));
  const raw = fromB64(sealed.slice(3));
  const k = key instanceof Uint8Array ? await importKey(key) : key;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(aad) }, k, raw.subarray(12)));
  } catch {
    throw new DecryptError(tk('복호화에 실패했습니다'));
  }
}

export const openText = async (key: SymKey | Uint8Array, sealed: string, aad: string) => dec.decode(await open(key, sealed, aad));

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', own(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: enc.encode(info) }, base, 256));
}

async function sha256(data: Uint8Array | string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : own(data)));
}

// ---------- 암호화 비밀번호 → KEK ----------
export type Kdf = { alg: 'argon2id'; salt: string; m: number; t: number; p: number };
const KDF_PARAMS = { m: 64 * 1024, t: 3, p: 1 };

// 서버가 준 묶음의 KDF 값은 이 범위 안이어야 쓴다 — 기기를 멈출 만큼 무겁거나 너무 약한 값은 거절 (서버 parseBundle 과 같은 범위)
const KDF_LIMITS = { m: [19 * 1024, 256 * 1024], t: [1, 10], p: [1, 4] } as const;

export async function deriveKek(password: string, kdf: Kdf): Promise<Uint8Array> {
  const within = (n: number, [lo, hi]: readonly [number, number]) => Number.isInteger(n) && n >= lo && n <= hi;
  if (kdf.alg !== 'argon2id' || !within(kdf.m, KDF_LIMITS.m) || !within(kdf.t, KDF_LIMITS.t) || !within(kdf.p, KDF_LIMITS.p) || fromB64(kdf.salt).length < 16) {
    throw new Error(tk('키 묶음의 설정 값이 올바르지 않습니다. 관리자에게 알려 주세요.'));
  }
  return argon2id({
    password: password.normalize('NFC'),
    salt: fromB64(kdf.salt),
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
}

// ---------- 복구 키: 20바이트 → Crockford base32 32자 (4자씩 끊어 보여 준다) ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function recoveryText(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

export function parseRecoveryKey(text: string): Uint8Array | null {
  const s = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== 32) return null;
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[o++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

const recoveryKek = (bytes: Uint8Array, userId: string) => hkdf(bytes, enc.encode('terminas-recovery-v1'), `user:${userId}`);

// ---------- 계정 ----------
export type Bundle = { v: 1; kdf: Kdf; encPrivateKey: string; wrapPw: string; wrapRecovery: string };
export type Account = { userId: string; publicKey: Uint8Array; privateKey: Uint8Array; accountKey: Uint8Array };

const AAD = {
  privateKey: (u: string) => `user:${u}:private-key`,
  accountKey: (u: string) => `user:${u}:account-key`,
  recovery: (u: string) => `user:${u}:account-key:recovery`,
};

// 계정 키를 가졌다는 증명(서버는 이 값으로 묶음 교체를 허락한다). 계정 키 없이는 만들 수 없다.
export async function accountProof(accountKey: Uint8Array, userId: string) {
  return hex(await sha256(concat(enc.encode(`terminas-proof-v1:${userId}:`), accountKey)));
}

async function wrapWithPassword(accountKey: Uint8Array, userId: string, password: string) {
  const kdf: Kdf = { alg: 'argon2id', salt: toB64(randomBytes(16)), ...KDF_PARAMS };
  const kek = await deriveKek(password, kdf);
  const wrapPw = await seal(kek, accountKey, AAD.accountKey(userId));
  wipe(kek);
  return { kdf, wrapPw };
}

async function wrapWithRecovery(accountKey: Uint8Array, userId: string) {
  const bytes = randomBytes(20);
  const text = recoveryText(bytes);
  const rkek = await recoveryKek(bytes, userId);
  const wrapRecovery = await seal(rkek, accountKey, AAD.recovery(userId));
  wipe(rkek);
  wipe(bytes);
  return { recoveryKey: text, wrapRecovery };
}

export async function createAccount(userId: string, password: string) {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const accountKey = randomBytes(32);
  const { kdf, wrapPw } = await wrapWithPassword(accountKey, userId, password);
  const { recoveryKey, wrapRecovery } = await wrapWithRecovery(accountKey, userId);
  const bundle: Bundle = { v: 1, kdf, encPrivateKey: await seal(accountKey, privateKey, AAD.privateKey(userId)), wrapPw, wrapRecovery };
  return {
    publicKey: toB64(publicKey),
    bundle,
    proof: await accountProof(accountKey, userId),
    recoveryKey,
    account: { userId, publicKey, privateKey, accountKey } satisfies Account,
  };
}

export class WrongSecret extends Error {}

// 계정 키로 개인키를 풀고, 서버가 준 공개키와 짝이 맞는지 확인한다
export async function openAccount(userId: string, publicKeyB64: string, bundle: Bundle, accountKey: Uint8Array): Promise<Account> {
  const privateKey = await open(accountKey, bundle.encPrivateKey, AAD.privateKey(userId));
  const publicKey = fromB64(publicKeyB64);
  const derived = x25519.getPublicKey(privateKey);
  if (derived.length !== publicKey.length || derived.some((b, i) => b !== publicKey[i])) throw new DecryptError(tk('공개키가 개인키와 맞지 않습니다'));
  return { userId, publicKey, privateKey, accountKey };
}

export async function unlockWithPassword(userId: string, publicKeyB64: string, bundle: Bundle, password: string): Promise<Account> {
  const kek = await deriveKek(password, bundle.kdf);
  let accountKey: Uint8Array;
  try {
    accountKey = await open(kek, bundle.wrapPw, AAD.accountKey(userId));
  } catch {
    throw new WrongSecret(tk('암호화 비밀번호가 맞지 않습니다.'));
  } finally {
    wipe(kek);
  }
  return openAccount(userId, publicKeyB64, bundle, accountKey);
}

export async function unlockWithRecovery(userId: string, publicKeyB64: string, bundle: Bundle, recoveryKey: string): Promise<Account> {
  const bytes = parseRecoveryKey(recoveryKey);
  if (!bytes) throw new WrongSecret(tk('복구 키 형식이 맞지 않습니다. 4자씩 8묶음(32자)입니다.'));
  const rkek = await recoveryKek(bytes, userId);
  let accountKey: Uint8Array;
  try {
    accountKey = await open(rkek, bundle.wrapRecovery, AAD.recovery(userId));
  } catch {
    throw new WrongSecret(tk('복구 키가 맞지 않습니다.'));
  } finally {
    wipe(rkek);
  }
  return openAccount(userId, publicKeyB64, bundle, accountKey);
}

// 비밀번호 바꾸기: 계정 키는 그대로, 비밀번호로 감싼 것만 새로
export async function rewrapPassword(account: Account, bundle: Bundle, password: string): Promise<Bundle> {
  const { kdf, wrapPw } = await wrapWithPassword(account.accountKey, account.userId, password);
  return { ...bundle, kdf, wrapPw };
}

export async function newRecoveryKey(account: Account, bundle: Bundle): Promise<{ bundle: Bundle; recoveryKey: string }> {
  const { recoveryKey, wrapRecovery } = await wrapWithRecovery(account.accountKey, account.userId);
  return { bundle: { ...bundle, wrapRecovery }, recoveryKey };
}

// 공개키 지문(팀원끼리 대조용): SHA-256 앞 16바이트를 4자리씩
export async function keyFingerprint(publicKeyB64: string) {
  const h = hex((await sha256(fromB64(publicKeyB64))).subarray(0, 16));
  return h.match(/.{4}/g)!.join(' ');
}

// ---------- 볼트 키 봉함 (X25519 + HKDF + AES-GCM) ----------
// 결과: v1.<base64(보낸 쪽 공개키 32 | iv 12 | 암호문 48)>
// 보내는 사람의 계정 키 쌍으로 봉한다(sender). 앞 32바이트가 보낸 사람의 공개키가 되어, 받는 쪽은 "그 공개키의 주인(또는 나 자신)만
// 만들 수 있는 암호문"임을 안다 — 서버는 X25519(보낸 사람 개인키, 받는 사람 공개키)를 계산할 수 없어서 볼트 키를 만들어 넣지 못한다
// (보안 점검 H-2). 형식은 예전(그때그때 만든 임시 키로 봉함, ~0.3.2)과 같아 옛 앱도 그대로 푼다 — 다만 임시 키로 봉한 것은
// 누가 만들었는지 알 수 없다(vault.ts 가 "출처를 모르는 키"로 다룬다).
export async function wrapVaultKey(vaultKey: Uint8Array, recipientPublicB64: string, vaultId: string, userId: string, sender?: Account): Promise<string> {
  const recipient = fromB64(recipientPublicB64);
  if (recipient.length !== 32) throw new Error(tk('공개키가 올바르지 않습니다'));
  const eph = sender ? sender.privateKey : x25519.utils.randomSecretKey();
  const ephPub = sender ? sender.publicKey : x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipient);
  const k = await hkdf(shared, concat(ephPub, recipient), 'terminas-vault-key-v1');
  const inner = await seal(k, vaultKey, `vault:${vaultId}:${userId}`);
  if (!sender) wipe(eph);
  wipe(shared);
  wipe(k);
  return `v1.${toB64(concat(ephPub, fromB64(inner.slice(3))))}`;
}

// 푼 볼트 키와, 봉한 쪽의 공개키(base64). 봉한 공개키가 내 것이면 내가, 팀원의 것이면 그 팀원이 봉한 것이다
export async function unwrapVaultKeyFrom(wrapped: string, account: Account, vaultId: string): Promise<{ key: Uint8Array; sender: string }> {
  if (!wrapped.startsWith('v1.')) throw new DecryptError(tk('알 수 없는 볼트 키 형식입니다'));
  const raw = fromB64(wrapped.slice(3));
  const ephPub = raw.subarray(0, 32);
  const shared = x25519.getSharedSecret(account.privateKey, ephPub);
  const k = await hkdf(shared, concat(ephPub, account.publicKey), 'terminas-vault-key-v1');
  try {
    const key = await open(k, `v1.${toB64(raw.subarray(32))}`, `vault:${vaultId}:${account.userId}`);
    if (key.length !== 32) throw new DecryptError(tk('볼트 키 길이가 맞지 않습니다'));
    return { key, sender: toB64(ephPub) };
  } finally {
    wipe(shared);
    wipe(k);
  }
}

export async function unwrapVaultKey(wrapped: string, account: Account, vaultId: string): Promise<Uint8Array> {
  return (await unwrapVaultKeyFrom(wrapped, account, vaultId)).key;
}

// 볼트 키 지문(이 기기에 처음 본 볼트 키를 기억해 두고, 바뀌면 경고한다)
export async function vaultKeyPin(vaultKey: Uint8Array, vaultId: string) {
  return hex((await sha256(concat(enc.encode(`terminas-vault-pin:${vaultId}:`), vaultKey))).subarray(0, 16));
}

// ---------- 볼트 항목 ----------
export const itemAad = (vaultId: string, id: string, kind: string) => `item:${vaultId}:${id}:${kind}`;
// 기록의 대상 이름: 볼트와 그 기록이 가리키는 항목(호스트)에 묶는다 — 서버가 다른 기록의 이름과 바꿔치기하지 못하게.
// ref 없이 봉한 예전 이름(~0.3.2)은 볼트에만 묶여 있다
export const labelAad = (vaultId: string, ref?: string) => (ref ? `audit:${vaultId}:${ref}` : `audit:${vaultId}`);

export async function sealJson(key: SymKey, value: unknown, aad: string) {
  return seal(key, JSON.stringify(value), aad);
}
export async function openJson<T>(key: SymKey, sealed: string, aad: string): Promise<T> {
  return JSON.parse(await openText(key, sealed, aad)) as T;
}
