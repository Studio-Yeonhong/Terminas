// 웹에서 쓰는 SSH: 브라우저 안에서 SSH 를 하고, Terminas 서버는 이미 암호화된 바이트만 전달한다(/api/relay).
// 바탕은 Microsoft dev-tunnels-ssh(WebCrypto). 빠진 것·틀린 것을 여기서 채운다 — 버전은 3.12.42 로 고정해 둔다.
//   · Ed25519(호스트 키·사용자 키) → @noble/curves
//     (curve25519 키 교환은 이 라이브러리가 교환값을 mpint 로 해시해서 절반쯤 틀린다 → 넣지 않았다. ECDH P-256 을 쓴다)
//   · keyboard-interactive 요청에 언어·서브메서드 칸이 빠져 있다(RFC 4256) → 서버가 프로토콜 오류로 끊는다
//   · INFO_REQUEST 를 "프롬프트 전부 → echo 전부" 로 읽는다. 표준은 프롬프트마다 (문자열, echo)
//   · 비밀번호를 주면 keyboard-interactive 를 아예 안 해 본다 → 비밀번호 실패 뒤에 이어서 시도(OTP 서버)
import './polyfill';
import { Buffer } from 'buffer';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AuthenticationInfoRequestMessage,
  AuthenticationRequestMessage,
  ChannelRequestMessage,
  PublicKeyAlgorithm,
  SshDataReader,
  SshDataWriter,
  SshSessionConfiguration,
  type SshClientSession,
  type KeyPair,
  type Signer,
  type Verifier,
} from '@microsoft/dev-tunnels-ssh';
import { t } from '../i18n-core';

// ---------- Ed25519 ----------
export class Ed25519KeyPair implements KeyPair {
  comment: string | null = null;
  pub: Uint8Array | null = null;
  seed: Uint8Array | null = null;
  get keyAlgorithmName() {
    return 'ssh-ed25519';
  }
  get hasPublicKey() {
    return Boolean(this.pub);
  }
  get hasPrivateKey() {
    return Boolean(this.seed);
  }
  async setPublicKeyBytes(bytes: Buffer) {
    const r = new SshDataReader(bytes);
    if (r.readString('ascii') !== 'ssh-ed25519') throw new Error(t('Ed25519 키가 아닙니다'));
    this.pub = new Uint8Array(r.readBinary());
  }
  async getPublicKeyBytes(): Promise<Buffer | null> {
    if (!this.pub) return null;
    const w = new SshDataWriter(Buffer.alloc(64));
    w.writeString('ssh-ed25519', 'ascii');
    w.writeBinary(Buffer.from(this.pub));
    return w.toBuffer();
  }
  async generate() {
    this.seed = ed25519.utils.randomSecretKey();
    this.pub = ed25519.getPublicKey(this.seed);
  }
  async importParameters(p: object) {
    const { seed } = p as { seed: Uint8Array };
    this.seed = seed;
    this.pub = ed25519.getPublicKey(seed);
  }
  async exportParameters() {
    return { seed: this.seed, pub: this.pub };
  }
  dispose() {
    this.seed?.fill(0);
  }
}

class Ed25519Algorithm extends PublicKeyAlgorithm {
  constructor() {
    super('ssh-ed25519', 'ssh-ed25519', 'SHA2-512');
  }
  createKeyPair(): KeyPair {
    return new Ed25519KeyPair();
  }
  async generateKeyPair(): Promise<KeyPair> {
    const k = new Ed25519KeyPair();
    await k.generate();
    return k;
  }
  createSigner(keyPair: KeyPair): Signer {
    const k = keyPair as Ed25519KeyPair;
    return { digestLength: 64, sign: async (data: Buffer) => Buffer.from(ed25519.sign(new Uint8Array(data), k.seed!)), dispose() {} };
  }
  createVerifier(keyPair: KeyPair): Verifier {
    const k = keyPair as Ed25519KeyPair;
    return { digestLength: 64, verify: async (data: Buffer, sig: Buffer) => ed25519.verify(new Uint8Array(sig), new Uint8Array(data), k.pub!), dispose() {} };
  }
}

