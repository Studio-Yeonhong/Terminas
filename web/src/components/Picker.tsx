import { useEffect, useRef, useState } from 'react';
import { Compass, Search, Server } from 'lucide-react';
import { errorMessage, type Host } from '../api';
import { allHosts } from '../vault';
import { useStore } from '../store';
import { colorFor } from './ui';
import { HostGlyph } from './OsIcon';
import { osOf } from '../os-detect';
import { hostSubtitle } from './Hosts';
import { t } from '../i18n';

// 새 탭: 모든 볼트의 호스트를 찾아 바로 연결 (Ctrl+K)
export function Picker({ visible }: { visible: boolean }) {
  const s = useStore();
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    input.current?.focus();
    allHosts().then(setHosts, (err) => s.toast(errorMessage(err), 'error'));
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const recent = s.tabs.filter((t) => t.kind === 'terminal').map((t) => (t.kind === 'terminal' ? t.hostId : ''));
  const list = (hosts ?? [])
    .filter((h) => !q || [h.label, h.address, h.username, h.vaultName ?? '', ...h.tags].some((v) => v.toLowerCase().includes(q)))
    .sort((a, b) => Number(recent.includes(b.id)) - Number(recent.includes(a.id)) || (a.label || a.address).localeCompare(b.label || b.address))
    .slice(0, 50);

  useEffect(() => setCursor(0), [query]);

  return (
    <div className="picker" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="picker-search">
        <Search size={16} />
        <input
          ref={input}
          placeholder={t('호스트 또는 탭 검색')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setCursor((c) => Math.min(c + 1, list.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
            else if (e.key === 'Enter' && list[cursor]) s.openTerminal(list[cursor]);
            else if (e.key === 'Escape') s.closeTab('picker');
          }}
        />
        <kbd>Ctrl+K</kbd>
      </div>
      {hosts && list.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <Compass size={22} />
          </div>
          <h3>{q ? t('맞는 호스트가 없습니다') : t('연결할 호스트가 없습니다')}</h3>
          <p>{t('볼트에 호스트를 먼저 만들어 주세요.')}</p>
        </div>
      ) : (
        <ul className="picker-list" role="listbox">
          {list.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === cursor}>
              <button className={i === cursor ? 'on' : ''} onMouseEnter={() => setCursor(i)} onClick={() => s.openTerminal(h)}>
                <span className="item-icon small" style={{ background: colorFor(h.id) }}>
                  <HostGlyph os={osOf(h)} size={14} />
                </span>
                <span className="picker-name">{h.label || h.address}</span>
                <span className="picker-sub">{hostSubtitle(h)}</span>
                <span className="picker-vault">{h.vaultName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
