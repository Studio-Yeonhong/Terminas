// 내 계정: 공개키와 "잠긴 계정 키 묶음"만 보관한다.
// 묶음 안의 개인키·계정 키는 암호화 비밀번호(또는 복구 키)로만 풀린다 — 서버는 풀 수 없다.
import type { FastifyInstance } from 'fastify';
import { requireUser, sessionAgeMs, sessionHash } from '../auth.ts';
import { endLive } from '../live.ts';
import { all, get, now, run, tx } from '../db.ts';
import { addTeamMember, canCreateTeams, listVaults, needsInviteCode, pendingInvites, type TeamRole, type User } from '../access.ts';
import { audit, badRequest, body, conflict, forbidden, HttpError, notFound, str } from '../http.ts';
import { sameString, sha256 } from '../crypto.ts';
import { config } from '../config.ts';
import { checkNewPassword, hashPassword, hashSlot, normalizeInviteCode, passwordField, Throttle, tooMany, verifyPassword } from '../password.ts';

// 초대 수락 때 초대 코드를 틀린 횟수 (사람마다 15분에 10번)
const acceptThrottle = new Throttle(10, 15 * 60 * 1000);

// 로그인 비밀번호 바꾸기에서 지금 비밀번호를 틀린 횟수 (사람마다 15분에 10번)
const changeThrottle = new Throttle(10, 15 * 60 * 1000);

const B64_32 = /^[A-Za-z0-9+/]{43}=$/;
const SEALED = /^v1\.[A-Za-z0-9+/]+=*$/;
const HEX64 = /^[0-9a-f]{64}$/;
// 초기화는 방금 로그인한(Google 로 다시 확인한) 세션에서만 받는다 (보안 검토 F-06)
const RESET_LOGIN_WINDOW_MS = 10 * 60 * 1000;

type Bundle = {
  v: 1;
  kdf: { alg: 'argon2id'; salt: string; m: number; t: number; p: number };
  encPrivateKey: string;
  wrapPw: string;
  wrapRecovery: string;
};

function parseBundle(value: unknown): Bundle {
  const b = value as Bundle;
  const ok =
    b &&
    typeof b === 'object' &&
    b.v === 1 &&
    b.kdf?.alg === 'argon2id' &&
    typeof b.kdf.salt === 'string' &&
    b.kdf.salt.length <= 64 &&
    [b.kdf.m, b.kdf.t, b.kdf.p].every((n) => Number.isInteger(n)) &&
    // 화면(e2ee.ts KDF_LIMITS)과 같은 범위: 너무 약하게도, 기기를 멈출 만큼 무겁게도 못 한다
    b.kdf.m >= 19 * 1024 &&
    b.kdf.m <= 256 * 1024 &&
    b.kdf.t >= 1 &&
    b.kdf.t <= 10 &&
    b.kdf.p >= 1 &&
    b.kdf.p <= 4 &&
    [b.encPrivateKey, b.wrapPw, b.wrapRecovery].every((s) => typeof s === 'string' && s.length <= 1024 && SEALED.test(s));
  if (!ok) throw badRequest('키 묶음 형식이 올바르지 않습니다');
  return { v: 1, kdf: { alg: 'argon2id', salt: b.kdf.salt, m: b.kdf.m, t: b.kdf.t, p: b.kdf.p }, encPrivateKey: b.encPrivateKey, wrapPw: b.wrapPw, wrapRecovery: b.wrapRecovery };
}

function publicKey(value: unknown) {
  if (typeof value !== 'string' || !B64_32.test(value)) throw badRequest('공개키 형식이 올바르지 않습니다');
  return value;
}

function proof(value: unknown) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw badRequest('확인 값이 올바르지 않습니다');
  return value;
}

// 계정 키 증명은 해시로만 보관한다 (db.ts 가 예전 원문도 바꿔 둔다) — DB 를 읽은 사람이 그 값을 내밀지 못하게
const proofHash = (p: string) => `h1:${sha256(p)}`;
const proofMatches = (p: string, stored: string) => (stored.startsWith('h1:') ? sameString(proofHash(p), stored) : sameString(p, stored));

export function meOut(user: User) {
  const teams = all<{ id: string; name: string; role: TeamRole }>(
    'SELECT t.id, t.name, tm.role FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY t.name',
    user.id,
  );
  return {
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url, isAdmin: Boolean(user.is_admin), canCreateTeams: canCreateTeams(user) },
    // 로그인 방법: 이 서버가 비밀번호 로그인을 받는지, 이 사람에게 로그인 비밀번호·Google 연결이 있는지
    login: { password: config.passwordLogin, hasPassword: Boolean(user.password_hash), google: Boolean(user.google_sub) },
    crypto: user.public_key && user.key_bundle ? { publicKey: user.public_key, bundle: JSON.parse(user.key_bundle) as Bundle, createdAt: user.keys_created_at } : null,
    teams,
    vaults: listVaults(user),
    // 수락을 기다리는 팀 초대 (받은 사람이 수락해야 팀에 들어간다)
    invites: pendingInvites(user),
  };
}

