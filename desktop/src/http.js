// HTTP 요청 도구 (앱 전용). 요청은 이 PC 에서 대상 서버로 바로 나간다 — Terminas 서버는 거치지 않고,
// 서버에는 요청을 대신 보내는 기능이 없다. 웹 화면에는 이 도구가 없다.
// 화면이 넘겨준 그대로 보낸다(변수 치환·인증 헤더는 화면이 만든다). 받은 본문은 20MB 까지(압축을 푼 뒤에도 20MB 까지).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';

const MAX_BODY = 20 * 1024 * 1024;
const MAX_SEND = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// 메서드: 글자로 시작하는 토큰만 (화면의 web/src/http-tools.ts 와 같은 규칙)
const METHOD = /^[A-Z][A-Z0-9_-]{0,19}$/;
// 다른 사이트로 넘어갈 때 늘 떼어 내는 헤더 (화면이 알려 준 민감한 헤더도 함께)
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const jobs = new Map();

class RequestError extends Error {
  constructor(fail, message) {
    super(message);
    this.fail = fail;
  }
}

function validate(o) {
  const id = String(o?.id ?? '');
  if (!/^[\w-]{1,64}$/.test(id)) throw new RequestError('error', '요청 번호가 올바르지 않습니다');
  const method = String(o.method ?? '').toUpperCase();
  if (!METHOD.test(method)) throw new RequestError('error', '메서드가 올바르지 않습니다');
  let url;
  try {
    url = new URL(String(o.url ?? ''));
  } catch {
    throw new RequestError('error', '주소가 올바르지 않습니다.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError('error', 'http:// 또는 https:// 주소만 보낼 수 있습니다.');
  const headers = [];
  for (const h of Array.isArray(o.headers) ? o.headers.slice(0, 200) : []) {
    const name = String(h?.[0] ?? '').trim();
    const value = String(h?.[1] ?? '');
    if (!TOKEN.test(name)) throw new RequestError('error', `헤더 이름이 올바르지 않습니다: ${name}`);
    // 헤더에 줄바꿈을 넣어 다른 헤더·요청을 끼워 넣지 못하게
    if (/[\r\n\0]/.test(value)) throw new RequestError('error', `헤더 값에 줄바꿈을 넣을 수 없습니다: ${name}`);
    headers.push([name, value]);
  }
  const body = o.body === null || o.body === undefined ? null : String(o.body);
  if (body !== null && Buffer.byteLength(body) > MAX_SEND) throw new RequestError('error', '보낼 본문이 너무 큽니다(5MB까지).');
  const timeout = Math.min(300, Math.max(1, Number(o.timeout) || 30)) * 1000;
  // 화면이 민감하다고 알려 준 헤더 이름(인증 탭의 API 키 헤더, 가린 변수를 쓰는 헤더 등). 이상한 이름은 버린다
  const sensitive = new Set(CREDENTIAL_HEADERS);
  for (const n of Array.isArray(o.sensitive) ? o.sensitive.slice(0, 200) : []) {
    const name = String(n ?? '').trim();
    if (TOKEN.test(name)) sensitive.add(name.toLowerCase());
  }
  return { id, method, url, headers, body, timeout, follow: o.follow !== false, insecure: o.insecure === true, sensitive };
}

function failOf(err, signal, cancel) {
  if (cancel.signal.aborted) return new RequestError('cancelled', '취소했습니다');
  if (signal.aborted) return new RequestError('timeout', '연결 시간이 초과되었습니다.');
  const code = String(err?.code ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new RequestError('dns', '주소를 찾을 수 없습니다.');
  if (code === 'ECONNREFUSED') return new RequestError('refused', '서버가 연결을 거부했습니다. 주소와 포트를 확인해 주세요.');
  if (code === 'ECONNRESET' || code === 'EPIPE') return new RequestError('reset', '서버가 연결을 끊었습니다.');
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|ERR_OSSL)/.test(code) || /certificate|SSL|TLS/i.test(String(err?.message))) {
    return new RequestError('tls', `인증서를 확인할 수 없습니다: ${err.message}`);
  }
  return new RequestError('error', `요청을 보내지 못했습니다: ${err?.message ?? err}`);
}

// 요청 하나 (다시 보내기 없이)
function once(url, method, headers, body, opts, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const t = { start: performance.now(), dns: null, connect: null, tls: null, ttfb: null, end: null };
    const outHeaders = {};
    for (const [name, value] of headers) {
      const k = name;
      const prev = Object.keys(outHeaders).find((x) => x.toLowerCase() === k.toLowerCase());
      if (prev) outHeaders[prev] = [].concat(outHeaders[prev], value);
      else outHeaders[k] = value;
    }
    if (body !== null && !Object.keys(outHeaders).some((x) => x.toLowerCase() === 'content-length')) outHeaders['Content-Length'] = Buffer.byteLength(body);
    let req;
    try {
      req = lib.request(url, { method, headers: outHeaders, agent: false, rejectUnauthorized: !opts.insecure, signal });
    } catch (err) {
      return reject(err);
    }
    req.on('socket', (s) => {
      s.once('lookup', () => (t.dns = performance.now()));
      s.once('connect', () => (t.connect = performance.now()));
      s.once('secureConnect', () => (t.tls = performance.now()));
    });
    req.on('response', (res) => {
      t.ttfb = performance.now();
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > MAX_BODY) {
          truncated = true;
          chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      const finish = () => {
        t.end = performance.now();
        const sock = res.socket ?? req.socket;
        let tls = null;
        if (url.protocol === 'https:' && sock && typeof sock.getPeerCertificate === 'function') {
          const cert = sock.getPeerCertificate() ?? {};
          tls = {
            protocol: sock.getProtocol?.() ?? null,
            cipher: sock.getCipher?.()?.name ?? null,
            authorized: Boolean(sock.authorized),
            authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
            subject: cert.subject?.CN ?? null,
            issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null,
            validTo: cert.valid_to ?? null,
          };
        }
        resolve({ res, raw: Buffer.concat(chunks), truncated, timing: t, remote: sock ? { address: sock.remoteAddress ?? null, port: sock.remotePort ?? null } : null, tls });
      };
      res.on('end', finish);
      res.on('close', () => (truncated || !res.complete ? finish() : undefined));
      res.on('error', (err) => (truncated ? finish() : reject(err)));
    });
    req.on('error', reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

// 압축 풀기 — 푼 크기도 MAX_BODY 까지만 (보안 점검 M-8: 241바이트가 150MB 로 풀리는 "압축 폭탄"에 앱 본체가 멈추지 않게).
// 한 번에 풀지 않고 조금씩 풀다가 한도를 넘으면 멈추고 앞부분만 둔다(잘렸다고 표시). 풀지 못하면 받은 그대로.
function inflate(raw, stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      resolve(out);
    };
    stream.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
        stream.destroy();
        finish({ body: Buffer.concat(chunks), truncated: true });
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => finish({ body: Buffer.concat(chunks), truncated: false }));
    stream.on('error', () => finish({ body: raw, truncated: false }));
    stream.end(raw);
  });
}

