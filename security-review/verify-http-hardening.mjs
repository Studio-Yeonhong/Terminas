// HTTP 요청 도구 보강 확인 (보안 점검 2026-09-29: M-8 압축 폭탄 · 리다이렉트 인증 헤더 · M-9 코드로 내보내기 명령 주입).
// 이 PC 안의 시험용 서버(127.0.0.1)로만 보낸다. 저장소 루트에서: node security-review/verify-http-hardening.mjs
//   HTTP_JS=<다른 http.js> 로 옛 파일을 넣어 보면 1) 2) 가 FAIL 이 나야 한다(시험이 실제로 잡는지 확인용).
// 1) 몇백 바이트~1.6KB 짜리 압축 폭탄(150MB·1GB 로 풀림)이 20MB 에서 멈추고 잘렸다고 표시되는지, 메모리가 수백 MB 늘지 않는지
// 2) 다른 사이트로 넘어갈 때 화면이 알려 준 민감한 헤더(API 키 등)를 떼는지, https → http 는 인증 정보가 있으면 따라가지 않는지
// 3) PowerShell·curl·fetch·Python 으로 내보낸 명령에 이상한 값(‘ ’ ‚ ‛ ' " \ 줄바꿈 $() 등)을 넣어도 명령 밖으로 새지 않는지 —
//    PowerShell 은 powershell.exe 로, curl 은 Git Bash 로 실제로 돌려 본다(127.0.0.1 시험용 서버에만, 표시는 Write-Host 뿐)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const httpJs = process.env.HTTP_JS ? path.resolve(process.env.HTTP_JS) : path.join(root, 'desktop/src/http.js');
const { _internal } = await import(pathToFileURL(httpJs).href);
const H = await import(pathToFileURL(path.join(root, 'web/src/http-tools.ts')).href);
const send = (o) => _internal.send({ id: `t${Math.random().toString(36).slice(2, 8)}`, method: 'GET', headers: [], body: null, timeout: 60, follow: true, insecure: false, ...o });
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const MB = 1024 * 1024;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-http-hardening-'));

// ---------- 압축 폭탄 만들기 (0 으로 가득 찬 스트림을 조금씩 압축 — 만드는 쪽도 메모리를 쓰지 않게) ----------
async function bomb(z, megabytes) {
  const out = [];
  z.on('data', (c) => out.push(c));
  const done = once(z, 'end');
  const block = Buffer.alloc(MB);
  for (let i = 0; i < megabytes; i++) if (!z.write(block)) await once(z, 'drain');
  z.end();
  await done;
  return Buffer.concat(out);
}
const brSmall = await bomb(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), 150);
const brHuge = await bomb(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }), 1024);
const gzBomb = await bomb(zlib.createGzip({ level: 9 }), 64);
const dfBomb = await bomb(zlib.createDeflate({ level: 9 }), 64);
const smallBr = zlib.brotliCompressSync(Buffer.from('작은 압축 본문 '.repeat(50)));

// ---------- 시험용 서버들 ----------
const listen = async (srv) => {
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return srv.address().port;
};
const seen = []; // 평문 http 서버들이 받은 요청
const record = (tag) => async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  seen.push({ tag, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
};
const other = http.createServer(record('other'));
const otherPort = await listen(other);
const plain = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/bomb-br-small') return res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'text/plain' }).end(brSmall);
  if (u.pathname === '/bomb-br') return res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'text/plain' }).end(brHuge);
  if (u.pathname === '/bomb-gzip') return res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end(gzBomb);
  if (u.pathname === '/bomb-deflate') return res.writeHead(200, { 'content-encoding': 'deflate', 'content-type': 'text/plain' }).end(dfBomb);
  if (u.pathname === '/small-br') return res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'text/plain' }).end(smallBr);
  if (u.pathname === '/bad-gzip') return res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end('not gzip at all');
  if (u.pathname === '/cross') return res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/landed` }).end();
  if (u.pathname === '/same') return res.writeHead(302, { location: '/landed' }).end();
  return record('plain')(req, res);
});
const plainPort = await listen(plain);
const base = `http://127.0.0.1:${plainPort}`;

