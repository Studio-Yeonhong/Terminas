// 데스크톱 앱: 자동 업데이트 알림 / 웹: "Windows 앱 받기"
import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw, RotateCw, Server } from 'lucide-react';
import { api } from '../api';
import { desktop, type UpdateStatus } from '../desktop';
import { t, tMsg } from '../i18n';
import { useStore } from '../store';
import { Badge, Button, Card, Toggle } from './ui';

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => desktop?.update?.onStatus(setStatus), []);
  return status;
}

// version 이 없으면: 이 서버엔 설치 파일이 없고 공식 배포처로 보낸다 (SHELL_APP_DOWNLOAD_URL)
type Latest = { version: string | null; url: string; releaseDate: string | null };
const downloadLabel = (l: Latest) => (l.version ? t('Windows 앱 받기({version})', { version: l.version }) : t('Windows 앱 받기'));

export function useLatestApp() {
  const [latest, setLatest] = useState<Latest | null>(null);
  useEffect(() => {
    if (desktop) return;
    api.get<Latest>('/api/app/latest').then(setLatest, () => setLatest(null));
  }, []);
  return latest;
}

// 새 버전 설치는 사람이 확인했을 때만 (앱이 다시 시작되며 열린 접속이 끊긴다)
function useInstall() {
  const s = useStore();
  return async (version: string) => {
    const ok = await s.confirm({
      title: t('{version}(으)로 업데이트', { version }),
      message: t('앱을 닫고 새 버전을 설치한 뒤 다시 엽니다. 열려 있는 터미널·SFTP·포트 포워딩 접속은 끊깁니다. 지금 업데이트할까요?'),
      confirmLabel: t('다시 시작해 업데이트'),
      cancelLabel: t('나중에'),
    });
    if (ok) desktop!.update.install();
  };
}

// 상단 바: 새 버전을 다 받았으면 "다시 시작" 버튼 (누르면 먼저 묻는다)
export function UpdatePill() {
  const status = useUpdateStatus();
  const install = useInstall();
  if (!desktop || !status) return null;
  if (status.state === 'downloading') {
    return (
      <span className="update-pill muted" title={t('새 버전을 받는 중')}>
        <Loader2 size={13} className="spin" /> {t('업데이트 {percent}%', { percent: Math.round(status.percent ?? 0) })}
      </span>
    );
  }
  if (status.state !== 'downloaded') return null;
  return (
    <button className="update-pill ready" onClick={() => void install(status.version ?? '')} title={t('다시 시작해 새 버전으로 바꿉니다')}>
      <RotateCw size={13} /> {t('{version}(으)로 업데이트', { version: status.version ?? '' })}
    </button>
  );
}

// 앱: 연결된 서버를 보여 줄 이름 — 공식 서버면 "공식 서버(주소)", 직접 운영하는 서버면 주소만
export function useServerLabel(): { label: string; official: boolean } | null {
  const [info, setInfo] = useState<{ url: string; official: boolean } | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const get = desktop.serverInfo ? desktop.serverInfo() : desktop.serverUrl().then((url) => ({ url, official: false }));
    get.then(setInfo, () => {});
  }, []);
  if (!info?.url) return null;
  let host = info.url;
  try {
    host = new URL(info.url).host;
  } catch {}
  return { label: info.official ? t('공식 서버({host})', { host }) : host, official: info.official };
}

// 앱: 지금 연결된 서버 (공식 서버 / 직접 운영하는 서버) 와 바꾸기
function ServerRow() {
  const server = useServerLabel();
  if (!desktop || !server) return null;
  return (
    <div className="setting-row">
      <span>
        <Server size={13} className="inline-icon" /> {t('연결된 서버')} <span className="muted small">· {server.label}</span>
      </span>
      <Button size="sm" onClick={() => void desktop!.changeServer()}>
        {t('서버 바꾸기')}
      </Button>
    </div>
  );
}

