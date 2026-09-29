// 서버 OS 알아보기 (Termius 처럼 호스트 아이콘을 OS 로고로 바꾼다).
//   1) SSH 서버 인사말 — 배포판이 이름을 넣는 경우(Ubuntu·Debian·Raspbian·FreeBSD, 윈도우 OpenSSH)
//   2) 접속한 뒤 읽기 전용 명령 한 번: `cat /etc/os-release; uname -s` — 처음 볼 때와 일주일에 한 번만
// 결과는 호스트 항목의 os 칸(볼트에 암호화, 팀이 함께 본다)에 남긴다. 보기 권한이라 못 쓰면 이 기기에만 기억한다.
// 서버가 보낸 글은 여기서 OS 이름을 고르는 데만 쓰고, 화면에 그대로 보여 주지 않는다.

export const OS_IDS = [
  'ubuntu', 'debian', 'raspberrypi', 'linuxmint', 'popos', 'elementary', 'zorin', 'kali',
  'centos', 'redhat', 'fedora', 'rocky', 'almalinux', 'arch', 'manjaro', 'endeavouros',
  'alpine', 'opensuse', 'suse', 'gentoo', 'nixos', 'void', 'openwrt',
  'freebsd', 'openbsd', 'macos', 'windows', 'linux',
] as const;
export type OsId = (typeof OS_IDS)[number];

// 접속한 뒤 한 번 돌리는 명령 (앱 desktop/src/ssh.js 에도 같은 문자열이 있다)
export const OS_PROBE = 'cat /etc/os-release 2>/dev/null; uname -s 2>/dev/null';
const PROBE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// 유닉스 계열 OpenSSH·dropbear 일 때만 명령을 돌린다 (윈도우·네트워크 장비는 인사말로만)
export const probeWorthy = (ident: string) => /OpenSSH|dropbear/i.test(ident) && !/Windows/i.test(ident);

export function osFromIdent(ident: string): OsId | '' {
  if (/OpenSSH_for_Windows|Windows/i.test(ident)) return 'windows';
  if (/Raspbian/i.test(ident)) return 'raspberrypi';
  if (/Ubuntu/i.test(ident)) return 'ubuntu';
  if (/Debian/i.test(ident)) return 'debian';
  if (/FreeBSD/i.test(ident)) return 'freebsd';
  return '';
}

const BY_ID: Record<string, OsId> = {
  ubuntu: 'ubuntu', debian: 'debian', raspbian: 'raspberrypi', linuxmint: 'linuxmint', pop: 'popos', elementary: 'elementary', zorin: 'zorin', kali: 'kali',
  centos: 'centos', rhel: 'redhat', fedora: 'fedora', rocky: 'rocky', almalinux: 'almalinux', arch: 'arch', archarm: 'arch', manjaro: 'manjaro', 'manjaro-arm': 'manjaro', endeavouros: 'endeavouros',
  alpine: 'alpine', opensuse: 'opensuse', 'opensuse-leap': 'opensuse', 'opensuse-tumbleweed': 'opensuse', 'opensuse-microos': 'opensuse', sles: 'suse', sled: 'suse', 'sle-micro': 'suse',
  gentoo: 'gentoo', nixos: 'nixos', void: 'void', openwrt: 'openwrt', freebsd: 'freebsd',
};
const BY_UNAME: Record<string, OsId> = { linux: 'linux', freebsd: 'freebsd', openbsd: 'openbsd', darwin: 'macos' };

// /etc/os-release (ID, ID_LIKE) 와 uname -s 출력
export function osFromRelease(text: string): OsId | '' {
  const field = (name: string) => new RegExp(`^${name}=["']?([^"'\\r\\n]*)`, 'm').exec(text)?.[1]?.trim().toLowerCase() ?? '';
  const id = field('ID');
  if (BY_ID[id]) return BY_ID[id];
  for (const like of field('ID_LIKE').split(/\s+/)) if (BY_ID[like]) return BY_ID[like];
  for (const line of text.split(/\r?\n/)) {
    const u = BY_UNAME[line.trim().toLowerCase()];
    if (u) return u;
  }
  return id ? 'linux' : '';
}

// 명령 결과가 더 정확하다 (민트·팝OS 도 인사말엔 Ubuntu 라고 나온다). 명령이 '리눅스'까지만 알면 인사말로 좁힌다.
export function detectOs(ident: string, release: string): OsId | '' {
  const r = osFromRelease(release);
  if (r && r !== 'linux') return r;
  return osFromIdent(ident) || r;
}

// ---------- 이 기기에 남기는 것: 마지막으로 명령을 돌린 때(디스크), (볼트에 못 쓰는 경우) 알아낸 OS(이 창을 닫을 때까지만) ----------
// 호스트 OS 는 볼트 내용이라 디스크(localStorage)에 두지 않는다 — 보기 권한이라 볼트에 못 적는 사람은 이번 실행 동안만 기억한다
type Local = Record<string, { os?: string; probedAt?: number }>;
const LOCAL_KEY = 'terminas.hostOs';
const read = (store: Storage): Local => {
  try {
    return JSON.parse(store.getItem(LOCAL_KEY) ?? '{}') as Local;
  } catch {
    return {};
  }
};
const readLocal = (): Local => {
  const disk = read(localStorage);
  const mem = read(sessionStorage);
  const out: Local = {};
  for (const id of new Set([...Object.keys(disk), ...Object.keys(mem)])) out[id] = { probedAt: disk[id]?.probedAt, os: mem[id]?.os };
  return out;
};
const writeLocal = (hostId: string, patch: { os?: string; probedAt?: number }) => {
  try {
    const disk = read(localStorage);
    const mem = read(sessionStorage);
    if (patch.probedAt !== undefined) disk[hostId] = { probedAt: patch.probedAt };
    if (patch.os !== undefined) mem[hostId] = { os: patch.os };
    // 예전(~0.3.2)에 디스크에 남긴 OS 는 지운다
    for (const v of Object.values(disk)) delete v.os;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(disk));
    sessionStorage.setItem(LOCAL_KEY, JSON.stringify(mem));
  } catch {}
};

export const isOsId = (v: string): v is OsId => (OS_IDS as readonly string[]).includes(v);

// 화면에 보여 줄 OS: 볼트에 남은 것 → 이 기기에만 기억한 것
export function osOf(host: { id: string; os?: string }): OsId | '' {
  const stored = host.os ?? '';
  if (isOsId(stored)) return stored;
  const local = readLocal()[host.id]?.os ?? '';
  return isOsId(local) ? local : '';
}

// 이번 접속에서 명령까지 돌릴지: 모르는 호스트이거나 일주일이 지났으면
export function shouldProbe(host: { id: string; os?: string }) {
  if (!osOf(host)) return true;
  return Date.now() - (readLocal()[host.id]?.probedAt ?? 0) > PROBE_EVERY_MS;
}

export function markProbed(hostId: string) {
  writeLocal(hostId, { probedAt: Date.now() });
}

export function rememberLocalOs(hostId: string, os: OsId | '') {
  writeLocal(hostId, { os });
}

// 화면이 호스트 목록을 다시 그리게 알린다
export const HOST_OS_EVENT = 'terminas:host-os';
