import { useCallback, useEffect, useState } from 'react';
import { Braces, CloudOff, Fingerprint, History, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorMessage, type KnownHost, type LogEntry, type Snippet } from '../api';
import { t, tk, tMsg } from '../i18n';
import { useStore } from '../store';
import { knownHostsOf, openLabel, vaultApi } from '../vault';
import { Badge, Button, EmptyState, IconButton, Input, SidePanel, Textarea, formatTime, timeAgo } from './ui';
import { httpFailLabel } from './Http';

// 스니펫 줄 수 (끝의 빈 줄은 세지 않는다) — 첫 줄만 보고 숨은 줄까지 실행하지 않게 목록에 드러낸다
const snippetLines = (text: string) => text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;

export function SnippetsView() {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [panel, setPanel] = useState<{ snippet?: Snippet } | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => setPanel(null), [s.vault.id]);
  const q = query.trim().toLowerCase();
  const list = s.items.snippets.filter((x) => !q || x.label.toLowerCase().includes(q) || x.script.toLowerCase().includes(q));

  return (
    <>
      <div className="view">
        <div className="toolbar">
          {canEdit && (
            <Button size="sm" onClick={() => setPanel({})}>
              <Plus size={15} /> {t('새 스니펫')}
            </Button>
          )}
          <div className="toolbar-spacer" />
          <Input className="search-sm" placeholder={t('검색')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {!s.itemsLoading && s.items.snippets.length === 0 ? (
          <EmptyState icon={<Braces size={22} />} title={t('스니펫 만들기')} text={t('자주 사용하는 명령을 저장해 두고 터미널 오른쪽 패널에서 한 번에 입력해 주세요.')}>
            {canEdit && (
              <Button variant="primary" onClick={() => setPanel({})}>
                {t('새 스니펫')}
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="view-content">
            <section>
              <h2 className="section-title">{t('스니펫')}</h2>
              <div className={`cards ${s.prefs.view}`}>
                {list.map((x) => (
                  <div key={x.id} className={`item-card ${panel?.snippet?.id === x.id ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => setPanel({ snippet: x })}>
                    <div className="item-icon snippet">
                      <Braces size={16} />
                    </div>
                    <div className="item-text" title={x.script}>
                      <div className="item-title">
                        {x.label}
                        {snippetLines(x.script) > 1 && (
                          <>
                            {' '}
                            <Badge tone="warn">{t('{count}줄', { count: snippetLines(x.script) })}</Badge>
                          </>
                        )}
                      </div>
                      <div className="item-sub mono">{x.script.split('\n')[0] || t('(비어 있음)')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
      {panel && <SnippetEditor key={panel.snippet?.id ?? 'new'} snippet={panel.snippet} onClose={() => setPanel(null)} />}
    </>
  );
}

function SnippetEditor({ snippet, onClose }: { snippet?: Snippet; onClose: () => void }) {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [label, setLabel] = useState(snippet?.label ?? '');
  const [script, setScript] = useState(snippet?.script ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (snippet) await vaultApi.updateSnippet(snippet.id, { label, script });
      else await vaultApi.createSnippet(s.vault.id, { label, script });
      await s.reloadItems();
      s.toast(t('저장했습니다'), 'success');
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!snippet || !(await s.confirm({ title: t('스니펫 삭제'), message: t('"{name}"을(를) 지웁니다.', { name: snippet.label }), confirmLabel: t('삭제'), danger: true }))) return;
    try {
      await vaultApi.deleteSnippet(snippet.id);
      await s.reloadItems();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <SidePanel
      title={snippet ? t('스니펫') : t('새 스니펫')}
      onClose={onClose}
      footer={
        canEdit && (
          <>
            {snippet && (
              <Button variant="danger" onClick={() => void remove()}>
                {t('삭제')}
              </Button>
            )}
            <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void save()}>
              {t('저장')}
            </Button>
          </>
        )
      }
    >
      <div className="panel-section">
        <h4>{t('이름')}</h4>
        <Input placeholder={t('예: 디스크 사용량')} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} autoFocus />
      </div>
      <div className="panel-section">
        <h4>{t('명령')}</h4>
        <Textarea className="mono" rows={10} placeholder="df -h" value={script} onChange={(e) => setScript(e.target.value)} readOnly={!canEdit} spellCheck={false} />
      </div>
    </SidePanel>
  );
}

export function KnownHostsView() {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  // 서버 지문도 볼트 안에 암호화되어 있다 (서버가 몰래 바꿔 넣을 수 없게)
  const [list, setList] = useState<KnownHost[] | null>(null);
  useEffect(() => setList(knownHostsOf(s.vault.id)), [s.vault.id, s.items]);
  const load = () => void s.reloadItems();

  const remove = async (k: KnownHost) => {
    const ok = await s.confirm({
      title: t('알려진 호스트 삭제'),
      message: t('{host}:{port}의 저장된 서버 지문을 지웁니다. 다음 접속 때 새 지문을 다시 확인하게 됩니다. 서버를 다시 설치해 지문이 바뀐 게 확실할 때만 지워 주세요.', { host: k.address, port: k.port }),
      confirmLabel: t('삭제'),
      danger: true,
    });
    if (!ok) return;
    try {
      await vaultApi.deleteKnownHost(k.id);
      setList(knownHostsOf(s.vault.id));
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="view">
      <div className="toolbar">
        <span className="toolbar-note">{t('처음 접속할 때 확인한 서버 지문입니다. 지문이 바뀌면 접속이 차단됩니다.')}</span>
        <div className="toolbar-spacer" />
        <IconButton label={t('새로고침')} onClick={load}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      {list && list.length === 0 ? (
        <EmptyState icon={<Fingerprint size={22} />} title={t('알려진 호스트가 여기에 나타납니다')} text={t('서버에 처음 접속할 때 지문을 확인하고 신뢰하면 이곳에 저장됩니다.')} />
      ) : (
        <div className="view-content">
          <table className="table">
            <thead>
              <tr>
                <th>{t('주소')}</th>
                <th>{t('종류')}</th>
                <th>{t('지문')}</th>
                <th>{t('추가')}</th>
                <th aria-label={t('작업')} />
              </tr>
            </thead>
            <tbody>
              {(list ?? []).map((k) => (
                <tr key={k.id}>
                  <td className="strong">
                    {k.address}
                    <span className="muted">:{k.port}</span>
                  </td>
                  <td>{k.keyType}</td>
                  <td>
                    <code className="fingerprint">{k.fingerprint}</code>
                  </td>
                  <td className="muted" title={formatTime(k.createdAt)}>
                    {k.addedBy ?? '—'} · {timeAgo(k.createdAt)}
                  </td>
                  <td className="actions">
                    {canEdit && (
                      <IconButton label={t('삭제')} onClick={() => void remove(k)}>
                        <Trash2 size={14} />
                      </IconButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ACTIONS: Record<string, [string, 'default' | 'accent' | 'warn' | 'danger' | 'ok']> = {
  login: [tk('로그인'), 'default'],
  logout: [tk('로그아웃'), 'default'],
  login_rejected: [tk('로그인 거절'), 'danger'],
  mfa_enable: [tk('2단계 인증 켬'), 'accent'],
  mfa_disable: [tk('2단계 인증 끔'), 'warn'],
  mfa_verify: [tk('2단계 인증 통과'), 'default'],
  mfa_fail: [tk('2단계 인증 실패'), 'danger'],
  mfa_recovery_new: [tk('복구 코드 새로 만듦'), 'default'],
  mfa_reset: [tk('2단계 인증 초기화(서버 관리자)'), 'warn'],
  password_set: [tk('로그인 비밀번호 정함'), 'accent'],
  password_change: [tk('로그인 비밀번호 바꿈'), 'warn'],
  invite_code: [tk('초대 코드 새로 만듦'), 'default'],
  team_create: [tk('팀 만듦'), 'accent'],
  team_rename: [tk('팀 이름 변경'), 'default'],
  team_offline: [tk('오프라인 사용 기간 변경'), 'warn'],
  team_delete: [tk('팀 삭제'), 'danger'],
  invite_create: [tk('초대'), 'accent'],
  invite_delete: [tk('초대 취소'), 'default'],
  invite_accept: [tk('초대 수락'), 'accent'],
  member_add: [tk('팀원 추가'), 'accent'],
  member_role: [tk('역할 변경'), 'warn'],
  member_remove: [tk('팀원 내보냄'), 'warn'],
  vault_create: [tk('볼트 만듦'), 'accent'],
  vault_rename: [tk('볼트 이름 변경'), 'default'],
  vault_delete: [tk('볼트 삭제'), 'danger'],
  vault_member_set: [tk('볼트 권한 변경'), 'warn'],
  vault_clear: [tk('서버 사본 비움'), 'warn'],
  group_create: [tk('그룹 만듦'), 'default'],
  group_update: [tk('그룹 수정'), 'default'],
  group_delete: [tk('그룹 삭제'), 'default'],
  host_create: [tk('호스트 만듦'), 'default'],
  host_update: [tk('호스트 수정'), 'default'],
  host_delete: [tk('호스트 삭제'), 'warn'],
  key_create: [tk('키 추가'), 'default'],
  key_update: [tk('키 수정'), 'default'],
  key_delete: [tk('키 삭제'), 'warn'],
  identity_create: [tk('계정 프리셋 추가'), 'default'],
  identity_update: [tk('계정 프리셋 수정'), 'default'],
  identity_delete: [tk('계정 프리셋 삭제'), 'warn'],
  snippet_create: [tk('스니펫 추가'), 'default'],
  snippet_update: [tk('스니펫 수정'), 'default'],
  snippet_delete: [tk('스니펫 삭제'), 'default'],
  ssh_connect: [tk('접속'), 'ok'],
  ssh_disconnect: [tk('접속 종료'), 'default'],
  ssh_error: [tk('접속 실패'), 'danger'],
  hostkey_trust: [tk('서버 지문 신뢰'), 'accent'],
  hostkey_mismatch: [tk('서버 지문 불일치'), 'danger'],
  knownhost_delete: [tk('지문 삭제'), 'warn'],
  sftp_connect: [tk('SFTP 접속'), 'ok'],
  sftp_disconnect: [tk('SFTP 종료'), 'default'],
  sftp_upload: [tk('파일 올림'), 'accent'],
  sftp_download: [tk('파일 받음'), 'default'],
  sftp_copy: [tk('파일 복사'), 'accent'],
  sftp_mkdir: [tk('폴더 만듦'), 'default'],
  sftp_rename: [tk('이름 바꿈'), 'default'],
  sftp_delete: [tk('파일 삭제'), 'warn'],
  sftp_chmod: [tk('권한 바꿈'), 'warn'],
  forward_start: [tk('포트 포워딩 시작'), 'accent'],
  forward_stop: [tk('포트 포워딩 끝'), 'default'],
  forward_create: [tk('포워딩 규칙 만듦'), 'default'],
  forward_update: [tk('포워딩 규칙 수정'), 'default'],
  forward_delete: [tk('포워딩 규칙 삭제'), 'warn'],
  http_request: [tk('HTTP 요청'), 'accent'],
  request_create: [tk('HTTP 요청 저장'), 'default'],
  request_update: [tk('HTTP 요청 수정'), 'default'],
  request_delete: [tk('HTTP 요청 삭제'), 'warn'],
  httpenv_create: [tk('HTTP 환경 만듦'), 'default'],
  httpenv_update: [tk('HTTP 환경 수정'), 'default'],
  httpenv_delete: [tk('HTTP 환경 삭제'), 'warn'],
  hostcred_create: [tk('내 계정 프리셋 연결'), 'default'],
  hostcred_update: [tk('내 계정 프리셋 연결'), 'default'],
  hostcred_delete: [tk('내 계정 프리셋 해제'), 'default'],
  vault_key_init: [tk('볼트 키 만듦'), 'accent'],
  vault_key_share: [tk('볼트 키 공유'), 'accent'],
  keys_setup: [tk('암호화 설정'), 'accent'],
  keys_password: [tk('암호화 비밀번호 변경'), 'warn'],
  keys_recovered: [tk('복구 키로 되살림'), 'warn'],
  keys_new_recovery: [tk('복구 키 새로 받음'), 'default'],
  keys_reset: [tk('암호화 초기화'), 'danger'],
};

function bytes(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function duration(sec: number) {
  if (sec < 60) return t('{seconds}초', { seconds: sec });
  if (sec < 3600) return t('{minutes}분 {seconds}초', { minutes: Math.floor(sec / 60), seconds: sec % 60 });
  return t('{hours}시간 {minutes}분', { hours: Math.floor(sec / 3600), minutes: Math.floor((sec % 3600) / 60) });
}

const SSH_ERROR_LABELS: Record<string, string> = {
  auth_failed: tk('인증 실패'),
  host_key_mismatch: tk('서버 지문 불일치'),
  host_key_rejected: tk('서버 지문을 신뢰하지 않음'),
  host_key_type: tk('다른 종류의 호스트 키'),
  timeout: tk('시간 초과'),
  refused: tk('연결 거부'),
  dns: tk('주소를 찾을 수 없음'),
  unreachable: tk('닿을 수 없음'),
  reset: tk('연결이 끊김'),
  closed: tk('서버가 연결을 닫음'),
  cancelled: tk('취소'),
  relay: tk('중계 오류'),
  key_error: tk('키 오류'),
  no_sftp: tk('SFTP 미지원'),
  negotiation: tk('암호 방식 협상 실패'),
  other: tk('기타 오류'),
};

function detailText(e: Pick<LogEntry, 'action' | 'detail'>) {
  const d = e.detail as Record<string, unknown>;
  switch (e.action) {
    case 'login': {
      // 어떤 방법으로 들어왔는지 (google·desktop = Google, password·invite = 아이디·비밀번호)
      const via = String(d.via ?? '');
      return via.startsWith('password') ? t('아이디·비밀번호') : via.startsWith('invite') ? t('초대 코드로 가입') : via === 'google' || via === 'desktop' ? 'Google' : '';
    }
    case 'password_set':
    case 'password_change':
      return d.by === 'server-admin' ? t('서버 관리자 명령') : d.by === 'env' ? t('서버 설정(env)') : '';
    case 'ssh_connect':
      return d.username ? t('{user} 계정', { user: String(d.username) }) : '';
    case 'ssh_disconnect':
      return d.bytesIn === undefined ? duration(Number(d.seconds) || 0) : t('{duration} · 입력 {input} · 출력 {output}', { duration: duration(Number(d.seconds) || 0), input: bytes(Number(d.bytesIn) || 0), output: bytes(Number(d.bytesOut) || 0) });
    case 'ssh_error': {
      // 새 앱은 오류 종류(코드)만 알린다 — 주소가 섞인 오류 문구를 서버에 남기지 않게. 예전 기록은 문구 그대로
      const reason = String(d.error ?? d.reason ?? '');
      return SSH_ERROR_LABELS[reason] ? t(SSH_ERROR_LABELS[reason]) : tMsg(reason);
    }
    case 'member_role':
      return `${d.from} → ${d.to}`;
    case 'vault_member_set':
      return d.permission === 'edit' ? t('편집 가능') : d.permission === 'view' ? t('보기 전용') : t('권한 없음');
    case 'invite_create':
    case 'member_add':
      return String(d.role ?? '');
    case 'login_rejected':
      return String(d.reason ?? '');
    case 'hostkey_trust':
      return String(d.fingerprint ?? '');
    case 'hostkey_mismatch':
      return d.expected ? t('예상 {expected} / 받은 {got}', { expected: String(d.expected), got: String(d.got) }) : '';
    case 'sftp_upload':
    case 'sftp_download':
      return `${d.host ?? ''} · ${bytes(Number(d.bytes) || 0)}`;
    case 'sftp_copy':
      return t('{from} → {host} · {count}개 · {size}', { from: String(d.from), host: String(d.host), count: Number(d.files) || 0, size: bytes(Number(d.bytes) || 0) });
    case 'sftp_rename':
      return `${d.host ?? ''} → ${d.to}`;
    case 'sftp_chmod':
      return `${d.host ?? ''} · ${d.mode}`;
    case 'sftp_mkdir':
    case 'sftp_delete':
      return String(d.host ?? '');
    case 'sftp_disconnect':
      return duration(Number(d.seconds) || 0);
    case 'vault_key_share':
      return '';
    case 'forward_start':
    case 'forward_stop':
      return d.route ? String(d.route) : d.seconds !== undefined ? duration(Number(d.seconds) || 0) : '';
    case 'http_request':
      // 서버에는 응답 코드·걸린 시간·실패 종류만 (메서드·주소는 볼트 키로 암호화된 '대상')
      return d.fail ? `${httpFailLabel(String(d.fail))} · ${Number(d.ms) || 0} ms` : `${Number(d.status) || 0} · ${Number(d.ms) || 0} ms`;
    case 'host_update':
      return Array.isArray(d.fields) ? `${(d.fields as string[]).join(', ')}` : '';
    case 'team_offline': {
      const days = (n: unknown) => (Number(n) ? t('{days}일', { days: Number(n) }) : t('사용하지 않음'));
      return `${days(d.from)} → ${days(d.to)}`;
    }
    case 'vault_clear':
      return t('항목 {count}개', { count: Number(d.items) || 0 });
    default:
      return '';
  }
}

export function LogsView() {
  const s = useStore();
  const [list, setList] = useState<LogEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const load = useCallback(
    async (before?: number) => {
      if (s.mode !== 'online') return setList(null);
      try {
        const raw = await api.get<LogEntry[]>(`/api/vaults/${s.vault.id}/logs${before ? `?before=${before}` : ''}`);
        // 대상 이름(호스트 별칭 등)은 볼트 키로 암호화되어 온다
        const next = await Promise.all(
          raw.map(async (e) => {
            if (!e.targetEnc) return e;
            // 이름은 그 기록이 가리키는 항목·호스트에 묶여 있다 (서버가 다른 기록의 이름과 바꿔치기하지 못하게)
            const d = (e.detail ?? {}) as Record<string, unknown>;
            const ref = typeof d.id === 'string' ? d.id : typeof d.hostId === 'string' ? d.hostId : null;
            return { ...e, target: (await openLabel(s.vault.id, e.targetEnc, ref)) ?? t('(풀 수 없음)') };
          }),
        );
        setList((cur) => (before && cur ? [...cur, ...next] : next));
        setMore(next.length === 200);
      } catch (err) {
        s.toast(errorMessage(err), 'error');
      }
    },
    [s.vault.id, s.mode], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  // 기록은 서버에만 있다
  if (s.mode !== 'online')
    return (
      <div className="view">
        <EmptyState
          icon={<CloudOff size={22} />}
          title={t('오프라인에서는 기록을 볼 수 없습니다')}
          text={s.mode === 'local' ? t('임시 모드에서 한 접속은 기록하지 않습니다.') : t('이 PC에서 한 접속은 모아 두었다가 다시 연결되면 서버에 올립니다.')}
        />
      </div>
    );

  return (
    <div className="view">
      <div className="toolbar">
        <span className="toolbar-note">{s.vault.perm === 'edit' ? t('이 볼트에서 일어난 접속과 변경 기록입니다.') : t('이 볼트에서 내가 한 접속 기록입니다.')}</span>
        <div className="toolbar-spacer" />
        <IconButton label={t('새로고침')} onClick={() => void load()}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      {list && list.length === 0 ? (
        <EmptyState icon={<History size={22} />} title={t('아직 기록이 없습니다')} text={t('호스트에 접속하거나 볼트를 바꾸면 여기에 남습니다.')} />
      ) : (
        <div className="view-content">
          <table className="table logs">
            <thead>
              <tr>
                <th>{t('시각')}</th>
                <th>{t('사람')}</th>
                <th>{t('동작')}</th>
                <th>{t('대상')}</th>
                <th>{t('내용')}</th>
              </tr>
            </thead>
            <tbody>
              {(list ?? []).map((e) => {
                const [labelKey, tone] = ACTIONS[e.action] ?? [e.action, 'default'];
                // 모르는 동작 코드는 코드 그대로
                const label = ACTIONS[e.action] ? t(labelKey) : labelKey;
                // 오프라인일 때 한 일: 실제로 한 때(앱 시계)를 보이고, 서버에 올라온 때는 풀이로
                const offlineAt = typeof e.detail.offlineAt === 'number' ? e.detail.offlineAt : null;
                return (
                  <tr key={e.id}>
                    <td className="muted nowrap" title={offlineAt ? t('오프라인일 때 한 일 · 서버에 올린 시각 {time}', { time: formatTime(e.ts) }) : formatTime(e.ts)}>
                      {formatTime(offlineAt ?? e.ts)}
                      {offlineAt && <CloudOff size={12} className="log-offline" />}
                    </td>
                    <td className="nowrap" title={e.userEmail ?? ''}>
                      {e.userName || e.userEmail || '—'}
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td className="strong">{e.target}</td>
                    <td className="muted detail">{detailText(e)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {more && (
            <div className="load-more">
              <Button size="sm" onClick={() => list && void load(list[list.length - 1].id)}>
                {t('더 보기')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