const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || fs.existsSync(p));
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=terminas-test'], { stdio: 'ignore' });
const secure = https.createServer({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://x');
  const status = Number(u.searchParams.get('s') || 302);
  if (u.pathname === '/down') return res.writeHead(status, { location: `${base}/downgraded` }).end('moved');
  res.end('secure');
});
const securePort = await listen(secure);
const sbase = `https://127.0.0.1:${securePort}`;

const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// 기다리는 동안 이 프로세스의 시험용 서버가 답할 수 있게 비동기로 (spawnSync 면 서버가 멈춰 요청이 걸린다)
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (error) => (clearTimeout(timer), resolve({ status: null, stdout, stderr, error })));
    child.on('close', (status) => (clearTimeout(timer), resolve({ status, stdout, stderr })));
  });
}
const runPs = (script) => run(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64')]);
const bashExe = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'].find((p) => fs.existsSync(p));

try {
  // ================= 1) 압축 폭탄 =================
  const rssBefore = process.resourceUsage().maxRSS;
  const t0 = Date.now();
  const b1 = await send({ url: `${base}/bomb-br-small` });
  const b2 = await send({ url: `${base}/bomb-br` });
  const rssAfter = process.resourceUsage().maxRSS;
  const zeros = (r) => Buffer.from(r.body, 'base64').subarray(0, 4096).every((x) => x === 0);
  check(`brotli 폭탄 ${brSmall.length}바이트(150MB로 풀림): 20MB에서 멈추고 잘렸다고 표시`, b1.truncated === true && b1.size === 20 * MB && b1.rawSize === brSmall.length && zeros(b1), { size: b1.size, rawSize: b1.rawSize, error: b1.error });
  check(`brotli 폭탄 ${brHuge.length}바이트(1GB로 풀림): 20MB에서 멈춤`, b2.truncated === true && b2.size === 20 * MB && zeros(b2), { size: b2.size, rawSize: b2.rawSize, error: b2.error });
  const grewMb = Math.round((rssAfter - rssBefore) / 1024);
  check('폭탄 두 개를 받는 동안 메모리 최고치가 250MB 넘게 늘지 않는다(옛 코드는 1GB 넘게)', grewMb < 250, { grewMb, seconds: (Date.now() - t0) / 1000 });
  const g = await send({ url: `${base}/bomb-gzip` });
  const d = await send({ url: `${base}/bomb-deflate` });
  check('gzip·deflate 폭탄(64MB로 풀림)도 20MB에서 멈춤', g.truncated === true && g.size === 20 * MB && d.truncated === true && d.size === 20 * MB, { gzip: g.size, deflate: d.size });
  const s = await send({ url: `${base}/small-br` });
  const bad = await send({ url: `${base}/bad-gzip` });
  check('보통 압축 응답은 끝까지 풀고, 풀 수 없는 것은 받은 그대로 (잘림 표시 없음)', s.truncated === false && Buffer.from(s.body, 'base64').toString('utf8').startsWith('작은 압축 본문') && bad.truncated === false && Buffer.from(bad.body, 'base64').toString('utf8') === 'not gzip at all', { small: s.size, bad: bad.size });

  // ================= 2) 리다이렉트 =================
  seen.length = 0;
  const cross = await send({ url: `${base}/cross`, headers: [['X-API-Key', 'k-secret'], ['X-Team-Token', 't-secret'], ['X-Trace', '1'], ['Authorization', 'Bearer a']], sensitive: ['X-API-Key', 'x-team-token'] });
  const landed = seen.find((r) => r.tag === 'other');
  check('다른 사이트로 넘어가면 화면이 알려 준 민감한 헤더(API 키 등)도 떼어 낸다 · 보통 헤더는 그대로', cross.status === 200 && landed && !landed.headers['x-api-key'] && !landed.headers['x-team-token'] && !landed.headers.authorization && landed.headers['x-trace'] === '1', { got: landed?.headers });
  seen.length = 0;
  await send({ url: `${base}/same`, headers: [['X-API-Key', 'k-secret']], sensitive: ['X-API-Key'] });
  check('같은 사이트 안의 리다이렉트는 민감한 헤더를 그대로 둔다', seen[0]?.headers['x-api-key'] === 'k-secret', { got: seen[0]?.headers['x-api-key'] });
  const badNames = _internal.validate({ id: 'x', method: 'get', url: 'http://h/', sensitive: ['ok-name', 'bad name', 'a\r\nb', null] });
  check('민감한 헤더 목록의 이상한 이름은 버린다 · 메서드는 대문자로', badNames.sensitive.has('ok-name') && !badNames.sensitive.has('bad name') && badNames.sensitive.size === 4 && badNames.method === 'GET', { list: [...badNames.sensitive] });

  // 화면 쪽: 어떤 헤더를 민감하다고 알려 주는지 (API 키 헤더 · 가린 변수를 쓰는 헤더 · 이름이 토큰 같은 헤더 · Authorization)
  const NO_AUTH = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };
  const draft = (o = {}) => ({ label: '', collection: '', method: 'GET', url: '', headers: [], offParams: [], bodyType: 'none', body: '', auth: { ...NO_AUTH }, insecure: false, follow: true, timeout: 30, ...o });
  const vars = [{ key: 'sec', value: 'hidden-value', secret: true }, { key: 'pub', value: 'plain', secret: false }];
  const built = H.buildRequest(draft({ url: `${base}/cross`, headers: [{ name: 'X-Tenant', value: '{{sec}}', on: true }, { name: 'X-Plain', value: '{{pub}}', on: true }, { name: 'X-Access-Token', value: 'v', on: true }], auth: { ...NO_AUTH, type: 'apikey', key: 'X-My-Key', token: 'k' } }), vars, '9.9.9');
  const sens = new Set(built.sensitive.map((n) => n.toLowerCase()));
  check('화면이 민감한 헤더를 고른다: API 키 헤더·가린 변수 헤더·토큰 이름 (보통 변수 헤더는 아님)', sens.has('x-my-key') && sens.has('x-tenant') && sens.has('x-access-token') && !sens.has('x-plain'), { sensitive: built.sensitive });
  seen.length = 0;
  await send({ url: built.url, method: built.method, headers: [...built.headers, ...built.auto], sensitive: built.sensitive });
  const e2e = seen.find((r) => r.tag === 'other')?.headers ?? {};
  check('화면 → 앱 본체: 다른 사이트에 API 키·가린 변수 헤더가 가지 않는다', !e2e['x-my-key'] && !e2e['x-tenant'] && !e2e['x-access-token'] && e2e['x-plain'] === 'plain' && /^Terminas\//.test(e2e['user-agent'] ?? ''), { got: e2e });
  const bearer = H.buildRequest(draft({ url: 'http://h/', auth: { ...NO_AUTH, type: 'bearer', token: 't' } }), []);
  check('Bearer·Basic 인증 헤더도 민감한 헤더 목록에', bearer.sensitive.includes('Authorization'));

  // https → http
  seen.length = 0;
  const down = await send({ url: `${sbase}/down`, insecure: true, headers: [['Authorization', 'Bearer secret']] });
  check('https → http 리다이렉트: Authorization 이 있으면 따라가지 않고 3xx 를 돌려준다', down.status === 302 && down.blockedRedirect?.url === `${base}/downgraded` && down.redirects.length === 0 && Buffer.from(down.body, 'base64').toString() === 'moved' && seen.length === 0, { status: down.status, blocked: down.blockedRedirect, httpGot: seen.length });
  const downKey = await send({ url: `${sbase}/down`, insecure: true, headers: [['X-API-Key', 'k']], sensitive: ['X-API-Key'] });
  const downCookie = await send({ url: `${sbase}/down`, insecure: true, headers: [['Cookie', 'sid=1']] });
  check('https → http: API 키(민감한 헤더)·Cookie 가 있어도 멈춘다', downKey.status === 302 && downKey.blockedRedirect && downCookie.status === 302 && downCookie.blockedRedirect && seen.length === 0);
  const down307 = await send({ url: `${sbase}/down?s=307`, method: 'POST', insecure: true, headers: [['Content-Type', 'text/plain']], body: 'password=hunter2' });
  check('https → http 307: 다시 보낼 본문이 있으면 멈춘다', down307.status === 307 && down307.blockedRedirect && seen.length === 0, { status: down307.status });
  const downPlain = await send({ url: `${sbase}/down`, insecure: true, headers: [['X-Trace', '1']] });
  check('https → http: 인증 정보가 없으면 따라간다 (전과 같이)', downPlain.status === 200 && !downPlain.blockedRedirect && downPlain.redirects.length === 1 && seen.some((r) => r.url === '/downgraded'), { status: downPlain.status });
  seen.length = 0;
  const downOff = await send({ url: `${sbase}/down`, insecure: true, follow: false, headers: [['Authorization', 'Bearer secret']] });
  check('리다이렉트 따라가기를 끈 요청은 원래대로 3xx (멈춤 표시 없음)', downOff.status === 302 && !downOff.blockedRedirect && seen.length === 0);

  // ================= 3) 코드로 내보내기 =================
  // 메서드
  const curlBad = H.parseCurl(`curl -X 'GET;Write-Host PWNED-M' ${base}/x`);
  const curlBad2 = H.parseCurl(`curl -X "GET\`nWrite-Host PWNED" ${base}/x`);
  const curlOk = H.parseCurl(`curl -X m-search ${base}/x`);
  check('curl 가져오기: 메서드 자리에 명령이 있으면 읽지 않는다 · 정상 메서드는 대문자로', curlBad === null && curlBad2 === null && curlOk?.method === 'M-SEARCH', { ok: curlOk?.method });
  const evilBuilt = H.buildRequest(draft({ method: 'GET;Write-Host PWNED', url: 'http://h/' }), []);
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('요청 만들기: 규칙에 맞지 않는 메서드는 빈 값 · 내보내기 4종 모두 거절', evilBuilt.method === '' && [H.toCurl, H.toPowerShell, H.toFetch, H.toPython].every((f) => throws(() => f(evilBuilt))) && throws(() => H.toPowerShell({ ...evilBuilt, method: 'GET ; calc' })));
  check('요청 만들기: 소문자 메서드는 대문자로', H.buildRequest(draft({ method: 'patch', url: 'http://h/' }), []).method === 'PATCH');

  // 이상한 값: PowerShell 작은따옴표를 끝내는 ‘ ’ ‚ ‛ (+ 나머지 줄을 주석으로 만드는 #), ASCII ' " “ ”, 역슬래시(끝에도), 줄바꿈, $() 와 `(백틱).
  // 공격 조각은 옛 코드에서 PowerShell 문법이 맞게 짰다 — 문법 오류면 스크립트 전체가 안 돌아 뚫렸는지 알 수 없다
  const Q = { l: '‘', r: '’', lo: '‚', rev: '‛' };
  const hdrPayload = `${Q.r} + $(Write-Host PWNED-HDR) + ${Q.r}`; // 해시테이블 값 자리
  const argPayload = (tag) => `${Q.rev};Write-Host PWNED-${tag};#`; // 명령 인자 자리
  const hdrValue = `${hdrPayload} '"“” \`$x ${Q.l}${Q.lo} end\\`;
  const bodyValue = `${argPayload('BODY')}\n'; Write-Host PWNED-BODY2; #\n$(PWNED-SH) \`PWNED-SH2\`\n"\\\\n \\' ${Q.r} end\\`;
  const urlValue = `${base}/inj?b=$(PWNED-SHURL)&a=${Q.r};Write-Host${Q.l}PWNED-URL;#frag`;
  const hostile = H.buildRequest(draft({ method: 'POST', url: urlValue, headers: [{ name: 'X-Evil', value: hdrValue, on: true }], bodyType: 'text', body: bodyValue }), []);
  const expectQuery = new URL(urlValue).searchParams;
  const sameUrlBody = (r) => r && r.body === bodyValue && new URL(r.url, 'http://x').searchParams.get('a') === expectQuery.get('a') && new URL(r.url, 'http://x').searchParams.get('b') === expectQuery.get('b');
  const same = (r) => sameUrlBody(r) && r.headers['x-evil'] === hdrValue;

  // PowerShell: 먼저 옛 방식(' 만 겹침)이 실제로 뚫리는지 보여 주고(시험 값이 진짜 공격인지), 새 내보내기는 안 뚫리고 값이 그대로 가는지
  const oldPs = (x) => `'${x.replace(/'/g, "''")}'`;
  const control = await runPs(`$h = @{ 'X' = ${oldPs(hdrPayload)} }\nWrite-Output ${oldPs(argPayload('ARG'))} -NoEnumerate`);
  check('(대조) 옛 PowerShell 따옴표 처리는 ’ ‛ 로 뚫린다 (해시테이블 값·명령 인자 둘 다)', /PWNED-HDR/.test(control.stdout) && /PWNED-ARG/.test(control.stdout), { out: control.stdout.trim().split(/\r?\n/).slice(0, 3), err: control.stderr.slice(0, 200) });
  seen.length = 0;
  const psCode = H.toPowerShell(hostile);
  const psRun = await runPs(`${psCode} | Out-Null`);
  // Windows PowerShell 5.1(.NET Framework)은 헤더 값에 ‘ ’ 같은 글자가 있으면 보내기 전에 거절한다(실행 오류) — 여기서는 문법이 맞고
  // 아무것도 실행되지 않았는지만 본다. 값이 그대로 가는지는 헤더만 ASCII 공격 조각으로 바꿔 한 번 더 보낸다
  check('PowerShell 내보내기: ‘ ’ ‚ ‛ · # · $() · 백틱이 명령이 되지 않는다 (powershell.exe 로 실행, 문법 오류 없음)', !/PWNED/.test(psRun.stdout) && !/ParserError|ParseException/.test(psRun.stderr), { status: psRun.status, out: psRun.stdout.slice(0, 200) });
  const asciiHdr = `' + $(Write-Host PWNED-A) + ' "\`$x;Write-Host PWNED-A2;# \\`;
  seen.length = 0;
  const psRun2 = await runPs(`${H.toPowerShell(H.buildRequest(draft({ method: 'POST', url: urlValue, headers: [{ name: 'X-Evil', value: asciiHdr, on: true }], bodyType: 'text', body: bodyValue }), []))} | Out-Null`);
  const psGot = seen.find((r) => r.url.startsWith('/inj'));
  check('PowerShell 내보내기: 실제로 보내지고, 서버가 받은 주소·본문(‘ ’ 포함)·헤더가 원래 값 그대로', psRun2.status === 0 && !/PWNED/.test(psRun2.stdout) && sameUrlBody(psGot) && psGot.headers['x-evil'] === asciiHdr && psGot.method === 'POST', { status: psRun2.status, body: psGot?.body, url: psGot?.url, header: psGot?.headers['x-evil'], err: psRun2.stderr.slice(0, 200) });
  const psCustom = H.toPowerShell(H.buildRequest(draft({ method: 'PROPFIND', url: 'http://h/' }), []));
  check('PowerShell 내보내기: -Method 가 받지 않는 메서드는 -CustomMethod 로 따옴표 안에', psCustom.includes("-CustomMethod 'PROPFIND'") && !/-Method PROPFIND/.test(psCustom));

  // curl: bash(Git Bash)로 실제로 보내 값이 그대로 가는지 · 같은 명령을 PowerShell 에 붙여 넣어도 명령이 되지 않는지 · curl 가져오기로 되돌아오는지
  const curlCode = H.toCurl(hostile);
  if (bashExe) {
    // 명령줄 인자로 넘기면 Windows 인자 따옴표 규칙이 끼어들어, 붙여 넣은 것처럼 스크립트 파일(UTF-8)로 돌린다.
    // (가) bash 가 curl 에 넘기는 인자를 그대로 적는 함수로 바꿔, 인자가 원래 값과 글자 하나까지 같은지
    const argsFile = path.join(T, 'args.bin').replace(/\\/g, '/');
    fs.writeFileSync(path.join(T, 'argv.sh'), `curl() { printf '%s\\0' "$@" > '${argsFile}'; }\n${curlCode}\n`);
    const shArgs = await run(bashExe, ['--noprofile', '--norc', path.join(T, 'argv.sh')]);
    const argv = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\0').slice(0, -1) : [];
    const wantArgv = ['-X', 'POST', urlValue, '-H', `X-Evil: ${hdrValue}`, '-H', 'Content-Type: text/plain; charset=utf-8', '--data-raw', bodyValue, '-L'];
    check('curl 내보내기: bash 가 curl 에 넘기는 인자가 원래 값 그대로 ($() · 백틱 · 따옴표 · 역슬래시 · # · 줄바꿈)', shArgs.status === 0 && !/PWNED/.test(shArgs.stdout + shArgs.stderr) && JSON.stringify(argv) === JSON.stringify(wantArgv), { status: shArgs.status, argv: argv.slice(0, 4), err: shArgs.stderr.slice(0, 200) });
    // (나) 실제 curl 로 보내기 — Git 의 curl.exe 는 인자를 시스템 코드 페이지로 받아 한글·‘ ’ 가 깨지므로 ASCII 공격 조각으로
    seen.length = 0;
    const asciiBody = `'; echo PWNED-B; # $(PWNED-C) \`PWNED-D\` "\\" \\' \\\\ end\\`;
    const curlSend = H.toCurl(H.buildRequest(draft({ method: 'POST', url: `${base}/inj3?b=$(PWNED-SHURL)&a=';echo%20PWNED-U;#`, headers: [{ name: 'X-Evil', value: asciiHdr, on: true }], bodyType: 'text', body: asciiBody }), []));
    fs.writeFileSync(path.join(T, 'curl.sh'), `${curlSend} -s -o /dev/null\n`);
    const sh = await run(bashExe, ['--noprofile', '--norc', path.join(T, 'curl.sh')]);
    const shGot = seen.find((r) => r.url.startsWith('/inj3'));
    check('curl 내보내기: bash 에서 실제 curl 로 보내도 명령이 되지 않고 서버가 받은 값이 그대로', sh.status === 0 && !/PWNED/.test(sh.stdout + sh.stderr) && shGot?.body === asciiBody && shGot.headers['x-evil'] === asciiHdr && new URL(shGot.url, 'http://x').searchParams.get('b') === '$(PWNED-SHURL)', { status: sh.status, err: sh.stderr.slice(0, 200), url: shGot?.url, body: shGot?.body });
  } else check('curl 내보내기: bash 로 실행 (Git Bash 없음 — 건너뜀)', true);
  const oldQ = (x) => `'${x.replace(/'/g, `'"'"'`)}'`;
  const curlControl = await runPs(`curl.exe -s -o NUL --data-raw ${oldQ(argPayload('CURLPS'))} ${oldQ(`${base}/ctl`)}`);
  const curlPs = await runPs(curlCode);
  check('(대조) 옛 curl 따옴표 처리는 PowerShell 에 붙여 넣으면 ‛ 로 뚫린다', /PWNED-CURLPS/.test(curlControl.stdout), { out: curlControl.stdout.trim().split(/\r?\n/).slice(0, 2) });
  check('curl 내보내기: PowerShell 에 붙여 넣어도 명령이 되지 않는다(실행은 실패해도 된다)', !/PWNED/.test(curlPs.stdout), { out: curlPs.stdout.split('\n').filter((l) => /PWNED/.test(l)).slice(0, 2) });
  const back = H.parseCurl(curlCode);
  check('curl 내보내기 → curl 가져오기: 메서드·주소·헤더·본문이 그대로 돌아온다', back?.method === 'POST' && back.url === urlValue && back.headers.some((h) => h.name === 'X-Evil' && h.value === hdrValue) && back.body === bodyValue, { url: back?.url, body: back?.body });
  const dashUrl = H.toCurl(H.buildRequest(draft({ url: '-K\\\\attacker\\share\\cfg' }), []));
  check('curl 내보내기: - 로 시작하는 주소는 --url 뒤에 (curl 옵션으로 읽히지 않게)', /^curl --url '-K/.test(dashUrl), { dashUrl });
  const fishTail = H.toCurl(H.buildRequest(draft({ url: 'http://h/', headers: [{ name: 'X-A', value: 'a\\', on: true }, { name: 'X-B', value: "b\\'c", on: true }] }), []));
  check('curl 내보내기: 역슬래시가 따옴표 앞·맨 끝에 오면 따옴표 밖으로 (fish 는 작은따옴표 안의 \\\' \\\\ 를 푼다)', !/\\'/.test(fishTail.replace(/'"\\\\"'/g, '')), { fishTail });

  // fetch: 생성된 코드를 fetch 대신 기록하는 함수로 실행해 값이 그대로인지 · Python: requests 를 기록용 가짜로 바꿔 실행
  const fetchCode = H.toFetch(hostile);
  const captured = await new Function('fetch', 'console', `return (async () => { ${fetchCode} })()`)(async (url, opts) => ((globalThis.__cap = { url, opts }), { status: 0, text: async () => '' }), { log() {} });
  const cap = globalThis.__cap;
  check('fetch 내보내기: 문법이 맞고 주소·헤더·본문·메서드가 원래 값 그대로', captured === undefined && cap?.url === urlValue && cap.opts.headers['X-Evil'] === hdrValue && cap.opts.body === bodyValue && cap.opts.method === 'POST', { url: cap?.url });
  const pyDir = path.join(T, 'py');
  fs.mkdirSync(pyDir);
  fs.writeFileSync(path.join(pyDir, 'requests.py'), 'import json, sys\ndef request(method, url, headers=None, data=None, **kw):\n    sys.stdout.buffer.write(json.dumps({"method": method, "url": url, "headers": headers, "data": data.decode("utf-8") if data is not None else None, "kw": sorted(kw)}).encode("utf-8"))\n    class R: status_code = 0; text = ""\n    return R()\n');
  const pyCode = H.toPython(hostile).replace('print(res.status_code, res.text)', '');
  const py = await run('python', ['-c', pyCode], { cwd: pyDir, env: { ...process.env, PYTHONPATH: pyDir, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  let pyOut = null;
  try {
    pyOut = JSON.parse(py.stdout);
  } catch {}
  if (py.error?.code === 'ENOENT') check('Python 내보내기: python 이 없어 건너뜀', true);
  else check('Python 내보내기: 문법이 맞고 주소·헤더·본문·메서드가 원래 값 그대로', py.status === 0 && pyOut?.method === 'POST' && pyOut.url === urlValue && pyOut.headers['X-Evil'] === hdrValue && pyOut.data === bodyValue, { status: py.status, err: py.stderr.slice(0, 300) });
} finally {
  plain.close();
  other.close();
  secure.close();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
