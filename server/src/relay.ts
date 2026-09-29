// 웹 접속용 중계: 브라우저가 SSH 를 직접 하고, 서버는 이미 암호화된 SSH 바이트만 TCP 로 옮긴다.
// 서버는 비밀번호·키·화면 내용을 볼 수 없다. 연결 대상 주소는 이 순간에만 알고, 어디에도 남기지 않는다.
//
// 막아 둔 것:
//   · 로그인한 사람만, 우리 화면(Origin)에서만
//   · 상대가 SSH 서버("SSH-" 로 시작하는 줄)를 보내기 전에는 브라우저 바이트를 한 바이트도 넘기지 않는다
//     → DB·웹 같은 다른 서비스로 가는 통로로 쓸 수 없다
//   · 사람마다 동시 연결 수, 운영에서는 이 서버 자신(루프백·이 서버의 주소)으로는 못 간다
//   · 서버 둘레의 내부망(사설망·CGNAT·ULA)은 SHELL_RELAY_PRIVATE 에 따라 (누구나 가입하는 서버는 기본이 서버 관리자만)
//   · 로그아웃하거나 세션이 끝나면(만료·팀에서 빠짐) 열려 있던 중계도 닫는다
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { sessionHash, userBySessionHash } from './auth.ts';
import type { User } from './access.ts';
import { config } from './config.ts';
import { trackLive } from './live.ts';
import { Throttle } from './password.ts';

const MAX_PER_USER = 20;
// 사람마다 10분에 새 연결 120개까지 (누구나 가입하는 서버에서 이 서버를 SSH 훑기 통로로 쓰지 못하게)
const opens = new Throttle(120, 10 * 60 * 1000);
const BANNER_WAIT_MS = 10_000;
const CONNECT_WAIT_MS = 12_000;
const MAX_HEAD = 8 * 1024;
const MAX_EARLY = 256 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const RECHECK_MS = 30_000;

const active = new Map<string, number>();

// 연결 대상이 될 수 없는 주소. 문자열 비교가 아니라 주소로 판정한다 —
// BlockList 는 ::ffff:7f00:1 처럼 16진수로 쓴 IPv4 매핑 IPv6 도 IPv4 규칙으로 잡는다 (보안 검토 F-04)
const deny = new net.BlockList();
deny.addSubnet('0.0.0.0', 8, 'ipv4');
deny.addSubnet('127.0.0.0', 8, 'ipv4');
deny.addSubnet('169.254.0.0', 16, 'ipv4'); // 링크 로컬(클라우드 메타데이터 포함)
deny.addSubnet('224.0.0.0', 3, 'ipv4'); // 멀티캐스트·예약·브로드캐스트
deny.addSubnet('::', 96, 'ipv6'); // 미지정·루프백·옛 IPv4 호환 (::7f00:1)
deny.addSubnet('64:ff9b::7f00:0', 104, 'ipv6'); // NAT64 로 감싼 127/8
deny.addSubnet('fe80::', 10, 'ipv6');
deny.addSubnet('ff00::', 8, 'ipv6');

export function blockedAddress(ip: string) {
  const bare = ip.split('%')[0];
  const family = net.isIP(bare);
  if (!family) return true;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (deny.check(bare, type)) return true;
  // 이 서버 자신의 다른 주소(사설망·VPN 주소)로 돌아 들어오는 것도 막는다
  const own = new net.BlockList();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) own.addAddress(a.address.split('%')[0], a.family === 'IPv6' ? 'ipv6' : 'ipv4');
  return own.check(bare, type);
}

// 로컬 개발(localhost 주소이고 production 이 아님)에서만 이 PC 의 시험용 sshd 로 가도록 풀어 준다.
// 공개 주소로 운영하면 NODE_ENV 를 빠뜨려도 막힌다
function blocked(ip: string) {
  if (process.env.NODE_ENV !== 'production' && config.isLocalOrigin) return false;
  return blockedAddress(ip);
}

