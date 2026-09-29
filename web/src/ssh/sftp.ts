// 브라우저용 SFTP v3 클라이언트 (SSH 채널의 "sftp" 서브시스템 위). 앱(ssh2)의 SFTP 와 같은 작업을 같은 문장으로 돌려준다.
import { Buffer } from 'buffer';
import type { SshChannel } from '@microsoft/dev-tunnels-ssh';
import { t } from '../i18n-core';

const T = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  SETSTAT: 9,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
} as const;
const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 };
const OPEN = { READ: 1, WRITE: 2, CREAT: 8, TRUNC: 0x10, EXCL: 0x20 };
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export const CHUNK = 32 * 1024;
// 받는 SFTP 패킷 한 개의 상한 (OpenSSH 는 256KB 까지 보낸다). 이보다 큰 길이를 적어 보내는 서버는 끊는다 —
// 끝나지 않는 패킷으로 메모리를 채우지 못하게 (공개 전 점검 OS-05)
const MAX_PACKET = 1024 * 1024;

export class SftpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function friendly(code: number, message: string) {
  if (code === FX.NO_SUCH_FILE) return new SftpError(code, t('파일이나 폴더가 없습니다.'));
  if (code === FX.PERMISSION_DENIED) return new SftpError(code, t('권한이 없습니다.'));
  if (code === FX.FAILURE) return new SftpError(code, message && message !== 'Failure' ? t('서버가 작업을 거부했습니다: {error}', { error: message }) : t('서버가 작업을 거부했습니다.'));
  return new SftpError(code, message || t('SFTP 오류'));
}

export type Attrs = { size?: number; mode?: number; mtime?: number; atime?: number };

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) {
    this.parts.push(Buffer.from([v]));
    return this;
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    this.parts.push(b);
    return this;
  }
  u64(v: number) {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(Math.floor(v / 0x100000000), 0);
    b.writeUInt32BE(v >>> 0, 4);
    this.parts.push(b);
    return this;
  }
  str(v: string | Buffer | Uint8Array) {
    const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v);
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }
  attrs(a: Attrs) {
    let flags = 0;
    if (a.size !== undefined) flags |= 1;
    if (a.mode !== undefined) flags |= 4;
    if (a.mtime !== undefined) flags |= 8;
    this.u32(flags);
    if (a.size !== undefined) this.u64(a.size);
    if (a.mode !== undefined) this.u32(a.mode);
    if (a.mtime !== undefined) this.u32(a.atime ?? a.mtime).u32(a.mtime);
    return this;
  }
  packet() {
    const body = Buffer.concat(this.parts);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  }
}

class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  u8() {
    return this.b[this.o++];
  }
  u32() {
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 0x100000000 + lo;
  }
  bytes() {
    const n = this.u32();
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  text() {
    return this.bytes().toString('utf8');
  }
  attrs(): Attrs & { flags: number } {
    const flags = this.u32();
    const a: Attrs & { flags: number } = { flags };
    if (flags & 1) a.size = this.u64();
    if (flags & 2) {
      this.u32();
      this.u32();
    }
    if (flags & 4) a.mode = this.u32();
    if (flags & 8) {
      a.atime = this.u32();
      a.mtime = this.u32();
    }
    if (flags & 0x80000000) {
      const n = this.u32();
      for (let i = 0; i < n; i++) {
        this.bytes();
        this.bytes();
      }
    }
    return a;
  }
}

type Reply = { type: number; r: Reader };

