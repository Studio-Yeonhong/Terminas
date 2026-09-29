// 웹 접속: 브라우저 ─(WebSocket, SSH 로 이미 암호화된 바이트)─▶ Terminas 서버 /api/relay ─TCP─▶ SSH 서버
// 서버 지문 확인·인증·셸·SFTP 는 모두 이 브라우저 안에서 한다. 서버는 비밀번호·키·화면 내용을 볼 수 없다.
import './polyfill';
import { Buffer } from 'buffer';
import { AuthenticationInfoResponseMessage, ChannelRequestMessage, SshAuthenticationType, SshClientSession, SshDisconnectReason, WebSocketStream, type SshChannel } from '@microsoft/dev-tunnels-ssh';
import { ExecRequest, hostKeyInfo, prepareSession, PtyRequest, restrictHostKeys, sshConfig, SubsystemRequest, WindowChange } from './engine';
import { t, tk, tMsg } from '../i18n-core';
import { OS_PROBE, probeWorthy } from '../os-detect';
import { KeyPassphraseError, parsePrivateKey } from './keys';
import { SftpClient, sftpOps, type SftpOps } from './sftp';

export type BrowserSshOptions = {
  kind: 'shell' | 'sftp';
  host: string;
  port: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  cols?: number;
  rows?: number;
  signal?: AbortSignal;
  // 서버 지문을 믿을지 (알려진 호스트 확인·처음 보는 서버는 물어보기). 못 믿으면 그 이유 문장
  verifyHostKey: (keyType: string, fingerprint: string) => Promise<true | string>;
  // 이 서버에 대해 이미 저장된 호스트 키 종류 — 있으면 그 종류로만 협상한다 (보안 검토 M-7)
  knownKeyTypes?: string[];
  // 추가 인증(OTP 등): 대답 목록, 취소면 null
  ask: (instructions: string, prompts: { prompt: string; echo: boolean }[]) => Promise<string[] | null>;
  // OS 알아보기: 인사말은 늘 넘기고, probeOs 면 읽기 전용 명령(OS_PROBE)도 한 번 돌린다
  probeOs?: boolean;
  onOs?: (ident: string, release: string) => void;
};

// 짧은 명령 하나를 돌려 출력(최대 max 자)을 받는다. 실패·시간 초과면 받은 데까지
async function execSmall(session: SshClientSession, command: string, ms = 4000, max = 16384): Promise<string> {
  const ch = await session.openChannel();
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const decoder = new TextDecoder();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void ch.close().catch(() => {});
      resolve(out.slice(0, max));
    };
    const timer = setTimeout(finish, ms);
    ch.onDataReceived((d) => {
      out += decoder.decode(d, { stream: true });
      ch.adjustWindow(d.length);
      if (out.length >= max) finish();
    });
    ch.onExtendedDataReceived((e) => ch.adjustWindow(e.data.length));
    ch.onClosed(finish);
    ch.request(new ExecRequest(command)).then((ok) => !ok && finish(), finish);
  });
}

export type BrowserSsh = {
  home: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (d: Uint8Array) => void): () => void;
  sftp: SftpOps | null;
  onClose(cb: (message: string) => void): void;
  close(): void;
};

export class RelayError extends Error {
  code = 'relay';
}

// 아는 종류로만 협상했는데 서버가 다른 종류의 호스트 키만 내밀었을 때 (앱 desktop/src/ssh.js 와 같은 문장)
export const HOST_KEY_TYPE_MESSAGE = tk('이 서버가 저장된 것과 다른 종류의 호스트 키만 제시했습니다. 서버를 다시 설치한 게 아니라면 중간자 공격이 의심되어 연결을 차단했습니다. 바뀐 게 확실하면 알려진 호스트에서 이 서버 항목을 지운 뒤 다시 연결해 주세요.');

// 오류에 정해진 분류(code)를 붙인다 — 서버 기록에는 문장(주소가 들어갈 수 있다) 대신 이것만 보낸다
const coded = (err: unknown, code: string) => Object.assign(err instanceof Error ? err : new Error(String(err)), { code });