// 서버 둘레의 내부망: 사설망·CGNAT(Tailscale 등)·벤치마크·ULA. IPv4 매핑 IPv6 는 BlockList 가 IPv4 규칙으로 잡고,
// NAT64(64:ff9b::/96)로 감싼 것은 따로 적는다
const internal = new net.BlockList();
for (const [addr, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['198.18.0.0', 15],
] as const) {
  internal.addSubnet(addr, bits, 'ipv4');
  const [a, b, c, d] = addr.split('.').map(Number);
  internal.addSubnet(`64:ff9b::${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`, 96 + bits, 'ipv6');
}
internal.addSubnet('fc00::', 7, 'ipv6');
internal.addSubnet('fec0::', 10, 'ipv6');

export function internalAddress(ip: string) {
  const bare = ip.split('%')[0];
  const family = net.isIP(bare);
  if (!family) return true;
  return internal.check(bare, family === 6 ? 'ipv6' : 'ipv4');
}

function internalAllowed(user: User) {
  if (process.env.NODE_ENV !== 'production' && config.isLocalOrigin) return true;
  return config.relayPrivate === 'all' || (config.relayPrivate === 'admins' && Boolean(user.is_admin));
}

// DNS 이름 풀기는 작업 스레드(libuv, 4개)를 쓴다 — 느리게 답하는 이름으로 스레드를 묶어 서버 전체(비밀번호 해시·파일)가
// 멈추지 않게, 서버 전체에서 동시에 두 개까지·5초까지만 기다린다 (보안 점검 09-29). IP 는 풀지 않는다
const MAX_LOOKUPS = 2;
let lookups = 0;
async function resolveHost(host: string): Promise<string> {
  if (net.isIP(host)) return host;
  if (lookups >= MAX_LOOKUPS) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  lookups++;
  const p = dns.lookup(host);
  p.finally(() => lookups--).catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return (await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'EAI_AGAIN' })), 5000)))])).address;
  } finally {
    clearTimeout(timer);
  }
}

function friendly(err: NodeJS.ErrnoException) {
  switch (err.code) {
    case 'EBUSY':
      return '주소를 확인하는 요청이 많습니다. 잠시 뒤에 다시 시도해 주세요.';
    case 'ECONNREFUSED':
      return '서버가 연결을 거부했습니다. 주소와 포트를 확인해 주세요.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '주소를 찾을 수 없습니다.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Terminas 서버에서 해당 주소에 연결할 수 없습니다.';
    case 'ECONNRESET':
      return '서버가 연결을 끊었습니다.';
  }
  return '연결하지 못했습니다.';
}

