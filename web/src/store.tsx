import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorMessage, type AuthConfig, type Host, type Items, type Me, type PendingInvite, type PendingShare, type Vault } from './api';
import { loadPrefs, savePrefs, type Prefs } from './themes';
import { desktop } from './desktop';
import { allowLeave, autoLockMinutes, markAutoLocked, watchIdle } from './autolock';
import { EMPTY_ITEMS, acceptStale, currentAccount, disablePersonalSync, dropTeamCopies, enablePersonalSync, expireCopies, flushAudits, flushPersist, initMissingKeys, loadVault, onSyncResult, setAccount, setVaults, syncAll, trustVaultKeyOnce, UntrustedVaultKey, type SyncResult } from './vault';
import { HOST_OS_EVENT } from './os-detect';
import { t } from './i18n';
import { compatWith } from './compat';
import { isOnline, onAppOutdated, onNetChange, onWake, setOnline } from './net';
import * as O from './offline';

export type Section = 'hosts' | 'keychain' | 'forwarding' | 'snippets' | 'known' | 'http' | 'logs';
export type TermState = 'connecting' | 'connected' | 'closed';
export type TerminalTab = { id: string; kind: 'terminal'; mode: 'remote' | 'local'; hostId: string; title: string; vaultId: string; state: TermState; seq: number };
export type Tab = TerminalTab | { id: string; kind: 'picker' };
export type Toast = { id: number; message: string; kind: 'info' | 'error' | 'success' };
export type ConfirmRequest = { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void };
export type TextRequest = { title: string; label?: string; value: string; confirmLabel?: string; hint?: string; resolve: (value: string | null) => void };
// online: 서버와 연결됨 · offline: 이 PC 의 사본으로 쓰는 중(앱) · local: 사본도 없이 연 임시 모드(앱)
export type NetMode = 'online' | 'offline' | 'local';

