// 2단계 인증(OTP): 로그인할 때 코드 묻기(MfaPrompt) · 설정의 켜기·끄기·복구 코드(MfaCard).
// 서버는 auth.ts(/api/auth/mfa/verify)·routes/mfa.ts. 처음엔 모두 꺼져 있다.
import { useEffect, useMemo, useState } from 'react';
import { renderSVG } from 'uqr';
import { Copy, Download, Eye, EyeOff, ShieldCheck, Smartphone } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api';
import { useStore } from '../store';
import { locale, t } from '../i18n';
import { saveText } from './Lock';
import { Button, Card, Input, Modal } from './ui';

// ---------- 로그인: Google·비밀번호 로그인 뒤 인증 앱 코드 ----------
export function MfaPrompt({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (value = code) => {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/mfa/verify', { code: value.trim() });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
      // 여러 번 틀려 세션이 지워졌으면 로그인 화면으로
      if (err instanceof ApiError && err.status === 401) setTimeout(onLogout, 2500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card lock-card">
        <div className="lock-icon">
          <Smartphone size={26} />
        </div>
        <h1>{t('2단계 인증')}</h1>
        <p className="login-sub">{recovery ? t('저장해 둔 복구 코드 하나를 입력해 주세요. 한 번 사용한 코드는 다시 사용할 수 없습니다.') : t('인증 앱에 보이는 6자리 코드를 입력해 주세요.')}</p>
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            className="mono otp-input"
            value={code}
            onChange={(e) => {
              const v = recovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              // 여섯 자리를 다 넣으면 바로 확인
              if (!recovery && v.length === 6 && !busy) void submit(v);
            }}
            placeholder={recovery ? 'xxxxx-xxxxx' : '000000'}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            spellCheck={false}
            aria-label={recovery ? t('복구 코드') : t('인증 코드')}
          />
          <Button variant="primary" type="submit" loading={busy} disabled={recovery ? code.trim().length < 10 : code.length !== 6}>
            {t('확인')}
          </Button>
        </form>
        {error && <p className="login-error">{error}</p>}
        <div className="lock-links">
          <button
            className="link-btn"
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
              setError('');
            }}
          >
            {recovery ? t('인증 앱 코드 사용하기') : t('복구 코드 사용하기')}
          </button>
          <button className="link-btn" onClick={onLogout}>
            {t('다른 계정으로 로그인')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 설정: 켜기·끄기·복구 코드 ----------
type MfaStatus = { enabled: boolean; enabledAt: number | null; recoveryLeft: number };

export function MfaCard() {
  const s = useStore();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.get<MfaStatus>('/api/me/mfa').then(setStatus, (err) => {
      s.toast(errorMessage(err), 'error');
    });
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const start = () => act(async () => setSetup(await api.post<{ secret: string; uri: string }>('/api/me/mfa/setup')));

  const disable = async () => {
    const code = await s.askText({ title: t('2단계 인증 끄기'), label: t('인증 앱의 6자리 코드 또는 복구 코드'), value: '', confirmLabel: t('끄기') });
    if (!code) return;
    await act(async () => {
      await api.post('/api/me/mfa/disable', { code });
      s.toast(t('2단계 인증을 껐습니다'), 'success');
      await load();
    });
  };

  const regenerate = async () => {
    const code = await s.askText({
      title: t('복구 코드 새로 만들기'),
      label: t('인증 앱의 6자리 코드'),
      value: '',
      confirmLabel: t('새로 만들기'),
      hint: t('예전 복구 코드는 모두 사용할 수 없게 됩니다.'),
    });
    if (!code) return;
    await act(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/me/mfa/recovery', { code });
      setCodes(r.recoveryCodes);
      await load();
    });
  };

  if (!status) return null;
  return (
    <Card title={t('2단계 인증(OTP)')}>
      {status.enabled ? (
        <>
          <div className="setting-row">
            <span>
              <ShieldCheck size={14} /> {t('켜져 있음')}
            </span>
            {status.enabledAt && <span className="muted small">{t('{date}에 켬', { date: new Date(status.enabledAt).toLocaleDateString(locale()) })}</span>}
          </div>
          <p className="muted small">{t('로그인할 때 인증 앱의 코드를 한 번 더 묻습니다. 남은 복구 코드: {count}개', { count: status.recoveryLeft })}</p>
          <div className="row-actions">
            <Button size="sm" disabled={busy} onClick={() => void regenerate()}>
              {t('복구 코드 새로 만들기')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void disable()}>
              {t('끄기')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">{t('켜면 로그인할 때 인증 앱(Google Authenticator·1Password·Authy 등)의 6자리 코드를 한 번 더 묻습니다. 처음에는 꺼져 있습니다.')}</p>
          <Button disabled={busy} onClick={() => void start()}>
            <Smartphone size={14} /> {t('켜기')}
          </Button>
        </>
      )}
      {setup && (
        <MfaSetupDialog
          setup={setup}
          onClose={() => setSetup(null)}
          onEnabled={(c) => {
            setSetup(null);
            setCodes(c);
            void load();
          }}
        />
      )}
      {codes && <RecoveryCodesDialog codes={codes} email={s.me.user.email} onClose={() => setCodes(null)} />}
    </Card>
  );
}

function MfaSetupDialog({ setup, onClose, onEnabled }: { setup: { secret: string; uri: string }; onClose: () => void; onEnabled: (codes: string[]) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // QR 은 이 기기에서 그린다 (비밀값을 다른 서비스로 보내지 않는다)
  const qr = useMemo(() => renderSVG(setup.uri, { border: 2 }), [setup.uri]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/me/mfa/enable', { code });
      onEnabled(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('2단계 인증 켜기')} onClose={onClose} width={460}>
      <ol className="mfa-steps">
        <li>{t('휴대폰의 인증 앱에서 이 QR 코드를 찍어 주세요.')}</li>
      </ol>
      <div className="mfa-qr" role="img" aria-label={t('인증 앱에 등록할 QR 코드')} dangerouslySetInnerHTML={{ __html: qr }} />
      <ol className="mfa-steps" start={2}>
        <li>{t('찍을 수 없으면 이 키를 직접 입력해 주세요.')}</li>
      </ol>
      <code className="mfa-secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
      <ol className="mfa-steps" start={3}>
        <li>{t('인증 앱에 보이는 6자리 코드를 입력해 확인합니다.')}</li>
      </ol>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <Input
          className="mono otp-input"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          aria-label={t('인증 코드')}
        />
        <Button variant="primary" type="submit" loading={busy} disabled={code.length !== 6}>
          {t('확인하고 켜기')}
        </Button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </Modal>
  );
}

// 복구 코드: 처음엔 가려 둔다 (복구 키와 같이). 복사·저장은 가린 채로도 된다
function RecoveryCodesDialog({ codes, email, onClose }: { codes: string[]; email: string; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const file = () =>
    t('Terminas 2단계 인증 복구 코드\r\n\r\n계정: {email}\r\n만든 날: {date}\r\n\r\n{codes}\r\n\r\n인증 앱을 사용할 수 없을 때 코드 하나로 로그인할 수 있습니다. 코드마다 한 번만 사용할 수 있습니다.\r\n', {
      email,
      date: new Date().toLocaleString(locale()),
      codes: codes.join('\r\n'),
    });
  return (
    <Modal title={t('복구 코드')} onClose={onClose} width={460}>
      <p className="muted small">{t('휴대폰을 잃었을 때 코드 하나로 로그인할 수 있습니다. 코드마다 한 번만 사용할 수 있고, 지금 한 번만 보여 드립니다.')}</p>
      <ul className="mfa-codes" aria-label={shown ? t('복구 코드') : t('가려진 복구 코드')}>
        {codes.map((c) => (
          <li key={c}>
            <code>{shown ? c : '•••••-•••••'}</code>
          </li>
        ))}
      </ul>
      <div className="recovery-actions">
        <Button size="sm" onClick={() => setShown(!shown)}>
          {shown ? <EyeOff size={14} /> : <Eye size={14} />} {shown ? t('가리기') : t('보이기')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(codes.join('\n')).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          <Copy size={14} /> {copied ? t('복사했습니다') : t('복사')}
        </Button>
        <Button size="sm" onClick={() => saveText('terminas-otp-recovery-codes.txt', file())}>
          <Download size={14} /> {t('파일로 저장')}
        </Button>
      </div>
      <Button variant="primary" className="mfa-done" onClick={onClose}>
        {t('저장했습니다')}
      </Button>
    </Modal>
  );
}
