// 웹 SFTP 파일 전송 (모두 브라우저 안에서): 브라우저 파일 → 서버, 서버 → 브라우저(디스크), 서버 → 서버.
// 조각 여러 개를 동시에 보내 왕복 지연을 가리고, 받는 쪽은 임시 이름으로 쓴 뒤 바꿔 끼운다(쓰다 끊겨도 원본이 안 망가지게).
import { t } from '../i18n-core';
import { CHUNK, existsError, sftpBase, sftpDir, sftpIsDir, sftpJoin, tmpName, type SftpOps } from './sftp';

const PARALLEL = 16;

// onSkip: 건너뛴 항목(폴더를 가리키는 심볼릭 링크) — 끝나면 화면에 알린다
export type Job = { signal: AbortSignal; onBytes: (n: number) => void; onFile: (name: string) => void; onSkip?: (path: string) => void };

// 폴더 안의 심볼릭 링크가 폴더를 가리키면 따라가지 않는다 — 자기 조상을 가리키는 링크로 복사·받기가 끝없이 커지지 않게.
// 파일을 가리키는 링크는 그 파일 내용을 옮긴다. (맨 위 항목은 사용자가 직접 고른 것이라 따라간다)
export const skipLinkedDir = (e: { link?: boolean; type: 'dir' | 'file' }) => Boolean(e.link) && e.type === 'dir';

const cancelled = (job: Job) => {
  if (job.signal.aborted) throw new Error(t('취소했습니다'));
};

// 조각을 동시에 처리한다: read(off, len) 로 읽어 sink(off, data) 로 넘긴다
async function pump(size: number, read: (off: number, len: number) => Promise<Uint8Array>, sink: (off: number, data: Uint8Array) => Promise<void>, job: Job) {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (!failed && next < size) {
      cancelled(job);
      const off = next;
      next += CHUNK;
      const data = await read(off, Math.min(CHUNK, size - off));
      await sink(off, data);
      job.onBytes(data.length);
    }
  };
  await Promise.allSettled(
    Array.from({ length: PARALLEL }, () =>
      worker().catch((err) => {
        failed ??= err;
      }),
    ),
  );
  if (failed) throw failed;
  cancelled(job);
}