// ---------- 라이브러리 고치기 (한 번만) ----------
class KbdInteractiveRequest extends AuthenticationRequestMessage {
  protected onWrite(w: SshDataWriter) {
    super.onWrite(w);
    w.writeString('', 'utf8'); // language tag
    w.writeString('', 'utf8'); // submethods
  }
}

type AuthInternals = {
  session: { config: SshSessionConfiguration; sendMessage(m: unknown, c?: unknown): Promise<void> };
  clientAuthenticationMethods: { enqueue(item: { method: string; handler: (c?: unknown) => Promise<void> }): void };
  setCurrentRequest(m: unknown): void;
  requestInteractiveAuthentication(username: string, c?: unknown): Promise<void>;
  authenticateClient(credentials: { username?: string; password?: string }, cancellation?: unknown): Promise<void>;
};

// 메시지 해석 고치기 (한 번만)
let messagesPatched = false;
function patchMessages() {
  if (messagesPatched) return;
  messagesPatched = true;
  (AuthenticationInfoRequestMessage.prototype as unknown as { onRead(r: SshDataReader): void }).onRead = function (this: AuthenticationInfoRequestMessage, r: SshDataReader) {
    this.name = r.readString('utf8');
    this.instruction = r.readString('utf8');
    this.language = r.readString('ascii');
    const n = r.readUInt32();
    this.prompts = [];
    for (let i = 0; i < n; i++) this.prompts.push({ prompt: r.readString('utf8'), echo: r.readBoolean() });
  };
}

// 인증 서비스 고치기: 그 클래스는 패키지 밖으로 나와 있지 않다(깊은 경로로 불러오면 순환 import 가 깨진다)
// → 세션이 서비스를 켤 때 받은 인스턴스의 프로토타입을 한 번 고친다
const patchedAuth = new WeakSet<object>();
function patchAuthService(proto: AuthInternals) {
  if (patchedAuth.has(proto)) return;
  patchedAuth.add(proto);
  proto.requestInteractiveAuthentication = async function (this: AuthInternals, username: string, cancellation?: unknown) {
    const m = new KbdInteractiveRequest();
    m.serviceName = 'ssh-connection';
    m.methodName = 'keyboard-interactive' as AuthenticationRequestMessage['methodName'];
    m.username = username;
    this.setCurrentRequest(m);
    await this.session.sendMessage(m, cancellation);
  };
  const original = proto.authenticateClient;
  proto.authenticateClient = function (this: AuthInternals, credentials, cancellation) {
    // 원래 함수는 첫 await 전에 시도할 방법 줄을 다 만든다 → 돌려받은 직후 줄 끝에 keyboard-interactive 를 붙인다
    const p = original.call(this, credentials, cancellation);
    if (credentials.password && this.session.config.authenticationMethods.includes('keyboard-interactive' as never)) {
      this.clientAuthenticationMethods.enqueue({
        method: 'keyboard-interactive',
        handler: (c) => this.requestInteractiveAuthentication(credentials.username ?? '', c),
      });
    }
    return p;
  };
}

export function prepareSession(session: SshClientSession) {
  const s = session as unknown as { activateService(t: unknown): unknown };
  const activate = s.activateService.bind(session);
  s.activateService = (t: unknown) => {
    const svc = activate(t) as Partial<AuthInternals> | null;
    if (svc && typeof svc.requestInteractiveAuthentication === 'function' && typeof svc.authenticateClient === 'function') patchAuthService(Object.getPrototypeOf(svc) as AuthInternals);
    return svc;
  };
  return session;
}

const ed25519Algorithm = new Ed25519Algorithm();

// 앱(ssh2)과 같은 순서로 호스트 키를 고른다 → 같은 서버면 앱과 같은 지문이 나온다
export function sshConfig() {
  patchMessages();
  const c = new SshSessionConfiguration();
  const pk = c.publicKeyAlgorithms;
  const by = (name: string) => pk.find((a) => a?.name === name) ?? null;
  const order = [ed25519Algorithm, by('ecdsa-sha2-nistp256'), by('ecdsa-sha2-nistp384'), by('ecdsa-sha2-nistp521'), by('rsa-sha2-512'), by('rsa-sha2-256')].filter(Boolean) as PublicKeyAlgorithm[];
  pk.splice(0, pk.length, ...order);
  return c;
}

