import { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Braces, CloudOff, Fingerprint, History, KeyRound, Loader2, LockKeyhole, RefreshCw, Send, Server, Settings, ShieldAlert, SquareTerminal, UserRound, Users } from 'lucide-react';
import { api, ApiError, errorMessage, isNetworkError, type AuthConfig, type Me } from './api';
import { compatWith, type Compat } from './compat';
import { forgetLoginPassword } from './login-secret';
import { desktop, legacyApp } from './desktop';
import { t, tk, useLang } from './i18n';
import * as E from './e2ee';
import { noteFreshAccount, setAccount, setVaults, startEphemeral, takeFreshAccount } from './vault';
import { isLeaving } from './autolock';
import { StoreProvider, useStore, type NetMode, type Section } from './store';
import { setOnline } from './net';
import * as O from './offline';
import { OfflineBanner } from './components/Offline';
import { Login } from './components/Login';
import { KeySetup, Unlock } from './components/Lock';
import { MfaPrompt } from './components/Mfa';
import { InviteBanner, ShareBanner } from './components/Share';
import { LegacyAppUpdate } from './components/LegacyApp';
import { TopBar } from './components/TopBar';
import { HostsView } from './components/Hosts';
import { KeychainView } from './components/Keychain';
import { KnownHostsView, LogsView, SnippetsView } from './components/Other';
import { TerminalView } from './components/Terminal';
import { Picker } from './components/Picker';
import { SettingsModal } from './components/Settings';
import { SftpScreen } from './components/Sftp';
import { ForwardingView, ForwardProvider } from './components/Forwarding';
import { HttpView } from './components/Http';
import { Badge, Button, ConfirmDialog, EmptyState, TextDialog, Toasts } from './components/ui';

const NAV: { id: Section; label: string; icon: typeof Server }[] = [
  { id: 'hosts', label: tk('호스트'), icon: Server },
  { id: 'keychain', label: tk('키체인'), icon: KeyRound },
  { id: 'forwarding', label: tk('포트 포워딩'), icon: ArrowRightLeft },
  { id: 'snippets', label: tk('스니펫'), icon: Braces },
  { id: 'known', label: tk('알려진 호스트'), icon: Fingerprint },
  // HTTP 요청은 앱에서만 (요청이 이 PC 에서 바로 나간다 — 웹·서버에는 이 기능이 없다)
  ...(desktop?.http ? [{ id: 'http' as const, label: tk('HTTP 요청'), icon: Send }] : []),
  { id: 'logs', label: tk('기록'), icon: History },
];

// 잠금을 푼 암호화 비밀번호가 로그인 비밀번호와 같을 때 (Lock.tsx 가 이 탭에 적어 둔다) — 서버가 볼트를 열 수 있는 상태
function SamePasswordBanner() {
  const s = useStore();
  const [same] = useState(() => {
    try {
      return sessionStorage.getItem('terminas.samePassword') === s.me.user.id;
    } catch {
      return false;
    }
  });
  if (!same) return null;
  return (
    <div className="banner warn">
      <ShieldAlert size={15} />
      <span>{t('암호화 비밀번호가 로그인 비밀번호와 같습니다. 같으면 서버가 암호화를 풀 수 있게 됩니다. 설정에서 암호화 비밀번호를 바꿔 주세요.')}</span>
      <Button size="sm" variant="ghost" onClick={() => s.openSettings('security')}>
        {t('설정')}
      </Button>
    </div>
  );
}

// 누가 봉했는지 모르는 예전 방식 볼트 키: 이유를 알 때만 연다
async function trustKey(s: ReturnType<typeof useStore>) {
  const ok = await s.confirm({
    title: t('이 볼트 키로 열까요?'),
    message: t('이전 버전 앱에서 공유받은 볼트라면 열어도 됩니다. 이 볼트에 새로 들어왔거나 최근에 공유받은 적이 없는데 이 안내가 보이면 열지 말고 팀 관리자에게 알려 주세요. 열면 이 볼트 키를 내 계정 키로 다시 봉해 둡니다.'),
    confirmLabel: t('열기'),
    danger: true,
  });
  if (ok) await s.trustVaultKey();
}

