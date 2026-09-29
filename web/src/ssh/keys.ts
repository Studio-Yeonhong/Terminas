// 브라우저에서 SSH 개인키 다루기: OpenSSH 형식(-----BEGIN OPENSSH PRIVATE KEY-----)은 직접 읽고 쓴다
// (암호가 걸린 것은 bcrypt-pbkdf + AES). PEM(PKCS#1·PKCS#8·SEC1)은 dev-tunnels-ssh-keys 로 읽는다.
import { Buffer } from 'buffer';
import { BigInt as SshBigInt, SshAlgorithms, type KeyPair } from '@microsoft/dev-tunnels-ssh';
import { importKey } from '@microsoft/dev-tunnels-ssh-keys';
import bcrypt from 'bcrypt-pbkdf';
import { t } from '../i18n-core';
import { Ed25519KeyPair, hostKeyInfo } from './engine';

export class KeyPassphraseError extends Error {}

const MAGIC = 'openssh-key-v1\0';

class Reader {
  private o = 0;
  constructor(private b: Buffer) {}
  u32() {
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  bytes() {
    const n = this.u32();
    if (this.o + n > this.b.length) throw new Error(t('키 데이터가 잘렸습니다'));
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  text() {
    return this.bytes().toString('utf8');
  }
  // 남은 전부 (AES-GCM 태그는 암호문 문자열 뒤에 따로 붙어 있다)
  rest() {
    const v = this.b.subarray(this.o);
    this.o = this.b.length;
    return v;
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const sshString = (v: Buffer | string) => {
  const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  return Buffer.concat([u32(b.length), b]);
};
// mpint → 부호 없는 바이트(앞의 0 을 뗀다)
const unsigned = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};
const toBig = (b: Buffer) => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};
const fromBig = (v: bigint) => {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
};
const sshBig = (b: Buffer) => SshBigInt.fromBytes(unsigned(b), { unsigned: true });

const CIPHERS: Record<string, { keyLen: number; ivLen: number; mode: 'AES-CTR' | 'AES-GCM'; block: number }> = {
  'aes256-ctr': { keyLen: 32, ivLen: 16, mode: 'AES-CTR', block: 16 },
  'aes192-ctr': { keyLen: 24, ivLen: 16, mode: 'AES-CTR', block: 16 },
  'aes128-ctr': { keyLen: 16, ivLen: 16, mode: 'AES-CTR', block: 16 },
  'aes256-gcm@openssh.com': { keyLen: 32, ivLen: 12, mode: 'AES-GCM', block: 16 },
};

function derive(passphrase: string, salt: Buffer, rounds: number, length: number) {
  const out = new Uint8Array(length);
  const pass = Buffer.from(passphrase, 'utf8');
  if (bcrypt.pbkdf(pass, pass.length, salt, salt.length, out, length, rounds) !== 0) throw new Error(t('키 암호를 풀지 못했습니다'));
  return out;
}

async function aes(mode: 'AES-CTR' | 'AES-GCM', key: Uint8Array, iv: Uint8Array, data: Uint8Array, decrypt: boolean) {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), mode, false, [decrypt ? 'decrypt' : 'encrypt']);
  const params = mode === 'AES-CTR' ? { name: mode, counter: new Uint8Array(iv), length: 128 } : { name: mode, iv: new Uint8Array(iv) };
  const fn = decrypt ? crypto.subtle.decrypt.bind(crypto.subtle) : crypto.subtle.encrypt.bind(crypto.subtle);
  return new Uint8Array(await fn(params, k, new Uint8Array(data)));
}

// bcrypt 반복 횟수는 키 파일에 적힌 값을 그대로 쓰고 화면을 멈춘 채(동기) 계산한다 → 터무니없이 큰 값이면
// 팀 편집자가 넣은 키 하나로 팀원 화면이 멈춘다. ssh-keygen 기본은 16, 흔히 100 안쪽이다 (보안 검토 낮음 항목)
export const MAX_KDF_ROUNDS = 1000;