// 베타 버전 받기 (업데이트 채널). 켤 때 안정성 경고를 먼저 보여 준다.
// 베타 채널에는 정식 버전도 올라가므로(더 새것일 때) 켜 두어도 정식 업데이트를 놓치지 않는다.
function BetaRow() {
  const s = useStore();
  const [info, setInfo] = useState<{ channel: 'stable' | 'beta'; prerelease: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    desktop?.update.channel?.().then(setInfo, () => {});
  }, []);
  if (!desktop?.update.setChannel || !info) return null;
  const on = info.channel === 'beta';
  const toggle = async (next: boolean) => {
    const ok = next
      ? await s.confirm({
          title: t('베타 버전 참여'),
          message: t('베타 버전은 정식 출시 전의 기능을 먼저 사용해 보는 버전입니다. 오류가 있을 수 있고, 드물게 앱이 멈추거나 베타에서 만든 항목을 정식 버전 앱에서 수정할 수 없을 수 있습니다. 중요한 서버를 다루는 PC라면 정식 버전을 권합니다. 베타도 공식 서명을 확인한 파일만 설치합니다.'),
          confirmLabel: t('베타 참여'),
          danger: true,
        })
      : await s.confirm({
          title: t('베타에서 나가기'),
          message: info.prerelease ? t('지금 사용하는 베타 버전은 그대로 사용하다가, 다음 정식 버전이 나오면 그것으로 바뀝니다.') : t('이제 정식 버전만 받습니다.'),
          confirmLabel: t('나가기'),
        });
    if (!ok) return;
    setBusy(true);
    try {
      await desktop!.update.setChannel!(next ? 'beta' : 'stable');
      setInfo({ ...info, channel: next ? 'beta' : 'stable' });
      s.toast(next ? t('베타 버전을 받습니다. 새 베타가 나오면 알아서 받아 둡니다.') : t('정식 버전만 받습니다.'), 'success');
    } catch (err) {
      s.toast(tMsg(err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="setting-row">
        <span>
          {t('베타 버전 받기')} {on && <Badge tone="warn">{t('베타')}</Badge>}
        </span>
        {!busy && <Toggle checked={on} label={t('베타 버전 받기')} onChange={(v) => void toggle(v)} />}
      </div>
      <p className="muted small">{t('정식 출시 전의 새 기능을 먼저 받습니다. 불안정할 수 있습니다.')}</p>
    </>
  );
}

// 설정 → 계정: 앱 버전·업데이트 확인·연결된 서버, 웹이면 앱 내려받기
export function AppCard() {
  const status = useUpdateStatus();
  const latest = useLatestApp();
  const [checking, setChecking] = useState(false);
  const install = useInstall();

  if (desktop) {
    const text =
      status?.state === 'checking'
        ? t('확인하는 중…')
        : status?.state === 'none'
          ? t('최신 버전입니다.')
          : status?.state === 'available' || status?.state === 'downloading'
            ? t('{version}을(를) 받는 중… {percent}%', { version: status.version ?? t('새 버전'), percent: Math.round(status.percent ?? 0) })
            : status?.state === 'downloaded'
              ? t('{version} 업데이트 준비가 완료되었습니다.', { version: status.version ?? '' })
              : status?.state === 'error'
                ? t('업데이트 확인 실패: {error}', { error: tMsg(status.message ?? '') })
                : t('새 버전이 나오면 알아서 받아 둡니다.');
    return (
      <Card title={t('데스크톱 앱')}>
        <div className="setting-row">
          <span>
            Terminas {desktop.version} {/-/.test(desktop.version) && <Badge tone="warn">{t('베타')}</Badge>} <span className="muted small">· {text}</span>
          </span>
          {/* 확인 단추는 자리를 바꾸지 않는다 — 받은 뒤에 같은 자리를 다시 눌러 설치되는 일이 없게 (설치는 아래 줄에서, 한 번 더 묻고) */}
          <Button
            size="sm"
            loading={checking}
            disabled={status?.state === 'downloading' || status?.state === 'downloaded'}
            onClick={async () => {
              setChecking(true);
              try {
                await desktop!.update.check();
              } finally {
                setChecking(false);
              }
            }}
          >
            <RefreshCw size={14} /> {t('업데이트 확인')}
          </Button>
        </div>
        {status?.state === 'downloaded' && (
          <div className="setting-row update-ready-row">
            <span>{t('{version}(으)로 바꾸려면 앱을 다시 시작해야 합니다.', { version: status.version ?? '' })}</span>
            <Button size="sm" variant="primary" onClick={() => void install(status.version ?? '')}>
              <RotateCw size={14} /> {t('다시 시작해 업데이트')}
            </Button>
          </div>
        )}
        <BetaRow />
        <ServerRow />
      </Card>
    );
  }

  return (
    <Card title={t('데스크톱 앱')}>
      <p className="muted small">{t('로컬 터미널, 내 컴퓨터 ↔ 서버 파일 전송, 포트 포워딩은 데스크톱 앱에서 됩니다. 앱은 새 버전이 나오면 알아서 업데이트합니다.')}</p>
      {latest ? (
        <a className="btn btn-primary btn-md app-download" href={latest.url} download={latest.version ? '' : undefined} target={latest.version ? undefined : '_blank'} rel="noreferrer">
          <Download size={15} /> {downloadLabel(latest)}
        </a>
      ) : (
        <p className="muted small">{t('아직 배포한 앱이 없습니다.')}</p>
      )}
    </Card>
  );
}

// 로그인 화면 아래 작은 링크
export function DownloadAppLink() {
  const latest = useLatestApp();
  if (!latest) return null;
  return (
    <a className="login-app-link" href={latest.url} download={latest.version ? '' : undefined} target={latest.version ? undefined : '_blank'} rel="noreferrer">
      <Download size={13} /> {downloadLabel(latest)}
    </a>
  );
}