async function acceptStale(s: ReturnType<typeof useStore>) {
  const ok = await s.confirm({
    title: t('예전 판을 받아들일까요?'),
    message: t('서버를 백업에서 되살렸다는 등 이유를 알 때만 받아들여 주세요. 이유를 모르면 팀 관리자에게 먼저 알려 주세요.'),
    confirmLabel: t('받아들이기'),
    danger: true,
  });
  if (ok) await s.acceptStaleItems();
}

function VaultScreen() {
  const s = useStore();
  return (
    <div className="vault-screen">
      <nav className="sidebar" aria-label={t('볼트 메뉴')}>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${s.section === n.id ? 'active' : ''}`} onClick={() => s.setSection(n.id)}>
            <n.icon size={16} />
            {t(n.label)}
          </button>
        ))}
        <div className="sidebar-foot">
          <div className="vault-card">
            <div className="vault-card-icon">{s.vault.kind === 'team' ? <Users size={15} /> : <UserRound size={15} />}</div>
            <div className="vault-card-text">
              <div className="strong">{s.vault.name}</div>
              <div className="muted small">{s.vault.teamName ?? t('나만 보는 볼트')}</div>
            </div>
            {s.vault.perm === 'view' && <Badge tone="warn">{t('보기')}</Badge>}
          </div>
          <button className="nav-item" onClick={() => s.openSettings(s.vault.teamId ? `team:${s.vault.teamId}` : 'account')}>
            <Settings size={16} />
            {t('설정')}
          </button>
        </div>
      </nav>
      <main className="vault-main">
        <OfflineBanner />
        <InviteBanner />
        <SamePasswordBanner />
        <ShareBanner />
        {s.vaultState.status === 'ready' && Boolean(s.vaultState.failed) && (
          <div className="banner warn">
            <ShieldAlert size={15} /> {t('이 볼트의 항목 {count}개를 풀지 못해 숨겼습니다. 계속되면 관리자에게 알려 주세요.', { count: s.vaultState.failed ?? 0 })}
          </div>
        )}
        {s.vaultState.status === 'ready' && Boolean(s.vaultState.stale) && (
          <div className="banner warn">
            <ShieldAlert size={15} />
            <span>{t('서버가 이 볼트의 항목 {count}개를 이 기기에서 전에 본 것보다 예전 판(또는 지운 항목)으로 주어 숨겼습니다. 서버 쪽 변조일 수 있습니다.', { count: s.vaultState.stale ?? 0 })}</span>
            <Button size="sm" variant="ghost" onClick={() => void acceptStale(s)}>
              {t('예전 판 받아들이기')}
            </Button>
          </div>
        )}
        {/* 안내 줄은 위에 쌓고, 본문(목록 + 옆 패널)은 그 아래 가로로 */}
        <div className="vault-body">
          {s.section === 'logs' ? (
            <LogsView />
          ) : s.vaultState.status === 'waiting' ? (
            <VaultWaiting />
          ) : s.vaultState.status === 'untrusted' ? (
            <EmptyState icon={<ShieldAlert size={22} />} title={t('볼트 키의 출처를 확인할 수 없습니다')} text={s.vaultState.message ?? ''}>
              <Button onClick={() => void trustKey(s)}>{t('확인하고 열기')}</Button>
            </EmptyState>
          ) : s.vaultState.status === 'error' ? (
            <EmptyState icon={<ShieldAlert size={22} />} title={t('이 볼트를 열지 못했습니다')} text={s.vaultState.message ?? ''}>
              <Button variant="primary" onClick={() => void s.reloadItems()}>
                <RefreshCw size={14} /> {t('다시 시도')}
              </Button>
            </EmptyState>
          ) : (
            <>
              {s.section === 'hosts' && <HostsView />}
              {s.section === 'keychain' && <KeychainView />}
              {s.section === 'forwarding' && <ForwardingView />}
              {s.section === 'snippets' && <SnippetsView />}
              {s.section === 'known' && <KnownHostsView />}
            </>
          )}
          {/* 다른 메뉴(기록 포함)에 다녀와도 쓰던 요청·응답이 남도록 숨겨만 둔다 */}
          {desktop?.http && s.vaultState.status === 'ready' && (
            <div className="keep-alive" hidden={s.section !== 'http'}>
              <HttpView />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// 볼트 키를 아직 공유받지 못한 팀 볼트
function VaultWaiting() {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <EmptyState
      icon={<LockKeyhole size={22} />}
      title={t('볼트 키를 기다리는 중')}
      text={t('이 볼트의 내용은 팀원끼리만 풀 수 있게 암호화되어 있습니다. 팀 관리자가 Terminas 앱이나 웹을 열면 공유 요청이 뜨고, 관리자가 확인하면 여기서 열립니다.')}
    >
      <Button
        variant="primary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await s.refreshMe();
            await s.reloadItems();
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={14} /> {t('다시 확인')}
      </Button>
    </EmptyState>
  );
}

function Shell() {
  const s = useStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      // 터미널 안에서는 셸의 Ctrl 키(Ctrl+K 줄 지우기 등)를 살린다
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const key = e.key.toLowerCase();
      if (key === 'k') s.openPicker();
      else if (key === '1') s.setActive('vault');
      else if (key === '2') s.openSftp();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.openPicker, s.openSftp, s.setActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const open = s.tabs.filter((t) => t.kind === 'terminal' && t.state !== 'closed').length;
    if (!open) return;
    const warn = (e: BeforeUnloadEvent) => !isLeaving() && e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [s.tabs]);

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        {s.active === 'vault' && <VaultScreen />}
        {s.sftpOpened && <SftpScreen visible={s.active === 'sftp'} />}
        {s.tabs.map((t) =>
          t.kind === 'terminal' ? <TerminalView key={t.id} tab={t} visible={s.active === t.id} /> : <Picker key={t.id} visible={s.active === t.id} />,
        )}
      </div>
      <SettingsModal />
      <ConfirmDialog />
      <TextDialog />
      <Toasts />
    </div>
  );
}

type Boot =
  | { kind: 'loading' }
  | { kind: 'anon' }
  // Google 로그인은 끝났고 2단계 인증 코드를 기다린다
  | { kind: 'mfa' }
  // 서버에 닿지 않고 이 PC 에 사본도 없다 (앱은 임시 모드로 로컬 터미널·HTTP 요청을 쓸 수 있다)
  | { kind: 'offline'; message: string }
  // 앱과 서버의 버전이 맞지 않는다 (직접 운영하는 서버가 오래됐거나, 앱이 오래됐거나)
  | { kind: 'incompatible'; reason: Exclude<Compat, 'ok'> }
  | { kind: 'setup'; me: Me }
  | { kind: 'locked'; me: Me; mode: NetMode }
  | { kind: 'ready'; me: Me; mode: NetMode };

// 임시 모드(사본 없이 오프라인으로 연 앱)의 계정·볼트: 메모리에만 있다
const LOCAL_USER = '00000000-0000-4000-8000-000000000000';
const LOCAL_VAULT = '00000000-0000-4000-8000-000000000001';

// 로그아웃하면 이 PC 에만 있던 것이 지워진다 — 먼저 묻는다 (잠금 화면 등 store 밖)
async function confirmLocalLoss() {
  const u = await O.unsyncedSummary().catch(() => ({ changes: 0, localOnly: false }));
  if (!u.changes && !u.localOnly) return true;
  const lines = [
    u.localOnly ? t('개인 동기화가 꺼져 있어 개인 볼트가 이 PC에만 있습니다.') : '',
    u.changes ? t('아직 서버에 올리지 못한 변경이 {count}개 있습니다.', { count: u.changes }) : '',
    t('로그아웃하면 이 PC에서 지워지고 되살릴 수 없습니다. 그래도 로그아웃할까요?'),
  ];
  return window.confirm(lines.filter(Boolean).join('\n\n'));
}

export function App() {
  // 언어를 바꾸면 여기서부터 전체를 다시 그린다 (새로고침 없음)
  useLang();
  return legacyApp ? <LegacyAppUpdate /> : <Main />;
}

function Main() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });

  // 앱: 서버에 닿지 않으면 이 PC 에 둔 사본으로 연다 (없으면 "서버에 연결할 수 없습니다" — 임시 모드를 고를 수 있다)
  const bootOffline = async (message: string) => {
    const cached = desktop ? await O.loadMe() : null;
    if (!cached?.crypto) return setBoot({ kind: 'offline', message });
    setOnline(false);
    const me: Me = { ...cached, vaults: await O.offlineVaults(cached) };
    await unlockOrAsk(me, 'offline');
  };

  // 이 PC 에 기억해 둔 잠금 해제가 있으면 바로 연다 (앱)
  const unlockOrAsk = async (me: Me, mode: NetMode) => {
    if (desktop && me.crypto) {
      const saved = await desktop.unlock.recall(me.user.id).catch(() => null);
      if (saved) {
        try {
          const account = await E.openAccount(me.user.id, me.crypto.publicKey, me.crypto.bundle, E.fromB64(saved));
          return enter(me, account, mode);
        } catch {
          await desktop.unlock.forget(me.user.id).catch(() => {});
        }
      }
    }
    setBoot({ kind: 'locked', me, mode });
  };

  const start = useCallback(async () => {
    setBoot({ kind: 'loading' });
    // 앱: 화면을 앱이 들고 있으니 서버와 맞는지 먼저 본다 (웹은 서버가 준 화면이라 늘 맞다)
    if (desktop) {
      await O.offlineAvailable();
      try {
        const reason = compatWith(await api.get<AuthConfig>('/api/auth/config'));
        if (reason !== 'ok') return setBoot({ kind: 'incompatible', reason });
      } catch (err) {
        return isNetworkError(err) ? bootOffline(errorMessage(err)) : setBoot({ kind: 'offline', message: errorMessage(err) });
      }
    }
    let me: Me;
    try {
      me = await api.get<Me>('/api/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 로그인이 끝났다(팀에서 빠졌거나 계정이 막혔을 수 있다) — 이 PC 의 팀 볼트 사본을 지운다 (다시 로그인하면 다시 받는다)
        if (desktop) await O.dropTeamSnaps();
        return setBoot(err.code === 'mfa_required' ? { kind: 'mfa' } : { kind: 'anon' });
      }
      return isNetworkError(err) ? bootOffline(errorMessage(err)) : setBoot({ kind: 'offline', message: errorMessage(err) });
    }
    setOnline(true);
    // 앱: 이 사람의 사본으로 묶고(다른 사람이 쓰던 사본이면 지운다) 계정 정보를 둔다
    if (desktop) {
      await O.bindUser(me.user.id);
      await O.saveMe(me);
      void O.pruneSnaps(me);
    }
    if (!me.crypto) return setBoot({ kind: 'setup', me });
    await unlockOrAsk(me, 'online');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enter = (me: Me, account: E.Account, mode: NetMode = 'online') => {
    setAccount(account, { id: me.user.id, name: me.user.name || me.user.email });
    takeFreshAccount(me.user.id);
    setVaults(me.vaults);
    setBoot({ kind: 'ready', me, mode });
  };

  // 임시 모드: 서버에도 닿지 않고 사본도 없을 때 로컬 터미널·HTTP 요청만이라도 (여기서 만든 것은 앱을 닫으면 사라진다)
  const startLocal = () => {
    const name = t('이 PC');
    const me: Me = {
      user: { id: LOCAL_USER, email: '', name, avatarUrl: '', isAdmin: false, canCreateTeams: false },
      crypto: null,
      teams: [],
      vaults: [{ id: LOCAL_VAULT, kind: 'personal', name: 'Personal', teamId: null, teamName: null, perm: 'edit', isDefault: true, wrappedKey: null, keyed: true }],
    };
    startEphemeral({ id: LOCAL_USER, name });
    setVaults(me.vaults);
    setOnline(false);
    setBoot({ kind: 'ready', me, mode: 'local' });
  };

  // 사본도 없이 연결을 기다리는 동안: 서버가 돌아오면 저절로 다시 연다
  useEffect(() => {
    if (boot.kind !== 'offline' || !desktop) return;
    const timer = setInterval(() => {
      api.get<AuthConfig>('/api/auth/config').then(
        () => void start(),
        () => {},
      );
    }, 15_000);
    return () => clearInterval(timer);
  }, [boot.kind, start]);

  const logout = async () => {
    if (desktop && !(await confirmLocalLoss())) return;
    forgetLoginPassword();
    try {
      if (desktop) await desktop.logout();
      else await api.post('/api/auth/logout');
    } finally {
      location.href = '/';
    }
  };

  useEffect(() => void start(), [start]);

  if (boot.kind === 'loading')
    return (
      <div className="boot">
        <Loader2 className="spin" size={22} />
      </div>
    );
  if (boot.kind === 'anon') return <Login onDone={() => void start()} />;
  if (boot.kind === 'mfa') return <MfaPrompt onDone={() => void start()} onLogout={() => void logout()} />;
  if (boot.kind === 'offline')
    return (
      <div className="login">
        <div className="login-card lock-card">
          <div className="lock-icon">
            <CloudOff size={26} />
          </div>
          <h1>{t('서버에 연결할 수 없습니다')}</h1>
          <p className="login-sub">{boot.message}</p>
          <Button variant="primary" className="lock-wide" onClick={() => void start()}>
            <RefreshCw size={14} /> {t('다시 시도')}
          </Button>
          {desktop && (
            <>
              <Button className="lock-wide" onClick={startLocal}>
                <SquareTerminal size={14} /> {t('로컬 터미널·HTTP 요청만 사용하기')}
              </Button>
              <p className="muted small">{t('이 PC에 저장된 볼트 사본이 없습니다. 한 번 로그인해 두면 다음부터는 서버에 연결할 수 없을 때도 볼트를 열 수 있습니다.')}</p>
              <button className="link-btn" onClick={() => void desktop!.changeServer()}>
                {t('서버 주소 바꾸기')}
              </button>
            </>
          )}
        </div>
      </div>
    );
  if (boot.kind === 'incompatible')
    return (
      <div className="login">
        <div className="login-card lock-card">
          <div className="lock-icon">
            <ShieldAlert size={26} />
          </div>
          <h1>{t('서버와 앱의 버전이 맞지 않습니다')}</h1>
          <p className="login-sub">
            {boot.reason === 'server_old'
              ? t('이 서버가 앱보다 오래된 버전입니다. 서버 관리자에게 Terminas 서버를 업데이트해 달라고 요청해 주세요.')
              : t('이 앱이 서버보다 오래된 버전입니다. 앱을 업데이트해 주세요.')}
          </p>
          {boot.reason === 'app_old' && desktop && (
            <Button variant="primary" className="lock-wide" onClick={() => void desktop!.update.check()}>
              <RefreshCw size={14} /> {t('업데이트 확인')}
            </Button>
          )}
          <Button className="lock-wide" onClick={() => void start()}>
            <RefreshCw size={14} /> {t('다시 시도')}
          </Button>
          {desktop && (
            <button className="link-btn" onClick={() => void desktop!.changeServer()}>
              {t('서버 주소 바꾸기')}
            </button>
          )}
        </div>
      </div>
    );
  if (boot.kind === 'setup')
    return (
      <KeySetup
        me={boot.me}
        onLogout={() => void logout()}
        onDone={(account) => {
          // 방금 만든 계정: 서버가 "볼트 키가 이미 있다"고 하면 열지 않는다 (vault.ts openVaultKey)
          noteFreshAccount(boot.me.user.id);
          void api.get<Me>('/api/me').then((me) => enter(me, account), () => enter(boot.me, account));
        }}
      />
    );
  if (boot.kind === 'locked') return <Unlock me={boot.me} offline={boot.mode === 'offline'} onLogout={() => void logout()} onUnlocked={(account) => enter(boot.me, account, boot.mode)} />;
  return (
    <StoreProvider initialMe={boot.me} initialMode={boot.mode}>
      <ForwardProvider>
        <Shell />
      </ForwardProvider>
    </StoreProvider>
  );
}
