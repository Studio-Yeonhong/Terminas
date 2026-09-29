import nodeCrypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import { randomToken, sameString, sha256 } from './crypto.ts';
import { addTeamMember, canUseGateway, ensurePersonalVault, type TeamRole, type User } from './access.ts';
import { audit, body, HttpError, str } from './http.ts';
import { endLive } from './live.ts';
import { openSecret, recoveryHash, verifyTotp } from './totp.ts';
import { checkNewPassword, hashPassword, hashSlot, normalizeInviteCode, passwordField, Throttle, tooMany, verifyPassword } from './password.ts';

// 앱(화면이 앱 안에 들어 있다)과 서버가 서로 맞는지: 서버 API 수준과, 이 서버가 받아 주는 가장 낮은 앱 수준.
// 앱이 쓰는 API 를 새로 넣으면 API_LEVEL 을, 옛 앱을 더는 받지 않을 때 MIN_APP_LEVEL 을 올린다 (web/src/compat.ts 와 짝)
// 2: 항목 지우기 충돌 확인(baseUpdatedAt)·개인 볼트 서버 사본 비우기·오프라인 기록 시각 (팀 오프라인 기간은 7일 고정이라 없음)
// 3: 볼트 키 다시 봉하기(PUT /api/vaults/:id/key/mine)·봉한 사람(wrappedBy)·팀 초대 수락/거절(/api/me/invites)
export const API_LEVEL = 3;
// SHELL_MIN_APP_API: 시험·긴급용 — 문제가 있는 옛 앱을 당장 막아야 할 때 올린다 (코드 값보다 낮출 수는 없다)
export const MIN_APP_LEVEL = Math.max(1, Math.floor(Number(process.env.SHELL_MIN_APP_API) || 0));

// 아이디·비밀번호: 아이디마다 15분에 10번, 주소(IP)마다 15분에 50번 틀리면 막는다
const loginThrottle = new Throttle(10, 15 * 60 * 1000);
const ipThrottle = new Throttle(50, 15 * 60 * 1000);
// Google 로그인 시작: 주소마다 10분에 30번 (시작할 때마다 10분짜리 행이 생긴다)
const startThrottle = new Throttle(30, 10 * 60 * 1000);
const MAX_OAUTH_STATES = 5000;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    // Google 로그인은 끝났지만 2단계 인증 코드를 아직 넣지 않은 세션
    mfaPending: boolean;
  }
}

// https 에서는 __Host- 쿠키: 같은 도메인의 다른 하위 도메인이 세션 쿠키를 심지 못한다(Secure·Path=/·Domain 없음이 강제됨).
// 이름이 바뀌어 예전 쿠키(ss_sid)로 로그인해 있던 웹은 한 번 다시 로그인한다 — 예전 이름은 읽지 않는다 (보안 점검 09-29)
const LEGACY_SESSION_COOKIE = 'ss_sid';
const SESSION_COOKIE = config.secureCookies ? '__Host-ss_sid' : 'ss_sid';
const OAUTH_COOKIE = config.secureCookies ? '__Secure-ss_oauth' : 'ss_oauth';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

