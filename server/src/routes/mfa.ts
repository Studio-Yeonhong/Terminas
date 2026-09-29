// 2단계 인증(OTP) 켜기·끄기·복구 코드. 로그인할 때의 확인은 auth.ts 의 POST /api/auth/mfa/verify.
// 처음엔 모두 꺼져 있고, 쓰고 싶은 사람만 설정 → 보안·암호화에서 켠다.
import type { FastifyInstance } from 'fastify';
import { checkSecondFactor, mfaFailed, mfaGuard, mfaPassed, requireUser, sessionAgeMs, sessionHash } from '../auth.ts';
import { get, now, run, tx } from '../db.ts';
import { audit, badRequest, body, conflict, HttpError, str } from '../http.ts';
import { endLive } from '../live.ts';
import { newRecoveryCodes, newSecret, openSecret, otpauthUri, recoveryHash, sealSecret, verifyTotp } from '../totp.ts';

const PENDING_MS = 15 * 60 * 1000;
// 켜기는 방금 로그인한 세션에서만 — 훔친 세션으로 자기 인증 앱을 등록해 주인을 잠그지 못하게 (보안 점검 09-29)
const ENABLE_LOGIN_WINDOW_MS = 10 * 60 * 1000;

// 로그인한 채로 코드를 계속 맞혀 보지 못하게: 틀린 횟수는 로그인 확인과 함께 사람마다 센다 (auth.ts mfaGuard)
const guard = mfaGuard;
function wrongCode(userId: string): never {
  mfaFailed(userId);
  throw new HttpError(400, 'mfa_bad', '코드가 맞지 않습니다. 인증 앱의 지금 코드를 입력해 주세요.');
}
function recentLogin(req: Parameters<typeof sessionAgeMs>[0]) {
  const age = sessionAgeMs(req);
  if (age === null || age > ENABLE_LOGIN_WINDOW_MS) throw new HttpError(403, 'reauth_required', '안전을 위해 다시 로그인한 뒤 10분 안에 설정해 주세요.');
}
const codeOf = (req: { body: unknown }) => str(body(req.body), 'code', { min: 6, max: 24 })!;

export function mfaRoutes(app: FastifyInstance) {
  app.get('/api/me/mfa', async (req) => {
    const user = requireUser(req);
    const left = get<{ n: number }>('SELECT COUNT(*) AS n FROM totp_recovery WHERE user_id = ? AND used_at IS NULL', user.id)!.n;
    return { enabled: Boolean(user.totp_secret), enabledAt: user.totp_enabled_at, recoveryLeft: user.totp_secret ? left : 0 };
  });

  // 켜기 1단계: 새 비밀값 (인증 앱에 등록할 QR·글자). 확인하기 전까지는 켜지지 않는다
  app.post('/api/me/mfa/setup', async (req) => {
    const user = requireUser(req);
    if (user.totp_secret) throw conflict('2단계 인증이 이미 켜져 있습니다');
    recentLogin(req);
    const secret = newSecret();
    run('UPDATE users SET totp_pending = ?, totp_pending_at = ? WHERE id = ?', sealSecret(secret, user.id), now(), user.id);
    return { secret, uri: otpauthUri(secret, user.email) };
  });

  // 켜기 2단계: 인증 앱이 보여 주는 코드로 확인 → 켜고, 복구 코드를 이번에 한 번만 돌려준다.
  // 다른 기기·브라우저의 로그인은 다음 요청부터 코드를 넣어야 하고, 그 웹 접속은 닫는다.
  app.post('/api/me/mfa/enable', async (req) => {
    const user = requireUser(req);
    if (user.totp_secret) throw conflict('2단계 인증이 이미 켜져 있습니다');
    const row = get<{ totp_pending: string | null; totp_pending_at: number | null }>('SELECT totp_pending, totp_pending_at FROM users WHERE id = ?', user.id);
    if (!row?.totp_pending || !row.totp_pending_at || now() - row.totp_pending_at > PENDING_MS) throw badRequest('설정 시간이 지났습니다. 처음부터 다시 해 주세요.');
    recentLogin(req);
    guard(user.id);
    const step = verifyTotp(openSecret(row.totp_pending, user.id), codeOf(req).replace(/\s/g, ''), 0);
    if (step === null) wrongCode(user.id);
    const codes = newRecoveryCodes();
    const current = sessionHash(req) ?? '';
    tx(() => {
      run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_pending_at = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?', now(), step, user.id);
      run('DELETE FROM totp_recovery WHERE user_id = ?', user.id);
      for (const c of codes) run('INSERT INTO totp_recovery (user_id, code_hash) VALUES (?, ?)', user.id, recoveryHash(c));
      run('UPDATE sessions SET mfa_ok = 0 WHERE user_id = ? AND id_hash != ?', user.id, current);
    });
    endLive((l) => l.userId === user.id && l.sessionHash !== current, 'mfa enabled');
    mfaPassed(user.id);
    audit({ userId: user.id, action: 'mfa_enable', ip: req.ip });
    return { recoveryCodes: codes };
  });

  // 끄기: 지금 코드나 복구 코드가 있어야 한다. 코드를 기다리던 다른 로그인은 지운다(다시 로그인)
  app.post('/api/me/mfa/disable', async (req) => {
    const user = requireUser(req);
    if (!user.totp_secret) return { ok: true };
    guard(user.id);
    const via = checkSecondFactor(user, codeOf(req), true);
    if (!via) wrongCode(user.id);
    tx(() => {
      run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_pending_at = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?', user.id);
      run('DELETE FROM totp_recovery WHERE user_id = ?', user.id);
      run('DELETE FROM sessions WHERE user_id = ? AND mfa_ok = 0', user.id);
    });
    mfaPassed(user.id);
    audit({ userId: user.id, action: 'mfa_disable', detail: { via }, ip: req.ip });
    return { ok: true };
  });

  // 복구 코드 새로 만들기: 인증 앱의 지금 코드로만 (복구 코드로는 안 된다). 예전 복구 코드는 모두 못 쓰게 된다
  app.post('/api/me/mfa/recovery', async (req) => {
    const user = requireUser(req);
    if (!user.totp_secret) throw badRequest('2단계 인증이 꺼져 있습니다');
    guard(user.id);
    if (!checkSecondFactor(user, codeOf(req), false)) wrongCode(user.id);
    const codes = newRecoveryCodes();
    tx(() => {
      run('DELETE FROM totp_recovery WHERE user_id = ?', user.id);
      for (const c of codes) run('INSERT INTO totp_recovery (user_id, code_hash) VALUES (?, ?)', user.id, recoveryHash(c));
    });
    mfaPassed(user.id);
    audit({ userId: user.id, action: 'mfa_recovery_new', ip: req.ip });
    return { recoveryCodes: codes };
  });
}
