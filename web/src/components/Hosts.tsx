import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ArrowDownAZ, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Folder, FolderOpen, FolderPlus, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Server, SquareTerminal, Tag, Tags, Trash2, Users } from 'lucide-react';
import { errorMessage, type Group, type Host, type Items } from '../api';
import { useStore } from '../store';
import { desktop } from '../desktop';
import { ensureLoaded, hostPassword, loadVault, personalVaultId, vaultApi } from '../vault';
import { Button, EmptyState, Field, IconButton, Input, Menu, Select, SidePanel, PALETTE, colorFor, useMenu, type MenuItem } from './ui';
import { HostGlyph } from './OsIcon';
import { osOf } from '../os-detect';
import { locale, t, tr } from '../i18n';

type Draft = { address?: string; port?: number; username?: string; groupId?: string | null };
type Panel = { kind: 'host'; host?: Host; draft?: Draft; nonce?: number } | { kind: 'group'; group?: Group; parentId?: string | null } | null;

export function parseSsh(input: string): { username: string; address: string; port: number } | null {
  const t = input.trim();
  if (!/^ssh\s/.test(t) && !t.includes('@')) return null;
  let rest = t.replace(/^ssh\s+/, '');
  let port: number | undefined;
  const pm = rest.match(/(?:^|\s)-p\s*(\d{1,5})/);
  if (pm) {
    port = Number(pm[1]);
    rest = rest.replace(pm[0], ' ');
  }
  const target = rest.trim().split(/\s+/)[0];
  if (!target) return null;
  let username = '';
  let address = target;
  const at = target.lastIndexOf('@');
  if (at >= 0) {
    username = target.slice(0, at);
    address = target.slice(at + 1);
  }
  const cm = address.match(/^([^:\]]+):(\d{1,5})$/);
  if (cm) {
    address = cm[1];
    port = port ?? Number(cm[2]);
  }
  if (!address || /[\s/]/.test(address)) return null;
  return { username, address, port: port ?? 22 };
}

function descendants(groups: Group[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) if (g.parentId && out.has(g.parentId) && !out.has(g.id)) out.add(g.id), (grew = true);
  }
  return out;
}

