import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { Braces, Loader2, Minus, Palette, PanelRight, Play, Plus, RotateCw, Server, SquareTerminal, X } from 'lucide-react';
import type { Snippet } from '../api';
import { useStore, type TerminalTab } from '../store';
import { TERM_THEMES, termTheme } from '../themes';
import { desktop } from '../desktop';
import { openSsh, type SshHandle } from '../connect';
import { ensureLoaded, itemsOf, vaultApi } from '../vault';
import { Badge, Button, IconButton, colorFor } from './ui';
import { applyRenderer } from '../term-renderer';
import { ConnectPrompt, type PromptOverlay } from './ConnectPrompts';
import { HostGlyph } from './OsIcon';
import { osOf } from '../os-detect';
import { t, tMsg } from '../i18n';

// 원격(앱이 PC 에서 직접 여는 SSH)과 로컬(앱의 pty) 을 같은 모양으로 다룬다
type Transport = { send: (data: string) => void; resize: (cols: number, rows: number) => void; close: () => void };

// ---------- 붙여넣기 정리 ----------
// 붙여 넣는 글(클립보드·스니펫)에서 제어 문자를 뺀다 (보안 검토 낮음 항목). ESC 가 섞이면 "ESC[201~" 로
// 괄호 붙여넣기를 일찍 닫아 뒤의 줄을 바로 실행시키거나, 화면에 안 보이게 명령을 숨길 수 있다. 탭·줄바꿈만 남긴다
function cleanPaste(text: string) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
// 스니펫 줄 수 (끝의 빈 줄은 세지 않는다)
const lineCount = (text: string) => text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
// ---------- 붙여넣기 정리 끝 ----------

