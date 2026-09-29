import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine, ArrowRightLeft, ArrowUp, ArrowUpFromLine, ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, File as FileIcon, FilePen, Folder,
  FolderOpen, FolderPlus, HardDrive, KeyRound, Loader2, Monitor, MoreHorizontal, Pencil, RefreshCw, RotateCw, Search, Server, Trash2, Upload, X,
} from 'lucide-react';
import { errorMessage, type Host } from '../api';
import { useStore } from '../store';
import { desktop, type TransferProgress } from '../desktop';
import { openSsh, type SshHandle } from '../connect';
import { canPickFolder, copyRemote, downloadTo, pickDownloadTarget, uploadFiles, type Job } from '../ssh/transfer';
import { allHosts } from '../vault';
import { Button, IconButton, Input, Modal, Textarea, colorFor, useMenu, type MenuItem } from './ui';
import { ConnectPrompt, type PromptOverlay } from './ConnectPrompts';
import { HostGlyph } from './OsIcon';
import { osOf } from '../os-detect';
import { locale, t, tk, tMsg } from '../i18n';

// ---------- 공용 ----------
type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; link: boolean; mode?: number };
type Listing = { path: string; parent: string | null; entries: Entry[] };
type Side = 'left' | 'right';

type Adapter = {
  kind: 'remote' | 'local';
  label: string;
  conn?: SshHandle;
  list(path: string): Promise<Listing>;
  mkdir(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  remove(paths: string[]): Promise<unknown>;
  join(dir: string, name: string): Promise<string>;
  chmod?(path: string, mode: string): Promise<unknown>;
};

const pjoin = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const pdirname = (p: string) => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// 원격: 앱은 PC 에서 직접, 웹은 브라우저 안에서(서버는 중계만) 연 SFTP 연결
function remoteAdapter(conn: SshHandle, label: string): Adapter {
  const sftp = conn.sftp!;
  return {
    kind: 'remote',
    label,
    conn,
    async list(path) {
      const r = await sftp.list(path);
      return { path: r.path, parent: r.path === '/' ? null : pdirname(r.path), entries: r.entries };
    },
    mkdir: (path) => sftp.mkdir(path),
    rename: (from, to) => sftp.rename(from, to),
    remove: (paths) => sftp.remove(paths),
    join: async (dir, name) => pjoin(dir, name),
    chmod: (path, mode) => sftp.chmod(path, mode),
  };
}

// 로컬 창의 이름표 — 반대편이 로컬인지 이 키로 가린다 (보여 줄 때만 번역)
const LOCAL = tk('내 컴퓨터');
const shownLabel = (label: string) => (label === LOCAL ? t(LOCAL) : label);

function localAdapter(): Adapter {
  const fs = desktop!.fs;
  return {
    kind: 'local',
    label: LOCAL,
    list: (path) => fs.list(path),
    mkdir: (path) => fs.mkdir(path),
    rename: (from, to) => fs.rename(from, to),
    remove: (paths) => fs.remove(paths),
    join: (dir, name) => fs.join(dir, name),
  };
}

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function kindOf(e: Entry) {
  if (e.type === 'dir') return t('폴더');
  const dot = e.name.lastIndexOf('.');
  return dot > 0 ? t('{ext} 파일', { ext: e.name.slice(dot + 1).toLowerCase() }) : t('파일');
}

function modeString(mode: number) {
  return [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((b, i) => (mode & b ? 'rwx'[i % 3] : '-')).join('');
}

function segments(p: string): { label: string; path: string }[] {
  // 앱의 Windows 로컬 경로: 맨 앞은 드라이브 목록("내 PC")
  if (p === '') return [{ label: t('내 PC'), path: '' }];
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    const parts = p.split(/[\\/]+/).filter(Boolean);
    return [{ label: t('내 PC'), path: '' }, ...parts.map((part, i) => ({ label: part, path: i === 0 ? `${part}\\` : `${parts.slice(0, i + 1).join('\\')}` }))];
  }
  const parts = p.split('/').filter(Boolean);
  return [{ label: '/', path: '/' }, ...parts.map((part, i) => ({ label: part, path: `/${parts.slice(0, i + 1).join('/')}` }))];
}

const TEXT_LIMIT = 2 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|log|json|ya?ml|conf|cfg|ini|env|toml|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|html?|css|scss|xml|sql|service|properties|go|rs|java|kt|c|h|cpp|hpp|cs|php|rb|lua|vue|svelte|csv|tsv|pem|pub)$/i;
const isTextName = (name: string) => TEXT_EXT.test(name) || !name.includes('.') || (name.startsWith('.') && name.indexOf('.', 1) < 0);

