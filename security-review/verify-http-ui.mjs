// HTTP 요청 도구 화면 확인 — 개발용 앱(Electron)을 버리는 프로필로 띄워 CDP 로 조작하고, 이 PC 안의 시험용 HTTP 서버가 실제로 받은 것을 본다.
// 격리된 임시 Terminas 서버(개발 로그인)만 쓴다. 화면은 따로 된 폴더에 빌드한다(운영 서버가 쓰는 web/dist 는 건드리지 않는다). 창이 잠깐 뜬다.
// 저장소 루트에서: node security-review/verify-http-ui.mjs   (화면 캡처는 OUT 폴더, 기본 임시 폴더)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { buildUi, checker, launchApp, seedAccount, sleep, tempServer } from './ui-harness.mjs';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-http-ui-'));
const OUT = process.env.OUT || path.join(T, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const c = checker();

// 시험용 대상 서버: 받은 요청을 적어 둔다
const got = [];
const target = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Max-Age=60'] });
  res.end(JSON.stringify({ ok: true, path: req.url, items: [{ id: 1, name: '하나' }, { id: 2, name: 'two' }] }));
});
target.listen(0, '127.0.0.1');
await once(target, 'listening');
const tbase = `http://127.0.0.1:${target.address().port}`;
const last = () => got[got.length - 1];

