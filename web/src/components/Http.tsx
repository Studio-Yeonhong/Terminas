// HTTP 요청 도구 (앱 전용). 요청은 이 PC 의 앱 본체(desktop/src/http.js)가 대상 서버로 바로 보낸다 —
// 웹에는 이 화면이 없고, Terminas 서버는 요청을 대신 보내지 않는다. 보낸 요청은 기록(메서드·주소, 볼트 키로 암호화)에 남는다.
// 저장한 요청·환경 변수는 다른 볼트 항목처럼 볼트 키로 암호화돼 팀과 공유된다.
// 화면 짜임은 Postman 을 따른다: 왼쪽 모음·기록, 위쪽 열린 요청 탭, 메서드·주소, Params·인증·헤더·본문·설정, 아래 응답.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Code,
  Copy,
  CopyPlus,
  CornerDownRight,
  Download,
  FolderInput,
  Globe,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
  Send,
  ShieldOff,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { errorMessage, type HttpEnv, type HttpEnvVar, type HttpHeader, type HttpRequestItem } from '../api';
import { useStore } from '../store';
import { desktop, type HttpResult, type HttpSend } from '../desktop';
import { HTTP_METHODS, emptyRequest, report, vaultApi } from '../vault';
import {
  autoHeaders,
  buildRequest,
  decodeBody,
  formRows,
  formText,
  jsonTokens,
  logTarget,
  looksBinary,
  parseCookies,
  parseCurl,
  queryParams,
  substituteMasked,
  toCurl,
  toFetch,
  toPowerShell,
  toPython,
  usesVars,
  withParams,
  type BuiltRequest,
  type RequestDraft,
} from '../http-tools';
import { locale, t, tk, tMsg } from '../i18n';
import { Badge, Button, EmptyState, IconButton, Input, Modal, Select, Textarea, Toggle, useMenu, type MenuItem } from './ui';

const METHOD_COLOR: Record<string, string> = { GET: '#20b486', POST: '#e0883a', PUT: '#4c8dff', PATCH: '#b36ee8', DELETE: '#e25c77', HEAD: '#1fa9c4', OPTIONS: '#8a9a2c' };
const methodColor = (m: string) => METHOD_COLOR[m] ?? '#8b93a7';
const APP_VERSION = () => desktop?.version ?? '0';

// ---------- 이 기기에만 기억하는 것 (고른 환경·접은 모음·위아래 나눈 높이) ----------
const envKey = (vaultId: string) => `terminas.httpEnv.${vaultId}`;
const collapsedKey = (vaultId: string) => `terminas.httpCollapsed.${vaultId}`;
const SPLIT_KEY = 'terminas.httpSplit';
const readLs = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeLs = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};
const readCollapsed = (vaultId: string) => {
  try {
    return new Set<string>(JSON.parse(readLs(collapsedKey(vaultId)) ?? '[]'));
  } catch {
    return new Set<string>();
  }
};

const toDraft = (r: HttpRequestItem): RequestDraft => ({
  label: r.label,
  collection: r.collection,
  method: r.method,
  url: r.url,
  headers: r.headers.map((h) => ({ ...h })),
  offParams: r.offParams.map((h) => ({ ...h })),
  bodyType: r.bodyType,
  body: r.body,
  auth: { ...r.auth },
  insecure: r.insecure,
  follow: r.follow,
  timeout: r.timeout,
});
const blank = (): RequestDraft => ({ ...emptyRequest() });
const cloneDraft = (d: RequestDraft): RequestDraft => JSON.parse(JSON.stringify(d));
function sizeText(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function shortUrl(url: string) {
  const u = url.replace(/^https?:\/\//i, '');
  return u.length > 60 ? `${u.slice(0, 57)}…` : u;
}
const tabTitle = (d: RequestDraft) => d.label || (d.url ? shortUrl(d.url) : t('새 요청'));
const FAIL_LABEL: Record<string, string> = { timeout: tk('시간 초과'), dns: tk('주소 못 찾음'), refused: tk('연결 거부'), reset: tk('연결 끊김'), tls: tk('인증서 오류'), cancelled: tk('취소'), error: tk('실패') };
export const httpFailLabel = (fail: string) => t(FAIL_LABEL[fail] ?? FAIL_LABEL.error);
const codeTone = (code: number) => (code >= 500 ? 'e5' : code >= 400 ? 'e4' : code >= 300 ? 'e3' : 'e2');

type Sent = { res: HttpResult; built: BuiltRequest; at: number };
// 앱 본체(desktop/src/http.js)와 더 주고받는 것 (보안 점검 09-29, desktop.ts 의 HttpSend·HttpResult 에는 아직 없다):
// 민감한 헤더 이름(다른 사이트로 넘어갈 때 떼어 낸다) · 따라가지 않은 리다이렉트(https → http)
type HttpSendMore = HttpSend & { sensitive: string[] };
type HttpResponse = Extract<HttpResult, { status: number }> & { blockedRedirect?: { status: number; url: string; reason: string } | null };
const SHOW_LIMIT = 256 * 1024;
const COLOR_LIMIT = 150 * 1024;
const PARSE_LIMIT = 5 * 1024 * 1024;

// ---------- 열린 요청 탭·보낸 기록 (볼트마다, 메모리에만) ----------
// 화면(React)이 사라져도(터미널 탭에 다녀와도) 남게 모듈에 둔다. 잠그거나 로그아웃하면 화면을 새로 읽어 함께 사라진다.
// 보낸 기록에는 토큰·본문이 들어 있을 수 있어 저장하지 않는다.
type ReqTab = { key: string; selId: string | null; draft: RequestDraft; dirty: boolean; sent: Sent | null; sending: string | null };
type HistoryEntry = { id: string; draft: RequestDraft; sent: Sent };
type Session = { tabs: ReqTab[]; active: string; history: HistoryEntry[] };
const HISTORY_MAX = 50;
const sessions = new Map<string, Session>();
const sessionListeners = new Set<() => void>();
const newTab = (draft: RequestDraft = blank(), selId: string | null = null, extra: Partial<ReqTab> = {}): ReqTab => ({
  key: `r${Math.random().toString(36).slice(2, 10)}`,
  selId,
  draft,
  dirty: false,
  sent: null,
  sending: null,
  ...extra,
});
function sessionOf(vaultId: string): Session {
  let ses = sessions.get(vaultId);
  if (!ses) {
    const tab = newTab();
    ses = { tabs: [tab], active: tab.key, history: [] };
    sessions.set(vaultId, ses);
  }
  return ses;
}
function setSession(vaultId: string, fn: (s: Session) => Session) {
  sessions.set(vaultId, fn(sessionOf(vaultId)));
  for (const l of sessionListeners) l();
}
const patchTab = (vaultId: string, key: string, fn: (t: ReqTab) => Partial<ReqTab>) =>
  setSession(vaultId, (ses) => ({ ...ses, tabs: ses.tabs.map((tb) => (tb.key === key ? { ...tb, ...fn(tb) } : tb)) }));
function useSession(vaultId: string) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    sessionListeners.add(force);
    return () => void sessionListeners.delete(force);
  }, []);
  return sessionOf(vaultId);
}