type Store = {
  me: Me;
  refreshMe: () => Promise<void>;
  vault: Vault;
  setVaultId: (id: string) => void;
  items: Items;
  itemsLoading: boolean;
  // ready: 풀림 · waiting: 볼트 키를 아직 공유받지 못함 · untrusted: 누가 봉했는지 모르는 예전 방식 키 (열지 물어본다) · error: 못 품
  // stale: 서버가 예전 판을 내밀어 숨긴 항목 수
  vaultState: { status: 'ready' | 'waiting' | 'untrusted' | 'error'; message?: string; failed?: number; stale?: number };
  reloadItems: () => Promise<void>;
  trustVaultKey: () => Promise<void>;
  acceptStaleItems: () => Promise<void>;
  acceptInvite: (invite: PendingInvite, code?: string) => Promise<boolean>;
  declineInvite: (invite: PendingInvite) => Promise<void>;
  pendingShares: PendingShare[];
  refreshPending: () => Promise<void>;
  isApp: boolean;
  section: Section;
  setSection: (s: Section) => void;
  tabs: Tab[];
  active: string;
  setActive: (id: string) => void;
  openTerminal: (host: Host) => Promise<void>;
  openLocalTerminal: () => void;
  reconnect: (tabId: string) => void;
  openPicker: () => void;
  closeTab: (id: string) => void;
  setTabState: (id: string, state: TermState) => void;
  sftpOpened: boolean;
  sftpRequest: { host: Host; nonce: number } | null;
  openSftp: (host?: Host) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  toast: (message: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
  confirm: (req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;
  confirmRequest: ConfirmRequest | null;
  askText: (req: Omit<TextRequest, 'resolve'>) => Promise<string | null>;
  textRequest: TextRequest | null;
  settingsOpen: string | null;
  openSettings: (page?: string) => void;
  closeSettings: () => void;
  lock: () => Promise<void>;
  logout: () => Promise<void>;
  // 오프라인 사용 (앱)
  mode: NetMode;
  offlineCapable: boolean;
  lastSync: number;
  // 다시 연결하려다 로그인이 끝난 것을 알았다 / 서버와 앱 버전이 맞지 않는다 / 계정·암호화 키가 바뀌었다
  authLost: boolean;
  serverIssue: 'incompatible' | 'account_changed' | null;
  reconnectNow: () => void;
  syncNow: () => Promise<void>;
  personalSync: boolean;
  setPersonalSync: (on: boolean, deleteServerCopy?: boolean) => Promise<void>;
};

const Ctx = createContext<Store | null>(null);

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('store missing');
  return s;
}

const EMPTY: Items = EMPTY_ITEMS;

function readVaultId() {
  try {
    return localStorage.getItem('shell.vault');
  } catch {
    return null;
  }
}

// 켤 때 먼저 보일 볼트 (비어 있으면 마지막으로 연 볼트). 이 기기에만
const START_VAULT_KEY = 'terminas.startVault';
export function getStartVault() {
  try {
    return localStorage.getItem(START_VAULT_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setStartVault(id: string) {
  try {
    if (id) localStorage.setItem(START_VAULT_KEY, id);
    else localStorage.removeItem(START_VAULT_KEY);
  } catch {}
}

const tabId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 서버와 맞춘 결과를 한 줄로 (오프라인에서 고친 것을 올렸을 때)
function syncSummary(r: SyncResult) {
  const parts: string[] = [];
  if (r.pushed + r.restored) parts.push(t('오프라인에서 수정한 것 {count}개를 서버에 올렸습니다.', { count: r.pushed + r.restored }));
  if (r.conflicts) parts.push(t('다른 곳에서도 수정한 항목 {count}개는 서버 것을 두고, 이 PC에서 수정한 것은 "충돌 사본"으로 남겼습니다.', { count: r.conflicts }));
  if (r.kept) parts.push(t('다른 곳에서 수정한 항목 {count}개는 지우지 않고 남겼습니다.', { count: r.kept }));
  if (r.failed) parts.push(t('{count}개는 올리지 못했습니다. 다음에 다시 올립니다.', { count: r.failed }));
  return parts.join(' ');
}

export function StoreProvider({ initialMe, initialMode = 'online', children }: { initialMe: Me; initialMode?: NetMode; children: ReactNode }) {
  const [me, setMe] = useState(initialMe);
  const localMode = initialMode === 'local';
  const offlineCapable = Boolean(desktop?.cache) && O.offlineReady() && !localMode;
  const [online, setOnlineState] = useState(() => (localMode ? false : isOnline()));
  const [lastSync, setLastSync] = useState(O.lastSync);
  const [authLost, setAuthLost] = useState(false);
  const [serverIssue, setServerIssue] = useState<Store['serverIssue']>(null);
  const [personalSync, setPersonalSyncState] = useState(O.personalSync);
  const mode: NetMode = localMode ? 'local' : online ? 'online' : 'offline';
  const [vaultId, setVaultIdState] = useState<string>(() => {
    const start = getStartVault();
    if (start && initialMe.vaults.some((v) => v.id === start)) return start;
    const saved = readVaultId();
    return initialMe.vaults.some((v) => v.id === saved) ? saved! : initialMe.vaults[0].id;
  });
  const [items, setItems] = useState<Items>(EMPTY);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [vaultState, setVaultState] = useState<Store['vaultState']>({ status: 'ready' });
  const [pendingShares, setPendingShares] = useState<PendingShare[]>([]);
  const [section, setSection] = useState<Section>('hosts');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActiveState] = useState('vault');
  const [sftpOpened, setSftpOpened] = useState(false);
  const [sftpRequest, setSftpRequest] = useState<{ host: Host; nonce: number } | null>(null);
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [textRequest, setTextRequest] = useState<TextRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const toastSeq = useRef(0);
  const loadSeq = useRef(0);

  const rawVault = me.vaults.find((v) => v.id === vaultId) ?? me.vaults[0];
  // 오프라인에서 팀 볼트는 보기만 (화면의 편집 단추를 숨긴다 — vault.ts 도 막는다)
  const vault = useMemo(() => (mode === 'offline' && rawVault.kind === 'team' && rawVault.perm === 'edit' ? { ...rawVault, perm: 'view' as const } : rawVault), [rawVault, mode]);

  const setActive = useCallback((id: string) => {
    if (id === 'sftp') setSftpOpened(true);
    setActiveState(id);
  }, []);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  // 누가 봉했는지 모르는 예전 방식 볼트 키를 사용자가 확인하고 연다 (이번 잠금 해제 동안만 — 열리면 내 키로 다시 봉해 둔다)
  const trustVaultKey = useCallback(async () => {
    trustVaultKeyOnce(vaultRef.current.id);
    await reloadItemsRef.current();
  }, []);
  // 서버가 준 예전 판을 받아들인다 (서버를 백업에서 되살린 것처럼 이유를 알 때)
  const acceptStaleItems = useCallback(async () => {
    acceptStale(vaultRef.current.id);
    await reloadItemsRef.current();
  }, []);

  // 볼트 목록(과 내 볼트 키)을 다시 받는다
  const refreshMe = useCallback(async () => {
    const next = await api.get<Me>('/api/me');
    setVaults(next.vaults);
    setMe(next);
    void O.saveMe(next).then(() => O.pruneSnaps(next));
  }, []);

  // 관리자: 볼트 키를 기다리는 팀원 (앱·웹을 여는 관리자에게만 공유를 확인받는다)
  const isManager = me.teams.some((t) => t.role === 'owner' || t.role === 'admin');
  const refreshPending = useCallback(async () => {
    if (!isManager || !isOnline() || localMode) return setPendingShares([]);
    try {
      setPendingShares(await api.get<PendingShare[]>('/api/vault-keys/pending'));
    } catch {}
  }, [isManager, localMode]);
  useEffect(() => {
    void refreshPending();
    const timer = setInterval(() => void refreshPending(), 2 * 60 * 1000);
    return () => clearInterval(timer);
  }, [refreshPending]);

  // 새로 만든 팀·볼트처럼 아직 키가 없는 볼트는 바로 키를 만든다
  useEffect(() => {
    void initMissingKeys(me.vaults).then(() => refreshPending());
  }, [me.vaults, refreshPending]);

  const vaultRef = useRef(rawVault);
  vaultRef.current = rawVault;
  const reloadItemsRef = useRef<() => Promise<void>>(async () => {});
  const reloadItems = useCallback(async () => {
    const seq = ++loadSeq.current;
    const vault = vaultRef.current;
    try {
      const res = await loadVault(vault);
      if (seq !== loadSeq.current) return;
      setItems(res.items);
      setVaultState(res.state === 'waiting' ? { status: 'waiting' } : { status: 'ready', failed: res.failed, stale: res.stale });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setItems(EMPTY);
      setVaultState({ status: err instanceof UntrustedVaultKey ? 'untrusted' : 'error', message: errorMessage(err) });
    } finally {
      if (seq === loadSeq.current) setItemsLoading(false);
    }
  }, []);
  reloadItemsRef.current = reloadItems;

  // 팀 초대: 받은 사람이 수락해야 팀에 들어간다. 아이디·비밀번호 계정은 초대 코드도 낸다
  const acceptInvite = useCallback(
    async (invite: PendingInvite, code?: string) => {
      try {
        await api.post(`/api/me/invites/${invite.id}/accept`, code ? { code } : {});
        toast(t('{team} 팀에 들어갔습니다.', { team: invite.teamName }), 'success');
        await refreshMe();
        return true;
      } catch (err) {
        toast(errorMessage(err), 'error');
        return false;
      }
    },
    [toast, refreshMe],
  );
  const declineInvite = useCallback(
    async (invite: PendingInvite) => {
      try {
        await api.del(`/api/me/invites/${invite.id}`);
        await refreshMe();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
    [toast, refreshMe],
  );

  useEffect(() => {
    setItemsLoading(true);
    setItems(EMPTY);
    void reloadItems();
  }, [vault.id, vault.wrappedKey, reloadItems]);

  // 접속하면서 서버 OS 를 알아내면 호스트 아이콘을 다시 그린다
  useEffect(() => {
    const onOs = () => void reloadItems();
    window.addEventListener(HOST_OS_EVENT, onOs);
    return () => window.removeEventListener(HOST_OS_EVENT, onOs);
  }, [reloadItems]);

  const setVaultId = useCallback((id: string) => {
    setVaultIdState(id);
    setActiveState('vault');
    try {
      localStorage.setItem('shell.vault', id);
    } catch {}
  }, []);

  const addTab = useCallback((tab: TerminalTab) => {
    setTabs((ts) => {
      // 새 탭(검색) 자리에서 열면 그 자리를 바꿔 끼운다
      const pickerIndex = ts.findIndex((t) => t.kind === 'picker');
      if (pickerIndex >= 0) {
        const copy = [...ts];
        copy[pickerIndex] = tab;
        return copy;
      }
      return [...ts, tab];
    });
    setActiveState(tab.id);
  }, []);

  const openLocalTerminal = useCallback(
    () => addTab({ id: tabId(), kind: 'terminal', mode: 'local', hostId: '', title: t('로컬 터미널'), vaultId: '', state: 'connecting', seq: 0 }),
    [addTab],
  );

  const reconnect = useCallback((id: string) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'terminal' ? { ...t, seq: t.seq + 1, state: 'connecting' } : t)));
  }, []);

  const openPicker = useCallback(() => {
    setTabs((ts) => (ts.some((t) => t.kind === 'picker') ? ts : [...ts, { id: 'picker', kind: 'picker' }]));
    setActiveState('picker');
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const index = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      setActiveState((cur) => (cur !== id ? cur : next[Math.min(index, next.length - 1)]?.id ?? 'vault'));
      return next;
    });
  }, []);

  const setTabState = useCallback((id: string, state: TermState) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === 'terminal' && t.state !== state ? { ...t, state } : t)));
  }, []);

  const openSftp = useCallback((host?: Host) => {
    setSftpOpened(true);
    setActiveState('sftp');
    if (host) setSftpRequest({ host, nonce: Date.now() });
  }, []);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });
  }, []);

  const confirm = useCallback(
    (req: Omit<ConfirmRequest, 'resolve'>) =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest({
          ...req,
          resolve: (ok) => {
            setConfirmRequest(null);
            resolve(ok);
          },
        });
      }),
    [],
  );

  // 같은 호스트에 이미 열린 세션이 있으면 하나 더 열지 먼저 묻는다
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const openTerminal = useCallback(
    async (host: Host) => {
      const existing = tabsRef.current.find((t): t is TerminalTab => t.kind === 'terminal' && t.mode === 'remote' && t.hostId === host.id && t.state !== 'closed');
      if (existing) {
        const again = await confirm({
          title: t('이미 연결된 세션이 있습니다'),
          message: t('"{name}"에 이미 열려 있는 세션이 있습니다. 그래도 새 세션을 하나 더 열까요?', { name: host.label || host.address }),
          confirmLabel: t('새로 열기'),
          cancelLabel: t('기존 세션으로 이동'),
        });
        if (!again) {
          setTabs((ts) => ts.filter((t) => t.kind !== 'picker'));
          setActiveState(existing.id);
          return;
        }
      }
      addTab({ id: tabId(), kind: 'terminal', mode: 'remote', hostId: host.id, title: host.label || host.address, vaultId: host.vaultId, state: 'connecting', seq: 0 });
    },
    [addTab, confirm, toast],
  );

  const askText = useCallback(
    (req: Omit<TextRequest, 'resolve'>) =>
      new Promise<string | null>((resolve) => {
        setTextRequest({
          ...req,
          resolve: (value) => {
            setTextRequest(null);
            resolve(value);
          },
        });
      }),
    [],
  );

  // 잠그기: 이 기기에 기억한 잠금 해제를 지우고 다시 암호화 비밀번호를 묻는다
  const lock = useCallback(async () => {
    const account = currentAccount();
    if (account) await desktop?.unlock.forget(account.userId).catch(() => {});
    setAccount(null);
    allowLeave();
    location.reload();
  }, []);

  // 자동 잠금: 한동안 입력이 없으면 잠근다 (열려 있던 접속도 끊긴다)
  useEffect(
    () =>
      watchIdle(autoLockMinutes, () => {
        markAutoLocked();
        void lock();
      }),
    [lock],
  );

  const logout = useCallback(async () => {
    // 임시 모드: 로그인한 적이 없으니 처음 화면으로
    if (localMode) {
      allowLeave();
      location.href = '/';
      return;
    }
    // 이 PC 에만 있는 것(올리지 못한 변경·개인 동기화를 끈 개인 볼트)은 로그아웃하면 지워진다 — 먼저 묻는다
    await flushPersist().catch(() => {});
    const u = await O.unsyncedSummary().catch(() => ({ changes: 0, localOnly: false }));
    if (u.changes || u.localOnly) {
      const ok = await confirm({
        title: t('이 PC에만 있는 것이 지워집니다'),
        message: [
          u.localOnly ? t('개인 동기화가 꺼져 있어 개인 볼트가 이 PC에만 있습니다.') : '',
          u.changes ? t('아직 서버에 올리지 못한 변경이 {count}개 있습니다.', { count: u.changes }) : '',
          t('로그아웃하면 이 PC에서 지워지고 되살릴 수 없습니다. 그래도 로그아웃할까요?'),
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('로그아웃'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      if (desktop) await desktop.logout();
      else await api.post('/api/auth/logout');
    } finally {
      setAccount(null);
      allowLeave();
      location.href = '/';
    }
  }, [confirm, localMode]);

  // ---------- 오프라인 사용 (앱) ----------
  useEffect(() => onNetChange(() => setOnlineState(isOnline())), []);
  // 서버가 이 앱을 받지 않는다(426, 서버가 새 버전으로 바뀐 뒤) — 이 PC 의 사본으로 이어 가며 업데이트를 알린다
  useEffect(() => onAppOutdated(() => setServerIssue('incompatible')), []);
  useEffect(
    () =>
      onSyncResult((r) => {
        const text = syncSummary(r);
        if (text) toast(text, r.conflicts || r.failed ? 'info' : 'success');
      }),
    [toast],
  );

  const meRef = useRef(me);
  meRef.current = me;
  // 서버와 맞추기: 오프라인에서 모아 둔 기록을 올리고, 볼트를 모두 맞춘 뒤 지금 볼트를 다시 그린다
  const syncing = useRef(false);
  const syncNow = useCallback(async () => {
    if (localMode || !isOnline() || syncing.current) return;
    syncing.current = true;
    try {
      await flushAudits();
      await syncAll();
      setLastSync(O.lastSync());
      await reloadItems();
    } catch {
      // 끊겼으면 api.ts 가 오프라인으로 바꾼다 — 다시 붙으면 또 맞춘다
    } finally {
      syncing.current = false;
    }
  }, [localMode, reloadItems]);

  // 다시 붙어 보기: 서버가 맞는지 → 내 정보 → 연결됨으로 바꾸고 맞추기. 끝났으면(붙었거나 더 해 볼 것이 없으면) true
  const tryReconnect = useCallback(async (): Promise<boolean> => {
    try {
      const cfg = await api.get<AuthConfig>('/api/auth/config');
      if (desktop && compatWith(cfg) !== 'ok') {
        setServerIssue('incompatible');
        return false;
      }
      const next = await api.get<Me>('/api/me');
      const cur = meRef.current;
      // 다른 계정이 되었거나 암호화 키를 새로 만들었다 → 다시 열어야 한다 (열려 있는 접속은 그대로 두고 알리기만)
      if (next.user.id !== cur.user.id || next.crypto?.publicKey !== cur.crypto?.publicKey) {
        setServerIssue('account_changed');
        return true;
      }
      setServerIssue(null);
      setVaults(next.vaults);
      setMe(next);
      setOnline(true);
      await O.saveMe(next);
      await O.pruneSnaps(next);
      void syncNow();
      return true;
    } catch (err) {
      // 로그인이 끝났다: 팀에서 빠졌을 수도 있으니 팀 볼트 사본은 지우고, 내 개인 볼트로만 이어 간다
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        const gone = await dropTeamCopies();
        setMe((m) => ({ ...m, teams: [], vaults: m.vaults.filter((v) => !gone.includes(v.id)) }));
        setAuthLost(true);
        return true;
      }
      return false;
    }
  }, [syncNow]);

  const wakeRef = useRef<(() => void) | null>(null);
  const reconnectNow = useCallback(() => wakeRef.current?.(), []);

  // 끊겨 있는 동안: 3초부터 두 배씩 최대 1분 간격으로 다시 붙어 본다 (네트워크가 돌아오거나 어떤 요청이 닿으면 곧바로)
  useEffect(() => {
    if (online || localMode || authLost || serverIssue === 'account_changed') return;
    let stop = false;
    let busy = false;
    let delay = 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      if (busy || stop) return;
      busy = true;
      clearTimeout(timer);
      const done = await tryReconnect();
      busy = false;
      if (!done && !stop) {
        delay = Math.min(delay * 2, 60_000);
        timer = setTimeout(() => void attempt(), delay);
      }
    };
    wakeRef.current = () => void attempt();
    timer = setTimeout(() => void attempt(), delay);
    const offWake = onWake(() => void attempt());
    const onLine = () => void attempt();
    window.addEventListener('online', onLine);
    return () => {
      stop = true;
      clearTimeout(timer);
      offWake();
      wakeRef.current = null;
      window.removeEventListener('online', onLine);
    };
  }, [online, localMode, authLost, serverIssue, tryReconnect]);

  // 끊겨 있는 동안 1분마다: 팀이 정한 기간이 지난 팀 볼트 사본을 지우고 목록에서 뺀다
  useEffect(() => {
    if (online || localMode) return;
    const sweep = async () => {
      const gone = await expireCopies();
      if (!gone.length) return;
      setMe((m) => ({ ...m, vaults: m.vaults.filter((v) => !gone.includes(v.id)) }));
      toast(t('오프라인에서 사용할 수 있는 기간이 지난 팀 볼트 {count}개를 이 PC에서 지웠습니다. 서버에 연결되면 다시 받습니다.', { count: gone.length }), 'info');
    };
    void sweep();
    const timer = setInterval(() => void sweep(), 60_000);
    return () => clearInterval(timer);
  }, [online, localMode, toast]);

  // 연결돼 있는 동안: 켠 직후 한 번, 그 뒤 10분마다 모든 볼트의 사본을 새로 둔다 (팀 사본의 기한도 여기서 다시 센다)
  useEffect(() => {
    if (!online || localMode || !offlineCapable) return;
    const first = setTimeout(() => void syncNow(), 3000);
    const timer = setInterval(() => void syncNow(), 10 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [online, localMode, offlineCapable, syncNow]);

  const setPersonalSync = useCallback(
    async (on: boolean, deleteServerCopy = false) => {
      // 올린 결과는 onSyncResult 알림으로 뜬다
      if (on) await enablePersonalSync();
      else await disablePersonalSync(deleteServerCopy);
      setPersonalSyncState(O.personalSync());
      await reloadItems();
    },
    [reloadItems],
  );

  // 볼트 목록이 바뀌어 지금 볼트를 더 못 보게 되면 첫 볼트로 돌아간다
  useEffect(() => {
    if (!me.vaults.some((v) => v.id === vaultId)) setVaultIdState(me.vaults[0].id);
  }, [me.vaults, vaultId]);

  const value = useMemo<Store>(
    () => ({
      me,
      refreshMe,
      vault,
      setVaultId,
      items,
      itemsLoading,
      vaultState,
      reloadItems,
      trustVaultKey,
      acceptStaleItems,
      acceptInvite,
      declineInvite,
      pendingShares,
      refreshPending,
      isApp: Boolean(desktop),
      section,
      setSection,
      tabs,
      active,
      setActive,
      openTerminal,
      openLocalTerminal,
      reconnect,
      openPicker,
      closeTab,
      setTabState,
      sftpOpened,
      sftpRequest,
      openSftp,
      prefs,
      setPrefs,
      toast,
      toasts,
      confirm,
      confirmRequest,
      askText,
      textRequest,
      settingsOpen,
      openSettings: (page = 'account') => setSettingsOpen(page),
      closeSettings: () => setSettingsOpen(null),
      lock,
      logout,
      mode,
      offlineCapable,
      lastSync,
      authLost,
      serverIssue,
      reconnectNow,
      syncNow,
      personalSync,
      setPersonalSync,
    }),
    [
      me, refreshMe, vault, setVaultId, items, itemsLoading, vaultState, reloadItems, trustVaultKey, acceptStaleItems, acceptInvite, declineInvite, pendingShares, refreshPending, section, tabs, active, setActive, openTerminal, openLocalTerminal, reconnect, openPicker,
      closeTab, setTabState, sftpOpened, sftpRequest, openSftp, prefs, setPrefs, toast, toasts, confirm, confirmRequest, askText, textRequest, settingsOpen, lock, logout,
      mode, offlineCapable, lastSync, authLost, serverIssue, reconnectNow, syncNow, personalSync, setPersonalSync,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
