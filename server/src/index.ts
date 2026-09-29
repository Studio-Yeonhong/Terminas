import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { ensureEnvAdmin, MIN_APP_LEVEL, purgeExpiredSessions, registerAuth } from './auth.ts';
import { HttpError } from './http.ts';
import { run } from './db.ts';
import { teamRoutes } from './routes/teams.ts';
import { itemRoutes } from './routes/items.ts';
import { accountRoutes } from './routes/account.ts';
import { mfaRoutes } from './routes/mfa.ts';
import { startConsole } from './console/index.ts';
import { relayRoutes } from './relay.ts';

if (config.logFile) fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
fs.mkdirSync(config.updatesDir, { recursive: true });

// 요청 주소의 경로 (라우터처럼 %xx 를 풀어서 본다)
function pathOf(url: string) {
  const p = url.split('?')[0];
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

// 요청 로그에는 경로만 남긴다 — 쿼리에는 웹 SSH 목적지(/api/relay?host=…&port=…)·Google 로그인 코드가 실린다 (공개 전 점검 OS-07).
// 파일 로그(운영)는 요청마다 남기지 않지만, 표준 출력으로 모으는 설정(Docker 등)에서도 새지 않게 같은 모양으로
const serializers = {
  req: (req: { method?: string; url?: string; hostname?: string; ip?: string }) => ({ method: req.method, url: String(req.url ?? '').split('?')[0], hostname: req.hostname, remoteAddress: req.ip }),
};
const app = Fastify({
  logger: config.logFile ? { level: process.env.LOG_LEVEL ?? 'info', file: config.logFile, serializers } : { level: process.env.LOG_LEVEL ?? 'info', serializers },
  // 운영(파일 로그)에서는 요청마다 남기지 않는다 — 누가 무엇을 했는지는 audit_log 에 있다
  disableRequestLogging: Boolean(config.logFile),
  trustProxy: config.trustProxy,
  bodyLimit: 256 * 1024,
});

await app.register(cookie);
// 웹 접속 중계(/api/relay) — SSH 로 이미 암호화된 바이트만 오간다
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

// 상태를 바꾸는 API 는 우리 화면에서 보낸 것만 받는다 (CSRF).
// 데스크톱 앱은 쿠키가 아니라 Bearer 토큰으로 부른다 — 브라우저가 저절로 붙이지 않으므로 CSRF 대상이 아니다.
// 주소로 거르지 않는다: 라우터는 /%61pi/... 를 /api/... 로 풀어서 찾는데 날것의 주소로 보면 건너뛰어졌다 (보안 점검 09-29).
// Bearer 는 값이 있어야 넘어간다 (빈 Bearer 로 쿠키 인증을 받지 못하게 — auth.ts sessionToken 과 같은 기준)
app.addHook('onRequest', async (req) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (typeof req.headers.authorization === 'string' && /^Bearer\s+\S/.test(req.headers.authorization)) return;
  const origin = req.headers.origin;
  if (origin && origin !== config.publicOrigin) throw new HttpError(403, 'bad_origin', '허용되지 않은 출처입니다');
  if (req.headers['x-shell'] !== '1') throw new HttpError(403, 'csrf', '잘못된 요청입니다');
});