export function accountRoutes(app: FastifyInstance) {
  app.get('/api/me', async (req) => meOut(requireUser(req)));

  // 처음 설정: 키 쌍과 잠긴 묶음을 올린다 (이미 있으면 거절 — 바꿀 때는 PUT, 다시 만들 때는 reset)
  app.post('/api/me/keys', async (req) => {
    const user = requireUser(req);
    const b = body(req.body);
    const pub = publicKey(b.publicKey);
    const bundle = parseBundle(b.bundle);
    const p = proof(b.proof);
    const res = run(
      'UPDATE users SET public_key = ?, key_bundle = ?, key_proof = ?, keys_created_at = ? WHERE id = ? AND public_key IS NULL',
      pub,
      JSON.stringify(bundle),
      proofHash(p),
      now(),
      user.id,
    );
    if (!res.changes) throw conflict('이미 암호화 설정이 되어 있습니다. 새로고침해 주세요.');
    audit({ userId: user.id, action: 'keys_setup', ip: req.ip });
    return { ok: true };
  });

  // 암호화 비밀번호 바꾸기·복구 키 새로 받기: 계정 키를 가진 사람만(proof) 묶음을 바꿀 수 있다
  app.put('/api/me/keys', async (req) => {
    const user = requireUser(req);
    const b = body(req.body);
    const bundle = parseBundle(b.bundle);
    if (!user.key_proof || !user.key_bundle || !proofMatches(proof(b.proof), user.key_proof)) throw forbidden('계정 키 확인에 실패했습니다');
    const current = JSON.parse(user.key_bundle) as Bundle;
    if (bundle.encPrivateKey !== current.encPrivateKey) throw badRequest('개인키는 바꿀 수 없습니다');
    run('UPDATE users SET key_bundle = ? WHERE id = ?', JSON.stringify(bundle), user.id);
    audit({ userId: user.id, action: b.reason === 'recovery' ? 'keys_recovered' : b.reason === 'new_recovery' ? 'keys_new_recovery' : 'keys_password', ip: req.ip });
    return { ok: true };
  });

  // 로그인 비밀번호 정하기·바꾸기 (비밀번호 로그인 서버). 이미 있으면 지금 비밀번호를, 없으면 방금 로그인한 세션을 요구한다.
  // 바꾸면 다른 기기·브라우저의 로그인은 끊는다. (볼트를 여는 암호화 비밀번호와는 별개 — 서버는 그것을 모른다)
  app.put('/api/me/password', async (req) => {
    const user = requireUser(req);
    if (!config.passwordLogin) throw new HttpError(404, 'not_found');
    const b = body(req.body);
    const next = passwordField(b, 'password');
    checkNewPassword(next);
    if (user.password_hash) {
      if (changeThrottle.blocked(user.id)) throw tooMany();
      // 느린 해시 앞에서 먼저 센다 (한꺼번에 보내 제한을 넘지 못하게)
      changeThrottle.fail(user.id);
      const release = hashSlot(`change:${user.id}`);
      let ok: boolean;
      try {
        ok = await verifyPassword(passwordField(b, 'current'), user.password_hash);
      } finally {
        release();
      }
      if (!ok) throw new HttpError(400, 'bad_password', '지금 비밀번호가 맞지 않습니다');
      changeThrottle.reset(user.id);
    } else {
      const age = sessionAgeMs(req);
      if (age === null || age > RESET_LOGIN_WINDOW_MS) throw new HttpError(403, 'reauth_required', '안전을 위해 다시 로그인한 뒤 10분 안에 정해 주세요.');
    }
    const release = hashSlot(`change:${user.id}`);
    let hash: string;
    try {
      hash = await hashPassword(next);
    } finally {
      release();
    }
    const current = sessionHash(req);
    tx(() => {
      run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, now(), user.id);
      run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', user.id, current);
    });
    endLive((l) => l.userId === user.id && l.sessionHash !== current, 'password changed');
    audit({ userId: user.id, action: user.password_hash ? 'password_change' : 'password_set', ip: req.ip });
    return { ok: true };
  });

  // 비밀번호도 복구 키도 잃었을 때: 새 키로 다시 시작. 개인 볼트 내용은 지우고, 팀 볼트는 관리자가 다시 공유해 준다.
  // 지금 세션으로 초기화할 수 있는지 (화면이 비밀번호를 받기 전에 먼저 묻는다)
  app.get('/api/me/keys/reset', async (req) => {
    requireUser(req);
    const age = sessionAgeMs(req);
    return { allowed: age !== null && age <= RESET_LOGIN_WINDOW_MS, windowMinutes: RESET_LOGIN_WINDOW_MS / 60_000 };
  });

  app.post('/api/me/keys/reset', async (req) => {
    const user = requireUser(req);
    const b = body(req.body);
    if (b.confirm !== 'RESET') throw badRequest('확인이 필요합니다');
    // 세션만 훔친 사람이 개인 볼트를 지우지 못하게, 로그인한 지 10분 안에만 받는다
    const age = sessionAgeMs(req);
    if (age === null || age > RESET_LOGIN_WINDOW_MS) throw new HttpError(403, 'reauth_required', '안전을 위해 다시 로그인한 뒤 10분 안에 초기화해 주세요.');
    const current = sessionHash(req);
    const pub = publicKey(b.publicKey);
    const bundle = parseBundle(b.bundle);
    const p = proof(b.proof);
    tx(() => {
      run('DELETE FROM vault_keys WHERE user_id = ?', user.id);
      run("DELETE FROM items WHERE vault_id IN (SELECT id FROM vaults WHERE kind = 'personal' AND owner_id = ?)", user.id);
      run('UPDATE users SET public_key = ?, key_bundle = ?, key_proof = ?, keys_created_at = ? WHERE id = ?', pub, JSON.stringify(bundle), proofHash(p), now(), user.id);
      // 다른 기기·브라우저의 로그인은 모두 끊는다 (옛 키로 열려 있던 곳)
      run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', user.id, current);
    });
    endLive((l) => l.userId === user.id && l.sessionHash !== current, 'keys reset');
    audit({ userId: user.id, action: 'keys_reset', ip: req.ip });
    return { ok: true };
  });

  // ---------- 내게 온 팀 초대: 수락해야 팀에 들어간다 (보안 점검 M-3) ----------
  app.get('/api/me/invites', async (req) => pendingInvites(requireUser(req)));

  app.post('/api/me/invites/:inviteId/accept', async (req) => {
    const user = requireUser(req);
    const { inviteId } = req.params as { inviteId: string };
    const invite = get<{ id: string; team_id: string; role: TeamRole; code_hash: string | null; code_expires_at: number | null }>(
      'SELECT id, team_id, role, code_hash, code_expires_at FROM invites WHERE id = ? AND email = ?',
      inviteId,
      user.email.toLowerCase(),
    );
    if (!invite) throw notFound('초대를 찾을 수 없습니다');
    // 아이디·비밀번호 계정은 초대한 사람에게 받은 초대 코드도 낸다 (이메일을 확인한 적이 없는 계정이라)
    if (needsInviteCode(user)) {
      if (acceptThrottle.blocked(user.id)) throw tooMany();
      const code = normalizeInviteCode(str(body(req.body), 'code', { optional: true, max: 64 }) ?? '');
      if (!invite.code_hash || (invite.code_expires_at ?? 0) <= now() || !sameString(invite.code_hash, sha256(code))) {
        acceptThrottle.fail(user.id);
        throw new HttpError(400, 'invite_bad', '초대 코드가 맞지 않거나 기한이 지났습니다');
      }
      acceptThrottle.reset(user.id);
    }
    tx(() => {
      addTeamMember(invite.team_id, user.id, invite.role);
      run('DELETE FROM invites WHERE id = ?', invite.id);
    });
    audit({ userId: user.id, teamId: invite.team_id, action: 'invite_accept', target: user.email, ip: req.ip });
    return { ok: true, teamId: invite.team_id };
  });

  app.delete('/api/me/invites/:inviteId', async (req) => {
    const user = requireUser(req);
    const { inviteId } = req.params as { inviteId: string };
    const invite = get<{ id: string; team_id: string }>('SELECT id, team_id FROM invites WHERE id = ? AND email = ?', inviteId, user.email.toLowerCase());
    if (!invite) throw notFound('초대를 찾을 수 없습니다');
    run('DELETE FROM invites WHERE id = ?', invite.id);
    audit({ userId: user.id, teamId: invite.team_id, action: 'invite_decline', target: user.email, ip: req.ip });
    return { ok: true };
  });

  // 팀원 공개키(지문 대조용)
  app.get('/api/users/:userId/public-key', async (req) => {
    const user = requireUser(req);
    const { userId } = req.params as { userId: string };
    const shared = get(
      'SELECT 1 AS x FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1',
      user.id,
      userId,
    );
    if (!shared && userId !== user.id) throw forbidden();
    const row = get<{ public_key: string | null; keys_created_at: number | null }>('SELECT public_key, keys_created_at FROM users WHERE id = ?', userId);
    return { publicKey: row?.public_key ?? null, createdAt: row?.keys_created_at ?? null };
  });
}
