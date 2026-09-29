// 호스트 하나에 SSH 로 붙는 공용 절차(터미널·SFTP·포트 포워딩):
// 볼트에서 자격증명 풀기 → 없으면 물어보기 → 연결 → 서버 지문 확인 → 추가 인증.
//   앱: PC 에서 서버로 직접(ssh2, 메인 프로세스)
//   웹: 브라우저 안에서 SSH 를 하고 Terminas 서버는 암호화된 바이트만 전달(/api/relay)
import { desktop, type LocalEntry, type SshEvent } from './desktop';
import { t, tk, tMsg } from './i18n-core';
import { credsComplete, ensureLoaded, identityCreds, knownFor, personalVaultId, report, resolveCreds, trustTarget, vaultApi, type Creds } from './vault';
import type { PromptOverlay } from './components/ConnectPrompts';
import type { SftpOps } from './ssh/sftp';
import { detectOs, HOST_OS_EVENT, markProbed, osOf, probeWorthy, rememberLocalOs, shouldProbe } from './os-detect';

export class ConnectError extends Error {}

export type ConnectUi = {
  // 대답이 필요한 질문(자격증명·처음 보는 서버 지문·추가 인증)
  ask: (p: PromptOverlay) => Promise<Record<string, unknown> | null>;
  // 알리기만 하는 것(지문이 바뀜)
  notify: (p: PromptOverlay) => void;
  // 접속은 계속하되 알려야 할 문제(지문 저장 실패 등)
  warn?: (message: string) => void;
  canEdit: boolean;
};

export type SftpApi = {
  list(path: string): Promise<{ path: string; entries: LocalEntry[] }>;
  stat(path: string): Promise<{ type: 'dir' | 'file'; size: number; mtime: number; mode: number }>;
  mkdir(path: string, ignoreExisting?: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  chmod(path: string, mode: string): Promise<void>;
  read(path: string, max: number): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
};

export type SshHandle = {
  id: string;
  home: string;
  label: string;
  vaultId: string;
  backend: 'app' | 'web';
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (d: Uint8Array) => void) => () => void;
  sftp: SftpApi | null;
  // 웹: 파일 전송(브라우저 ↔ 서버, 서버 ↔ 서버)을 브라우저에서 직접 흘리는 데 쓴다
  web: SftpOps | null;
  onClose: (cb: (message: string) => void) => void;
  close: () => void;
};

type Known = { keyType: string; fingerprint: string }[];

// 알려진 호스트 판정: 같은 종류의 키끼리만 비교한다 (서버가 ed25519·ecdsa·rsa 키를 함께 가질 수 있다)
export function hostKeyVerdict(known: Known, keyType: string, fingerprint: string) {
  const same = known.filter((k) => k.keyType === keyType);
  if (!same.length) return { state: 'new' as const, otherTypes: [...new Set(known.map((k) => k.keyType))] };
  if (same.every((k) => k.fingerprint === fingerprint)) return { state: 'ok' as const };
  return { state: 'mismatch' as const, knownFingerprint: same.find((k) => k.fingerprint !== fingerprint)!.fingerprint };
}

const MISMATCH = tk('서버 지문이 저장된 것과 다릅니다. 서버를 다시 설치한 게 아니라면 중간자 공격이 의심되어 연결을 차단했습니다.');

// 서버 기록(ssh_error)에는 오류 문장(주소가 들어갈 수 있다) 대신 정해진 분류만 보낸다. 자세한 문장은 화면에만
const ERROR_CODES = new Set(['auth_failed', 'host_key_mismatch', 'host_key_rejected', 'host_key_type', 'timeout', 'refused', 'dns', 'unreachable', 'reset', 'closed', 'cancelled', 'relay', 'key_error', 'no_sftp', 'negotiation', 'other']);
export const errorCode = (code: unknown) => (typeof code === 'string' && ERROR_CODES.has(code) ? code : 'other');
const codeOf = (err: unknown) => errorCode((err as { code?: unknown } | null)?.code);

