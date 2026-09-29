// 포트 포워딩: 규칙은 볼트에 저장(웹에서도 편집), 실행은 데스크톱 앱에서만 (내 PC 의 포트를 열어야 하므로)
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRightLeft, Loader2, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { errorMessage, type Forward, type Host } from '../api';
import { t, tMsg } from '../i18n';
import { useStore } from '../store';
import { desktop } from '../desktop';
import { openSsh, type SshHandle } from '../connect';
import { vaultApi } from '../vault';
import { Badge, Button, EmptyState, Field, IconButton, Input, Select, SidePanel } from './ui';
import { ConnectPrompt, type PromptOverlay } from './ConnectPrompts';

type Run = { state: 'connecting' | 'listening' | 'error' | 'stopped'; message: string; connections: number; prompt: PromptOverlay | null; vaultId: string };
type Ctx = { runs: Record<string, Run>; start: (rule: Forward, host: Host | undefined) => void; stop: (ruleId: string) => void };
const ForwardCtx = createContext<Ctx | null>(null);

export const useForwards = () => useContext(ForwardCtx)!;

export function ForwardProvider({ children }: { children: ReactNode }) {
  const s = useStore();
  const [runs, setRuns] = useState<Record<string, Run>>({});
  // 규칙마다 SSH 연결 하나 (PC → 서버 직접)
  const conns = useRef(new Map<string, { handle: SshHandle | null; abort: AbortController }>());
  const answers = useRef(new Map<string, (msg: Record<string, unknown> | null) => void>());
  const patch = useCallback((id: string, p: Partial<Run>) => setRuns((r) => (r[id] ? { ...r, [id]: { ...r[id], ...p } } : r)), []);

  useEffect(
    () =>
      desktop?.forward.onStatus((st) =>
        patch(st.ruleId, { connections: st.connections, ...(st.state === 'error' ? { state: 'error', message: tMsg(st.message ?? '') } : {}) }),
      ),
    [patch],
  );

  const stop = useCallback(
    (ruleId: string) => {
      const c = conns.current.get(ruleId);
      conns.current.delete(ruleId);
      c?.abort.abort();
      answers.current.get(ruleId)?.(null);
      answers.current.delete(ruleId);
      void desktop?.forward.stop(ruleId);
      c?.handle?.close();
      patch(ruleId, { state: 'stopped', message: '', prompt: null, connections: 0 });
    },
    [patch],
  );

  const start = useCallback(
    (rule: Forward, host: Host | undefined) => {
      if (!desktop) return s.toast(t('포트 포워딩은 데스크톱 앱에서 실행할 수 있습니다.'), 'error');
      if (conns.current.has(rule.id)) return;
      const abort = new AbortController();
      conns.current.set(rule.id, { handle: null, abort });
      setRuns((r) => ({ ...r, [rule.id]: { state: 'connecting', message: t('{host}에 연결하는 중…', { host: host?.label || host?.address || '' }), connections: 0, prompt: null, vaultId: rule.vaultId } }));
      const ask = (p: PromptOverlay) =>
        new Promise<Record<string, unknown> | null>((resolve) => {
          answers.current.set(rule.id, resolve);
          patch(rule.id, { prompt: p });
        });
      const fail = (message: string) => {
        conns.current.delete(rule.id);
        setRuns((r) => (r[rule.id] && r[rule.id].state !== 'stopped' ? { ...r, [rule.id]: { ...r[rule.id], state: 'error', message, prompt: null } } : r));
      };
      const canEdit = s.me.vaults.find((v) => v.id === rule.vaultId)?.perm === 'edit';
      openSsh(rule.hostId, 'forward', { ask, notify: (p) => patch(rule.id, { prompt: p }), warn: (m) => s.toast(m, 'error'), canEdit }, { signal: abort.signal }).then(
        async (handle) => {
          const c = conns.current.get(rule.id);
          if (!c || abort.signal.aborted) return handle.close();
          c.handle = handle;
          handle.onClose((message) => fail(tMsg(message)));
          try {
            await desktop!.forward.start({ ruleId: rule.id, connId: handle.id, bindAddress: rule.bindAddress, localPort: rule.localPort, remoteHost: rule.remoteHost, remotePort: rule.remotePort });
            patch(rule.id, { state: 'listening', message: t('{address}:{port}에서 받는 중', { address: rule.bindAddress, port: rule.localPort }), prompt: null });
          } catch (err) {
            handle.close();
            fail(errorMessage(err));
          }
        },
        (err: Error) => {
          if (!abort.signal.aborted) fail(tMsg(err.message));
        },
      );
    },
    [patch, s],
  );

  const prompting = Object.entries(runs).find(([, r]) => r.prompt);

  return (
    <ForwardCtx.Provider value={{ runs, start, stop }}>
      {children}
      {prompting && (
        <div className="floating-prompt">
          <ConnectPrompt
            overlay={prompting[1].prompt!}
            vaultId={prompting[1].vaultId}
            reply={(m) => {
              const r = answers.current.get(prompting[0]);
              answers.current.delete(prompting[0]);
              r?.(m);
            }}
            dismiss={() => patch(prompting[0], { prompt: null })}
            reconnect={() => stop(prompting[0])}
          />
        </div>
      )}
    </ForwardCtx.Provider>
  );
}