// 원격 파일에서 정확히 len 바이트 (서버가 나눠 줄 수 있다)
function remoteReader(ops: SftpOps, handle: Uint8Array) {
  return async (off: number, len: number) => {
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < len) {
      const chunk = await ops.client.read(handle as never, off + got, len - got);
      if (!chunk || !chunk.length) throw new Error(t('읽는 동안 파일 크기가 바뀌었습니다.'));
      parts.push(chunk);
      got += chunk.length;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
}

async function writeRemote(ops: SftpOps, dest: string, size: number, read: (off: number, len: number) => Promise<Uint8Array>, job: Job, mode = 0o644) {
  const c = ops.client;
  const tmp = tmpName(sftpDir(dest), sftpBase(dest));
  try {
    const h = await c.open(tmp, 'w', mode);
    try {
      await pump(size, read, (off, data) => c.write(h, off, data), job);
    } finally {
      await c.close(h).catch(() => {});
    }
    await c.renameOver(tmp, dest);
  } catch (err) {
    await c.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ---------- 브라우저 파일 → 서버 ----------
export async function uploadFiles(ops: SftpOps, files: { file: File; rel: string }[], destDir: string, overwrite: boolean, job: Job) {
  const dirs = [...new Set(files.flatMap((f) => f.rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const d of dirs) await ops.mkdir(sftpJoin(destDir, d), true);
  for (const { file, rel } of files) {
    cancelled(job);
    const dest = sftpJoin(destDir, rel);
    if (!overwrite && (await ops.client.exists(dest))) throw existsError(dest);
    await writeRemote(ops, dest, file.size, async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()), job);
    job.onFile(dest);
  }
}

// ---------- 서버 → 서버 (같은 서버 안도 된다) ----------
export async function copyRemote(from: SftpOps, to: SftpOps, paths: string[], toDir: string, overwrite: boolean, sameConnection: boolean, job: Job) {
  const one = async (src: string, dst: string, top: string): Promise<void> => {
    cancelled(job);
    // 고른 대상 폴더 밖으로 나가는 경로면 멈춘다 (악성 서버의 파일 이름 대비, 보안 검토 F-02)
    const target = normalize(dst);
    if (target !== top && !target.startsWith(`${top}/`)) throw new Error(t('대상 폴더 밖을 가리키는 항목이 있어 복사를 멈췄습니다.'));
    if (sameConnection && (dst === src || dst.startsWith(`${src}/`))) throw new Error(t('폴더를 자기 안으로 복사할 수 없습니다'));
    const a = await from.client.stat(src);
    if (sftpIsDir(a)) {
      await to.mkdir(dst, true);
      for (const e of await from.listDir(src)) {
        // 윈도우 SFTP 서버는 \ 도 경로 구분자로 읽는다
        if (e.name.includes('\\')) throw new Error(t('이름에 \\가 든 항목({name})은 복사하지 않습니다.', { name: e.name }));
        if (skipLinkedDir(e)) {
          job.onSkip?.(e.path);
          continue;
        }
        await one(e.path, sftpJoin(dst, e.name), top);
      }
      return;
    }
    if (!overwrite && (await to.client.exists(dst))) throw existsError(dst);
    const h = await from.client.open(src, 'r');
    try {
      await writeRemote(to, dst, a.size ?? 0, remoteReader(from, h), job, (a.mode ?? 0o644) & 0o777);
    } finally {
      await from.client.close(h).catch(() => {});
    }
    job.onFile(dst);
  };
  for (const p of paths) {
    // 맨 위 항목도 안쪽 항목과 같이 확인한다
    if (sftpBase(p).includes('\\')) throw new Error(t('이름에 \\가 든 항목({name})은 복사하지 않습니다.', { name: sftpBase(p) }));
    const top = normalize(sftpJoin(toDir, sftpBase(p)));
    await one(p, top, top);
  }
}

// POSIX 경로 정규화 ("."·".."·중복 "/" 정리)
function normalize(p: string) {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

// ---------- 서버 → 브라우저 ----------
type SaveTarget = { write(off: number, data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type FsWindow = {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
  showDirectoryPicker?: (o: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};
const fsw = window as unknown as FsWindow;
export const canPickFolder = typeof fsw.showDirectoryPicker === 'function';

async function streamTarget(handle: { createWritable(): Promise<FileSystemWritableFileStream> }): Promise<SaveTarget> {
  const w = await handle.createWritable();
  return {
    write: (off, data) => w.write({ type: 'write', position: off, data: new Uint8Array(data) }),
    close: () => w.close(),
    abort: () => w.abort(),
  };
}

// 브라우저 저장 창을 못 쓰면 메모리에 모았다가 "내려받기" 로 넘긴다
function blobTarget(name: string, size: number): SaveTarget {
  const parts = new Map<number, Uint8Array>();
  return {
    async write(off, data) {
      parts.set(off, new Uint8Array(data));
    },
    async close() {
      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d as BlobPart);
      const url = URL.createObjectURL(new Blob(ordered, { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      void size;
    },
    async abort() {
      parts.clear();
    },
  };
}

async function readInto(ops: SftpOps, src: string, size: number, target: SaveTarget, job: Job) {
  const h = await ops.client.open(src, 'r');
  try {
    await pump(size, remoteReader(ops, h), (off, data) => target.write(off, data), job);
    await target.close();
  } catch (err) {
    await target.abort().catch(() => {});
    throw err;
  } finally {
    await ops.client.close(h).catch(() => {});
  }
}

// 저장 위치는 사용자 동작(클릭) 안에서 먼저 골라야 한다 → pickDownloadTarget 을 await 없이 먼저 부른다
export async function pickDownloadTarget(entries: { name: string; type: 'dir' | 'file' }[]): Promise<{ kind: 'file'; handle: { createWritable(): Promise<FileSystemWritableFileStream> } } | { kind: 'dir'; handle: FileSystemDirectoryHandle } | { kind: 'blob' } | null> {
  try {
    if (entries.length === 1 && entries[0].type === 'file' && fsw.showSaveFilePicker) return { kind: 'file', handle: await fsw.showSaveFilePicker({ suggestedName: entries[0].name }) };
    if (fsw.showDirectoryPicker && (entries.length > 1 || entries.some((e) => e.type === 'dir'))) return { kind: 'dir', handle: await fsw.showDirectoryPicker({ mode: 'readwrite' }) };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null;
    throw err;
  }
  return { kind: 'blob' };
}

const safeName = (name: string) => {
  const n = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return !n || n === '.' || n === '..' ? '_' : n;
};

export async function downloadTo(ops: SftpOps, paths: string[], target: Exclude<Awaited<ReturnType<typeof pickDownloadTarget>>, null>, overwrite: boolean, job: Job) {
  if (target.kind === 'file') {
    const a = await ops.client.stat(paths[0]);
    await readInto(ops, paths[0], a.size ?? 0, await streamTarget(target.handle), job);
    job.onFile(paths[0]);
    return;
  }
  if (target.kind === 'blob') {
    for (const p of paths) {
      const a = await ops.client.stat(p);
      if (sftpIsDir(a)) throw new Error(t('이 브라우저는 폴더째 받기를 지원하지 않습니다. 크롬·엣지를 사용하거나 파일을 골라 받아 주세요.'));
      await readInto(ops, p, a.size ?? 0, blobTarget(sftpBase(p), a.size ?? 0), job);
      job.onFile(p);
    }
    return;
  }
  const one = async (src: string, dir: FileSystemDirectoryHandle): Promise<void> => {
    cancelled(job);
    const a = await ops.client.stat(src);
    const name = safeName(sftpBase(src));
    if (sftpIsDir(a)) {
      const sub = await dir.getDirectoryHandle(name, { create: true });
      for (const e of await ops.listDir(src)) {
        if (skipLinkedDir(e)) job.onSkip?.(e.path);
        else await one(e.path, sub);
      }
      return;
    }
    if (!overwrite) {
      const exists = await dir.getFileHandle(name).then(
        () => true,
        () => false,
      );
      if (exists) throw existsError(name);
    }
    const fh = await dir.getFileHandle(name, { create: true });
    await readInto(ops, src, a.size ?? 0, await streamTarget(fh), job);
    job.onFile(src);
  };
  for (const p of paths) await one(p, target.handle);
}
