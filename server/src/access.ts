import { all, get, newId, now, run, tx } from './db.ts';
import { forbidden, notFound } from './http.ts';
import { config } from './config.ts';

export type User = {
  id: string;
  email: string;
  name: string;
  avatar_url: string;
  google_sub: string | null;
  is_admin: number;
  disabled: number;
  public_key: string | null;
  key_bundle: string | null;
  key_proof: string | null;
  keys_created_at: number | null;
  totp_secret: string | null;
  totp_enabled_at: number | null;
  totp_last_step: number;
  password_hash: string | null;
  password_changed_at: number | null;
};

export type TeamRole = 'owner' | 'admin' | 'member';
export type Perm = 'edit' | 'view';

export type VaultRow = {
  id: string;
  kind: 'personal' | 'team';
  team_id: string | null;
  owner_id: string | null;
  name: string;
  is_default: number;
  created_at: number;
};

export function teamRole(userId: string, teamId: string): TeamRole | null {
  return get<{ role: TeamRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId)?.role ?? null;
}

export function isTeamManager(role: TeamRole | null) {
  return role === 'owner' || role === 'admin';
}

export function requireTeamRole(user: User, teamId: string, manager: boolean): TeamRole {
  const role = teamRole(user.id, teamId);
  if (!role) throw notFound('팀을 찾을 수 없습니다');
  if (manager && !isTeamManager(role)) throw forbidden('팀 관리자만 할 수 있습니다');
  return role;
}

// 개인 볼트: 주인만 edit. 팀 볼트: owner/admin 은 모든 볼트 edit, member 는 vault_members 에 있는 볼트만.
export function vaultAccess(user: User, vaultId: string): { vault: VaultRow; perm: Perm } | null {
  const vault = get<VaultRow>('SELECT * FROM vaults WHERE id = ?', vaultId);
  if (!vault) return null;
  if (vault.kind === 'personal') return vault.owner_id === user.id ? { vault, perm: 'edit' } : null;
  const role = teamRole(user.id, vault.team_id!);
  if (!role) return null;
  if (isTeamManager(role)) return { vault, perm: 'edit' };
  const m = get<{ permission: Perm }>('SELECT permission FROM vault_members WHERE vault_id = ? AND user_id = ?', vault.id, user.id);
  return m ? { vault, perm: m.permission } : null;
}

export function requireVault(user: User, vaultId: string, need: Perm): VaultRow {
  const access = vaultAccess(user, vaultId);
  if (!access) throw notFound('볼트를 찾을 수 없습니다');
  if (need === 'edit' && access.perm !== 'edit') throw forbidden('이 볼트는 보기 권한만 있습니다');
  return access.vault;
}

export type VaultSummary = {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  teamId: string | null;
  teamName: string | null;
  perm: Perm;
  isDefault: boolean;
  // 내 공개키로 봉한 볼트 키(없으면 아직 공유받지 못함), 이 볼트 키를 가진 사람이 한 명이라도 있는지
  wrappedKey: string | null;
  keyed: boolean;
  // 그 볼트 키를 봉한 사람(서버 기록). 화면은 봉한 공개키가 정말 이 사람 것인지 암호문으로 확인한다
  wrappedBy: { userId: string; name: string; publicKey: string | null } | null;
};

function keyInfo(vaultId: string, userId: string) {
  const mine = get<{ wrapped: string; wrapped_by: string | null; by_name: string | null; by_key: string | null }>(
    'SELECT vk.wrapped, vk.wrapped_by, u.name AS by_name, u.public_key AS by_key FROM vault_keys vk LEFT JOIN users u ON u.id = vk.wrapped_by WHERE vk.vault_id = ? AND vk.user_id = ?',
    vaultId,
    userId,
  );
  const any = mine ? true : Boolean(get('SELECT 1 AS x FROM vault_keys WHERE vault_id = ? LIMIT 1', vaultId));
  return {
    wrappedKey: mine?.wrapped ?? null,
    keyed: any,
    wrappedBy: mine?.wrapped_by ? { userId: mine.wrapped_by, name: mine.by_name ?? '', publicKey: mine.by_key } : null,
  };
}

export function listVaults(user: User): VaultSummary[] {
  const personal = all<VaultRow>("SELECT * FROM vaults WHERE kind = 'personal' AND owner_id = ?", user.id).map(
    (v): VaultSummary => ({ id: v.id, kind: 'personal', name: v.name, teamId: null, teamName: null, perm: 'edit', isDefault: true, ...keyInfo(v.id, user.id) }),
  );
  const team = all<VaultRow & { team_name: string; role: TeamRole; permission: Perm | null }>(
    `SELECT v.*, t.name AS team_name, tm.role, vm.permission
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN vaults v ON v.team_id = tm.team_id
       LEFT JOIN vault_members vm ON vm.vault_id = v.id AND vm.user_id = tm.user_id
      WHERE tm.user_id = ?
      ORDER BY t.name, v.is_default DESC, v.name`,
    user.id,
  )
    .filter((v) => isTeamManager(v.role) || v.permission)
    .map(
      (v): VaultSummary => ({
        id: v.id,
        kind: 'team',
        name: v.name,
        teamId: v.team_id,
        teamName: v.team_name,
        perm: isTeamManager(v.role) ? 'edit' : v.permission!,
        isDefault: Boolean(v.is_default),
        ...keyInfo(v.id, user.id),
      }),
    );
  return [...personal, ...team];
}

