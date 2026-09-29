// 데스크톱 앱(Electron)이 preload 로 넣어 주는 기능. 웹 브라우저에서는 undefined.
export type LocalEntry = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; link: boolean; mode?: number };
export type TransferProgress = { jobId: string; bytes: number; files: number; current?: string };
export type UpdateStatus = { state: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'; version?: string; percent?: number; message?: string };
export type ForwardStatus = { ruleId: string; state: 'listening' | 'stopped' | 'error'; message?: string; connections: number; localPort?: number };

export type SshTarget = { host: string; port: number; username: string; password?: string | null; privateKey?: string | null; passphrase?: string | null };
export type SshEvent =
  | { t: 'hostkey'; state: 'new' | 'mismatch'; keyType: string; fingerprint: string; knownFingerprint?: string }
  | { t: 'kbd'; instructions: string; prompts: { prompt: string; echo: boolean }[] }
  | { t: 'ready'; home?: string }
  | { t: 'os'; ident: string; release: string }
  // code: 오류 종류 (서버 기록에는 문구 대신 이것만 보낸다 — connect.ts)
  | { t: 'closed'; message: string; code?: string };
export type HttpSend = { id: string; method: string; url: string; headers: [string, string][]; body: string | null; timeout: number; follow: boolean; insecure: boolean };
export type HttpTiming = { dns: number | null; connect: number | null; tls: number | null; ttfb: number | null; download: number | null; total: number | null };
export type HttpResult =
  | {
      status: number;
      statusText: string;
      httpVersion: string;
      url: string;
      headers: [string, string][];
      body: string;
      size: number;
      rawSize: number;
      truncated: boolean;
      redirects: { status: number; url: string }[];
      remote: { address: string | null; port: number | null } | null;
      tls: { protocol: string | null; cipher: string | null; authorized: boolean; authorizationError: string | null; subject: string | null; issuer: string | null; validTo: string | null } | null;
      timing: HttpTiming;
      error?: undefined;
    }
  | { error: { fail: string; message: string }; total?: number | null };
export type SshReply = { t: 'hostkey'; accept: boolean } | { t: 'kbd'; answers: string[] };
export type KeyInfo = { keyType: string; publicKey: string; fingerprint: string };

export type DesktopBridge = {
  version: string;
  platform: string;
  // apiLevel: 이 화면의 API 수준 (0.3.1 부터 — 서버가 너무 오래된 앱을 426 으로 돌려보낸다)
  api(method: string, path: string, body?: unknown, apiLevel?: number): Promise<{ status: number; data: unknown }>;
  serverUrl(): Promise<string>;
  // 연결된 서버가 공식 서버인지 (0.3.1 부터)
  serverInfo?(): Promise<{ url: string; official: boolean }>;
  login(): Promise<{ ok: boolean; error?: string }>;
  devLogin(email: string): Promise<{ ok: boolean }>;
  // 아이디·비밀번호 로그인·초대 코드 가입 (0.2.9 부터)
  passwordLogin?(id: string, password: string): Promise<{ ok: boolean; error?: string; message?: string }>;
  inviteSignup?(o: { email: string; code: string; name: string; password: string }): Promise<{ ok: boolean; error?: string; message?: string }>;
  // 메뉴·대화상자 언어 (0.2.6 부터 — 옛 앱에는 없다)
  setLang?(lang: string): Promise<void>;
  logout(): Promise<void>;
  changeServer(): Promise<void>;
  unlock: {
    available(): Promise<boolean>;
    remember(userId: string, keyB64: string): Promise<void>;
    recall(userId: string): Promise<string | null>;
    forget(userId: string): Promise<void>;
  };
  // 오프라인 사본 (0.3.0 부터): 이 PC 에 OS 보호 저장소로 감싸 두는 계정 정보·볼트 암호문. 이름은 me·state·audit·vault.<id>
  cache?: {
    available(): Promise<boolean>;
    get(name: string): Promise<string | null>;
    put(name: string, value: string): Promise<boolean>;
    remove(name: string): Promise<void>;
    list(): Promise<string[]>;
    clear(): Promise<void>;
  };
  update: {
    check(): Promise<void>;
    // 업데이트 채널 정식/베타 (0.3.1 부터). prerelease = 지금 앱이 베타 버전인지
    channel?(): Promise<{ channel: 'stable' | 'beta'; prerelease: boolean }>;
    setChannel?(channel: 'stable' | 'beta'): Promise<void>;
    install(): void;
    onStatus(cb: (s: UpdateStatus) => void): () => void;
  };
  pty: {
    shells(): Promise<{ id: string; label: string }[]>;
    spawn(o: { cols: number; rows: number; shell?: string }): Promise<{ id: string; title: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(id: string, cb: (data: string) => void): () => void;
    onExit(id: string, cb: (code: number) => void): () => void;
  };
  // HTTP 요청 도구 (0.2.8 부터 — 옛 앱에는 없다). 요청은 이 PC 에서 바로 나간다
  http?: {
    send(o: HttpSend): Promise<HttpResult>;
    cancel(id: string): void;
  };
  ssh: {
    open(o: { id: string; kind: 'shell' | 'sftp' | 'forward'; target: SshTarget; known: { keyType: string; fingerprint: string }[]; cols?: number; rows?: number; probeOs?: boolean }): Promise<{ id: string }>;
    reply(id: string, msg: SshReply): void;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    close(id: string): void;
    onEvent(id: string, cb: (e: SshEvent) => void): () => void;
    onData(id: string, cb: (data: Uint8Array) => void): () => void;
    generateKey(o: { type: string; comment: string; passphrase?: string | null }): Promise<KeyInfo & { privateKey: string }>;
    inspectKey(o: { privateKey: string; passphrase?: string | null; comment?: string }): Promise<KeyInfo>;
  };
  sftp: {
    list(id: string, path: string): Promise<{ path: string; entries: LocalEntry[] }>;
    stat(id: string, path: string): Promise<{ type: 'dir' | 'file'; size: number; mtime: number; mode: number }>;
    mkdir(id: string, path: string, ignoreExisting?: boolean): Promise<void>;
    rename(id: string, from: string, to: string): Promise<void>;
    remove(id: string, paths: string[]): Promise<void>;
    chmod(id: string, path: string, mode: string): Promise<void>;
    read(id: string, path: string, max: number): Promise<Uint8Array>;
    write(id: string, path: string, data: Uint8Array): Promise<void>;
  };
  fs: {
    home(): Promise<string>;
    roots(): Promise<string[]>;
    list(path: string): Promise<{ path: string; parent: string | null; entries: LocalEntry[] }>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    remove(paths: string[]): Promise<void>;
    copy(paths: string[], destDir: string): Promise<void>;
    join(dir: string, name: string): Promise<string>;
    open(path: string): Promise<void>;
    pathForFile(file: File): string;
  };
  transfer: {
    upload(o: { jobId: string; connId: string; localPaths: string[]; remoteDir: string; overwrite: boolean }): Promise<{ files: number; bytes: number }>;
    download(o: { jobId: string; connId: string; remotePaths: string[]; localDir: string; overwrite: boolean }): Promise<{ files: number; bytes: number }>;
    copy(o: { jobId: string; fromConn: string; toConn: string; paths: string[]; toDir: string; overwrite: boolean }): Promise<{ files: number; bytes: number }>;
    cancel(jobId: string): void;
    onProgress(cb: (p: TransferProgress) => void): () => void;
  };
  forward: {
    start(o: { ruleId: string; connId: string; bindAddress: string; localPort: number; remoteHost: string; remotePort: number }): Promise<ForwardStatus>;
    stop(ruleId: string): Promise<void>;
    list(): Promise<ForwardStatus[]>;
    onStatus(cb: (s: ForwardStatus) => void): () => void;
  };
};

const bridge = (window as unknown as { studioDesktop?: DesktopBridge }).studioDesktop;

export const desktop: DesktopBridge | undefined = bridge && typeof bridge.api === 'function' ? bridge : undefined;

// 0.1.x 앱: 화면을 서버에서 받아 오던 옛 앱. 새 화면과 맞지 않으니 업데이트만 하게 한다.
export type LegacyBridge = Pick<DesktopBridge, 'version' | 'platform' | 'update'>;
export const legacyApp: LegacyBridge | undefined = bridge && !desktop ? bridge : undefined;