export function relayRoutes(app: FastifyInstance) {
  app.get('/api/relay', { websocket: true }, (socket: WebSocket, req) => {
    const send = (msg: Record<string, unknown>) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
    const fail = (message: string) => {
      send({ t: 'error', message });
      socket.close(1000);
    };
    // 브라우저 WebSocket 은 쿠키를 저절로 싣는다 → 출처를 꼭 확인한다
    if (req.headers.origin !== config.publicOrigin) return socket.close(4403, 'origin');
    const user = req.user;
    const hash = sessionHash(req);
    if (!user || !hash) return socket.close(4401, 'unauthorized');
    const q = req.query as { host?: string; port?: string };
    const host = String(q.host ?? '').trim();
    const port = Number(q.port);
    if (!host || host.length > 255 || /[\s/]/.test(host)) return fail('주소가 올바르지 않습니다.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('포트가 올바르지 않습니다.');
    const count = active.get(user.id) ?? 0;
    if (count >= MAX_PER_USER || opens.blocked(user.id)) return socket.close(4429, 'too many');
    opens.fail(user.id);
    active.set(user.id, count + 1);

    let tcp: net.Socket | null = null;
    let open = false;
    let done = false;
    const early: Buffer[] = [];
    let earlyBytes = 0;
    let head = Buffer.alloc(0);
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000);
    let bannerTimer: NodeJS.Timeout | null = null;
    // 여는 순간만이 아니라 열려 있는 동안에도 세션을 다시 확인한다 (만료·팀에서 빠짐)
    const recheck = setInterval(() => {
      if (userBySessionHash(hash)?.id !== user.id) socket.close(4401, 'session ended');
    }, RECHECK_MS);
    const untrack = trackLive({ sessionHash: hash, userId: user.id, close: (code, reason) => socket.close(code, reason) });

    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      clearInterval(recheck);
      untrack();
      if (bannerTimer) clearTimeout(bannerTimer);
      tcp?.destroy();
      const n = (active.get(user.id) ?? 1) - 1;
      if (n > 0) active.set(user.id, n);
      else active.delete(user.id);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // 브라우저 → 서버: SSH 서버임을 확인하기 전에는 모아 두기만 한다
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!open || !tcp) {
        earlyBytes += buf.length;
        if (earlyBytes > MAX_EARLY) return fail('연결을 준비하는 동안 너무 많은 데이터가 왔습니다.');
        early.push(buf);
        return;
      }
      if (!tcp.write(buf)) {
        socket.pause();
        tcp.once('drain', () => socket.resume());
      }
    });

    // 서버 → 브라우저: 브라우저가 못 따라오면 TCP 를 잠깐 멈춘다
    const forward = (chunk: Buffer) => {
      socket.send(chunk, { binary: true });
      if (socket.bufferedAmount > HIGH_WATER && tcp && !tcp.isPaused()) {
        tcp.pause();
        const wait = setInterval(() => {
          if (done || socket.bufferedAmount < LOW_WATER) {
            clearInterval(wait);
            tcp?.resume();
          }
        }, 50);
      }
    };

    void (async () => {
      let address: string;
      try {
        address = await resolveHost(host);
      } catch (err) {
        return fail(friendly(err as NodeJS.ErrnoException));
      }
      if (done) return;
      if (blocked(address)) return fail('해당 주소로는 연결할 수 없습니다.');
      if (internalAddress(address) && !internalAllowed(user)) return fail('이 서버에서는 내부망 주소로 웹 접속을 할 수 없습니다. 데스크톱 앱에서 접속해 주세요.');
      tcp = net.connect({ host: address, port });
      tcp.setNoDelay(true);
      tcp.setTimeout(CONNECT_WAIT_MS, () => {
        if (!open) fail('연결 시간이 초과되었습니다.');
      });
      tcp.once('connect', () => {
        tcp?.setTimeout(0);
        bannerTimer = setTimeout(() => !open && fail('SSH 서버가 아닙니다(인사말이 오지 않았습니다).'), BANNER_WAIT_MS);
      });
      tcp.on('data', (chunk: Buffer) => {
        if (open) return forward(chunk);
        head = Buffer.concat([head, chunk]);
        // SSH 서버는 먼저 "SSH-2.0-..." 줄을 보낸다 (그 앞에 다른 줄이 올 수도 있다, RFC 4253 4.2)
        const text = head.toString('latin1');
        const lines = text.split('\n');
        const complete = text.endsWith('\n') ? lines : lines.slice(0, -1);
        if (complete.some((l) => l.startsWith('SSH-'))) {
          open = true;
          if (bannerTimer) clearTimeout(bannerTimer);
          send({ t: 'open' });
          forward(head);
          for (const b of early.splice(0)) tcp!.write(b);
          return;
        }
        if (head.length > MAX_HEAD || complete.some((l) => l.length && !/^[\x20-\x7e\r]*$/.test(l))) fail('SSH 서버가 아닙니다.');
      });
      tcp.on('error', (err: NodeJS.ErrnoException) => (open ? socket.close(1000) : fail(friendly(err))));
      tcp.on('close', () => socket.readyState === socket.OPEN && socket.close(1000));
    })();
  });
}
