// 팀 관리자: 볼트를 볼 권한은 있는데 아직 볼트 키를 못 받은 팀원에게 키를 봉해서 건넨다.
// 서버는 키를 못 만든다 — 키를 가진 관리자의 앱·웹이 그 사람 공개키로 봉해서 올린다.
import { useEffect, useState } from 'react';
import { KeyRound, TriangleAlert, UserPlus } from 'lucide-react';
import { errorMessage, type PendingInvite, type PendingShare } from '../api';
import { useStore } from '../store';
import { keyFingerprint } from '../e2ee';
import { peerKeyChanged, peerKnown, shareVaultKeys } from '../vault';
import { Badge, Button, Modal } from './ui';
import { t } from '../i18n';

export function ShareBanner() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const people = new Set(s.pendingShares.map((p) => p.userId)).size;
  if (!s.pendingShares.length) return null;
  return (
    <>
      <div className="banner info">
        <KeyRound size={15} />
        <span>{t('팀원 {count}명이 볼트 키를 기다립니다. 확인하면 해당 팀원의 앱에서 볼트가 열립니다.', { count: people })}</span>
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          {t('확인하고 공유')}
        </Button>
      </div>
      {open && <ShareDialog list={s.pendingShares} onClose={() => setOpen(false)} />}
    </>
  );
}

// 내게 온 팀 초대: 수락해야 팀에 들어간다 (서버 API 3~)
export function InviteBanner() {
  const s = useStore();
  const [busy, setBusy] = useState('');
  const list = s.me.invites ?? [];
  if (!list.length) return null;
  const accept = async (inv: PendingInvite) => {
    let code: string | undefined;
    if (inv.needsCode) {
      const v = await s.askText({ title: t('초대 코드 입력'), label: t('팀 관리자에게 받은 초대 코드'), value: '', hint: 'XXXX-XXXX-XXXX', confirmLabel: t('수락') });
      if (!v) return;
      code = v;
    }
    setBusy(inv.id);
    try {
      await s.acceptInvite(inv, code);
    } finally {
      setBusy('');
    }
  };
  const decline = async (inv: PendingInvite) => {
    if (!(await s.confirm({ title: t('초대 거절'), message: t('{team} 팀의 초대를 거절합니다.', { team: inv.teamName }), confirmLabel: t('거절'), danger: true }))) return;
    setBusy(inv.id);
    try {
      await s.declineInvite(inv);
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      {list.map((inv) => (
        <div key={inv.id} className="banner info">
          <UserPlus size={15} />
          <span>
            {inv.invitedBy
              ? t('{name}님이 {team} 팀에 초대했습니다.', { name: inv.invitedBy, team: inv.teamName })
              : t('{team} 팀에서 초대했습니다.', { team: inv.teamName })}
          </span>
          <Button size="sm" variant="ghost" disabled={busy === inv.id} onClick={() => void decline(inv)}>
            {t('거절')}
          </Button>
          <Button size="sm" variant="primary" loading={busy === inv.id} onClick={() => void accept(inv)}>
            {t('수락')}
          </Button>
        </div>
      ))}
    </>
  );
}

const key = (p: PendingShare) => `${p.vaultId}:${p.userId}`;

function ShareDialog({ list, onClose }: { list: PendingShare[]; onClose: () => void }) {
  const s = useStore();
  // 이 기기에서 전에 본(같은 공개키) 사람만 미리 고른다 — 처음 보는 사람은 키 지문을 맞춰 보고 직접 고른다
  // (서버가 끼워 넣은 가짜 팀원에게 볼트 키를 건네지 않게)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(list.filter((p) => peerKnown(p.userId, p.publicKey)).map(key)));
  const [prints, setPrints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all(list.map(async (p) => [p.userId, await keyFingerprint(p.publicKey)] as const)).then((pairs) => setPrints(Object.fromEntries(pairs)));
  }, [list]);

  const share = async () => {
    setBusy(true);
    try {
      const n = await shareVaultKeys(list.filter((p) => picked.has(key(p))));
      s.toast(t('볼트 키를 {count}건 공유했습니다.', { count: n }), 'success');
      await s.refreshPending();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('볼트 키 공유')}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('나중에')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!picked.size} onClick={() => void share()}>
            {t('{count}건 공유', { count: picked.size })}
          </Button>
        </>
      }
    >
      <p className="muted small share-intro">
        {t('공유하면 그 사람이 이 볼트의 호스트·비밀번호·키를 풀어 사용할 수 있습니다. 모르는 사람이거나 키 지문이 그 사람이 설정 화면에서 보는 것과 다르면 공유하지 마세요.')}
      </p>
      <ul className="share-list">
        {list.map((p) => {
          const changed = peerKeyChanged(p.userId, p.publicKey);
          const recent = p.keysCreatedAt && Date.now() - p.keysCreatedAt < 3 * 24 * 60 * 60 * 1000;
          return (
            <li key={key(p)}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.has(key(p))}
                  onChange={(e) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(key(p));
                      else next.delete(key(p));
                      return next;
                    })
                  }
                />
                <span className="share-who">
                  <span className="strong">{p.name || p.email}</span>
                  <span className="muted small">{p.email}</span>
                </span>
              </label>
              <span className="share-vault muted small">
                {p.teamName} · {p.vaultName}
              </span>
              <span className="share-fp">
                <code>{prints[p.userId] ?? '…'}</code>
                {changed && (
                  <Badge tone="warn">
                    <TriangleAlert size={11} /> {t('키가 바뀜')}
                  </Badge>
                )}
                {!changed && recent && <Badge>{t('최근 설정')}</Badge>}
              </span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
