import { useEffect, useState } from 'react';
import { api, errorMessage, type AuthConfig } from '../api';
import { desktop } from '../desktop';
import { LANGS, getLang, setLang, t, tk, tMsg, type Lang } from '../i18n';
import { rememberLoginPassword } from '../login-secret';
import { Button, Input, Select } from './ui';
import { DownloadAppLink, useServerLabel } from './AppUpdate';

const ERRORS: Record<string, string> = {
  not_invited: tk('초대받지 않은 계정입니다. 팀 관리자에게 이 이메일로 초대해 달라고 요청해 주세요.'),
  no_team: tk('소속된 팀이 없습니다. 팀 관리자에게 다시 초대해 달라고 요청해 주세요.'),
  disabled: tk('사용이 중지된 계정입니다.'),
  account_mismatch: tk('이 이메일은 다른 Google 계정에 연결되어 있습니다.'),
  unverified_email: tk('Google에서 확인되지 않은 이메일입니다.'),
  expired: tk('로그인 시간이 지났습니다. 다시 시도해 주세요.'),
  cancelled: tk('로그인을 취소했습니다.'),
  google_error: tk('Google 로그인 중 오류가 발생했습니다. 다시 시도해 주세요.'),
  password_account: tk('이 이메일은 아이디·비밀번호로 가입한 계정입니다. 아이디·비밀번호로 로그인해 주세요.'),
  too_many: tk('요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.'),
};

// 알려진 오류 코드면 그 안내 (지금 언어로), 아니면 undefined
const errorText = (code: string) => (ERRORS[code] ? t(ERRORS[code]) : undefined);
const PASSWORD_MIN = 10;

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

// 앱: 지금 연결된 서버와 바꾸기
function ServerLine() {
  const server = useServerLabel();
  if (!desktop || !server) return null;
  return (
    <p className="login-server">
      {server.official ? server.label : t('서버: {server}', { server: server.label })} ·{' '}
      <button className="link-btn" onClick={() => void desktop!.changeServer()}>
        {t('바꾸기')}
      </button>
    </p>
  );
}

