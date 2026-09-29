import { useRef, type MouseEvent } from 'react';
import { Check, ChevronDown, FolderOpen, Loader2, LockKeyhole, LogOut, Menu as MenuIcon, Monitor, Plus, Search, Settings, ShieldCheck, SquareTerminal, UserRound, Users, FolderLock, X } from 'lucide-react';
import { useStore, type TerminalTab } from '../store';
import { desktop } from '../desktop';
import { t } from '../i18n';
import { Avatar, useMenu, type MenuItem } from './ui';
import { UpdatePill } from './AppUpdate';
import { NetPill } from './Offline';

function TabStatus({ tab }: { tab: TerminalTab }) {
  if (tab.state === 'connecting') return <Loader2 size={13} className="spin tab-status connecting" />;
  if (tab.mode === 'local') return <Monitor size={13} className={`tab-status ${tab.state}`} />;
  return <span className={`tab-dot ${tab.state}`} />;
}

export function TopBar() {
  const s = useStore();
  const { node: menuNode, open: openMenu } = useMenu();
  const vaultBtn = useRef<HTMLButtonElement>(null);

  const vaultMenu = () => {
    const items: MenuItem[] = [];
    let lastTeam: string | null | undefined;
    for (const v of s.me.vaults) {
      if (v.teamName !== lastTeam && v.teamName) items.push({ header: v.teamName });
      lastTeam = v.teamName;
      items.push({
        label: v.name,
        icon: v.id === s.vault.id ? <Check size={14} /> : v.kind === 'team' ? <Users size={14} /> : <UserRound size={14} />,
        hint: v.perm === 'view' ? t('보기 전용') : undefined,
        onClick: () => s.setVaultId(v.id),
      });
    }
    if (s.me.teams.length || (s.me.user.canCreateTeams ?? s.me.user.isAdmin)) {
      items.push({ divider: true });
      items.push({ label: t('팀·볼트 관리'), icon: <Settings size={14} />, onClick: () => s.openSettings(s.me.teams[0] ? `team:${s.me.teams[0].id}` : 'new-team') });
    }
    openMenu({ anchor: vaultBtn.current!.getBoundingClientRect(), items });
  };

  // 임시 모드(서버·사본 없이 연 앱): 잠글 것도, 로그아웃할 계정도 없다 — "처음 화면으로"
  const local = s.mode === 'local';
  const leave = local
    ? [{ label: t('처음 화면으로'), icon: <LogOut size={14} />, onClick: () => void s.logout() }]
    : [
        { label: t('지금 잠그기'), icon: <LockKeyhole size={14} />, onClick: () => void s.lock() },
        { label: t('로그아웃'), icon: <LogOut size={14} />, onClick: () => void s.logout() },
      ];

  const mainMenu = (e: MouseEvent<HTMLButtonElement>) =>
    openMenu({
      anchor: e.currentTarget.getBoundingClientRect(),
      items: [
        { label: t('볼트'), icon: <FolderLock size={14} />, hint: 'Ctrl+1', onClick: () => s.setActive('vault') },
        { label: 'SFTP', icon: <FolderOpen size={14} />, hint: 'Ctrl+2', onClick: () => s.openSftp() },
        { label: t('호스트 찾아 연결'), icon: <Search size={14} />, hint: 'Ctrl+K', onClick: s.openPicker },
        ...(desktop ? [{ label: t('새 로컬 터미널'), icon: <SquareTerminal size={14} />, onClick: s.openLocalTerminal }] : []),
        { divider: true },
        { label: t('설정'), icon: <Settings size={14} />, onClick: () => s.openSettings('account') },
        ...leave,
      ],
    });

  const userMenu = (e: MouseEvent<HTMLButtonElement>) =>
    openMenu({
      anchor: e.currentTarget.getBoundingClientRect(),
      align: 'right',
      items: [
        ...(local ? [] : [{ header: s.me.user.email }]),
        { label: t('설정'), icon: <Settings size={14} />, onClick: () => s.openSettings('account') },
        ...(local ? [] : [{ label: t('보안·암호화'), icon: <ShieldCheck size={14} />, onClick: () => s.openSettings('security') }]),
        ...leave,
      ],
    });

  const vaultLabel = s.vault.kind === 'team' ? `${s.vault.teamName} · ${s.vault.name}` : 'Personal';

  return (
    <header className="topbar">
      <button className="icon-btn topbar-menu" aria-label={t('메뉴')} onClick={mainMenu}>
        <MenuIcon size={17} />
      </button>
      <div className="tabs" role="tablist">
        <div className={`tab tab-vault ${s.active === 'vault' ? 'active' : ''}`}>
          <button className="tab-main" role="tab" aria-selected={s.active === 'vault'} onClick={() => s.setActive('vault')}>
            {s.vault.kind === 'team' ? <Users size={14} /> : <UserRound size={14} />}
            <span className="tab-title">{vaultLabel}</span>
          </button>
          <button ref={vaultBtn} className="tab-chevron" aria-label={t('볼트 바꾸기')} onClick={vaultMenu}>
            <ChevronDown size={14} />
          </button>
        </div>
        <div className={`tab tab-fixed ${s.active === 'sftp' ? 'active' : ''}`}>
          <button className="tab-main" role="tab" aria-selected={s.active === 'sftp'} onClick={() => s.openSftp()}>
            <FolderOpen size={14} />
            <span className="tab-title">SFTP</span>
          </button>
        </div>
        {s.tabs.map((tab) => (
          <div key={tab.id} className={`tab ${s.active === tab.id ? 'active' : ''} ${tab.kind === 'terminal' ? `tstate-${tab.state}` : ''}`}>
            <button className="tab-main" role="tab" aria-selected={s.active === tab.id} onClick={() => s.setActive(tab.id)} onAuxClick={(e) => e.button === 1 && s.closeTab(tab.id)}>
              {tab.kind === 'terminal' ? <TabStatus tab={tab} /> : <Search size={13} />}
              <span className="tab-title">{tab.kind === 'terminal' ? tab.title : t('새 탭')}</span>
            </button>
            <button className="tab-close" aria-label={t('탭 닫기')} onClick={() => s.closeTab(tab.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="icon-btn tab-add" aria-label={t('새 탭(Ctrl+K)')} title={t('새 탭(Ctrl+K)')} onClick={s.openPicker}>
          <Plus size={16} />
        </button>
      </div>
      <div className="topbar-right">
        <NetPill />
        <UpdatePill />
        {s.tabs.some((tab) => tab.kind === 'terminal') && (
          <span className="topbar-count" title={t('열린 터미널')}>
            <SquareTerminal size={14} />
            {s.tabs.filter((tab) => tab.kind === 'terminal').length}
          </span>
        )}
        <button className="user-btn" aria-label={t('내 계정')} onClick={userMenu}>
          <Avatar name={s.me.user.name || s.me.user.email} url={s.me.user.avatarUrl} size={26} />
        </button>
      </div>
      {menuNode}
    </header>
  );
}