// 호스트 키 종류 → 그 키로 서명하는 알고리즘 이름 (앱 desktop/src/ssh.js 와 같은 표)
const HOST_KEY_ALGORITHMS: Record<string, string[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

// 이미 아는 서버면 아는 종류의 호스트 키만 받겠다고 알린다 (보안 검토 M-7): 중간자가 처음 보는 종류의 키로
// 협상을 끌고 가 "처음 접속" 창을 띄우지 못하게 한다. available 순서를 지키고, 쓸 수 있는 게 없으면 null (제한 없음)
export function hostKeyAlgorithmsFor(knownTypes: string[], available: string[]): string[] | null {
  const allowed = new Set(knownTypes.flatMap((t) => HOST_KEY_ALGORITHMS[t] ?? []));
  const list = available.filter((a) => allowed.has(a));
  return list.length ? list : null;
}

// 이 연결(세션)만 호스트 키 협상 목록을 줄인다. 설정(config)의 목록은 사용자 키 인증에도 쓰이므로
// (사용자 키 종류가 호스트 키와 다를 수 있다) 그대로 두고, 키 교환 서비스가 협상에 내미는 목록만 바꾼다
export function restrictHostKeys(session: SshClientSession, knownTypes: string[]): string[] | null {
  const kex = (session as unknown as { kexService?: { getPublicKeyAlgorithms(): string[] } | null }).kexService;
  if (!kex || typeof kex.getPublicKeyAlgorithms !== 'function' || !knownTypes.length) return null;
  const only = hostKeyAlgorithmsFor(knownTypes, kex.getPublicKeyAlgorithms());
  if (only) kex.getPublicKeyAlgorithms = () => [...only];
  return only;
}

export function algorithmFor(keyAlgorithmName: string) {
  if (keyAlgorithmName === 'ssh-ed25519') return ed25519Algorithm;
  return null;
}

// ---------- 채널 요청 ----------
export class PtyRequest extends ChannelRequestMessage {
  constructor(
    private cols: number,
    private rows: number,
  ) {
    super('pty-req', true);
  }
  protected onWrite(w: SshDataWriter) {
    super.onWrite(w);
    w.writeString('xterm-256color', 'ascii');
    w.writeUInt32(this.cols);
    w.writeUInt32(this.rows);
    w.writeUInt32(0);
    w.writeUInt32(0);
    w.writeBinary(Buffer.from([0])); // 터미널 모드: 없음(TTY_OP_END)
  }
}

export class WindowChange extends ChannelRequestMessage {
  constructor(
    private cols: number,
    private rows: number,
  ) {
    super('window-change', false);
  }
  protected onWrite(w: SshDataWriter) {
    super.onWrite(w);
    w.writeUInt32(this.cols);
    w.writeUInt32(this.rows);
    w.writeUInt32(0);
    w.writeUInt32(0);
  }
}

export class SubsystemRequest extends ChannelRequestMessage {
  constructor(private subsystem: string) {
    super('subsystem', true);
  }
  protected onWrite(w: SshDataWriter) {
    super.onWrite(w);
    w.writeString(this.subsystem, 'ascii');
  }
}

export class ExecRequest extends ChannelRequestMessage {
  constructor(private command: string) {
    super('exec', true);
  }
  protected onWrite(w: SshDataWriter) {
    super.onWrite(w);
    w.writeString(this.command, 'utf8');
  }
}

// 호스트 키 블롭 → 종류 이름·지문(OpenSSH 와 같은 SHA256:base64)
export async function hostKeyInfo(blob: Uint8Array) {
  const r = new SshDataReader(Buffer.from(blob));
  const keyType = r.readString('ascii');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(blob)));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return { keyType, fingerprint: `SHA256:${btoa(s).replace(/=+$/, '')}` };
}