class LoginRejected extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// 초대받은 계정만 들어온다. 첫 로그인 때 받아 둔 초대를 모두 수락한다.
function admitUser(identity: { sub: string; email: string; name: string; picture: string }): User {
  const email = identity.email.toLowerCase();
  return tx(() => {
    let user = get<User>('SELECT * FROM users WHERE google_sub = ?', identity.sub) ?? get<User>('SELECT * FROM users WHERE email = ?', email);
    const invites = all<{ id: string; team_id: string; role: TeamRole }>('SELECT id, team_id, role FROM invites WHERE email = ?', email);
    const bootstrap = config.bootstrapAdmins.includes(email);

    if (user?.google_sub && user.google_sub !== identity.sub) throw new LoginRejected('account_mismatch');
    // 아이디·비밀번호로 만든 계정(초대 코드 가입·env 관리자)에는 이메일이 같다는 것만으로 Google 을 붙이지 않는다.
    // 그 이메일은 서버가 확인한 적이 없다 — 남이 먼저 만들어 둔 계정에 진짜 주인이 들어가 버린다 (보안 점검 H-1)
    if (user && !user.google_sub && user.password_hash) throw new LoginRejected('password_account');
    const isNew = !user;
    if (!user) {
      if (!invites.length && !bootstrap && !config.openSignup) throw new LoginRejected('not_invited');
      const id = newId();
      run('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)', id, email, now());
      user = get<User>('SELECT * FROM users WHERE id = ?', id)!;
    }
    if (user.disabled) throw new LoginRejected('disabled');

    run(
      'UPDATE users SET google_sub = ?, email = ?, name = ?, avatar_url = ?, is_admin = ?, last_login_at = ? WHERE id = ?',
      identity.sub,
      email,
      identity.name || email.split('@')[0],
      identity.picture,
      user.is_admin || bootstrap,
      now(),
      user.id,
    );
    // 초대는 받은 사람이 로그인해서 수락해야 들어간다 (보안 점검 M-3 — 이미 계정이 있는 사람을 묻지 않고 팀에 넣지 않는다).
    // 초대받아야만 들어오는 서버의 새 계정만은 그 초대 덕분에 들어온 것이라 바로 수락한다
    if (isNew && !config.openSignup) {
      for (const invite of invites) {
        addTeamMember(invite.team_id, user.id, invite.role);
        run('DELETE FROM invites WHERE id = ?', invite.id);
        audit({ userId: user.id, teamId: invite.team_id, action: 'invite_accept', target: email });
      }
    }
    const fresh = get<User>('SELECT * FROM users WHERE id = ?', user.id)!;
    // 팀에서 모두 빠진 사람은 게이트웨이를 못 쓴다 (관리자·누구나 가입하는 서버 제외)
    if (!canUseGateway(fresh)) throw new LoginRejected('no_team');
    ensurePersonalVault(fresh.id);
    return fresh;
  });
}

function clientIp(req: FastifyRequest) {
  return req.ip ?? '';
}

function createSession(req: FastifyRequest, user: User, via: string) {
  const token = randomToken(32);
  run(
    'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent, mfa_ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    user.id,
    now(),
    now() + config.sessionTtlMs,
    clientIp(req),
    String(req.headers['user-agent'] ?? '').slice(0, 300),
    // OTP 를 켠 사람은 코드를 넣을 때까지 반쯤 로그인한 상태 (POST /api/auth/mfa/verify)
    user.totp_secret ? 0 : 1,
  );
  audit({ userId: user.id, action: 'login', detail: { via }, ip: clientIp(req) });
  return token;
}

// 비밀번호·초대 코드 로그인의 끝: 웹은 쿠키, 앱은 토큰
function finishLogin(req: FastifyRequest, reply: FastifyReply, user: User, via: string, desktop: boolean) {
  const mfa = Boolean(user.totp_secret);
  if (desktop) return { token: createSession(req, user, `${via}-desktop`), maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000), mfa };
  startSession(req, reply, user, via);
  return { ok: true, mfa };
}

function startSession(req: FastifyRequest, reply: FastifyReply, user: User, via: string) {
  const token = createSession(req, user, via);
  if (LEGACY_SESSION_COOKIE !== SESSION_COOKIE && req.cookies?.[LEGACY_SESSION_COOKIE]) reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

// 웹은 쿠키, 데스크톱 앱은 Authorization: Bearer (앱 화면은 앱 안에 들어 있고 API 는 앱 본체가 대신 부른다)
export function sessionToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  // Bearer 로 부르면 쿠키는 보지 않는다 (값이 비어도) — CSRF 확인과 같은 기준 (index.ts)
  if (typeof auth === 'string' && auth.startsWith('Bearer')) return auth.slice(6).trim() || undefined;
  return req.cookies?.[SESSION_COOKIE];
}

export function sessionHash(req: FastifyRequest): string | null {
  const token = sessionToken(req);
  return token ? sha256(token) : null;
}

// 세션이 살아 있고, 그 사람이 아직 게이트웨이를 쓸 수 있으면 사용자를 돌려준다 (오래 가는 연결의 재확인에도 쓴다)
// 2단계 인증까지 끝난 세션만 사용자로 본다. 코드를 기다리는 세션은 sessionRow 로 따로 본다
export function userBySessionHash(hash: string): User | null {
  const row = sessionRow(hash);
  return row && row.mfa_ok ? row : null;
}