type ReqPane = 'params' | 'auth' | 'headers' | 'body' | 'options';

export function HttpView() {
  const s = useStore();
  const bridge = desktop?.http;
  const vid = s.vault.id;
  const ses = useSession(vid);
  const canEdit = s.vault.perm === 'edit';
  const { requests, httpEnvs } = s.items;
  const tab = ses.tabs.find((x) => x.key === ses.active) ?? ses.tabs[0];
  const draft = tab.draft;
  const [side, setSide] = useState<'saved' | 'history'>('saved');
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<ReqPane>('params');
  const [envId, setEnvIdState] = useState(() => readLs(envKey(vid)) ?? '');
  const [envEditor, setEnvEditor] = useState(false);
  const [curlDialog, setCurlDialog] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(vid));
  const [split, setSplit] = useState(() => Number(readLs(SPLIT_KEY)) || 230);
  const { node: menuNode, open: openMenu } = useMenu();

  useEffect(() => {
    setEnvIdState(readLs(envKey(vid)) ?? '');
    setCollapsed(readCollapsed(vid));
  }, [vid]);

  // 저장한 요청이 바뀌면(다른 사람·다른 탭) 고치지 않은 탭은 새 내용으로
  useEffect(() => {
    if (s.itemsLoading) return;
    const byId = new Map(requests.filter((r) => r.vaultId === vid).map((r) => [r.id, r]));
    const cur = sessionOf(vid);
    const stale = cur.tabs.some((tb) => tb.selId && !tb.dirty && byId.has(tb.selId) && JSON.stringify(toDraft(byId.get(tb.selId)!)) !== JSON.stringify(tb.draft));
    if (stale) setSession(vid, (x) => ({ ...x, tabs: x.tabs.map((tb) => (tb.selId && !tb.dirty && byId.has(tb.selId) ? { ...tb, draft: toDraft(byId.get(tb.selId)!) } : tb)) }));
  }, [requests, vid, s.itemsLoading]);

  const env = httpEnvs.find((e) => e.id === envId) ?? null;
  const vars = env?.vars ?? [];
  const setEnvId = (id: string) => {
    setEnvIdState(id);
    writeLs(envKey(vid), id || null);
  };
  const update = (patch: Partial<RequestDraft>) => patchTab(vid, tab.key, (tb) => ({ draft: { ...tb.draft, ...patch }, dirty: true }));
  const activate = (key: string) => setSession(vid, (x) => ({ ...x, active: key }));

  // ---------- 탭 ----------
  const openSaved = (r: HttpRequestItem) =>
    setSession(vid, (x) => {
      const existing = x.tabs.find((tb) => tb.selId === r.id);
      if (existing) return { ...x, active: existing.key };
      const cur = x.tabs.find((tb) => tb.key === x.active);
      // 아무것도 안 한 빈 탭이면 그 자리를 쓴다
      const pristine = cur && !cur.selId && !cur.dirty && !cur.sent && !cur.sending;
      const next = newTab(toDraft(r), r.id);
      return { ...x, tabs: pristine ? x.tabs.map((tb) => (tb.key === cur.key ? next : tb)) : [...x.tabs, next], active: next.key };
    });
  const openNew = (d: RequestDraft = blank(), extra: Partial<ReqTab> = {}) =>
    setSession(vid, (x) => {
      const next = newTab(d, null, extra);
      return { ...x, tabs: [...x.tabs, next], active: next.key };
    });
  const dropTabs = (keys: string[]) =>
    setSession(vid, (x) => {
      const i = x.tabs.findIndex((tb) => keys.includes(tb.key));
      const tabs = x.tabs.filter((tb) => !keys.includes(tb.key));
      if (!tabs.length) {
        const fresh = newTab();
        return { ...x, tabs: [fresh], active: fresh.key };
      }
      const active = keys.includes(x.active) ? tabs[Math.max(0, Math.min(i, tabs.length - 1))].key : x.active;
      return { ...x, tabs, active };
    });
  const closeTab = async (key: string) => {
    const tb = ses.tabs.find((x) => x.key === key);
    if (!tb) return;
    if (tb.dirty && !(await s.confirm({ title: t('저장하지 않은 변경'), message: t('"{name}" 탭에 저장하지 않은 변경이 있습니다. 버리고 닫을까요?', { name: tabTitle(tb.draft) }), confirmLabel: t('버리기'), danger: true }))) return;
    if (tb.sending) bridge?.cancel(tb.sending);
    dropTabs([key]);
  };

  // ---------- 보내기·저장 ----------
  const send = async () => {
    if (!bridge || tab.sending) return;
    const key = tab.key;
    const d = cloneDraft(tab.draft);
    const vaultId = vid;
    const built = buildRequest(d, vars, APP_VERSION());
    if (!built.url) return s.toast(t('주소를 입력해 주세요'), 'error');
    if (!built.method) return s.toast(t('메서드가 올바르지 않습니다'), 'error');
    if (built.missing.length) return s.toast(t('환경에 없는 변수가 있습니다: {names}', { names: built.missing.join(', ') }), 'error');
    const id = crypto.randomUUID();
    patchTab(vaultId, key, () => ({ sending: id }));
    let res: HttpResult;
    try {
      const req: HttpSendMore = { id, method: built.method, url: built.url, headers: [...built.headers, ...built.auto], body: built.body, timeout: built.timeout, follow: built.follow, insecure: built.insecure, sensitive: built.sensitive };
      res = await bridge.send(req);
    } catch (err) {
      res = { error: { fail: 'error', message: errorMessage(err) } };
    }
    const sent: Sent = { res, built, at: Date.now() };
    setSession(vaultId, (x) => ({
      ...x,
      tabs: x.tabs.map((tb) => (tb.key === key ? { ...tb, sending: null, sent } : tb)),
      history: [{ id, draft: d, sent }, ...x.history].slice(0, HISTORY_MAX),
    }));
    // 기록: 메서드·주소(쿼리 빼고)는 볼트 키로 암호화된 이름으로, 서버는 응답 코드·시간·실패 종류만 안다
    void report(vaultId, 'http_request', logTarget(built.method, built.url), res.error ? { status: 0, ms: res.total ?? 0, fail: res.error.fail } : { status: res.status, ms: res.timing.total ?? 0 });
  };

  const suggestName = (d: RequestDraft) => {
    try {
      return `${d.method} ${new URL(d.url.replace(/\{\{[^}]*\}\}/g, 'x')).pathname}`;
    } catch {
      return d.method;
    }
  };
  const save = async (asNew = false) => {
    if (!canEdit) return s.toast(t('이 볼트는 보기 권한만 있어 저장할 수 없습니다'), 'error');
    const key = tab.key;
    const d = tab.draft;
    let label = d.label.trim();
    // 아직 저장한 적 없는 탭(새 요청·기록·curl 에서 연 것)은 늘 이름을 확인받는다 — 모르는 새 사본이 생기지 않게
    if (!tab.selId || asNew) {
      const v = await s.askText({ title: asNew ? t('다른 이름으로 저장') : t('요청 저장'), label: t('이름'), value: asNew ? t('{label} (복사본)', { label: label || suggestName(d) }) : label || suggestName(d), confirmLabel: t('저장') });
      if (!v?.trim()) return;
      label = v.trim();
    }
    try {
      const data = { ...d, label };
      const saved = tab.selId && !asNew ? await vaultApi.updateRequest(tab.selId, data) : await vaultApi.createRequest(vid, data);
      await s.reloadItems();
      patchTab(vid, key, () => ({ selId: saved.id, draft: toDraft(saved), dirty: false }));
      s.toast(t('저장했습니다'), 'success');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  // ---------- 저장한 요청 다루기 (목록의 ⋯ · 오른쪽 클릭) ----------
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await s.reloadItems();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };
  const duplicate = (r: HttpRequestItem) =>
    run(async () => {
      const copy = await vaultApi.createRequest(vid, { ...toDraft(r), label: t('{label} (복사본)', { label: r.label }).slice(0, 120) });
      await s.reloadItems();
      openSaved(copy);
    });
  const rename = async (r: HttpRequestItem) => {
    const v = await s.askText({ title: t('이름 바꾸기'), label: t('이름'), value: r.label, confirmLabel: t('저장') });
    if (v?.trim() && v.trim() !== r.label) await run(() => vaultApi.updateRequest(r.id, { label: v.trim() }));
  };
  const move = async (r: HttpRequestItem) => {
    const v = await s.askText({ title: t('모음 옮기기'), label: t('모음 이름(비우면 모음 없음)'), value: r.collection, confirmLabel: t('옮기기') });
    if (v !== null && v.trim() !== r.collection) await run(() => vaultApi.updateRequest(r.id, { collection: v.trim() }));
  };
  const removeSaved = async (r: HttpRequestItem) => {
    const ok = await s.confirm({ title: t('요청 삭제'), message: t('{name} 요청을 지웁니다. 되돌릴 수 없습니다.', { name: r.label }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    await run(() => vaultApi.deleteRequest(r.id));
    dropTabs(sessionOf(vid).tabs.filter((tb) => tb.selId === r.id).map((tb) => tb.key));
  };
  const renameCollection = async (name: string, items: HttpRequestItem[]) => {
    const v = await s.askText({ title: t('모음 이름 바꾸기'), label: t('모음 이름'), value: name, confirmLabel: t('저장') });
    if (v === null || !v.trim() || v.trim() === name) return;
    await run(async () => {
      for (const r of items) await vaultApi.updateRequest(r.id, { collection: v.trim() });
    });
  };
  const itemMenu = (r: HttpRequestItem, anchor: DOMRect | { x: number; y: number }) =>
    openMenu({
      anchor,
      items: [
        { label: t('열기'), icon: <Send size={14} />, onClick: () => openSaved(r) },
        ...(canEdit
          ? ([
              { label: t('복제'), icon: <CopyPlus size={14} />, onClick: () => void duplicate(r) },
              { label: t('이름 바꾸기'), icon: <Pencil size={14} />, onClick: () => void rename(r) },
              { label: t('모음 옮기기'), icon: <FolderInput size={14} />, onClick: () => void move(r) },
              { divider: true },
              { label: t('삭제'), icon: <Trash2 size={14} />, danger: true, onClick: () => void removeSaved(r) },
            ] as MenuItem[])
          : []),
      ],
    });

  const copyCode = (kind: 'curl' | 'powershell' | 'fetch' | 'python') => {
    const built = buildRequest(draft, vars);
    // 규칙에 맞지 않는 메서드(붙여 넣은 curl 등)는 명령에 넣지 않는다 — 내보내기 함수도 거절한다
    if (!built.method) return s.toast(t('메서드가 올바르지 않습니다'), 'error');
    const text = kind === 'curl' ? toCurl(built) : kind === 'powershell' ? toPowerShell(built) : kind === 'fetch' ? toFetch(built) : toPython(built);
    void navigator.clipboard.writeText(text).then(() => s.toast(t('코드를 복사했습니다'), 'success'));
  };
  const moreMenu = (e: ReactMouseEvent<HTMLButtonElement>) =>
    openMenu({
      anchor: e.currentTarget.getBoundingClientRect(),
      align: 'right',
      items: [
        { header: t('코드로 복사') },
        { label: 'curl', icon: <Code size={14} />, onClick: () => copyCode('curl') },
        { label: 'PowerShell', icon: <Code size={14} />, onClick: () => copyCode('powershell') },
        { label: 'JavaScript (fetch)', icon: <Code size={14} />, onClick: () => copyCode('fetch') },
        { label: 'Python (requests)', icon: <Code size={14} />, onClick: () => copyCode('python') },
        { divider: true },
        { label: t('curl 붙여넣기'), icon: <ClipboardPaste size={14} />, onClick: () => setCurlDialog(true) },
        ...(canEdit ? [{ label: t('다른 이름으로 저장'), icon: <Save size={14} />, onClick: () => void save(true) }] : []),
        ...(tab.selId && canEdit
          ? ([
              { divider: true },
              {
                label: t('요청 삭제'),
                icon: <Trash2 size={14} />,
                danger: true,
                onClick: () => {
                  const r = requests.find((x) => x.id === tab.selId);
                  if (r) void removeSaved(r);
                },
              },
            ] as MenuItem[])
          : []),
      ],
    });

  const onKey = (e: ReactKeyboardEvent) => {
    // 대화상자(환경 변수·curl)는 포털이라 키가 여기까지 올라온다 — 거기서는 무시
    if ((e.target as HTMLElement).closest('.modal')) return;
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void save();
    }
  };

  // 요청 편집 칸과 응답 사이 경계를 끌어 높이를 바꾼다 (이 기기에 기억)
  const splitRef = useRef(split);
  splitRef.current = split;
  const onSplitDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = splitRef.current;
    const onMove = (ev: MouseEvent) => setSplit(Math.max(90, Math.min(window.innerHeight - 280, start + ev.clientY - startY)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      writeLs(SPLIT_KEY, String(Math.round(splitRef.current)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---------- 목록 ----------
  const q = query.trim().toLowerCase();
  const listed = requests.filter((r) => !q || [r.label, r.url, r.collection, r.method].some((v) => v.toLowerCase().includes(q)));
  const collections = useMemo(() => {
    const map = new Map<string, HttpRequestItem[]>();
    for (const r of listed) map.set(r.collection, [...(map.get(r.collection) ?? []), r]);
    return [...map.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0], locale())));
  }, [listed]);
  const collectionNames = useMemo(() => [...new Set(requests.map((r) => r.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b, locale())), [requests]);
  const toggleCollapsed = (name: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      writeLs(collapsedKey(vid), JSON.stringify([...next]));
      return next;
    });

  if (!bridge) {
    return (
      <div className="view">
        <EmptyState icon={<Globe size={22} />} title={t('HTTP 요청은 Terminas 앱에서만 사용할 수 있습니다')} text={t('요청은 내 PC에서 바로 나가고, Terminas 서버는 요청을 대신 보내지 않습니다.')} />
      </div>
    );
  }

  const params = [...queryParams(draft.url), ...draft.offParams];
  const onParams = params.filter((p) => p.on).length;
  const enabledHeaders = draft.headers.filter((h) => h.on && h.name.trim()).length;
  const missing = new Set<string>();
  const preview = usesVars(draft.url) ? substituteMasked(draft.url, vars, missing) : null;

  return (
    <div className="http-view" onKeyDown={onKey}>
      <aside className="http-list">
        <div className="http-side-head">
          <div className="seg">
            <button data-side="saved" className={side === 'saved' ? 'on' : ''} onClick={() => setSide('saved')}>
              {t('모음')}
            </button>
            <button data-side="history" className={side === 'history' ? 'on' : ''} onClick={() => setSide('history')}>
              {t('기록')}
              {ses.history.length > 0 && <span className="seg-count">{ses.history.length}</span>}
            </button>
          </div>
          <div className="toolbar-spacer" />
          <IconButton label={t('새 요청')} onClick={() => openNew()}>
            <Plus size={15} />
          </IconButton>
          <IconButton label={t('curl 붙여넣기')} onClick={() => setCurlDialog(true)}>
            <ClipboardPaste size={15} />
          </IconButton>
        </div>
        {side === 'saved' ? (
          <>
            <Input className="search-sm" placeholder={t('검색')} value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="http-list-items">
              {requests.length === 0 && <p className="muted small">{t('저장한 요청이 없습니다. 요청을 만들어 Ctrl+S로 저장해 주세요.')}</p>}
              {collections.map(([name, items]) => {
                const folded = collapsed.has(name) && !q;
                return (
                  <div key={name || '-'} className="http-collection">
                    <div className="http-collection-head">
                      <button className="http-collection-name" onClick={() => toggleCollapsed(name)}>
                        {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <span>{name || t('모음 없음')}</span>
                        <span className="http-count">{items.length}</span>
                      </button>
                      {canEdit && (
                        <IconButton
                          label={t('모음 메뉴')}
                          className="http-hover-btn"
                          onClick={(e) =>
                            openMenu({
                              anchor: e.currentTarget.getBoundingClientRect(),
                              align: 'right',
                              items: [
                                { label: t('이 모음에 새 요청'), icon: <Plus size={14} />, onClick: () => openNew({ ...blank(), collection: name }) },
                                ...(name ? [{ label: t('모음 이름 바꾸기'), icon: <Pencil size={14} />, onClick: () => void renameCollection(name, items) }] : []),
                              ],
                            })
                          }
                        >
                          <MoreHorizontal size={14} />
                        </IconButton>
                      )}
                    </div>
                    {!folded &&
                      items.map((r) => (
                        <div key={r.id} className={`http-item-row ${r.id === tab.selId ? 'on' : ''}`}>
                          <button
                            className="http-item"
                            onClick={() => openSaved(r)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              itemMenu(r, { x: e.clientX, y: e.clientY });
                            }}
                            title={r.url}
                          >
                            <span className="http-method" style={{ color: methodColor(r.method) }}>
                              {r.method}
                            </span>
                            <span className="http-item-label">{r.label}</span>
                          </button>
                          <IconButton label={t('더 보기')} className="http-hover-btn" onClick={(e) => itemMenu(r, e.currentTarget.getBoundingClientRect())}>
                            <MoreHorizontal size={14} />
                          </IconButton>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="http-list-items">
            {ses.history.length === 0 ? (
              <p className="muted small">{t('이번에 보낸 요청이 여기 쌓입니다. 토큰·본문이 들어 있을 수 있어 저장하지 않고, 앱을 닫거나 잠그면 사라집니다.')}</p>
            ) : (
              <>
                {ses.history.map((h) => (
                  <button key={h.id} className="http-item http-hist" onClick={() => openNew(cloneDraft(h.draft), { sent: h.sent, dirty: true })} title={h.sent.built.url}>
                    <span className="http-method" style={{ color: methodColor(h.draft.method) }}>
                      {h.draft.method}
                    </span>
                    <span className="http-item-label">
                      {h.draft.label || shortUrl(h.draft.url)}
                      <span className="http-hist-time">{new Date(h.sent.at).toTimeString().slice(0, 8)}</span>
                    </span>
                    {h.sent.res.error ? <span className="http-code fail sm">{httpFailLabel(h.sent.res.error.fail)}</span> : <span className={`http-code sm ${codeTone(h.sent.res.status)}`}>{h.sent.res.status}</span>}
                  </button>
                ))}
                <Button size="sm" variant="ghost" className="http-hist-clear" onClick={() => setSession(vid, (x) => ({ ...x, history: [] }))}>
                  <Trash2 size={13} /> {t('기록 지우기')}
                </Button>
              </>
            )}
          </div>
        )}
      </aside>

      <section className="http-main">
        <div className="http-tabstrip">
          <div className="http-rtabs" role="tablist">
            {ses.tabs.map((tb) => (
              <div key={tb.key} className={`http-rtab ${tb.key === tab.key ? 'on' : ''}`} onAuxClick={(e) => e.button === 1 && void closeTab(tb.key)}>
                <button className="http-rtab-main" role="tab" aria-selected={tb.key === tab.key} onClick={() => activate(tb.key)} title={tb.draft.url}>
                  <span className="http-method" style={{ color: methodColor(tb.draft.method) }}>
                    {tb.draft.method}
                  </span>
                  <span className="http-rtab-label">{tabTitle(tb.draft)}</span>
                  {tb.sending ? <Loader2 size={12} className="spin" /> : tb.dirty ? <span className="http-dirty" title={t('저장하지 않은 변경')} /> : null}
                </button>
                <button className="http-rtab-close" aria-label={t('탭 닫기')} onClick={() => void closeTab(tb.key)}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <IconButton label={t('새 요청')} className="http-rtab-add" onClick={() => openNew()}>
              <Plus size={15} />
            </IconButton>
          </div>
          <div className="http-envpick">
            <Select value={env ? env.id : ''} onChange={(e) => setEnvId(e.target.value)} aria-label={t('환경')}>
              <option value="">{t('환경 없음')}</option>
              {httpEnvs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
            <IconButton label={t('환경 변수 편집')} onClick={() => setEnvEditor(true)}>
              <SlidersHorizontal size={15} />
            </IconButton>
          </div>
        </div>

        <div className="http-work">
          <div className="http-crumbs">
            <input className="http-crumb col" list={`http-cols-${vid}`} placeholder={t('모음')} value={draft.collection} onChange={(e) => update({ collection: e.target.value })} aria-label={t('모음')} spellCheck={false} />
            <datalist id={`http-cols-${vid}`}>
              {collectionNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <span className="http-crumb-sep">/</span>
            <input className="http-crumb name" placeholder={t('이름 없는 요청')} value={draft.label} onChange={(e) => update({ label: e.target.value })} aria-label={t('이름')} spellCheck={false} />
            <div className="toolbar-spacer" />
            <Button size="sm" disabled={!canEdit} onClick={() => void save()} title="Ctrl+S">
              <Save size={14} /> {tab.dirty || !tab.selId ? t('저장') : t('저장됨')}
            </Button>
            <IconButton label={t('더 보기')} onClick={moreMenu}>
              <MoreHorizontal size={15} />
            </IconButton>
          </div>

          <div className="http-bar">
            <Select className="http-method-select" value={draft.method} onChange={(e) => update({ method: e.target.value })} aria-label={t('메서드')}>
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Input className="mono http-url" placeholder="https://api.example.com/v1/items" value={draft.url} onChange={(e) => update({ url: e.target.value })} spellCheck={false} aria-label={t('주소')} />
            {/* 인증서 확인을 끈 요청은 설정 탭 밖에서도 보이게 (공유된 요청에 켜져 있을 수 있다) — 누르면 설정 탭으로 */}
            {draft.insecure && (
              <button type="button" className="http-insecure" style={{ flex: '0 0 auto', display: 'inline-flex' }} title={t('자체 서명 인증서를 사용하는 내부 서버를 시험할 때만 켜 주세요. 켜면 중간에서 가로채도 알 수 없습니다.')} onClick={() => setPane('options')}>
                <Badge tone="warn">
                  <ShieldOff size={12} style={{ marginRight: 4 }} />
                  {t('인증서 확인 꺼짐')}
                </Badge>
              </button>
            )}
            {tab.sending ? (
              <Button variant="soft" onClick={() => bridge.cancel(tab.sending!)}>
                <Square size={14} /> {t('취소')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void send()} title="Ctrl+Enter">
                <Send size={14} /> {t('보내기')}
              </Button>
            )}
          </div>
          {preview !== null && (
            <p className="http-preview mono" title={t('환경 변수를 채운 주소(가리기로 한 값은 ●●)')}>
              <CornerDownRight size={12} /> {preview}
              {missing.size > 0 && <span className="warn-text"> {t('환경에 없는 변수: {names}', { names: [...missing].join(', ') })}</span>}
            </p>
          )}
          {!canEdit && <p className="readonly-note">{t('보기 전용 볼트 — 요청을 보낼 수는 있지만 저장할 수는 없습니다')}</p>}

          <div className="http-tabs" role="tablist">
            {(
              [
                ['params', 'Params', onParams],
                ['auth', t('인증'), draft.auth.type !== 'none' ? -1 : 0],
                ['headers', t('헤더'), enabledHeaders],
                ['body', t('본문'), draft.bodyType !== 'none' ? -1 : 0],
                ['options', t('설정'), draft.insecure ? -1 : 0],
              ] as const
            ).map(([id, label, n]) => (
              <button key={id} role="tab" data-pane={id} aria-selected={pane === id} className={pane === id ? 'on' : ''} onClick={() => setPane(id)}>
                {label}
                {n > 0 && <span className="http-tab-count">{n}</span>}
                {n < 0 && <span className="http-tab-dot" />}
              </button>
            ))}
          </div>
          <div className="http-editor" style={{ height: split }}>
            {pane === 'params' && (
              <>
                <KvTable
                  rows={params}
                  toggle
                  insertAt={onParams}
                  onChange={(next) => update({ url: withParams(draft.url, next), offParams: next.filter((p) => !p.on).map((p) => ({ ...p, on: false })) })}
                  namePh={t('이름')}
                  valuePh={t('값')}
                />
                <p className="muted small">{t('주소의 ? 뒤와 같은 내용입니다 — 어느 쪽을 수정해도 서로 따라갑니다. 끈 줄은 보내지 않고 저장만 합니다.')}</p>
              </>
            )}
            {pane === 'auth' && <AuthEditor draft={draft} onChange={update} />}
            {pane === 'headers' && (
              <>
                <KvTable rows={draft.headers} toggle onChange={(headers) => update({ headers })} namePh={t('이름')} valuePh={t('값')} />
                <AutoHeaderList draft={draft} vars={vars} />
                <p className="muted small">{t('주소·헤더·본문·인증에 {{token}}처럼 쓰면 고른 환경의 같은 이름 변수 값으로 바뀝니다.')}</p>
              </>
            )}
            {pane === 'body' && <BodyEditor draft={draft} onChange={update} />}
            {pane === 'options' && <OptionsEditor draft={draft} onChange={update} />}
          </div>
          <div className="http-split" onMouseDown={onSplitDown} role="separator" aria-orientation="horizontal" title={t('끌어서 높이 바꾸기')} />
          <ResponseView sending={Boolean(tab.sending)} sent={tab.sent} />
        </div>
      </section>
      {menuNode}
      {envEditor && <EnvEditor envs={httpEnvs} canEdit={canEdit} onClose={() => setEnvEditor(false)} onPick={setEnvId} />}
      {curlDialog && (
        <CurlDialog
          onClose={() => setCurlDialog(false)}
          onImport={(d) => {
            openNew(d, { dirty: true });
            setCurlDialog(false);
          }}
        />
      )}
    </div>
  );
}

// 이름·값 표: 빈 줄에 쓰면 새 줄이 된다 (Params·헤더·폼 본문).
// 빈 줄은 insertAt 자리(Params 는 켜진 것과 끈 것 사이) — 새 줄이 그 자리에 생겨 쓰던 칸에서 커서가 튀지 않는다
function KvTable({ rows, onChange, toggle, insertAt = rows.length, namePh, valuePh }: { rows: HttpHeader[]; onChange: (rows: HttpHeader[]) => void; toggle?: boolean; insertAt?: number; namePh: string; valuePh: string }) {
  const all = [...rows.slice(0, insertAt), { name: '', value: '', on: true }, ...rows.slice(insertAt)];
  const set = (i: number, patch: Partial<HttpHeader>) => {
    if (i === insertAt) return onChange([...rows.slice(0, insertAt), { name: '', value: '', on: true, ...patch }, ...rows.slice(insertAt)]);
    const j = i < insertAt ? i : i - 1;
    onChange(rows.map((r, k) => (k === j ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => {
    const j = i < insertAt ? i : i - 1;
    onChange(rows.filter((_, k) => k !== j));
  };
  return (
    <div className="http-kv">
      {all.map((r, i) => {
        const empty = i === insertAt;
        return (
          <div key={i} className={`http-kv-row ${toggle ? '' : 'no-toggle'} ${r.on ? '' : 'off'}`}>
            {toggle && (empty ? <span /> : <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} aria-label={t('사용')} />)}
            <Input className="mono" placeholder={namePh} value={r.name} onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
            <Input className="mono" placeholder={valuePh} value={r.value} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
            {empty ? (
              <span />
            ) : (
              <IconButton label={t('지우기')} onClick={() => remove(i)}>
                <X size={14} />
              </IconButton>
            )}
          </div>
        );
      })}
    </div>
  );
}

const FROM_LABEL: Record<string, string> = { auth: tk('인증 탭'), body: tk('본문 탭'), app: tk('앱 기본값'), send: tk('보낼 때') };
function AutoHeaderList({ draft, vars }: { draft: RequestDraft; vars: HttpEnvVar[] }) {
  const [open, setOpen] = useState(false);
  const list = useMemo(() => autoHeaders(draft, vars, APP_VERSION()), [draft, vars]);
  return (
    <div className="http-auto">
      <button className="link-btn http-auto-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('앱이 붙이는 헤더 {count}개', { count: list.length })}
      </button>
      {open && (
        <>
          <table className="http-headers-table">
            <tbody>
              {list.map((h) => (
                <tr key={h.name}>
                  <th>{h.name}</th>
                  <td>{h.value}</td>
                  <td className="http-auto-from">
                    <Badge>{t(FROM_LABEL[h.from])}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{t('같은 이름의 헤더를 위 표에 입력하면 그 값을 사용합니다.')}</p>
        </>
      )}
    </div>
  );
}

// {{변수}} 는 JSON 이 아니어도 되게 0 으로 바꿔 본다
const jsonProblem = (text: string) => {
  if (!text.trim()) return '';
  try {
    JSON.parse(text.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '0'));
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

function BodyEditor({ draft, onChange }: { draft: RequestDraft; onChange: (p: Partial<RequestDraft>) => void }) {
  const tidy = () => {
    try {
      onChange({ body: JSON.stringify(JSON.parse(draft.body), null, 2) });
    } catch {}
  };
  const problem = draft.bodyType === 'json' ? jsonProblem(draft.body) : '';
  return (
    <div className="http-body-editor">
      <div className="http-body-head">
        <div className="seg">
          {(
            [
              ['none', t('없음')],
              ['json', 'JSON'],
              ['text', t('텍스트')],
              ['xml', 'XML'],
              ['form', t('폼')],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={draft.bodyType === id ? 'on' : ''} onClick={() => onChange({ bodyType: id })}>
              {label}
            </button>
          ))}
        </div>
        {draft.bodyType === 'json' && (
          <Button size="sm" variant="ghost" onClick={tidy} disabled={Boolean(problem)}>
            {t('정리')}
          </Button>
        )}
      </div>
      {draft.bodyType === 'form' ? (
        <>
          <KvTable rows={formRows(draft.body)} onChange={(rows) => onChange({ body: formText(rows) })} namePh={t('이름')} valuePh={t('값')} />
          <p className="muted small">{t('application/x-www-form-urlencoded 형식으로 보냅니다.')}</p>
        </>
      ) : (
        draft.bodyType !== 'none' && (
          <>
            <Textarea
              className="mono http-body"
              value={draft.body}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder={draft.bodyType === 'json' ? '{\n  "key": "value"\n}' : draft.bodyType === 'xml' ? '<item>\n  <name>value</name>\n</item>' : ''}
              spellCheck={false}
              maxLength={32000}
            />
            {problem && <p className="warn-text small">{t('JSON 형식이 아닙니다: {reason}', { reason: problem })}</p>}
          </>
        )
      )}
      {draft.bodyType === 'none' && <p className="muted small">{t('이 요청은 본문 없이 보냅니다.')}</p>}
    </div>
  );
}

function AuthEditor({ draft, onChange }: { draft: RequestDraft; onChange: (p: Partial<RequestDraft>) => void }) {
  const a = draft.auth;
  const set = (patch: Partial<RequestDraft['auth']>) => onChange({ auth: { ...a, ...patch } });
  return (
    <div className="http-auth">
      <div className="seg">
        {(
          [
            ['none', t('없음')],
            ['bearer', 'Bearer'],
            ['basic', 'Basic'],
            ['apikey', t('API 키')],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={a.type === id ? 'on' : ''} onClick={() => set({ type: id })}>
            {label}
          </button>
        ))}
      </div>
      {a.type === 'bearer' && <Input className="mono" type="password" placeholder={t('토큰(또는 {{token}})')} value={a.token} onChange={(e) => set({ token: e.target.value })} autoComplete="off" />}
      {a.type === 'basic' && (
        <>
          <Input placeholder={t('사용자 이름')} value={a.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
          <Input type="password" placeholder={t('비밀번호')} value={a.password} onChange={(e) => set({ password: e.target.value })} autoComplete="off" />
        </>
      )}
      {a.type === 'apikey' && (
        <>
          <Input className="mono" placeholder={t('이름(예: X-API-Key)')} value={a.key} onChange={(e) => set({ key: e.target.value })} autoComplete="off" spellCheck={false} />
          <Input className="mono" type="password" placeholder={t('값(또는 {{apiKey}})')} value={a.token} onChange={(e) => set({ token: e.target.value })} autoComplete="off" />
          <div className="setting-row">
            <span>{t('넣을 곳')}</span>
            <Select value={a.keyIn} onChange={(e) => set({ keyIn: e.target.value === 'query' ? 'query' : 'header' })} aria-label={t('넣을 곳')}>
              <option value="header">{t('헤더')}</option>
              <option value="query">{t('쿼리 파라미터')}</option>
            </Select>
          </div>
        </>
      )}
      <p className="muted small">
        {a.type === 'none'
          ? t('인증 없이 보냅니다. 헤더에 직접 입력해도 됩니다.')
          : t('헤더에 같은 이름을 직접 입력했으면 그쪽을 사용합니다. 저장하면 볼트 키로 암호화돼 이 볼트를 사용하는 사람과 공유됩니다.')}
      </p>
    </div>
  );
}

function OptionsEditor({ draft, onChange }: { draft: RequestDraft; onChange: (p: Partial<RequestDraft>) => void }) {
  return (
    <div className="http-options">
      <div className="setting-row">
        <span>{t('시간 제한(초)')}</span>
        <Input type="number" min={1} max={300} value={String(draft.timeout)} onChange={(e) => onChange({ timeout: Math.min(300, Math.max(1, Math.round(Number(e.target.value) || 30))) })} className="http-timeout" />
      </div>
      <div className="setting-row">
        <span>{t('리다이렉트 따라가기(최대 10번)')}</span>
        <Toggle label={t('리다이렉트 따라가기(최대 10번)')} checked={draft.follow} onChange={(v) => onChange({ follow: v })} />
      </div>
      <div className="setting-row">
        <span>{t('인증서 확인 끄기')}</span>
        <Toggle label={t('인증서 확인 끄기')} checked={draft.insecure} onChange={(v) => onChange({ insecure: v })} />
      </div>
      <p className="muted small">{t('자체 서명 인증서를 사용하는 내부 서버를 시험할 때만 켜 주세요. 켜면 중간에서 가로채도 알 수 없습니다.')}</p>
      <p className="muted small">{t('다른 사이트로 넘어가는 리다이렉트에서는 Authorization·Cookie·API 키 헤더와 가린 변수를 사용하는 헤더를 떼어 냅니다. 이런 인증 정보가 있으면 https에서 http로 넘어가는 리다이렉트는 따라가지 않습니다.')}</p>
    </div>
  );
}

// ---------- 응답 ----------
function ResponseView({ sending, sent }: { sending: boolean; sent: Sent | null }) {
  const [view, setView] = useState<'body' | 'headers' | 'cookies' | 'timing'>('body');
  const [raw, setRaw] = useState(false);
  const res = sent?.res;
  const decoded = useMemo(() => {
    if (!res || res.error) return null;
    const bytes = decodeBody(res.body);
    const contentType = res.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '';
    if (looksBinary(bytes, contentType)) return { binary: true as const, bytes, contentType };
    const full = new TextDecoder().decode(bytes);
    let pretty: string | null = null;
    if (full.length <= PARSE_LIMIT && (/json/i.test(contentType) || /^\s*[{[]/.test(full))) {
      try {
        pretty = JSON.stringify(JSON.parse(full), null, 2);
      } catch {}
    }
    return { binary: false as const, bytes, full, pretty, contentType };
  }, [res]);
  // 화면에는 앞부분만 (긴 글을 통째로 그리면 창이 한참 멈춘다 — 복사·저장은 전체) · 색칠은 더 작을 때만
  const body = useMemo(() => {
    if (!decoded || decoded.binary) return null;
    const formatted = decoded.pretty !== null && !raw;
    const source = formatted ? decoded.pretty! : decoded.full;
    const clipped = source.length > SHOW_LIMIT;
    const text = clipped ? source.slice(0, SHOW_LIMIT) : source;
    return { formatted, clipped, text, tokens: formatted && !clipped && text.length <= COLOR_LIMIT ? jsonTokens(text) : null };
  }, [decoded, raw]);
  const cookies = useMemo(() => (res && !res.error ? parseCookies(res.headers) : []), [res]);

  if (sending) {
    return (
      <div className="http-response http-response-empty">
        <Loader2 size={15} className="spin" /> {t('보내는 중…')}
      </div>
    );
  }
  if (!res) return <div className="http-response http-response-empty muted">{t('보내기(Ctrl+Enter)를 누르면 응답이 여기 나옵니다.')}</div>;
  if (res.error) {
    return (
      <div className="http-response">
        <div className="http-status">
          <span className="http-code fail">{httpFailLabel(res.error.fail)}</span>
          {res.total != null && <span className="muted">{`${Math.round(res.total)} ms`}</span>}
        </div>
        <p className="login-error">{tMsg(res.error.message)}</p>
      </div>
    );
  }
  const code = res.status;
  // https → http 리다이렉트를 앱 본체가 따라가지 않았으면 (인증 정보를 싣고 있었을 때) 3xx 응답과 함께 알려 준다
  const blocked = (res as HttpResponse).blockedRedirect ?? null;
  const saveBody = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([decoded!.bytes as BlobPart], { type: decoded?.contentType || 'application/octet-stream' }));
    let name = 'response';
    try {
      name = new URL(res.url).pathname.split('/').filter(Boolean).pop() || 'response';
    } catch {}
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const tm = res.timing;
  const bars: [string, number | null][] = [
    [t('주소 찾기'), tm.dns],
    [t('연결'), tm.connect],
    ['TLS', tm.tls],
    [t('첫 바이트까지'), tm.ttfb],
    [t('받기'), tm.download],
  ];
  const total = tm.total ?? 0;
  return (
    <div className="http-response">
      <div className="http-status">
        <div className="seg">
          {(
            [
              ['body', t('본문'), 0],
              ['headers', t('헤더'), res.headers.length],
              ['cookies', t('쿠키'), cookies.length],
              ['timing', t('시간·연결'), 0],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} data-view={id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>
              {label}
              {n > 0 && <span className="seg-count">{n}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        <span className={`http-code ${codeTone(code)}`}>
          {code} {res.statusText}
        </span>
        <span className="muted" title={t('전체 시간')}>{`${Math.round(total)} ms`}</span>
        <span className="muted" title={t('받은 크기')}>
          {sizeText(res.size)}
        </span>
        {res.truncated && <span className="warn-text small">{t('20MB까지만 받았습니다')}</span>}
        {res.tls && !res.tls.authorized && <Badge tone="warn">{t('인증서 확인 꺼짐')}</Badge>}
      </div>
      {blocked && <p className="warn-text small http-blocked" style={{ margin: 0, padding: '6px 10px', borderBottom: '1px solid var(--line-soft)', overflowWrap: 'anywhere' }}>{t('https에서 http로 넘어가는 리다이렉트라 따라가지 않았습니다. 인증 정보나 본문이 암호화되지 않은 연결로 나가지 않게 멈췄습니다. 넘어가려던 주소: {url}', { url: blocked.url })}</p>}
      {view === 'body' && decoded && (
        <div className="http-resp-tools">
          {!decoded.binary && decoded.pretty !== null && (
            <div className="seg">
              <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>
                {t('정리')}
              </button>
              <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
                {t('원본')}
              </button>
            </div>
          )}
          <span className="muted small">{decoded.contentType}</span>
          <div className="toolbar-spacer" />
          {!decoded.binary && (
            <IconButton label={t('본문 복사')} onClick={() => void navigator.clipboard.writeText(decoded.full)}>
              <Copy size={14} />
            </IconButton>
          )}
          <IconButton label={t('파일로 저장')} onClick={saveBody}>
            <Download size={14} />
          </IconButton>
        </div>
      )}
      <div className="http-response-body">
        {view === 'body' &&
          (!decoded ? null : decoded.binary ? (
            <p className="muted">{t('글이 아닌 응답입니다({type}, {size}). 파일로 저장해서 확인해 주세요.', { type: decoded.contentType || '?', size: sizeText(decoded.bytes.length) })}</p>
          ) : (
            body && (
              <>
                {body.clipped && <p className="warn-text small">{t('너무 길어서 앞 {size}만 보여 줍니다. 전체는 파일로 저장해서 확인해 주세요.', { size: sizeText(SHOW_LIMIT) })}</p>}
                <pre className="http-pre">{body.tokens ? body.tokens.map((tok, i) => (tok.kind === 'punct' ? tok.text : <span key={i} className={`j-${tok.kind}`}>{tok.text}</span>)) : body.text || t('(본문 없음)')}</pre>
              </>
            )
          ))}
        {view === 'headers' && (
          <table className="http-headers-table">
            <tbody>
              {res.headers.map(([n, v], i) => (
                <tr key={i}>
                  <th>{n}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === 'cookies' &&
          (cookies.length === 0 ? (
            <p className="muted small">{t('이 응답은 쿠키(Set-Cookie)를 보내지 않았습니다.')}</p>
          ) : (
            <table className="http-headers-table">
              <tbody>
                {cookies.map((c, i) => (
                  <tr key={i}>
                    <th>{c.name}</th>
                    <td>
                      {c.value}
                      {c.attrs.length > 0 && <div className="muted small">{c.attrs.join(' · ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {view === 'timing' && (
          <div className="http-timing">
            {bars.map(([label, v]) =>
              v === null ? null : (
                <div key={label} className="http-timing-row">
                  <span>{label}</span>
                  <div className="http-timing-bar">
                    <div style={{ width: `${total ? Math.max(2, (v / total) * 100) : 0}%` }} />
                  </div>
                  <span className="mono">{`${v} ms`}</span>
                </div>
              ),
            )}
            <div className="http-timing-row total">
              <span>{t('전체')}</span>
              <span className="muted small">{res.redirects.length ? t('리다이렉트 {count}번 포함 — 위 막대는 마지막 요청', { count: res.redirects.length }) : ''}</span>
              <span className="mono">{`${total} ms`}</span>
            </div>
            <dl className="http-facts">
              <dt>{t('최종 주소')}</dt>
              <dd className="mono">{res.url}</dd>
              {res.remote?.address && (
                <>
                  <dt>{t('접속한 주소')}</dt>
                  <dd className="mono">{`${res.remote.address}:${res.remote.port}`}</dd>
                </>
              )}
              <dt>HTTP</dt>
              <dd className="mono">{res.httpVersion}</dd>
              {res.tls && (
                <>
                  <dt>
                    <Lock size={12} /> TLS
                  </dt>
                  <dd>
                    {`${res.tls.protocol ?? ''} · ${res.tls.cipher ?? ''}`}
                    <br />
                    {t('인증서: {subject}(발급: {issuer}, 만료: {until})', { subject: res.tls.subject ?? '?', issuer: res.tls.issuer ?? '?', until: res.tls.validTo ?? '?' })}
                    {!res.tls.authorized && <div className="warn-text">{t('인증서를 확인하지 않고 받았습니다: {reason}', { reason: res.tls.authorizationError ?? '?' })}</div>}
                  </dd>
                </>
              )}
              {res.redirects.length > 0 && (
                <>
                  <dt>{t('리다이렉트')}</dt>
                  <dd>
                    {res.redirects.map((r, i) => (
                      <div key={i} className="mono small">
                        <CornerDownRight size={11} /> {`${r.status} → ${r.url}`}
                      </div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 환경 변수 ----------
function EnvEditor({ envs, canEdit, onClose, onPick }: { envs: HttpEnv[]; canEdit: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const s = useStore();
  const [cur, setCur] = useState<string | null>(envs[0]?.id ?? null);
  const current = envs.find((e) => e.id === cur) ?? null;
  const [name, setName] = useState(current?.name ?? '');
  const [vars, setVars] = useState<HttpEnvVar[]>(current?.vars ?? []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(current?.name ?? '');
    setVars(current?.vars.map((v) => ({ ...v })) ?? []);
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    act(async () => {
      const v = await s.askText({ title: t('새 환경'), label: t('이름(예: 개발, 운영)'), value: '', confirmLabel: t('만들기') });
      if (!v?.trim()) return;
      const env = await vaultApi.createHttpEnv(s.vault.id, { name: v.trim(), vars: [] });
      await s.reloadItems();
      setCur(env.id);
    });
  const save = () =>
    act(async () => {
      if (!current) return;
      await vaultApi.updateHttpEnv(current.id, { name, vars: vars.filter((v) => v.key.trim()) });
      await s.reloadItems();
      s.toast(t('저장했습니다'), 'success');
    });
  const remove = () =>
    act(async () => {
      if (!current) return;
      const ok = await s.confirm({ title: t('환경 삭제'), message: t('{name} 환경과 그 안의 변수를 지웁니다.', { name: current.name }), confirmLabel: t('삭제'), danger: true });
      if (!ok) return;
      await vaultApi.deleteHttpEnv(current.id);
      await s.reloadItems();
      setCur(null);
    });

  return (
    <Modal title={t('환경 변수')} onClose={onClose} width={760}>
      <div className="http-env-editor">
        <div className="http-env-list">
          {envs.map((e) => (
            <button key={e.id} className={e.id === cur ? 'on' : ''} onClick={() => setCur(e.id)}>
              {e.name}
            </button>
          ))}
          {canEdit && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void create()}>
              <Plus size={14} /> {t('새 환경')}
            </Button>
          )}
        </div>
        <div className="http-env-body">
          {!current ? (
            <p className="muted small">{t('환경마다 변수(예: 개발·운영 서버 주소 base, 토큰 token)를 정해 두면 주소·헤더·본문·인증에 {{base}}처럼 사용할 수 있습니다. 볼트 키로 암호화돼 이 볼트를 사용하는 사람과 공유됩니다.')}</p>
          ) : (
            <>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} aria-label={t('이름')} />
              <div className="http-rows">
                {vars.map((v, i) => (
                  <div key={i} className="http-row">
                    <Input className="mono" placeholder={t('이름')} value={v.key} disabled={!canEdit} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^\w.-]/g, '') } : x)))} />
                    <Input className="mono" type={v.secret ? 'password' : 'text'} placeholder={t('값')} value={v.value} disabled={!canEdit} autoComplete="off" onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <label className="check small">
                      <input type="checkbox" checked={v.secret} disabled={!canEdit} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} />
                      {t('가리기')}
                    </label>
                    {canEdit && (
                      <IconButton label={t('지우기')} onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                        <X size={14} />
                      </IconButton>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => setVars([...vars, { key: '', value: '', secret: false }])}>
                    <Plus size={14} /> {t('변수 추가')}
                  </Button>
                )}
              </div>
              <div className="row-actions">
                <Button size="sm" onClick={() => (onPick(current.id), onClose())}>
                  {t('이 환경 사용하기')}
                </Button>
                {canEdit && (
                  <>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                      {t('저장')}
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
                      {t('삭제')}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CurlDialog({ onClose, onImport }: { onClose: () => void; onImport: (d: RequestDraft) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void navigator.clipboard
      .readText()
      .then((c) => /^\s*curl(\.exe)?\s/i.test(c) && setText(c))
      .catch(() => {});
  }, []);
  return (
    <Modal
      title={t('curl 명령 가져오기')}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('취소')}
          </Button>
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              const d = parseCurl(text);
              if (!d) return setError(t('curl 명령을 읽지 못했습니다. curl로 시작하고 주소가 있어야 합니다.'));
              onImport(d);
            }}
          >
            {t('가져오기')}
          </Button>
        </>
      }
    >
      <Textarea className="mono http-curl" value={text} onChange={(e) => setText(e.target.value)} placeholder={"curl -X POST 'https://api.example.com/items' -H 'Content-Type: application/json' -d '{\"a\":1}'"} spellCheck={false} autoFocus />
      {error && <p className="login-error">{error}</p>}
    </Modal>
  );
}