// 끌어다 놓은 폴더까지 파일 목록으로 펼친다 (웹)
async function collectDropped(items: DataTransferItemList, files: FileList): Promise<{ file: File; rel: string }[]> {
  const out: { file: File; rel: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: `${prefix}${entry.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...files].map((file) => ({ file, rel: file.name }));
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------- 끌어다 놓기 표 (보안 검토 M-10) ----------
// 창끼리 끌어다 놓을 때 경로는 이 창의 메모리에만 두고, 끌기 데이터에는 무작위 표만 싣는다.
// 다른 웹페이지·앱이 우리 형식을 흉내 내 놓아도 표가 맞지 않으면 무시한다 → 공격자가 고른 로컬 파일을 올리거나
// \\공격자\공유 경로를 건드리게 해서(Windows 로그인 해시 유출) 쓸 수 없다
const DRAG_TYPE = 'application/x-studio-sftp';
type DragPayload = { side: Side; paths: string[]; adapter: Adapter };
let activeDrag: { nonce: string; payload: DragPayload } | null = null;
function beginDrag(payload: DragPayload): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  activeDrag = { nonce, payload };
  return nonce;
}
// 놓을 때: 이 창에서 시작한 끌기의 표와 같을 때만 경로를 한 번 돌려준다
function takeDrag(nonce: unknown): DragPayload | null {
  const cur = activeDrag;
  if (!cur || typeof nonce !== 'string' || nonce !== cur.nonce) return null;
  activeDrag = null;
  return cur.payload;
}
// 끌기가 끝나면(놓았든 취소했든) 표를 버린다 — 창 밖으로 끌려 나간 표를 누가 다시 들고 와도 쓸 수 없게
function endDrag() {
  activeDrag = null;
}
// Windows 네트워크 공유(UNC)·장치 경로 — 건드리기만 해도 그 서버로 Windows 로그인(NTLM)을 시도한다
const isUncPath = (p: string) => /^[\\/]{2}/.test(p);
// ---------- 끌어다 놓기 표 끝 ----------

// ---------- 전송 목록 ----------
// 같은 이름이 있어 멈춘 전송인지 — 번역된 문구 말고 원문·code 로 가린다
const isExists = (err: unknown) => (err as { code?: string } | null)?.code === 'exists' || /exists|이미 있습니다/.test(err instanceof Error ? err.message : String(err)); // i18n-ignore
type Transfer = {
  id: string;
  name: string;
  from: string;
  to: string;
  direction: 'up' | 'down' | 'copy';
  bytes: number;
  total: number | null;
  files: number;
  state: 'running' | 'done' | 'error';
  error?: string;
  cancel?: () => void;
  // 따라가지 않고 건너뛴 항목(폴더를 가리키는 심볼릭 링크)
  skipped?: string[];
};

// 앱 전송 결과에서 건너뛴 항목을 꺼낸다
const skippedOf = (result: unknown): Partial<Transfer> => {
  const list = (result as { skipped?: unknown } | null | undefined)?.skipped;
  return Array.isArray(list) && list.length ? { skipped: list.map(String) } : {};
};

type PaneHandle = { adapter: Adapter | null; cwd: string; refresh: () => void };

// ---------- 화면 ----------
export function SftpScreen({ visible }: { visible: boolean }) {
  const s = useStore();
  const [sources, setSources] = useState<Record<Side, { kind: 'local' } | { kind: 'remote'; host: Host; nonce: number } | null>>(() => ({
    left: desktop ? { kind: 'local' } : null,
    right: null,
  }));
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [showTransfers, setShowTransfers] = useState(false);
  const [labels, setLabels] = useState<Record<Side, string | null>>({ left: null, right: null });
  const handles = useRef<Record<Side, PaneHandle>>({ left: { adapter: null, cwd: '', refresh: () => {} }, right: { adapter: null, cwd: '', refresh: () => {} } });

  const patch = useCallback((id: string, p: Partial<Transfer>) => setTransfers((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t))), []);
  const addTransfer = useCallback((t: Transfer) => {
    setTransfers((ts) => [t, ...ts].slice(0, 100));
    setShowTransfers(true);
  }, []);

  const onProgress = useCallback((p: TransferProgress) => patch(p.jobId, { bytes: p.bytes, files: p.files }), [patch]);
  useEffect(() => desktop?.transfer.onProgress(onProgress), [onProgress]);

  // 호스트 화면에서 "SFTP 로 열기"
  useEffect(() => {
    const req = s.sftpRequest;
    if (!req) return;
    setSources((cur) => {
      const side: Side = cur.left && !(cur.left.kind === 'local' && !cur.right) ? 'right' : cur.left ? 'right' : 'left';
      return { ...cur, [side]: { kind: 'remote', host: req.host, nonce: req.nonce } };
    });
  }, [s.sftpRequest]);

  // from 창의 paths 를 to 창의 dir 로 보낸다 (방향에 따라 복사·업로드·다운로드)
  const transfer = useCallback(
    async (fromSide: Side, paths: string[], toSide: Side, toDir?: string, overwrite = false): Promise<void> => {
      const from = handles.current[fromSide];
      const to = handles.current[toSide];
      if (!from.adapter || !to.adapter || !paths.length) return;
      const destDir = toDir ?? to.cwd;
      const jobId = crypto.randomUUID();
      const direction = from.adapter.kind === 'local' && to.adapter.kind === 'remote' ? 'up' : from.adapter.kind === 'remote' && to.adapter.kind === 'local' ? 'down' : 'copy';
      addTransfer({
        id: jobId,
        name: paths.length === 1 ? basename(paths[0]) : t('{name} 외 {count}개', { name: basename(paths[0]), count: paths.length - 1 }),
        from: shownLabel(from.adapter.label),
        to: shownLabel(to.adapter.label),
        direction,
        bytes: 0,
        total: null,
        files: 0,
        state: 'running',
        cancel: from.adapter.kind === 'local' && to.adapter.kind === 'local' ? undefined : desktop ? () => desktop!.transfer.cancel(jobId) : () => ac.abort(),
      });
      const ac = new AbortController();
      try {
        let result: unknown;
        if (from.adapter.kind === 'remote' && to.adapter.kind === 'remote') {
          if (desktop) result = await desktop.transfer.copy({ jobId, fromConn: from.adapter.conn!.id, toConn: to.adapter.conn!.id, paths, toDir: destDir, overwrite });
          else await copyRemote(from.adapter.conn!.web!, to.adapter.conn!.web!, paths, destDir, overwrite, from.adapter.conn === to.adapter.conn, webJob(jobId, ac));
        } else if (direction === 'up') {
          result = await desktop!.transfer.upload({ jobId, connId: to.adapter.conn!.id, localPaths: paths, remoteDir: destDir, overwrite });
        } else if (direction === 'down') {
          result = await desktop!.transfer.download({ jobId, connId: from.adapter.conn!.id, remotePaths: paths, localDir: destDir, overwrite });
        } else {
          await desktop!.fs.copy(paths, destDir);
        }
        patch(jobId, { state: 'done', ...skippedOf(result) });
      } catch (err) {
        const exists = isExists(err);
        if (exists && !overwrite) {
          setTransfers((ts) => ts.filter((t) => t.id !== jobId));
          const ok = await s.confirm({ title: t('같은 이름이 있습니다'), message: t('{error} 덮어쓸까요?', { error: errorMessage(err) }), confirmLabel: t('덮어쓰기'), danger: true });
          if (ok) return transfer(fromSide, paths, toSide, toDir, true);
          return;
        }
        patch(jobId, { state: 'error', error: errorMessage(err) });
      }
      to.refresh();
    },
    [addTransfer, patch, s], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 웹 전송의 진행을 전송 목록에 반영한다
  const webJob = useCallback(
    (jobId: string, ac: AbortController): Job => {
      let bytes = 0;
      let files = 0;
      let last = 0;
      const skipped: string[] = [];
      return {
        signal: ac.signal,
        onBytes: (n) => {
          bytes += n;
          const now = Date.now();
          if (now - last > 200) {
            last = now;
            patch(jobId, { bytes });
          }
        },
        onFile: () => patch(jobId, { bytes, files: ++files }),
        onSkip: (p) => {
          if (skipped.length < 200) skipped.push(p);
          patch(jobId, { skipped: [...skipped] });
        },
      };
    },
    [patch],
  );

  // 웹: 브라우저 파일(끌어다 놓기·파일 고르기)을 원격 창에 올린다
  const uploadBrowserFiles = useCallback(
    async (side: Side, files: { file: File; rel: string }[], toDir?: string, overwrite = false): Promise<void> => {
      const to = handles.current[side];
      if (!to.adapter?.conn?.web || !files.length) return;
      const destDir = toDir ?? to.cwd;
      const jobId = crypto.randomUUID();
      const ac = new AbortController();
      addTransfer({
        id: jobId,
        name: files.length === 1 ? files[0].rel : t('{name} 외 {count}개', { name: files[0].rel.split('/')[0], count: files.length - 1 }),
        from: t('이 브라우저'),
        to: to.adapter.label,
        direction: 'up',
        bytes: 0,
        total: files.reduce((n, f) => n + f.file.size, 0),
        files: 0,
        state: 'running',
        cancel: () => ac.abort(),
      });
      try {
        await uploadFiles(to.adapter.conn.web, files, destDir, overwrite, webJob(jobId, ac));
        patch(jobId, { state: 'done' });
      } catch (err) {
        if (isExists(err) && !overwrite && !ac.signal.aborted) {
          setTransfers((ts) => ts.filter((t) => t.id !== jobId));
          if (await s.confirm({ title: t('같은 이름이 있습니다'), message: t('{error} 덮어쓸까요?', { error: errorMessage(err) }), confirmLabel: t('덮어쓰기'), danger: true })) return uploadBrowserFiles(side, files, toDir, true);
          return;
        }
        patch(jobId, { state: 'error', error: ac.signal.aborted ? t('취소했습니다') : errorMessage(err) });
      }
      to.refresh();
    },
    [addTransfer, patch, s, webJob],
  );

  // 웹: 원격 파일·폴더를 이 컴퓨터로 받는다 (저장 위치는 클릭 안에서 먼저 고른다)
  const downloadBrowser = useCallback(
    async (side: Side, list: { name: string; path: string; type: 'dir' | 'file'; size: number }[]): Promise<void> => {
      const from = handles.current[side];
      if (!from.adapter?.conn?.web || !list.length) return;
      let target;
      try {
        target = await pickDownloadTarget(list);
      } catch (err) {
        return s.toast(errorMessage(err), 'error');
      }
      if (!target) return;
      if (target.kind === 'blob' && list.some((e) => e.type === 'dir')) return s.toast(t('이 브라우저는 폴더째 받기를 지원하지 않습니다. 크롬·엣지를 사용하거나 파일을 골라 받아 주세요.'), 'error');
      const jobId = crypto.randomUUID();
      const ac = new AbortController();
      addTransfer({
        id: jobId,
        name: list.length === 1 ? list[0].name : t('{name} 외 {count}개', { name: list[0].name, count: list.length - 1 }),
        from: from.adapter.label,
        to: t('이 컴퓨터'),
        direction: 'down',
        bytes: 0,
        total: list.every((e) => e.type === 'file') ? list.reduce((n, e) => n + e.size, 0) : null,
        files: 0,
        state: 'running',
        cancel: () => ac.abort(),
      });
      try {
        await downloadTo(from.adapter.conn.web, list.map((e) => e.path), target, true, webJob(jobId, ac));
        patch(jobId, { state: 'done' });
      } catch (err) {
        patch(jobId, { state: 'error', error: ac.signal.aborted ? t('취소했습니다') : errorMessage(err) });
      }
    },
    [addTransfer, patch, s, webJob],
  );

  // 앱: 바깥(탐색기)에서 끌어다 놓은 로컬 경로를 올린다
  const uploadLocal = useCallback(
    async (side: Side, paths: string[], toDir?: string, overwrite = false): Promise<void> => {
      const to = handles.current[side];
      if (!desktop || !to.adapter || !paths.length) return;
      const destDir = toDir ?? to.cwd;
      if (to.adapter.kind === 'local') {
        await desktop.fs.copy(paths, destDir).catch((err) => s.toast(errorMessage(err), 'error'));
        return to.refresh();
      }
      const jobId = crypto.randomUUID();
      addTransfer({
        id: jobId,
        name: paths.length === 1 ? basename(paths[0]) : t('{name} 외 {count}개', { name: basename(paths[0]), count: paths.length - 1 }),
        from: t('내 컴퓨터'),
        to: to.adapter.label,
        direction: 'up',
        bytes: 0,
        total: null,
        files: 0,
        state: 'running',
        cancel: () => desktop!.transfer.cancel(jobId),
      });
      try {
        const result = await desktop.transfer.upload({ jobId, connId: to.adapter.conn!.id, localPaths: paths, remoteDir: destDir, overwrite });
        patch(jobId, { state: 'done', ...skippedOf(result) });
      } catch (err) {
        if (isExists(err) && !overwrite) {
          setTransfers((ts) => ts.filter((t) => t.id !== jobId));
          if (await s.confirm({ title: t('같은 이름이 있습니다'), message: t('{error} 덮어쓸까요?', { error: errorMessage(err) }), confirmLabel: t('덮어쓰기'), danger: true })) return uploadLocal(side, paths, toDir, true);
          return;
        }
        patch(jobId, { state: 'error', error: errorMessage(err) });
      }
      to.refresh();
    },
    [addTransfer, patch, s],
  );

  const running = transfers.filter((t) => t.state === 'running').length;

  return (
    <div className="sftp" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="sftp-panes">
        {(['left', 'right'] as Side[]).map((side) => (
          <SftpPane
            key={side}
            side={side}
            source={sources[side]}
            setSource={(src) => setSources((cur) => ({ ...cur, [side]: src }))}
            otherLabel={labels[side === 'left' ? 'right' : 'left']}
            onAdapter={(label) => setLabels((cur) => (cur[side] === label ? cur : { ...cur, [side]: label }))}
            uploadLocal={(paths, dir) => uploadLocal(side, paths, dir)}
            uploadBrowserFiles={(files, dir) => uploadBrowserFiles(side, files, dir)}
            downloadBrowser={(list) => downloadBrowser(side, list)}
            handle={handles.current[side]}
            transfer={(paths, toOther, dir, source) => {
              const other: Side = side === 'left' ? 'right' : 'left';
              const fromSide = toOther ? side : other;
              // 끌어 온 창이 그사이 다른 연결로 바뀌었으면 그 경로를 새 연결에 쓰지 않는다
              if (source && handles.current[fromSide].adapter !== source) return Promise.resolve();
              return transfer(fromSide, paths, toOther ? other : side, dir);
            }}
          />
        ))}
      </div>
      <div className={`sftp-transfers ${showTransfers ? 'open' : ''}`}>
        <button className="sftp-transfers-head" onClick={() => setShowTransfers(!showTransfers)}>
          <ArrowRightLeft size={14} />
          {running ? t('전송 {count}개 진행 중', { count: running }) : transfers.length ? t('전송 {count}개', { count: transfers.length }) : t('전송')}
          <span className="toolbar-spacer" />
          {transfers.some((t) => t.state !== 'running') && (
            <span
              className="link-btn"
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                setTransfers((ts) => ts.filter((t) => t.state === 'running'));
              }}
            >
              {t('끝난 항목 지우기')}
            </span>
          )}
          <ChevronDown size={14} className={showTransfers ? '' : 'flip'} />
        </button>
        {showTransfers && (
          <ul className="transfer-list">
            {transfers.length === 0 && <li className="muted small">{t('전송한 파일이 여기에 나타납니다. 파일을 반대편 창으로 끌어다 놓아 보세요.')}</li>}
            {transfers.map((item) => (
              <li key={item.id} className={`transfer ${item.state}`}>
                <span className="transfer-icon">{item.direction === 'up' ? <ArrowUpFromLine size={14} /> : item.direction === 'down' ? <ArrowDownToLine size={14} /> : <Copy size={14} />}</span>
                <span className="transfer-name" title={item.name}>
                  {item.name}
                </span>
                <span className="transfer-route muted">
                  {item.from} → {item.to}
                </span>
                <span className="transfer-progress">
                  {item.total ? <progress value={item.bytes} max={item.total} /> : null}
                  <span className="muted small">
                    {item.state === 'error' ? item.error : item.state === 'done' ? (item.files > 1 ? t('완료 · {size} · {count}개', { size: humanSize(item.bytes), count: item.files }) : t('완료 · {size}', { size: humanSize(item.bytes) })) : `${humanSize(item.bytes)}${item.total ? ` / ${humanSize(item.total)}` : ''}`}
                    {item.skipped?.length ? (
                      <span title={item.skipped.join('\n')}>
                        {' · '}
                        {t('폴더 링크 {count}개는 따라가지 않고 건너뛰었습니다', { count: item.skipped.length })}
                      </span>
                    ) : null}
                  </span>
                </span>
                {item.state === 'running' && item.cancel && (
                  <IconButton label={t('취소')} onClick={item.cancel}>
                    <X size={14} />
                  </IconButton>
                )}
                {item.state === 'running' && !item.cancel && <Loader2 size={14} className="spin muted" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------- 한쪽 창 ----------
type PaneProps = {
  side: Side;
  source: { kind: 'local' } | { kind: 'remote'; host: Host; nonce: number } | null;
  setSource: (s: { kind: 'local' } | { kind: 'remote'; host: Host; nonce: number } | null) => void;
  otherLabel: string | null;
  onAdapter: (label: string | null) => void;
  uploadLocal: (paths: string[], dir?: string) => Promise<void>;
  uploadBrowserFiles: (files: { file: File; rel: string }[], dir?: string) => Promise<void>;
  downloadBrowser: (list: Entry[]) => Promise<void>;
  handle: PaneHandle;
  // source: 끌어다 놓기로 온 경로의 원래 창 연결 — 그 창이 지금도 같은 연결일 때만 옮긴다
  transfer: (paths: string[], toOther: boolean, dir?: string, source?: Adapter) => Promise<void>;
};

type SortKey = 'name' | 'mtime' | 'size' | 'kind';

function SftpPane({ side, source, setSource, otherLabel, onAdapter, uploadLocal, uploadBrowserFiles, downloadBrowser, handle, transfer }: PaneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const s = useStore();
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [conn, setConn] = useState<{ state: 'idle' | 'connecting' | 'ready' | 'closed'; message: string }>({ state: 'idle', message: '' });
  const [overlay, setOverlay] = useState<PromptOverlay | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [editingPath, setEditingPath] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ path: string; text: string } | null>(null);
  const [chmodOf, setChmodOf] = useState<Entry | null>(null);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [seq, setSeq] = useState(0);
  const answer = useRef<((msg: Record<string, unknown> | null) => void) | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const { node: menuNode, open: openMenu } = useMenu();

  const load = useCallback(
    async (path: string, a: Adapter | null = adapter, push = true) => {
      if (!a) return;
      setLoading(true);
      setError('');
      try {
        const next = await a.list(path);
        setListing((cur) => {
          if (push && cur && cur.path !== next.path) setHistory((h) => ({ back: [...h.back, cur.path].slice(-50), forward: [] }));
          return next;
        });
        setSelected(new Set());
        setAnchor(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [adapter],
  );

  // 부모(화면)에서 쓰는 손잡이
  handle.adapter = adapter;
  handle.cwd = listing?.path ?? '';
  handle.refresh = () => listing && void load(listing.path, adapter, false);
  useEffect(() => onAdapter(adapter?.label ?? null), [adapter]); // eslint-disable-line react-hooks/exhaustive-deps

  // 소스가 바뀌면 연결한다
  useEffect(() => {
    setListing(null);
    setAdapter(null);
    setOverlay(null);
    setHistory({ back: [], forward: [] });
    setError('');
    if (!source) {
      setConn({ state: 'idle', message: '' });
      return;
    }
    if (source.kind === 'local') {
      const a = localAdapter();
      setAdapter(a);
      setConn({ state: 'ready', message: '' });
      void desktop!.fs.home().then((home) => load(home, a, false));
      return;
    }
    setConn({ state: 'connecting', message: t('{host}에 연결하는 중…', { host: source.host.label || source.host.address }) });
    const label = source.host.label || source.host.address;
    const ac = new AbortController();
    let conn: SshHandle | null = null;
    const ask = (p: PromptOverlay) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        answer.current = resolve;
        setOverlay(p);
      });
    const canEdit = s.me.vaults.find((v) => v.id === source.host.vaultId)?.perm === 'edit';
    openSsh(source.host.id, 'sftp', { ask, notify: setOverlay, warn: (m) => s.toast(m, 'error'), canEdit }, { signal: ac.signal }).then(
      (h) => {
        if (ac.signal.aborted) return h.close();
        conn = h;
        const a = remoteAdapter(h, label);
        setAdapter(a);
        setConn({ state: 'ready', message: '' });
        setOverlay((o) => (o?.kind === 'hostkey' && o.state === 'mismatch' ? o : null));
        h.onClose((message) => {
          setAdapter(null);
          setConn({ state: 'closed', message: tMsg(message) });
        });
        void load(h.home || '/', a, false);
      },
      (err: Error) => {
        if (ac.signal.aborted) return;
        setOverlay((o) => (o?.kind === 'hostkey' && o.state === 'mismatch' ? o : null));
        setConn({ state: 'closed', message: tMsg(err.message) });
      },
    );
    return () => {
      ac.abort();
      answer.current?.(null);
      answer.current = null;
      conn?.close();
    };
  }, [source && (source.kind === 'local' ? 'local' : `${source.host.id}:${source.nonce}`), seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    if (!listing) return [];
    const q = filter.trim().toLowerCase();
    const list = listing.entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    const cmp = (a: Entry, b: Entry) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let v = 0;
      if (sort.key === 'size') v = a.size - b.size;
      else if (sort.key === 'mtime') v = a.mtime - b.mtime;
      else if (sort.key === 'kind') v = kindOf(a).localeCompare(kindOf(b));
      if (v === 0) v = a.name.localeCompare(b.name, locale(), { numeric: true, sensitivity: 'base' });
      return v * sort.dir;
    };
    return list.sort(cmp);
  }, [listing, filter, showHidden, sort]);

  const selectedEntries = entries.filter((e) => selected.has(e.path));

  // 로컬 파일을 PC 의 기본 프로그램으로 연다. 실행 파일이면 앱 본체가 한 번 더 묻는데, 사용자가 취소한 것은 알리지 않는다
  const openLocal = async (path: string) => {
    try {
      await desktop!.fs.open(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as { code?: unknown } | null)?.code === 'cancelled' || /^(cancel+ed|취소)/i.test(message)) return;
      s.toast(errorMessage(err), 'error');
    }
  };

  const open = (e: Entry) => {
    if (e.type === 'dir') return void load(e.path);
    if (adapter?.kind === 'local') return void openLocal(e.path);
    if (isTextName(e.name) && e.size <= TEXT_LIMIT) return void editText(e);
    if (!desktop) void downloadBrowser([e]);
    else if (otherLabel === LOCAL) void transfer([e.path], true);
    else s.toast(t('반대편 창을 "내 컴퓨터"로 열고 끌어다 놓으면 내려받습니다.'));
  };

  const editText = async (e: Entry) => {
    if (!adapter?.conn?.sftp) return;
    if (e.size > TEXT_LIMIT) return s.toast(t('2MB보다 큰 파일은 여기서 편집할 수 없습니다'), 'error');
    try {
      const buf = await adapter.conn.sftp.read(e.path, TEXT_LIMIT);
      if (buf.includes(0)) return s.toast(t('텍스트 파일이 아니라 편집할 수 없습니다. 내려받아 주세요.'), 'error');
      setEditor({ path: e.path, text: new TextDecoder().decode(buf) });
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const newFolder = async () => {
    if (!adapter || !listing) return;
    const name = await s.askText({ title: t('새 폴더'), label: t('폴더 이름'), value: t('새 폴더'), confirmLabel: t('만들기') });
    if (!name) return;
    if (/[\\/]/.test(name)) return s.toast(t('이름에 /나 \\는 사용할 수 없습니다'), 'error');
    try {
      await adapter.mkdir(await adapter.join(listing.path, name));
      await load(listing.path, adapter, false);
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const rename = async (e: Entry) => {
    if (!adapter || !listing) return;
    const name = await s.askText({ title: t('이름 바꾸기'), label: t('새 이름'), value: e.name, confirmLabel: t('바꾸기') });
    if (!name || name === e.name) return;
    if (/[\\/]/.test(name)) return s.toast(t('이름에 /나 \\는 사용할 수 없습니다'), 'error');
    try {
      await adapter.rename(e.path, await adapter.join(listing.path, name));
      await load(listing.path, adapter, false);
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const remove = async (list: Entry[]) => {
    if (!adapter || !listing || !list.length) return;
    const dirs = list.filter((e) => e.type === 'dir').length;
    const what = list.length === 1 ? `"${list[0].name}"` : t('{count}개 항목', { count: list.length });
    const ok = await s.confirm({
      title: t('삭제'),
      message: dirs
        ? t('{what}을(를) {target}에서 지웁니다. 폴더는 안의 내용까지 모두 지워집니다. 되돌릴 수 없습니다.', { what, target: shownLabel(adapter.label) })
        : t('{what}을(를) {target}에서 지웁니다. 되돌릴 수 없습니다.', { what, target: shownLabel(adapter.label) }),
      confirmLabel: t('삭제'),
      danger: true,
    });
    if (!ok) return;
    try {
      await adapter.remove(list.map((e) => e.path));
      await load(listing.path, adapter, false);
    } catch (err) {
      s.toast(errorMessage(err), 'error');
      void load(listing.path, adapter, false);
    }
  };

  const goBack = () => {
    const prev = history.back[history.back.length - 1];
    if (!prev || !listing) return;
    setHistory((h) => ({ back: h.back.slice(0, -1), forward: [listing.path, ...h.forward] }));
    void load(prev, adapter, false);
  };
  const goForward = () => {
    const next = history.forward[0];
    if (!next || !listing) return;
    setHistory((h) => ({ back: [...h.back, listing.path], forward: h.forward.slice(1) }));
    void load(next, adapter, false);
  };
  const goUp = () => listing?.parent && void load(listing.parent);

  const clickRow = (e: ReactMouseEvent, entry: Entry, index: number) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.path)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchor(index);
    } else {
      setSelected(new Set([entry.path]));
      setAnchor(index);
    }
  };

  const rowMenu = (e: ReactMouseEvent, entry: Entry | null) => {
    e.preventDefault();
    let list = selectedEntries;
    if (entry && !selected.has(entry.path)) {
      list = [entry];
      setSelected(new Set([entry.path]));
    }
    if (!entry) list = [];
    const single = list.length === 1 ? list[0] : null;
    const remote = adapter?.kind === 'remote';
    const items: MenuItem[] = [];
    if (single?.type === 'dir') items.push({ label: t('열기'), icon: <FolderOpen size={14} />, onClick: () => void load(single.path) });
    if (single?.type === 'file' && adapter?.kind === 'local') items.push({ label: t('열기'), icon: <FileIcon size={14} />, onClick: () => void openLocal(single.path) });
    if (list.length && otherLabel)
      items.push({ label: remote && otherLabel === LOCAL ? t('{target}(으)로 받기', { target: shownLabel(otherLabel) }) : adapter?.kind === 'local' ? t('{target}(으)로 올리기', { target: shownLabel(otherLabel) }) : t('{target}(으)로 복사', { target: shownLabel(otherLabel) }), icon: <ArrowRightLeft size={14} />, onClick: () => void transfer(list.map((x) => x.path), true) });
    if (single?.type === 'file' && remote) items.push({ label: t('편집'), icon: <FilePen size={14} />, onClick: () => void editText(single) });
    if (list.length && remote && !desktop) items.push({ label: canPickFolder || list.every((x) => x.type === 'file') ? t('내려받기') : t('내려받기(파일만)'), icon: <ArrowDownToLine size={14} />, onClick: () => void downloadBrowser(list) });
    if (single) items.push({ label: t('이름 바꾸기'), icon: <Pencil size={14} />, hint: 'F2', onClick: () => void rename(single) });
    if (single && remote) items.push({ label: t('권한'), icon: <KeyRound size={14} />, onClick: () => setChmodOf(single) });
    if (list.length) items.push({ label: t('삭제'), icon: <Trash2 size={14} />, danger: true, hint: 'Del', onClick: () => void remove(list) });
    if (items.length) items.push({ divider: true });
    items.push({ label: t('새 폴더'), icon: <FolderPlus size={14} />, onClick: () => void newFolder() });
    if (remote && !desktop) items.push({ label: t('파일 올리기'), icon: <Upload size={14} />, onClick: () => fileInput.current?.click() });
    items.push({ label: showHidden ? t('숨김 파일 숨기기') : t('숨김 파일 보기'), icon: showHidden ? <EyeOff size={14} /> : <Eye size={14} />, onClick: () => setShowHidden(!showHidden) });
    items.push({ label: t('새로고침'), icon: <RefreshCw size={14} />, onClick: () => handle.refresh() });
    openMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (!listing || (e.target as HTMLElement).tagName === 'INPUT') return;
    const idx = entries.findIndex((x) => x.path === [...selected].pop());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(Math.max((idx < 0 ? -1 : idx) + (e.key === 'ArrowDown' ? 1 : -1), 0), entries.length - 1);
      if (entries[next]) {
        setSelected(new Set([entries[next].path]));
        setAnchor(next);
        tableRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' && selectedEntries.length === 1) open(selectedEntries[0]);
    else if (e.key === 'Backspace') goUp();
    else if (e.key === 'Delete' && selectedEntries.length) void remove(selectedEntries);
    else if (e.key === 'F2' && selectedEntries.length === 1) void rename(selectedEntries[0]);
    else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelected(new Set(entries.map((x) => x.path)));
    }
  };

  // 끌어다 놓기: 반대편 창의 항목이면 전송, 바깥(OS) 파일이면 업로드
  const onDragOver = (e: DragEvent, dir: string | null) => {
    if (!adapter) return;
    const internal = e.dataTransfer.types.includes(DRAG_TYPE);
    const external = e.dataTransfer.types.includes('Files');
    if (!internal && !external) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(dir ?? listing?.path ?? null);
  };
  const onDrop = async (e: DragEvent, dir: string | null) => {
    e.preventDefault();
    setDropTarget(null);
    if (!adapter || !listing) return;
    const target = dir ?? listing.path;
    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
      // 이 창에서 시작한 끌기의 표일 때만 경로를 믿는다. 다른 웹페이지·앱이 흉내 낸 것은 무시한다 (M-10)
      const data = takeDrag(e.dataTransfer.getData(DRAG_TYPE));
      if (!data || data.side === side) return;
      return void transfer(data.paths, false, target, data.adapter);
    }
    if (desktop) {
      // 바깥에서 끌어 온 파일: 네트워크 공유(\\서버\공유) 경로는 건드리지 않는다 (그 서버로 Windows 로그인 정보가 나간다)
      const paths = [...e.dataTransfer.files].map((f) => desktop!.fs.pathForFile(f)).filter(Boolean);
      const local = paths.filter((p) => !isUncPath(p));
      if (local.length < paths.length) s.toast(t('네트워크 공유 경로에 있는 항목은 끌어다 놓아 올릴 수 없습니다. 네트워크 드라이브로 연결한 뒤 사용해 주세요.'), 'error');
      return void uploadLocal(local, target);
    }
    if (adapter.kind !== 'remote') return;
    void uploadBrowserFiles(await collectDropped(e.dataTransfer.items, e.dataTransfer.files), target);
  };

  const label = source?.kind === 'remote' ? source.host.label || source.host.address : source?.kind === 'local' ? t('내 컴퓨터') : t('호스트 선택');

  return (
    <section className={`sftp-pane ${dropTarget === listing?.path ? 'drop' : ''}`} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropTarget(null)}>
      <header className="sftp-head">
        <button className="sftp-source" onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}>
          <span className="item-icon small" style={{ background: source?.kind === 'remote' ? colorFor(source.host.id) : '#3b4460' }}>
            {source?.kind === 'remote' ? <HostGlyph os={osOf(source.host)} size={14} /> : source?.kind === 'local' ? <Monitor size={14} /> : <HardDrive size={14} />}
          </span>
          <span className="sftp-source-label">{label}</span>
          {conn.state === 'ready' && conn.message && <span className="muted small">{conn.message}</span>}
          <ChevronDown size={14} />
        </button>
        <span className="toolbar-spacer" />
        {adapter && (
          <>
            {showFilter ? (
              <Input className="sftp-filter" placeholder={t('이름으로 거르기')} value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} onBlur={() => !filter && setShowFilter(false)} />
            ) : (
              <IconButton label={t('거르기')} onClick={() => setShowFilter(true)}>
                <Search size={15} />
              </IconButton>
            )}
            <IconButton label={t('작업')} onClick={(e) => rowMenu(e, null)}>
              <MoreHorizontal size={16} />
            </IconButton>
          </>
        )}
      </header>

      {adapter && listing && (
        <div className="sftp-nav">
          <IconButton label={t('뒤로')} onClick={goBack} disabled={!history.back.length}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton label={t('앞으로')} onClick={goForward} disabled={!history.forward.length}>
            <ChevronRight size={16} />
          </IconButton>
          <IconButton label={t('위로')} onClick={goUp} disabled={!listing.parent}>
            <ArrowUp size={15} />
          </IconButton>
          {editingPath ? (
            <form
              className="sftp-path-form"
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get('path');
                setEditingPath(false);
                if (typeof v === 'string' && v.trim()) void load(v.trim());
              }}
            >
              <Input name="path" defaultValue={listing.path} autoFocus onBlur={() => setEditingPath(false)} onKeyDown={(e) => e.key === 'Escape' && setEditingPath(false)} />
            </form>
          ) : (
            <div className="sftp-crumbs" onDoubleClick={() => setEditingPath(true)} title={t('두 번 눌러 경로 입력')}>
              {segments(listing.path).map((seg, i) => (
                <span key={seg.path}>
                  {i > 0 && <ChevronRight size={12} className="muted" />}
                  <button onClick={() => void load(seg.path)} onDragOver={(e) => onDragOver(e, seg.path)} onDrop={(e) => void onDrop(e, seg.path)}>
                    {i === 0 ? <Folder size={13} /> : null}
                    {seg.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          <IconButton label={t('새로고침')} onClick={() => handle.refresh()}>
            {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </IconButton>
        </div>
      )}

      <div className="sftp-body" tabIndex={0} onKeyDown={onKey} ref={tableRef} onDragOver={(e) => onDragOver(e, null)} onDrop={(e) => void onDrop(e, null)} onContextMenu={(e) => adapter && rowMenu(e, null)}>
        {!source && (
          <div className="empty">
            <div className="empty-icon">
              <Folder size={22} />
            </div>
            <h3>{t('호스트에 연결')}</h3>
            <p>{t('저장된 호스트를 골라 SFTP로 파일을 관리해 주세요.')}</p>
            <Button variant="primary" onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}>
              {t('호스트 선택')}
            </Button>
          </div>
        )}
        {source && conn.state === 'connecting' && !overlay && (
          <div className="empty">
            <Loader2 size={22} className="spin muted" />
            <p>{conn.message || t('연결하는 중…')}</p>
          </div>
        )}
        {source && conn.state === 'closed' && !overlay && (
          <div className="empty">
            <div className="empty-icon">
              <Server size={22} />
            </div>
            <h3>{t('연결이 끊겼습니다')}</h3>
            <p>{conn.message}</p>
            <Button variant="primary" onClick={() => setSeq((n) => n + 1)}>
              <RotateCw size={14} /> {t('다시 연결')}
            </Button>
          </div>
        )}
        {adapter && error && !listing && <p className="sftp-error">{error}</p>}
        {adapter && listing && (
          <table className="sftp-table">
            <thead>
              <tr>
                {(
                  [
                    ['name', t('이름')],
                    ['mtime', t('수정한 날짜')],
                    ['size', t('크기')],
                    ['kind', t('종류')],
                  ] as [SortKey, string][]
                ).map(([key, text]) => (
                  <th key={key} className={`col-${key}`} onClick={() => setSort((cur) => ({ key, dir: cur.key === key ? (-cur.dir as 1 | -1) : 1 }))}>
                    {text}
                    {sort.key === key && <span className="sort-mark">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listing.parent && (
                <tr className="row-parent" onDoubleClick={goUp} onDragOver={(e) => onDragOver(e, listing.parent)} onDrop={(e) => void onDrop(e, listing.parent)}>
                  <td className="col-name">
                    <Folder size={15} className="icon-dir" /> ..
                  </td>
                  <td />
                  <td />
                  <td />
                </tr>
              )}
              {entries.map((entry, i) => (
                <tr
                  key={entry.path}
                  data-index={i}
                  className={`${selected.has(entry.path) ? 'selected' : ''} ${dropTarget === entry.path ? 'drop' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    if (!adapter) return e.preventDefault();
                    const paths = selected.has(entry.path) ? selectedEntries.map((x) => x.path) : [entry.path];
                    // 경로는 이 창 메모리에 두고 끌기 데이터에는 표만 싣는다 (M-10)
                    e.dataTransfer.setData(DRAG_TYPE, beginDrag({ side, paths, adapter }));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => entry.type === 'dir' && onDragOver(e, entry.path)}
                  onDrop={(e) => entry.type === 'dir' && (e.stopPropagation(), void onDrop(e, entry.path))}
                  onClick={(e) => clickRow(e, entry, i)}
                  onDoubleClick={() => open(entry)}
                  onContextMenu={(e) => (e.stopPropagation(), rowMenu(e, entry))}
                >
                  <td className="col-name" title={entry.name}>
                    {entry.type === 'dir' ? <Folder size={15} className="icon-dir" /> : <FileIcon size={15} className="icon-file" />}
                    <span>{entry.name}</span>
                    {entry.link && <span className="muted small"> ↪</span>}
                  </td>
                  <td className="col-mtime muted">{entry.mtime ? new Date(entry.mtime).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : ''}</td>
                  <td className="col-size muted">{entry.type === 'dir' ? '--' : humanSize(entry.size)}</td>
                  <td className="col-kind muted" title={entry.mode !== undefined ? modeString(entry.mode) : undefined}>
                    {kindOf(entry)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {adapter && listing && entries.length === 0 && <p className="muted small sftp-empty-dir">{filter ? t('맞는 항목이 없습니다.') : t('빈 폴더입니다. 파일을 여기로 끌어다 놓으면 올라갑니다.')}</p>}
        {overlay && source?.kind === 'remote' && (
          <ConnectPrompt
            overlay={overlay}
            vaultId={source.host.vaultId}
            reply={(m) => {
              const r = answer.current;
              answer.current = null;
              r?.(m);
            }}
            dismiss={() => setOverlay(null)}
            reconnect={() => (setOverlay(null), setSeq((n) => n + 1))}
          />
        )}
      </div>

      <footer className="sftp-foot muted small">
        {listing ? (selected.size ? t('{count}개 항목 · {selected}개 선택', { count: entries.length, selected: selected.size }) : t('{count}개 항목', { count: entries.length })) : ''}
        {error && listing && <span className="sftp-error-inline">{error}</span>}
      </footer>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].map((file) => ({ file, rel: file.name }));
          e.target.value = '';
          void uploadBrowserFiles(files);
        }}
      />
      {picker && (
        <SourcePicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(src) => {
            setPicker(null);
            setSource(src);
          }}
        />
      )}
      {editor && adapter?.conn?.sftp && (
        <TextEditor
          path={editor.path}
          initial={editor.text}
          conn={adapter.conn}
          onClose={() => setEditor(null)}
          onSaved={() => handle.refresh()}
        />
      )}
      {chmodOf && adapter?.chmod && (
        <ChmodDialog
          entry={chmodOf}
          onClose={() => setChmodOf(null)}
          onSave={async (mode) => {
            try {
              await adapter.chmod!(chmodOf.path, mode);
              setChmodOf(null);
              handle.refresh();
            } catch (err) {
              s.toast(errorMessage(err), 'error');
            }
          }}
        />
      )}
      {menuNode}
    </section>
  );
}

