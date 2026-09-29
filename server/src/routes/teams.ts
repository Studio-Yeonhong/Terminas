import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import { all, get, newId, now, run, tx } from '../db.ts';
import { addTeamMember, canCreateTeams, createVault, isTeamManager, pruneVaultKeys, requireTeamRole, teamRole, type Perm, type TeamRole, type VaultRow } from '../access.ts';
import { audit, badRequest, body, forbidden, HttpError, notFound, str } from '../http.ts';
import { config } from '../config.ts';
import { sha256 } from '../crypto.ts';
import { INVITE_CODE_TTL_MS, newInviteCode, normalizeInviteCode, Throttle } from '../password.ts';

// 초대 보내기: 사람마다 하루 100개 (누구나 가입하는 서버에서 초대로 남을 괴롭히지 못하게)
const inviteThrottle = new Throttle(100, 24 * 60 * 60 * 1000);

// 비밀번호 로그인 서버의 초대: 초대받은 사람이 처음 비밀번호를 정할 때 낼 코드를 만든다(해시만 남기고 원문은 이번 한 번만 보여 준다)
function issueInviteCode(inviteId: string) {
  const code = newInviteCode();
  const expiresAt = now() + INVITE_CODE_TTL_MS;
  run('UPDATE invites SET code_hash = ?, code_expires_at = ? WHERE id = ?', sha256(normalizeInviteCode(code)), expiresAt, inviteId);
  return { code, codeExpiresAt: expiresAt };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_OWNED_TEAMS = 20;
const MAX_TEAM_VAULTS = 50;

export function teamRoutes(app: FastifyInstance) {
  app.post('/api/teams', async (req) => {
    const user = requireUser(req);
    if (!canCreateTeams(user)) throw forbidden('팀은 관리자만 만들 수 있습니다');
    // 누구나 가입하는 서버의 남용 막기: 서버 관리자가 아니면 소유한 팀은 MAX_OWNED_TEAMS 개까지
    const owned = get<{ n: number }>("SELECT COUNT(*) AS n FROM team_members WHERE user_id = ? AND role = 'owner'", user.id)!.n;
    if (!user.is_admin && owned >= MAX_OWNED_TEAMS) throw badRequest(`팀은 한 사람이 ${MAX_OWNED_TEAMS}개까지 만들 수 있습니다`);
    const name = str(body(req.body), 'name', { min: 1, max: 60 })!;
    const id = newId();
    // 볼트 키는 만든 사람의 앱·웹이 곧바로 만들어 올린다 (POST /api/vaults/:id/key)
    const vaultId = tx(() => {
      run('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', id, name, user.id, now());
      const v = createVault({ kind: 'team', teamId: id, name: 'Team', isDefault: true });
      addTeamMember(id, user.id, 'owner');
      return v;
    });
    audit({ userId: user.id, teamId: id, action: 'team_create', target: name, ip: req.ip });
    return { id, vaultId };
  });

  app.patch('/api/teams/:teamId', async (req) => {
    const user = requireUser(req);
    const { teamId } = req.params as { teamId: string };
    requireTeamRole(user, teamId, true);
    const name = str(body(req.body), 'name', { min: 1, max: 60 })!;
    run('UPDATE teams SET name = ? WHERE id = ?', name, teamId);
    audit({ userId: user.id, teamId, action: 'team_rename', target: name, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/teams/:teamId', async (req) => {
    const user = requireUser(req);
    const { teamId } = req.params as { teamId: string };
    const myRole = requireTeamRole(user, teamId, false);
    const manager = isTeamManager(myRole);
    const team = get<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ?', teamId)!;
    const members = all<{ userId: string; email: string; name: string; avatarUrl: string; role: TeamRole; joinedAt: number; lastLoginAt: number | null; publicKey: string | null }>(
      `SELECT u.id AS userId, u.email, u.name, u.avatar_url AS avatarUrl, tm.role, tm.joined_at AS joinedAt, u.last_login_at AS lastLoginAt, u.public_key AS publicKey
         FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
        ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
      teamId,
      // 마지막 로그인 시각은 팀 관리자에게만
    ).map((m) => (manager || m.userId === user.id ? m : { ...m, lastLoginAt: null }));
    const invites = isTeamManager(myRole)
      ? all('SELECT id, email, role, created_at AS createdAt, code_expires_at AS codeExpiresAt FROM invites WHERE team_id = ? ORDER BY created_at DESC', teamId)
      : [];
    const vaults = all<{ id: string; name: string; isDefault: number }>(
      'SELECT id, name, is_default AS isDefault FROM vaults WHERE team_id = ? ORDER BY is_default DESC, name',
      teamId,
    ).map((v) => ({ ...v, isDefault: Boolean(v.isDefault) }));
    // 소유자에게만: 이 팀이 지워지면 소속 팀이 하나도 남지 않는 사람 수 (관리자 제외 — 그 사람들은 로그인할 수 없게 된다)
    const soleMembers =
      myRole === 'owner'
        ? get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM team_members tm JOIN users u ON u.id = tm.user_id
              WHERE tm.team_id = ? AND u.is_admin = 0
                AND NOT EXISTS (SELECT 1 FROM team_members o WHERE o.user_id = tm.user_id AND o.team_id != tm.team_id)`,
            teamId,
          )!.n
        : undefined;
    return { team, myRole, members, invites, vaults, soleMembers };
  });

  // 팀 삭제: 소유자만, 팀 이름을 그대로 적어야 한다. 팀 볼트와 그 안의 항목·볼트 키, 팀원 관계, 초대가 함께 지워진다
  // (외래 키 ON DELETE CASCADE). 기록(audit_log)은 남는다.
  app.delete('/api/teams/:teamId', async (req) => {
    const user = requireUser(req);
    const { teamId } = req.params as { teamId: string };
    const role = requireTeamRole(user, teamId, true);
    if (role !== 'owner') throw forbidden('팀 삭제는 팀 소유자만 할 수 있습니다');
    const team = get<{ name: string }>('SELECT name FROM teams WHERE id = ?', teamId);
    if (!team) throw notFound('팀을 찾을 수 없습니다');
    if (body(req.body).confirm !== team.name) throw badRequest('확인을 위해 팀 이름을 정확히 적어 주세요');
    const vaults = all<{ id: string }>('SELECT id FROM vaults WHERE team_id = ?', teamId).length;
    tx(() => {
      run('DELETE FROM teams WHERE id = ?', teamId);
      pruneVaultKeys();
    });
    audit({ userId: user.id, teamId, action: 'team_delete', target: team.name, detail: { vaults }, ip: req.ip });
    return { ok: true };
  });

  // 초대장을 남긴다. 받은 사람이 로그인해서 수락해야 팀에 들어간다 (이미 계정이 있어도 — 보안 점검 M-3).
  // 계정이 있든 없든 답은 같다 (초대로 가입 여부를 알아내지 못하게)
  app.post('/api/teams/:teamId/invites', async (req) => {
    const user = requireUser(req);
    const { teamId } = req.params as { teamId: string };
    const myRole = requireTeamRole(user, teamId, true);
    const b = body(req.body);
    const email = str(b, 'email', { min: 3, max: 200 })!.toLowerCase();
    const role = (str(b, 'role', { optional: true }) ?? 'member') as TeamRole;
    if (!EMAIL.test(email)) throw badRequest('이메일 형식이 올바르지 않습니다');
    if (role !== 'member' && role !== 'admin') throw badRequest('역할은 admin 또는 member입니다');
    if (role === 'admin' && myRole !== 'owner') throw forbidden('관리자 초대는 팀 소유자만 할 수 있습니다');
    if (inviteThrottle.blocked(user.id)) throw new HttpError(429, 'too_many', '초대를 너무 많이 보냈습니다. 내일 다시 시도해 주세요.');
    inviteThrottle.fail(user.id);

    const existing = get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
    if (existing && teamRole(existing.id, teamId)) throw badRequest('이미 팀에 있는 사람입니다');
    run(
      'INSERT INTO invites (id, team_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, email) DO UPDATE SET role = excluded.role',
      newId(),
      teamId,
      email,
      role,
      user.id,
      now(),
    );
    audit({ userId: user.id, teamId, action: 'invite_create', target: email, detail: { role }, ip: req.ip });
    if (!config.passwordLogin) return { invited: true };
    const invite = get<{ id: string }>('SELECT id FROM invites WHERE team_id = ? AND email = ?', teamId, email)!;
    return { invited: true, ...issueInviteCode(invite.id) };
  });

  // 초대 코드 다시 만들기 (잃어버렸거나 기한이 지났을 때). 전에 준 코드는 더는 쓸 수 없다
  app.post('/api/teams/:teamId/invites/:inviteId/code', async (req) => {
    const user = requireUser(req);
    if (!config.passwordLogin) throw notFound();
    const { teamId, inviteId } = req.params as { teamId: string; inviteId: string };
    const myRole = requireTeamRole(user, teamId, true);
    const invite = get<{ email: string; role: TeamRole }>('SELECT email, role FROM invites WHERE id = ? AND team_id = ?', inviteId, teamId);
    if (!invite) throw notFound();
    if (invite.role === 'admin' && myRole !== 'owner') throw forbidden('관리자 초대는 팀 소유자만 할 수 있습니다');
    const out = issueInviteCode(inviteId);
    audit({ userId: user.id, teamId, action: 'invite_code', target: invite.email, ip: req.ip });
    return out;
  });

  app.delete('/api/teams/:teamId/invites/:inviteId', async (req) => {
    const user = requireUser(req);
    const { teamId, inviteId } = req.params as { teamId: string; inviteId: string };
    requireTeamRole(user, teamId, true);
    const invite = get<{ email: string }>('SELECT email FROM invites WHERE id = ? AND team_id = ?', inviteId, teamId);
    if (!invite) throw notFound();
    run('DELETE FROM invites WHERE id = ?', inviteId);
    audit({ userId: user.id, teamId, action: 'invite_delete', target: invite.email, ip: req.ip });
    return { ok: true };
  });

  app.patch('/api/teams/:teamId/members/:userId', async (req) => {
    const user = requireUser(req);
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    const myRole = requireTeamRole(user, teamId, true);
    if (myRole !== 'owner') throw forbidden('역할 변경은 팀 소유자만 할 수 있습니다');
    const role = str(body(req.body), 'role')! as TeamRole;
    if (!['owner', 'admin', 'member'].includes(role)) throw badRequest('역할이 올바르지 않습니다');
    const current = teamRole(userId, teamId);
    if (!current) throw notFound('팀원을 찾을 수 없습니다');
    if (userId === user.id && role !== 'owner') {
      const owners = get<{ n: number }>("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'", teamId)!.n;
      if (owners <= 1) throw badRequest('마지막 소유자는 역할을 내릴 수 없습니다');
    }
    tx(() => {
      run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId);
      if (role === 'member' && current !== 'member') {
        // owner/admin 이던 사람이 member 로 내려가면 기본 볼트 보기 권한만 남긴다 — 전에 받아 둔 다른 볼트 권한·키도 지운다
        const def = get<{ id: string }>('SELECT id FROM vaults WHERE team_id = ? AND is_default = 1', teamId);
        run('DELETE FROM vault_members WHERE user_id = ? AND vault_id IN (SELECT id FROM vaults WHERE team_id = ?)', userId, teamId);
        if (def) run("INSERT INTO vault_members (vault_id, user_id, permission) VALUES (?, ?, 'view')", def.id, userId);
        pruneVaultKeys();
      }
    });
    const target = get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)!.email;
    audit({ userId: user.id, teamId, action: 'member_role', target, detail: { from: current, to: role }, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/teams/:teamId/members/:userId', async (req) => {
    const user = requireUser(req);
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    const myRole = requireTeamRole(user, teamId, userId !== user.id);
    const role = teamRole(userId, teamId);
    if (!role) throw notFound('팀원을 찾을 수 없습니다');
    if (role === 'owner' && myRole !== 'owner') throw forbidden('소유자는 소유자만 내보낼 수 있습니다');
    if (role === 'owner') {
      const owners = get<{ n: number }>("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'", teamId)!.n;
      if (owners <= 1) throw badRequest('마지막 소유자는 나갈 수 없습니다');
    }
    tx(() => {
      run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
      run('DELETE FROM vault_members WHERE user_id = ? AND vault_id IN (SELECT id FROM vaults WHERE team_id = ?)', userId, teamId);
      pruneVaultKeys();
    });
    const target = get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email ?? userId;
    audit({ userId: user.id, teamId, action: 'member_remove', target, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/teams/:teamId/vaults', async (req) => {
    const user = requireUser(req);
    const { teamId } = req.params as { teamId: string };
    requireTeamRole(user, teamId, true);
    const name = str(body(req.body), 'name', { min: 1, max: 60 })!;
    if (get<{ n: number }>('SELECT COUNT(*) AS n FROM vaults WHERE team_id = ?', teamId)!.n >= MAX_TEAM_VAULTS) throw badRequest(`팀 볼트는 ${MAX_TEAM_VAULTS}개까지 만들 수 있습니다`);
    const id = createVault({ kind: 'team', teamId, name, isDefault: false });
    audit({ userId: user.id, teamId, vaultId: id, action: 'vault_create', target: name, ip: req.ip });
    return { id };
  });

  app.patch('/api/vaults/:vaultId', async (req) => {
    const user = requireUser(req);
    const vault = teamVault(req.params);
    requireTeamRole(user, vault.team_id!, true);
    const name = str(body(req.body), 'name', { min: 1, max: 60 })!;
    run('UPDATE vaults SET name = ? WHERE id = ?', name, vault.id);
    audit({ userId: user.id, teamId: vault.team_id, vaultId: vault.id, action: 'vault_rename', target: name, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/vaults/:vaultId', async (req) => {
    const user = requireUser(req);
    const vault = teamVault(req.params);
    requireTeamRole(user, vault.team_id!, true);
    if (vault.is_default) throw badRequest('기본 팀 볼트는 지울 수 없습니다');
    run('DELETE FROM vaults WHERE id = ?', vault.id);
    audit({ userId: user.id, teamId: vault.team_id, action: 'vault_delete', target: vault.name, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/vaults/:vaultId/members', async (req) => {
    const user = requireUser(req);
    const vault = teamVault(req.params);
    requireTeamRole(user, vault.team_id!, true);
    return all<{ userId: string; email: string; name: string; avatarUrl: string; role: TeamRole; permission: Perm | null; hasKeys: number; hasVaultKey: number }>(
      `SELECT u.id AS userId, u.email, u.name, u.avatar_url AS avatarUrl, tm.role, vm.permission,
              (u.public_key IS NOT NULL) AS hasKeys,
              EXISTS (SELECT 1 FROM vault_keys vk WHERE vk.vault_id = ? AND vk.user_id = u.id) AS hasVaultKey
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         LEFT JOIN vault_members vm ON vm.vault_id = ? AND vm.user_id = tm.user_id
        WHERE tm.team_id = ?
        ORDER BY u.name`,
      vault.id,
      vault.id,
      vault.team_id,
    ).map((m) => ({ ...m, hasKeys: Boolean(m.hasKeys), hasVaultKey: Boolean(m.hasVaultKey), permission: isTeamManager(m.role) ? 'edit' : m.permission, implicit: isTeamManager(m.role) }));
  });

  app.put('/api/vaults/:vaultId/members/:userId', async (req) => {
    const user = requireUser(req);
    const vault = teamVault(req.params);
    const { userId } = req.params as { userId: string };
    requireTeamRole(user, vault.team_id!, true);
    const role = teamRole(userId, vault.team_id!);
    if (!role) throw notFound('팀원이 아닙니다');
    if (isTeamManager(role)) throw badRequest('팀 소유자·관리자는 모든 볼트를 편집할 수 있습니다');
    const permission = (body(req.body).permission ?? null) as Perm | null;
    if (permission !== null && permission !== 'edit' && permission !== 'view') throw badRequest('권한은 edit, view, null 중 하나입니다');
    if (permission) {
      run(
        'INSERT INTO vault_members (vault_id, user_id, permission) VALUES (?, ?, ?) ON CONFLICT (vault_id, user_id) DO UPDATE SET permission = excluded.permission',
        vault.id,
        userId,
        permission,
      );
    } else {
      run('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?', vault.id, userId);
      pruneVaultKeys();
    }
    const target = get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)!.email;
    audit({ userId: user.id, teamId: vault.team_id, vaultId: vault.id, action: 'vault_member_set', target, detail: { permission }, ip: req.ip });
    return { ok: true };
  });
}

function teamVault(params: unknown): VaultRow {
  const { vaultId } = params as { vaultId: string };
  const vault = get<VaultRow>('SELECT * FROM vaults WHERE id = ?', vaultId);
  if (!vault || vault.kind !== 'team') throw notFound('볼트를 찾을 수 없습니다');
  return vault;
}