// 접속해서 들은 인사말·명령 결과로 OS 를 정해 남기고, 화면에 알린다
async function learnOs(hostId: string, ident: string, release: string) {
  // 명령을 돌렸거나, 돌릴 필요가 없는 서버(윈도우·네트워크 장비)면 이번 확인을 적어 둔다
  if (release || !probeWorthy(ident)) markProbed(hostId);
  const os = detectOs(ident, release);
  // 명령을 안 돌린 접속(인사말만)으로는 이미 아는 OS 를 바꾸지 않는다 — 민트·팝OS 도 인사말엔 Ubuntu 라고 나온다
  if (!os || (!release && osOf({ id: hostId, os: currentOs(hostId) }))) return;
  if (os === osOf({ id: hostId, os: currentOs(hostId) })) return;
  const saved = await vaultApi.setHostOs(hostId, os);
  rememberLocalOs(hostId, saved ? '' : os);
  window.dispatchEvent(new CustomEvent(HOST_OS_EVENT, { detail: { hostId, os } }));
}
const currentOs = (hostId: string) => vaultApi.hostOs(hostId);

async function resolveForConnect(hostId: string, ui: ConnectUi) {
  const { creds: stored, address, port, label, vaultId } = await resolveCreds(hostId);
  // 내가 개인 볼트에 남긴 지문도 함께 확인하므로 미리 불러 둔다
  const pv = personalVaultId();
  if (pv && pv !== vaultId) await ensureLoaded(pv).catch(() => false);
  let creds: Creds = stored;
  if (!credsComplete(creds)) {
    const reply = await ui.ask({ kind: 'auth', username: creds.username, needUsername: !creds.username });
    if (!reply || reply.cancel) throw new ConnectError(t('연결을 취소했습니다.'));
    const username = typeof reply.username === 'string' ? reply.username.trim().slice(0, 120) : '';
    if (typeof reply.identityId === 'string') {
      const pv = personalVaultId();
      const identity = pv ? identityCreds(pv, reply.identityId) : null;
      if (!identity) throw new ConnectError(t('개인 볼트에서 해당 계정 프리셋을 찾을 수 없습니다.'));
      creds = {
        ...creds,
        username: creds.username || username || identity.username,
        password: creds.password ?? identity.password,
        privateKey: creds.privateKey ?? identity.privateKey,
        passphrase: creds.privateKey ? creds.passphrase : identity.passphrase,
      };
      if (reply.remember) await vaultApi.setMyCredential(hostId, reply.identityId).catch(() => {});
    } else {
      creds = { ...creds, username: creds.username || username, password: typeof reply.password === 'string' ? reply.password : creds.password };
    }
    if (!creds.username) throw new ConnectError(t('사용자 이름이 필요합니다.'));
  }
  return { creds, address, port, label, vaultId };
}

const actions = (kind: 'shell' | 'sftp' | 'forward') =>
  kind === 'sftp' ? (['sftp_connect', 'sftp_disconnect'] as const) : kind === 'forward' ? (['forward_start', 'forward_stop'] as const) : (['ssh_connect', 'ssh_disconnect'] as const);

export async function openSsh(hostId: string, kind: 'shell' | 'sftp' | 'forward', ui: ConnectUi, opts: { cols?: number; rows?: number; signal?: AbortSignal } = {}): Promise<SshHandle> {
  const r = await resolveForConnect(hostId, ui);
  if (opts.signal?.aborted) throw new ConnectError(t('연결을 취소했습니다.'));
  if (desktop) return openInApp(hostId, kind, ui, opts, r);
  if (kind === 'forward') throw new ConnectError(t('포트 포워딩은 Terminas 앱에서 실행할 수 있습니다.'));
  return openInBrowser(hostId, kind, ui, opts, r);
}

type Resolved = Awaited<ReturnType<typeof resolveForConnect>>;

