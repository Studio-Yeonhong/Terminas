// 0.1.x 앱(화면을 서버에서 받아 오던 옛 앱)에서 새 화면이 열렸을 때: 업데이트만 안내한다.
// 옛 앱의 자동 업데이트(electron-updater)는 그대로 돌기 때문에, 받으면 "다시 시작" 한 번으로 새 앱이 된다.
import { useEffect, useState } from 'react';
import { Download, RotateCw, ShieldCheck } from 'lucide-react';
import { legacyApp, type UpdateStatus } from '../desktop';
import { Button } from './ui';
import { t, tMsg } from '../i18n';

export function LegacyAppUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const off = legacyApp!.update.onStatus(setStatus);
    void legacyApp!.update.check().catch(() => {});
    return off;
  }, []);

  const busy = status?.state === 'checking' || status?.state === 'available' || status?.state === 'downloading';
  return (
    <div className="login">
      <div className="login-card lock-card">
        <div className="lock-icon">
          <ShieldCheck size={26} />
        </div>
        <h1>{t('앱을 업데이트해 주세요')}</h1>
        <p className="login-sub">
          {t('새 Terminas는 비밀번호·SSH 키를 이 PC에서만 풀고, 서버를 거치지 않고 서버에 직접 접속합니다. 지금 앱({version})으로는 사용할 수 없어 새 버전이 필요합니다.', { version: legacyApp!.version })}
        </p>
        {status?.state === 'downloaded' ? (
          <Button variant="primary" className="lock-wide" onClick={() => legacyApp!.update.install()}>
            <RotateCw size={14} /> {t('다시 시작해서 {version}(으)로 바꾸기', { version: status.version ?? '' })}
          </Button>
        ) : (
          <Button variant="primary" className="lock-wide" loading={busy} onClick={() => void legacyApp!.update.check()}>
            {/* 버튼이 loading 일 때 스피너를 이미 하나 그린다 */}
            {busy ? (status?.percent ? t('새 버전을 받는 중… {percent}%', { percent: Math.round(status.percent) }) : t('새 버전을 받는 중…')) : t('업데이트 확인')}
          </Button>
        )}
        {status?.state === 'error' && <p className="login-error">{tMsg(status.message ?? '')}</p>}
        <a className="login-app-link" href="/api/app/latest" onClick={(e) => (e.preventDefault(), void openInstaller())}>
          <Download size={13} /> {t('설치 파일로 직접 받기')}
        </a>
      </div>
    </div>
  );
}

async function openInstaller() {
  const res = await fetch('/api/app/latest').catch(() => null);
  const latest = res?.ok ? ((await res.json()) as { url: string }) : null;
  if (latest) window.open(new URL(latest.url, location.origin).toString(), '_blank');
}
