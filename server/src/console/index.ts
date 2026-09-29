// 관리 콘솔: 공개 서버와 따로, 서버 PC 안에서만 열리는 관리 서버 (기본 127.0.0.1:5282, SHELL_CONSOLE_PORT=0 이면 끔).
// 앱·웹 화면에는 관리 기능이 없고, 공개 서버의 /api 에도 관리 API 가 없다. 원격에서는 원격 데스크톱이나 SSH 터널로 연다.
//   ssh -L 5282:127.0.0.1:5282 <서버>   →   http://127.0.0.1:5282/admin
// 막아 둔 것: 이 PC 주소(127.0.0.1·localhost·[::1])로 부른 요청만(DNS 리바인딩 차단), 상태를 바꾸는 요청은 x-console 머리글·같은 출처만,
// 관리 비밀번호(+선택 OTP)로 로그인, 15분에 5번 틀리면 막힘, 쿠키는 HttpOnly·SameSite=Strict·/admin 만.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { config } from '../config.ts';
import { audit, body, HttpError } from '../http.ts';
import { hashSlot, tooMany } from '../password.ts';
import { consoleLogin, consoleLogout, consoleSession, consoleState, dropSessionsIfChanged, loginThrottle } from './auth.ts';
import { consoleRoutes } from './routes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'terminas_console';
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
// 로그인 없이 받는 라우트 (라우터가 고른 라우트 모양으로 본다). 나머지는 모두 콘솔 세션이 있어야 한다
const PUBLIC_ROUTES = new Set(['/', '/admin', '/admin/', '/admin/console.js', '/admin/console.css', '/admin/api/state', '/admin/api/login']);
const FILES: Record<string, [string, string]> = {
  '/admin': ['page.html', 'text/html; charset=utf-8'],
  '/admin/': ['page.html', 'text/html; charset=utf-8'],
  '/admin/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  '/admin/console.css': ['console.css', 'text/css; charset=utf-8'],
};

export async function startConsole(log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }) {
  if (!config.consolePort) return null;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    // DNS 리바인딩: 남의 웹 페이지가 이 PC 주소로 이름을 바꿔 부르지 못하게, 이 PC 주소로 부른 것만 받는다
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) return reply.code(421).type('text/plain').send('This console only answers on 127.0.0.1 / localhost.');
    dropSessionsIfChanged();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if ((origin && !LOOPBACK_ORIGIN.test(origin)) || req.headers['x-console'] !== '1') throw new HttpError(403, 'forbidden', '허용되지 않은 요청입니다');
    }
    // 날것의 주소가 아니라 라우터가 고른 라우트로 판단한다 — /admin/%61pi/... 처럼 인코딩해 부르면 라우터는 풀어서 보호 API 를
    // 찾는데 주소 비교는 건너뛰어졌다 (공개 전 점검 OS-01). 공개 라우트 목록 밖은 모두 로그인이 필요하다 (없는 주소는 404)
    const route = req.routeOptions?.url;
    if (route && !PUBLIC_ROUTES.has(route) && !consoleSession(req.cookies[COOKIE])) throw new HttpError(401, 'unauthorized', '관리 콘솔에 로그인해 주세요');
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });

  app.get('/', async (_req, reply) => reply.redirect('/admin'));
  for (const [route, [file, type]] of Object.entries(FILES)) {
    app.get(route, async (_req, reply) => reply.type(type).send(fs.readFileSync(path.join(here, file))));
  }

  app.get('/admin/api/state', async (req) => ({ ...consoleState(), loggedIn: consoleSession(req.cookies[COOKIE]) }));

  app.post('/admin/api/login', async (req, reply) => {
    const ip = req.ip ?? '';
    if (loginThrottle.blocked(ip)) throw tooMany();
    const b = body(req.body);
    const password = typeof b.password === 'string' ? b.password : '';
    const code = typeof b.code === 'string' ? b.code : '';
    // 느린 비밀번호 확인 앞에서 먼저 센다 — 한꺼번에 보내도 5번을 넘지 못하게. 콘솔 로그인은 한 번에 하나만 (공개 전 점검 OS-03)
    loginThrottle.fail(ip);
    const release = hashSlot('console-login');
    let token: string | null;
    try {
      token = password ? await consoleLogin(password, code) : null;
    } finally {
      release();
    }
    if (!token) {
      audit({ action: 'console_login_failed', ip });
      throw new HttpError(401, 'bad_password', consoleState().otp ? '비밀번호나 OTP 코드가 맞지 않습니다' : '비밀번호가 맞지 않습니다');
    }
    loginThrottle.reset(ip);
    audit({ action: 'console_login', ip });
    reply.setCookie(COOKIE, token, { path: '/admin', httpOnly: true, sameSite: 'strict', secure: false, maxAge: 8 * 60 * 60 });
    return { ok: true };
  });

  app.post('/admin/api/logout', async (req, reply) => {
    consoleLogout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/admin' });
    return { ok: true };
  });

  consoleRoutes(app);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    log.error(`console error: ${err.message}`);
    return reply.code(500).send({ error: 'internal', message: '서버 오류가 발생했습니다' });
  });

  if (!/^(127\.0\.0\.1|::1|localhost)$/.test(config.consoleHost)) log.warn(`관리 콘솔이 ${config.consoleHost} 에서 열립니다 — 이 포트를 인터넷에 열지 마세요.`);
  try {
    await app.listen({ host: config.consoleHost, port: config.consolePort });
    log.info(`관리 콘솔: http://${config.consoleHost === '0.0.0.0' ? '127.0.0.1' : config.consoleHost}:${config.consolePort}/admin (서버 PC 안에서만)`);
    if (!consoleState().passwordSet) log.warn('관리 콘솔 비밀번호가 없습니다: npm run console:password -w server');
  } catch (err) {
    // 공개 서버는 그대로 둔다 (다른 프로세스가 포트를 쓰는 등)
    log.error(`관리 콘솔을 열지 못했습니다 (${config.consoleHost}:${config.consolePort}): ${(err as Error).message}`);
    return null;
  }
  return app;
}