function relayUrl(host: string, port: number) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/relay?host=${encodeURIComponent(host)}&port=${port}`;
}

// 중계 연결을 열고, 서버가 "SSH 서버 맞음(open)" 을 알려 줄 때까지 기다린다
function openRelay(host: string, port: number, signal?: AbortSignal): Promise<{ socket: WebSocket; early: ArrayBuffer[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl(host, port));
    socket.binaryType = 'arraybuffer';
    const early: ArrayBuffer[] = [];
    let opened = false;
    const onAbort = () => socket.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        early.push(ev.data as ArrayBuffer);
        return;
      }
      let msg: { t?: string; message?: string } = {};
      try {
        msg = JSON.parse(ev.data);
      } catch {}
      if (msg.t === 'open' && !opened) {
        opened = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({ socket, early });
      } else if (msg.t === 'error') {
        reject(new RelayError(msg.message == null ? t('연결하지 못했습니다.') : tMsg(msg.message)));
      }
    };
    socket.onclose = (ev) => {
      if (opened) return;
      signal?.removeEventListener('abort', onAbort);
      reject(new RelayError(signal?.aborted ? t('연결을 취소했습니다.') : ev.code === 4401 ? t('로그인이 만료되었습니다. 새로고침해 주세요.') : ev.code === 4429 ? t('동시에 열 수 있는 연결이 너무 많습니다.') : t('서버에 연결하지 못했습니다.')));
    };
  });
}

// dev-tunnels-ssh 의 WebSocketStream 에 바이너리만 넘긴다 (중계 서버의 안내 문자열은 여기서 거른다)
function binaryOnly(socket: WebSocket, early: ArrayBuffer[]) {
  let handler: ((e: { data: ArrayBuffer }) => void) | null = null;
  const queue = [...early];
  const like = {
    get protocol() {
      return socket.protocol;
    },
    get onmessage() {
      return handler;
    },
    set onmessage(h: ((e: { data: ArrayBuffer }) => void) | null) {
      handler = h;
      if (h) for (const data of queue.splice(0)) h({ data });
    },
    onclose: null as ((e: { code: number; reason: string; wasClean: boolean }) => void) | null,
    send: (data: ArrayBuffer) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code, reason),
  };
  socket.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    if (handler) handler({ data: ev.data as ArrayBuffer });
    else queue.push(ev.data as ArrayBuffer);
  };
  socket.onclose = (ev) => like.onclose?.({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
  return like;
}

// 오류 → 화면 문장과 분류. restricted = 아는 종류의 호스트 키로만 협상했는지
function friendly(err: unknown, restricted: boolean): { message: string; code: string } {
  const m = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof RelayError) return { message: m, code: 'relay' };
  if (err instanceof KeyPassphraseError) return { message: m, code: 'key_error' };
  // dev-tunnels-ssh: "Failed PublicKey negotiation: Server (…) Client (…)" — 아는 종류로만 협상했는데 서버가 다른 종류만 내밀었다 (M-7)
  if (restricted && /PublicKey negotiation/i.test(m)) return { message: t(HOST_KEY_TYPE_MESSAGE), code: 'host_key_type' };
  if (typeof code === 'string') return { message: m, code };
  if (/negotiat|no matching|algorithm/i.test(m)) return { message: t('서버와 맞는 암호 방식이 없습니다({error}). 앱에서 접속해 보세요.', { error: m }), code: 'negotiation' };
  return { message: m, code: 'other' };
}

export async function openBrowserSsh(o: BrowserSshOptions): Promise<BrowserSsh> {
  const { socket, early } = await openRelay(o.host, o.port, o.signal);
  const session = prepareSession(new SshClientSession(sshConfig()));
  const restricted = restrictHostKeys(session, o.knownKeyTypes ?? []) !== null;
  let rejectMessage: string | null = null;
  let rejectCode: string | null = null;
  let passwordUsed = false;
  const closers: ((message: string) => void)[] = [];
  let closed = false;
  const finish = (message: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closers) cb(message);
  };

  session.onAuthenticating((e) => {
    if (e.authenticationType === SshAuthenticationType.serverPublicKey && e.publicKey) {
      const key = e.publicKey;
      e.authenticationPromise = (async () => {
        const blob = await key.getPublicKeyBytes(key.keyAlgorithmName);
        if (!blob) return null;
        const { keyType, fingerprint } = await hostKeyInfo(blob);
        const verdict = await o.verifyHostKey(keyType, fingerprint);
        if (verdict !== true) {
          rejectMessage = rejectMessage ?? verdict;
          rejectCode = rejectCode ?? 'host_key_rejected';
        }
        return verdict === true ? {} : null;
      })();
    } else if (e.authenticationType === SshAuthenticationType.clientInteractive && e.infoRequest) {
      const req = e.infoRequest;
      e.authenticationPromise = (async () => {
        const prompts = req.prompts ?? [];
        // 비밀번호 칸은 저장된 비밀번호로 한 번 채우고, 나머지(OTP 등)만 묻는다
        const pwIndex = o.password && !passwordUsed ? prompts.findIndex((p) => !p.echo && /password|암호|비밀번호/i.test(p.prompt)) : -1; // i18n-ignore
        const rest = prompts.map((p, i) => ({ ...p, i })).filter((p) => p.i !== pwIndex);
        const answers = prompts.map(() => '');
        if (pwIndex >= 0) {
          answers[pwIndex] = o.password!;
          passwordUsed = true;
        }
        if (rest.length) {
          const given = await o.ask(req.instruction ?? '', rest.map(({ prompt, echo }) => ({ prompt, echo })));
          if (!given) {
            rejectMessage = t('연결을 취소했습니다.');
            rejectCode = 'cancelled';
          }
          rest.forEach((p, j) => (answers[p.i] = given?.[j] ?? ''));
        }
        const res = new AuthenticationInfoResponseMessage();
        res.responses = answers;
        e.infoResponse = res;
        return null;
      })();
    }
  });
  session.onClosed((e) => {
    socket.close();
    finish(rejectMessage ?? (e.message && !/disconnect/i.test(e.message) ? tMsg(e.message) : t('연결이 종료되었습니다.')));
  });

  try {
    await session.connect(new WebSocketStream(binaryOnly(socket, early)));
    let keyPair = null;
    if (o.privateKey)
      keyPair = (
        await parsePrivateKey(o.privateKey, o.passphrase).catch((err) => {
          throw coded(err, 'key_error');
        })
      ).keyPair;
    const ok = await session.authenticate({ username: o.username, password: o.password ?? undefined, publicKeys: keyPair ? [keyPair] : undefined });
    if (!ok) throw coded(new Error(rejectMessage ?? t('인증에 실패했습니다. 사용자 이름·비밀번호·키를 확인해 주세요.')), rejectCode ?? 'auth_failed');
    if (o.signal?.aborted) throw coded(new Error(t('연결을 취소했습니다.')), 'cancelled');

    const channel: SshChannel = await session.openChannel();
    // 접속이 자리 잡은 뒤 OS 를 알아본다 (실패해도 접속에는 영향 없음)
    const reportOs = () =>
      setTimeout(async () => {
        if (!o.onOs || closed) return;
        const ident = String(session.remoteVersion?.toString() ?? '').slice(0, 255);
        const release = o.probeOs && probeWorthy(ident) ? await execSmall(session, OS_PROBE).catch(() => '') : '';
        if (!closed) o.onOs(ident, release);
      }, 300);
    if (o.kind === 'sftp') {
      if (!(await channel.request(new SubsystemRequest('sftp')))) throw coded(new Error(t('이 서버는 SFTP를 지원하지 않습니다.')), 'no_sftp');
      const client = await SftpClient.start(channel);
      const ops = sftpOps(client);
      const home = await client.realpath('.').catch(() => '/');
      channel.onClosed(() => finish(t('SFTP 연결이 종료되었습니다.')));
      reportOs();
      return {
        home,
        write() {},
        resize() {},
        onData: () => () => {},
        sftp: ops,
        onClose: (cb) => closers.push(cb),
        close: () => void session.close(SshDisconnectReason.byApplication).catch(() => socket.close()),
      };
    }

    const listeners = new Set<(d: Uint8Array) => void>();
    const buffered: Uint8Array[] = [];
    const emit = (d: Uint8Array) => {
      if (listeners.size) for (const l of listeners) l(d);
      else buffered.push(d);
    };
    channel.onDataReceived((d) => {
      emit(new Uint8Array(d));
      channel.adjustWindow(d.length);
    });
    channel.onExtendedDataReceived((e) => {
      emit(new Uint8Array(e.data));
      channel.adjustWindow(e.data.length);
    });
    channel.onClosed(() => {
      finish(t('셸이 종료되었습니다.'));
      void session.close(SshDisconnectReason.byApplication).catch(() => {});
    });
    await channel.request(new PtyRequest(o.cols ?? 80, o.rows ?? 24));
    if (!(await channel.request(new ChannelRequestMessage('shell', true)))) throw new Error(t('셸을 열지 못했습니다.'));
    reportOs();

    // 입력 순서가 섞이지 않게 줄 세운다
    let chain: Promise<void> = Promise.resolve();
    return {
      home: '',
      write: (data) => {
        chain = chain.then(() => channel.send(Buffer.from(data, 'utf8'))).catch(() => {});
      },
      resize: (cols, rows) => void channel.request(new WindowChange(cols, rows)).catch(() => {}),
      onData: (cb) => {
        listeners.add(cb);
        for (const d of buffered.splice(0)) cb(d);
        return () => listeners.delete(cb);
      },
      sftp: null,
      onClose: (cb) => closers.push(cb),
      close: () => void session.close(SshDisconnectReason.byApplication).catch(() => socket.close()),
    };
  } catch (err) {
    const f = friendly(err, restricted);
    closed = true;
    void session.close(SshDisconnectReason.byApplication).catch(() => {});
    socket.close();
    throw coded(new Error(rejectMessage ?? f.message), rejectCode ?? f.code);
  }
}