const pemBody = (text: string) => Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

async function parseOpenSsh(text: string, passphrase?: string | null): Promise<{ keyPair: KeyPair; comment: string }> {
  const data = pemBody(text);
  if (data.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Error(t('OpenSSH 키 형식이 아닙니다'));
  const r = new Reader(data.subarray(MAGIC.length));
  const cipher = r.text();
  const kdf = r.text();
  const kdfOptions = r.bytes();
  if (r.u32() !== 1) throw new Error(t('키가 여러 개 든 파일은 읽지 못합니다'));
  r.bytes(); // 공개키
  let section = Buffer.from(r.bytes());
  if (cipher !== 'none') {
    const info = CIPHERS[cipher];
    if (!info || kdf !== 'bcrypt') throw new Error(t('이 암호 방식({cipher})으로 잠긴 키는 웹에서 읽지 못합니다. 앱에서 사용해 주세요.', { cipher }));
    const o = new Reader(Buffer.from(kdfOptions));
    const salt = Buffer.from(o.bytes());
    const rounds = o.u32();
    if (rounds > MAX_KDF_ROUNDS) throw new Error(t('키 암호 반복 횟수({rounds}회)가 너무 많아 이 키를 읽지 않습니다. ssh-keygen -p -a 100 으로 다시 저장한 키를 사용해 주세요.', { rounds }));
    if (!passphrase) throw new KeyPassphraseError(t('키 암호가 필요합니다'));
    const km = derive(passphrase, salt, rounds, info.keyLen + info.ivLen);
    const input = info.mode === 'AES-GCM' ? Buffer.concat([section, r.rest()]) : section;
    try {
      section = Buffer.from(await aes(info.mode, km.subarray(0, info.keyLen), km.subarray(info.keyLen), input, true));
    } catch {
      throw new KeyPassphraseError(t('키 암호가 틀렸습니다'));
    }
  }
  const p = new Reader(section);
  if (p.u32() !== p.u32()) throw new KeyPassphraseError(t('키 암호가 틀렸습니다'));
  const type = p.text();
  if (type === 'ssh-ed25519') {
    p.bytes();
    const priv = p.bytes();
    const kp = new Ed25519KeyPair();
    await kp.importParameters({ seed: new Uint8Array(priv.subarray(0, 32)) });
    return { keyPair: kp, comment: p.text() };
  }
  if (type.startsWith('ecdsa-sha2-')) {
    const curve = p.text();
    const q = p.bytes();
    const d = p.bytes();
    const n = (q.length - 1) / 2;
    const alg = SshAlgorithms.publicKey[{ nistp256: 'ecdsaSha2Nistp256', nistp384: 'ecdsaSha2Nistp384', nistp521: 'ecdsaSha2Nistp521' }[curve] ?? ''];
    if (!alg) throw new Error(t('지원하지 않는 곡선입니다: {curve}', { curve }));
    const kp = alg.createKeyPair();
    await kp.importParameters({ curve: { name: curve }, x: sshBig(q.subarray(1, 1 + n)), y: sshBig(q.subarray(1 + n)), d: sshBig(d) } as never);
    return { keyPair: kp, comment: p.text() };
  }
  if (type === 'ssh-rsa') {
    const [nn, e, d, iqmp, pp, q] = [p.bytes(), p.bytes(), p.bytes(), p.bytes(), p.bytes(), p.bytes()].map((b) => Buffer.from(unsigned(b)));
    const dBig = toBig(d);
    const kp = SshAlgorithms.publicKey.rsaWithSha512!.createKeyPair();
    await kp.importParameters({
      modulus: sshBig(nn),
      exponent: sshBig(e),
      d: sshBig(d),
      p: sshBig(pp),
      q: sshBig(q),
      dp: sshBig(fromBig(dBig % (toBig(pp) - 1n))),
      dq: sshBig(fromBig(dBig % (toBig(q) - 1n))),
      qi: sshBig(iqmp),
    } as never);
    return { keyPair: kp, comment: p.text() };
  }
  throw new Error(t('이 키 종류({type})는 웹에서 아직 사용할 수 없습니다. 앱에서 사용해 주세요.', { type }));
}

export type ParsedKey = { keyPair: KeyPair; keyType: string; publicKey: string; fingerprint: string };

export async function parsePrivateKey(text: string, passphrase?: string | null, comment?: string): Promise<ParsedKey> {
  const trimmed = text.trim();
  let keyPair: KeyPair;
  let fileComment = '';
  if (trimmed.includes('BEGIN OPENSSH PRIVATE KEY')) {
    const r = await parseOpenSsh(trimmed, passphrase);
    keyPair = r.keyPair;
    fileComment = r.comment;
  } else if (/BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY/.test(trimmed)) {
    if (/ENCRYPTED/.test(trimmed) && !passphrase) throw new KeyPassphraseError(t('키 암호가 필요합니다'));
    try {
      keyPair = await importKey(trimmed, passphrase ?? null);
    } catch (err) {
      if (/decrypt|passphrase/i.test(String((err as Error)?.message))) throw new KeyPassphraseError(t('키 암호가 틀렸습니다'));
      throw new Error(t('개인키를 읽을 수 없습니다: {error}', { error: String((err as Error)?.message ?? err) }));
    }
  } else if (/^(ssh-|ecdsa-)/.test(trimmed)) {
    throw new Error(t('공개키입니다. 개인키를 입력해 주세요.'));
  } else {
    throw new Error(t('알아볼 수 없는 키 형식입니다'));
  }
  if (!keyPair.hasPrivateKey) throw new Error(t('개인키가 아닙니다'));
  const blob = await keyPair.getPublicKeyBytes(keyPair.keyAlgorithmName);
  if (!blob) throw new Error(t('공개키를 만들지 못했습니다'));
  const info = await hostKeyInfo(blob);
  const note = (comment ?? fileComment).trim().replace(/\s+/g, '_').slice(0, 80);
  return { keyPair, keyType: info.keyType, fingerprint: info.fingerprint, publicKey: `${info.keyType} ${blob.toString('base64')}${note ? ` ${note}` : ''}` };
}

// 새 Ed25519 키 (OpenSSH 형식, 암호를 주면 aes256-ctr + bcrypt 로 잠근다) — ssh-keygen 이 만드는 것과 같은 모양
export async function generateEd25519(comment: string, passphrase?: string | null) {
  const kp = new Ed25519KeyPair();
  await kp.generate();
  const pub = Buffer.from(kp.pub!);
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = u32(crypto.getRandomValues(new Uint32Array(1))[0]);
  const blockSize = passphrase ? 16 : 8;
  let section = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([Buffer.from(kp.seed!), pub])), sshString(comment)]);
  const pad = (blockSize - (section.length % blockSize)) % blockSize;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  let cipher = 'none';
  let kdf = 'none';
  let kdfOptions = Buffer.alloc(0);
  if (passphrase) {
    cipher = 'aes256-ctr';
    kdf = 'bcrypt';
    const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
    const rounds = 16;
    kdfOptions = Buffer.concat([sshString(salt), u32(rounds)]);
    const km = derive(passphrase, salt, rounds, 48);
    section = Buffer.from(await aes('AES-CTR', km.subarray(0, 32), km.subarray(32), section, false));
  }
  const body = Buffer.concat([Buffer.from(MAGIC, 'latin1'), sshString(cipher), sshString(kdf), sshString(kdfOptions), u32(1), sshString(pubBlob), sshString(section)]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n');
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const info = await hostKeyInfo(pubBlob);
  const note = comment.trim().replace(/\s+/g, '_').slice(0, 80);
  kp.dispose();
  return { privateKey, keyType: 'ssh-ed25519', fingerprint: info.fingerprint, publicKey: `ssh-ed25519 ${pubBlob.toString('base64')}${note ? ` ${note}` : ''}` };
}