// 로그인 화면. 서버 설정에 따라 Google · 아이디·비밀번호(+ 초대 코드로 가입) · 개발용 로그인을 보여 준다.
// 비밀번호·개발용 로그인은 끝나면 onDone(화면을 다시 부팅)으로 넘어간다.
export function Login({ onDone }: { onDone: () => void }) {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(location.search).get('login_error');
    // 주소에 실려 온 글은 그대로 보여 주지 않는다 — 아는 코드만 안내하고 나머지는 한 가지 문구로 (공식 도메인에 남의 문구를 띄우지 못하게)
    return code ? errorText(code) ?? t('로그인하지 못했습니다') : '';
  });

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config').then(setCfg, () => setCfg({ google: false, devLogin: false }));
    if (location.search) history.replaceState(null, '', '/');
  }, []);

  const failed = (code: string | undefined, message: string | undefined) => {
    setError(errorText(code ?? '') ?? errorText(message ?? '') ?? (message ? tMsg(message) : t('로그인하지 못했습니다')));
    setBusy(false);
  };

  // 앱: 시스템 브라우저에서 Google 로그인 → 앱이 세션을 받아 창을 다시 연다
  const desktopLogin = async () => {
    setBusy(true);
    setError('');
    const res = await desktop!.login();
    setBusy(false);
    if (!res.ok) setError(errorText(res.error ?? '') ?? (res.error != null ? tMsg(res.error) : t('로그인하지 못했습니다')));
  };

  const devLogin = async () => {
    setBusy(true);
    setError('');
    try {
      if (desktop) await desktop.devLogin(email);
      else await api.post('/api/auth/dev-login', { email });
      onDone();
    } catch (err) {
      failed((err as { code?: string }).code, errorMessage(err));
    }
  };

  const passwordLogin = async () => {
    setBusy(true);
    setError('');
    try {
      if (desktop) {
        if (!desktop.passwordLogin) return failed(undefined, t('앱을 업데이트해 주세요.'));
        const res = await desktop.passwordLogin(id.trim(), pw);
        if (!res.ok) return failed(res.error, res.message);
      } else {
        await api.post('/api/auth/password', { id: id.trim(), password: pw });
      }
      // 암호화 비밀번호를 정할 때 이것과 같지 않은지 보려고 (login-secret.ts)
      await rememberLoginPassword(pw);
      setPw('');
      onDone();
    } catch (err) {
      failed((err as { code?: string }).code, errorMessage(err));
    }
  };

  const signup = async () => {
    if ([...pw].length < PASSWORD_MIN) return setError(t('{min}자 이상으로 정해 주세요.', { min: PASSWORD_MIN }));
    if (pw !== again) return setError(t('두 번 입력한 비밀번호가 다릅니다.'));
    setBusy(true);
    setError('');
    const body = { email: email.trim(), code: code.trim(), name: name.trim(), password: pw };
    try {
      if (desktop) {
        if (!desktop.inviteSignup) return failed(undefined, t('앱을 업데이트해 주세요.'));
        const res = await desktop.inviteSignup(body);
        if (!res.ok) return failed(res.error, res.message);
      } else {
        await api.post('/api/auth/invite-signup', body);
      }
      await rememberLoginPassword(pw);
      setPw('');
      setAgain('');
      onDone();
    } catch (err) {
      failed((err as { code?: string }).code, errorMessage(err));
    }
  };

  const nothing = cfg && !cfg.google && !cfg.password && !cfg.devLogin;

  return (
    <div className="login">
      <div className="login-card">
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>Terminas</h1>
        <p className="login-sub">{mode === 'signup' ? t('초대 코드로 가입') : t('팀 서버와 저장된 호스트에 한곳에서 접속하세요')}</p>

        {mode === 'login' && (
          <>
            {cfg?.google && !desktop && (
              <a className="btn btn-soft btn-md login-google" href="/api/auth/google/start">
                <GoogleMark />
                {t('Google로 계속하기')}
              </a>
            )}
            {cfg?.google && desktop && (
              <button className="btn btn-soft btn-md login-google" disabled={busy} onClick={() => void desktopLogin()}>
                <GoogleMark />
                {busy ? t('브라우저에서 로그인을 마쳐 주세요…') : t('Google로 계속하기')}
              </button>
            )}

            {cfg?.password && (
              <form
                className="login-dev"
                onSubmit={(e) => {
                  e.preventDefault();
                  void passwordLogin();
                }}
              >
                {cfg.google && (
                  <div className="login-divider">
                    <span>{t('또는')}</span>
                  </div>
                )}
                <Input placeholder={t('아이디(이메일)')} value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus={!cfg.google} aria-label={t('아이디')} />
                <Input type="password" placeholder={t('비밀번호')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-label={t('비밀번호')} />
                <Button variant="primary" type="submit" loading={busy} disabled={!id.trim() || !pw}>
                  {t('로그인')}
                </Button>
                <button
                  type="button"
                  className="link-btn login-switch"
                  onClick={() => {
                    setMode('signup');
                    setError('');
                    setPw('');
                  }}
                >
                  {t('초대 코드를 받았나요? 가입하기')}
                </button>
              </form>
            )}

            {nothing && <p className="login-note">{t('로그인 방법이 아직 설정되지 않았습니다. 서버 관리자에게 문의해 주세요.')}</p>}

            {cfg?.devLogin && (
              <form
                className="login-dev"
                onSubmit={(e) => {
                  e.preventDefault();
                  void devLogin();
                }}
              >
                <div className="login-divider">
                  <span>{t('개발용 로그인')}</span>
                </div>
                <Input type="email" placeholder={t('이메일')} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!cfg.google && !cfg.password} />
                <Button variant="primary" type="submit" loading={busy} disabled={!email}>
                  {t('이메일로 들어가기')}
                </Button>
              </form>
            )}
          </>
        )}

        {mode === 'signup' && (
          <form
            className="login-dev"
            onSubmit={(e) => {
              e.preventDefault();
              void signup();
            }}
          >
            <p className="login-note">{t('팀 관리자에게 받은 초대 코드와, 초대받은 이메일을 입력하고 로그인 비밀번호를 정해 주세요.')}</p>
            <Input type="email" placeholder={t('초대받은 이메일')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus aria-label={t('초대받은 이메일')} />
            <Input className="mono" placeholder="XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} aria-label={t('초대 코드')} />
            <Input placeholder={t('이름(선택)')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-label={t('이름')} />
            <Input type="password" placeholder={t('로그인 비밀번호({min}자 이상)', { min: PASSWORD_MIN })} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" aria-label={t('비밀번호')} />
            <Input type="password" placeholder={t('한 번 더')} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label={t('한 번 더')} />
            <Button variant="primary" type="submit" loading={busy} disabled={!email.trim() || !code.trim() || !pw || !again}>
              {t('가입하고 들어가기')}
            </Button>
            <button
              type="button"
              className="link-btn login-switch"
              onClick={() => {
                setMode('login');
                setError('');
                setPw('');
                setAgain('');
              }}
            >
              {t('로그인으로 돌아가기')}
            </button>
          </form>
        )}

        {error && <p className="login-error">{error}</p>}
        <p className="login-foot">{cfg?.openSignup && cfg.google ? t('Google 계정으로 누구나 가입할 수 있습니다') : t('초대받은 계정만 들어올 수 있습니다')}</p>
        {cfg?.links && (cfg.links.terms || cfg.links.privacy || cfg.links.source) && (
          <p className="login-links">
            {[
              cfg.links.terms && ['terms', t('이용약관'), cfg.links.terms],
              cfg.links.privacy && ['privacy', t('개인정보처리방침'), cfg.links.privacy],
              cfg.links.source && ['source', t('소스 코드(AGPL-3.0)'), cfg.links.source],
            ]
              .filter((x): x is [string, string, string] => Boolean(x))
              .map(([key, label, href], i) => (
                <span key={key}>
                  {i > 0 && ' · '}
                  <a href={href} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                </span>
              ))}
          </p>
        )}
        <ServerLine />
        {!desktop && <DownloadAppLink />}
        <Select className="login-lang" aria-label={t('언어')} value={getLang()} onChange={(e) => void setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