type SessionUser = User & { expires_at: number; mfa_ok: number; mfa_fails: number };
function sessionRow(hash: string): SessionUser | null {
  const row = get<SessionUser>('SELECT u.*, s.expires_at, s.mfa_ok, s.mfa_fails FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?', hash);
  if (!row || row.expires_at < now() || row.disabled) return null;
  if (!canUseGateway(row)) return null;
  return row;
}

// 로그인한 사람의 OTP 코드(또는 복구 코드) 확인 — 맞으면 쓴 칸·복구 코드를 표시한다
export function checkSecondFactor(user: User, code: string, allowRecovery: boolean): 'totp' | 'recovery' | null {
  if (!user.totp_secret) return null;
  const clean = code.replace(/[\s-]/g, '');
  const step = verifyTotp(openSecret(user.totp_secret, user.id), clean, user.totp_last_step);
  if (step !== null) {
    // 쓴 칸을 조건부로 적는다 — 같은 코드를 동시에 두 번 보내도(요청마다 읽어 둔 사용자 정보가 옛것이어도) 한 번만 통과한다
    const used = run('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', step, user.id, step);
    return used.changes ? 'totp' : null;
  }
  if (!allowRecovery || !/^[a-z2-7]{10}$/i.test(clean)) return null;
  const used = run('UPDATE totp_recovery SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', now(), user.id, recoveryHash(clean));
  return used.changes ? 'recovery' : null;
}

// 2단계 인증 코드 대입 막기: 사람마다 다섯 번 틀리면 잠그고, 거듭 잠길수록 길게(15분 → 30분 → … 하루). 맞히면 풀린다.
// 세션마다 세던 것은 다시 로그인하면 새로 셌다 (보안 점검 M-1). 로그인 확인·끄기·복구 코드 새로 받기가 함께 쓴다
const MFA_MAX_FAILS = 5;
export function mfaGuard(userId: string) {
  const r = get<{ mfa_locked_until: number }>('SELECT mfa_locked_until FROM users WHERE id = ?', userId);
  if (r && r.mfa_locked_until > now()) {
    const minutes = Math.max(1, Math.ceil((r.mfa_locked_until - now()) / 60_000));
    throw new HttpError(429, 'mfa_throttled', `코드를 여러 번 틀렸습니다. ${minutes}분 뒤에 다시 시도해 주세요.`);
  }
}
export function mfaFailed(userId: string) {
  const r = get<{ mfa_fails: number; mfa_lock_level: number }>('SELECT mfa_fails, mfa_lock_level FROM users WHERE id = ?', userId);
  if (!r) return;
  if (r.mfa_fails + 1 >= MFA_MAX_FAILS) {
    const minutes = Math.min(15 * 2 ** r.mfa_lock_level, 24 * 60);
    run('UPDATE users SET mfa_fails = 0, mfa_lock_level = mfa_lock_level + 1, mfa_locked_until = ? WHERE id = ?', now() + minutes * 60_000, userId);
  } else {
    run('UPDATE users SET mfa_fails = mfa_fails + 1 WHERE id = ?', userId);
  }
}
export function mfaPassed(userId: string) {
  run('UPDATE users SET mfa_fails = 0, mfa_lock_level = 0, mfa_locked_until = 0 WHERE id = ?', userId);
}

// 로그인한 지 얼마나 됐는지 (지우기처럼 되돌릴 수 없는 일 앞에서 확인한다)
export function sessionAgeMs(req: FastifyRequest): number | null {
  const hash = sessionHash(req);
  const row = hash ? get<{ created_at: number }>('SELECT created_at FROM sessions WHERE id_hash = ?', hash) : undefined;
  return row ? now() - row.created_at : null;
}

