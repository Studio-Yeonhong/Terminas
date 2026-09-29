// HTTP 요청 도구 화면의 보강 확인 (보안 점검 2026-09-29) — 개발용 앱(Electron)을 버리는 프로필로 띄워 CDP 로 조작한다.
//   · "인증서 확인 끄기"가 켜진 요청은 주소 줄 옆에 경고 배지(누르면 설정 탭) · 설정 탭에 점 · 응답에도 배지
//   · https → http 리다이렉트를 앱 본체가 멈추면(인증 정보가 있을 때) 3xx 응답과 함께 안내 문구, http 서버는 아무것도 받지 않는다
//   · "PowerShell 로 복사"가 ’ 를 두 번 적는다 (실제 메뉴·클립보드로)
// 격리된 임시 Terminas 서버(개발 로그인)와 127.0.0.1 시험용 서버만 쓴다. 화면은 임시 폴더에 빌드한다(web/dist 는 건드리지 않는다). 창이 잠깐 뜬다.
// 저장소 루트에서: node security-review/verify-http-hardening-ui.mjs   (OUT=<폴더> 면 캡처를 남긴다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { buildUi, checker, launchApp, seedAccount, sleep, tempServer } from './ui-harness.mjs';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-http-hardening-ui-'));
const OUT = process.env.OUT || path.join(T, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const c = checker();

// http 대상 서버 (https 에서 넘어오면 안 되는 곳)
const got = [];
const target = http.createServer((req, res) => {
  got.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' }).end('plain');
});
target.listen(0, '127.0.0.1');
await once(target, 'listening');
const tbase = `http://127.0.0.1:${target.address().port}`;
// 자체 서명 https 서버: /down → http 대상으로 302
const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || fs.existsSync(p));
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=terminas-test'], { stdio: 'ignore' });
const secure = https.createServer({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')) }, (req, res) => res.writeHead(302, { location: `${tbase}/downgraded` }).end('moved'));
secure.listen(0, '127.0.0.1');
await once(secure, 'listening');
const sbase = `https://127.0.0.1:${secure.address().port}`;

const server = await tempServer(path.join(T, 'data'));
let app = null;
try {
  await server.start();
  const PW = 'http-hardening-ui-1';
  const { V, pv } = await seedAccount(server, 'owner@example.test', PW);
  const noAuth = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };
  const base = { collection: '', offParams: [], bodyType: 'none', body: '', follow: true, timeout: 30 };
  await V.vaultApi.createRequest(pv.id, { ...base, label: '보통 요청', method: 'GET', url: `${tbase}/ok`, headers: [], auth: noAuth, insecure: false });
  await V.vaultApi.createRequest(pv.id, { ...base, label: '인증서 끈 요청', method: 'GET', url: `${sbase}/down`, headers: [], auth: { ...noAuth, type: 'bearer', token: 'secret-token' }, insecure: true });
  await V.vaultApi.createRequest(pv.id, { ...base, label: '따옴표 요청', method: 'POST', url: `${tbase}/q`, headers: [{ name: 'X-Q', value: 'a\u2019;Write-Host PWNED;#', on: true }], auth: noAuth, insecure: false });

  const uiDir = buildUi(path.join(T, 'ui'));
  app = await launchApp({ base: server.base, profile: path.join(T, 'profile'), out: OUT, uiDir });
  c.check('로그인·잠금 해제', await app.signIn('owner@example.test', PW, 'Personal'));
  await app.clickText('HTTP 요청', '.sidebar button');
  await app.waitText('보통 요청');

  await app.clickText('보통 요청', '.http-item');
  await app.waitFor(`document.querySelector('.http-url input')?.value.endsWith('/ok')`);
  c.check('보통 요청: 경고 배지·설정 탭 점 없음', await app.evaluate(`!document.querySelector('.http-bar .http-insecure') && !document.querySelector('[data-pane=options] .http-tab-dot')`));

  await app.clickText('인증서 끈 요청', '.http-item');
  c.check('인증서 확인을 끈 요청: 주소 줄 옆에 "인증서 확인 꺼짐" 배지 · 설정 탭에 점', (await app.waitFor(`document.querySelector('.http-bar .http-insecure')?.innerText.includes('인증서 확인 꺼짐')`)) && (await app.evaluate(`Boolean(document.querySelector('[data-pane=options] .http-tab-dot'))`)));
  await app.shot('1-insecure-badge');
  await app.click('.http-bar .http-insecure');
  c.check('배지를 누르면 설정 탭(인증서 확인 끄기 스위치)으로', await app.waitFor(`document.querySelector('[data-pane=options]')?.getAttribute('aria-selected') === 'true' && document.querySelector('.http-options') !== null`));

  got.length = 0;
  await app.clickText('보내기');
  c.check('https → http 리다이렉트(Bearer 인증): 302 를 보여 주고 따라가지 않는다', await app.waitFor(`document.querySelector('.http-status .http-code')?.innerText.startsWith('302')`));
  c.check('안내 문구에 넘어가려던 주소 · 응답에 인증서 배지 · http 서버는 아무것도 받지 않았다', (await app.waitFor(`document.querySelector('.http-blocked')?.innerText.includes(${JSON.stringify(`${tbase}/downgraded`)})`)) && (await app.evaluate(`[...document.querySelectorAll('.http-status .badge')].some((b) => b.innerText.includes('인증서 확인 꺼짐'))`)) && got.length === 0, { got });
  await app.shot('2-blocked-redirect');

  await app.clickText('따옴표 요청', '.http-item');
  await app.waitFor(`document.querySelector('.http-url input')?.value.endsWith('/q')`);
  await app.evaluate(`[...document.querySelectorAll('.http-crumbs .icon-btn, .http-crumbs button')].find((b) => b.getAttribute('aria-label') === '더 보기' || b.title === '더 보기')?.click()`);
  await sleep(300);
  await app.clickText('PowerShell', '.menu-item');
  await sleep(500);
  const clip = await app.evaluate(`navigator.clipboard.readText()`);
  c.check("PowerShell 로 복사: ’ 를 두 번 적어 문자열 밖으로 나가지 않는다", typeof clip === 'string' && clip.includes("'X-Q' = 'a\u2019\u2019;Write-Host PWNED;#'") && clip.includes('-Method POST'), { clip: String(clip).slice(0, 300) });
} catch (err) {
  c.check(`예외: ${err?.message ?? err}`, false);
} finally {
  app?.close();
  await server.stop();
  target.close();
  secure.close();
  await sleep(500);
  console.log(`shots: ${OUT}`);
  if (!process.env.OUT) fs.rmSync(T, { recursive: true, force: true });
}
console.log(c.failures ? `\n${c.failures} FAILED` : '\nALL PASS');
process.exit(c.failures ? 1 : 0);