// 태그로 거르기: 볼트마다 이 기기에 기억한다
const tagFilterKey = (vaultId: string) => `terminas.hostTags.${vaultId}`;
// 태그 이름은 볼트 내용이라 디스크(localStorage)에 두지 않고 이 창을 닫을 때까지만 기억한다 (sessionStorage)
function readTagFilter(vaultId: string): string[] {
  try {
    localStorage.removeItem(tagFilterKey(vaultId)); // 예전(~0.3.2)에 디스크에 남긴 것은 지운다
    const v = JSON.parse(sessionStorage.getItem(tagFilterKey(vaultId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeTagFilter(vaultId: string, tags: string[]) {
  try {
    if (tags.length) sessionStorage.setItem(tagFilterKey(vaultId), JSON.stringify(tags));
    else sessionStorage.removeItem(tagFilterKey(vaultId));
  } catch {}
}

export function hostSubtitle(h: Host) {
  return h.username ? `ssh, ${h.username}` : 'ssh';
}

export function HostsView() {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [groupId, setGroupId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const { node: menuNode, open: openMenu } = useMenu();
  const [sortAnchor, setSortAnchor] = useState<DOMRect | null>(null);
  const [tagFilter, setTagFilterState] = useState<string[]>(() => readTagFilter(s.vault.id));

  useEffect(() => {
    setGroupId(null);
    setPanel(null);
    setQuery('');
    setTagFilterState(readTagFilter(s.vault.id));
  }, [s.vault.id]);

  const setTagFilter = (next: string[]) => {
    setTagFilterState(next);
    writeTagFilter(s.vault.id, next);
  };

  const { groups, hosts } = s.items;
  const parsed = parseSsh(query);
  const q = query.trim().toLowerCase();
  const searching = Boolean(q);

  // 이 볼트의 태그 (이름순, 붙은 호스트 수)
  const allTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const h of hosts) for (const tag of h.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => a[0].localeCompare(b[0], locale(), { numeric: true, sensitivity: 'base' }));
  }, [hosts]);
  // 지금 볼트에 없는 태그는 거르기에서 뺀다 (지운 태그)
  const activeTags = tagFilter.filter((tag) => allTags.some(([name]) => name === tag));
  // 태그로 거르면 그룹과 상관없이 볼트 전체에서 찾는다 (검색처럼)
  const filtering = activeTags.length > 0;
  const byTag = s.prefs.hostSort === 'tag';

  const visibleGroups = searching || filtering ? [] : groups.filter((g) => g.parentId === groupId);
  const visibleHosts = (
    searching
      ? hosts.filter((h) => {
          if (parsed) return h.address.toLowerCase().includes(parsed.address.toLowerCase());
          return [h.label, h.address, h.username, ...h.tags].some((v) => v.toLowerCase().includes(q));
        })
      : filtering
        ? hosts
        : hosts.filter((h) => h.groupId === groupId)
  ).filter((h) => !filtering || h.tags.some((tag) => activeTags.includes(tag)));

  // 태그별로 묶기: 호스트는 붙은 태그마다 나온다. 태그 없는 호스트는 맨 뒤
  const tagSections = useMemo(() => {
    if (!byTag) return [];
    const names = [...new Set(visibleHosts.flatMap((h) => h.tags))]
      .filter((tag) => !filtering || activeTags.includes(tag))
      .sort((a, b) => a.localeCompare(b, locale(), { numeric: true, sensitivity: 'base' }));
    const sections = names.map((tag) => ({ tag, hosts: visibleHosts.filter((h) => h.tags.includes(tag)) }));
    const untagged = visibleHosts.filter((h) => h.tags.length === 0);
    return untagged.length ? [...sections, { tag: '', hosts: untagged }] : sections;
  }, [byTag, visibleHosts, filtering, activeTags]); // eslint-disable-line react-hooks/exhaustive-deps

  const sortItems = (): MenuItem[] => [
    { header: t('정렬') },
    { label: t('이름순(가나다)'), checked: !byTag, onClick: () => s.setPrefs({ hostSort: 'name' }) },
    { label: t('태그별로 묶기'), checked: byTag, onClick: () => s.setPrefs({ hostSort: 'tag' }) },
    { divider: true },
    { header: t('태그로 거르기') },
    ...(allTags.length === 0
      ? [{ label: t('아직 태그가 없습니다'), disabled: true, onClick: () => {} }]
      : [
          { label: t('모든 호스트'), checked: !filtering, keepOpen: true, onClick: () => setTagFilter([]) },
          ...allTags.map(([tag, n]) => ({
            label: tag,
            hint: String(n),
            checked: activeTags.includes(tag),
            keepOpen: true,
            onClick: () => setTagFilter(activeTags.includes(tag) ? activeTags.filter((x) => x !== tag) : [...activeTags, tag]),
          })),
        ]),
  ];

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      const ids = descendants(groups, g.id);
      map.set(g.id, hosts.filter((h) => h.groupId && ids.has(h.groupId)).length);
    }
    return map;
  }, [groups, hosts]);

  const path: Group[] = [];
  for (let cur = groups.find((g) => g.id === groupId); cur; cur = groups.find((g) => g.id === cur!.parentId)) path.unshift(cur);

  const quickConnect = () => {
    if (parsed) {
      if (!canEdit) return s.toast(t('보기 전용 볼트라 새 호스트를 만들 수 없습니다'), 'error');
      setPanel({ kind: 'host', draft: { ...parsed, groupId }, nonce: Date.now() });
      return;
    }
    if (visibleHosts.length === 1) openHost(visibleHosts[0]);
  };

  const openHost = (h: Host) => void s.openTerminal(h);

  const hostMenu = (e: ReactMouseEvent, host: Host) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu({
      anchor: { x: e.clientX, y: e.clientY },
      items: [
        { label: t('연결'), icon: <SquareTerminal size={14} />, onClick: () => void s.openTerminal(host) },
        { label: t('SFTP로 열기'), icon: <FolderOpen size={14} />, onClick: () => s.openSftp(host) },
        ...(canEdit
          ? [
              { label: t('편집'), icon: <Pencil size={14} />, onClick: () => setPanel({ kind: 'host', host }) },
              { label: t('복제'), icon: <Copy size={14} />, onClick: () => void duplicate(host) },
              { divider: true as const },
              { label: t('삭제'), icon: <Trash2 size={14} />, danger: true, onClick: () => void removeHost(host) },
            ]
          : [{ label: t('정보 보기'), icon: <Eye size={14} />, onClick: () => setPanel({ kind: 'host', host }) }]),
      ],
    });
  };

  const duplicate = async (host: Host) => {
    try {
      const copy = await vaultApi.duplicateHost(host.id);
      await s.reloadItems();
      setPanel({ kind: 'host', host: copy });
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const removeHost = async (host: Host) => {
    const ok = await s.confirm({ title: t('호스트 삭제'), message: t('"{name}"을(를) 이 볼트에서 지웁니다. 이 호스트를 사용하는 포트 포워딩 규칙도 함께 지워집니다.', { name: host.label || host.address }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    try {
      await vaultApi.deleteHost(host.id);
      setPanel(null);
      await s.reloadItems();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const onCardKey = (e: ReactKeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  const hostCard = (h: Host, key: string) => (
    <div
      key={key}
      className={`item-card host ${panel?.kind === 'host' && panel.host?.id === h.id ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      title={t('{target} — 눌러서 연결', { target: `${h.username ? `${h.username}@` : ''}${h.address}:${h.port}` })}
      onClick={() => openHost(h)}
      onKeyDown={(e) => onCardKey(e, () => openHost(h))}
      onContextMenu={(e) => hostMenu(e, h)}
    >
      <div className="item-icon" style={{ background: colorFor(h.id) }}>
        <HostGlyph os={osOf(h)} size={18} />
      </div>
      <div className="item-text">
        <div className="item-title">{h.label || h.address}</div>
        <div className="item-sub">
          {hostSubtitle(h)}
          {s.prefs.view === 'list' && <span className="item-addr">{`${h.address}${h.port !== 22 ? `:${h.port}` : ''}`}</span>}
        </div>
      </div>
      {s.prefs.view === 'list' && h.tags.length > 0 && (
        <div className="item-tags">
          {h.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
      <button
        className="card-action"
        aria-label={canEdit ? t('호스트 편집') : t('호스트 정보')}
        onClick={(e) => {
          e.stopPropagation();
          setPanel({ kind: 'host', host: h });
        }}
      >
        {canEdit ? <Pencil size={14} /> : <MoreHorizontal size={14} />}
      </button>
    </div>
  );

  const empty = !s.itemsLoading && groups.length === 0 && hosts.length === 0;

  return (
    <>
      <div className="view">
        <div className="quickbar">
          <Input
            placeholder={t('호스트 검색, 또는 "ssh user@host -p port" 입력')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') quickConnect();
              if (e.key === 'Escape') setQuery('');
            }}
          />
          <Button size="sm" variant={parsed ? 'primary' : 'soft'} disabled={!parsed && visibleHosts.length !== 1} onClick={quickConnect}>
            {t('연결')}
          </Button>
        </div>

        <div className="toolbar">
          {canEdit && (
            <div className="split-btn">
              <Button size="sm" onClick={() => setPanel({ kind: 'host', draft: { groupId }, nonce: Date.now() })}>
                <Plus size={15} /> {t('새 호스트')}
              </Button>
              <button
                className="btn btn-soft btn-sm split-caret"
                aria-label={t('더 만들기')}
                onClick={(e) =>
                  openMenu({
                    anchor: e.currentTarget.getBoundingClientRect(),
                    items: [
                      { label: t('새 호스트'), icon: <Server size={14} />, onClick: () => setPanel({ kind: 'host', draft: { groupId }, nonce: Date.now() }) },
                      { label: t('새 그룹'), icon: <FolderPlus size={14} />, onClick: () => setPanel({ kind: 'group', parentId: groupId }) },
                    ],
                  })
                }
              >
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {desktop && (
            <Button size="sm" variant="ghost" onClick={s.openLocalTerminal}>
              <SquareTerminal size={15} /> {t('터미널')}
            </Button>
          )}
          {!canEdit && <span className="readonly-note">{t('보기 전용 볼트 — 접속만 할 수 있습니다')}</span>}
          <div className="toolbar-spacer" />
          <Button size="sm" variant={filtering ? 'soft' : 'ghost'} aria-label={t('정렬·거르기')} aria-haspopup="menu" onClick={(e) => setSortAnchor(e.currentTarget.getBoundingClientRect())}>
            {byTag ? <Tags size={15} /> : <ArrowDownAZ size={15} />}
            {filtering ? t('태그 {count}개', { count: activeTags.length }) : byTag ? t('태그별') : t('이름순')}
          </Button>
          <div className="seg">
            <button className={s.prefs.view === 'grid' ? 'on' : ''} aria-label={t('격자로 보기')} onClick={() => s.setPrefs({ view: 'grid' })}>
              <LayoutGrid size={15} />
            </button>
            <button className={s.prefs.view === 'list' ? 'on' : ''} aria-label={t('목록으로 보기')} onClick={() => s.setPrefs({ view: 'list' })}>
              <List size={15} />
            </button>
          </div>
        </div>

        {empty ? (
          <EmptyState icon={<Server size={22} />} title={t('호스트 만들기')} text={t('접속 정보를 호스트로 저장해 두면 한 번에 연결할 수 있습니다.')}>
            {canEdit ? <QuickCreate onContinue={(address) => setPanel({ kind: 'host', draft: { address }, nonce: Date.now() })} /> : <p className="muted">{t('이 볼트에는 아직 호스트가 없습니다.')}</p>}
          </EmptyState>
        ) : (
          <div className="view-content">
            {!searching && !filtering && path.length > 0 && (
              <nav className="crumbs">
                <button onClick={() => setGroupId(null)}>{t('호스트')}</button>
                {path.map((g) => (
                  <span key={g.id}>
                    <ChevronRight size={14} />
                    <button onClick={() => setGroupId(g.id)} className={g.id === groupId ? 'current' : ''}>
                      {g.name}
                    </button>
                  </span>
                ))}
                {canEdit && groupId && (
                  <IconButton label={t('그룹 편집')} onClick={() => setPanel({ kind: 'group', group: groups.find((g) => g.id === groupId) })}>
                    <Pencil size={13} />
                  </IconButton>
                )}
              </nav>
            )}

            {visibleGroups.length > 0 && (
              <section>
                <h2 className="section-title">{t('그룹')}</h2>
                <div className={`cards ${s.prefs.view}`}>
                  {visibleGroups.map((g) => (
                    <div key={g.id} className="item-card" role="button" tabIndex={0} onClick={() => setGroupId(g.id)} onKeyDown={(e) => onCardKey(e, () => setGroupId(g.id))}>
                      <div className="item-icon folder">
                        <Folder size={18} />
                      </div>
                      <div className="item-text">
                        <div className="item-title">{g.name}</div>
                        <div className="item-sub">{t('호스트 {count}개', { count: counts.get(g.id) ?? 0 })}</div>
                      </div>
                      {canEdit && (
                        <button
                          className="card-action"
                          aria-label={t('그룹 편집')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPanel({ kind: 'group', group: g });
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="section-title">
                {searching ? t('검색 결과 {count}개', { count: visibleHosts.length }) : filtering ? t('태그 {tags} · {count}개', { tags: activeTags.join(', '), count: visibleHosts.length }) : t('호스트')}
                {filtering && (
                  <button className="link-btn section-action" onClick={() => setTagFilter([])}>
                    {t('거르기 해제')}
                  </button>
                )}
              </h2>
              {visibleHosts.length === 0 ? (
                <p className="muted small">{searching ? t('맞는 호스트가 없습니다.') : filtering ? t('이 태그가 붙은 호스트가 없습니다.') : t('이 그룹에는 호스트가 없습니다.')}</p>
              ) : byTag ? (
                tagSections.map((sec) => (
                  <div key={sec.tag || '-'} className="tag-section">
                    <h3 className="tag-section-title">
                      <Tag size={12} /> {sec.tag || t('태그 없음')} <span className="muted">{sec.hosts.length}</span>
                    </h3>
                    <div className={`cards ${s.prefs.view}`}>{sec.hosts.map((h) => hostCard(h, `${sec.tag}:${h.id}`))}</div>
                  </div>
                ))
              ) : (
                <div className={`cards ${s.prefs.view}`}>{visibleHosts.map((h) => hostCard(h, h.id))}</div>
              )}
            </section>
          </div>
        )}
      </div>

      {sortAnchor && <Menu anchor={sortAnchor} align="right" items={sortItems()} onClose={() => setSortAnchor(null)} />}
      {panel?.kind === 'host' && (
        <HostEditor
          key={panel.host?.id ?? `new-${panel.nonce ?? 0}`}
          host={panel.host}
          draft={panel.draft}
          onClose={() => setPanel(null)}
          onSaved={(h) => setPanel({ kind: 'host', host: h })}
          onDelete={(h) => void removeHost(h)}
        />
      )}
      {panel?.kind === 'group' && <GroupEditor key={panel.group?.id ?? 'new'} group={panel.group} parentId={panel.parentId ?? null} onClose={() => setPanel(null)} onDeleted={() => (setPanel(null), setGroupId(null))} />}
      {menuNode}
    </>
  );
}

function QuickCreate({ onContinue }: { onContinue: (address: string) => void }) {
  const [address, setAddress] = useState('');
  return (
    <form
      className="quick-create"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim()) onContinue(address.trim());
      }}
    >
      <Input placeholder={t('IP 또는 호스트 이름')} value={address} onChange={(e) => setAddress(e.target.value)} />
      <Button variant="primary" type="submit" disabled={!address.trim()}>
        {t('계속')}
      </Button>
    </form>
  );
}

// 태그 입력: 이 볼트에서 이미 쓰는 태그를 자동 완성으로 보여 준다 (많이 쓴 순, 앞글자가 맞는 것 먼저)
function TagInput({ value, onChange, disabled, suggestions = [] }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; suggestions?: string[] }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const add = (tag = text) => {
    const t = tag.trim().replace(/,$/, '');
    if (t && !value.includes(t)) onChange([...value, t]);
    setText('');
    setCursor(-1);
  };
  const q = text.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    return suggestions
      .filter((t) => !value.includes(t) && t.toLowerCase().includes(q) && t.toLowerCase() !== q)
      .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)))
      .slice(0, 8);
  }, [q, suggestions, value]);
  const open = focused && matches.length > 0;
  return (
    <div className={`tag-input ${disabled ? 'disabled' : ''}`}>
      <Tag size={14} className="tag-input-icon" />
      {value.map((tag) => (
        <span key={tag} className="chip">
          {tag}
          {!disabled && (
            <button type="button" aria-label={t('{tag} 태그 빼기', { tag })} onClick={() => onChange(value.filter((x) => x !== tag))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={text}
          placeholder={value.length ? '' : t('태그')}
          onChange={(e) => {
            setCursor(-1);
            if (e.target.value.endsWith(',')) {
              setText(e.target.value);
              setTimeout(add);
            } else setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setCursor((c) => (e.key === 'ArrowDown' ? (c + 1) % matches.length : c <= 0 ? matches.length - 1 : c - 1));
            } else if (open && e.key === 'Tab') {
              e.preventDefault();
              add(matches[Math.max(cursor, 0)]);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              // 목록에서 고른 게 있으면 그것, 아니면 입력한 그대로
              add(open && cursor >= 0 ? matches[cursor] : text);
            } else if (e.key === 'Escape' && open) {
              e.stopPropagation();
              setFocused(false);
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            add();
          }}
        />
      )}
      {open && (
        <div className="menu tag-suggest" role="listbox" aria-label={t('이미 사용 중인 태그')}>
          {matches.map((t, i) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`menu-item ${i === cursor ? 'on' : ''}`}
              // 입력칸이 먼저 blur 되지 않게 mousedown 에서 고른다
              onMouseDown={(e) => {
                e.preventDefault();
                add(t);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="menu-icon">
                <Tag size={12} />
              </span>
              <span className="menu-label">{t}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 새 호스트의 id 를 창을 열 때 미리 정한다. 아이콘 색이 id 로 정해지므로 주소를 입력하는 동안에도, 저장한 뒤에도
// 같은 색이다. 바로 전 새 호스트와 다른 색 중 이 볼트에서 덜 쓴 색이 나오게 고른다.
let lastNewColor = '';
function pickNewHostId(existing: Host[]) {
  const used = new Map<string, number>();
  for (const h of existing) used.set(colorFor(h.id), (used.get(colorFor(h.id)) ?? 0) + 1);
  const candidates = PALETTE.filter((c) => c !== lastNewColor);
  const least = Math.min(...candidates.map((c) => used.get(c) ?? 0));
  const pool = candidates.filter((c) => (used.get(c) ?? 0) === least);
  const want = pool[Math.floor(Math.random() * pool.length)];
  let id = crypto.randomUUID();
  for (let i = 0; i < 2000 && colorFor(id) !== want; i++) id = crypto.randomUUID();
  lastNewColor = colorFor(id);
  return id;
}

function HostEditor({ host, draft, onClose, onSaved, onDelete }: { host?: Host; draft?: Draft; onClose: () => void; onSaved: (h: Host) => void; onDelete: (h: Host) => void }) {
  const s = useStore();
  const [newId] = useState(() => (host ? '' : pickNewHostId(s.items.hosts)));
  const editableVaults = s.me.vaults.filter((v) => v.perm === 'edit');
  const [vaultId, setVaultId] = useState(host?.vaultId ?? s.vault.id);
  const vault = s.me.vaults.find((v) => v.id === vaultId)!;
  const canEdit = vault.perm === 'edit';
  const [other, setOther] = useState<Items | null>(null);
  const source = vaultId === s.vault.id ? s.items : other;
  // 이 볼트의 다른 호스트들이 쓰는 태그 (많이 쓴 순)
  const knownTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const h of source?.hosts ?? []) for (const t of h.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], locale())).map(([t]) => t);
  }, [source]);

  const [address, setAddress] = useState(host?.address ?? draft?.address ?? '');
  const [label, setLabel] = useState(host?.label ?? '');
  const [groupId, setGroupId] = useState<string | null>(host?.groupId ?? draft?.groupId ?? null);
  const [tags, setTags] = useState<string[]>(host?.tags ?? []);
  const [port, setPort] = useState(String(host?.port ?? draft?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? draft?.username ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [keyId, setKeyId] = useState<string | null>(host?.keyId ?? null);
  const [identityId, setIdentityId] = useState<string | null>(host?.identityId ?? null);
  const [busy, setBusy] = useState(false);
  const [myCredential, setMyCredential] = useState<{ identityId: string; label: string } | null>(null);
  const { node: menuNode, open: openMenu } = useMenu();

  useEffect(() => {
    if (vaultId === s.vault.id) return;
    setGroupId(null);
    setKeyId(null);
    setIdentityId(null);
    loadVault(vault).then((r) => setOther(r.items), (err) => s.toast(errorMessage(err), 'error'));
  }, [vaultId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!host || vault.kind !== 'team') return;
    const pv = personalVaultId();
    if (pv) void ensureLoaded(pv).then(() => setMyCredential(vaultApi.myCredential(host.id)), () => {});
  }, [host, vault.kind]);

  const dirty =
    !host ||
    address !== host.address ||
    label !== host.label ||
    groupId !== host.groupId ||
    JSON.stringify(tags) !== JSON.stringify(host.tags) ||
    Number(port) !== host.port ||
    username !== host.username ||
    Boolean(password) ||
    clearPassword ||
    keyId !== host.keyId ||
    identityId !== host.identityId;

  const save = async (): Promise<Host | null> => {
    if (!address.trim()) {
      s.toast(t('주소를 입력해 주세요'), 'error');
      return null;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        address: address.trim(),
        label: label.trim(),
        groupId,
        tags,
        port: Number(port) || 22,
        username: username.trim(),
        keyId,
        identityId,
      };
      if (password) payload.password = password;
      else if (clearPassword) payload.password = null;
      // 프리셋을 쓰면 호스트에 따로 적어 둔 ID·비밀번호·키는 비운다 (프리셋이 우선이 되게)
      if (identityId) {
        payload.username = '';
        payload.keyId = null;
        if (host?.hasPassword || password) payload.password = null;
      }
      const saved = host ? await vaultApi.updateHost(host.id, payload) : await vaultApi.createHost(vaultId, payload, newId);
      if (vaultId !== s.vault.id) {
        s.setVaultId(vaultId);
      } else {
        await s.reloadItems();
      }
      setPassword('');
      setClearPassword(false);
      s.toast(host ? t('저장했습니다') : t('호스트를 만들었습니다'), 'success');
      onSaved(saved);
      return saved;
    } catch (err) {
      s.toast(errorMessage(err), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const target = dirty && canEdit ? await save() : host;
    if (target) void s.openTerminal(target);
  };

  // 저장된 비밀번호(이 기기에서 풀어 둔 것)도 프리셋으로 옮길 수 있다
  const typedOrStoredPassword = () => password || (host && !clearPassword ? hostPassword(host.id) : null) || '';

  // 직접 넣은 ID·비밀번호(또는 키)를 계정 프리셋으로 만들어 이 호스트에 연결한다
  const saveAsPreset = async () => {
    const pw = typedOrStoredPassword();
    if (!username.trim() || (!pw && !keyId)) {
      return s.toast(t('ID와 비밀번호(또는 SSH 키)를 입력한 뒤 저장할 수 있습니다.'), 'error');
    }
    const name = await s.askText({
      title: t('계정 프리셋으로 저장'),
      label: t('프리셋 이름'),
      value: username.trim(),
      confirmLabel: t('저장'),
      hint: t('같은 ID·비밀번호를 사용하는 다른 호스트에서도 골라 쓸 수 있습니다. 프리셋을 수정하면 해당 프리셋을 사용하는 모든 호스트에 적용됩니다.'),
    });
    if (!name) return;
    try {
      const created = await vaultApi.createIdentity(vaultId, { label: name, username: username.trim(), password: pw || null, keyId });
      if (vaultId === s.vault.id) await s.reloadItems();
      else setOther((await loadVault(vault)).items);
      setIdentityId(created.id);
      setPassword('');
      s.toast(t('"{name}" 프리셋을 만들었습니다. 저장을 누르면 해당 호스트에 적용됩니다.', { name }), 'success');
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const presets = source?.identities ?? [];
  const preset = presets.find((i) => i.id === identityId);

  const groupOptions = (source?.groups ?? []).map((g) => {
    const names: string[] = [];
    for (let cur: Group | undefined = g; cur; cur = source!.groups.find((x) => x.id === cur!.parentId)) names.unshift(cur.name);
    return { id: g.id, name: names.join(' / ') };
  });

  return (
    <SidePanel
      title={host ? (canEdit ? t('호스트 편집') : t('호스트 정보')) : t('새 호스트')}
      onClose={onClose}
      actions={
        host &&
        canEdit && (
          <IconButton
            label={t('더 보기')}
            onClick={(e) =>
              openMenu({
                anchor: e.currentTarget.getBoundingClientRect(),
                align: 'right',
                items: [{ label: t('삭제'), icon: <Trash2 size={14} />, danger: true, onClick: () => onDelete(host) }],
              })
            }
          >
            <MoreHorizontal size={16} />
          </IconButton>
        )
      }
      footer={
        <>
          {canEdit && (
            <Button variant="soft" onClick={() => void save()} loading={busy} disabled={!dirty}>
              {t('저장')}
            </Button>
          )}
          <Button variant="primary" onClick={() => void connect()} disabled={busy || !address.trim()}>
            {t('연결')}
          </Button>
        </>
      }
    >
      <div className="panel-section">
        {!host ? (
          <Select value={vaultId} onChange={(e) => setVaultId(e.target.value)} aria-label={t('저장할 볼트')}>
            {editableVaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.teamName ? `${v.teamName} · ${v.name}` : v.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="vault-pill">
            {vault.kind === 'team' ? <Users size={14} /> : <Server size={14} />}
            {vault.teamName ? `${vault.teamName} · ${vault.name}` : vault.name}
          </div>
        )}
      </div>

      <div className="panel-section">
        <h4>{t('주소')}</h4>
        <div className="address-row">
          <div className="item-icon small" style={{ background: colorFor(host?.id ?? newId) }}>
            <HostGlyph os={host ? osOf(host) : ''} size={15} />
          </div>
          <Input placeholder={t('IP 또는 호스트 이름')} value={address} onChange={(e) => setAddress(e.target.value)} disabled={!canEdit} autoFocus={!host} />
        </div>
      </div>

      <div className="panel-section">
        <h4>{t('일반')}</h4>
        <Input placeholder={t('이름')} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} />
        <Select value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value || null)} disabled={!canEdit} aria-label={t('상위 그룹')}>
          <option value="">{t('상위 그룹 없음')}</option>
          {groupOptions.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        <TagInput value={tags} onChange={setTags} disabled={!canEdit} suggestions={knownTags} />
      </div>

      <div className="panel-section">
        <div className="port-row">
          <h4>{t('SSH 포트')}</h4>
          <input className="port-input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} disabled={!canEdit} aria-label={t('포트')} />
        </div>
        <h4>{t('자격증명')}</h4>
        <Field label={t('계정 프리셋')}>
          <Select value={identityId ?? ''} onChange={(e) => setIdentityId(e.target.value || null)} disabled={!canEdit}>
            <option value="">{t('직접 입력')}</option>
            {presets.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label} ({i.username})
              </option>
            ))}
          </Select>
        </Field>
        {preset ? (
          <p className="panel-hint">
            {tr('<b>{name}</b> 프리셋의 ID({user})·{methods}로 접속합니다. 프리셋을 수정하면 이 프리셋을 사용하는 모든 호스트에 적용됩니다.', {
              name: preset.label,
              user: preset.username,
              methods: [preset.hasPassword ? t('비밀번호') : '', preset.keyId ? t('SSH 키') : ''].filter(Boolean).join('·'),
            })}
          </p>
        ) : (
          <>
        <Input placeholder={t('사용자 이름')} value={username} onChange={(e) => setUsername(e.target.value)} disabled={!canEdit} autoComplete="off" />
        {canEdit && (
          <div className="password-row">
            <Input
              type={showPassword ? 'text' : 'password'}
              placeholder={host?.hasPassword && !clearPassword ? t('저장된 비밀번호 있음 — 바꾸려면 입력') : t('비밀번호')}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setClearPassword(false);
              }}
              autoComplete="new-password"
            />
            <IconButton label={showPassword ? t('비밀번호 숨기기') : t('입력한 비밀번호 보기')} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </IconButton>
          </div>
        )}
        {canEdit && host?.hasPassword && !password && (
          <button type="button" className="link-btn" onClick={() => setClearPassword(!clearPassword)}>
            {clearPassword ? t('저장된 비밀번호 지우기 취소') : t('저장된 비밀번호 지우기')}
          </button>
        )}
        <Field label={t('SSH 키')}>
          <Select value={keyId ?? ''} onChange={(e) => setKeyId(e.target.value || null)} disabled={!canEdit}>
            <option value="">{t('키 없음')}</option>
            {(source?.keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({k.keyType})
              </option>
            ))}
          </Select>
        </Field>
        {canEdit && (
          <button type="button" className="link-btn" onClick={() => void saveAsPreset()}>
            {t('+ 이 ID·비밀번호를 계정 프리셋으로 저장')}
          </button>
        )}
          </>
        )}
        {vault.kind === 'team' && (
          <p className="panel-hint">
            {t('여기 입력한 자격증명은 팀원끼리만 풀 수 있게 암호화되어, 팀원의 앱이 PC에서 직접 접속할 때 사용합니다(화면에는 보이지 않음). 서버는 풀 수 없습니다. 비워 두면 팀원이 접속할 때 각자 입력하거나 내 계정 프리셋에서 고릅니다.')}
          </p>
        )}
        {myCredential && (
          <div className="my-cred">
            <span>
              {tr('내 개인 자격증명 연결됨: <b>{name}</b>', { name: myCredential.label })}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (host) void vaultApi.clearMyCredential(host.id).then(() => setMyCredential(null));
              }}
            >
              {t('연결 해제')}
            </button>
          </div>
        )}
      </div>
      {menuNode}
    </SidePanel>
  );
}

function GroupEditor({ group, parentId, onClose, onDeleted }: { group?: Group; parentId: string | null; onClose: () => void; onDeleted: () => void }) {
  const s = useStore();
  const [name, setName] = useState(group?.name ?? '');
  const [parent, setParent] = useState<string | null>(group ? group.parentId : parentId);
  const [busy, setBusy] = useState(false);
  const blocked = group ? descendants(s.items.groups, group.id) : new Set<string>();

  const save = async () => {
    setBusy(true);
    try {
      if (group) await vaultApi.updateGroup(group.id, { name, parentId: parent });
      else await vaultApi.createGroup(s.vault.id, { name, parentId: parent });
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
    if (!group) return;
    const ok = await s.confirm({ title: t('그룹 삭제'), message: t('"{name}" 그룹을 지웁니다. 안에 있던 호스트와 하위 그룹은 한 단계 위로 옮겨집니다.', { name: group.name }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    try {
      await vaultApi.deleteGroup(group.id);
      await s.reloadItems();
      onDeleted();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <SidePanel
      title={group ? t('그룹 편집') : t('새 그룹')}
      onClose={onClose}
      footer={
        <>
          {group && (
            <Button variant="danger" onClick={() => void remove()}>
              {t('삭제')}
            </Button>
          )}
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!name.trim()}>
            {t('저장')}
          </Button>
        </>
      }
    >
      <div className="panel-section">
        <h4>{t('일반')}</h4>
        <Input placeholder={t('그룹 이름')} value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
        <Select value={parent ?? ''} onChange={(e) => setParent(e.target.value || null)} aria-label={t('상위 그룹')}>
          <option value="">{t('상위 그룹 없음')}</option>
          {s.items.groups
            .filter((g) => !blocked.has(g.id))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </Select>
      </div>
    </SidePanel>
  );
}