// 너무 오래된 데스크톱 앱은 받지 않는다 (426). 앱은 화면을 안에 들고 있어서, 서버가 바뀐 뒤 옛 앱이 계속 쓰면
// 모르는 형식을 잘못 다룰 수 있다. 앱(0.3.1~)은 x-terminas-api 로 자기 수준을 알린다 — 없으면 그 전 앱(수준 1)으로 본다.
// 켤 때 맞춰 보는 /api/auth/config 와 앱 내려받기 정보는 늘 받는다(앱이 "업데이트해 주세요"를 보여 주려면 필요하다).
// 웹 화면은 이 서버가 준 것이라 늘 맞는다(쿠키로 부른다 — Bearer 가 아니다).
const ALWAYS_OPEN = new Set(['/api/auth/config', '/api/app/latest']);
app.addHook('onRequest', async (req) => {
  const p = pathOf(req.url);
  if (!p.startsWith('/api/') || ALWAYS_OPEN.has(p)) return;
  if (!(typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer '))) return;
  const level = Number(req.headers['x-terminas-api']) || 1;
  if (level < MIN_APP_LEVEL) throw new HttpError(426, 'app_old', '앱이 이 서버보다 오래되었습니다. 앱을 업데이트해 주세요.');
});

app.addHook('onSend', async (req, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'same-origin');
  reply.header('x-frame-options', 'DENY');
  // https 로만 오게 (첫 방문 뒤로는 브라우저가 http 로 가지 않는다)
  if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
  if (pathOf(req.url).startsWith('/api/')) {
    reply.header('cache-control', 'no-store');
  } else {
    reply.header(
      'content-security-policy',
      // 웹 접속 중계(wss) 는 같은 주소지만 옛 사파리는 'self' 에 ws 를 안 넣는다 → 따로 적는다
      `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ${config.publicOrigin.replace(/^http/, 'ws')}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
  }
});

registerAuth(app);
accountRoutes(app);
mfaRoutes(app);
teamRoutes(app);
itemRoutes(app);
relayRoutes(app);

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal', message: '서버 오류가 발생했습니다' });
});

// 데스크톱 앱 업데이트: electron-updater(generic) 가 /updates/latest.yml 을 읽는다
await app.register(fastifyStatic, {
  root: config.updatesDir,
  prefix: '/updates/',
  decorateReply: false,
  index: false,
  setHeaders(res, file) {
    res.header('cache-control', file.endsWith('.yml') ? 'no-cache' : 'public, max-age=3600');
  },
});

// 웹에서 "Windows 앱 받기" 버튼이 쓰는 최신 버전 정보
app.get('/api/app/latest', async (_req, reply) => {
  const file = path.join(config.updatesDir, 'latest.yml');
  if (!fs.existsSync(file)) {
    // 이 서버에 설치 파일을 올려 두지 않았으면 공식 배포처로 (직접 운영하는 서버)
    if (config.appDownloadUrl) return { version: null, url: config.appDownloadUrl, releaseDate: null };
    return reply.code(404).send({ error: 'not_found', message: '아직 배포한 앱이 없습니다' });
  }
  const yml = fs.readFileSync(file, 'utf8');
  const version = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const installer = /^path:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const releaseDate = /^releaseDate:\s*'?([^'\n]+)'?$/m.exec(yml)?.[1]?.trim();
  if (!version || !installer) return reply.code(404).send({ error: 'not_found', message: '업데이트 정보를 읽지 못했습니다' });
  return { version, url: `/updates/${encodeURIComponent(installer)}`, releaseDate: releaseDate ?? null };
});

const indexHtml = path.join(config.webDist, 'index.html');
if (fs.existsSync(indexHtml)) {
  await app.register(fastifyStatic, {
    root: config.webDist,
    wildcard: false,
    setHeaders(res, file) {
      res.header('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

app.setNotFoundHandler((req, reply) => {
  // 없는 업데이트 파일은 404 (화면 HTML 을 주면 앱의 업데이트 확인이 엉뚱한 오류를 낸다)
  if (req.url.startsWith('/api/') || req.url.startsWith('/updates/') || !fs.existsSync(indexHtml)) {
    return reply.code(404).send({ error: 'not_found', message: '찾을 수 없습니다' });
  }
  reply.header('cache-control', 'no-cache');
  return reply.type('text/html').send(fs.readFileSync(indexHtml));
});

setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
// 오래된 기록 지우기 (SHELL_AUDIT_RETENTION_DAYS, 기본 365일 — 기록이 끝없이 쌓이지 않게)
const purgeOldAudit = () => config.auditRetentionDays > 0 && run('DELETE FROM audit_log WHERE ts < ?', Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000);
purgeOldAudit();
setInterval(purgeOldAudit, 6 * 60 * 60 * 1000).unref();

// 운영은 예약 작업이 conhost 로 감싸 띄운다. 작업을 멈추면 conhost 만 꺼지고 node 가 남아
// 포트를 쥔 채 새 서버를 막았다 → 부모가 사라지면 같이 끝낸다.
if (process.env.SHELL_EXIT_WITH_PARENT === '1') {
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      app.log.info('parent process gone, shutting down');
      app.close().finally(() => process.exit(0));
    }
  }, 2000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    Promise.allSettled([app.close(), consoleApp?.close()]).finally(() => process.exit(0));
  });
}

await ensureEnvAdmin({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
await app.listen({ port: config.port, host: config.host });
// 관리 콘솔은 따로 (서버 PC 안에서만)
const consoleApp = await startConsole({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) });
app.log.info(`Terminas listening on ${config.host}:${config.port} (public ${config.publicUrl})`);
