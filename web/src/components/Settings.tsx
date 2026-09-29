import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, KeyRound, LockKeyhole, LogOut, Mail, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import { api, errorMessage, type AuthConfig, type Me, type Perm, type TeamDetail, type TeamRole, type VaultMember } from '../api';
import { getStartVault, setStartVault, useStore } from '../store';
import { desktop } from '../desktop';
import { LANGS, getLang, locale, setLang, t, tk, type Lang } from '../i18n';

// 초대 코드 기한처럼 분 단위면 되는 때
const shortTime = (ts: number) => new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
import * as E from '../e2ee';
import { currentAccount, initMissingKeys } from '../vault';
import { RecoveryKeyView, rememberUnlock, SAME_AS_LOGIN } from './Lock';
import { isLoginPassword, rememberLoginPassword } from '../login-secret';
import { MfaCard } from './Mfa';
import { AUTOLOCK_CHOICES, autoLockMinutes, setAutoLockMinutes } from '../autolock';
import { Avatar, Badge, Button, Card, IconButton, Input, Modal, Select, Toggle, timeAgo } from './ui';
import { ThemeList } from './Terminal';
import { AppCard } from './AppUpdate';
import { OfflinePage } from './Offline';

const ROLE_LABEL: Record<TeamRole, string> = { owner: tk('소유자'), admin: tk('관리자'), member: tk('멤버') };

export function SettingsModal() {
  const s = useStore();
  const page = s.settingsOpen;
  if (!page) return null;
  const go = (p: string) => s.openSettings(p);
  // 팀 만들기: 서버 관리자, 또는 누구나 가입하는 서버의 모든 사람 (옛 서버는 canCreateTeams 가 없다)
  const canCreateTeams = (s.me.user.canCreateTeams ?? s.me.user.isAdmin) && s.mode === 'online';
  // 임시 모드(서버·사본 없이 연 앱)는 언어·터미널 설정만
  const local = s.mode === 'local';
  return (
    <Modal onClose={s.closeSettings} width={880}>
      <div className="settings">
        <nav className="settings-nav">
          <h2>{t('설정')}</h2>
          <button className={page === 'account' ? 'on' : ''} onClick={() => go('account')}>
            {t('계정')}
          </button>
          {!local && (
            <button className={page === 'security' ? 'on' : ''} onClick={() => go('security')}>
              {t('보안·암호화')}
            </button>
          )}
          {s.offlineCapable && (
            <button className={page === 'offline' ? 'on' : ''} onClick={() => go('offline')}>
              {t('오프라인·동기화')}
            </button>
          )}
          <button className={page === 'terminal' ? 'on' : ''} onClick={() => go('terminal')}>
            {t('터미널')}
          </button>
          {(s.me.teams.length > 0 || canCreateTeams) && <div className="settings-nav-head">{t('팀')}</div>}
          {s.me.teams.map((t) => (
            <button key={t.id} className={page === `team:${t.id}` ? 'on' : ''} onClick={() => go(`team:${t.id}`)}>
              <Users size={14} /> {t.name}
            </button>
          ))}
          {canCreateTeams && (
            <button className={page === 'new-team' ? 'on' : ''} onClick={() => go('new-team')}>
              <Plus size={14} /> {t('팀 만들기')}
            </button>
          )}
        </nav>
        <div className="settings-body">
          <IconButton label={t('닫기')} className="settings-close" onClick={s.closeSettings}>
            <X size={16} />
          </IconButton>
          {page === 'account' && (local ? <LocalAccountPage /> : <AccountPage />)}
          {page === 'security' && !local && <SecurityPage />}
          {page === 'offline' && s.offlineCapable && <OfflinePage />}
          {page === 'terminal' && <TerminalPage />}
          {page === 'new-team' && <NewTeamPage />}
          {page.startsWith('team:') && <TeamPage key={page} teamId={page.slice(5)} />}
        </div>
      </div>
    </Modal>
  );
}

