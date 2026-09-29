// 관리 콘솔의 API (서버 PC 안에서만 열리는 관리 서버, console/index.ts — 공개 서버에는 없다):
// 가입한 사람 목록·막기·서버 관리자 지정·로그아웃시키기·2단계 인증 초기화·계정 지우기, 팀 목록, 서버 기록.
// 볼트 내용은 서버도 관리자도 볼 수 없다 — 여기서 다루는 것은 계정 정보와 시각·개수뿐이다.
// 로그인 확인은 console/index.ts 의 훅이 한다. 기록(audit_log)에는 행위자 없이 detail.by = 'console' 로 남는다.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { endLive } from '../live.ts';
import { all, get, now, run, tx } from '../db.ts';
import { audit, badRequest, body, conflict, notFound, str } from '../http.ts';

const PAGE = 100;
const DAY = 24 * 60 * 60 * 1000;

type Target = { id: string; email: string; is_admin: number; disabled: number; totp_secret: string | null };
function target(req: FastifyRequest) {
  const { userId } = req.params as { userId: string };
  const t = get<Target>('SELECT id, email, is_admin, disabled, totp_secret FROM users WHERE id = ?', userId);
  if (!t) throw notFound('사용자를 찾을 수 없습니다');
  return t;
}
const BY = { by: 'console' };

// 그 사람의 모든 로그인과 열려 있던 웹 접속(중계)을 끊는다
function signOutEverywhere(userId: string) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
  endLive((l) => l.userId === userId, 'signed out by admin');
}