async function decode(raw, encoding, truncated) {
  if (truncated || !raw.length) return { body: raw, truncated };
  const enc = String(encoding ?? '').toLowerCase().trim();
  const opts = { chunkSize: 64 * 1024 };
  if (enc === 'gzip' || enc === 'x-gzip') return inflate(raw, zlib.createGunzip(opts));
  if (enc === 'deflate') return inflate(raw, zlib.createInflate(opts));
  if (enc === 'br') return inflate(raw, zlib.createBrotliDecompress(opts));
  return { body: raw, truncated };
}

const ms = (a, b) => (a !== null && b !== null ? Math.max(0, Math.round((b - a) * 10) / 10) : null);

async function send(o) {
  let v;
  try {
    v = validate(o);
  } catch (err) {
    return { error: { fail: err.fail ?? 'error', message: err.message } };
  }
  const cancel = new AbortController();
  jobs.set(v.id, cancel);
  const timeout = AbortSignal.timeout(v.timeout);
  const signal = AbortSignal.any([cancel.signal, timeout]);
  const startedAt = performance.now();
  try {
    let url = v.url;
    let method = v.method;
    let headers = v.headers;
    let body = v.body;
    const redirects = [];
    const secret = (name) => v.sensitive.has(name.toLowerCase());
    for (;;) {
      const r = await once(url, method, headers, body, v, signal);
      const status = r.res.statusCode ?? 0;
      const location = r.res.headers.location;
      let blocked = null;
      if (v.follow && [301, 302, 303, 307, 308].includes(status) && location && redirects.length < MAX_REDIRECTS) {
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new RequestError('error', '주소가 올바르지 않습니다.');
        // 303, 그리고 301/302 의 POST 는 GET 으로 (브라우저처럼)
        const toGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
        // https → http 로 내려가는데 인증 정보(Authorization·Cookie·민감한 헤더)나 다시 보낼 본문이 있으면 따라가지 않고
        // 3xx 응답을 그대로 돌려준다 — 암호화되지 않은 연결로 나가지 않게
        if (url.protocol === 'https:' && next.protocol === 'http:' && (headers.some(([n]) => secret(n)) || (body !== null && !toGet))) {
          blocked = { status, url: next.toString(), reason: 'downgrade' };
        } else {
          redirects.push({ status, url: next.toString() });
          if (toGet) {
            if (method !== 'HEAD') method = 'GET';
            body = null;
            headers = headers.filter(([n]) => !/^(content-type|content-length)$/i.test(n));
          }
          // 다른 사이트로 가면 인증·쿠키 헤더와 화면이 민감하다고 알려 준 헤더는 떼어 낸다
          if (next.origin !== url.origin) headers = headers.filter(([n]) => !secret(n));
          url = next;
          continue;
        }
      }
      const decoded = await decode(r.raw, r.res.headers['content-encoding'], r.truncated);
      const t = r.timing;
      const rawHeaders = r.res.rawHeaders;
      const pairs = [];
      for (let i = 0; i + 1 < rawHeaders.length; i += 2) pairs.push([rawHeaders[i], rawHeaders[i + 1]]);
      return {
        status,
        statusText: r.res.statusMessage ?? '',
        httpVersion: r.res.httpVersion,
        url: url.toString(),
        headers: pairs,
        body: decoded.body.toString('base64'),
        size: decoded.body.length,
        rawSize: r.raw.length,
        truncated: r.truncated || decoded.truncated,
        redirects,
        // 따라가지 않은 리다이렉트 (https → http 에 인증 정보가 실려 있을 때)
        blockedRedirect: blocked,
        remote: r.remote,
        tls: r.tls,
        timing: {
          dns: ms(t.start, t.dns),
          connect: ms(t.dns ?? t.start, t.connect),
          tls: ms(t.connect, t.tls),
          ttfb: ms(t.tls ?? t.connect ?? t.start, t.ttfb),
          download: ms(t.ttfb, t.end),
          total: ms(startedAt, t.end),
        },
      };
    }
  } catch (err) {
    const e = err instanceof RequestError ? err : failOf(err, timeout, cancel);
    return { error: { fail: e.fail, message: e.message }, total: ms(startedAt, performance.now()) };
  } finally {
    jobs.delete(v.id);
  }
}

export function registerHttp({ handle, on }) {
  handle('http:send', (_e, o) => send(o ?? {}));
  on('http:cancel', (_e, id) => jobs.get(String(id))?.abort());
}

// 시험용
export const _internal = { send, validate, decode };
