import { desktop } from './desktop';
import type { Bundle } from './e2ee';
import { t, tMsg } from './i18n-core';
import { isOnline, markAppOutdated, setOnline, unreachableStatus, wakeReconnect } from './net';
import { APP_API } from './compat';

export type Perm = 'edit' | 'view';
export type TeamRole = 'owner' | 'admin' | 'member';

export type Vault = {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  teamId: string | null;
  teamName: string | null;
  perm: Perm;
  isDefault: boolean;
  // 내 공개키로 봉한 볼트 키 (없으면 아직 공유받지 못함) · 누군가 이 볼트 키를 갖고 있는지
  wrappedKey: string | null;
  keyed: boolean;
  // 그 볼트 키를 봉한 사람 (서버 API 3~). 화면이 봉한 공개키와 맞춰 본다 (vault.ts openVaultKey)
  wrappedBy?: { userId: string; name: string; publicKey: string | null } | null;
};

// 내게 온, 아직 수락하지 않은 팀 초대 (서버 API 3~). needsCode: 아이디·비밀번호 계정은 초대 코드도 낸다
export type PendingInvite = { id: string; teamId: string; teamName: string; role: TeamRole; invitedBy: string | null; createdAt: number; needsCode: boolean };

export type Me = {
  // canCreateTeams: 서버 관리자이거나 누구나 가입하는 서버 (옛 서버는 없음 → isAdmin 으로)
  user: { id: string; email: string; name: string; avatarUrl: string; isAdmin: boolean; canCreateTeams?: boolean };
  crypto: { publicKey: string; bundle: Bundle; createdAt: number | null } | null;
  teams: { id: string; name: string; role: TeamRole }[];
  vaults: Vault[];
  // 로그인 방법: 서버가 비밀번호 로그인을 받는지, 나에게 로그인 비밀번호·Google 연결이 있는지 (옛 서버는 없음)
  login?: { password: boolean; hasPassword: boolean; google: boolean };
  invites?: PendingInvite[];
};

// GET /api/auth/config — 로그인 화면·앱 호환 확인
export type AuthConfig = {
  google: boolean;
  devLogin: boolean;
  password?: boolean;
  // Google 로 누구나 가입하는 서버
  openSignup?: boolean;
  // 이용약관·개인정보처리방침·소스 코드(AGPL-3.0) 주소 (빈 값이면 없음)
  links?: { terms: string; privacy: string; source: string };
  api?: number;
  minAppApi?: number;
};

export type Group = { id: string; vaultId: string; parentId: string | null; name: string };

export type Host = {
  id: string;
  vaultId: string;
  groupId: string | null;
  label: string;
  address: string;
  port: number;
  username: string;
  hasPassword: boolean;
  keyId: string | null;
  identityId: string | null;
  tags: string[];
  os: string;
  updatedAt: number;
  vaultName?: string;
};

export type SshKey = {
  id: string;
  vaultId: string;
  label: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  hasPassphrase: boolean;
  createdAt: number;
};

export type Identity = { id: string; vaultId: string; label: string; username: string; hasPassword: boolean; keyId: string | null };
export type Snippet = { id: string; vaultId: string; label: string; script: string };
export type Forward = { id: string; vaultId: string; hostId: string; label: string; bindAddress: string; localPort: number; remoteHost: string; remotePort: number };
// HTTP 요청 도구 (앱 전용)
export type HttpHeader = { name: string; value: string; on: boolean };
export type HttpBodyType = 'none' | 'json' | 'text' | 'xml' | 'form';
// apikey: key 이름(key)과 값(token)을 헤더나 쿼리(keyIn)에 넣는다 (0.3.1 부터 — 옛 앱은 '없음'으로 본다)
export type HttpAuth = { type: 'none' | 'bearer' | 'basic' | 'apikey'; token: string; username: string; password: string; key: string; keyIn: 'header' | 'query' };
export type HttpRequestItem = {
  id: string;
  vaultId: string;
  label: string;
  collection: string;
  method: string;
  url: string;
  headers: HttpHeader[];
  // 꺼 둔 쿼리 파라미터 (켜진 것은 주소 안에 있다)
  offParams: HttpHeader[];
  bodyType: HttpBodyType;
  body: string;
  auth: HttpAuth;
  insecure: boolean;
  follow: boolean;
  timeout: number;
};
export type HttpEnvVar = { key: string; value: string; secret: boolean };
export type HttpEnv = { id: string; vaultId: string; name: string; vars: HttpEnvVar[] };
export type Items = { groups: Group[]; hosts: Host[]; keys: SshKey[]; identities: Identity[]; snippets: Snippet[]; forwards: Forward[]; requests: HttpRequestItem[]; httpEnvs: HttpEnv[] };

export type KnownHost = { id: string; vaultId: string; address: string; port: number; keyType: string; fingerprint: string; createdAt: number; addedBy: string | null };

export type LogEntry = {
  id: number;
  ts: number;
  action: string;
  target: string;
  targetEnc: string | null;
  detail: Record<string, unknown>;
  ip: string;
  userName: string | null;
  userEmail: string | null;
};

export type TeamMember = { userId: string; email: string; name: string; avatarUrl: string; role: TeamRole; joinedAt: number; lastLoginAt: number | null; publicKey: string | null };
export type TeamDetail = {
  team: { id: string; name: string };
  myRole: TeamRole;
  members: TeamMember[];
  // codeExpiresAt: 비밀번호 로그인 서버에서 초대 코드를 쓸 수 있는 기한 (코드 자체는 만들 때 한 번만 보인다)
  invites: { id: string; email: string; role: TeamRole; createdAt: number; codeExpiresAt?: number | null }[];
  vaults: { id: string; name: string; isDefault: boolean }[];
  // 소유자에게만: 이 팀을 지우면 소속 팀이 하나도 남지 않는 사람 수
  soleMembers?: number;
};
export type VaultMember = { userId: string; email: string; name: string; avatarUrl: string; role: TeamRole; permission: Perm | null; implicit: boolean; hasKeys: boolean; hasVaultKey: boolean };
export type PendingShare = { vaultId: string; vaultName: string; teamName: string; userId: string; email: string; name: string; publicKey: string; keysCreatedAt: number | null };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 서버에 닿지 않아 실패한 것 (앱은 이때 오프라인 사본으로 이어 간다)
export const isNetworkError = (err: unknown) => err instanceof ApiError && unreachableStatus(err.status);

// 앱에서는 앱 본체가 로그인 토큰으로 대신 부른다 (화면은 앱 안에 있고 서버와 출처가 다르다)
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (desktop) {
    // 이 화면의 API 수준을 알린다 — 서버가 받지 않는 오래된 앱이면 426
    const res = await desktop.api(method, url, body, APP_API);
    const data = (res.data ?? null) as { error?: string; message?: string } | null;
    if (res.status === 426) markAppOutdated();
    // 닿지 않으면 오프라인으로 바꾸고, 끊긴 동안 무엇이든 닿으면 곧바로 다시 붙어 본다 (net.ts · store.tsx)
    if (unreachableStatus(res.status)) setOnline(false);
    else if (!isOnline()) wakeReconnect();
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? t('요청이 실패했습니다({status})', { status: res.status }));
    return data as T;
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'x-shell': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let data: { error?: string; message?: string } = {};
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};

// 서버·앱 본체가 보낸 한국어 메시지는 지금 언어로 바꿔 보여 준다
export function errorMessage(err: unknown) {
  return tMsg(err instanceof Error ? err.message : String(err));
}