export function TerminalView({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const transport = useRef<Transport | null>(null);
  const [overlay, setOverlay] = useState<PromptOverlay | null>(null);
  const answer = useRef<((msg: Record<string, unknown> | null) => void) | null>(null);
  const [status, setStatus] = useState<{ state: 'connecting' | 'connected' | 'closed'; message: string }>({ state: 'connecting', message: '' });
  const [side, setSide] = useState<null | 'snippets' | 'theme'>(null);
  const host = s.items.hosts.find((h) => h.id === tab.hostId);

  const fit = () => {
    try {
      fitRef.current?.fit();
    } catch {}
  };

  // 터미널은 탭이 살아 있는 동안 하나만 만든다
  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", "D2Coding", "Cascadia Mono", Consolas, monospace',
      fontSize: s.prefs.fontSize,
      theme: termTheme(s.prefs.themeId).theme,
      cursorBlink: s.prefs.cursorBlink,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
    t.open(box.current!);
    // 그래픽 카드가 있으면 WebGL 로 그린다 (term-renderer.ts)
    applyRenderer(t, 'auto');
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        const sel = t.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (e.code === 'KeyV') {
        void navigator.clipboard.readText().then((text) => t.paste(cleanPaste(text)), () => {});
        return false;
      }
      return true;
    });
    // Ctrl+V·오른쪽 클릭 붙여넣기도 xterm 보다 먼저 받아 제어 문자를 뺀 뒤 xterm 의 붙여넣기(셸이 켰으면 괄호 붙여넣기)로 보낸다
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      e.stopImmediatePropagation();
      if (text) t.paste(cleanPaste(text));
    };
    const boxEl = box.current!;
    boxEl.addEventListener('paste', onPaste, true);
    t.onData((d) => transport.current?.send(d));
    t.onResize(({ cols, rows }) => transport.current?.resize(cols, rows));
    termRef.current = t;
    fitRef.current = fitAddon;
    const ro = new ResizeObserver(() => {
      if (box.current?.offsetParent) fit();
    });
    ro.observe(box.current!);
    return () => {
      ro.disconnect();
      boxEl.removeEventListener('paste', onPaste, true);
      t.dispose();
      termRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = s.prefs.fontSize;
    t.options.theme = termTheme(s.prefs.themeId).theme;
    t.options.cursorBlink = s.prefs.cursorBlink;
    requestAnimationFrame(fit);
  }, [s.prefs.fontSize, s.prefs.themeId, s.prefs.cursorBlink]);

  const setState = (state: 'connecting' | 'connected' | 'closed', message = '') => {
    setStatus({ state, message });
    s.setTabState(tab.id, state);
  };

  // 연결 (다시 연결하면 seq 가 올라간다)
  useEffect(() => {
    const term = termRef.current!;
    fit();
    if (tab.seq > 0) term.write(`\r\n\x1b[2m── ${t('다시 연결')} ──\x1b[0m\r\n`);
    setOverlay(null);
    answer.current = null;
    setState('connecting');
    return tab.mode === 'local' ? connectLocal(term) : connectRemote(term);
  }, [tab.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  function connectRemote(t: Terminal) {
    const ac = new AbortController();
    let conn: SshHandle | null = null;
    const offs: (() => void)[] = [];
    transport.current = {
      send: (d) => conn?.write(d),
      resize: (cols, rows) => conn?.resize(cols, rows),
      close: () => conn?.close(),
    };
    const ask = (p: PromptOverlay) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        answer.current = resolve;
        setOverlay(p);
      });
    openSsh(tab.hostId, 'shell', { ask, notify: setOverlay, warn: (m) => s.toast(m, 'error'), canEdit: s.me.vaults.find((v) => v.id === tab.vaultId)?.perm === 'edit' }, { cols: t.cols, rows: t.rows, signal: ac.signal }).then(
      (handle) => {
        if (ac.signal.aborted) return handle.close();
        conn = handle;
        offs.push(handle.onData((d) => t.write(d)));
        handle.onClose((message) => setState('closed', tMsg(message)));
        setState('connected');
        setOverlay((o) => (o?.kind === 'hostkey' && o.state === 'mismatch' ? o : null));
        requestAnimationFrame(() => {
          fit();
          handle.resize(t.cols, t.rows);
          t.focus();
        });
      },
      (err: Error) => {
        if (ac.signal.aborted) return;
        setOverlay((o) => (o?.kind === 'hostkey' && o.state === 'mismatch' ? o : null));
        setState('closed', tMsg(err.message));
      },
    );
    return () => {
      ac.abort();
      answer.current?.(null);
      offs.forEach((off) => off());
      conn?.close();
    };
  }

  function connectLocal(term: Terminal) {
    if (!desktop) {
      setState('closed', t('로컬 터미널은 데스크톱 앱에서만 열 수 있습니다.'));
      return () => {};
    }
    let id: string | null = null;
    let disposed = false;
    const offs: (() => void)[] = [];
    transport.current = {
      send: (d) => id && desktop!.pty.write(id, d),
      resize: (cols, rows) => id && desktop!.pty.resize(id, cols, rows),
      close: () => id && desktop!.pty.kill(id),
    };
    void desktop.pty.spawn({ cols: term.cols, rows: term.rows }).then(
      (res) => {
        if (disposed) return desktop!.pty.kill(res.id);
        id = res.id;
        offs.push(desktop!.pty.onData(res.id, (d) => term.write(d)));
        offs.push(desktop!.pty.onExit(res.id, (code) => setState('closed', t('셸이 종료되었습니다(코드 {code}).', { code }))));
        setState('connected', res.title);
        requestAnimationFrame(() => {
          fit();
          desktop!.pty.resize(res.id, term.cols, term.rows);
          term.focus();
        });
      },
      (err: Error) => setState('closed', t('셸을 열지 못했습니다: {error}', { error: tMsg(err.message) })),
    );
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      if (id) desktop!.pty.kill(id);
    };
  }

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fit();
      if (!overlay) termRef.current?.focus();
    });
  }, [visible, side]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = tab.mode === 'local' ? tab.title : host?.label || host?.address || tab.title;
  const theme = termTheme(s.prefs.themeId).theme;

  return (
    <div className="term-screen" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="term-wrap" style={{ background: theme.background }}>
        <div className="term-box" ref={box} />
        <IconButton label={t('사이드 패널')} className="term-side-toggle" onClick={() => setSide(side ? null : 'snippets')}>
          <PanelRight size={16} />
        </IconButton>

        {status.state === 'connecting' && !overlay && (
          <div className="term-overlay">
            <div className="term-dialog connecting">
              <div className="item-icon big" style={{ background: tab.mode === 'local' ? '#3b4460' : colorFor(tab.hostId) }}>
                {tab.mode === 'local' ? <SquareTerminal size={24} /> : <HostGlyph os={osOf({ id: tab.hostId, os: host?.os ?? vaultApi.hostOs(tab.hostId) })} size={24} />}
              </div>
              {/* 별칭이 있으면 별칭으로 "…에 연결하는 중" (주소는 보여 주지 않는다) */}
              <h3 className="connecting-title">
                <Loader2 size={16} className="spin" />
                {tab.mode === 'local' ? t('로컬 터미널을 여는 중…') : t('{name}에 연결하는 중…', { name: title })}
              </h3>
              <Button size="sm" variant="ghost" onClick={() => s.closeTab(tab.id)}>
                {t('취소')}
              </Button>
            </div>
          </div>
        )}

        {overlay && (
          <ConnectPrompt
            overlay={overlay}
            vaultId={tab.vaultId}
            reply={(m) => {
              const r = answer.current;
              answer.current = null;
              r?.(m);
            }}
            dismiss={() => setOverlay(null)}
            reconnect={() => s.reconnect(tab.id)}
          />
        )}

        {status.state === 'closed' && !overlay && (
          <div className="term-closed">
            <span>{status.message || t('연결이 종료되었습니다.')}</span>
            <Button size="sm" variant="primary" onClick={() => s.reconnect(tab.id)}>
              <RotateCw size={14} /> {t('다시 연결')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => s.closeTab(tab.id)}>
              {t('탭 닫기')}
            </Button>
          </div>
        )}
      </div>
      {side && (
        <TermSidePanel
          tab={tab}
          side={side}
          setSide={setSide}
          onSnippet={(text, run) => {
            const term = termRef.current;
            if (!term) return;
            // 스니펫도 클립보드 붙여넣기와 같게: 제어 문자를 빼고 xterm 의 붙여넣기로 보낸다
            // (셸이 괄호 붙여넣기를 켰으면 여러 줄 스니펫이 Enter 전에 실행되지 않는다)
            const clean = cleanPaste(text);
            if (run) {
              term.paste(clean.replace(/[\r\n]+$/, ''));
              transport.current?.send('\r');
            } else term.paste(clean);
            term.focus();
          }}
        />
      )}
    </div>
  );
}

