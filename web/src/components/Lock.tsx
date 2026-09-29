// 암호화 비밀번호: 처음 설정 · 잠금 해제 · 복구 키로 되살리기 · (둘 다 잃었을 때) 처음부터 다시.
// 비밀번호와 복구 키는 이 기기 밖으로 나가지 않는다. 서버에는 그것으로 잠근 묶음만 올라간다.
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { CloudOff, Copy, Download, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, ApiError, errorMessage, type Me } from '../api';
import { desktop } from '../desktop';
import { takeAutoLocked } from '../autolock';
import * as E from '../e2ee';
import { locale, t, tk, tr } from '../i18n';
import { Button, Input } from './ui';
import { isLoginPassword } from '../login-secret';
import { forgetPin, noteFreshAccount } from '../vault';

const MIN = 10;

// 로그인 비밀번호(서버가 받는 값)와 같으면 서버가 볼트를 열 수 있게 된다 — 비밀번호 로그인으로 들어온 화면에서 막는다
export const SAME_AS_LOGIN = tk('로그인 비밀번호와 다르게 정해 주세요. 같으면 서버가 암호화를 풀 수 있게 됩니다.');

function passwordProblem(pw: string, again: string) {
  if (pw.length < MIN) return t('{min}자 이상으로 정해 주세요.', { min: MIN });
  if (pw !== again) return t('두 번 입력한 비밀번호가 다릅니다.');
  return '';
}

// 앱: 잠금 해제를 이 PC 에 기억(OS 보호 저장소). 웹은 기억하지 않는다.
export async function rememberUnlock(account: E.Account, remember: boolean) {
  if (!desktop) return;
  if (remember) await desktop.unlock.remember(account.userId, E.toB64(account.accountKey)).catch(() => {});
  else await desktop.unlock.forget(account.userId).catch(() => {});
}