export function ForwardingView() {
  const s = useStore();
  const { runs, start, stop } = useForwards();
  const canEdit = s.vault.perm === 'edit';
  const [panel, setPanel] = useState<{ rule?: Forward } | null>(null);
  useEffect(() => setPanel(null), [s.vault.id]);
  const forwards = s.items.forwards;
  const hostOf = (id: string) => s.items.hosts.find((h) => h.id === id);

  return (
    <>
      <div className="view">
        <div className="toolbar">
          {canEdit && (
            <Button size="sm" onClick={() => setPanel({})}>
              <Plus size={15} /> {t('새 포워딩')}
            </Button>
          )}
          {!desktop && <span className="toolbar-note">{t('규칙은 여기서 만들고, 실행은 데스크톱 앱에서 합니다(내 PC의 포트를 열어야 해서).')}</span>}
        </div>
        {!s.itemsLoading && forwards.length === 0 ? (
          <EmptyState icon={<ArrowRightLeft size={22} />} title={t('포트 포워딩 설정')} text={t('서버 뒤에 있는 데이터베이스·웹 화면 같은 서비스를 내 PC의 포트로 불러와 사용해 주세요.')}>
            {canEdit && (
              <Button variant="primary" onClick={() => setPanel({})}>
                {t('새 포워딩')}
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="view-content">
            <section>
              <h2 className="section-title">{t('포트 포워딩')}</h2>
              <div className={`cards ${s.prefs.view}`}>
                {forwards.map((f) => {
                  const run = runs[f.id];
                  const on = run && (run.state === 'listening' || run.state === 'connecting');
                  const host = hostOf(f.hostId);
                  return (
                    <div key={f.id} className={`item-card forward ${panel?.rule?.id === f.id ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => setPanel({ rule: f })}>
                      <div className={`item-icon forward-icon ${run?.state ?? ''}`}>
                        <ArrowRightLeft size={17} />
                      </div>
                      <div className="item-text">
                        <div className="item-title">{f.label || `localhost:${f.localPort}`}</div>
                        <div className="item-sub">
                          {f.bindAddress === '127.0.0.1' ? 'localhost' : f.bindAddress}:{f.localPort} → {f.remoteHost}:{f.remotePort} · {host?.label || host?.address || t('호스트 없음')}
                        </div>
                        {run && run.state !== 'stopped' && (
                          <div className={`forward-status ${run.state}`}>
                            {run.state === 'connecting' && <Loader2 size={12} className="spin" />}
                            {run.state === 'listening' ? (run.connections ? t('실행 중 · 연결 {count}개', { count: run.connections }) : t('실행 중')) : run.message}
                          </div>
                        )}
                      </div>
                      {desktop ? (
                        <button
                          className={`forward-toggle ${on ? 'on' : ''}`}
                          aria-label={on ? t('멈추기') : t('시작')}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (on) stop(f.id);
                            else start(f, host);
                          }}
                        >
                          {on ? <Square size={13} /> : <Play size={13} />}
                        </button>
                      ) : (
                        <Badge>{t('앱에서 실행')}</Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>
      {panel && <ForwardEditor key={panel.rule?.id ?? 'new'} rule={panel.rule} onClose={() => setPanel(null)} />}
    </>
  );
}

function ForwardEditor({ rule, onClose }: { rule?: Forward; onClose: () => void }) {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const { runs, stop } = useForwards();
  const [label, setLabel] = useState(rule?.label ?? '');
  const [hostId, setHostId] = useState(rule?.hostId ?? s.items.hosts[0]?.id ?? '');
  const [bindAddress, setBind] = useState(rule?.bindAddress ?? '127.0.0.1');
  const [localPort, setLocalPort] = useState(String(rule?.localPort ?? ''));
  const [remoteHost, setRemoteHost] = useState(rule?.remoteHost ?? '127.0.0.1');
  const [remotePort, setRemotePort] = useState(String(rule?.remotePort ?? ''));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = { label, hostId, bindAddress, localPort: Number(localPort), remoteHost, remotePort: Number(remotePort) };
      if (rule) await vaultApi.updateForward(rule.id, payload);
      else await vaultApi.createForward(s.vault.id, payload);
      if (rule && runs[rule.id]?.state === 'listening') {
        stop(rule.id);
        s.toast(t('규칙이 바뀌어 실행 중이던 포워딩을 멈췄습니다. 다시 시작해 주세요.'));
      }
      await s.reloadItems();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rule || !(await s.confirm({ title: t('포워딩 삭제'), message: t('이 포트 포워딩 규칙을 지웁니다.'), confirmLabel: t('삭제'), danger: true }))) return;
    try {
      stop(rule.id);
      await vaultApi.deleteForward(rule.id);
      await s.reloadItems();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 5);

  return (
    <SidePanel
      title={rule ? t('포트 포워딩') : t('새 포트 포워딩')}
      onClose={onClose}
      actions={
        rule &&
        canEdit && (
          <IconButton label={t('삭제')} onClick={() => void remove()}>
            <Trash2 size={15} />
          </IconButton>
        )
      }
      footer={
        canEdit && (
          <Button variant="primary" loading={busy} onClick={() => void save()} disabled={!hostId || !localPort || !remotePort || !remoteHost.trim()}>
            {t('저장')}
          </Button>
        )
      }
    >
      <div className="panel-section">
        <h4>{t('일반')}</h4>
        <Input placeholder={t('이름(예: 운영 DB)')} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} />
        <Field label={t('거쳐 갈 호스트')}>
          <Select value={hostId} onChange={(e) => setHostId(e.target.value)} disabled={!canEdit}>
            {s.items.hosts.length === 0 && <option value="">{t('이 볼트에 호스트가 없습니다')}</option>}
            {s.items.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label || h.address}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="panel-section">
        <h4>{t('내 PC')}</h4>
        <div className="forward-row">
          <Select value={bindAddress} onChange={(e) => setBind(e.target.value)} disabled={!canEdit} aria-label={t('묶을 주소')}>
            <option value="127.0.0.1">{t('127.0.0.1(나만)')}</option>
            <option value="0.0.0.0">{t('0.0.0.0(같은 망 모두)')}</option>
            <option value="::1">::1</option>
          </Select>
          <Input placeholder={t('포트')} inputMode="numeric" value={localPort} onChange={(e) => setLocalPort(digits(e.target.value))} disabled={!canEdit} />
        </div>
        {bindAddress === '0.0.0.0' && <p className="panel-hint">{t('같은 네트워크의 다른 사람도 이 포트로 들어올 수 있습니다. 꼭 필요할 때만 사용해 주세요.')}</p>}
      </div>
      <div className="panel-section">
        <h4>{t('호스트에서 본 대상')}</h4>
        <div className="forward-row">
          <Input placeholder="127.0.0.1" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} disabled={!canEdit} />
          <Input placeholder={t('포트')} inputMode="numeric" value={remotePort} onChange={(e) => setRemotePort(digits(e.target.value))} disabled={!canEdit} />
        </div>
        <p className="panel-hint">{t('호스트에 접속한 다음 해당 서버 입장에서 이 주소로 이어 줍니다. 예: DB가 같은 서버에 있으면 127.0.0.1:5432.')}</p>
      </div>
    </SidePanel>
  );
}
