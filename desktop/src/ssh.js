// PC 에서 서버로 직접 SSH 를 연다(터미널·SFTP·포트 포워딩). 게이트웨이는 이 연결에 끼지 않는다.
// 비밀번호·개인키는 화면이 볼트 키로 풀어서 넘겨 주고, 여기서는 연결이 살아 있는 동안만 메모리에 둔다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import posix from 'node:path/posix';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client, utils } = require('ssh2');

// 호스트 키 종류 → 그 키로 서명하는 알고리즘 이름 (웹 web/src/ssh/engine.ts 와 같은 표)
const HOST_KEY_ALGOS = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};
// ssh2 가 이 PC 에서 실제로 쓸 수 있는 목록(기본 순서) — ed25519 는 암호 라이브러리가 지원할 때만 들어 있다
const DEFAULT_HOST_KEY_ALGOS = (() => {
  try {
    const list = require('ssh2/lib/protocol/constants.js').DEFAULT_SERVER_HOST_KEY;
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return Object.values(HOST_KEY_ALGOS).flat();
})();

// 이미 아는 서버면 아는 종류의 호스트 키만 받겠다고 알린다 (보안 검토 M-7): 중간자가 처음 보는 종류의 키로
// 협상을 끌고 가 "처음 접속" 창을 띄우지 못하게 한다. 아는 종류 중 쓸 수 있는 게 없으면 null (제한 없음)
export function hostKeyAlgorithms(knownTypes, supported = DEFAULT_HOST_KEY_ALGOS) {
  const allowed = new Set((Array.isArray(knownTypes) ? knownTypes : []).flatMap((t) => HOST_KEY_ALGOS[t] ?? []));
  const list = supported.filter((a) => allowed.has(a));
  return list.length ? list : null;
}
export const HOST_KEY_TYPE_MESSAGE = '이 서버가 저장된 것과 다른 종류의 호스트 키만 제시했습니다. 서버를 다시 설치한 게 아니라면 중간자 공격이 의심되어 연결을 차단했습니다. 바뀐 게 확실하면 알려진 호스트에서 이 서버 항목을 지운 뒤 다시 연결해 주세요.';

// OpenSSH 개인키의 bcrypt 반복 횟수는 파일에 적힌 값을 그대로 쓰고, ssh2 는 이를 앱 본체에서 멈춘 채(동기) 계산한다.
// 터무니없이 큰 값이면 앱 전체가 멈추므로 넘기기 전에 거른다 (보안 검토 낮음 항목)
export const MAX_KDF_ROUNDS = 1000;
export function checkKdfRounds(privateKey) {
  const m = typeof privateKey === 'string' ? /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(privateKey) : null;
  if (!m) return;
  let rounds = 0;
  try {
    const data = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    let o = 15; // "openssh-key-v1\0"
    const str = () => {
      const n = data.readUInt32BE(o);
      const v = data.subarray(o + 4, o + 4 + n);
      o += 4 + n;
      return v;
    };
    str(); // 암호 방식
    if (str().toString('latin1') !== 'bcrypt') return;
    const opts = str();
    const saltLen = opts.readUInt32BE(0);
    rounds = opts.readUInt32BE(4 + saltLen);
  } catch {
    return; // 형식이 이상하면 ssh2 가 알아서 거절한다
  }
  if (rounds > MAX_KDF_ROUNDS) throw Object.assign(new Error(`키 암호 반복 횟수(${rounds}회)가 너무 많아 이 키를 읽지 않습니다. ssh-keygen -p -a 100 으로 다시 저장한 키를 사용해 주세요.`), { code: 'key_error' });
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const CHUNK = 32 * 1024;
const PARALLEL = 32;

const conns = new Map();
const jobs = new Map();
const forwards = new Map();

// ---------- 공용 ----------
const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

const text = (v, name, max = 4096) => {
  if (typeof v !== 'string' || !v || v.length > max || v.includes('\0')) throw new Error(`${name} 값이 올바르지 않습니다`);
  return v;
};
const optText = (v, max = 65536) => (typeof v === 'string' && v && v.length <= max ? v : undefined);
const int = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const idOf = (v) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(v)) throw new Error('연결 번호가 올바르지 않습니다');
  return v;
};
const absLocal = (v) => {
  const p = text(v, 'path');
  if (!path.isAbsolute(p)) throw new Error('절대 경로가 필요합니다');
  return path.normalize(p);
};
const safeName = (name) => {
  const n = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return !n || n === '.' || n === '..' ? '_' : n;
};

export function fingerprintOf(publicSsh) {
  return `SHA256:${crypto.createHash('sha256').update(publicSsh).digest('base64').replace(/=+$/, '')}`;
}

function hostKeyType(raw) {
  if (raw.length < 4) return 'unknown';
  const len = raw.readUInt32BE(0);
  return raw.subarray(4, 4 + len).toString('latin1') || 'unknown';
}