export function userFromRequest(req: FastifyRequest): User | null {
  const hash = sessionHash(req);
  return hash ? userBySessionHash(hash) : null;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) {
    if (req.mfaPending) throw new HttpError(401, 'mfa_required', '2단계 인증 코드를 입력해 주세요');
    throw new HttpError(401, 'unauthorized', '로그인이 필요합니다');
  }
  return req.user;
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('mfaPending', false);
  app.addHook('onRequest', async (req) => {
    const hash = sessionHash(req);
    const row = hash ? sessionRow(hash) : null;
    req.user = row && row.mfa_ok ? row : null;
    req.mfaPending = Boolean(row && !row.mfa_ok);
  });

  // 2단계 인증: Google 로그인 뒤 인증 앱의 코드(또는 복구 코드)를 넣는다. 다섯 번 틀리면 그 세션을 지운다
  app.post('/api/auth/mfa/verify', async (req) => {
    const hash = sessionHash(req);
    const row = hash ? sessionRow(hash) : null;
    if (!row) throw new HttpError(401, 'unauthorized', '로그인이 필요합니다');
    if (row.mfa_ok) return { ok: true };
    // 그사이 OTP 를 껐으면 그대로 통과
    if (!row.totp_secret) {
      run('UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?', hash);
      return { ok: true };
    }
    const code = str(body(req.body), 'code', { min: 6, max: 24 })!;
    mfaGuard(row.id);
    const via = checkSecondFactor(row, code, true);
    if (!via) {
      mfaFailed(row.id);
      const fails = row.mfa_fails + 1;
      audit({ userId: row.id, action: 'mfa_fail', detail: { fails }, ip: clientIp(req) });
      if (fails >= 5) {
        run('DELETE FROM sessions WHERE id_hash = ?', hash);
        throw new HttpError(401, 'mfa_locked', '코드를 여러 번 틀려 로그아웃했습니다. 다시 로그인해 주세요.');
      }
      run('UPDATE sessions SET mfa_fails = ? WHERE id_hash = ?', fails, hash);
      throw new HttpError(400, 'mfa_bad', '코드가 맞지 않습니다. 인증 앱의 지금 코드를 입력해 주세요.');
    }
    run('UPDATE sessions SET mfa_ok = 1, mfa_fails = 0 WHERE id_hash = ?', hash);
    mfaPassed(row.id);
    audit({ userId: row.id, action: 'mfa_verify', detail: { via }, ip: clientIp(req) });
    return { ok: true, via };
  });

  app.get('/api/auth/config', async () => ({
    google: Boolean(config.googleClientId && config.googleClientSecret),
    devLogin: config.devLogin,
    password: config.passwordLogin,
    openSignup: config.openSignup,
    links: { terms: config.termsUrl, privacy: config.privacyUrl, source: config.sourceUrl },
    api: API_LEVEL,
    minAppApi: MIN_APP_LEVEL,
  }));

  // 아이디·비밀번호 로그인. 웹은 쿠키, 앱(desktop: true)은 토큰으로 받는다. 2단계 인증을 켠 사람은 이어서 코드를 넣는다
  app.post('/api/auth/password', async (req, reply) => {
    if (!config.passwordLogin) throw new HttpError(404, 'not_found');
    const b = body(req.body);
    const id = str(b, 'id', { min: 1, max: 200 })!.toLowerCase();
    const password = passwordField(b, 'password');
    const ip = clientIp(req);
    if (ipThrottle.blocked(ip) || loginThrottle.blocked(id)) throw tooMany();
    // 느린 해시를 기다리기 전에 먼저 센다 — 한꺼번에 보내도 제한을 넘지 못하게 (보안 점검 M-2). 맞으면 되돌린다
    ipThrottle.fail(ip);
    loginThrottle.fail(id);
    const release = hashSlot(`login:${id}`);
    const user = get<User>('SELECT * FROM users WHERE email = ?', id);
    let ok: boolean;
    try {
      ok = await verifyPassword(password, user?.password_hash);
    } finally {
      release();
    }
    // 해시를 기다리는 동안 비밀번호가 바뀌었거나 2단계 인증이 켜졌을 수 있다 — 지금 계정을 다시 읽어, 확인한 해시가 그대로일 때만
    // 그 상태(지금의 2단계 인증)로 세션을 만든다 (공개 전 점검 OS-02). 다시 읽기부터 세션 만들기까지는 await 가 없어 끼어들 수 없다
    const current = user && ok ? get<User>('SELECT * FROM users WHERE id = ?', user.id) : undefined;
    if (!user || !ok || !current || current.password_hash !== user.password_hash) {
      audit({ action: 'login_rejected', target: id, detail: { reason: 'bad_password' }, ip });
      throw new HttpError(401, 'bad_password', '아이디 또는 비밀번호가 맞지 않습니다');
    }
    loginThrottle.reset(id);
    ipThrottle.undo(ip);
    const reason = current.disabled ? 'disabled' : !canUseGateway(current) ? 'no_team' : '';
    if (reason) {
      audit({ userId: current.id, action: 'login_rejected', target: id, detail: { reason }, ip });
      throw new HttpError(403, reason, reason);
    }
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), current.id);
    ensurePersonalVault(current.id);
    return finishLogin(req, reply, current, 'password', b.desktop === true);
  });

  // 초대 코드로 처음 비밀번호를 정하고 들어온다 (비밀번호 로그인 서버). 코드가 맞은 그 초대 하나만 수락한다
  app.post('/api/auth/invite-signup', async (req, reply) => {
    if (!config.passwordLogin) throw new HttpError(404, 'not_found');
    const b = body(req.body);
    const email = str(b, 'email', { min: 3, max: 200 })!.toLowerCase();
    const code = normalizeInviteCode(str(b, 'code', { min: 6, max: 64 })!);
    const name = str(b, 'name', { optional: true, max: 80 }) ?? '';
    const password = passwordField(b, 'password');
    checkNewPassword(password);
    const ip = clientIp(req);
    if (ipThrottle.blocked(ip) || loginThrottle.blocked(`invite:${email}`)) throw tooMany();
    // 서버 관리자가 될 이메일(부트스트랩·env 관리자)은 초대 코드로 만들 수 없다 — 코드를 받은 사람이 관리자 계정을 먼저 차지하지 못하게
    if (config.bootstrapAdmins.includes(email) || email === config.adminId) throw new HttpError(403, 'forbidden', '이 이메일은 초대 코드로 가입할 수 없습니다');
    const invite = all<{ id: string; team_id: string; role: TeamRole; code_hash: string | null; code_expires_at: number | null }>(
      'SELECT id, team_id, role, code_hash, code_expires_at FROM invites WHERE email = ?',
      email,
    ).find((i) => i.code_hash && (i.code_expires_at ?? 0) > now() && sameString(i.code_hash, sha256(code)));
    if (!invite) {
      ipThrottle.fail(ip);
      loginThrottle.fail(`invite:${email}`);
      audit({ action: 'login_rejected', target: email, detail: { reason: 'invite_bad' }, ip });
      throw new HttpError(400, 'invite_bad', '초대 코드가 맞지 않거나 기한이 지났습니다');
    }
    if (get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'account_exists', '이미 계정이 있습니다. 로그인해 주세요.');
    const release = hashSlot(`invite:${email}`);
    let hash: string;
    try {
      hash = await hashPassword(password);
    } finally {
      release();
    }
    const user = tx(() => {
      const id = newId();
      run(
        'INSERT INTO users (id, email, name, password_hash, password_changed_at, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        email,
        name || email.split('@')[0],
        hash,
        now(),
        now(),
        now(),
      );
      addTeamMember(invite.team_id, id, invite.role);
      run('DELETE FROM invites WHERE id = ?', invite.id);
      audit({ userId: id, teamId: invite.team_id, action: 'invite_accept', target: email, detail: { via: 'code' }, ip });
      ensurePersonalVault(id);
      return get<User>('SELECT * FROM users WHERE id = ?', id)!;
    });
    return finishLogin(req, reply, user, 'invite', b.desktop === true);
  });

  app.get('/api/auth/google/start', async (req, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new HttpError(503, 'google_not_configured', 'Google 로그인이 아직 설정되지 않았습니다');
    }
    // 시작을 끝없이 되풀이해 표를 채우지 못하게: 주소마다 10분에 30번, 서버 전체로 기다리는 로그인 5000개까지
    const ip = clientIp(req);
    run('DELETE FROM oauth_states WHERE created_at < ?', now() - 10 * 60 * 1000);
    if (startThrottle.blocked(ip) || get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_states')!.n >= MAX_OAUTH_STATES) return reply.redirect('/?login_error=too_many');
    startThrottle.fail(ip);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const q = req.query as { desktop_port?: string; desktop_challenge?: string };
    let desktopPort: number | null = null;
    let desktopChallenge: string | null = null;
    if (q.desktop_port || q.desktop_challenge) {
      desktopPort = Number(q.desktop_port);
      desktopChallenge = String(q.desktop_challenge ?? '');
      if (!Number.isInteger(desktopPort) || desktopPort < 1024 || desktopPort > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(desktopChallenge)) {
        throw new HttpError(400, 'bad_request', '앱 로그인 요청이 올바르지 않습니다');
      }
    }
    run(
      'INSERT INTO oauth_states (state, nonce, verifier, created_at, desktop_port, desktop_challenge) VALUES (?, ?, ?, ?, ?, ?)',
      state,
      nonce,
      verifier,
      now(),
      desktopPort,
      desktopChallenge,
    );
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: nodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    // state 를 이 브라우저에 묶어 둔다 (남의 로그인 결과를 끼워 넣는 공격 방지)
    reply.setCookie(OAUTH_COOKIE, state, { path: '/api/auth/google', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 600 });
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const row = q.state ? get<{ nonce: string; verifier: string; created_at: number; desktop_port: number | null; desktop_challenge: string | null }>('SELECT * FROM oauth_states WHERE state = ?', q.state) : undefined;
    const loopback = row?.desktop_port ? `http://127.0.0.1:${row.desktop_port}/callback` : null;
    const fail = (code: string) => {
      reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });
      return reply.redirect(loopback ? `${loopback}?error=${encodeURIComponent(code)}` : `/?login_error=${encodeURIComponent(code)}`);
    };
    if (q.error || !q.code || !q.state) return fail('cancelled');
    run('DELETE FROM oauth_states WHERE state = ?', q.state);
    if (!row || row.created_at < now() - 10 * 60 * 1000 || req.cookies[OAUTH_COOKIE] !== q.state) return fail('expired');

    let claims: { sub: string; email: string; name: string; picture: string };
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: config.googleRedirectUri,
          grant_type: 'authorization_code',
          code_verifier: row.verifier,
        }),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const tokens = (await res.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error('no id_token');
      const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.googleClientId,
      });
      if (payload.nonce !== row.nonce) throw new Error('nonce mismatch');
      if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.sub) return fail('unverified_email');
      claims = {
        sub: `google:${payload.sub}`,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : '',
        picture: typeof payload.picture === 'string' ? payload.picture : '',
      };
    } catch (err) {
      req.log.warn({ err }, 'google login failed');
      return fail('google_error');
    }

    try {
      const user = admitUser(claims);
      reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });
      if (loopback && row?.desktop_challenge) {
        const code = randomToken(32);
        run('DELETE FROM desktop_codes WHERE created_at < ?', now() - 2 * 60 * 1000);
        run('INSERT INTO desktop_codes (code_hash, user_id, challenge, created_at) VALUES (?, ?, ?, ?)', sha256(code), user.id, row.desktop_challenge, now());
        return reply.redirect(`${loopback}?code=${encodeURIComponent(code)}`);
      }
      startSession(req, reply, user, 'google');
      return reply.redirect('/');
    } catch (err) {
      if (err instanceof LoginRejected) {
        audit({ action: 'login_rejected', target: claims.email.toLowerCase(), detail: { reason: err.code }, ip: clientIp(req) });
        return fail(err.code);
      }
      throw err;
    }
  });

  app.post('/api/auth/desktop/exchange', async (req) => {
    const b = body(req.body);
    const code = str(b, 'code', { min: 10, max: 200 })!;
    const verifier = str(b, 'verifier', { min: 43, max: 128 })!;
    const row = get<{ user_id: string; challenge: string; created_at: number }>('SELECT * FROM desktop_codes WHERE code_hash = ?', sha256(code));
    run('DELETE FROM desktop_codes WHERE code_hash = ?', sha256(code));
    if (!row || row.created_at < now() - 2 * 60 * 1000) throw new HttpError(400, 'expired', '로그인 코드가 만료되었습니다. 다시 로그인해 주세요.');
    if (nodeCrypto.createHash('sha256').update(verifier).digest('base64url') !== row.challenge) throw new HttpError(400, 'bad_verifier', '로그인 확인에 실패했습니다.');
    const user = get<User>('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user || !canUseGateway(user)) throw new HttpError(403, 'forbidden', '로그인할 수 없는 계정입니다.');
    return { token: createSession(req, user, 'desktop'), maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000) };
  });

  app.post('/api/auth/dev-login', async (req, reply) => {
    if (!config.devLogin) throw new HttpError(404, 'not_found');
    const b = body(req.body);
    const email = str(b, 'email', { min: 3, max: 200 })!.toLowerCase();
    try {
      const user = admitUser({ sub: `dev:${email}`, email, name: str(b, 'name', { optional: true, max: 80 }) ?? '', picture: '' });
      startSession(req, reply, user, 'dev');
      return { ok: true };
    } catch (err) {
      if (err instanceof LoginRejected) {
        audit({ action: 'login_rejected', target: email, detail: { reason: err.code, dev: true }, ip: clientIp(req) });
        throw new HttpError(403, err.code, err.code);
      }
      throw err;
    }
  });

  // 개발용: 데스크톱 앱이 쓰는 토큰으로 로그인 (SHELL_DEV_LOGIN=1 이고 localhost 일 때만)
  app.post('/api/auth/dev-login-token', async (req) => {
    if (!config.devLogin) throw new HttpError(404, 'not_found');
    const email = str(body(req.body), 'email', { min: 3, max: 200 })!.toLowerCase();
    try {
      const user = admitUser({ sub: `dev:${email}`, email, name: '', picture: '' });
      return { token: createSession(req, user, 'dev-desktop'), maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000) };
    } catch (err) {
      if (err instanceof LoginRejected) throw new HttpError(403, err.code, err.code);
      throw err;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) {
      const hash = sha256(token);
      run('DELETE FROM sessions WHERE id_hash = ?', hash);
      // 이 세션으로 열어 둔 웹 SSH 중계도 닫는다 (보안 검토 F-05)
      endLive((l) => l.sessionHash === hash, 'logged out');
    }
    if (req.user) audit({ userId: req.user.id, action: 'logout', ip: clientIp(req) });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (LEGACY_SESSION_COOKIE !== SESSION_COOKIE) reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('DELETE FROM oauth_states WHERE created_at < ?', now() - 10 * 60 * 1000);
  run('DELETE FROM desktop_codes WHERE created_at < ?', now() - 2 * 60 * 1000);
}