function TermSidePanel({ tab, side, setSide, onSnippet }: { tab: TerminalTab; side: 'snippets' | 'theme'; setSide: (v: null | 'snippets' | 'theme') => void; onSnippet: (text: string, run: boolean) => void }) {
  const s = useStore();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const personal = s.me.vaults.find((v) => v.kind === 'personal');

  // 패널을 열 때마다 새로 읽는다 (다른 팀원이 방금 추가한 스니펫도 보이게)
  useEffect(() => {
    if (side !== 'snippets') return;
    const ids = [...new Set([tab.vaultId, personal?.id].filter(Boolean) as string[])];
    Promise.all(ids.map((id) => ensureLoaded(id).catch(() => false)))
      .then(() => setSnippets(ids.flatMap((id) => itemsOf(id).snippets)))
      .catch(() => {});
  }, [tab.vaultId, personal?.id, side]);

  return (
    <aside className="term-side">
      <div className="term-side-tabs">
        <IconButton label={t('스니펫')} className={side === 'snippets' ? 'on' : ''} onClick={() => setSide('snippets')}>
          <Braces size={16} />
        </IconButton>
        <IconButton label={t('테마')} className={side === 'theme' ? 'on' : ''} onClick={() => setSide('theme')}>
          <Palette size={16} />
        </IconButton>
        <div className="toolbar-spacer" />
        <IconButton label={t('닫기')} onClick={() => setSide(null)}>
          <X size={16} />
        </IconButton>
      </div>
      {side === 'snippets' && (
        <div className="term-side-body">
          <h4>{t('스니펫')}</h4>
          {snippets.length === 0 && <p className="muted small">{t('스니펫이 없습니다. 볼트의 스니펫 메뉴에서 만들 수 있습니다.')}</p>}
          {snippets.map((x) => {
            // 여러 줄 스니펫은 줄 수를 드러내고, 전체 내용을 도움말로 보여 준다 (첫 줄만 보고 숨은 줄까지 실행하지 않게)
            const lines = lineCount(x.script);
            return (
              <div key={x.id} className="snippet-row">
                <button className="snippet-main" title={`${t('터미널에 붙여넣기')}\n\n${cleanPaste(x.script)}`} onClick={() => onSnippet(x.script, false)}>
                  <span className="item-title">
                    {x.label}
                    {lines > 1 && (
                      <>
                        {' '}
                        <Badge tone="warn">{t('{count}줄', { count: lines })}</Badge>
                      </>
                    )}
                  </span>
                  <span className="item-sub mono">{x.script.split('\n')[0]}</span>
                </button>
                <IconButton label={t('바로 실행')} onClick={() => onSnippet(x.script, true)}>
                  <Play size={14} />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}
      {side === 'theme' && (
        <div className="term-side-body">
          <h4>{t('글꼴 크기')}</h4>
          <div className="font-size">
            <IconButton label={t('작게')} onClick={() => s.setPrefs({ fontSize: Math.max(9, s.prefs.fontSize - 1) })}>
              <Minus size={14} />
            </IconButton>
            <span>{s.prefs.fontSize}</span>
            <IconButton label={t('크게')} onClick={() => s.setPrefs({ fontSize: Math.min(28, s.prefs.fontSize + 1) })}>
              <Plus size={14} />
            </IconButton>
          </div>
          <h4>{t('테마')}</h4>
          <ThemeList />
        </div>
      )}
    </aside>
  );
}

export function ThemeList() {
  const s = useStore();
  return (
    <div className="theme-list">
      {TERM_THEMES.map((t) => (
        <button key={t.id} className={`theme-item ${s.prefs.themeId === t.id ? 'on' : ''}`} onClick={() => s.setPrefs({ themeId: t.id })}>
          <span className="theme-preview" style={{ background: t.theme.background }}>
            <i style={{ background: t.theme.green }} />
            <i style={{ background: t.theme.foreground, width: '60%' }} />
            <i style={{ background: t.theme.blue, width: '40%' }} />
          </span>
          <span>{t.name}</span>
        </button>
      ))}
    </div>
  );
}