// 오류 → 화면에 보일 문장과 정해진 분류. 문장(주소가 들어갈 수 있다)은 화면에만, 서버 기록에는 분류만 보낸다
function friendlyError(err) {
  if (err?.level === 'client-authentication') return { message: '인증에 실패했습니다. 사용자 이름·비밀번호·키를 확인해 주세요.', code: 'auth_failed' };
  if (err?.level === 'client-timeout') return { message: '연결 시간이 초과되었습니다.', code: 'timeout' };
  switch (err?.code) {
    case 'ECONNREFUSED':
      return { message: '서버가 연결을 거부했습니다. 주소와 포트를 확인해 주세요.', code: 'refused' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { message: '주소를 찾을 수 없습니다.', code: 'dns' };
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { message: '서버에 닿을 수 없습니다. 이 PC에서 그 주소로 갈 수 있는지(VPN 등) 확인해 주세요.', code: 'unreachable' };
    case 'ECONNRESET':
      return { message: '서버가 연결을 끊었습니다.', code: 'reset' };
    case 'key_error':
      return { message: err.message, code: 'key_error' };
  }
  const raw = err?.message ?? String(err);
  if (/private key|passphrase|decrypt/i.test(raw)) return { message: '개인키를 읽지 못했습니다. 키 암호를 확인해 주세요.', code: 'key_error' };
  return { message: raw, code: /no matching/i.test(raw) ? 'negotiation' : 'other' };
}

// SFTP 상태 코드 → 사용자 문장
function sftpError(err) {
  switch (err?.code) {
    case 2:
      return new Error('파일이나 폴더가 없습니다.');
    case 3:
      return new Error('권한이 없습니다.');
    case 4:
      return new Error(`서버가 작업을 거부했습니다${err.message && err.message !== 'Failure' ? `: ${err.message}` : '.'}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw sftpError(err);
  }
};

// ---------- 연결 ----------
function connect(wc, o) {
  const id = idOf(o?.id);
  if (conns.has(id)) throw new Error('이미 사용 중인 연결 번호입니다');
  const kind = ['shell', 'sftp', 'forward'].includes(o.kind) ? o.kind : 'shell';
  const t = o.target ?? {};
  const host = text(t.host, 'host', 255);
  const port = int(t.port, 1, 65535, 22);
  const username = text(t.username, 'username', 255);
  const password = optText(t.password, 4096);
  const privateKey = optText(t.privateKey);
  const passphrase = optText(t.passphrase, 4096);
  // 알려진 호스트 지문: 같은 종류의 키끼리만 비교한다 (서버가 ed25519·ecdsa·rsa 키를 함께 가질 수 있다)
  const known = Array.isArray(o.known) ? o.known.filter((k) => typeof k?.fingerprint === 'string' && typeof k?.keyType === 'string') : [];
  // 아는 종류의 호스트 키만 협상한다 (보안 검토 M-7)
  const serverHostKey = hostKeyAlgorithms([...new Set(known.map((k) => k.keyType))]);

  const conn = new Client();
  const c = { id, wc, kind, conn, sftp: null, stream: null, pending: null, closed: false, ready: false, forwards: new Set() };
  conns.set(id, c);
  const send = (msg) => !wc.isDestroyed() && wc.send('ssh:event', id, msg);
  let rejectMessage = null;
  let rejectCode = null;

  // 화면에 묻고 답을 기다린다 (서버 지문·추가 인증)
  const ask = (msg) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (c.pending?.t === msg.t) {
          c.pending = null;
          resolve(null);
        }
      }, 180_000);
      c.pending = {
        t: msg.t,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      };
      send(msg);
    });

  // code: 서버 기록에 남길 정해진 분류 (문장에는 주소가 들어갈 수 있어 보내지 않는다)
  c.close = (message, code) => {
    if (c.closed) return;
    c.closed = true;
    conns.delete(id);
    c.pending?.resolve(null);
    c.pending = null;
    for (const ruleId of c.forwards) stopForward(ruleId, message ?? '연결이 끊겨 포워딩을 멈췄습니다.');
    try {
      conn.end();
    } catch {}
    send({ t: 'closed', message: message ?? '연결이 종료되었습니다.', code: code ?? 'other' });
  };

  // 비밀번호 칸은 저장된 비밀번호로 채우고, 나머지(OTP 등)만 묻는다
  conn.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
    if (!prompts.length) return finish([]);
    const pwIndex = password ? prompts.findIndex((p) => !p.echo && /password|암호|비밀번호/i.test(p.prompt)) : -1;
    if (pwIndex >= 0 && prompts.length === 1) return finish([password]);
    const rest = prompts.map((p, i) => ({ i, prompt: String(p.prompt ?? ''), echo: Boolean(p.echo) })).filter((p) => p.i !== pwIndex);
    void ask({ t: 'kbd', instructions: String(instructions ?? ''), prompts: rest.map(({ prompt, echo }) => ({ prompt, echo })) }).then((reply) => {
      const given = Array.isArray(reply?.answers) ? reply.answers.map((a) => String(a ?? '')) : [];
      const answers = prompts.map(() => '');
      rest.forEach((p, j) => (answers[p.i] = given[j] ?? ''));
      if (pwIndex >= 0) answers[pwIndex] = password;
      finish(answers);
    });
  });
  // 키 하나하나를 바로 보낸다(Nagle 끔) — 켜 두면 짧은 패킷을 모아 보내 글자를 치거나 지울 때 뚝뚝 끊긴다 (OpenSSH 도 끈다)
  conn.once('connect', () => conn.setNoDelay(true));
  conn.once('ready', () => {
    c.ready = true;
    onReady(c, o, send)
      .then(() => setTimeout(() => void reportOs(c, o.probeOs === true, send), 300))
      .catch((err) => c.close(err.message, err.code === 'no_sftp' ? 'no_sftp' : 'other'));
  });
  conn.on('error', (err) => {
    if (c.closed) return;
    if (rejectMessage) return c.close(rejectMessage, rejectCode ?? 'other');
    if (c.ready) return c.close('연결에 오류가 발생했습니다.', 'other');
    // 아는 종류로만 협상했는데 서버가 다른 종류만 내밀었다 → 중간자일 수 있다 (M-7)
    if (serverHostKey && /no matching host key/i.test(err?.message ?? '')) return c.close(HOST_KEY_TYPE_MESSAGE, 'host_key_type');
    const f = friendlyError(err);
    c.close(f.message, f.code);
  });
  conn.on('close', () => c.close(rejectMessage ?? (c.ready ? undefined : '서버가 연결을 닫았습니다.'), rejectCode ?? (c.ready ? 'other' : 'closed')));

  try {
    if (privateKey) checkKdfRounds(privateKey);
    conn.connect({
      host,
      port,
      username,
      password,
      privateKey,
      passphrase,
      tryKeyboard: true,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      ...(serverHostKey ? { algorithms: { serverHostKey } } : {}),
      hostVerifier: (key, verify) => {
        const fingerprint = fingerprintOf(key);
        const keyType = hostKeyType(key);
        const same = known.filter((k) => k.keyType === keyType);
        if (same.length) {
          if (same.every((k) => k.fingerprint === fingerprint)) return verify(true);
          rejectMessage = '서버 지문이 저장된 것과 다릅니다. 서버를 다시 설치한 게 아니라면 중간자 공격이 의심되어 연결을 차단했습니다.';
          rejectCode = 'host_key_mismatch';
          send({ t: 'hostkey', state: 'mismatch', keyType, fingerprint, knownFingerprint: same.find((k) => k.fingerprint !== fingerprint).fingerprint });
          return verify(false);
        }
        void ask({ t: 'hostkey', state: 'new', keyType, fingerprint }).then((reply) => {
          if (reply?.accept) return verify(true);
          rejectMessage = '서버 지문을 신뢰하지 않아 연결을 중단했습니다.';
          rejectCode = 'host_key_rejected';
          verify(false);
        });
      },
    });
  } catch (err) {
    const f = friendlyError(err);
    setImmediate(() => c.close(f.message, f.code));
  }
  return { id };
}

async function onReady(c, o, send) {
  if (c.kind === 'shell') {
    const stream = await call((cb) => c.conn.shell({ term: 'xterm-256color', cols: int(o.cols, 10, 500, 80), rows: int(o.rows, 5, 300, 24) }, cb));
    c.stream = stream;
    const out = (d) => !c.wc.isDestroyed() && c.wc.send('ssh:data', c.id, d);
    stream.on('data', out);
    stream.stderr.on('data', out);
    stream.on('close', () => c.close('셸이 종료되었습니다.'));
    send({ t: 'ready' });
  } else if (c.kind === 'sftp') {
    c.sftp = await call((cb) => c.conn.sftp(cb)).catch(() => {
      throw Object.assign(new Error('이 서버는 SFTP를 지원하지 않습니다.'), { code: 'no_sftp' });
    });
    const home = await call((cb) => c.sftp.realpath('.', cb)).catch(() => '/');
    send({ t: 'ready', home });
  } else {
    send({ t: 'ready' });
  }
}

// 서버 OS 알아보기 (화면이 호스트 아이콘을 OS 로고로 바꾼다): SSH 인사말은 늘, 읽기 전용 명령은 화면이 원할 때만
// (처음 보는 호스트이거나 일주일이 지났을 때 — web/src/os-detect.ts 와 같은 명령). 실패해도 접속에는 영향 없다.
const OS_PROBE = 'cat /etc/os-release 2>/dev/null; uname -s 2>/dev/null';
async function reportOs(c, probe, send) {
  if (c.closed) return;
  const raw = c.conn._protocol?._remoteIdentRaw;
  const ident = String(raw ? raw.toString('latin1') : c.conn._remoteVer ? `SSH-2.0-${c.conn._remoteVer}` : '').trim().slice(0, 255);
  const release = probe && /OpenSSH|dropbear/i.test(ident) && !/Windows/i.test(ident) ? await execSmall(c.conn, OS_PROBE).catch(() => '') : '';
  if (!c.closed) send({ t: 'os', ident, release });
}

// 짧은 명령 하나를 돌려 출력(최대 max 자)을 받는다. 실패·시간 초과면 받은 데까지
function execSmall(conn, command, ms = 4000, max = 16384) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let stream = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream?.close();
      } catch {}
      resolve(out.slice(0, max));
    };
    const timer = setTimeout(finish, ms);
    try {
      conn.exec(command, (err, s) => {
        if (err) return finish();
        stream = s;
        s.on('data', (d) => {
          out += d.toString('utf8');
          if (out.length >= max) finish();
        });
        s.stderr?.on('data', () => {});
        s.on('close', finish);
      });
    } catch {
      finish();
    }
  });
}

function connOf(id) {
  const c = conns.get(id);
  if (!c || c.closed) throw new Error('연결이 종료되었습니다. 다시 연결해 주세요.');
  return c;
}
function sftpOf(id) {
  const c = conns.get(id);
  if (!c?.sftp || c.closed) throw new Error('SFTP 연결이 종료되었습니다. 다시 연결해 주세요.');
  return c.sftp;
}

// ---------- SFTP ----------
const rstat = (sftp, p) => call((cb) => sftp.stat(p, cb));
const rlstat = (sftp, p) => call((cb) => sftp.lstat(p, cb));
const isDir = (a) => (a.mode & S_IFMT) === S_IFDIR;
const rexists = async (sftp, p) => {
  try {
    await rlstat(sftp, p);
    return true;
  } catch {
    return false;
  }
};
const existsError = (p) => Object.assign(new Error(`${posix.basename(p) || p}이(가) 이미 있습니다.`), { code: 'exists' });

async function listDir(sftp, dir) {
  const list = await call((cb) => sftp.readdir(dir, cb));
  // 서버가 준 이름은 한 칸짜리 파일 이름이어야 한다. "/"·NUL·"."·".." 가 든 이름은
  // 복사·삭제할 때 고른 폴더 밖을 가리키는 데 쓰일 수 있어 버린다 (보안 검토 F-02)
  const named = list.filter((e) => typeof e.filename === 'string' && e.filename !== '' && e.filename !== '.' && e.filename !== '..' && !/[/\0]/.test(e.filename));
  const entries = await Promise.all(
    named.map(async (e) => {
      const kind = (e.attrs.mode & S_IFMT) === S_IFDIR ? 'dir' : (e.attrs.mode & S_IFMT) === S_IFLNK ? 'link' : 'file';
      let type = kind === 'dir' ? 'dir' : 'file';
      let size = e.attrs.size;
      if (kind === 'link') {
        try {
          const target = await rstat(sftp, posix.join(dir, e.filename));
          type = isDir(target) ? 'dir' : 'file';
          size = target.size;
        } catch {}
      }
      return { name: e.filename, path: posix.join(dir, e.filename), type, link: kind === 'link', size, mtime: e.attrs.mtime * 1000, mode: e.attrs.mode & 0o7777 };
    }),
  );
  return entries;
}

async function removeRecursive(sftp, p) {
  const a = await rlstat(sftp, p);
  if (isDir(a)) {
    for (const e of await call((cb) => sftp.readdir(p, cb))) {
      if (e.filename === '.' || e.filename === '..') continue;
      // "../x" 같은 이름을 따라가면 고른 폴더 밖을 지우게 된다 (보안 검토 F-02)
      if (!e.filename || /[/\\\0]/.test(e.filename)) throw new Error(`이름이 올바르지 않은 항목(${JSON.stringify(e.filename)})이 있어 지우기를 멈췄습니다.`);
      await removeRecursive(sftp, posix.join(p, e.filename));
    }
    await call((cb) => sftp.rmdir(p, cb));
    return;
  }
  await call((cb) => sftp.unlink(p, cb));
}

// 덮어쓰기까지 되는 이름 바꾸기 (OpenSSH 확장이 있으면 원자적으로)
async function renameOver(sftp, from, to) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      return await call((cb) => sftp.ext_openssh_rename(from, to, cb));
    } catch {}
  }
  if (await rexists(sftp, to)) await call((cb) => sftp.unlink(to, cb));
  await call((cb) => sftp.rename(from, to, cb));
}

async function mkdirp(sftp, p) {
  if (await rexists(sftp, p)) return;
  await call((cb) => sftp.mkdir(p, cb));
}

const tmpName = (dir, name) => posix.join(dir, `.${name}.terminas-${crypto.randomBytes(4).toString('hex')}.part`);

const sftpOps = {
  list: wrap(async (id, p) => {
    const sftp = sftpOf(id);
    const dir = await call((cb) => sftp.realpath(text(p, 'path'), cb));
    return { path: dir, entries: await listDir(sftp, dir) };
  }),
  stat: wrap(async (id, p) => {
    const a = await rstat(sftpOf(id), text(p, 'path'));
    return { type: isDir(a) ? 'dir' : 'file', size: a.size, mtime: a.mtime * 1000, mode: a.mode & 0o7777 };
  }),
  mkdir: wrap(async (id, p, ignoreExisting) => {
    const sftp = sftpOf(id);
    if (ignoreExisting && (await rexists(sftp, text(p, 'path')))) return;
    await call((cb) => sftp.mkdir(text(p, 'path'), cb));
  }),
  rename: wrap(async (id, from, to) => {
    const sftp = sftpOf(id);
    if (await rexists(sftp, text(to, 'to'))) throw existsError(to);
    await call((cb) => sftp.rename(text(from, 'from'), to, cb));
  }),
  remove: wrap(async (id, paths) => {
    const sftp = sftpOf(id);
    for (const p of Array.isArray(paths) ? paths : []) {
      if (text(p, 'path') === '/') throw new Error('루트는 지울 수 없습니다');
      await removeRecursive(sftp, p);
    }
  }),
  chmod: wrap(async (id, p, mode) => {
    const m = typeof mode === 'string' ? parseInt(mode, 8) : Number(mode);
    if (!Number.isInteger(m) || m < 0 || m > 0o7777) throw new Error('권한은 0000~7777(8진수)입니다');
    await call((cb) => sftpOf(id).chmod(text(p, 'path'), m, cb));
  }),
  readFile: wrap(async (id, p, max) => {
    const sftp = sftpOf(id);
    const file = text(p, 'path');
    const limit = int(max, 1, 64 * 1024 * 1024, 2 * 1024 * 1024);
    const a = await rstat(sftp, file);
    if (a.size > limit) throw new Error('파일이 너무 커서 여기서 열 수 없습니다.');
    return new Uint8Array(await readLimited(sftp, file, limit));
  }),
  // 옆에 임시 이름으로 쓰고 다 쓰면 바꿔 끼운다 (쓰다 끊겨도 원본이 망가지지 않게)
  writeFile: wrap(async (id, p, data) => {
    const sftp = sftpOf(id);
    const target = text(p, 'path');
    if (!(data instanceof Uint8Array)) throw new Error('내용이 올바르지 않습니다');
    const mode = await rstat(sftp, target).then((a) => a.mode & 0o7777, () => 0o644);
    const tmp = tmpName(posix.dirname(target), posix.basename(target));
    try {
      await call((cb) => sftp.writeFile(tmp, Buffer.from(data), { mode }, cb));
      await renameOver(sftp, tmp, target);
    } catch (err) {
      sftp.unlink(tmp, () => {});
      throw err;
    }
  }),
};

// ---------- 전송 ----------
// 로컬 fs 와 SFTP 는 콜백 모양이 같다(open/read/write/close/fstat) → 같은 코드로 어느 방향이든 옮긴다.
function endpoint(obj) {
  return {
    open: (p, flags, mode) => call((cb) => (obj === fs ? fs.open(p, flags, mode ?? 0o644, cb) : obj.open(p, flags, flags === 'r' ? {} : { mode: mode ?? 0o644 }, cb))),
    read: (h, buf, off, len, pos) => call((cb) => obj.read(h, buf, off, len, pos, cb)),
    write: (h, buf, off, len, pos) => call((cb) => obj.write(h, buf, off, len, pos, cb)),
    close: (h) => call((cb) => obj.close(h, cb)),
    fstat: (h) => call((cb) => obj.fstat(h, cb)),
  };
}

// 여러 조각을 동시에 읽고 써서 왕복 지연을 가린다. 취소하면 조각 사이에서 멈춘다.
async function xfer(srcObj, dstObj, srcPath, dstPath, { signal, onBytes, mode }) {
  const src = endpoint(srcObj);
  const dst = endpoint(dstObj);
  const sh = await src.open(srcPath, 'r');
  let dh = null;
  try {
    const size = Number((await src.fstat(sh)).size);
    dh = await dst.open(dstPath, 'w', mode);
    let next = 0;
    let failed = null;
    const worker = async () => {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (!failed && next < size) {
        if (signal.aborted) throw new Error('취소했습니다');
        const pos = next;
        next += CHUNK;
        const len = Math.min(CHUNK, size - pos);
        let done = 0;
        while (done < len) {
          const nb = await src.read(sh, buf, done, len - done, pos + done);
          if (!nb) throw new Error('읽는 동안 파일 크기가 바뀌었습니다.');
          await dst.write(dh, buf, done, nb, pos + done);
          done += nb;
          onBytes(nb);
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: PARALLEL }, () =>
        worker().catch((err) => {
          failed ??= err;
        }),
      ),
    );
    if (failed) throw failed;
    if (signal.aborted) throw new Error('취소했습니다');
  } finally {
    await Promise.allSettled([src.close(sh), dh !== null ? dst.close(dh) : Promise.resolve()]);
  }
}

async function runJob(wc, jobId, fn) {
  const id = idOf(jobId);
  const ac = new AbortController();
  jobs.set(id, ac);
  const state = { bytes: 0, files: 0, current: '' };
  // 건너뛴 항목(폴더를 가리키는 심볼릭 링크) — 끝나면 화면에 알린다
  const skipped = [];
  let last = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - last < 200) return;
    last = now;
    if (!wc.isDestroyed()) wc.send('transfer:progress', { jobId: id, ...state });
  };
  try {
    await fn({
      signal: ac.signal,
      state,
      add: (n) => {
        state.bytes += n;
        report();
      },
      fileDone: () => {
        state.files++;
        report(true);
      },
      skip: (p) => {
        if (skipped.length < 200) skipped.push(String(p));
      },
    });
    return { files: state.files, bytes: state.bytes, skipped };
  } catch (err) {
    throw ac.signal.aborted ? new Error('취소했습니다') : sftpError(err);
  } finally {
    jobs.delete(id);
  }
}

function upload(wc, o) {
  const sftp = sftpOf(o?.connId);
  const remoteDir = text(o.remoteDir, 'remoteDir');
  return runJob(wc, o.jobId, async (job) => {
    const one = async (local, dir, top) => {
      if (job.signal.aborted) throw new Error('취소했습니다');
      // 폴더 안의 심볼릭 링크·정션이 폴더를 가리키면 따라가지 않는다 (자기 자신을 가리키는 링크로 끝없이 커지지 않게)
      if (!top && (await fs.promises.lstat(local)).isSymbolicLink() && (await fs.promises.stat(local).then((s) => s.isDirectory(), () => false))) return job.skip(local);
      const st = await fs.promises.stat(local);
      const remote = posix.join(dir, path.basename(local));
      if (st.isDirectory()) {
        await mkdirp(sftp, remote);
        for (const name of await fs.promises.readdir(local)) await one(path.join(local, name), remote, false);
        return;
      }
      if (!o.overwrite && (await rexists(sftp, remote))) throw existsError(remote);
      job.state.current = remote;
      const tmp = tmpName(dir, path.basename(local));
      try {
        await xfer(fs, sftp, local, tmp, { signal: job.signal, onBytes: job.add, mode: 0o644 });
        await renameOver(sftp, tmp, remote);
      } catch (err) {
        sftp.unlink(tmp, () => {});
        throw err;
      }
      job.fileDone();
    };
    for (const p of o.localPaths ?? []) await one(absLocal(p), remoteDir, true);
  });
}

// 받은 파일에 "인터넷에서 받음" 표시(Mark of the Web)를 단다 → 실행하면 Windows 가 SmartScreen·보호된 보기로 한 번 더 확인한다.
// FAT·exFAT 처럼 대체 데이터 스트림이 없는 곳이나 Windows 가 아니면 조용히 넘어간다
async function markOfTheWeb(file) {
  if (process.platform !== 'win32') return;
  await fs.promises.writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {});
}

// 원격 파일을 limit 바이트까지만 읽는다. 서버가 알려 준 크기를 믿지 않고 조각으로 읽으며 실제로 받은 양을 센다 — 크기를 속이거나
// 읽는 사이 커지는 파일로 앱 메모리를 채우지 못하게 (공개 전 점검 OS-04. ssh2 의 readFile 은 fstat 크기만큼 한 번에 잡는다)
export async function readLimited(sftp, file, limit) {
  const src = endpoint(sftp);
  const h = await src.open(file, 'r');
  const parts = [];
  let total = 0;
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const nb = await src.read(h, buf, 0, CHUNK, total);
      if (!nb) break;
      total += nb;
      if (total > limit) throw new Error('파일이 너무 커서 여기서 열 수 없습니다.');
      parts.push(Buffer.from(buf.subarray(0, nb)));
    }
  } finally {
    await src.close(h).catch(() => {});
  }
  return Buffer.concat(parts);
}

// 받는 곳이 고른 폴더 안의 진짜 폴더·파일인지 — 그 안에 이미 있던 junction·심볼릭 링크를 따라 고른 폴더 밖에 쓰지 않게
// (공개 전 점검 OS-06). 없으면 통과 (새로 만든다)
export async function checkLocalTarget(root, p) {
  const st = await fs.promises.lstat(p).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error('받을 곳에 다른 위치를 가리키는 링크(junction·심볼릭 링크)가 있어 멈췄습니다.');
  const real = await fs.promises.realpath(p);
  if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error('받을 곳이 고른 폴더 밖을 가리켜 멈췄습니다.');
}

function download(wc, o) {
  const sftp = sftpOf(o?.connId);
  const localDir = absLocal(o.localDir);
  return runJob(wc, o.jobId, async (job) => {
    // 고른 폴더 자체는 사용자가 고른 것이라 링크여도 그 실제 위치를 기준으로 삼는다
    const root = await fs.promises.realpath(localDir);
    const one = async (remote, dir) => {
      if (job.signal.aborted) throw new Error('취소했습니다');
      const a = await rstat(sftp, remote);
      const local = path.join(dir, safeName(posix.basename(remote)));
      await checkLocalTarget(root, dir);
      await checkLocalTarget(root, local);
      if (isDir(a)) {
        await fs.promises.mkdir(local, { recursive: true });
        await checkLocalTarget(root, local);
        for (const e of await listDir(sftp, remote)) {
          // 폴더를 가리키는 심볼릭 링크는 따라가지 않는다 (순환 링크로 끝없이 받지 않게). 파일 링크는 가리키는 파일을 받는다
          if (e.link && e.type === 'dir') job.skip(e.path);
          else await one(e.path, local);
        }
        return;
      }
      if (!o.overwrite && fs.existsSync(local)) throw Object.assign(new Error(`${path.basename(local)}이(가) 이미 있습니다.`), { code: 'exists' });
      job.state.current = local;
      // 임시 파일은 무작위 이름으로 새로 만든다(있으면 실패) — 미리 놓아 둔 같은 이름의 링크를 따라 쓰지 않게
      const tmp = `${local}.${crypto.randomBytes(6).toString('hex')}.studio-part`;
      try {
        await fs.promises.writeFile(tmp, '', { flag: 'wx' });
        await xfer(sftp, fs, remote, tmp, { signal: job.signal, onBytes: job.add });
        await fs.promises.rename(tmp, local);
      } catch (err) {
        fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await markOfTheWeb(local);
      job.fileDone();
    };
    for (const p of o.remotePaths ?? []) await one(text(p, 'path'), localDir);
  });
}

// 서버 ↔ 서버 (같은 서버 안도 된다). 두 연결 모두 이 PC 에서 열려 있으니 PC 를 거쳐 옮긴다.
function copyRemote(wc, o) {
  const from = sftpOf(o?.fromConn);
  const to = sftpOf(o?.toConn);
  const toDir = text(o.toDir, 'toDir');
  return runJob(wc, o.jobId, async (job) => {
    const one = async (src, dst, top) => {
      if (job.signal.aborted) throw new Error('취소했습니다');
      // 고른 대상 폴더 밖으로 나가는 경로면 멈춘다 (악성 서버의 파일 이름 대비)
      const target = posix.normalize(dst);
      if (target !== top && !target.startsWith(`${top}/`)) throw new Error('대상 폴더 밖을 가리키는 항목이 있어 복사를 멈췄습니다.');
      if (o.fromConn === o.toConn && (dst === src || dst.startsWith(`${src}/`))) throw new Error('폴더를 자기 안으로 복사할 수 없습니다');
      const a = await rstat(from, src);
      if (isDir(a)) {
        await mkdirp(to, dst);
        for (const e of await listDir(from, src)) {
          // 윈도우 SFTP 서버는 \ 도 경로 구분자로 읽는다
          if (e.name.includes('\\')) throw new Error(`이름에 \\가 든 항목(${e.name})은 복사하지 않습니다.`);
          // 폴더를 가리키는 심볼릭 링크는 따라가지 않는다 (순환 링크로 끝없이 복사하지 않게)
          if (e.link && e.type === 'dir') {
            job.skip?.(e.path);
            continue;
          }
          await one(e.path, posix.join(dst, e.name), top);
        }
        return;
      }
      if (!o.overwrite && (await rexists(to, dst))) throw existsError(dst);
      job.state.current = dst;
      const tmp = tmpName(posix.dirname(dst), posix.basename(dst));
      try {
        await xfer(from, to, src, tmp, { signal: job.signal, onBytes: job.add, mode: a.mode & 0o777 });
        await renameOver(to, tmp, dst);
      } catch (err) {
        to.unlink(tmp, () => {});
        throw err;
      }
      job.fileDone();
    };
    for (const p of o.paths ?? []) {
      const src = text(p, 'path');
      const name = posix.basename(src);
      // 맨 위 항목도 안쪽 항목과 같이 확인한다
      if (name.includes('\\')) throw new Error(`이름에 \\가 든 항목(${name})은 복사하지 않습니다.`);
      const top = posix.join(toDir, name);
      await one(src, top, top);
    }
  });
}

// ---------- 포트 포워딩 ----------
function forwardStatus(ruleId, extra = {}) {
  const f = forwards.get(ruleId);
  const msg = { ruleId, state: f ? 'listening' : 'stopped', connections: f?.sockets.size ?? 0, localPort: f?.localPort, ...extra };
  if (f && !f.wc.isDestroyed()) f.wc.send('forward:status', msg);
  return msg;
}

async function startForward(wc, o) {
  const ruleId = text(o?.ruleId, 'ruleId', 64);
  const c = connOf(o.connId);
  if (c.kind !== 'forward' || !c.ready) throw new Error('포워딩용 연결이 준비되지 않았습니다');
  const remoteHost = text(o.remoteHost, 'remoteHost', 255);
  const localPort = int(o.localPort, 1, 65535, 0);
  const remotePort = int(o.remotePort, 1, 65535, 0);
  if (!localPort || !remotePort) throw new Error('포트가 올바르지 않습니다');
  const bind = ['127.0.0.1', '0.0.0.0', '::1', '::'].includes(o.bindAddress) ? o.bindAddress : '127.0.0.1';
  stopForward(ruleId);
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    forwardStatus(ruleId);
    const done = () => {
      if (!sockets.delete(sock)) return;
      sock.destroy();
      forwardStatus(ruleId);
    };
    sock.on('close', done);
    sock.on('error', done);
    c.conn.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
      if (err || sock.destroyed) {
        stream?.close();
        return done();
      }
      sock.pipe(stream).pipe(sock);
      stream.on('close', done);
      stream.on('error', done);
      sock.on('close', () => stream.close());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(new Error(err.code === 'EADDRINUSE' ? `${localPort} 포트를 이미 다른 프로그램이 쓰고 있습니다.` : err.code === 'EACCES' ? `${localPort} 포트를 열 권한이 없습니다.` : err.message)),
    );
    server.listen(localPort, bind, resolve);
  });
  forwards.set(ruleId, { server, sockets, wc, localPort, connId: c.id });
  c.forwards.add(ruleId);
  return forwardStatus(ruleId);
}

function stopForward(ruleId, message) {
  const f = forwards.get(ruleId);
  if (!f) return;
  forwards.delete(ruleId);
  for (const s of f.sockets) s.destroy();
  f.server.close();
  const c = conns.get(f.connId);
  if (c) {
    c.forwards.delete(ruleId);
    if (!c.forwards.size) c.close('포워딩을 멈췄습니다.');
  }
  if (!f.wc.isDestroyed()) f.wc.send('forward:status', { ruleId, state: message ? 'error' : 'stopped', connections: 0, message });
}

// ---------- SSH 키 ----------
function inspectKey(o) {
  const privateKey = text(o?.privateKey, 'privateKey', 65536);
  checkKdfRounds(privateKey);
  const parsed = utils.parseKey(privateKey, optText(o.passphrase, 4096));
  if (parsed instanceof Error) {
    if (/passphrase|encrypted|decrypt/i.test(parsed.message)) throw new Error('키 암호가 없거나 틀렸습니다');
    throw new Error(`개인키를 읽을 수 없습니다: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || !key.isPrivateKey()) throw new Error('개인키가 아닙니다(공개키가 아니라 개인키를 입력해 주세요)');
  const pub = key.getPublicSSH();
  const comment = typeof o.comment === 'string' ? o.comment.trim().replace(/\s+/g, '_').slice(0, 80) : '';
  return { keyType: key.type, publicKey: `${key.type} ${pub.toString('base64')}${comment ? ` ${comment}` : ''}`, fingerprint: fingerprintOf(pub) };
}

function generateKey(o) {
  const type = ['ed25519', 'rsa', 'ecdsa'].includes(o?.type) ? o.type : null;
  if (!type) throw new Error('키 종류는 ed25519, ecdsa, rsa 중 하나입니다');
  const comment = typeof o.comment === 'string' ? o.comment.trim().slice(0, 80) : '';
  const passphrase = optText(o.passphrase, 4096);
  const opts = { comment };
  if (type === 'rsa') opts.bits = 4096;
  if (type === 'ecdsa') opts.bits = 256;
  if (passphrase) {
    opts.passphrase = passphrase;
    opts.cipher = 'aes256-ctr';
  }
  const pair = utils.generateKeyPairSync(type, opts);
  return { privateKey: pair.private, ...inspectKey({ privateKey: pair.private, passphrase, comment }) };
}

// ---------- 등록 ----------
export function registerSsh({ handle, on }) {
  handle('ssh:open', (e, o) => connect(e.sender, o ?? {}));
  on('ssh:reply', (_e, id, msg) => {
    const c = conns.get(id);
    if (c?.pending && msg && msg.t === c.pending.t) {
      const p = c.pending;
      c.pending = null;
      p.resolve(msg);
    }
  });
  on('ssh:write', (_e, id, data) => {
    const c = conns.get(id);
    if (c?.stream && typeof data === 'string') c.stream.write(data);
  });
  on('ssh:resize', (_e, id, cols, rows) => {
    const c = conns.get(id);
    if (c?.stream && cols > 0 && rows > 0) c.stream.setWindow(Math.min(300, rows), Math.min(500, cols), 0, 0);
  });
  on('ssh:close', (_e, id) => conns.get(id)?.close('연결을 닫았습니다.', 'cancelled'));
  handle('ssh:keygen', (_e, o) => generateKey(o));
  handle('ssh:inspect', (_e, o) => inspectKey(o));

  handle('sftp:list', (_e, id, p) => sftpOps.list(id, p));
  handle('sftp:stat', (_e, id, p) => sftpOps.stat(id, p));
  handle('sftp:mkdir', (_e, id, p, ignore) => sftpOps.mkdir(id, p, ignore));
  handle('sftp:rename', (_e, id, from, to) => sftpOps.rename(id, from, to));
  handle('sftp:remove', (_e, id, paths) => sftpOps.remove(id, paths));
  handle('sftp:chmod', (_e, id, p, mode) => sftpOps.chmod(id, p, mode));
  handle('sftp:read', (_e, id, p, max) => sftpOps.readFile(id, p, max));
  handle('sftp:write', (_e, id, p, data) => sftpOps.writeFile(id, p, data));

  handle('transfer:upload', (e, o) => upload(e.sender, o ?? {}));
  handle('transfer:download', (e, o) => download(e.sender, o ?? {}));
  handle('transfer:copy', (e, o) => copyRemote(e.sender, o ?? {}));
  on('transfer:cancel', (_e, jobId) => jobs.get(jobId)?.abort());

  handle('forward:start', (e, o) => startForward(e.sender, o ?? {}));
  handle('forward:stop', (_e, ruleId) => stopForward(ruleId));
  handle('forward:list', () => [...forwards.keys()].map((id) => forwardStatus(id)));
}

// 창이 닫히거나 새로고침되면 그 창이 연 연결을 모두 닫는다
export function closeConnectionsOf(wc) {
  for (const c of [...conns.values()]) if (c.wc === wc) c.close();
  for (const [ruleId, f] of [...forwards]) if (f.wc === wc) stopForward(ruleId);
}

export function closeAll() {
  for (const ruleId of [...forwards.keys()]) stopForward(ruleId);
  for (const c of [...conns.values()]) c.close();
}