export class SftpClient {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Reply) => void; reject: (e: Error) => void }>();
  private versionWaiter: ((v: Reply) => void) | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  extensions = new Set<string>();
  closed = false;

  private constructor(private channel: SshChannel) {
    channel.onDataReceived((data) => {
      this.feed(Buffer.from(data));
      channel.adjustWindow(data.length);
    });
    channel.onClosed(() => this.fail(new Error(t('SFTP 연결이 끊겼습니다.'))));
  }

  static async start(channel: SshChannel) {
    const c = new SftpClient(channel);
    const version = new Promise<Reply>((resolve) => (c.versionWaiter = resolve));
    await c.send(new Writer().u8(T.INIT).u32(3).packet());
    const v = await version;
    v.r.u32();
    // 확장 이름 목록 (posix-rename@openssh.com 등)
    try {
      for (;;) {
        const name = v.r.text();
        v.r.bytes();
        if (!name) break;
        c.extensions.add(name);
      }
    } catch {}
    return c;
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private feed(data: Buffer) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_PACKET) {
        this.buf = Buffer.alloc(0);
        this.fail(new Error(t('SFTP 서버가 올바르지 않은(너무 큰) 패킷을 보내 연결을 닫았습니다.')));
        void this.channel.close().catch(() => {});
        return;
      }
      if (this.buf.length < 4 + len) break;
      const packet = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const r = new Reader(Buffer.from(packet));
      const type = r.u8();
      if (type === T.VERSION) {
        this.versionWaiter?.({ type, r });
        continue;
      }
      const id = r.u32();
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      p.resolve({ type, r });
    }
  }

  private send(packet: Buffer) {
    // 채널 send 는 창 크기에 맞춰 기다린다. 순서가 섞이지 않게 줄 세운다.
    const next = this.sendChain.then(() => this.channel.send(packet));
    this.sendChain = next.catch(() => {});
    return next;
  }

  private request(type: number, build: (w: Writer) => void): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error(t('SFTP 연결이 끊겼습니다.')));
    const id = this.nextId++ >>> 0;
    const w = new Writer().u8(type).u32(id);
    build(w);
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(w.packet()).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private static status(reply: Reply, okOnly = true) {
    if (reply.type !== T.STATUS) throw new SftpError(FX.FAILURE, t('예상하지 못한 SFTP 응답({type})', { type: reply.type }));
    const code = reply.r.u32();
    let message = '';
    try {
      message = reply.r.text();
    } catch {}
    if (code === FX.OK || (!okOnly && code === FX.EOF)) return code;
    throw friendly(code, message);
  }

  async realpath(path: string) {
    const reply = await this.request(T.REALPATH, (w) => w.str(path));
    if (reply.type !== T.NAME) SftpClient.status(reply);
    reply.r.u32();
    return reply.r.text();
  }
  private async attrsOf(type: number, path: string) {
    const reply = await this.request(type, (w) => w.str(path));
    if (reply.type !== T.ATTRS) SftpClient.status(reply);
    return reply.r.attrs();
  }
  stat(path: string) {
    return this.attrsOf(T.STAT, path);
  }
  lstat(path: string) {
    return this.attrsOf(T.LSTAT, path);
  }
  async readdir(path: string) {
    const h = await this.handle(await this.request(T.OPENDIR, (w) => w.str(path)));
    const out: { filename: string; attrs: Attrs }[] = [];
    try {
      for (;;) {
        const reply = await this.request(T.READDIR, (w) => w.str(h));
        if (reply.type === T.STATUS) {
          SftpClient.status(reply, false);
          break;
        }
        const n = reply.r.u32();
        for (let i = 0; i < n; i++) {
          const filename = reply.r.text();
          reply.r.text();
          out.push({ filename, attrs: reply.r.attrs() });
        }
      }
    } finally {
      await this.close(h).catch(() => {});
    }
    return out;
  }
  private async handle(reply: Reply) {
    if (reply.type !== T.HANDLE) SftpClient.status(reply);
    return Buffer.from(reply.r.bytes());
  }
  async simple(type: number, build: (w: Writer) => void) {
    SftpClient.status(await this.request(type, build));
  }
  mkdir(path: string) {
    return this.simple(T.MKDIR, (w) => w.str(path).attrs({}));
  }
  rmdir(path: string) {
    return this.simple(T.RMDIR, (w) => w.str(path));
  }
  unlink(path: string) {
    return this.simple(T.REMOVE, (w) => w.str(path));
  }
  rename(from: string, to: string) {
    return this.simple(T.RENAME, (w) => w.str(from).str(to));
  }
  chmod(path: string, mode: number) {
    return this.simple(T.SETSTAT, (w) => w.str(path).attrs({ mode }));
  }
  // 덮어쓰기까지 되는 이름 바꾸기 (OpenSSH 확장이 있으면 원자적으로)
  async renameOver(from: string, to: string) {
    if (this.extensions.has('posix-rename@openssh.com')) {
      try {
        return await this.simple(T.EXTENDED, (w) => w.str('posix-rename@openssh.com').str(from).str(to));
      } catch {}
    }
    if (await this.exists(to)) await this.unlink(to);
    await this.rename(from, to);
  }
  async exists(path: string) {
    try {
      await this.lstat(path);
      return true;
    } catch {
      return false;
    }
  }
  async open(path: string, flags: 'r' | 'w', mode = 0o644) {
    const pflags = flags === 'r' ? OPEN.READ : OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC;
    return this.handle(await this.request(T.OPEN, (w) => w.str(path).u32(pflags).attrs(flags === 'w' ? { mode } : {})));
  }
  async read(handle: Buffer, offset: number, length: number): Promise<Buffer | null> {
    const reply = await this.request(T.READ, (w) => w.str(handle).u64(offset).u32(length));
    if (reply.type === T.DATA) return Buffer.from(reply.r.bytes());
    SftpClient.status(reply, false);
    return null;
  }
  write(handle: Buffer, offset: number, data: Uint8Array) {
    return this.simple(T.WRITE, (w) => w.str(handle).u64(offset).str(data));
  }
  close(handle: Buffer) {
    return this.simple(T.CLOSE, (w) => w.str(handle));
  }
  end() {
    this.fail(new Error(t('SFTP 연결을 닫았습니다.')));
    void this.channel.close().catch(() => {});
  }
}

// ---------- 앱의 SFTP 와 같은 모양의 작업들 ----------
export type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; link: boolean; mode?: number };
const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const dirOf = (p: string) => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const isDir = (a: Attrs) => ((a.mode ?? 0) & S_IFMT) === S_IFDIR;
export const existsError = (p: string) => Object.assign(new Error(t('{name}이(가) 이미 있습니다.', { name: base(p) || p })), { code: 'exists' });
export const tmpName = (dir: string, name: string) => join(dir, `.${name}.terminas-${Math.random().toString(16).slice(2, 10)}.part`);