const likeText = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function consoleRoutes(app: FastifyInstance) {
  app.get('/admin/api/stats', async (req) => {
    const t = now();
    const n = (sql: string, ...args: number[]) => get<{ n: number }>(sql, ...args)!.n;
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      admins: n('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
      disabled: n('SELECT COUNT(*) AS n FROM users WHERE disabled = 1'),
      new7: n('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - 7 * DAY),
      active7: n('SELECT COUNT(*) AS n FROM users WHERE last_login_at > ?', t - 7 * DAY),
      active30: n('SELECT COUNT(*) AS n FROM users WHERE last_login_at > ?', t - 30 * DAY),
      teams: n('SELECT COUNT(*) AS n FROM teams'),
      vaults: n('SELECT COUNT(*) AS n FROM vaults'),
      items: n('SELECT COUNT(*) AS n FROM items'),
      sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', t),
      server: { openSignup: config.openSignup, passwordLogin: config.passwordLogin, google: Boolean(config.googleClientId && config.googleClientSecret) },
    };
  });

  // 가입한 사람들 (최근 가입 순, 100명씩). q: 이메일·이름 검색, filter: all | admins | disabled | nokeys
  app.get('/admin/api/users', async (req) => {
    const q = (req.query as { q?: string; filter?: string; offset?: string }) ?? {};
    const text = String(q.q ?? '').trim().slice(0, 100);
    const filter = String(q.filter ?? 'all');
    const offset = Math.max(0, Math.min(1_000_000, Number(q.offset) || 0));
    const where = [
      text ? "(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')" : '1',
      filter === 'admins' ? 'u.is_admin = 1' : filter === 'disabled' ? 'u.disabled = 1' : filter === 'nokeys' ? 'u.public_key IS NULL' : '1',
    ].join(' AND ');
    const args = text ? [likeText(text), likeText(text)] : [];
    const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, ...args)!.n;
    const users = all<Record<string, number | string | null>>(
      `SELECT u.id, u.email, u.name, u.avatar_url AS avatarUrl, u.is_admin AS isAdmin, u.disabled, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
              u.google_sub IS NOT NULL AS google, u.password_hash IS NOT NULL AS password, u.totp_secret IS NOT NULL AS mfa, u.public_key IS NOT NULL AS keys,
              (SELECT COUNT(*) FROM team_members tm WHERE tm.user_id = u.id) AS teams,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
         FROM users u WHERE ${where}
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      now(),
      ...args,
      PAGE,
      offset,
    ).map((u) => ({ ...u, isAdmin: Boolean(u.isAdmin), disabled: Boolean(u.disabled), google: Boolean(u.google), password: Boolean(u.password), mfa: Boolean(u.mfa), keys: Boolean(u.keys) }));
    return { users, total, offset, pageSize: PAGE };
  });

  // 한 사람의 소속 팀 (지우기 전에 보여 준다)
  app.get('/admin/api/users/:userId', async (req) => {
    const t = target(req);
    const teams = all<{ id: string; name: string; role: string; members: number }>(
      `SELECT t.id, t.name, tm.role, (SELECT COUNT(*) FROM team_members o WHERE o.team_id = t.id) AS members
         FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY t.name`,
      t.id,
    );
    return { id: t.id, email: t.email, teams };
  });

  app.post('/admin/api/users/:userId/disable', async (req) => {
    const t = target(req);
    const disabled = body(req.body).disabled === true;
    run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, t.id);
    if (disabled) signOutEverywhere(t.id);
    audit({ action: disabled ? 'admin_user_disable' : 'admin_user_enable', target: t.email, detail: BY, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/api/users/:userId/admin', async (req) => {
    const t = target(req);
    const admin = body(req.body).admin === true;
    run('UPDATE users SET is_admin = ? WHERE id = ?', admin ? 1 : 0, t.id);
    audit({ action: admin ? 'admin_grant' : 'admin_revoke', target: t.email, detail: BY, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/api/users/:userId/signout', async (req) => {
    const t = target(req);
    signOutEverywhere(t.id);
    audit({ action: 'admin_signout', target: t.email, detail: BY, ip: req.ip });
    return { ok: true };
  });

  // 인증 앱과 복구 코드를 모두 잃은 사람 (npm run mfa:reset 과 같다)
  app.post('/admin/api/users/:userId/mfa-reset', async (req) => {
    const t = target(req);
    if (!t.totp_secret) return { ok: true };
    tx(() => {
      run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_pending_at = NULL, totp_enabled_at = NULL, totp_last_step = 0, mfa_fails = 0, mfa_locked_until = 0, mfa_lock_level = 0 WHERE id = ?', t.id);
      run('DELETE FROM totp_recovery WHERE user_id = ?', t.id);
      run('DELETE FROM sessions WHERE user_id = ? AND mfa_ok = 0', t.id);
    });
    audit({ action: 'mfa_reset', target: t.email, detail: BY, ip: req.ip });
    return { ok: true };
  });

  // 계정 지우기: 이메일을 그대로 적어야 한다. 다른 사람이 있는 팀을 가진 사람은 먼저 그 팀을 넘기거나 지워야 한다.
  // 혼자 있는 팀·개인 볼트·볼트 키·로그인은 함께 지워진다(외래 키 CASCADE). 기록(audit_log)은 남는다.
  app.delete('/admin/api/users/:userId', async (req) => {
    const t = target(req);
    if (str(body(req.body), 'confirm', { max: 200 }) !== t.email) throw badRequest('확인을 위해 이메일을 그대로 적어 주세요');
    const owned = all<{ id: string; name: string; members: number; owners: number }>(
      `SELECT t.id, t.name,
              (SELECT COUNT(*) FROM team_members o WHERE o.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM team_members o WHERE o.team_id = t.id AND o.role = 'owner') AS owners
         FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? AND tm.role = 'owner'`,
      t.id,
    );
    const blocking = owned.filter((o) => o.members > 1 && o.owners === 1);
    if (blocking.length) throw conflict(`다른 팀원이 있는 팀의 소유자입니다. 먼저 소유권을 넘기거나 팀을 지워 주세요: ${blocking.map((b) => b.name).join(', ')}`);
    tx(() => {
      for (const o of owned) if (o.members === 1) run('DELETE FROM teams WHERE id = ?', o.id);
      run('DELETE FROM users WHERE id = ?', t.id);
    });
    endLive((l) => l.userId === t.id, 'account deleted');
    audit({ action: 'admin_user_delete', target: t.email, detail: { ...BY, teamsDeleted: owned.filter((o) => o.members === 1).length }, ip: req.ip });
    return { ok: true };
  });

  app.get('/admin/api/teams', async (req) => {
    return all(
      `SELECT t.id, t.name, t.created_at AS createdAt,
              (SELECT COUNT(*) FROM team_members o WHERE o.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM vaults v WHERE v.team_id = t.id) AS vaults,
              (SELECT group_concat(u.email, ', ') FROM team_members o JOIN users u ON u.id = o.user_id WHERE o.team_id = t.id AND o.role = 'owner') AS owners
         FROM teams t ORDER BY t.created_at DESC LIMIT 500`,
    );
  });

  // 서버 기록: 볼트 밖의 일(로그인·거절·관리 작업·팀 만들기/지우기 등). 볼트 안의 기록은 볼트 키가 있어야 읽히므로 여기엔 없다
  app.get('/admin/api/audit', async (req) => {
    const before = Number((req.query as { before?: string }).before) || Number.MAX_SAFE_INTEGER;
    return all<{ id: number; ts: number; action: string; target: string; detail: string; ip: string; userEmail: string | null }>(
      `SELECT a.id, a.ts, a.action, a.target, a.detail, a.ip, u.email AS userEmail
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.vault_id IS NULL AND a.id < ?
        ORDER BY a.id DESC LIMIT 200`,
      before,
    ).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  });
}
