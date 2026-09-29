// HTTP 요청 도구(앱 본체 desktop/src/http.js) 확인 — 이 PC 안의 시험용 서버로만. 저장소 루트에서: node security-review/verify-http-tool.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _internal } = await import(pathToFileURL(path.join(root, 'desktop/src/http.js')).href);
const send = (o) => _internal.send({ id: `t${Math.random().toString(36).slice(2, 8)}`, method: 'GET', headers: [], body: null, timeout: 10, follow: true, insecure: false, ...o });
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const body = (r) => Buffer.from(r.body ?? '', 'base64').toString('utf8');

// 두 번째 사이트 (다른 origin 으로 넘어갈 때 인증 헤더가 떨어지는지)
const other = http.createServer((req, res) => res.end(JSON.stringify({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })));
other.listen(0, '127.0.0.1');
await once(other, 'listening');
const otherPort = other.address().port;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const reqBody = Buffer.concat(chunks).toString('utf8');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"n":1}');
  if (u.pathname === '/echo') return res.writeHead(201, { 'content-type': 'application/json', 'x-test': 'a' }).end(JSON.stringify({ method: req.method, headers: req.headers, body: reqBody, query: u.search }));
  if (u.pathname === '/gzip') return res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end(zlib.gzipSync('압축된 본문 '.repeat(100)));
  if (u.pathname === '/redirect') return res.writeHead(302, { location: '/json' }).end();
  if (u.pathname === '/see-other') return res.writeHead(303, { location: '/echo' }).end();
  if (u.pathname === '/cross') return res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/` }).end();
  if (u.pathname === '/loop') return res.writeHead(302, { location: '/loop' }).end();
  if (u.pathname === '/slow') return setTimeout(() => res.end('late'), 3000);
  if (u.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const block = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 25 && !res.destroyed; i++) if (!res.write(block)) await once(res, 'drain').catch(() => {});
    return res.end();
  }
  res.writeHead(404).end('nope');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

// 자체 서명 인증서 HTTPS (Git 의 openssl 로 임시 발급)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-http-tool-'));
const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || fs.existsSync(p));
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=terminas-test'], { stdio: 'ignore' });
const tlsServer = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (req, res) => res.end('secure'));
tlsServer.listen(0, '127.0.0.1');
await once(tlsServer, 'listening');
const tlsBase = `https://127.0.0.1:${tlsServer.address().port}`;