export function createVault(opts: { kind: 'personal'; ownerId: string; name: string } | { kind: 'team'; teamId: string; name: string; isDefault: boolean }) {
  const id = newId();
  run(
    "INSERT INTO vaults (id, kind, team_id, owner_id, name, is_default, dek, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?)",
    id,
    opts.kind,
    opts.kind === 'team' ? opts.teamId : null,
    opts.kind === 'personal' ? opts.ownerId : null,
    opts.name,
    opts.kind === 'personal' ? true : opts.isDefault,
    now(),
  );
  return id;
}

export function ensurePersonalVault(userId: string) {
  const v = get<{ id: string }>("SELECT id FROM vaults WHERE kind = 'personal' AND owner_id = ?", userId);
  return v?.id ?? createVault({ kind: 'personal', ownerId: userId, name: 'Personal' });
}

// 팀에 들어오면 기본 팀 볼트를 볼 수 있게 한다(member 는 view, owner/admin 은 원래 전부 edit)
export function addTeamMember(teamId: string, userId: string, role: TeamRole) {
  tx(() => {
    run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', teamId, userId, role, now());
    const def = get<{ id: string }>("SELECT id FROM vaults WHERE team_id = ? AND is_default = 1", teamId);
    if (def && role === 'member') {
      run("INSERT INTO vault_members (vault_id, user_id, permission) VALUES (?, ?, 'view') ON CONFLICT DO NOTHING", def.id, userId);
    }
  });
}

export function hasAnyTeam(userId: string) {
  return Boolean(get('SELECT 1 AS x FROM team_members WHERE user_id = ? LIMIT 1', userId));
}

export function hasPendingInvite(email: string) {
  return Boolean(get('SELECT 1 AS x FROM invites WHERE email = ? LIMIT 1', email.toLowerCase()));
}

// 게이트웨이를 쓸 수 있는 사람: 막히지 않았고, 서버 관리자이거나, 누구나 가입하는 서버이거나, 팀이 하나라도 있거나,
// 수락을 기다리는 초대가 있는 사람 (초대는 받은 사람이 로그인해서 수락해야 들어간다)
export function canUseGateway(user: { id: string; is_admin: number; disabled: number; email?: string }) {
  return !user.disabled && (Boolean(user.is_admin) || config.openSignup || hasAnyTeam(user.id) || Boolean(user.email && hasPendingInvite(user.email)));
}

// 내게 온, 아직 수락하지 않은 팀 초대
export function pendingInvites(user: { email: string; google_sub: string | null; password_hash: string | null }) {
  return all<{ id: string; teamId: string; teamName: string; role: TeamRole; invitedBy: string | null; createdAt: number }>(
    `SELECT i.id, i.team_id AS teamId, t.name AS teamName, i.role, u.name AS invitedBy, i.created_at AS createdAt
       FROM invites i JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.email = ? ORDER BY i.created_at`,
    user.email.toLowerCase(),
  ).map((i) => ({ ...i, needsCode: needsInviteCode(user) }));
}

// 아이디·비밀번호로 만든 계정(Google 이 확인한 이메일이 아님)은 초대를 수락할 때 초대 코드도 내야 한다 —
// 이메일만 같으면 남이 먼저 만든 계정이 그 사람 앞으로 온 초대를 가져가게 된다 (보안 점검 H-1)
export const needsInviteCode = (user: { google_sub: string | null; password_hash: string | null }) => !user.google_sub && Boolean(user.password_hash);

// 팀을 만들 수 있는 사람: 서버 관리자, 또는 누구나 가입하는 서버의 모든 사람
export const canCreateTeams = (user: { is_admin: number }) => Boolean(user.is_admin) || config.openSignup;

// 볼트를 더 볼 수 없게 된 사람의 볼트 키를 지운다 (팀에서 나감·역할 내림·볼트 권한 해제)
export function pruneVaultKeys() {
  run(
    `DELETE FROM vault_keys WHERE rowid IN (
       SELECT vk.rowid FROM vault_keys vk JOIN vaults v ON v.id = vk.vault_id
        WHERE (v.kind = 'personal' AND v.owner_id <> vk.user_id)
           OR (v.kind = 'team' AND NOT EXISTS (
                SELECT 1 FROM team_members tm
                 WHERE tm.team_id = v.team_id AND tm.user_id = vk.user_id
                   AND (tm.role IN ('owner', 'admin')
                        OR EXISTS (SELECT 1 FROM vault_members vm WHERE vm.vault_id = v.id AND vm.user_id = vk.user_id)))))`,
  );
}