// ---------- 앱: PC 에서 직접 ----------
async function openInApp(hostId: string, kind: 'shell' | 'sftp' | 'forward', ui: ConnectUi, opts: { cols?: number; rows?: number; signal?: AbortSignal }, r: Resolved): Promise<SshHandle> {
  const bridge = desktop!;
  const { creds, address, port, label, vaultId } = r;
  const known = knownFor(vaultId, address, port);
  const id = crypto.randomUUID();
  const closers: ((message: string) => void)[] = [];
  const [openAction, closeAction] = actions(kind);
  let ready = false;
  let startedAt = 0;
  let offEvent: () => void = () => {};

  const opened = new Promise<string>((resolve, reject) => {
    offEvent = bridge.ssh.onEvent(id, (ev: SshEvent) => {
      if (ev.t === 'hostkey' && ev.state === 'new') {
        const otherTypes = [...new Set(known.filter((k) => k.keyType !== ev.keyType).map((k) => k.keyType))];
        void ui.ask({ kind: 'hostkey', state: 'new', address, port, keyType: ev.keyType, fingerprint: ev.fingerprint, otherTypes, personal: trustTarget(vaultId) !== vaultId }).then(async (res) => {
          const accept = Boolean(res?.accept);
          // 신뢰하면 이 볼트의 알려진 호스트에 (암호화해서) 남긴다
          if (accept) await vaultApi.trustHost(vaultId, { address, port, keyType: ev.keyType, fingerprint: ev.fingerprint }).catch((err: Error) => ui.warn?.(t('서버 지문을 알려진 호스트에 저장하지 못했습니다: {error}', { error: tMsg(err.message) })));
          bridge.ssh.reply(id, { t: 'hostkey', accept });
        });
      } else if (ev.t === 'hostkey') {
        ui.notify({ kind: 'hostkey', state: 'mismatch', address, port, keyType: ev.keyType, fingerprint: ev.fingerprint, knownFingerprint: ev.knownFingerprint, canEdit: ui.canEdit });
        void report(vaultId, 'hostkey_mismatch', `${address}:${port}`, { hostId });
      } else if (ev.t === 'kbd') {
        void ui.ask({ kind: 'kbd', instructions: ev.instructions, prompts: ev.prompts }).then((res) =>
          bridge.ssh.reply(id, { t: 'kbd', answers: Array.isArray(res?.answers) ? (res!.answers as unknown[]).map((a) => String(a ?? '')) : [] }),
        );
      } else if (ev.t === 'ready') {
        ready = true;
        startedAt = Date.now();
        void report(vaultId, openAction, label, { hostId, via: 'app' });
        resolve(ev.home ?? '/');
      } else if (ev.t === 'os') {
        void learnOs(hostId, ev.ident, ev.release).catch(() => {});
      } else if (ev.t === 'closed') {
        offEvent();
        if (!ready) {
          void report(vaultId, 'ssh_error', label, { hostId, reason: codeOf(ev), via: 'app' });
          return reject(new ConnectError(tMsg(ev.message)));
        }
        void report(vaultId, closeAction, label, { hostId, seconds: (Date.now() - startedAt) / 1000, via: 'app' });
        for (const cb of closers) cb(tMsg(ev.message));
      }
    });
  });

  try {
    await bridge.ssh.open({
      id,
      kind,
      target: { host: address, port, username: creds.username, password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase },
      known,
      cols: opts.cols,
      rows: opts.rows,
      probeOs: shouldProbe({ id: hostId, os: currentOs(hostId) }),
    });
  } catch (err) {
    offEvent();
    throw new ConnectError(tMsg(err instanceof Error ? err.message : String(err)));
  }
  // 연결하는 도중에 탭을 닫으면 끊는다
  const onAbort = () => bridge.ssh.close(id);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const home = await opened.finally(() => opts.signal?.removeEventListener('abort', onAbort));
  const s = bridge.sftp;
  return {
    id,
    home,
    label,
    vaultId,
    backend: 'app',
    write: (data) => bridge.ssh.write(id, data),
    resize: (cols, rows) => bridge.ssh.resize(id, cols, rows),
    onData: (cb) => bridge.ssh.onData(id, cb),
    sftp:
      kind === 'sftp'
        ? {
            list: (p) => s.list(id, p),
            stat: (p) => s.stat(id, p),
            mkdir: (p, ignore) => s.mkdir(id, p, ignore),
            rename: (a, b) => s.rename(id, a, b),
            remove: (paths) => s.remove(id, paths),
            chmod: (p, mode) => s.chmod(id, p, mode),
            read: (p, max) => s.read(id, p, max),
            write: (p, data) => s.write(id, p, data),
          }
        : null,
    web: null,
    onClose: (cb) => closers.push(cb),
    close: () => bridge.ssh.close(id),
  };
}