try {
  const j = await send({ url: `${base}/json` });
  check('GET JSON: 코드·본문·시간', j.status === 200 && body(j) === '{"ok":true,"n":1}' && j.timing.total > 0 && j.timing.ttfb !== null, { status: j.status, timing: j.timing });

  const e = await send({ method: 'POST', url: `${base}/echo?a=1&b=%ED%95%9C`, headers: [['Content-Type', 'application/json'], ['X-Multi', 'one'], ['X-Multi', 'two']], body: '{"name":"한글"}' });
  const eb = JSON.parse(body(e));
  check('POST: 메서드·헤더(같은 이름 여러 개)·본문·쿼리가 그대로', e.status === 201 && eb.method === 'POST' && eb.body === '{"name":"한글"}' && eb.headers['x-multi'] === 'one, two' && eb.query === '?a=1&b=%ED%95%9C' && e.headers.some(([n, v]) => n === 'x-test' && v === 'a'));

  const g = await send({ url: `${base}/gzip` });
  check('gzip 응답을 풀어 준다', body(g).startsWith('압축된 본문') && g.size > g.rawSize, { size: g.size, rawSize: g.rawSize });

  const r = await send({ url: `${base}/redirect` });
  const noFollow = await send({ url: `${base}/redirect`, follow: false });
  check('리다이렉트: 따라가기 / 안 따라가기', r.status === 200 && r.redirects.length === 1 && noFollow.status === 302);

  const so = await send({ method: 'POST', url: `${base}/see-other`, headers: [['Content-Type', 'text/plain']], body: 'x' });
  check('303 은 GET 으로 바꾸고 본문을 버린다', JSON.parse(body(so)).method === 'GET' && JSON.parse(body(so)).body === '');

  const cross = await send({ url: `${base}/cross`, headers: [['Authorization', 'Bearer secret-token'], ['Cookie', 'sid=1']] });
  check('다른 사이트로 넘어가면 Authorization·Cookie 를 떼어 낸다', JSON.parse(body(cross)).auth === null && JSON.parse(body(cross)).cookie === null);

  const loop = await send({ url: `${base}/loop` });
  check('리다이렉트는 10번까지', loop.status === 302 && loop.redirects.length === 10);

  const slow = await send({ url: `${base}/slow`, timeout: 1 });
  check('시간 초과', slow.error?.fail === 'timeout', slow.error);

  const id = 'cancel-test';
  const p = _internal.send({ id, method: 'GET', url: `${base}/slow`, headers: [], body: null, timeout: 10, follow: true });
  setTimeout(() => {
    // registerHttp 의 cancel 과 같은 길: jobs 에서 찾아 abort
  }, 0);
  const mod = await import(pathToFileURL(path.join(root, 'desktop/src/http.js')).href);
  const handlers = {};
  mod.registerHttp({ handle: (n, f) => (handlers[n] = f), on: (n, f) => (handlers[n] = f) });
  await new Promise((r) => setTimeout(r, 200));
  handlers['http:cancel']({}, id);
  const cancelled = await p;
  check('취소', cancelled.error?.fail === 'cancelled', cancelled.error);

  const big = await send({ url: `${base}/big`, timeout: 30 });
  check('20MB 넘는 본문은 잘라서 받는다', big.truncated === true && big.size === 20 * 1024 * 1024, { size: big.size });

  const tlsStrict = await send({ url: tlsBase });
  const tlsLoose = await send({ url: tlsBase, insecure: true });
  check('자체 서명 인증서: 기본은 거절, "인증서 확인 끄기"면 받고 확인 안 됨 표시', tlsStrict.error?.fail === 'tls' && tlsLoose.status === 200 && tlsLoose.tls?.authorized === false && tlsLoose.tls?.subject === 'terminas-test' && tlsLoose.timing.tls !== null, { strict: tlsStrict.error?.fail });

  const inj = await send({ url: `${base}/echo`, headers: [['X-Evil', 'a\r\nX-Injected: 1']] });
  const badName = await send({ url: `${base}/echo`, headers: [['Bad Name', 'v']] });
  const ftp = await send({ url: 'ftp://example.test/' });
  const file = await send({ url: 'file:///C:/Windows/win.ini' });
  const method = await send({ method: 'GE T', url: `${base}/json` });
  check('헤더 끼워 넣기·잘못된 헤더 이름·http 가 아닌 주소·잘못된 메서드는 거절', Boolean(inj.error && badName.error && ftp.error && file.error && method.error), { inj: inj.error?.message, file: file.error?.message });

  // .invalid 는 이 PC(윈도우)에서 11초 걸려 실패한다 — 보통의 없는 이름으로
  const dns = await send({ url: 'http://no-such-host-terminas-test.example.com/' });
  const free = net.createServer();
  free.listen(0, '127.0.0.1');
  await once(free, 'listening');
  const closedPort = free.address().port;
  await new Promise((r) => free.close(r));
  const refused = await send({ url: `http://127.0.0.1:${closedPort}/` });
  check('실패 종류: 주소 못 찾음·연결 거부', dns.error?.fail === 'dns' && refused.error?.fail === 'refused', { dns: dns.error?.fail, refused: refused.error?.fail });

  // ---------- 화면 쪽 계산 (web/src/http-tools.ts): Params · 폼 표 · API 키 · 앱 기본 헤더 · 코드로 내보내기 · 쿠키 ----------
  const H = await import(pathToFileURL(path.join(root, 'web/src/http-tools.ts')).href);
  const NO_AUTH = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };
  const draft = (o = {}) => ({ label: '', collection: '', method: 'GET', url: '', headers: [], offParams: [], bodyType: 'none', body: '', auth: { ...NO_AUTH }, insecure: false, follow: true, timeout: 30, ...o });
  check('Params: 주소 → 표 (빈 조각은 건너뜀, # 뒤는 제외)', JSON.stringify(H.queryParams('{{b}}/x?a=1&&c=&d#frag')) === JSON.stringify([{ name: 'a', value: '1', on: true }, { name: 'c', value: '', on: true }, { name: 'd', value: '', on: true }]));
  const p1 = H.withParams('{{b}}/x?old=1#frag', [{ name: 'a', value: '1&2#3', on: true }, { name: 'k=v', value: '', on: true }, { name: 'off', value: 'x', on: false }, { name: 'pct', value: '100%', on: true }]);
  check('Params: 표 → 주소 (& # = % 만 바꾸고 끈 줄·# 뒤는 그대로)', p1 === '{{b}}/x?a=1%262%233&k%3Dv=&pct=100%25#frag', { p1 });
  check('Params: 모두 지우면 ? 도 없앤다', H.withParams('http://h/x?a=1', []) === 'http://h/x');
  check('폼 표: 한 줄이면 끝에 줄바꿈을 붙여 값의 & 를 지킨다', H.formText([{ name: 'a', value: 'x&y', on: true }]) === 'a=x&y\n' && JSON.stringify(H.formRows('a=x&y\n')) === JSON.stringify([{ name: 'a', value: 'x&y', on: true }]));
  check('폼 표: 옛 저장(한 줄 &) 도 읽는다', H.formRows('a=1&b=2').length === 2);
  const bForm = H.buildRequest(draft({ method: 'POST', bodyType: 'form', body: 'a=1\nb=x&y' }), []);
  check('폼 본문은 urlencoded 로', bForm.body === 'a=1&b=x%26y' && bForm.headers.some(([n, v]) => n === 'Content-Type' && v === 'application/x-www-form-urlencoded'));
  const bXml = H.buildRequest(draft({ method: 'POST', bodyType: 'xml', body: '<a/>' }), []);
  check('XML 본문은 application/xml', bXml.headers.some(([n, v]) => n === 'Content-Type' && v === 'application/xml'));
  const vars = [{ key: 'k', value: 'SECRET', secret: true }];
  const bKeyH = H.buildRequest(draft({ url: 'http://h/x', auth: { ...NO_AUTH, type: 'apikey', key: 'X-API-Key', token: '{{k}}' } }), vars);
  const bKeyQ = H.buildRequest(draft({ url: 'http://h/x?a=1#f', auth: { ...NO_AUTH, type: 'apikey', key: 'api key', token: 'v&1', keyIn: 'query' } }), []);
  check('API 키: 헤더 / 쿼리(인코딩해서 # 앞에)', bKeyH.headers.some(([n, v]) => n === 'X-API-Key' && v === 'SECRET') && bKeyQ.url === 'http://h/x?a=1&api%20key=v%261#f', { q: bKeyQ.url });
  const bAuto = H.buildRequest(draft({ url: 'http://h/', headers: [{ name: 'user-agent', value: 'mine', on: true }] }), [], '9.9.9');
  check('앱 기본 헤더: 사람이 넣은 이름은 빼고 붙인다 (코드 내보내기에는 없음)', !bAuto.auto.some(([n]) => n === 'User-Agent') && bAuto.auto.some(([n, v]) => n === 'Accept-Encoding' && /br/.test(v)) && !H.toCurl(bAuto).includes('Accept-Encoding'));
  const auto = H.autoHeaders(draft({ url: 'https://h:8443/x', bodyType: 'json', body: '{}', auth: { ...NO_AUTH, type: 'bearer', token: '{{k}}' } }), vars, '9.9.9');
  check('헤더 탭 자동 목록: 인증은 가리고 출처를 붙인다', auto.find((h) => h.name === 'Authorization')?.value === 'Bearer ●●●●' && auto.find((h) => h.name === 'Host')?.value === 'h:8443' && auto.find((h) => h.name === 'Content-Length')?.value === '2' && auto.find((h) => h.name === 'User-Agent')?.from === 'app', { auto });
  check('변수 미리보기: 가린 값은 ●●, 없는 변수는 그대로', H.substituteMasked('{{k}}/{{nope}}', vars) === '●●●●/{{nope}}');
  const code = H.buildRequest(draft({ method: 'POST', url: "http://h/x?q='1'", headers: [{ name: 'X-Q', value: "it's", on: true }], bodyType: 'json', body: '{"a":"b\'c\\n"}' }), []);
  const psCode = H.toPowerShell(code);
  const fetchCode = H.toFetch(code);
  const pyCode = H.toPython(code);
  let fetchOk = true;
  try {
    new Function(`return (async () => { ${fetchCode.replace('await fetch', 'await (async () => ({ status: 0, text: async () => "" }))')} })`);
  } catch {
    fetchOk = false;
  }
  check('코드로 내보내기: PowerShell(작은따옴표 겹치기) · fetch(문법 맞음) · Python', psCode.includes(`-Uri 'http://h/x?q=''1'''`) && psCode.includes(`'X-Q' = 'it''s'`) && psCode.includes("-ContentType 'application/json'") && fetchOk && fetchCode.includes('"X-Q": "it\'s"') && pyCode.includes('requests.request("POST", "http://h/x?q=\'1\'", headers=headers, data=data, timeout=30)'), { psCode, pyCode });
  const cookies = H.parseCookies([['Set-Cookie', 'sid=abc; Path=/; HttpOnly'], ['content-type', 'x'], ['set-cookie', 'n=']]);
  check('응답 쿠키 읽기', cookies.length === 2 && cookies[0].name === 'sid' && cookies[0].value === 'abc' && cookies[0].attrs.join('|') === 'Path=/|HttpOnly' && cookies[1].value === '');
} finally {
  server.close();
  other.close();
  tlsServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