const server = await tempServer(path.join(T, 'data'));
let app = null;
try {
  await server.start();
  const PW = 'http-ui-password-1';
  const { V, pv } = await seedAccount(server, 'owner@example.test', PW);
  await V.vaultApi.createHttpEnv(pv.id, { name: '로컬', vars: [{ key: 'base', value: tbase, secret: false }, { key: 'token', value: 's3cr3t-token', secret: true }] });
  const noAuth = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };
  await V.vaultApi.createRequest(pv.id, { label: '항목 목록', collection: 'Demo API', method: 'GET', url: '{{base}}/v1/items?limit=10&sort=name', headers: [{ name: 'X-Trace', value: '1', on: true }], offParams: [], bodyType: 'none', body: '', auth: { ...noAuth, type: 'bearer', token: '{{token}}' } });
  await V.vaultApi.createRequest(pv.id, { label: '항목 만들기', collection: 'Demo API', method: 'POST', url: '{{base}}/v1/items', headers: [], offParams: [], bodyType: 'json', body: '{"name":"새 항목"}', auth: noAuth });
  await V.vaultApi.createRequest(pv.id, { label: 'health', collection: '', method: 'GET', url: `${tbase}/health`, headers: [], offParams: [], bodyType: 'none', body: '', auth: noAuth });

  const uiDir = buildUi(path.join(T, 'ui'));
  app = await launchApp({ base: server.base, profile: path.join(T, 'profile'), out: OUT, uiDir });
  c.check('로그인·잠금 해제', await app.signIn('owner@example.test', PW, 'Personal'));
  await app.clickText('HTTP 요청', '.sidebar button');
  c.check('HTTP 화면: 모음(접기)·기록', (await app.waitText('Demo API')) && (await app.waitText('모음 없음')));

  // 환경 고르기 (위쪽 오른쪽)
  await app.click('.http-envpick .select-btn');
  await sleep(300);
  await app.clickText('로컬', '.select-option');
  await sleep(300);

  // 저장한 요청 열기 → 탭
  await app.clickText('항목 목록', '.http-item');
  c.check('저장한 요청이 탭으로 열린다', await app.waitFor(`[...document.querySelectorAll('.http-rtab')].some((t) => t.innerText.includes('항목 목록'))`));
  c.check('주소의 변수를 채운 미리보기 (가린 값은 ●●)', await app.waitText(`${tbase.replace('http://', 'http://')}/v1/items?limit=10&sort=name`));
  c.check('Params 표 = 주소의 쿼리 2개', await app.waitFor(`document.querySelectorAll('.http-editor .http-kv-row').length === 3`));
  // sort 끄기 · limit 을 20 으로 · 빈 줄에 q=한 글
  await app.evaluate(`document.querySelectorAll('.http-editor .http-kv-row')[1].querySelector('input[type=checkbox]').click()`);
  await sleep(200);
  c.check('Params 끄기: 주소에서 빠지고 표에는 남는다', await app.waitFor(`document.querySelector('.http-url input').value === '{{base}}/v1/items?limit=10' && document.querySelectorAll('.http-editor .http-kv-row.off').length === 1`));
  // 빈 줄은 켜진 것(limit)과 끈 것(sort) 사이 = 2번째 줄. 새 줄이 그 자리에 생겨 같은 칸에 이어 쓴다
  await app.fill('.http-editor .http-kv-row:nth-child(1) .input:nth-of-type(2) input', '20');
  await app.fill('.http-editor .http-kv-row:nth-child(2) .input:nth-of-type(1) input', 'q');
  await sleep(150);
  c.check('빈 줄에 쓰면 그 자리에 새 줄이 생긴다 (끈 줄은 아래 그대로)', await app.waitFor(`(() => { const rows = [...document.querySelectorAll('.http-editor .http-kv-row')]; return rows.length === 4 && rows[1].querySelector('input:not([type=checkbox])').value === 'q' && rows[3].classList.contains('off'); })()`));
  await app.fill('.http-editor .http-kv-row:nth-child(2) .input:nth-of-type(2) input', '한 글&x');
  await sleep(200);
  const url1 = await app.evaluate(`document.querySelector('.http-url input').value`);
  c.check('Params 를 고치면 주소가 따라간다 (& 는 %26)', url1 === '{{base}}/v1/items?limit=20&q=한 글%26x', { url1 });
  c.check('고친 탭에 저장 안 함 표시', await app.waitFor(`document.querySelector('.http-rtab.on .http-dirty') !== null`));
  await app.shot('1-params');

  // 헤더 탭: 앱이 붙이는 헤더
  await app.click('[data-pane=headers]');
  await app.evaluate(`document.querySelector('.http-auto-toggle').click()`);
  c.check('헤더 탭에 앱이 붙이는 헤더 (인증 가림·User-Agent 등)', (await app.waitText('Bearer ●●●●')) && (await app.waitText('User-Agent')) && (await app.waitText('앱 기본값')));
  await app.shot('2-auto-headers');

  // 보내기
  await app.clickText('보내기');
  c.check('응답 200', await app.waitFor(`document.querySelector('.http-status .http-code')?.innerText.startsWith('200')`));
  const r1 = last();
  c.check('대상이 받은 것: 쿼리·인증·내 헤더·앱 기본 헤더', r1.url === '/v1/items?limit=20&q=%ED%95%9C%20%EA%B8%80%26x' && r1.headers.authorization === 'Bearer s3cr3t-token' && r1.headers['x-trace'] === '1' && /^Terminas\//.test(r1.headers['user-agent']) && r1.headers.accept === '*/*' && /gzip/.test(r1.headers['accept-encoding']), { url: r1.url, ua: r1.headers['user-agent'] });
  await app.click('[data-view=cookies]');
  c.check('응답 쿠키 탭 (2개)', (await app.waitText('sid')) && (await app.waitText('HttpOnly')) && (await app.evaluate(`[...document.querySelectorAll('.http-status .seg button')].find((b) => b.innerText.startsWith('쿠키'))?.innerText.includes('2')`)));
  await app.click('[data-view=body]');
  await app.shot('3-response');

  // 다른 저장 요청을 열어도 묻지 않고 새 탭 · 첫 탭은 그대로
  await app.clickText('항목 만들기', '.http-item');
  c.check('다른 요청은 새 탭 (고치던 탭을 버릴지 묻지 않는다)', await app.waitFor(`document.querySelectorAll('.http-rtab').length === 2 && !document.querySelector('.modal')`));
  // 화면 전환(SFTP 탭)에 다녀와도 탭·응답이 남는다
  await app.click('.tab-fixed .tab-main');
  await sleep(600);
  await app.click('.tab-vault .tab-main');
  await sleep(600);
  await app.clickText('HTTP 요청', '.sidebar button');
  await sleep(300);
  c.check('다른 화면에 다녀와도 열린 탭이 남는다', await app.waitFor(`document.querySelectorAll('.http-rtab').length === 2`));
  await app.evaluate(`[...document.querySelectorAll('.http-rtab-main')].find((b) => b.innerText.includes('항목 목록')).click()`);
  c.check('첫 탭의 응답도 남아 있다', await app.waitFor(`document.querySelector('.http-status .http-code')?.innerText.startsWith('200')`));

  // 기록 → 새 탭으로 다시 열기
  await app.click('[data-side=history]');
  c.check('기록: 보낸 요청 1개 (메모리에만)', await app.waitFor(`document.querySelectorAll('.http-hist').length === 1`));
  await app.shot('4-history');
  await app.click('.http-hist');
  c.check('기록을 누르면 새 탭(저장 안 함)으로 응답과 함께 열린다', await app.waitFor(`document.querySelectorAll('.http-rtab').length === 3 && document.querySelector('.http-rtab.on .http-dirty') && document.querySelector('.http-status .http-code')?.innerText.startsWith('200')`));

  // 새 요청: API 키(쿼리) + 폼 본문 표
  await app.click('.http-rtab-add');
  await sleep(300);
  await app.evaluate(`document.querySelector('.select-btn.http-method-select').click()`);
  await sleep(200);
  await app.clickText('POST', '.select-option');
  await app.fill('.http-url input', `${tbase}/submit`);
  await app.click('[data-pane=auth]');
  await app.clickText('API 키', '.http-auth .seg button');
  await app.fill('.http-auth input[placeholder^="이름"]', 'api_key');
  await app.fill('.http-auth input[type=password]', 'k-123');
  await app.evaluate(`document.querySelector('.http-auth .select-btn').click()`);
  await sleep(200);
  await app.clickText('쿼리 파라미터', '.select-option');
  await app.click('[data-pane=body]');
  await app.clickText('폼', '.http-body-editor .seg button');
  await app.fill('.http-body-editor .http-kv-row:nth-child(1) .input:nth-of-type(1) input', 'a');
  await sleep(100);
  await app.fill('.http-body-editor .http-kv-row:nth-child(1) .input:nth-of-type(2) input', '1');
  await sleep(100);
  await app.fill('.http-body-editor .http-kv-row:nth-child(2) .input:nth-of-type(1) input', 'b');
  await sleep(100);
  await app.fill('.http-body-editor .http-kv-row:nth-child(2) .input:nth-of-type(2) input', 'x&y');
  await sleep(200);
  await app.shot('5-form');
  await app.key('.http-url input', 'Enter', { ctrl: true });
  await app.waitFor(`document.querySelector('.http-status .http-code')?.innerText.startsWith('200')`);
  const r2 = last();
  c.check('API 키를 쿼리에 · 폼 표를 urlencoded 로 (값의 & 도 그대로)', r2.method === 'POST' && r2.url === '/submit?api_key=k-123' && r2.body === 'a=1&b=x%26y' && r2.headers['content-type'] === 'application/x-www-form-urlencoded', { url: r2.url, body: r2.body });

  // 저장: 이름을 묻고 모음 없음에 들어간다 → 저장 표시가 사라진다
  await app.key('.http-url input', 's', { ctrl: true });
  await app.waitText('요청 저장');
  await app.fill('.modal input', '폼 보내기');
  await app.evaluate(`document.querySelector('.modal form')?.requestSubmit() ?? [...document.querySelectorAll('.modal button')].find((b) => b.innerText.trim() === '저장').click()`);
  await app.click('[data-side=saved]');
  c.check('Ctrl+S 로 저장 → 목록에 생기고 저장 안 함 표시가 사라진다', (await app.waitFor(`[...document.querySelectorAll('.http-item')].some((b) => b.innerText.includes('폼 보내기'))`)) && (await app.waitFor(`!document.querySelector('.http-rtab.on .http-dirty')`)));
  const saved = V.itemsOf(pv.id).requests.length;
  await V.loadVault(pv);
  const again = V.itemsOf(pv.id).requests.find((r) => r.label === '폼 보내기');
  c.check('저장된 요청: API 키(쿼리)·폼 본문이 그대로', again?.auth.type === 'apikey' && again.auth.keyIn === 'query' && again.auth.key === 'api_key' && again.bodyType === 'form' && again.body === 'a=1\nb=x&y', { saved, auth: again?.auth.type, body: again?.body });

  // 탭 닫기: 저장 안 한 탭은 묻는다
  await app.evaluate(`[...document.querySelectorAll('.http-rtab')].find((t) => t.querySelector('.http-dirty')).querySelector('.http-rtab-close').click()`);
  c.check('저장 안 한 탭을 닫으면 묻는다', await app.waitText('버리고 닫을까요?'));
  await app.clickText('버리기', '.modal button');
  await sleep(300);
  c.check('버리면 닫힌다', await app.waitFor(`document.querySelectorAll('.http-rtab').length === 3`));
  await app.shot('6-final');
} catch (err) {
  c.check(`예외: ${err?.message ?? err}`, false);
} finally {
  app?.close();
  await server.stop();
  target.close();
  await sleep(500);
  console.log(`shots: ${OUT}`);
  if (!process.env.OUT) fs.rmSync(path.join(T, 'profile'), { recursive: true, force: true });
}
console.log(c.failures ? `\n${c.failures} FAILED` : '\nALL PASS');
process.exit(c.failures ? 1 : 0);