export function saveText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function RecoveryKeyView({ recoveryKey, email }: { recoveryKey: string; email: string }) {
  const [copied, setCopied] = useState(false);
  // 처음에는 가려 둔다 (옆 사람·화면 공유에 그대로 보이지 않게). 복사·저장은 가린 채로도 된다.
  const [shown, setShown] = useState(false);
  return (
    <div className="recovery">
      <code className={`recovery-key ${shown ? '' : 'masked'}`} aria-label={shown ? t('복구 키') : t('가려진 복구 키')}>
        {/* 4자 묶음 사이에서만 줄을 바꾼다 (복사하면 원래 글자만 나온다) */}
        {recoveryKey.split('-').map((g, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                -<wbr />
              </>
            )}
            {shown ? g : '••••'}
          </Fragment>
        ))}
      </code>
      <div className="recovery-actions">
        <Button size="sm" onClick={() => setShown(!shown)}>
          {shown ? <EyeOff size={14} /> : <Eye size={14} />} {shown ? t('가리기') : t('보이기')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(recoveryKey).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          <Copy size={14} /> {copied ? t('복사했습니다') : t('복사')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            saveText(
              'terminas-recovery-key.txt',
              t('Terminas 복구 키\r\n\r\n계정: {email}\r\n만든 날: {date}\r\n\r\n{key}\r\n\r\n암호화 비밀번호를 잊었을 때 이 키로 잠금을 풀 수 있습니다.\r\n이 키를 가진 사람은 내 볼트를 볼 수 있으니 반드시 안전한 곳(비밀번호 관리자·금고)에 보관해 주세요.\r\n', {
                email,
                date: new Date().toLocaleString(locale()),
                key: recoveryKey,
              }),
            )
          }
        >
          <Download size={14} /> {t('파일로 저장')}
        </Button>
      </div>
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="login">
      <div className="login-card lock-card">
        <div className="lock-icon">{icon}</div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

// ---------- 처음 설정 ----------
export function KeySetup({ me, onDone, onLogout }: { me: Me; onDone: (account: E.Account) => void; onLogout: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ account: E.Account; recoveryKey: string } | null>(null);
  const [kept, setKept] = useState(false);
  // 잠금 해제 기억은 직접 고를 때만 (기본은 끔 — 이 PC 의 Windows 계정에 들어올 수 있는 사람은 볼트를 열 수 있게 된다)
  const [remember, setRemember] = useState(false);

  const create = async () => {
    const problem = passwordProblem(pw, again);
    if (problem) return setError(problem);
    if (await isLoginPassword(pw)) return setError(t(SAME_AS_LOGIN));
    setBusy(true);
    setError('');
    try {
      const r = await E.createAccount(me.user.id, pw);
      await api.post('/api/me/keys', { publicKey: r.publicKey, bundle: r.bundle, proof: r.proof });
      setMade({ account: r.account, recoveryKey: r.recoveryKey });
      setPw('');
      setAgain('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <Card icon={<KeyRound size={26} />} title={t('복구 키를 보관해 주세요')}>
        <p className="login-sub">{tr('암호화 비밀번호를 잊으면 이 복구 키로만 되살릴 수 있습니다. <b>지금 한 번만</b> 보여 드립니다.')}</p>
        <RecoveryKeyView recoveryKey={made.recoveryKey} email={me.user.email} />
        <label className="check lock-check">
          <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
          {t('복구 키를 안전한 곳에 보관했습니다')}
        </label>
        {desktop && (
          <label className="check lock-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('이 PC에서 잠금 해제 기억하기')}
          </label>
        )}
        <Button
          variant="primary"
          className="lock-wide"
          disabled={!kept}
          onClick={() => void rememberUnlock(made.account, remember).then(() => onDone(made.account))}
        >
          {t('시작하기')}
        </Button>
      </Card>
    );
  }

  return (
    <Card icon={<ShieldCheck size={26} />} title={t('암호화 비밀번호 만들기')}>
      <p className="login-sub">
        {tr('호스트 비밀번호와 SSH 키는 이 비밀번호로 <b>이 기기에서</b> 암호화한 뒤에만 서버에 저장됩니다. 서버 관리자도, DB를 가져간 사람도 풀 수 없습니다.')}
      </p>
      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input type="password" placeholder={t('암호화 비밀번호({min}자 이상)', { min: MIN })} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="new-password" />
        <Input type="password" placeholder={t('한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        <Button variant="primary" type="submit" loading={busy} disabled={!pw || !again}>
          {busy ? t('키를 만드는 중…') : t('만들기')}
        </Button>
      </form>
      {error && <p className="login-error">{error}</p>}
      <p className="login-foot">{t('로그인과는 별개입니다. 이 비밀번호는 서버로 보내지 않으며, 로그인 비밀번호와 달라야 합니다.')}</p>
      <button className="link-btn" onClick={onLogout}>
        {t('다른 계정으로 로그인')}
      </button>
    </Card>
  );
}

// ---------- 잠금 해제 ----------
// offline: 서버에 닿지 않아 이 PC 에 둔 사본으로 연다 (앱)
export function Unlock({ me, offline, onUnlocked, onLogout }: { me: Me; offline?: boolean; onUnlocked: (account: E.Account) => void; onLogout: () => void }) {
  const crypto = me.crypto!;
  const [mode, setMode] = useState<'password' | 'recovery' | 'reset'>('password');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [recovery, setRecovery] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<{ account: E.Account; recoveryKey: string } | null>(null);
  const [autoLocked] = useState(takeAutoLocked);
  // 초기화는 방금 로그인한 세션에서만 된다 — 새 비밀번호를 받기 전에 먼저 묻는다
  const [resetWindow, setResetWindow] = useState<{ allowed: boolean; windowMinutes: number } | null>(null);

  useEffect(() => setError(''), [mode]);
  useEffect(() => {
    if (mode !== 'reset') return;
    let alive = true;
    api.get<{ allowed: boolean; windowMinutes: number }>('/api/me/keys/reset').then(
      (r) => alive && setResetWindow(r),
      () => alive && setResetWindow({ allowed: true, windowMinutes: 10 }),
    );
    return () => {
      alive = false;
    };
  }, [mode]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unlock = () =>
    run(async () => {
      const account = await E.unlockWithPassword(me.user.id, crypto.publicKey, crypto.bundle, pw);
      // 로그인 비밀번호와 같으면 서버가 볼트를 열 수 있다 — 들어간 뒤 알린다 (App SamePasswordBanner)
      if (await isLoginPassword(pw)) {
        try {
          sessionStorage.setItem('terminas.samePassword', me.user.id);
        } catch {}
      }
      await rememberUnlock(account, remember);
      onUnlocked(account);
    });

  // 복구 키로 풀고, 새 암호화 비밀번호로 다시 잠근다 (계정 키·볼트는 그대로)
  const recover = () =>
    run(async () => {
      const problem = passwordProblem(pw, again);
      if (problem) throw new Error(problem);
      if (await isLoginPassword(pw)) throw new Error(t(SAME_AS_LOGIN));
      const account = await E.unlockWithRecovery(me.user.id, crypto.publicKey, crypto.bundle, recovery);
      const bundle = await E.rewrapPassword(account, crypto.bundle, pw);
      await api.put('/api/me/keys', { bundle, proof: await E.accountProof(account.accountKey, account.userId), reason: 'recovery' });
      await rememberUnlock(account, remember);
      onUnlocked(account);
    });

  // 둘 다 잃었을 때: 새 키로 다시 시작 (개인 볼트 내용은 지워진다)
  const reset = () =>
    run(async () => {
      if (confirmText.trim().toLocaleLowerCase() !== t('초기화').toLocaleLowerCase()) throw new Error(t('확인란에 "{word}"라고 적어 주세요.', { word: t('초기화') }));
      const problem = passwordProblem(pw, again);
      if (problem) throw new Error(problem);
      if (await isLoginPassword(pw)) throw new Error(t(SAME_AS_LOGIN));
      const r = await E.createAccount(me.user.id, pw);
      try {
        await api.post('/api/me/keys/reset', { confirm: 'RESET', publicKey: r.publicKey, bundle: r.bundle, proof: r.proof });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'reauth_required') return setResetWindow({ allowed: false, windowMinutes: resetWindow?.windowMinutes ?? 10 });
        throw err;
      }
      // 개인 볼트는 새 키가 된다 — 이 기기가 기억하던 옛 키·판 번호를 잊고, 다시 열 때 "방금 만든 계정"으로 다룬다
      const personal = me.vaults.find((v) => v.kind === 'personal');
      if (personal) forgetPin(personal.id, me.user.id);
      noteFreshAccount(me.user.id);
      setFresh({ account: r.account, recoveryKey: r.recoveryKey });
    });

  if (fresh) {
    return (
      <Card icon={<KeyRound size={26} />} title={t('새 복구 키')}>
        <p className="login-sub">{t('새로 만든 키의 복구 키입니다. 지금 한 번만 보여 드립니다.')}</p>
        <RecoveryKeyView recoveryKey={fresh.recoveryKey} email={me.user.email} />
        <Button variant="primary" className="lock-wide" onClick={() => void rememberUnlock(fresh.account, remember).then(() => location.reload())}>
          {t('시작하기')}
        </Button>
      </Card>
    );
  }

  if (mode === 'reset' && resetWindow && !resetWindow.allowed) {
    return (
      <Card icon={<TriangleAlert size={26} />} title={t('다시 로그인해 주세요')}>
        <p className="login-sub">
          {tr('내 개인 볼트를 지우는 일이라, 로그인한 지 {minutes}분이 지나지 않았을 때만 할 수 있습니다. 다시 로그인한 뒤 곧바로 <b>복구 키도 없나요?</b>에서 이어 주세요.', {
            minutes: resetWindow.windowMinutes,
          })}
        </p>
        <Button variant="primary" className="lock-wide" onClick={onLogout}>
          {t('다시 로그인')}
        </Button>
        <button className="link-btn" onClick={() => setMode('password')}>
          {t('돌아가기')}
        </button>
      </Card>
    );
  }

  if (mode === 'reset') {
    return (
      <Card icon={<TriangleAlert size={26} />} title={t('처음부터 다시 만들기')}>
        <div className="lock-warn">
          {tr('비밀번호도 복구 키도 없으면 예전 키는 아무도 풀 수 없습니다. 새로 만들면 <b>내 개인 볼트의 호스트·키·프리셋이 모두 지워집니다.</b> 팀 볼트는 팀 관리자가 다시 공유해 주면 그대로 사용할 수 있습니다.')}
        </div>
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <Input placeholder={t('확인: "{word}"라고 적기', { word: t('초기화') })} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          <Input type="password" placeholder={t('새 암호화 비밀번호({min}자 이상)', { min: MIN })} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <Input type="password" placeholder={t('한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          <Button variant="danger" type="submit" loading={busy} disabled={!pw || !again || !confirmText}>
            {t('지우고 새로 만들기')}
          </Button>
        </form>
        {error && <p className="login-error">{error}</p>}
        <button className="link-btn" onClick={() => setMode('password')}>
          {t('돌아가기')}
        </button>
      </Card>
    );
  }

  if (mode === 'recovery') {
    return (
      <Card icon={<KeyRound size={26} />} title={t('복구 키로 열기')}>
        <p className="login-sub">{t('처음 설정할 때 받은 복구 키(4자씩 8묶음)와, 앞으로 사용할 새 암호화 비밀번호를 입력해 주세요.')}</p>
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            void recover();
          }}
        >
          <Input className="mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          <Input type="password" placeholder={t('새 암호화 비밀번호({min}자 이상)', { min: MIN })} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <Input type="password" placeholder={t('한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          {desktop && (
            <label className="check lock-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {t('이 PC에서 잠금 해제 기억하기')}
            </label>
          )}
          <Button variant="primary" type="submit" loading={busy} disabled={!recovery || !pw || !again}>
            {t('열고 비밀번호 바꾸기')}
          </Button>
        </form>
        {error && <p className="login-error">{error}</p>}
        <div className="lock-links">
          <button className="link-btn" onClick={() => setMode('password')}>
            {t('돌아가기')}
          </button>
          <button className="link-btn" onClick={() => setMode('reset')}>
            {t('복구 키도 없나요?')}
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card icon={<LockKeyhole size={26} />} title={t('잠금 해제')}>
      <p className="login-sub">
        {autoLocked && (
          <>
            {t('한동안 입력이 없어 자동으로 잠갔습니다.')}
            <br />
          </>
        )}
        {tr('<b>{email}</b>의 볼트를 열려면 암호화 비밀번호를 입력해 주세요.', { email: me.user.email })}
      </p>
      {offline && (
        <p className="lock-offline">
          <CloudOff size={14} /> {t('서버에 연결할 수 없어 이 PC에 저장된 사본으로 엽니다.')}
        </p>
      )}
      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
      >
        <Input type="password" placeholder={t('암호화 비밀번호')} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        {desktop && (
          <label className="check lock-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t('이 PC에서 기억하기')}
          </label>
        )}
        <Button variant="primary" type="submit" loading={busy} disabled={!pw}>
          {t('잠금 해제')}
        </Button>
      </form>
      {error && <p className="login-error">{error}</p>}
      <div className="lock-links">
        <button className="link-btn" onClick={() => setMode('recovery')}>
          {t('비밀번호를 잊었나요?')}
        </button>
        <button className="link-btn" onClick={onLogout}>
          {t('로그아웃')}
        </button>
      </div>
    </Card>
  );
}