export function sftpOps(c: SftpClient) {
  const listDir = async (dir: string): Promise<Entry[]> => {
    const list = await c.readdir(dir);
    const entries = await Promise.all(
      list
        // 서버가 준 이름은 한 칸짜리 파일 이름이어야 한다 — "/"·NUL·"."·".." 는 경로 탈출에 쓰일 수 있다 (보안 검토 F-02)
        .filter((e) => e.filename !== '' && e.filename !== '.' && e.filename !== '..' && !/[/\0]/.test(e.filename))
        .map(async (e) => {
          const kind = ((e.attrs.mode ?? 0) & S_IFMT) === S_IFLNK ? 'link' : isDir(e.attrs) ? 'dir' : 'file';
          let type: 'dir' | 'file' = kind === 'dir' ? 'dir' : 'file';
          let size = e.attrs.size ?? 0;
          if (kind === 'link') {
            try {
              const t = await c.stat(join(dir, e.filename));
              type = isDir(t) ? 'dir' : 'file';
              size = t.size ?? 0;
            } catch {}
          }
          return { name: e.filename, path: join(dir, e.filename), type, link: kind === 'link', size, mtime: (e.attrs.mtime ?? 0) * 1000, mode: (e.attrs.mode ?? 0) & 0o7777 };
        }),
    );
    return entries;
  };
  const removeRecursive = async (p: string): Promise<void> => {
    const a = await c.lstat(p);
    if (isDir(a)) {
      for (const e of await c.readdir(p)) {
        if (e.filename === '.' || e.filename === '..') continue;
        // "../x" 같은 이름을 따라가면 고른 폴더 밖을 지우게 된다 (보안 검토 F-02)
        if (!e.filename || /[/\\\0]/.test(e.filename)) throw new Error(t('이름이 올바르지 않은 항목({name})이 있어 지우기를 멈췄습니다.', { name: JSON.stringify(e.filename) }));
        await removeRecursive(join(p, e.filename));
      }
      await c.rmdir(p);
      return;
    }
    await c.unlink(p);
  };
  return {
    client: c,
    listDir,
    async list(path: string) {
      const dir = await c.realpath(path);
      return { path: dir, entries: await listDir(dir) };
    },
    async stat(path: string) {
      const a = await c.stat(path);
      return { type: isDir(a) ? ('dir' as const) : ('file' as const), size: a.size ?? 0, mtime: (a.mtime ?? 0) * 1000, mode: (a.mode ?? 0) & 0o7777 };
    },
    async mkdir(path: string, ignoreExisting?: boolean) {
      if (ignoreExisting && (await c.exists(path))) return;
      await c.mkdir(path);
    },
    async rename(from: string, to: string) {
      if (await c.exists(to)) throw existsError(to);
      await c.rename(from, to);
    },
    async remove(paths: string[]) {
      for (const p of paths) {
        if (p === '/') throw new Error(t('루트는 지울 수 없습니다'));
        await removeRecursive(p);
      }
    },
    async chmod(path: string, mode: string) {
      const m = parseInt(mode, 8);
      if (!Number.isInteger(m) || m < 0 || m > 0o7777) throw new Error(t('권한은 0000~7777(8진수)입니다'));
      await c.chmod(path, m);
    },
    async read(path: string, max: number) {
      const a = await c.stat(path);
      if ((a.size ?? 0) > max) throw new Error(t('파일이 너무 커서 여기서 열 수 없습니다.'));
      const h = await c.open(path, 'r');
      const parts: Buffer[] = [];
      try {
        for (let off = 0; ; ) {
          const chunk = await c.read(h, off, CHUNK);
          if (!chunk || !chunk.length) break;
          off += chunk.length;
          // 서버가 알려 준 크기가 아니라 실제로 받은 양으로 센다 — 크기를 속이거나 읽는 사이 커지는 파일 (공개 전 점검 OS-04)
          if (off > max) throw new Error(t('파일이 너무 커서 여기서 열 수 없습니다.'));
          parts.push(chunk);
        }
      } finally {
        await c.close(h).catch(() => {});
      }
      return new Uint8Array(Buffer.concat(parts));
    },
    // 옆에 임시 이름으로 쓰고 다 쓰면 바꿔 끼운다
    async write(path: string, data: Uint8Array) {
      const mode = await c.stat(path).then((a) => (a.mode ?? 0o644) & 0o7777, () => 0o644);
      const tmp = tmpName(dirOf(path), base(path));
      try {
        const h = await c.open(tmp, 'w', mode);
        try {
          await Promise.all(Array.from({ length: Math.ceil(data.length / CHUNK) }, (_, i) => c.write(h, i * CHUNK, data.subarray(i * CHUNK, (i + 1) * CHUNK))));
        } finally {
          await c.close(h);
        }
        await c.renameOver(tmp, path);
      } catch (err) {
        await c.unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}
export type SftpOps = ReturnType<typeof sftpOps>;
export { join as sftpJoin, base as sftpBase, dirOf as sftpDir, isDir as sftpIsDir };