// ---------- 호스트 고르기 ----------
function SourcePicker({ anchor, onClose, onPick }: { anchor: DOMRect; onClose: () => void; onPick: (s: { kind: 'local' } | { kind: 'remote'; host: Host; nonce: number }) => void }) {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });
  useEffect(() => {
    allHosts().then(setHosts, () => setHosts([]));
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - el.offsetWidth - 8)), top: Math.min(anchor.bottom + 6, window.innerHeight - el.offsetHeight - 8) });
  }, [anchor, hosts]);
  const q = query.trim().toLowerCase();
  const list = (hosts ?? []).filter((h) => !q || [h.label, h.address, h.username, h.vaultName ?? ''].some((v) => v.toLowerCase().includes(q)));
  return createPortal(
    <div className="menu source-picker" ref={ref} style={pos}>
      <Input placeholder={t('호스트 찾기')} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && list[0] && onPick({ kind: 'remote', host: list[0], nonce: Date.now() })} />
      <div className="source-list">
        {desktop && (
          <button className="menu-item" onClick={() => onPick({ kind: 'local' })}>
            <span className="menu-icon">
              <Monitor size={14} />
            </span>
            <span className="menu-label">{t('내 컴퓨터')}</span>
          </button>
        )}
        {hosts === null && <div className="menu-header">{t('불러오는 중…')}</div>}
        {hosts && list.length === 0 && <div className="menu-header">{t('호스트가 없습니다')}</div>}
        {list.map((h) => (
          <button key={h.id} className="menu-item" onClick={() => onPick({ kind: 'remote', host: h, nonce: Date.now() })}>
            <span className="item-icon tiny" style={{ background: colorFor(h.id) }}>
              <HostGlyph os={osOf(h)} size={11} />
            </span>
            <span className="menu-label">{h.label || h.address}</span>
            <span className="menu-hint">{h.vaultName}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ---------- 텍스트 편집 ----------
function TextEditor({ path, initial, conn, onClose, onSaved }: { path: string; initial: string; conn: SshHandle; onClose: () => void; onSaved: () => void }) {
  const s = useStore();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = text !== initial;
  const save = async () => {
    setBusy(true);
    try {
      await conn.sftp!.write(path, new TextEncoder().encode(text));
      s.toast(t('저장했습니다'), 'success');
      onSaved();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (dirty && !(await s.confirm({ title: t('저장하지 않고 닫기'), message: t('수정한 내용이 사라집니다.'), confirmLabel: t('닫기'), danger: true }))) return;
    onClose();
  };
  return (
    <Modal
      title={basename(path)}
      onClose={() => void close()}
      width={900}
      footer={
        <>
          <span className="muted small editor-path">{path}</span>
          <Button variant="ghost" onClick={() => void close()}>
            {t('닫기')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
            {t('저장')}
          </Button>
        </>
      }
    >
      <Textarea
        className="mono editor-area"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (dirty) void save();
          }
        }}
      />
    </Modal>
  );
}

// ---------- 권한 ----------
function ChmodDialog({ entry, onClose, onSave }: { entry: Entry; onClose: () => void; onSave: (mode: string) => void }) {
  const [mode, setMode] = useState(((entry.mode ?? 0o644) & 0o777).toString(8).padStart(3, '0'));
  const n = parseInt(mode, 8);
  const valid = /^[0-7]{3,4}$/.test(mode);
  const bits = [t('소유자'), t('그룹'), t('다른 사람')];
  const toggle = (bit: number) => setMode(((valid ? n : 0) ^ bit).toString(8).padStart(3, '0'));
  return (
    <Modal
      title={t('권한 — {name}', { name: entry.name })}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('취소')}
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave(mode)}>
            {t('적용')}
          </Button>
        </>
      }
    >
      <div className="chmod">
        <table>
          <thead>
            <tr>
              <th />
              <th>{t('읽기')}</th>
              <th>{t('쓰기')}</th>
              <th>{t('실행')}</th>
            </tr>
          </thead>
          <tbody>
            {bits.map((who, i) => (
              <tr key={who}>
                <td>{who}</td>
                {[4, 2, 1].map((b) => {
                  const bit = b << (3 * (2 - i));
                  return (
                    <td key={b}>
                      <input type="checkbox" checked={valid && Boolean(n & bit)} onChange={() => toggle(bit)} aria-label={b === 4 ? t('{who} 읽기', { who }) : b === 2 ? t('{who} 쓰기', { who }) : t('{who} 실행', { who })} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="chmod-row">
          <Input value={mode} onChange={(e) => setMode(e.target.value.replace(/[^0-7]/g, '').slice(0, 4))} aria-label={t('8진수 권한')} />
          <code>{valid ? modeString(n) : '—'}</code>
        </div>
      </div>
    </Modal>
  );
}