// ---------- 웹: 브라우저 안에서 SSH, 서버는 중계만 ----------
async function openInBrowser(hostId: string, kind: 'shell' | 'sftp', ui: ConnectUi, opts: { cols?: number; rows?: number; signal?: AbortSignal }, r: Resolved): Promise<SshHandle> {
  const { creds, address, port, label, vaultId } = r;
  const { openBrowserSsh } = await import('./ssh/browser');
  const [openAction, closeAction] = actions(kind);
  let conn;
  // 서버 지문 때문에 멈췄으면 그 분류를 기록한다 (바뀜·신뢰 안 함)
  let hostKeyCode: string | null = null;
  try {
    conn = await openBrowserSsh({
      kind,
      host: address,
      port,
      username: creds.username,
      password: creds.password,
      privateKey: creds.privateKey,
      passphrase: creds.passphrase,
      cols: opts.cols,
      rows: opts.rows,
      signal: opts.signal,
      probeOs: shouldProbe({ id: hostId, os: currentOs(hostId) }),
      onOs: (ident, release) => void learnOs(hostId, ident, release).catch(() => {}),
      // 이미 아는 서버면 아는 종류의 호스트 키로만 협상한다 (보안 검토 M-7)
      knownKeyTypes: [...new Set(knownFor(vaultId, address, port).map((k) => k.keyType))],
      verifyHostKey: async (keyType, fingerprint) => {
        const known = knownFor(vaultId, address, port);
        const v = hostKeyVerdict(known, keyType, fingerprint);
        if (v.state === 'ok') return true;
        if (v.state === 'mismatch') {
          hostKeyCode = 'host_key_mismatch';
          ui.notify({ kind: 'hostkey', state: 'mismatch', address, port, keyType, fingerprint, knownFingerprint: v.knownFingerprint, canEdit: ui.canEdit });
          void report(vaultId, 'hostkey_mismatch', `${address}:${port}`, { hostId });
          return t(MISMATCH);
        }
        const res = await ui.ask({ kind: 'hostkey', state: 'new', address, port, keyType, fingerprint, otherTypes: v.otherTypes, personal: trustTarget(vaultId) !== vaultId });
        if (!res?.accept) {
          hostKeyCode = 'host_key_rejected';
          return t('서버 지문을 신뢰하지 않아 연결을 중단했습니다.');
        }
        await vaultApi.trustHost(vaultId, { address, port, keyType, fingerprint }).catch((err: Error) => ui.warn?.(t('서버 지문을 알려진 호스트에 저장하지 못했습니다: {error}', { error: tMsg(err.message) })));
        return true;
      },
      ask: async (instructions, prompts) => {
        const res = await ui.ask({ kind: 'kbd', instructions, prompts });
        return Array.isArray(res?.answers) ? (res!.answers as unknown[]).map((a) => String(a ?? '')) : null;
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!opts.signal?.aborted) void report(vaultId, 'ssh_error', label, { hostId, reason: hostKeyCode ?? codeOf(err), via: 'web' });
    throw new ConnectError(message);
  }
  const startedAt = Date.now();
  void report(vaultId, openAction, label, { hostId, via: 'web' });
  conn.onClose(() => void report(vaultId, closeAction, label, { hostId, seconds: (Date.now() - startedAt) / 1000, via: 'web' }));
  return {
    id: crypto.randomUUID(),
    home: conn.home,
    label,
    vaultId,
    backend: 'web',
    write: conn.write,
    resize: conn.resize,
    onData: conn.onData,
    sftp: conn.sftp,
    web: conn.sftp,
    onClose: conn.onClose,
    close: conn.close,
  };
}
