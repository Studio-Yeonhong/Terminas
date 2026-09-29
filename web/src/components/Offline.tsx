// 오프라인 사용 (앱): 볼트 위의 안내 줄 · 위쪽 막대의 상태 표시 · 설정 "오프라인·동기화"
import { useState } from 'react';
import { CloudOff, HardDrive, LogIn, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { errorMessage } from '../api';
import { useStore } from '../store';
import { desktop } from '../desktop';
import { allowLeave } from '../autolock';
import { locale, t } from '../i18n';
import { pendingChanges, vaultCopyExpiresAt, vaultSyncedAt } from '../vault';
import { TEAM_OFFLINE_DAYS, queuedAudits } from '../offline';
import { Badge, Button, Card, Modal, Toggle, timeAgo } from './ui';

const day = (ts: number) => new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

// 화면을 새로 연다 (열린 터미널은 끊긴다 — 사람이 누른 때만)
const reopen = () => {
  allowLeave();
  location.reload();
};

export function OfflineBanner() {
  const s = useStore();
  if (s.authLost)
    return (
      <div className="banner warn">
        <LogIn size={15} />
        <span>{t('로그인이 만료되어 서버와 맞추지 못합니다. 이 PC의 사본으로 계속 사용할 수 있고, 다시 로그인하면 수정한 것을 올립니다.')}</span>
        <Button size="sm" onClick={reopen}>
          {t('다시 로그인')}
        </Button>
      </div>
    );
  if (s.serverIssue === 'account_changed')
    return (
      <div className="banner warn">
        <ShieldAlert size={15} />
        <span>{t('서버에서 이 계정의 암호화 설정이 바뀌었습니다. 볼트를 다시 열어야 서버와 맞출 수 있습니다.')}</span>
        <Button size="sm" onClick={reopen}>
          {t('다시 열기')}
        </Button>
      </div>
    );
  if (s.serverIssue === 'incompatible')
    return (
      <div className="banner warn">
        <TriangleAlert size={15} />
        <span>{t('서버와 앱의 버전이 맞지 않아 연결하지 않았습니다. 앱을 업데이트해 주세요. 그동안은 이 PC의 사본을 사용합니다.')}</span>
        {desktop && (
          <Button size="sm" onClick={() => void desktop!.update.check()}>
            <RefreshCw size={13} /> {t('업데이트 확인')}
          </Button>
        )}
      </div>
    );
  if (s.mode === 'local')
    return (
      <div className="banner warn">
        <HardDrive size={15} />
        <span>{t('임시 모드: 서버에 연결할 수 없고 이 PC에 저장된 볼트도 없어 임시로 열었습니다. 여기서 만든 호스트·요청은 앱을 닫으면 사라집니다.')}</span>
        <Button size="sm" onClick={reopen}>
          {t('서버에 다시 연결')}
        </Button>
      </div>
    );
  if (s.mode === 'offline') {
    const team = s.vault.kind === 'team';
    const expires = team ? vaultCopyExpiresAt(s.vault.id) : null;
    const synced = vaultSyncedAt(s.vault.id);
    const pending = pendingChanges(s.vault.id);
    return (
      <div className="banner warn">
        <CloudOff size={15} />
        <span>
          {team
            ? t('오프라인: 팀 볼트는 보기만 됩니다. 이 PC의 사본은 {date}까지 사용할 수 있습니다.', { date: expires ? day(expires) : '—' })
            : s.personalSync
              ? t('오프라인: 이 PC에 저장된 사본입니다(마지막 동기화 {time}). 수정한 것은 다시 연결되면 올립니다.', { time: synced ? timeAgo(synced) : '—' })
              : t('오프라인: 개인 볼트는 이 PC에만 두도록 되어 있어 그대로 사용할 수 있습니다.')}
          {pending > 0 && s.personalSync && ` ${t('올릴 변경 {count}개', { count: pending })}`}
        </span>
        <Button size="sm" onClick={s.reconnectNow}>
          <RefreshCw size={13} /> {t('다시 연결')}
        </Button>
      </div>
    );
  }
  if (s.vault.kind === 'personal' && !s.personalSync && s.offlineCapable)
    return (
      <div className="banner info">
        <HardDrive size={15} />
        <span>{t('개인 동기화가 꺼져 있어 개인 볼트는 이 PC에만 있습니다.')}</span>
        <Button size="sm" onClick={() => s.openSettings('offline')}>
          {t('설정')}
        </Button>
      </div>
    );
  return null;
}

// 위쪽 막대: 오프라인 · 임시 모드 표시 (누르면 바로 다시 연결해 본다)
export function NetPill() {
  const s = useStore();
  if (s.mode === 'online') return null;
  if (s.mode === 'local')
    return (
      <span className="net-pill" title={t('여기서 만든 것은 앱을 닫으면 사라집니다')}>
        <HardDrive size={13} /> {t('임시 모드')}
      </span>
    );
  return (
    <button className="net-pill" title={t('다시 연결')} onClick={s.reconnectNow}>
      <CloudOff size={13} /> {t('오프라인')}
    </button>
  );
}

// 설정 → 오프라인·동기화 (앱)
export function OfflinePage() {
  const s = useStore();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = pendingChanges();
  const audits = queuedAudits();

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) s.toast(done, 'success');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = (deleteServerCopy: boolean) => {
    setAsk(false);
    void run(
      () => s.setPersonalSync(false, deleteServerCopy),
      deleteServerCopy ? t('개인 볼트를 이 PC에만 두고 서버 사본을 지웠습니다.') : t('개인 볼트를 이 PC에만 둡니다. 서버 사본은 그대로 있습니다.'),
    );
  };

  return (
    <>
      <Card title={t('개인 볼트 동기화')}>
        <div className="setting-row">
          <span>{t('개인 볼트를 서버와 동기화')}</span>
          <Toggle
            checked={s.personalSync}
            label={t('개인 볼트를 서버와 동기화')}
            onChange={(on) => (on ? void run(() => s.setPersonalSync(true), t('개인 동기화를 켰습니다.')) : setAsk(true))}
          />
        </div>
        <p className="muted small">
          {s.personalSync
            ? t('다른 기기·웹에서도 같은 개인 볼트를 사용합니다. 서버에 연결할 수 없을 때는 이 PC의 사본으로 사용하고, 수정한 것은 다시 연결되면 올립니다.')
            : t('개인 볼트를 이 PC에만 둡니다. 서버에 올리지도 받지도 않고, 개인 볼트에서 한 접속 기록도 서버에 보내지 않습니다. 다시 켜면 서버의 것과 합칩니다.')}
        </p>
        {!s.personalSync && <p className="warn-text small">{t('로그아웃하면 이 PC의 개인 볼트가 지워집니다. 다른 기기에서 사용하려면 먼저 동기화를 켜 주세요.')}</p>}
      </Card>

      <Card title={t('이 PC의 오프라인 사본')}>
        <div className="setting-row">
          <span>
            {s.mode === 'online' ? t('서버에 연결됨') : t('오프라인')}
            {' · '}
            {t('마지막 동기화 {time}', { time: s.lastSync ? timeAgo(s.lastSync) : '—' })}
          </span>
          <Button size="sm" disabled={busy || s.mode !== 'online'} onClick={() => void run(() => s.syncNow(), t('서버와 맞췄습니다.'))}>
            <RefreshCw size={14} /> {t('지금 동기화')}
          </Button>
        </div>
        {(pending > 0 || audits > 0) && (
          <p className="small">
            {pending > 0 && <Badge tone="warn">{t('올릴 변경 {count}개', { count: pending })}</Badge>} {audits > 0 && <Badge>{t('올릴 접속 기록 {count}개', { count: audits })}</Badge>}
          </p>
        )}
        <ul className="plain-list offline-copies">
          {s.me.vaults.map((v) => {
            const expires = vaultCopyExpiresAt(v.id);
            return (
              <li key={v.id}>
                <span className="strong">{v.teamName ? `${v.teamName} · ${v.name}` : v.name}</span>
                <span className="muted small">
                  {v.kind === 'personal'
                    ? s.personalSync
                      ? t('늘 둡니다')
                      : t('이 PC에만')
                    : expires
                      ? t('{date}까지', { date: day(expires) })
                      : t('마지막 동기화부터 {days}일', { days: TEAM_OFFLINE_DAYS })}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="muted small">
          {t('서버에 연결할 수 없을 때 사용하려고, 볼트의 암호문을 이 PC에 한 번 더 암호화(Windows 보호 저장소)해서 둡니다. 팀 볼트는 오프라인에서 보기만 되고, 마지막 동기화부터 {days}일이 지나거나 팀에서 빠지면 지웁니다. 로그아웃하면 모두 지웁니다.', { days: TEAM_OFFLINE_DAYS })}
        </p>
      </Card>

      {ask && (
        <Modal
          title={t('개인 동기화 끄기')}
          onClose={() => setAsk(false)}
          width={500}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsk(false)}>
                {t('취소')}
              </Button>
              <Button disabled={busy} onClick={() => turnOff(false)}>
                {t('서버 사본은 두기')}
              </Button>
              <Button variant="danger" disabled={busy || s.mode !== 'online'} onClick={() => turnOff(true)}>
                {t('서버 사본도 지우기')}
              </Button>
            </>
          }
        >
          <p>{t('이제부터 개인 볼트를 이 PC에만 둡니다. 서버에 있는 개인 볼트 사본은 어떻게 할까요?')}</p>
          <ul className="plain-list small">
            <li>{t('두기: 다른 기기·웹에서는 지금까지의 개인 볼트가 그대로 보입니다(이 PC에서 수정한 것은 올라가지 않습니다).')}</li>
            <li>{t('지우기: 서버에서 개인 볼트의 항목을 모두 지웁니다. 다시 켜면 이 PC의 것을 올립니다.')}</li>
          </ul>
          <p className="warn-text small">{t('로그아웃하면 이 PC의 개인 볼트도 지워집니다.')}</p>
        </Modal>
      )}
    </>
  );
}