// 처음 켤 때: SHELL_ADMIN_ID·SHELL_ADMIN_PASSWORD 로 서버 관리자 계정을 만든다 (그 계정에 비밀번호가 아직 없을 때만).
// 비밀번호를 잊으면: npm run user:password -w server -- 아이디
export async function ensureEnvAdmin(log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  if (!config.passwordLogin || !config.adminId) return;
  const existing = get<User>('SELECT * FROM users WHERE email = ?', config.adminId);
  if (existing?.password_hash) return;
  if (!config.adminPassword) {
    log.warn(`SHELL_ADMIN_ID=${config.adminId} 계정에 비밀번호가 없습니다. SHELL_ADMIN_PASSWORD 를 넣거나 npm run user:password 로 정해 주세요.`);
    return;
  }
  const hash = await hashPassword(config.adminPassword);
  const id = tx(() => {
    const userId = existing?.id ?? newId();
    if (!existing) run('INSERT INTO users (id, email, name, is_admin, created_at) VALUES (?, ?, ?, 1, ?)', userId, config.adminId, config.adminId.split('@')[0], now());
    run('UPDATE users SET password_hash = ?, password_changed_at = ?, is_admin = 1 WHERE id = ?', hash, now(), userId);
    ensurePersonalVault(userId);
    return userId;
  });
  audit({ userId: id, action: 'password_set', target: config.adminId, detail: { by: 'env' } });
  log.info(`서버 관리자 계정 ${config.adminId} 에 SHELL_ADMIN_PASSWORD 로 비밀번호를 정했습니다. 이제 env 에서 SHELL_ADMIN_PASSWORD 를 지워도 됩니다.`);
}
