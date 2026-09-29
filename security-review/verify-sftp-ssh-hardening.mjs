// 보안 검토(2026-09-29) SFTP·SSH 보강 확인: M-10 끌어다 놓기 위조, M-7 호스트 키 종류 낮추기, 심볼릭 링크 순환,
// 역슬래시 이름, 받은 파일 MOTW, bcrypt 반복 상한, 붙여넣기 제어 문자, 서버 기록 오류 분류.
// 운영 서버·data-prod·실제 SSH 호스트는 쓰지 않는다. SSH 서버는 이 시험이 127.0.0.1 에 잠깐 띄우는 ssh2 서버뿐이다.
// 저장소 루트에서: node security-review/verify-sftp-ssh-hardening.mjs
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { createRequire, register, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 웹 SSH 엔진은 확장자 없이 서로를 가져오고(Vite 방식) 생성자 매개변수 속성을 쓴다 → 여기서만 .ts 를 붙이고 변환한다 (verify-fixes.mjs 와 같다)
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]s$/.test(s)) return n(s + '.ts', c); throw e; } }
export async function load(url, c, n) {
  if (url.startsWith('file:') && url.includes('/web/src/ssh/') && url.endsWith('.ts')) {
    const src = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: stripTypeScriptTypes(src, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
  }
  return n(url, c);
}`),
);

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`구간을 찾지 못했습니다: ${start}`);
  return text.slice(a, b);
};
const tsRun = (code, tail, ctx = {}) => vm.runInNewContext(`${stripTypeScriptTypes(code, { mode: 'transform' }).replace(/^export /gm, '')}\n${tail}`, ctx);
let failures = 0;
const check = (name, ok, evidence = {}) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
};
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`시간 초과: ${label}`)), ms))]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-verify-hardening-'));

// ---------- M-10: 끌어다 놓기 표 ----------
{
  const sftpTsx = src('web/src/components/Sftp.tsx');
  const block = between(sftpTsx, '// ---------- 끌어다 놓기 표 (보안 검토 M-10) ----------', '// ---------- 끌어다 놓기 표 끝 ----------');
  const D = tsRun(block, '({ beginDrag, takeDrag, endDrag, isUncPath, DRAG_TYPE })', { crypto: globalThis.crypto });
  const adapter = { kind: 'local' };
  const nonce = D.beginDrag({ side: 'left', paths: ['C:\\Users\\me\\a.txt'], adapter });
  // 악성 페이지가 옛 형식(JSON)이나 추측한 값을 실어 놓는 경우
  const forgedJson = D.takeDrag(JSON.stringify({ side: 'left', paths: ['\\\\attacker\\share\\x', 'C:\\Users\\me\\.ssh\\id_ed25519'] }));
  const forgedGuess = D.takeDrag('00000000000000000000000000000000');
  const forgedEmpty = D.takeDrag('');
  const forgedObj = D.takeDrag({ toString: () => nonce });
  const legit = D.takeDrag(nonce);
  const replay = D.takeDrag(nonce);
  const n2 = D.beginDrag({ side: 'right', paths: ['/etc/hosts'], adapter });
  D.endDrag();
  const afterEnd = D.takeDrag(n2);
  check(
    'M-10 이 창에서 시작한 끌기의 표만 받고, 흉내 낸 데이터·재사용·끝난 끌기는 버린다',
    forgedJson === null && forgedGuess === null && forgedEmpty === null && forgedObj === null && legit?.paths?.[0] === 'C:\\Users\\me\\a.txt' && legit.adapter === adapter && replay === null && afterEnd === null && /^[0-9a-f]{32}$/.test(nonce),
    { forgedJson, forgedGuess, legitSide: legit?.side, replay, afterEnd, nonceLength: nonce.length },
  );
  const unc = ['\\\\attacker\\share\\x', '//attacker/share', '\\\\?\\UNC\\h\\s\\f', '\\\\.\\pipe\\x'].map(D.isUncPath);
  const notUnc = ['C:\\Users\\me\\a.txt', 'Z:\\team\\b', '/home/me'].map(D.isUncPath);
  check('M-10 네트워크 공유(UNC)·장치 경로를 가려낸다', unc.every(Boolean) && !notUnc.some(Boolean), { unc, notUnc });
  // 놓기 처리기가 JSON 경로를 더는 믿지 않고 표로만 꺼내는지, 바깥 파일은 UNC 를 거르는지 (소스 확인)
  const drop = between(sftpTsx, 'const onDrop = async', 'const label =');
  check(
    'M-10 놓기 처리기는 표로만 경로를 꺼내고 바깥 파일의 UNC 경로를 거른다',
    !/JSON\.parse/.test(drop) && drop.includes('takeDrag(e.dataTransfer.getData(DRAG_TYPE))') && drop.includes('!isUncPath(p)') && sftpTsx.includes('beginDrag({ side, paths, adapter })') && sftpTsx.includes('onDragEnd={endDrag}'),
    {},
  );
}

// ---------- 낮음: 붙여넣기 제어 문자 ----------
{
  const block = between(src('web/src/components/Terminal.tsx'), '// ---------- 붙여넣기 정리 ----------', '// ---------- 붙여넣기 정리 끝 ----------');
  const P = tsRun(block, '({ cleanPaste, lineCount })');
  const evil = 'echo safe\x1b[201~\nrm -rf ~/\x07\x08x\x7f\x9b31m\tend\r\n';
  const out = P.cleanPaste(evil);
  check(
    '붙여넣기·스니펫에서 ESC 등 제어 문자를 빼고 탭·줄바꿈만 남긴다',
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(out) && out.includes('\n') && out.includes('\t') && out.includes('\r') && out.startsWith('echo safe[201~'),
    { out },
  );
  check('여러 줄 스니펫의 줄 수를 센다(끝 빈 줄 제외)', P.lineCount('a\nb\r\nc\n\n') === 3 && P.lineCount('one') === 1, { three: P.lineCount('a\nb\r\nc\n\n') });
  const term = src('web/src/components/Terminal.tsx');
  check(
    '스니펫은 xterm 붙여넣기로 보내고, 클립보드 붙여넣기도 가로채 정리한다 (소스 확인)',
    term.includes("boxEl.addEventListener('paste', onPaste, true)") && term.includes('t.paste(cleanPaste(text))') && term.includes('term.paste(clean)') && !term.includes('send(run ? `${text}\\r` : text)'),
    {},
  );
}

// ---------- M-7: 호스트 키 종류 제한 (판정 함수) ----------
const desktopSsh = await import(pathToFileURL(path.join(root, 'desktop/src/ssh.js')).href);
const engine = await import(pathToFileURL(path.join(root, 'web/src/ssh/engine.ts')).href);
{
  const all = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];
  const app = {
    ed: desktopSsh.hostKeyAlgorithms(['ssh-ed25519'], all),
    rsa: desktopSsh.hostKeyAlgorithms(['ssh-rsa'], all),
    both: desktopSsh.hostKeyAlgorithms(['ssh-rsa', 'ecdsa-sha2-nistp256'], all),
    none: desktopSsh.hostKeyAlgorithms([], all),
    unknown: desktopSsh.hostKeyAlgorithms(['ssh-dss', 'x'], all),
  };
  const web = {
    ed: engine.hostKeyAlgorithmsFor(['ssh-ed25519'], all),
    rsa: engine.hostKeyAlgorithmsFor(['ssh-rsa'], all),
    none: engine.hostKeyAlgorithmsFor([], all),
  };
  check(
    'M-7 아는 종류의 호스트 키 알고리즘만 고른다 (앱·웹 같은 표, 모르면 제한 없음)',
    JSON.stringify(app.ed) === '["ssh-ed25519"]' &&
      JSON.stringify(app.rsa) === '["rsa-sha2-512","rsa-sha2-256","ssh-rsa"]' &&
      JSON.stringify(app.both) === '["ecdsa-sha2-nistp256","rsa-sha2-512","rsa-sha2-256","ssh-rsa"]' &&
      app.none === null &&
      app.unknown === null &&
      JSON.stringify(web) === JSON.stringify({ ed: app.ed, rsa: app.rsa, none: null }),
    { app, web },
  );
  const { SshClientSession } = require('@microsoft/dev-tunnels-ssh');
  const session = new SshClientSession(engine.sshConfig());
  const before = session.config.publicKeyAlgorithms.map((a) => a?.name);
  const restricted = engine.restrictHostKeys(session, ['ssh-ed25519']);
  const offered = session.kexService.getPublicKeyAlgorithms();
  const other = new SshClientSession(engine.sshConfig()).kexService.getPublicKeyAlgorithms();
  check(
    'M-7 웹: 이 세션의 호스트 키 협상 목록만 줄이고 사용자 키 인증용 설정·다른 세션은 그대로 둔다',
    JSON.stringify(restricted) === '["ssh-ed25519"]' && JSON.stringify(offered) === '["ssh-ed25519"]' && session.config.publicKeyAlgorithms.map((a) => a?.name).join() === before.join() && other.length > 1,
    { offered, other, before },
  );
  void session.dispose?.();
}

// ---------- M-7: 실제 협상 (127.0.0.1 의 일회용 ssh2 서버, RSA 호스트 키만) ----------
{
  const { Server, utils } = require('ssh2');
  const hostKey = utils.generateKeyPairSync('rsa', { bits: 2048 }).private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => (ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () =>
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (ok) => ok?.());
        s.on('shell', (ok) => ok());
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  // 앱 경로: ssh.js 를 그대로 (Electron 창 대신 가짜 webContents)
  const handlers = {};
  desktopSsh.registerSsh({ handle: (n, fn) => (handlers[n] = fn), on: (n, fn) => (handlers[n] = fn) });
  const open = (id, known) => {
    const events = [];
    const waiters = [];
    const wc = {
      isDestroyed: () => false,
      send: (_ch, _id, msg) => {
        if (_ch !== 'ssh:event' || _id !== id) return;
        events.push(msg);
        for (const w of waiters.splice(0)) w();
      },
    };
    handlers['ssh:open']({ sender: wc }, { id, kind: 'shell', target: { host: '127.0.0.1', port, username: 'u', password: 'p' }, known });
    const next = async (pred) => {
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => waiters.push(r));
      }
    };
    return { events, next: (pred) => withTimeout(next(pred), 20000, id) };
  };
  try {
    const a = open('verify-hk-type', [{ keyType: 'ssh-ed25519', fingerprint: 'SHA256:known-ed25519-fixture' }]);
    const closedA = await a.next((m) => m.t === 'closed');
    check(
      'M-7 앱: ed25519 를 아는 서버가 RSA 만 내밀면 "처음 접속" 창 없이 끊고 분류 host_key_type 을 알린다',
      closedA.code === 'host_key_type' && closedA.message === desktopSsh.HOST_KEY_TYPE_MESSAGE && !a.events.some((m) => m.t === 'hostkey'),
      { closed: closedA, events: a.events.map((m) => m.t) },
    );
    const b = open('verify-hk-new', []);
    const askB = await b.next((m) => m.t === 'hostkey');
    handlers['ssh:reply']({}, 'verify-hk-new', { t: 'hostkey', accept: false });
    const closedB = await b.next((m) => m.t === 'closed');
    check('M-7 앱(대조): 처음 보는 서버는 전처럼 묻고, 거절하면 분류 host_key_rejected', askB.state === 'new' && askB.keyType === 'ssh-rsa' && closedB.code === 'host_key_rejected', { ask: askB.state, closed: closedB.code });
    const c = open('verify-hk-okay', [{ keyType: 'ssh-rsa', fingerprint: askB.fingerprint }]);
    const readyC = await c.next((m) => m.t === 'ready' || m.t === 'closed');
    handlers['ssh:close']({}, 'verify-hk-okay');
    check('M-7 앱(대조): 저장된 종류(RSA)로는 정상 접속된다', readyC.t === 'ready', { got: readyC });

    // 웹 경로: dev-tunnels-ssh 세션을 TCP 로 직접 (중계 없이)
    const { SshClientSession, NodeStream, SshAuthenticationType } = require('@microsoft/dev-tunnels-ssh');
    const webTry = async (types) => {
      const session = new SshClientSession(engine.sshConfig());
      engine.restrictHostKeys(session, types);
      let presented = null;
      session.onAuthenticating((e) => {
        if (e.authenticationType === SshAuthenticationType.serverPublicKey) {
          presented = e.publicKey?.keyAlgorithmName ?? null;
          e.authenticationPromise = Promise.resolve({});
        }
      });
      const sock = net.connect(port, '127.0.0.1');
      await once(sock, 'connect');
      try {
        await withTimeout(session.connect(new NodeStream(sock)), 15000, 'web connect');
        // 키 교환 뒤 서버 키 확인(browser.ts 의 authenticate 가 먼저 하는 것)
        const serverOk = await withTimeout(session.authenticateServer(), 15000, 'web server auth');
        return { ok: serverOk, presented };
      } catch (err) {
        return { ok: false, message: String(err?.message ?? err), presented };
      } finally {
        await session.close(0).catch(() => {});
        sock.destroy();
      }
    };
    const webBlocked = await webTry(['ssh-ed25519']);
    const webAllowed = await webTry(['ssh-rsa']);
    check(
      'M-7 웹: ed25519 만 아는 세션은 RSA 만 내미는 서버와 협상을 거절한다 (browser.ts 가 알아보는 문장), RSA 를 알면 된다',
      !webBlocked.ok && /PublicKey negotiation/i.test(webBlocked.message) && webBlocked.presented === null && webAllowed.ok && webAllowed.presented === 'ssh-rsa',
      { webBlocked, webAllowed },
    );
    // browser.ts 의 오류 분류기를 그대로 떼어 실제 오류 문장으로 확인
    const friendlySrc = between(src('web/src/ssh/browser.ts'), '// 오류 → 화면 문장과 분류', '\nexport async function openBrowserSsh');
    const friendly = tsRun(friendlySrc, 'friendly', { t: (k) => k, HOST_KEY_TYPE_MESSAGE: 'HOST_KEY_TYPE', RelayError: class {}, KeyPassphraseError: class {} });
    const asRestricted = friendly(new Error(webBlocked.message), true);
    const asOpen = friendly(new Error(webBlocked.message), false);
    check('M-7 웹: 제한한 세션의 협상 실패는 "다른 종류의 호스트 키" 문장·host_key_type 으로 알린다', asRestricted.code === 'host_key_type' && asRestricted.message === 'HOST_KEY_TYPE' && asOpen.code === 'negotiation', { asRestricted, asOpen: asOpen.code });
  } finally {
    server.close();
  }
}

// ---------- 낮음: bcrypt 반복 상한 ----------
// OpenSSH 키 본문의 kdfoptions 안 rounds 값만 바꿔 쓴다 (실제로 큰 값으로 만들면 시험이 멈춘다)
function patchRounds(pem, rounds) {
  const body = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  let o = 15;
  const skip = () => (o += 4 + body.readUInt32BE(o));
  skip(); // cipher
  skip(); // kdf
  const optStart = o + 4;
  skip(); // kdfoptions
  const saltLen = body.readUInt32BE(optStart);
  body.writeUInt32BE(rounds, optStart + 4 + saltLen);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
{
  const keys = await import(pathToFileURL(path.join(root, 'web/src/ssh/keys.ts')).href);
  const { privateKey } = await keys.generateEd25519('verify', 'fixture-passphrase');
  const normal = await keys.parsePrivateKey(privateKey, 'fixture-passphrase').then(
    (k) => k.keyType,
    (err) => err.message,
  );
  const huge = patchRounds(privateKey, 50_000_000);
  const t0 = Date.now();
  const webHuge = await keys.parsePrivateKey(huge, 'fixture-passphrase').then(
    () => 'parsed',
    (err) => err.message,
  );
  const webNoPass = await keys.parsePrivateKey(huge, null).then(
    () => 'parsed',
    (err) => err.message,
  );
  const webMs = Date.now() - t0;
  check(
    '낮음: 웹 키 읽기는 bcrypt 반복이 1000 을 넘으면 계산 전에 거절한다 (암호를 묻기 전에도)',
    normal === 'ssh-ed25519' && /반복 횟수\(50000000회\)/.test(webHuge) && /반복 횟수/.test(webNoPass) && webMs < 2000,
    { normal, webHuge, webMs },
  );

  const { utils } = require('ssh2');
  const appKey = utils.generateKeyPairSync('ed25519', { passphrase: 'fixture-passphrase', cipher: 'aes256-ctr', rounds: 16 }).private;
  const handlers = {};
  desktopSsh.registerSsh({ handle: (n, fn) => (handlers[n] = fn), on: (n, fn) => (handlers[n] = fn) });
  const appNormal = (() => {
    try {
      return handlers['ssh:inspect']({}, { privateKey: appKey, passphrase: 'fixture-passphrase' }).keyType;
    } catch (err) {
      return err.message;
    }
  })();
  const t1 = Date.now();
  const appHuge = (() => {
    try {
      handlers['ssh:inspect']({}, { privateKey: patchRounds(appKey, 50_000_000), passphrase: 'fixture-passphrase' });
      return 'parsed';
    } catch (err) {
      return err.message;
    }
  })();
  const appMs = Date.now() - t1;
  check('낮음: 앱 키 읽기(ssh2 는 앱 본체에서 동기로 bcrypt 를 돌린다)도 1000 을 넘으면 거절한다', appNormal === 'ssh-ed25519' && /반복 횟수\(50000000회\)/.test(appHuge) && appMs < 2000, { appNormal, appHuge, appMs });
}

// ---------- 낮음: 심볼릭 링크 순환 (웹) ----------
// /src: loop → /src(폴더 링크), sub/up → /src(폴더 링크), lnk.txt → f.txt(파일 링크), f.txt
const LNK = 0o120777;
const DIR = 0o040755;
const FILE = 0o100644;
const tree = {
  '/src': [
    { filename: 'loop', attrs: { mode: LNK, size: 4 } },
    { filename: 'f.txt', attrs: { mode: FILE, size: 3 } },
    { filename: 'lnk.txt', attrs: { mode: LNK, size: 5 } },
    { filename: 'sub', attrs: { mode: DIR, size: 0 } },
  ],
  '/src/sub': [{ filename: 'up', attrs: { mode: LNK, size: 2 } }],
};
// 링크를 따라간 stat (다른 경로는 모두 끝없이 이어지는 가짜 트리: 따라가면 readdir 가 계속 불린다)
const followStat = (p) => (p === '/src' || p === '/src/sub' || p.endsWith('/loop') || p.endsWith('/up') ? { mode: DIR, size: 0 } : { mode: FILE, size: 3 });
const readdirOf = (p, calls) => {
  calls.push(p);
  if (calls.length > 30) throw new Error('LOOP: readdir 가 끝없이 불렸습니다');
  return tree[p] ?? tree['/src'];
};
{
  globalThis.window = globalThis.window ?? {};
  const { sftpOps } = await import(pathToFileURL(path.join(root, 'web/src/ssh/sftp.ts')).href);
  const { copyRemote, downloadTo } = await import(pathToFileURL(path.join(root, 'web/src/ssh/transfer.ts')).href);
  const calls = [];
  const client = {
    readdir: async (p) => readdirOf(p, calls),
    stat: async (p) => followStat(p),
    lstat: async (p) => followStat(p),
    open: async () => 'h',
    close: async () => {},
    read: async (_h, off) => (off === 0 ? new Uint8Array([1, 2, 3]) : null),
  };
  const from = sftpOps(client);
  const written = [];
  const toOps = { client: { exists: async () => false, open: async () => 'h', write: async () => {}, close: async () => {}, renameOver: async (_a, b) => written.push(b), unlink: async () => {} }, mkdir: async () => {} };
  const skipped = [];
  const job = { signal: { aborted: false }, onBytes() {}, onFile() {}, onSkip: (p) => skipped.push(p) };
  let copyError = '';
  try {
    await copyRemote(from, toOps, ['/src'], '/approved', false, false, job);
  } catch (err) {
    copyError = err.message;
  }
  check(
    '낮음: 웹 서버간 복사는 폴더 링크를 따라가지 않고 건너뛴 목록에 남긴다 (파일 링크는 복사)',
    !copyError && calls.join() === '/src,/src/sub' && written.sort().join() === '/approved/src/f.txt,/approved/src/lnk.txt' && skipped.sort().join() === '/src/loop,/src/sub/up',
    { copyError, calls, written, skipped },
  );

  calls.length = 0;
  skipped.length = 0;
  const files = [];
  const fakeDir = (prefix) => ({
    getDirectoryHandle: async (name) => fakeDir(`${prefix}/${name}`),
    getFileHandle: async (name, o) => {
      if (!o?.create) throw new Error('없음');
      files.push(`${prefix}/${name}`);
      return { createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) };
    },
  });
  let dlError = '';
  try {
    await downloadTo(from, ['/src'], { kind: 'dir', handle: fakeDir('') }, true, job);
  } catch (err) {
    dlError = err.message;
  }
  check('낮음: 웹 폴더 받기도 폴더 링크를 따라가지 않는다', !dlError && calls.join() === '/src,/src/sub' && files.sort().join() === '/src/f.txt,/src/lnk.txt' && skipped.sort().join() === '/src/loop,/src/sub/up', { dlError, calls, files, skipped });

  let topBackslash = '';
  try {
    await copyRemote(from, toOps, ['/src/we\\ird'], '/approved', false, false, job);
  } catch (err) {
    topBackslash = err.message;
  }
  check('낮음: 웹 서버간 복사도 맨 위 항목의 역슬래시 이름을 거절한다', /이름에 \\가 든 항목/.test(topBackslash), { topBackslash });
}

// ---------- 낮음: 심볼릭 링크 순환·역슬래시·MOTW (앱, 운영 코드를 떼어 모의 SFTP 로) ----------
{
  const ssh = src('desktop/src/ssh.js');
  const listFn = between(ssh, 'async function listDir(', '\nasync function removeRecursive');
  const motwFn = between(ssh, 'async function markOfTheWeb(', '\n// 원격 파일을 limit 바이트까지만');
  const downloadFn = between(ssh, 'function download(', '\n// 서버 ↔ 서버');
  const copyFn = between(ssh, 'function copyRemote(', '// ---------- 포트 포워딩');
  const calls = [];
  const sftp = { readdir: (p, cb) => Promise.resolve().then(() => cb(null, readdirOf(p, calls))).catch((err) => cb(err)) };
  const skipped = [];
  const marked = [];
  const written = [];
  const outDir = path.join(tmp, 'download');
  fs.mkdirSync(outDir);
  const ctx = {
    posix: path.posix,
    path,
    fs,
    S_IFMT: 0o170000,
    S_IFDIR: 0o040000,
    S_IFLNK: 0o120000,
    call: (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value)))),
    rstat: async (_s, p) => ({ ...followStat(p), mtime: 0 }),
    isDir: (a) => (a.mode & 0o170000) === 0o040000,
    sftpOf: () => sftp,
    text: (v) => v,
    absLocal: (v) => v,
    safeName: (n) => n,
    // 받을 곳의 링크 검사(OS-06)는 verify-public-review.mjs 에서 따로 본다 — 여기서는 통과
    checkLocalTarget: async () => {},
    crypto: require('node:crypto'),
    runJob: async (_w, _j, fn) => fn({ signal: { aborted: false }, state: {}, add() {}, fileDone() {}, skip: (p) => skipped.push(p) }),
    mkdirp: async () => {},
    rexists: async () => false,
    existsError: (p) => new Error(p),
    tmpName: (d, n) => path.posix.join(d, `.${n}.part`),
    xfer: async (_a, _b, _src, dst) => (typeof dst === 'string' && path.isAbsolute(dst) && !dst.startsWith('/') ? fs.writeFileSync(dst, 'x') : undefined),
    renameOver: async (_s, _a, dst) => written.push(dst),
    markOfTheWeb: async (f) => marked.push(path.relative(outDir, f)),
  };
  const run = (fnSrc, name) => vm.runInNewContext(`${listFn}\n${fnSrc}\n${name}`, ctx);
  let dlError = '';
  try {
    await run(downloadFn, 'download')({}, { connId: 'x', localDir: outDir, remotePaths: ['/src'], overwrite: true, jobId: 'x' });
  } catch (err) {
    dlError = err.message;
  }
  const got = fs.readdirSync(path.join(outDir, 'src'), { recursive: true }).map(String).sort();
  check(
    '낮음: 앱 폴더 받기는 폴더 링크를 따라가지 않고 건너뛴 목록에 남기며, 받은 파일마다 MOTW 를 단다',
    !dlError && calls.join() === '/src,/src/sub' && skipped.sort().join() === '/src/loop,/src/sub/up' && got.join() === ['f.txt', 'lnk.txt', 'sub'].join() && marked.sort().join() === [path.join('src', 'f.txt'), path.join('src', 'lnk.txt')].join(),
    { dlError, calls, skipped, got, marked },
  );

  calls.length = 0;
  skipped.length = 0;
  let copyError = '';
  try {
    await run(copyFn, 'copyRemote')({}, { fromConn: 'a', toConn: 'b', toDir: '/approved', paths: ['/src'], overwrite: false, jobId: 'x' });
  } catch (err) {
    copyError = err.message;
  }
  check(
    '낮음: 앱 서버간 복사도 폴더 링크를 따라가지 않는다',
    !copyError && calls.join() === '/src,/src/sub' && written.sort().join() === '/approved/src/f.txt,/approved/src/lnk.txt' && skipped.sort().join() === '/src/loop,/src/sub/up',
    { copyError, calls, written, skipped },
  );
  let topBackslash = '';
  try {
    await run(copyFn, 'copyRemote')({}, { fromConn: 'a', toConn: 'b', toDir: '/approved', paths: ['/source/..\\..\\outside'], overwrite: false, jobId: 'x' });
  } catch (err) {
    topBackslash = err.message;
  }
  check('낮음: 앱 서버간 복사는 맨 위 항목 이름의 역슬래시도 거절한다', /이름에 \\가 든 항목/.test(topBackslash), { topBackslash });

  // MOTW 함수 자체: 이 PC(NTFS 임시 폴더)에서 대체 데이터 스트림이 실제로 생기는지
  if (process.platform === 'win32') {
    const file = path.join(tmp, 'motw.bin');
    fs.writeFileSync(file, 'x');
    await vm.runInNewContext(`${motwFn}\nmarkOfTheWeb`, { fs, process })(file);
    let zone = '';
    try {
      zone = fs.readFileSync(`${file}:Zone.Identifier`, 'utf8');
    } catch (err) {
      zone = `읽지 못함: ${err.code}`;
    }
    check('낮음: 받은 파일에 Zone.Identifier(ZoneId=3)가 붙는다', zone === '[ZoneTransfer]\r\nZoneId=3\r\n', { zone });
  }
}

// ---------- 낮음: 서버 기록에는 오류 분류만 ----------
{
  const connect = src('web/src/connect.ts');
  const reports = connect.match(/report\(vaultId, 'ssh_error'[^\n]*/g) ?? [];
  const codeFn = between(connect, '// 서버 기록(ssh_error)에는', '\n// 접속해서 들은');
  const C = tsRun(codeFn, '({ errorCode })');
  check(
    '낮음: ssh_error 기록에는 문장 대신 정해진 분류만 보낸다',
    reports.length === 2 && reports.every((r) => /reason: (codeOf\(ev\)|hostKeyCode \?\? codeOf\(err\))/.test(r)) && C.errorCode('auth_failed') === 'auth_failed' && C.errorCode('connect ECONNREFUSED 10.0.0.5:22') === 'other' && C.errorCode(undefined) === 'other',
    { reports },
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
