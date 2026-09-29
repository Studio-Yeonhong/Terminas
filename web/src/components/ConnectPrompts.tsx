// SSH 접속 중에 묻는 것들(서버 지문·자격증명·추가 인증) — 터미널·SFTP·포트 포워딩 공용
import { useEffect, useState } from 'react';
import { AlertTriangle, Fingerprint, KeyRound, RotateCw } from 'lucide-react';
import type { Identity } from '../api';
import { t, tr } from '../i18n';
import { useStore } from '../store';
import { ensureLoaded, personalIdentities, personalVaultId } from '../vault';
import { Button, Input, Select } from './ui';

export type PromptOverlay =
  | { kind: 'hostkey'; state: 'new' | 'mismatch'; address: string; port: number; keyType: string; fingerprint: string; knownFingerprint?: string; canEdit?: boolean; otherTypes?: string[]; personal?: boolean }
  | { kind: 'auth'; username: string; needUsername: boolean }
  | { kind: 'kbd'; instructions: string; prompts: { prompt: string; echo: boolean }[] };

type Props = {
  overlay: PromptOverlay;
  vaultId: string;
  reply: (msg: Record<string, unknown>) => void;
  dismiss: () => void;
  reconnect: () => void;
};

export function ConnectPrompt({ overlay, vaultId, reply, dismiss, reconnect }: Props) {
  const s = useStore();
  // 이미 아는 서버가 처음 보는 종류의 키를 내밀었다 → 중간자가 키 종류를 바꿔 끼웠을 수 있다 (보안 검토 M-7).
  // 위험 창으로 보여 주고, 기본 초점은 취소에 둔다 (Enter 한 번으로 신뢰하지 않게)
  if (overlay.kind === 'hostkey' && overlay.state === 'new' && overlay.otherTypes?.length) {
    return (
      <div className="term-overlay">
        <div className="term-dialog danger">
          <div className="dlg-icon danger">
            <AlertTriangle size={22} />
          </div>
          <h3>{t('서버가 다른 종류의 호스트 키를 제시했습니다')}</h3>
          <p>
            {tr('<b>{address}:{port}</b>은(는) 전에 다른 종류의 호스트 키({types})를 제시했는데, 이번에는 처음 보는 종류({keyType})의 키를 제시했습니다. 서버 관리자가 새 키를 추가한 게 확실하지 않으면 중간자 공격일 수 있으니 신뢰하지 말고 취소해 주세요.', {
              address: overlay.address,
              port: overlay.port,
              types: overlay.otherTypes.join(', '),
              keyType: overlay.keyType,
            })}
          </p>
          <div className="fp-box danger">
            <span>{overlay.keyType}</span>
            <code>{overlay.fingerprint}</code>
          </div>
          <p className="muted small">
            {overlay.personal
              ? t('신뢰하면 내 개인 볼트의 알려진 호스트에 저장됩니다.')
              : t('신뢰하면 이 볼트의 알려진 호스트에 저장되어 이 볼트를 사용하는 모든 사람에게 적용됩니다.')}
          </p>
          <div className="dlg-actions">
            <Button variant="primary" autoFocus onClick={() => (reply({ t: 'hostkey', accept: false }), dismiss())}>
              {t('취소')}
            </Button>
            <Button variant="danger" onClick={() => (reply({ t: 'hostkey', accept: true }), dismiss())}>
              {t('그래도 신뢰하고 연결')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (overlay.kind === 'hostkey' && overlay.state === 'new') {
    return (
      <div className="term-overlay">
        <div className="term-dialog">
          <div className="dlg-icon">
            <Fingerprint size={22} />
          </div>
          <h3>{t('처음 접속하는 서버입니다')}</h3>
          <p>
            {tr('<b>{address}:{port}</b>의 서버 지문이 맞는지 확인한 뒤 신뢰해 주세요. 신뢰하면 {vault}의 알려진 호스트에 저장되고, 다음부터 지문이 바뀌면 접속이 차단됩니다.', {
              address: overlay.address,
              port: overlay.port,
              vault: overlay.personal ? t('내 개인 볼트') : t('이 볼트'),
            })}
            {overlay.personal && ' ' + t('이 볼트는 보기 권한이라 팀 전체가 아니라 나에게만 적용됩니다.')}
          </p>
          <div className="fp-box">
            <span>{overlay.keyType}</span>
            <code>{overlay.fingerprint}</code>
          </div>
          <div className="dlg-actions">
            <Button variant="ghost" onClick={() => (reply({ t: 'hostkey', accept: false }), dismiss())}>
              {t('취소')}
            </Button>
            <Button variant="primary" autoFocus onClick={() => (reply({ t: 'hostkey', accept: true }), dismiss())}>
              {t('신뢰하고 연결')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (overlay.kind === 'hostkey') {
    return (
      <div className="term-overlay">
        <div className="term-dialog danger">
          <div className="dlg-icon danger">
            <AlertTriangle size={22} />
          </div>
          <h3>{t('서버 지문이 바뀌었습니다')}</h3>
          <p>
            {tr('<b>{address}:{port}</b>의 지문이 저장된 것과 다릅니다. 서버를 다시 설치한 게 아니라면 중간자 공격이 의심되어 연결을 차단했습니다.', {
              address: overlay.address,
              port: overlay.port,
            })}
          </p>
          <div className="fp-box">
            <span>{t('저장됨')}</span>
            <code>{overlay.knownFingerprint}</code>
          </div>
          <div className="fp-box danger">
            <span>{t('지금')}</span>
            <code>{overlay.fingerprint}</code>
          </div>
          <p className="muted small">{overlay.canEdit ? t('바뀐 게 확실하면 알려진 호스트에서 이 항목을 지운 뒤 다시 연결해 주세요.') : t('이 볼트 관리자에게 알려 주세요.')}</p>
          <div className="dlg-actions">
            {overlay.canEdit && (
              <Button
                onClick={() => {
                  s.setVaultId(vaultId);
                  s.setSection('known');
                }}
              >
                {t('알려진 호스트 열기')}
              </Button>
            )}
            <Button variant="ghost" onClick={dismiss}>
              {t('닫기')}
            </Button>
            <Button variant="primary" onClick={reconnect}>
              <RotateCw size={14} /> {t('다시 연결')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (overlay.kind === 'auth') return <AuthDialog key={overlay.username} overlay={overlay} onSubmit={(m) => (reply({ t: 'auth', ...m }), dismiss())} />;
  return <KbdDialog overlay={overlay} onSubmit={(answers) => (reply({ t: 'kbd', answers }), dismiss())} />;
}

function AuthDialog({ overlay, onSubmit }: { overlay: Extract<PromptOverlay, { kind: 'auth' }>; onSubmit: (m: Record<string, unknown>) => void }) {
  const [mode, setMode] = useState<'password' | 'identity'>('password');
  const [username, setUsername] = useState(overlay.username);
  const [password, setPassword] = useState('');
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityId] = useState('');
  const [remember, setRemember] = useState(true);

  // 내 개인 볼트의 계정 프리셋 (이 기기에서 풀어 둔 것)
  useEffect(() => {
    const pv = personalVaultId();
    if (!pv) return;
    void ensureLoaded(pv)
      .catch(() => false)
      .then(() => {
        const list = personalIdentities();
        setIdentities(list);
        if (list[0]) setIdentityId(list[0].id);
      });
  }, []);

  return (
    <div className="term-overlay">
      <form
        className="term-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(mode === 'identity' ? { username, identityId, remember } : { username, password });
        }}
      >
        <div className="dlg-icon">
          <KeyRound size={22} />
        </div>
        <h3>{t('자격증명이 필요합니다')}</h3>
        <p className="muted">{t('이 호스트에는 저장된 자격증명이 없습니다. 이번 접속에 사용할 정보를 입력해 주세요.')}</p>
        <div className="seg wide">
          <button type="button" className={mode === 'password' ? 'on' : ''} onClick={() => setMode('password')}>
            {t('비밀번호')}
          </button>
          <button type="button" className={mode === 'identity' ? 'on' : ''} onClick={() => setMode('identity')}>
            {t('내 계정 프리셋')}
          </button>
        </div>
        {mode === 'password' ? (
          <>
            <Input placeholder={t('사용자 이름')} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} autoComplete="off" />
            <Input type="password" placeholder={t('비밀번호')} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={Boolean(username)} autoComplete="off" />
            <p className="muted small">{t('입력한 비밀번호는 이번 접속에만 사용하고 어디에도 저장하지 않습니다.')}</p>
          </>
        ) : identities.length === 0 ? (
          <p className="muted small">{t('개인 볼트에 계정 프리셋이 없습니다. 볼트를 Personal로 바꿔 키체인에서 먼저 만들어 주세요.')}</p>
        ) : (
          <>
            <Select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label} ({i.username})
                </option>
              ))}
            </Select>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {t('이 호스트에 기억하기(나에게만 적용)')}
            </label>
          </>
        )}
        <div className="dlg-actions">
          <Button type="button" variant="ghost" onClick={() => onSubmit({ cancel: true })}>
            {t('취소')}
          </Button>
          <Button type="submit" variant="primary" disabled={mode === 'password' ? !username || !password : !identityId}>
            {t('연결')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function KbdDialog({ overlay, onSubmit }: { overlay: Extract<PromptOverlay, { kind: 'kbd' }>; onSubmit: (answers: string[]) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => overlay.prompts.map(() => ''));
  return (
    <div className="term-overlay">
      <form
        className="term-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(answers);
        }}
      >
        <div className="dlg-icon">
          <KeyRound size={22} />
        </div>
        <h3>{t('서버가 추가 인증을 요청합니다')}</h3>
        {overlay.instructions && <p className="muted">{overlay.instructions}</p>}
        {overlay.prompts.map((p, i) => (
          <label key={i} className="field">
            <span className="field-label">{p.prompt.trim()}</span>
            <Input
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              autoFocus={i === 0}
              autoComplete="off"
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
        <div className="dlg-actions">
          <Button type="submit" variant="primary">
            {t('확인')}
          </Button>
        </div>
      </form>
    </div>
  );
}