// 로그인 비밀번호 (서버가 아이디·비밀번호 로그인을 받을 때만). 볼트를 여는 암호화 비밀번호와는 다른 것이다
const LOGIN_PW_MIN = 10;
function LoginPasswordCard() {
  const s = useStore();
  const login = s.me.login;
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  if (!login?.password) return null;

  const close = () => {
    setOpen(false);
    setCurrent('');
    setPw('');
    setAgain('');
  };
  const save = async () => {
    if ([...pw].length < LOGIN_PW_MIN) return s.toast(t('{min}자 이상으로 정해 주세요.', { min: LOGIN_PW_MIN }), 'error');
    if (pw !== again) return s.toast(t('두 번 입력한 비밀번호가 다릅니다.'), 'error');
    setBusy(true);
    try {
      // 암호화 비밀번호와 같으면 안 된다: 새 로그인 비밀번호로 내 키 묶음이 열리는지 이 기기 안에서 본다.
      // 들고 있던 것은 그사이 다른 기기에서 암호화 비밀번호를 바꿨으면 옛 묶음이라, 지금 서버의 묶음으로 본다
      const c = (await api.get<Me>('/api/me').catch(() => s.me)).crypto;
      if (c && (await E.unlockWithPassword(s.me.user.id, c.publicKey, c.bundle, pw).then(() => true, () => false))) {
        throw new Error(t('암호화 비밀번호와 다르게 정해 주세요. 같으면 서버가 암호화를 풀 수 있게 됩니다.'));
      }
      await api.put('/api/me/password', login.hasPassword ? { current, password: pw } : { password: pw });
      await rememberLoginPassword(pw);
      await s.refreshMe();
      close();
      s.toast(login.hasPassword ? t('로그인 비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊었습니다.') : t('로그인 비밀번호를 정했습니다. 이제 아이디와 비밀번호로도 로그인할 수 있습니다.'), 'success');
    } catch (err) {
      const code = (err as { code?: string }).code;
      s.toast(code === 'reauth_required' ? t('안전을 위해 로그아웃했다가 다시 로그인한 뒤 10분 안에 정해 주세요.') : errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('로그인 비밀번호')}>
      <div className="setting-row">
        <span>{login.hasPassword ? t('아이디 {id}와(과) 비밀번호로 로그인합니다.', { id: s.me.user.email }) : t('아직 로그인 비밀번호가 없습니다. 정하면 아이디 {id}와(과) 비밀번호로도 로그인할 수 있습니다.', { id: s.me.user.email })}</span>
        {!open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <KeyRound size={14} /> {login.hasPassword ? t('바꾸기') : t('정하기')}
          </Button>
        )}
      </div>
      {open && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {login.hasPassword && <Input type="password" placeholder={t('지금 로그인 비밀번호')} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />}
          <Input type="password" placeholder={t('새 로그인 비밀번호({min}자 이상)', { min: LOGIN_PW_MIN })} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus={!login.hasPassword} />
          <Input type="password" placeholder={t('한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          <div className="row-actions">
            <Button variant="ghost" type="button" onClick={close}>
              {t('취소')}
            </Button>
            <Button variant="primary" type="submit" loading={busy} disabled={!pw || !again || (login.hasPassword && !current)}>
              {t('저장')}
            </Button>
          </div>
        </form>
      )}
      <p className="muted small">{t('볼트를 여는 암호화 비밀번호와는 다른 비밀번호입니다. 서버는 로그인 비밀번호만 알고, 암호화 비밀번호는 모릅니다.')}</p>
    </Card>
  );
}

// Terminas 는 AGPL-3.0 오픈소스 — 이 서버가 돌리는 판의 소스를 받을 곳 (AGPL 제13조, 서버 설정 SHELL_SOURCE_URL)
function SourceNote() {
  const [links, setLinks] = useState<AuthConfig['links'] | null>(null);
  useEffect(() => void api.get<AuthConfig>('/api/auth/config').then((c) => setLinks(c.links ?? null), () => {}), []);
  if (!links || !(links.source || links.terms || links.privacy)) return null;
  return (
    <p className="muted small source-note">
      {t('Terminas는 AGPL-3.0 오픈소스입니다.')}{' '}
      {links.source && (
        <a href={links.source} target="_blank" rel="noreferrer">
          {t('소스 코드')}
        </a>
      )}
      {links.terms && (
        <>
          {' · '}
          <a href={links.terms} target="_blank" rel="noreferrer">
            {t('이용약관')}
          </a>
        </>
      )}
      {links.privacy && (
        <>
          {' · '}
          <a href={links.privacy} target="_blank" rel="noreferrer">
            {t('개인정보처리방침')}
          </a>
        </>
      )}
    </p>
  );
}

function AccountPage() {
  const s = useStore();
  const u = s.me.user;
  return (
    <>
      <Card>
        <div className="account-row">
          <Avatar name={u.name || u.email} url={u.avatarUrl} size={48} />
          <div>
            <div className="strong">{u.name || u.email}</div>
            <div className="muted">{u.email}</div>
          </div>
          {u.isAdmin && <Badge tone="accent">{t('관리자')}</Badge>}
        </div>
      </Card>
      <Card>
        <div className="setting-row">
          <span>{t('언어')}</span>
          <Select value={getLang()} onChange={(e) => void setLang(e.target.value as Lang)} aria-label={t('언어')}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <p className="muted small">{t('화면에 표시할 언어입니다. 이 기기에만 적용됩니다.')}</p>
      </Card>
      <StartVaultCard />
      <Card title={t('소속 팀')}>
        {s.me.teams.length === 0 ? (
          <p className="muted small">{t('소속된 팀이 없습니다.')}</p>
        ) : (
          <ul className="plain-list">
            {s.me.teams.map((team) => (
              <li key={team.id}>
                <Users size={14} /> {team.name} <Badge>{t(ROLE_LABEL[team.role])}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <LoginPasswordCard />
      <AppCard />
      <Card>
        <Button onClick={() => void s.logout()}>
          <LogOut size={14} /> {t('로그아웃')}
        </Button>
      </Card>
      <SourceNote />
    </>
  );
}

// 임시 모드: 로그인하지 않았으니 언어만
function LocalAccountPage() {
  return (
    <Card>
      <div className="setting-row">
        <span>{t('언어')}</span>
        <Select value={getLang()} onChange={(e) => void setLang(e.target.value as Lang)} aria-label={t('언어')}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="muted small">{t('화면에 표시할 언어입니다. 이 기기에만 적용됩니다.')}</p>
    </Card>
  );
}

// 켤 때 먼저 보일 볼트 (Personal 또는 팀 볼트)
function StartVaultCard() {
  const s = useStore();
  const [start, setStart] = useState(getStartVault);
  const known = s.me.vaults.some((v) => v.id === start);
  return (
    <Card>
      <div className="setting-row">
        <span>{t('시작할 때 열 볼트')}</span>
        <Select
          value={known ? start : ''}
          onChange={(e) => {
            setStartVault(e.target.value);
            setStart(e.target.value);
          }}
          aria-label={t('시작할 때 열 볼트')}
        >
          <option value="">{t('마지막으로 연 볼트')}</option>
          {s.me.vaults.map((v) => (
            <option key={v.id} value={v.id}>
              {v.teamName ? `${v.teamName} · ${v.name}` : v.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="muted small">{t('앱이나 웹을 열면 이 볼트가 먼저 보입니다. 이 기기에만 적용됩니다.')}</p>
    </Card>
  );
}

// 내 공개키 지문 · 암호화 비밀번호 바꾸기 · 복구 키 새로 받기 · 이 PC 에 잠금 해제 기억
function SecurityPage() {
  const s = useStore();
  const [fp, setFp] = useState('');
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const [lockAfter, setLockAfter] = useState(autoLockMinutes);

  useEffect(() => {
    if (s.me.crypto) void E.keyFingerprint(s.me.crypto.publicKey).then(setFp);
    if (desktop) void desktop.unlock.recall(s.me.user.id).then((k) => setRemembered(Boolean(k)), () => setRemembered(false));
  }, [s.me.crypto, s.me.user.id]);

  // 묶음은 언제나 서버의 최신 것을 받아서 고친다
  const freshBundle = async () => {
    const me = await api.get<Me>('/api/me');
    if (!me.crypto) throw new Error(t('암호화 설정을 찾을 수 없습니다'));
    return me.crypto;
  };

  const changePassword = async () => {
    const account = currentAccount();
    if (!account) return;
    if (pw.length < 10) return s.toast(t('새 비밀번호는 10자 이상으로 정해 주세요.'), 'error');
    if (pw !== again) return s.toast(t('두 번 입력한 새 비밀번호가 다릅니다.'), 'error');
    if (await isLoginPassword(pw)) return s.toast(t(SAME_AS_LOGIN), 'error');
    setBusy(true);
    try {
      const c = await freshBundle();
      await E.unlockWithPassword(account.userId, c.publicKey, c.bundle, current);
      const bundle = await E.rewrapPassword(account, c.bundle, pw);
      await api.put('/api/me/keys', { bundle, proof: await E.accountProof(account.accountKey, account.userId), reason: 'password' });
      await s.refreshMe();
      setCurrent('');
      setPw('');
      setAgain('');
      s.toast(t('암호화 비밀번호를 바꿨습니다. 다른 기기에서도 새 비밀번호로 엽니다.'), 'success');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    const account = currentAccount();
    if (!account) return;
    const ok = await s.confirm({ title: t('복구 키 새로 받기'), message: t('새 복구 키를 만들면 예전 복구 키는 더 이상 사용할 수 없습니다. 계속할까요?'), confirmLabel: t('새로 받기') });
    if (!ok) return;
    try {
      const c = await freshBundle();
      const r = await E.newRecoveryKey(account, c.bundle);
      await api.put('/api/me/keys', { bundle: r.bundle, proof: await E.accountProof(account.accountKey, account.userId), reason: 'new_recovery' });
      await s.refreshMe();
      setNewKey(r.recoveryKey);
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <Card title={t('종단간 암호화')}>
        <p className="muted small">
          {t('호스트 주소·비밀번호·SSH 키·스니펫은 이 기기에서 볼트 키로 암호화된 뒤에만 서버에 저장됩니다. 서버와 서버 관리자는 풀 수 없습니다. 볼트 키는 볼 권한이 있는 팀원의 공개키로만 봉해 둡니다.')}
        </p>
        <div className="setting-row">
          <span>
            <ShieldCheck size={14} /> {t('내 키 지문')}
          </span>
          <code className="fingerprint">{fp || '…'}</code>
        </div>
        <p className="muted small">{t('팀 관리자가 볼트 키를 공유할 때 이 지문이 보입니다. 서로 같은지 말로 확인하면 가장 안전합니다.')}</p>
      </Card>

      <MfaCard />

      <Card title={t('자동 잠금')}>
        <div className="setting-row">
          <span>{t('입력이 없으면 잠그기')}</span>
          <Select
            value={String(lockAfter)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setAutoLockMinutes(v);
              setLockAfter(v);
            }}
            aria-label={t('자동 잠금')}
          >
            {AUTOLOCK_CHOICES.map((m) => (
              <option key={m} value={String(m)}>
                {m === 0 ? t('잠그지 않음') : m < 60 ? t('{count}분 뒤', { count: m }) : t('{count}시간 뒤', { count: m / 60 })}
              </option>
            ))}
          </Select>
        </div>
        <p className="muted small">
          {desktop
            ? t('이 PC에만 적용됩니다. 잠기면 암호화 비밀번호를 다시 입력해야 하고, 열려 있던 터미널·SFTP 접속도 끊깁니다.')
            : t('이 브라우저에만 적용됩니다. 잠기면 암호화 비밀번호를 다시 입력해야 하고, 열려 있던 터미널·SFTP 접속도 끊깁니다.')}
        </p>
      </Card>

      {desktop && (
        <Card title={t('이 PC')}>
          <div className="setting-row">
            <span>{t('잠금 해제 기억')}</span>
            <Toggle
              label={t('잠금 해제 기억')}
              checked={Boolean(remembered)}
              onChange={(v) => {
                const account = currentAccount();
                if (!account) return;
                void rememberUnlock(account, v).then(() => setRemembered(v));
              }}
            />
          </div>
          <p className="muted small">{t('켜 두면 Windows 보호 저장소(DPAPI)에 넣어 두고 앱을 켤 때 묻지 않습니다. 이 PC의 Windows 계정에 들어올 수 있는 사람은 볼트를 열 수 있습니다.')}</p>
          <Button onClick={() => void s.lock()}>
            <LockKeyhole size={14} /> {t('지금 잠그기')}
          </Button>
        </Card>
      )}

      <Card title={t('암호화 비밀번호 바꾸기')}>
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
        >
          <Input type="password" placeholder={t('지금 비밀번호')} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <Input type="password" placeholder={t('새 비밀번호(10자 이상)')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <Input type="password" placeholder={t('새 비밀번호 한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          <Button variant="primary" type="submit" loading={busy} disabled={!current || !pw || !again}>
            {t('바꾸기')}
          </Button>
        </form>
      </Card>

      <Card title={t('복구 키')}>
        {newKey ? (
          <>
            <p className="muted small">{t('새 복구 키입니다. 지금 한 번만 보여 드립니다. 예전 복구 키는 이제 사용할 수 없습니다.')}</p>
            <RecoveryKeyView recoveryKey={newKey} email={s.me.user.email} />
          </>
        ) : (
          <>
            <p className="muted small">{t('암호화 비밀번호를 잊었을 때 사용하는 키입니다. 잃어버렸거나 남에게 보였다면 새로 받아 주세요.')}</p>
            <Button onClick={() => void regenerate()}>
              <KeyRound size={14} /> {t('복구 키 새로 받기')}
            </Button>
          </>
        )}
      </Card>
    </>
  );
}

function TerminalPage() {
  const s = useStore();
  return (
    <>
      <Card title={t('터미널 설정')}>
        <div className="setting-row">
          <span>{t('글꼴 크기')}</span>
          <div className="font-size">
            <Button size="sm" onClick={() => s.setPrefs({ fontSize: Math.max(9, s.prefs.fontSize - 1) })}>
              −
            </Button>
            <span>{s.prefs.fontSize}</span>
            <Button size="sm" onClick={() => s.setPrefs({ fontSize: Math.min(28, s.prefs.fontSize + 1) })}>
              +
            </Button>
          </div>
        </div>
        <div className="setting-row">
          <span>{t('커서 깜빡임')}</span>
          <Toggle label={t('커서 깜빡임')} checked={s.prefs.cursorBlink} onChange={(v) => s.setPrefs({ cursorBlink: v })} />
        </div>
        <div className="setting-row">
          <span>{t('복사·붙여넣기')}</span>
          <span className="muted small">{t('Ctrl+Shift+C / Ctrl+Shift+V(Ctrl+V도 됩니다)')}</span>
        </div>
      </Card>
      <Card title={t('테마')}>
        <ThemeList />
      </Card>
    </>
  );
}

function NewTeamPage() {
  const s = useStore();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api.post<{ id: string; vaultId: string }>('/api/teams', { name });
      // 새 팀 볼트의 키는 만든 사람이 곧바로 만든다 (서버는 키를 만들지 못한다)
      const me = await api.get<Me>('/api/me');
      await initMissingKeys(me.vaults);
      await s.refreshMe();
      s.toast(t('팀을 만들었습니다'), 'success');
      s.openSettings(`team:${id}`);
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('팀 만들기')}>
      <p className="muted small">{t('팀을 만들면 기본 "Team" 볼트가 함께 생기고, 초대한 사람은 첫 Google 로그인 때 자동으로 들어옵니다.')}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input placeholder={t('팀 이름(예: 개발팀)')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Button variant="primary" type="submit" loading={busy} disabled={!name.trim()}>
          {t('만들기')}
        </Button>
      </form>
    </Card>
  );
}

function TeamPage({ teamId }: { teamId: string }) {
  const s = useStore();
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  // 비밀번호 로그인 서버: 방금 만든 초대 코드 (한 번만 보여 준다)
  const [inviteCode, setInviteCode] = useState<{ email: string; code: string; codeExpiresAt: number } | null>(null);
  const passwordServer = Boolean(s.me.login?.password);
  const [vaultName, setVaultName] = useState('');
  const [openVault, setOpenVault] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeam(await api.get<TeamDetail>(`/api/teams/${teamId}`));
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  }, [teamId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, [load]);

  if (!team) return <p className="muted">{s.mode === 'online' ? t('불러오는 중…') : t('오프라인에서는 팀 설정을 볼 수 없습니다.')}</p>;
  const manager = team.myRole === 'owner' || team.myRole === 'admin';
  const owner = team.myRole === 'owner';

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([load(), s.refreshMe()]);
      if (done) s.toast(done, 'success');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const invite = () =>
    run(async () => {
      const r = await api.post<{ added?: boolean; code?: string; codeExpiresAt?: number }>(`/api/teams/${teamId}/invites`, { email, role });
      if (r.code && r.codeExpiresAt) setInviteCode({ email, code: r.code, codeExpiresAt: r.codeExpiresAt });
      else s.toast(r.added ? t('이미 가입한 사람이라 바로 팀에 추가했습니다') : t('초대했습니다. 해당 이메일로 Google 로그인하면 들어옵니다'), 'success');
      setEmail('');
    });

  const removeMember = async (m: TeamDetail['members'][number]) => {
    const self = m.userId === s.me.user.id;
    const ok = await s.confirm({
      title: self ? t('팀 나가기') : t('팀원 내보내기'),
      message: self
        ? t('{team} 팀에서 나갑니다. 팀 볼트를 더 이상 볼 수 없습니다.', { team: team.team.name })
        : t('{name}님을 팀에서 내보냅니다. 열려 있는 터미널도 바로 끊깁니다.', { name: m.name || m.email }),
      confirmLabel: self ? t('나가기') : t('내보내기'),
      danger: true,
    });
    if (ok) await run(() => api.del(`/api/teams/${teamId}/members/${m.userId}`), self ? undefined : t('내보냈습니다'));
    if (ok && self) s.closeSettings();
  };

  // 팀 삭제: 팀 이름을 그대로 적어야 한다 (서버도 다시 확인한다)
  const removeTeam = async () => {
    const typed = await s.askText({
      title: t('팀 삭제'),
      label: t('확인을 위해 팀 이름 "{name}"을(를) 적어 주세요', { name: team.team.name }),
      value: '',
      confirmLabel: t('삭제'),
      hint: t('팀 볼트와 그 안의 모든 항목이 지워집니다. 되돌릴 수 없습니다.'),
    });
    if (typed === null) return;
    if (typed.trim() !== team.team.name) return s.toast(t('팀 이름이 맞지 않아 지우지 않았습니다.'), 'error');
    setBusy(true);
    try {
      await api.del(`/api/teams/${teamId}`, { confirm: team.team.name });
      await s.refreshMe();
      s.toast(t('{team} 팀을 지웠습니다.', { team: team.team.name }), 'success');
      s.openSettings('account');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {inviteCode && (
        <Modal
          title={t('초대 코드')}
          onClose={() => setInviteCode(null)}
          width={460}
          footer={
            <Button variant="primary" onClick={() => setInviteCode(null)}>
              {t('확인')}
            </Button>
          }
        >
          <p className="muted small">{t('{email}님에게 이 코드를 전달해 주세요. 로그인 화면의 "초대 코드를 받았나요? 가입하기"에서 이 코드로 로그인 비밀번호를 정하고 가입할 수 있습니다.', { email: inviteCode.email })}</p>
          <div className="invite-code">
            <span className="mono">{inviteCode.code}</span>
            <IconButton label={t('복사')} onClick={() => void navigator.clipboard.writeText(inviteCode.code).then(() => s.toast(t('복사했습니다'), 'success'))}>
              <Copy size={15} />
            </IconButton>
          </div>
          <p className="muted small">{t('코드는 지금 한 번만 보입니다. {date}까지 사용할 수 있고, 잃어버리면 새로 만들 수 있습니다.', { date: shortTime(inviteCode.codeExpiresAt) })}</p>
        </Modal>
      )}
      <div className="team-head">
        <h2>{team.team.name}</h2>
        <Badge tone="accent">{t('내 역할: {role}', { role: t(ROLE_LABEL[team.myRole]) })}</Badge>
      </div>

      {manager && (
        <Card title={t('초대')}>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <Input icon={<Mail size={14} />} type="email" placeholder={passwordServer ? t('이메일') : t('Google 계정 이메일')} value={email} onChange={(e) => setEmail(e.target.value)} />
            <Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)} aria-label={t('역할')}>
              <option value="member">{t('멤버')}</option>
              {owner && <option value="admin">{t('관리자')}</option>}
            </Select>
            <Button variant="primary" type="submit" disabled={!email.trim() || busy}>
              <UserPlus size={14} /> {t('초대')}
            </Button>
          </form>
          <p className="muted small">{t('멤버는 기본 "Team" 볼트를 보기 전용으로 받습니다. 볼트별 권한은 아래에서 바꿀 수 있습니다. 관리자는 모든 팀 볼트를 편집합니다.')}</p>
          {team.invites.length > 0 && (
            <ul className="member-list">
              {team.invites.map((i) => (
                <li key={i.id}>
                  <Avatar name={i.email} size={30} />
                  <div className="member-text">
                    <div>{i.email}</div>
                    <div className="muted small">
                      {t('초대 대기 · {time}', { time: timeAgo(i.createdAt) })}
                      {passwordServer && (i.codeExpiresAt && i.codeExpiresAt > Date.now() ? ` · ${t('코드 {date}까지', { date: shortTime(i.codeExpiresAt) })}` : ` · ${t('코드 없음·만료')}`)}
                    </div>
                  </div>
                  <Badge>{t(ROLE_LABEL[i.role])}</Badge>
                  {passwordServer && (owner || i.role !== 'admin') && (
                    <IconButton
                      label={t('초대 코드 새로 만들기')}
                      onClick={() =>
                        void run(async () => {
                          const r = await api.post<{ code: string; codeExpiresAt: number }>(`/api/teams/${teamId}/invites/${i.id}/code`);
                          setInviteCode({ email: i.email, code: r.code, codeExpiresAt: r.codeExpiresAt });
                        })
                      }
                    >
                      <RefreshCw size={14} />
                    </IconButton>
                  )}
                  <IconButton label={t('초대 취소')} onClick={() => void run(() => api.del(`/api/teams/${teamId}/invites/${i.id}`), t('초대를 취소했습니다'))}>
                    <X size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title={t('팀원 {count}명', { count: team.members.length })}>
        <ul className="member-list">
          {team.members.map((m) => (
            <li key={m.userId}>
              <Avatar name={m.name || m.email} url={m.avatarUrl} size={30} />
              <div className="member-text">
                <div>
                  {m.name || m.email} {m.userId === s.me.user.id && <span className="muted">{t('(나)')}</span>}
                </div>
                <div className="muted small">
                  {m.email}
                  {m.lastLoginAt ? ` · ${t('최근 로그인 {time}', { time: timeAgo(m.lastLoginAt) })}` : ''}
                  {!m.publicKey && ` · ${t('아직 암호화 설정 전')}`}
                </div>
              </div>
              {owner ? (
                <Select value={m.role} onChange={(e) => void run(() => api.patch(`/api/teams/${teamId}/members/${m.userId}`, { role: e.target.value }), t('역할을 바꿨습니다'))} aria-label={t('역할')}>
                  <option value="owner">{t('소유자')}</option>
                  <option value="admin">{t('관리자')}</option>
                  <option value="member">{t('멤버')}</option>
                </Select>
              ) : (
                <Badge>{t(ROLE_LABEL[m.role])}</Badge>
              )}
              {(m.userId === s.me.user.id || (manager && (m.role !== 'owner' || owner))) && (
                <IconButton label={m.userId === s.me.user.id ? t('팀 나가기') : t('내보내기')} onClick={() => void removeMember(m)}>
                  {m.userId === s.me.user.id ? <LogOut size={14} /> : <Trash2 size={14} />}
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('팀 볼트')}>
        <ul className="vault-list">
          {team.vaults.map((v) => (
            <li key={v.id}>
              <button className="vault-row" onClick={() => setOpenVault(openVault === v.id ? null : v.id)} disabled={!manager}>
                {manager ? openVault === v.id ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="spacer-14" />}
                <span className="strong">{v.name}</span>
                {v.isDefault && <Badge>{t('기본')}</Badge>}
              </button>
              {manager && openVault === v.id && <VaultAccess vaultId={v.id} isDefault={v.isDefault} onChanged={() => void run(async () => {})} onDeleted={() => void run(async () => {}, t('볼트를 지웠습니다'))} />}
            </li>
          ))}
        </ul>
        {manager && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post(`/api/teams/${teamId}/vaults`, { name: vaultName });
                setVaultName('');
                await initMissingKeys((await api.get<Me>('/api/me')).vaults);
              }, t('볼트를 만들었습니다'));
            }}
          >
            <Input placeholder={t('새 볼트 이름(예: 운영 서버)')} value={vaultName} onChange={(e) => setVaultName(e.target.value)} />
            <Button type="submit" disabled={!vaultName.trim() || busy}>
              <Plus size={14} /> {t('볼트 만들기')}
            </Button>
          </form>
        )}
      </Card>
      {owner && (
        <Card title={t('팀 삭제')}>
          <p className="muted small">{t('팀과 팀 볼트, 그 안의 호스트·키·스니펫을 모두 지웁니다. 되돌릴 수 없습니다.')}</p>
          {Boolean(team.soleMembers) && <p className="warn-text small">{t('이 팀에만 속한 팀원 {count}명은 더 이상 로그인할 수 없습니다.', { count: team.soleMembers ?? 0 })}</p>}
          <Button variant="danger" disabled={busy} onClick={() => void removeTeam()}>
            <Trash2 size={14} /> {t('팀 삭제')}
          </Button>
        </Card>
      )}
    </>
  );
}

function VaultAccess({ vaultId, isDefault, onChanged, onDeleted }: { vaultId: string; isDefault: boolean; onChanged: () => void; onDeleted: () => void }) {
  const s = useStore();
  const [members, setMembers] = useState<VaultMember[] | null>(null);
  const load = useCallback(() => {
    api.get<VaultMember[]>(`/api/vaults/${vaultId}/members`).then(setMembers, (err) => s.toast(errorMessage(err), 'error'));
  }, [vaultId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const set = async (userId: string, permission: Perm | null) => {
    try {
      await api.put(`/api/vaults/${vaultId}/members/${userId}`, { permission });
      load();
      onChanged();
      // 새로 볼 수 있게 된 사람에게 볼트 키를 건넬지 바로 확인받는다
      void s.refreshPending();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const remove = async () => {
    const ok = await s.confirm({ title: t('볼트 삭제'), message: t('이 볼트와 그 안의 호스트·키·스니펫을 모두 지웁니다. 되돌릴 수 없습니다.'), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/vaults/${vaultId}`);
      onDeleted();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="vault-access">
      {(members ?? []).map((m) => (
        <div key={m.userId} className="vault-access-row">
          <Avatar name={m.name || m.email} url={m.avatarUrl} size={24} />
          <span className="member-text">
            {m.name || m.email} <span className="muted small">{m.email}</span>
            {(m.implicit || m.permission) && !m.hasVaultKey && (
              <Badge tone="warn">{m.hasKeys ? t('키 공유 대기') : t('암호화 설정 전')}</Badge>
            )}
          </span>
          {m.implicit ? (
            <Badge tone="accent">{t('편집({role})', { role: t(ROLE_LABEL[m.role]) })}</Badge>
          ) : (
            <Select value={m.permission ?? ''} onChange={(e) => void set(m.userId, (e.target.value || null) as Perm | null)} aria-label={t('볼트 권한')}>
              <option value="">{t('접근 없음')}</option>
              <option value="view">{t('보기·접속')}</option>
              <option value="edit">{t('편집')}</option>
            </Select>
          )}
        </div>
      ))}
      {!isDefault && (
        <div className="vault-access-foot">
          <Button size="sm" variant="danger" onClick={() => void remove()}>
            <Trash2 size={14} /> {t('볼트 삭제')}
          </Button>
        </div>
      )}
    </div>
  );
}
