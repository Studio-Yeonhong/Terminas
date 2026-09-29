// 볼트 데이터 층: 서버에서 암호문을 받아 볼트 키로 풀고, 고친 것은 다시 암호화해서 보낸다.
// 화면에는 비밀값이 빠진 모양(hasPassword 등)만 내보내고, 비밀값은 접속할 때 resolveCreds 로만 꺼낸다.
// 앱: 받은 암호문을 이 PC 에 사본으로 두고(offline.ts), 서버에 닿지 않으면 사본으로 연다. 개인 볼트는 오프라인에서도 고칠 수 있고
// 고친 것은 다시 연결되면 올린다(syncVault) — 그사이 다른 곳에서도 고쳤으면 서버 것을 살리고 내 것은 "충돌 사본"으로 남긴다.
import { api, ApiError, isNetworkError, type Forward, type Group, type Host, type Identity, type Items, type KnownHost, type Me, type PendingShare, type Snippet, type SshKey, type Vault, type HttpRequestItem, type HttpEnv, type HttpEnvVar, type HttpHeader, type HttpAuth, type HttpBodyType } from './api';
import { desktop } from './desktop';
import * as E from './e2ee';
import { locale, t } from './i18n-core';
import { isOnline } from './net';
import * as O from './offline';
import type { Dirty, Kind, RawItem } from './offline';

export type { Kind } from './offline';

// ---------- 항목 형식 수준 (앞으로 올 앱과 섞여 쓸 때) ----------
// 항목 암호문 안의 _v = 이 항목을 망가뜨리지 않고 고칠 수 있는 가장 낮은 앱 형식. 새 앱이 옛 앱이 모르는 값(새 인증 종류 등)을 쓰면 올린다.
// 이 앱보다 높은 _v 의 항목은 보여 주기만 하고 고치거나 지우지 않는다 — 모르는 값을 빼고 저장해 버리지 않게.
// 1 = 0.3.0 까지, 2 = 0.3.1 (HTTP 요청의 API 키 인증·XML 본문·끈 쿼리 파라미터)
export const ITEM_FORMAT = 2;
const formatOf = (data: unknown) => Number((data as { _v?: unknown } | null)?._v) || 1;
function formatNeeded(kind: Kind, data: Record<string, unknown>) {
  if (kind === 'request') {
    const auth = data.auth as { type?: string } | undefined;
    if (auth?.type === 'apikey' || data.bodyType === 'xml' || (Array.isArray(data.offParams) && data.offParams.length)) return 2;
  }
  return 1;
}
// 저장할 모양: 이 앱이 모르는 칸(더 새 앱이 넣은 것)은 원래 것을 그대로 두고, _v 를 새로 적는다
function stamp(kind: Kind, data: object, original?: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(original ?? {}), ...data };
  delete out._v;
  const v = formatNeeded(kind, out);
  if (v > 1) out._v = v;
  // 판 번호: 저장할 때마다 1씩 올린다 — 서버가 예전 판을 다시 내밀면 이 기기가 알아챈다 (보안 점검 M-5, applyRows)
  out._r = (Number((original as { _r?: unknown } | undefined)?._r) || 0) + 1;
  return out;
}
const TOO_NEW = () => t('새 버전 앱에서 만든 항목이라 이 앱에서는 수정하거나 지울 수 없습니다. 앱을 업데이트해 주세요.');
export const tooNew = (id: string) => {
  for (const map of cache.values()) {
    const e = map.get(id);
    if (e) return formatOf(e.data) > ITEM_FORMAT;
  }
  return false;
};

type GroupData = { name: string; parentId: string | null };
type HostData = {
  label: string;
  address: string;
  port: number;
  username: string;
  password: string | null;
  keyId: string | null;
  identityId: string | null;
  groupId: string | null;
  tags: string[];
  os: string;
};
type KeyData = { label: string; keyType: string; publicKey: string; fingerprint: string; privateKey: string; passphrase: string | null };
type IdentityData = { label: string; username: string; password: string | null; keyId: string | null };
type SnippetData = { label: string; script: string };
type ForwardData = { label: string; hostId: string; bindAddress: string; localPort: number; remoteHost: string; remotePort: number };
type KnownHostData = { address: string; port: number; keyType: string; fingerprint: string; addedBy: string | null; addedByName: string };
// address·port: 연결할 때의 호스트 주소. 그 뒤 호스트 주소가 바뀌면(팀 편집자가 다른 서버로 돌려놓는 것) 내 접속 정보를 보내지 않는다 (보안 점검 M-6)
type HostCredData = { hostId: string; identityId: string; address?: string; port?: number };
type RequestData = Omit<HttpRequestItem, 'id' | 'vaultId'>;
type HttpEnvData = Omit<HttpEnv, 'id' | 'vaultId'>;

type DataOf = {
  group: GroupData;
  host: HostData;
  key: KeyData;
  identity: IdentityData;
  snippet: SnippetData;
  forward: ForwardData;
  knownhost: KnownHostData;
  hostcred: HostCredData;
  request: RequestData;
  httpenv: HttpEnvData;
};
type Entry<K extends Kind = Kind> = { id: string; kind: K; vaultId: string; data: DataOf[K]; createdAt: number; updatedAt: number; createdBy: string | null };

export const EMPTY_ITEMS: Items = { groups: [], hosts: [], keys: [], identities: [], snippets: [], forwards: [], requests: [], httpEnvs: [] };

// ---------- 상태 ----------
let account: E.Account | null = null;
let me: { id: string; name: string } | null = null;
const vaults = new Map<string, Vault>();
const vaultKeys = new Map<string, { raw: Uint8Array; key: E.SymKey }>();
const cache = new Map<string, Map<string, Entry>>();
const loading = new Map<string, Promise<VaultLoad>>();
const failures = new Map<string, number>();
// 오프라인 사본으로 두는 것: 서버와 맞춘 암호문 + 이 PC 에서 고친 것 · 아직 올리지 않은 것 · 마지막으로 서버와 맞춘 때
const rowsOf = new Map<string, Map<string, RawItem>>();
const dirtyOf = new Map<string, Record<string, Dirty>>();
const syncedAt = new Map<string, number>();
// 이 PC 에 저장된 사본도 없이 오프라인으로 연 임시 모드: 볼트 하나를 메모리에만 만들어 쓴다 (앱을 닫으면 사라진다)
let ephemeral = false;

export class VaultWaiting extends Error {}

// 누가 봉했는지 알 수 없는 예전 방식(~0.3.2 앱이 임시 키로 봉함)의 볼트 키를 이 기기에서 처음 볼 때 (보안 점검 H-2).
// 서버가 만들어 넣은 키일 수도 있어 저절로 열지 않고 사용자에게 묻는다 (trustVaultKeyOnce)
export class UntrustedVaultKey extends Error {
  vaultId: string;
  constructor(vaultId: string, message: string) {
    super(message);
    this.vaultId = vaultId;
  }
}
// 사용자가 "출처를 확인하지 않고 열기"를 고른 볼트 (이번 잠금 해제 동안만)
const trustedOnce = new Set<string>();
export function trustVaultKeyOnce(vaultId: string) {
  trustedOnce.add(vaultId);
}
// 방금(이번 잠금 해제에서) 암호화 설정을 만든 계정: 예전 방식 볼트 키는 있을 수 없다 — 서버가 먼저 채워 둔 것이면 열지 않는다
let freshAccount = false;
export function markFreshAccount() {
  freshAccount = true;
}
// 되돌리기로 숨긴 항목 수 (볼트마다)
const staleOf = new Map<string, number>();

export function setAccount(a: E.Account | null, user?: { id: string; name: string }) {
  if (account && account !== a) {
    E.wipe(account.privateKey);
    E.wipe(account.accountKey);
  }
  account = a;
  me = user ?? null;
  freshAccount = false;
  trustedOnce.clear();
  staleOf.clear();
  for (const k of vaultKeys.values()) E.wipe(k.raw);
  vaultKeys.clear();
  keyLoading.clear();
  cache.clear();
  loading.clear();
  rowsOf.clear();
  dirtyOf.clear();
  syncedAt.clear();
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
}
export const currentAccount = () => account;

export function setVaults(list: Vault[]) {
  vaults.clear();
  for (const v of list) vaults.set(v.id, v);
  for (const id of [...cache.keys()]) {
    if (vaults.has(id)) continue;
    cache.delete(id);
    rowsOf.delete(id);
    dirtyOf.delete(id);
    syncedAt.delete(id);
  }
}

// 임시 모드로 연다 (App 이 오프라인인데 사본이 없을 때)
export function startEphemeral(user: { id: string; name: string }) {
  setAccount(null, user);
  ephemeral = true;
}
export const isEphemeral = () => ephemeral;

const personalVault = () => [...vaults.values()].find((v) => v.kind === 'personal');

// ---------- 볼트 키 ----------
// 이 기기에서 처음 본 볼트 키를 사람마다 기억한다. 서버가 볼트 키를 바꿔치기하면 여기서 걸린다.
// 예전(~0.3.2)엔 볼트 id 로만 적었다 → 사람을 붙인 이름으로 옮긴다 (다른 서버가 같은 볼트 id 로 핀을 더럽히지 못하게)
const pinKey = (vaultId: string) => `terminas.vaultpin.${account?.userId ?? me?.id ?? ''}.${vaultId}`;
const legacyPinKey = (vaultId: string) => `terminas.vaultpin.${vaultId}`;
function readPin(vaultId: string): string | null {
  try {
    const saved = localStorage.getItem(pinKey(vaultId));
    if (saved) return saved;
    const old = localStorage.getItem(legacyPinKey(vaultId));
    if (old) {
      localStorage.setItem(pinKey(vaultId), old);
      localStorage.removeItem(legacyPinKey(vaultId));
    }
    return old;
  } catch {
    return null;
  }
}
async function writePin(vaultId: string, raw: Uint8Array) {
  const pin = await E.vaultKeyPin(raw, vaultId);
  try {
    localStorage.setItem(pinKey(vaultId), pin);
  } catch {}
}
// "처음부터 다시"(키 초기화) 뒤: 개인 볼트는 새 키가 되니 전에 본 키와 판 번호를 잊는다
export function forgetPin(vaultId: string, userId: string) {
  try {
    localStorage.removeItem(`terminas.vaultpin.${userId}.${vaultId}`);
    localStorage.removeItem(legacyPinKey(vaultId));
    localStorage.removeItem(`terminas.rev.${userId}.${vaultId}`);
  } catch {}
}

// 방금 암호화 설정을 만들었거나 초기화한 계정 표시 — 초기화 뒤에는 새로고침하므로 이 탭(세션)에만 잠깐 적어 둔다
const FRESH_KEY = 'terminas.freshAccount';
export function noteFreshAccount(userId: string) {
  try {
    sessionStorage.setItem(FRESH_KEY, userId);
  } catch {}
}
// setAccount 뒤에 부른다: 적어 둔 것이 이 사람이면 "방금 만든 계정"으로 다룬다
export function takeFreshAccount(userId: string) {
  try {
    if (sessionStorage.getItem(FRESH_KEY) !== userId) return;
    sessionStorage.removeItem(FRESH_KEY);
    freshAccount = true;
  } catch {}
}

// 'same' = 이 기기에서 전에 본 그 키, 'new' = 처음 봄. 전에 본 것과 다르면 열지 않는다
async function checkPin(vaultId: string, raw: Uint8Array): Promise<'same' | 'new'> {
  const pin = await E.vaultKeyPin(raw, vaultId);
  const saved = readPin(vaultId);
  if (saved && saved !== pin) throw new Error(t('이 볼트의 키가 이 기기에서 전에 본 것과 다릅니다. 서버 쪽 변조일 수 있어 열지 않았습니다. 관리자에게 알려 주세요.'));
  return saved ? 'same' : 'new';
}

// 받은 볼트 키를 내 계정 키로 다시 봉해 서버에 둔다 — 다음부터 어느 기기에서든 "내가 봉한 키"로 확인된다.
// 새로 봉한 것이 풀리는지 먼저 확인하고 올린다. 서버가 모르면(API 3 전) 그대로 둔다
async function rewrapMine(v: Vault, raw: Uint8Array) {
  const a = account;
  if (!a) return;
  try {
    const wrapped = await E.wrapVaultKey(raw, E.toB64(a.publicKey), v.id, a.userId, a);
    const back = await E.unwrapVaultKeyFrom(wrapped, a, v.id);
    const same = back.key.length === raw.length && back.key.every((b, i) => b === raw[i]);
    E.wipe(back.key);
    if (!same) return;
    await api.put(`/api/vaults/${v.id}/key/mine`, { wrapped });
    v.wrappedKey = wrapped;
    v.wrappedBy = { userId: a.userId, name: me?.name ?? '', publicKey: E.toB64(a.publicKey) };
  } catch {}
}

// 같은 볼트의 키를 동시에 두 번 만들지 않게 진행 중인 것을 함께 기다린다
const keyLoading = new Map<string, Promise<{ raw: Uint8Array; key: E.SymKey } | null>>();

function vaultKey(v: Vault): Promise<{ raw: Uint8Array; key: E.SymKey } | null> {
  const cached = vaultKeys.get(v.id);
  if (cached) return Promise.resolve(cached);
  const running = keyLoading.get(v.id);
  if (running) return running;
  const p = openVaultKey(v).finally(() => keyLoading.delete(v.id));
  keyLoading.set(v.id, p);
  return p;
}

async function openVaultKey(v: Vault): Promise<{ raw: Uint8Array; key: E.SymKey } | null> {
  if (ephemeral) {
    // 임시 모드: 서버도 사본도 없으니 이번에만 쓰는 키
    const raw = E.randomBytes(32);
    const entry = { raw, key: await E.importKey(raw) };
    vaultKeys.set(v.id, entry);
    return entry;
  }
  if (!account) throw new Error(t('잠겨 있습니다. 암호화 비밀번호로 잠금을 풀어 주세요.'));
  let raw: Uint8Array;
  if (v.wrappedKey) {
    // 누가 봉했는지 (보안 점검 H-2):
    //   self   — 내 계정 키로 봉함: 나만 만들 수 있다
    //   member — 서버가 알려 준 봉한 사람의 공개키로 봉함: 그 공개키의 주인만 만들 수 있다 (가짜 팀원이면 팀원 목록에 드러난다)
    //   legacy — 예전 앱이 임시 키로 봉함: 누가 만들었는지 알 수 없다
    const opened = await E.unwrapVaultKeyFrom(v.wrappedKey, account, v.id);
    raw = opened.key;
    const by = v.wrappedBy ?? null;
    const origin = opened.sender === E.toB64(account.publicKey) ? 'self' : by && by.userId !== account.userId && by.publicKey === opened.sender ? 'member' : 'legacy';
    try {
      if (origin === 'member' && v.kind === 'personal') throw new Error(t('개인 볼트의 키를 다른 사람이 봉했습니다. 서버 쪽 변조일 수 있어 열지 않았습니다. 관리자에게 알려 주세요.'));
      if (origin === 'member' && by && peerKeyChanged(by.userId, opened.sender)) {
        throw new Error(t('이 볼트 키를 공유한 {name}님의 공개키가 이 기기에서 전에 본 것과 다릅니다. 서버 쪽 변조일 수 있어 열지 않았습니다. 관리자에게 알려 주세요.', { name: by.name }));
      }
      const seen = await checkPin(v.id, raw);
      if (origin === 'legacy' && seen === 'new') {
        if (freshAccount && v.kind === 'personal') throw new Error(t('방금 만든 계정인데 서버가 이미 볼트 키가 있다고 합니다. 서버 쪽 변조일 수 있어 열지 않았습니다. 관리자에게 알려 주세요.'));
        if (!trustedOnce.has(v.id)) throw new UntrustedVaultKey(v.id, t('이 볼트 키는 누가 봉했는지 확인할 수 없는 예전 방식이고, 이 기기에서 처음 봅니다. 이전 버전 앱에서 공유받은 키라면 열어도 되지만, 서버가 바꿔치기한 키일 수도 있습니다.'));
      }
    } catch (err) {
      E.wipe(raw);
      throw err;
    }
    if (origin === 'member' && by) rememberPeer(by.userId, opened.sender);
    await writePin(v.id, raw);
    if (origin !== 'self' && usesServer(v)) void rewrapMine(v, raw);
  } else if (!v.keyed && v.perm === 'edit') {
    // 아무도 키를 갖지 않은 새 볼트 → 내가 처음 만든다 (내 계정 키로 봉해 나만 만들 수 있는 암호문으로)
    raw = E.randomBytes(32);
    const wrapped = await E.wrapVaultKey(raw, E.toB64(account.publicKey), v.id, account.userId, account);
    try {
      await api.post(`/api/vaults/${v.id}/key`, { wrapped });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return null;
      throw err;
    }
    v.wrappedKey = wrapped;
    v.wrappedBy = { userId: account.userId, name: me?.name ?? '', publicKey: E.toB64(account.publicKey) };
    v.keyed = true;
    await checkPin(v.id, raw);
    await writePin(v.id, raw);
  } else {
    return null;
  }
  const entry = { raw, key: await E.importKey(raw) };
  vaultKeys.set(v.id, entry);
  return entry;
}

// 편집 권한이 있는데 아직 키가 없는 볼트(새 팀·새 볼트)는 잠금을 풀자마자 키를 만들어 둔다
export async function initMissingKeys(list: Vault[]) {
  if (ephemeral || !isOnline()) return;
  for (const v of list) {
    if (!v.keyed && v.perm === 'edit') await vaultKey(v).catch(() => null);
  }
}

// ---------- 읽기 ----------
export type VaultLoad = { items: Items; state: 'ready' | 'waiting'; failed: number; stale?: number };

type VKey = { raw: Uint8Array; key: E.SymKey };

export function loadVault(v: Vault, force = true): Promise<VaultLoad> {
  if (!force && cache.has(v.id)) return Promise.resolve({ items: itemsOf(v.id), state: 'ready', failed: failures.get(v.id) ?? 0, stale: staleOf.get(v.id) ?? 0 });
  const running = loading.get(v.id);
  if (running) return running;
  const p = (async (): Promise<VaultLoad> => {
    const k = await vaultKey(v);
    if (!k) return { items: EMPTY_ITEMS, state: 'waiting', failed: 0 };
    if (usesServer(v)) {
      try {
        await withLock(v.id, () => syncVault(v, k));
        return { items: itemsOf(v.id), state: 'ready', failed: failures.get(v.id) ?? 0, stale: staleOf.get(v.id) ?? 0 };
      } catch (err) {
        // 서버에 닿지 않으면 이 PC 의 사본으로 이어 간다
        if (!isNetworkError(err) || !O.offlineReady()) throw err;
      }
    }
    await withLock(v.id, () => loadLocal(v, k));
    return { items: itemsOf(v.id), state: 'ready', failed: failures.get(v.id) ?? 0, stale: staleOf.get(v.id) ?? 0 };
  })();
  loading.set(v.id, p);
  return p.finally(() => loading.delete(v.id));
}

// 서버와 주고받는 볼트인지 (오프라인·임시 모드·개인 동기화를 끈 개인 볼트는 이 PC 의 것만 쓴다)
const localOnly = (v: Vault) => v.kind === 'personal' && !O.personalSync();
const usesServer = (v: Vault) => !ephemeral && isOnline() && !localOnly(v);

// 같은 볼트의 올리기·받기·쓰기를 하나씩 차례로 (서로 끼어들면 사본이 어긋난다)
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(vaultId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(vaultId, tail);
  void tail.then(() => locks.get(vaultId) === tail && locks.delete(vaultId));
  return next;
}

// ---------- 되돌리기 알아채기 (보안 점검 M-5) ----------
// 이 기기에서 본 항목마다 가장 높은 판 번호(_r + 1)를, 지운(목록에서 사라진) 항목은 음수로 기억한다. 서버가 그보다 낮은 판이나
// 지운 항목을 같은 판으로 다시 주면 숨기고 알린다 — 옛 비밀번호·지운 신뢰 지문·폐기한 키가 되살아나지 않게.
// 기억은 이 기기(앱·브라우저)에만 있어, 처음 보는 기기에서는 알아채지 못한다.
const revKey = (vaultId: string) => `terminas.rev.${account?.userId ?? me?.id ?? ''}.${vaultId}`;
function readRevs(vaultId: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(revKey(vaultId)) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function writeRevs(vaultId: string, revs: Record<string, number>) {
  try {
    localStorage.setItem(revKey(vaultId), JSON.stringify(revs));
  } catch {}
}
const revOf = (data: unknown) => (Number((data as { _r?: unknown } | null)?._r) || 0) + 1;

// 서버가 준 예전 판을 받아들인다 (서버를 백업에서 되살린 것처럼 이유를 아는 경우) — 이 볼트의 기억을 지금 서버 것으로 새로 적는다
export function acceptStale(vaultId: string) {
  try {
    localStorage.removeItem(revKey(vaultId));
  } catch {}
  staleOf.delete(vaultId);
}

// 받은 암호문을 풀어 화면에 쓸 모양으로 (풀지 못한 것은 사본에만 남기고 숨긴다)
// fromServer: 서버 목록 전체를 받은 때 — 그 목록에서 사라진 항목을 "지운 것"으로 기억한다
async function applyRows(v: Vault, k: VKey, rows: RawItem[], dirty: Record<string, Dirty>, synced: number, fromServer = false) {
  const map = new Map<string, Entry>();
  let failed = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        const data = await E.openJson<DataOf[Kind]>(k.key, r.data, E.itemAad(v.id, r.id, r.kind));
        map.set(r.id, { id: r.id, kind: r.kind, vaultId: v.id, data, createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy });
      } catch {
        failed++;
      }
    }),
  );
  if (!ephemeral) {
    const revs = readRevs(v.id);
    let stale = 0;
    let changed = false;
    for (const [id, e] of map) {
      const r = revOf(e.data);
      const seen = revs[id];
      if (seen !== undefined && (seen > 0 ? r < seen : r <= -seen)) {
        map.delete(id);
        stale++;
        continue;
      }
      if (seen === undefined || seen < 0 || r > seen) {
        revs[id] = r;
        changed = true;
      }
    }
    if (fromServer) {
      const present = new Set(rows.map((r) => r.id));
      for (const [id, seen] of Object.entries(revs)) {
        if (seen > 0 && !present.has(id)) {
          revs[id] = -seen;
          changed = true;
        }
      }
    }
    if (changed) writeRevs(v.id, revs);
    staleOf.set(v.id, stale);
  }
  cache.set(v.id, map);
  failures.set(v.id, failed);
  rowsOf.set(v.id, new Map(rows.map((r) => [r.id, r])));
  dirtyOf.set(v.id, dirty);
  syncedAt.set(v.id, synced);
}

// 서버에 닿지 않을 때: 메모리에 있는 것 → 없으면 이 PC 의 사본 (팀 볼트는 팀이 정한 기간 안에서만)
async function loadLocal(v: Vault, k: VKey) {
  if (cache.has(v.id) && rowsOf.has(v.id)) {
    if (v.kind === 'personal' || ephemeral || O.copyUsable(v, syncedAt.get(v.id) ?? 0)) return;
    await forgetVault(v.id);
    throw new Error(t('이 팀 볼트의 오프라인 사본은 사용할 수 있는 기간이 지나 지웠습니다. 서버에 연결되면 다시 받습니다.'));
  }
  if (ephemeral) return applyRows(v, k, [], {}, 0);
  const snap = await O.loadVaultSnap(v.id);
  if (!snap) {
    // 개인 동기화를 끈 개인 볼트는 이 PC 의 것이 전부 — 없으면 빈 볼트로 시작한다
    if (localOnly(v)) return applyRows(v, k, [], {}, 0);
    throw new Error(t('서버에 연결할 수 없고, 이 PC에 저장된 이 볼트의 사본이 없습니다.'));
  }
  if (!O.copyUsable(v, snap.syncedAt)) {
    await O.dropVaultSnap(v.id);
    throw new Error(t('이 팀 볼트의 오프라인 사본은 사용할 수 있는 기간이 지나 지웠습니다. 서버에 연결되면 다시 받습니다.'));
  }
  await applyRows(v, k, snap.rows, snap.dirty, snap.syncedAt);
}

// ---------- 서버와 맞추기 ----------
export type SyncResult = { pushed: number; conflicts: number; restored: number; kept: number; failed: number };
const emptyResult = (): SyncResult => ({ pushed: 0, conflicts: 0, restored: 0, kept: 0, failed: 0 });
const addResult = (a: SyncResult, b: SyncResult) => {
  for (const key of Object.keys(a) as (keyof SyncResult)[]) a[key] += b[key];
};
const syncListeners = new Set<(r: SyncResult) => void>();
// 오프라인에서 고친 것을 올린 결과 (화면이 알림으로 보여 준다)
export function onSyncResult(fn: (r: SyncResult) => void) {
  syncListeners.add(fn);
  return () => void syncListeners.delete(fn);
}
const announce = (r: SyncResult) => {
  if (r.pushed || r.conflicts || r.restored || r.kept || r.failed) for (const fn of syncListeners) fn(r);
};

// 이 PC 에서 고친 것을 먼저 올리고, 서버의 지금 것을 받아 사본을 새로 만든다 (withLock 안에서)
async function syncVault(v: Vault, k: VKey): Promise<SyncResult> {
  const result = emptyResult();
  // 앱을 다시 켠 뒤라면 올릴 것은 사본 파일에만 있다
  if (!dirtyOf.has(v.id) && O.offlineReady()) {
    const snap = await O.loadVaultSnap(v.id);
    if (snap && Object.keys(snap.dirty).length) {
      dirtyOf.set(v.id, snap.dirty);
      rowsOf.set(v.id, new Map(snap.rows.map((r) => [r.id, r])));
    }
  }
  const dirty = dirtyOf.get(v.id) ?? {};
  let server = await api.get<RawItem[]>(`/api/vaults/${v.id}/items`);
  if (Object.keys(dirty).length) {
    if (v.perm === 'edit') {
      await pushDirty(v, k, server, dirty, result);
      server = await api.get<RawItem[]>(`/api/vaults/${v.id}/items`);
    } else {
      // 그사이 보기 권한으로 바뀌어 올릴 수 없다
      result.failed += Object.keys(dirty).length;
      for (const id of Object.keys(dirty)) delete dirty[id];
    }
  }
  const local = rowsOf.get(v.id) ?? new Map<string, RawItem>();
  const merged = new Map(server.map((r) => [r.id, r]));
  // 올리지 못하고 남은 것은 이 PC 의 것을 그대로 보여 준다
  for (const [id, d] of Object.entries(dirty)) {
    if (d.op === 'delete') merged.delete(id);
    else if (local.has(id)) merged.set(id, local.get(id)!);
  }
  await applyRows(v, k, [...merged.values()], dirty, Date.now(), true);
  schedulePersist(v.id, 0);
  announce(result);
  return result;
}

async function pushDirty(v: Vault, k: VKey, server: RawItem[], dirty: Record<string, Dirty>, result: SyncResult) {
  const theirs = new Map(server.map((r) => [r.id, r]));
  const local = rowsOf.get(v.id) ?? new Map<string, RawItem>();
  for (const [id, d] of Object.entries(dirty)) {
    const mine = local.get(id);
    const there = theirs.get(id);
    try {
      await pushOne(v, k, id, d, mine, there, result);
    } catch (err) {
      if (isNetworkError(err)) {
        schedulePersist(v.id, 0);
        throw err;
      }
      // 올리는 사이 다른 곳에서 고쳤거나(409) 지웠다(404)
      const status = err instanceof ApiError ? err.status : 0;
      try {
        if (status === 409 && d.op !== 'delete' && mine) await conflictCopy(v, k, mine, result);
        else if (status === 409) result.kept++;
        else if (status === 404 && d.op !== 'delete' && mine) {
          await api.post(`/api/vaults/${v.id}/items`, { id, kind: mine.kind, data: mine.data, label: d.label });
          result.restored++;
        } else if (!(status === 404 && d.op === 'delete')) {
          result.failed++;
          continue;
        }
      } catch (again) {
        if (isNetworkError(again)) throw again;
        result.failed++;
        continue;
      }
    }
    delete dirty[id];
    schedulePersist(v.id);
  }
}

async function pushOne(v: Vault, k: VKey, id: string, d: Dirty, mine: RawItem | undefined, there: RawItem | undefined, result: SyncResult) {
  if (d.op === 'delete') {
    // 그사이 다른 곳에서 고쳤으면 지우지 않고 고친 쪽을 살린다
    if (there && there.updatedAt === d.base) {
      await api.del(`/api/items/${id}`, { label: d.label, baseUpdatedAt: d.base });
      result.pushed++;
    } else if (there) result.kept++;
    return;
  }
  if (!mine) return;
  if (!there) {
    // 새로 만든 것 · 또는 고치는 사이 다른 곳에서 지운 것 → (다시) 만든다
    await api.post(`/api/vaults/${v.id}/items`, { id, kind: mine.kind, data: mine.data, label: d.label });
    if (d.op === 'update') result.restored++;
    else result.pushed++;
    return;
  }
  // 새로 만든 것인데 이미 서버에 있다 = 전에 올리다 끊겼다 → 내 것으로 덮는다
  if (d.op === 'create' || there.updatedAt === d.base) {
    await api.patch(`/api/items/${id}`, { data: mine.data, baseUpdatedAt: there.updatedAt, label: d.label });
    result.pushed++;
    return;
  }
  // 양쪽에서 고쳤다: 서버 것은 그대로 두고, 내 것은 새 항목으로 남긴다
  await conflictCopy(v, k, mine, result);
}

// "충돌 사본": 이름 뒤에 표시를 붙여 새 항목으로 올린다 (서버 지문·내 계정 연결은 사본을 만들지 않고 서버 것을 따른다)
async function conflictCopy(v: Vault, k: VKey, mine: RawItem, result: SyncResult) {
  if (mine.kind === 'knownhost' || mine.kind === 'hostcred') {
    result.kept++;
    return;
  }
  const data = await E.openJson<Record<string, unknown>>(k.key, mine.data, E.itemAad(v.id, mine.id, mine.kind));
  const field = mine.kind === 'group' || mine.kind === 'httpenv' ? 'name' : 'label';
  const base = String(data[field] || (mine.kind === 'host' ? data.address : '') || '');
  data[field] = t('{name} (충돌 사본)', { name: base }).slice(0, 120);
  const id = crypto.randomUUID();
  await api.post(`/api/vaults/${v.id}/items`, {
    id,
    kind: mine.kind,
    data: await E.sealJson(k.key, data, E.itemAad(v.id, id, mine.kind)),
    label: await sealLabel(k, v.id, String(data[field]), id),
  });
  result.conflicts++;
}

// 볼 수 있는 모든 볼트를 서버와 맞춘다 (다시 연결됐을 때, 그리고 켜져 있는 동안 가끔). 개인 볼트부터.
export async function syncAll(): Promise<SyncResult> {
  const total = emptyResult();
  if (ephemeral || !isOnline()) return total;
  const list = [...vaults.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'personal' ? -1 : 1));
  for (const v of list) {
    if (localOnly(v)) continue;
    try {
      const k = await vaultKey(v);
      if (!k) continue;
      addResult(total, await withLock(v.id, () => syncVault(v, k)));
    } catch (err) {
      if (isNetworkError(err)) throw err;
    }
  }
  await O.markSynced();
  return total;
}

// 사본 저장: 고칠 때마다 쓰지 않고 잠깐 모았다가 (서버와 맞춘 직후에는 바로)
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(vaultId: string, delay = 400) {
  if (ephemeral || !O.offlineReady()) return;
  const prev = saveTimers.get(vaultId);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    vaultId,
    setTimeout(() => {
      saveTimers.delete(vaultId);
      void persist(vaultId);
    }, delay),
  );
}
async function persist(vaultId: string) {
  const v = vaults.get(vaultId);
  const rows = rowsOf.get(vaultId);
  if (!v || !rows) return;
  await O.saveVaultSnap(vaultId, syncedAt.get(vaultId) ?? 0, [...rows.values()], dirtyOf.get(vaultId) ?? {});
}
// 저장을 기다리는 사본을 바로 쓴다 (설정을 바꾸기 전 등)
export async function flushPersist() {
  const ids = [...saveTimers.keys()];
  for (const id of ids) clearTimeout(saveTimers.get(id)!);
  saveTimers.clear();
  await Promise.all(ids.map((id) => persist(id)));
}

// 메모리와 이 PC 에서 그 볼트의 사본을 지운다
async function forgetVault(vaultId: string) {
  cache.delete(vaultId);
  rowsOf.delete(vaultId);
  dirtyOf.delete(vaultId);
  syncedAt.delete(vaultId);
  failures.delete(vaultId);
  const k = vaultKeys.get(vaultId);
  if (k) E.wipe(k.raw);
  vaultKeys.delete(vaultId);
  await O.dropVaultSnap(vaultId);
}

// 오프라인이 길어지면: 쓸 수 있는 기간이 지난(또는 사본이 없는) 팀 볼트를 메모리와 이 PC 에서 지운다. 지운 볼트 id 를 돌려준다
export async function expireCopies(): Promise<string[]> {
  if (ephemeral || isOnline()) return [];
  const gone: string[] = [];
  for (const v of [...vaults.values()]) {
    if (v.kind !== 'team') continue;
    const at = syncedAt.get(v.id) ?? O.snapSyncedAt(v.id);
    if (at !== undefined && O.copyUsable(v, at)) continue;
    await forgetVault(v.id);
    vaults.delete(v.id);
    gone.push(v.id);
  }
  return gone;
}

// 로그인이 끝났을 때(팀에서 빠졌거나 계정이 막혔을 수 있다): 팀 볼트를 메모리와 이 PC 에서 모두 지운다
export async function dropTeamCopies(): Promise<string[]> {
  const gone: string[] = [];
  for (const v of [...vaults.values()]) {
    if (v.kind !== 'team') continue;
    await forgetVault(v.id);
    vaults.delete(v.id);
    gone.push(v.id);
  }
  await O.dropTeamSnaps();
  return gone;
}

// ---------- 오프라인 상태 (화면에 보여 줄 것) ----------
export function pendingChanges(vaultId?: string) {
  if (vaultId) return Object.keys(dirtyOf.get(vaultId) ?? {}).length;
  let n = 0;
  for (const d of dirtyOf.values()) n += Object.keys(d).length;
  return n;
}
export const vaultSyncedAt = (vaultId: string) => syncedAt.get(vaultId) ?? 0;
export function vaultCopyExpiresAt(vaultId: string) {
  const v = vaults.get(vaultId);
  const at = syncedAt.get(vaultId);
  return v && at ? O.copyExpiresAt(v, at) : null;
}

// ---------- 개인 동기화 켜기·끄기 (이 PC 에서만) ----------
// 끄기: 먼저 서버와 맞춘 뒤(올릴 것은 올리고) 이 PC 에만 둔다. 서버 사본을 지우면, 다시 켤 때 이 PC 의 것을 모두 새로 올린다.
export async function disablePersonalSync(deleteServerCopy: boolean) {
  const v = personalVault();
  if (!v) return;
  const k = await vaultKey(v);
  if (!k) throw new Error(t('개인 볼트를 열 수 없습니다'));
  if (deleteServerCopy && !isOnline()) throw new Error(t('서버 사본은 서버에 연결되어 있을 때만 지울 수 있습니다.'));
  await withLock(v.id, async () => {
    if (isOnline()) await syncVault(v, k);
    else await loadLocal(v, k);
    if (deleteServerCopy) {
      await api.del(`/api/vaults/${v.id}/items`, { confirm: 'CLEAR' });
      const now = Date.now();
      const dirty: Record<string, Dirty> = {};
      for (const id of rowsOf.get(v.id)?.keys() ?? []) dirty[id] = { op: 'create', base: null, at: now };
      dirtyOf.set(v.id, dirty);
    }
    await O.setPersonalSync(false);
    await persist(v.id);
  });
}
// 켜기: 서버와 합친다 (오프라인이면 다시 연결될 때)
export async function enablePersonalSync(): Promise<SyncResult> {
  await flushPersist();
  await O.setPersonalSync(true);
  const v = personalVault();
  if (!v || !isOnline()) return emptyResult();
  const k = await vaultKey(v);
  if (!k) return emptyResult();
  return withLock(v.id, () => syncVault(v, k));
}

export async function ensureLoaded(vaultId: string) {
  const v = vaults.get(vaultId);
  if (!v) return false;
  if (!cache.has(vaultId)) await loadVault(v, false);
  return cache.has(vaultId);
}

function entriesOf<K extends Kind>(vaultId: string, kind: K): Entry<K>[] {
  return [...(cache.get(vaultId)?.values() ?? [])].filter((e): e is Entry<K> => e.kind === kind);
}
function findEntry(id: string): Entry {
  for (const map of cache.values()) {
    const e = map.get(id);
    if (e) return e;
  }
  throw new Error(t('항목을 찾을 수 없습니다. 새로고침해 주세요.'));
}
function entryIn<K extends Kind>(vaultId: string, id: string | null | undefined, kind: K): Entry<K> | undefined {
  if (!id) return undefined;
  const e = cache.get(vaultId)?.get(id);
  return e?.kind === kind ? (e as Entry<K>) : undefined;
}
const byLabel = (a: string, b: string) => a.localeCompare(b, locale(), { numeric: true, sensitivity: 'base' });

const groupOut = (e: Entry<'group'>): Group => ({ id: e.id, vaultId: e.vaultId, parentId: entryIn(e.vaultId, e.data.parentId, 'group') ? e.data.parentId : null, name: e.data.name });
const hostOut = (e: Entry<'host'>): Host => ({
  id: e.id,
  vaultId: e.vaultId,
  groupId: entryIn(e.vaultId, e.data.groupId, 'group') ? e.data.groupId : null,
  label: e.data.label,
  address: e.data.address,
  port: e.data.port,
  username: e.data.username,
  hasPassword: Boolean(e.data.password),
  keyId: entryIn(e.vaultId, e.data.keyId, 'key') ? e.data.keyId : null,
  identityId: entryIn(e.vaultId, e.data.identityId, 'identity') ? e.data.identityId : null,
  tags: e.data.tags ?? [],
  os: e.data.os ?? '',
  updatedAt: e.updatedAt,
});
const keyOut = (e: Entry<'key'>): SshKey => ({
  id: e.id,
  vaultId: e.vaultId,
  label: e.data.label,
  keyType: e.data.keyType,
  publicKey: e.data.publicKey,
  fingerprint: e.data.fingerprint,
  hasPassphrase: Boolean(e.data.passphrase),
  createdAt: e.createdAt,
});
const identityOut = (e: Entry<'identity'>): Identity => ({
  id: e.id,
  vaultId: e.vaultId,
  label: e.data.label,
  username: e.data.username,
  hasPassword: Boolean(e.data.password),
  keyId: entryIn(e.vaultId, e.data.keyId, 'key') ? e.data.keyId : null,
});
const snippetOut = (e: Entry<'snippet'>): Snippet => ({ id: e.id, vaultId: e.vaultId, label: e.data.label, script: e.data.script });
const forwardOut = (e: Entry<'forward'>): Forward => ({ id: e.id, vaultId: e.vaultId, ...e.data });
const requestOut = (e: Entry<'request'>): HttpRequestItem => ({ id: e.id, vaultId: e.vaultId, ...normRequest(e.data) });
const httpEnvOut = (e: Entry<'httpenv'>): HttpEnv => ({ id: e.id, vaultId: e.vaultId, ...normHttpEnv(e.data) });

// ---------- HTTP 요청 도구 (앱 전용) — 저장한 요청·환경 변수. 한 항목은 서버에서 64KB(암호문)까지라 본문은 32,000자까지 ----------
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
function normRequest(d: Partial<Record<keyof RequestData, unknown>>): RequestData {
  const method = clip(d.method, 20).toUpperCase();
  const auth = (d.auth && typeof d.auth === 'object' ? d.auth : {}) as Partial<Record<keyof HttpAuth, unknown>>;
  return {
    label: clip(d.label, 120),
    collection: clip(d.collection, 60).trim(),
    method: /^[A-Z]{1,20}$/.test(method) ? method : 'GET',
    url: clip(d.url, 4000),
    headers: (Array.isArray(d.headers) ? d.headers : []).slice(0, 100).map((h: Partial<HttpHeader>) => ({ name: clip(h?.name, 200), value: clip(h?.value, 8000), on: h?.on !== false })),
    offParams: (Array.isArray(d.offParams) ? d.offParams : []).slice(0, 100).map((h: Partial<HttpHeader>) => ({ name: clip(h?.name, 500), value: clip(h?.value, 4000), on: false })),
    bodyType: (['none', 'json', 'text', 'xml', 'form'] as const).includes(d.bodyType as HttpBodyType) ? (d.bodyType as HttpBodyType) : 'none',
    body: clip(d.body, 32000),
    auth: {
      type: (['none', 'bearer', 'basic', 'apikey'] as const).includes(auth.type as HttpAuth['type']) ? (auth.type as HttpAuth['type']) : 'none',
      token: clip(auth.token, 8000),
      username: clip(auth.username, 200),
      password: clip(auth.password, 1000),
      key: clip(auth.key, 200),
      keyIn: auth.keyIn === 'query' ? 'query' : 'header',
    },
    insecure: d.insecure === true,
    follow: d.follow !== false,
    timeout: typeof d.timeout === 'number' && d.timeout >= 1 && d.timeout <= 300 ? Math.round(d.timeout) : 30,
  };
}
function normHttpEnv(d: Partial<Record<keyof HttpEnvData, unknown>>): HttpEnvData {
  return {
    name: clip(d.name, 60),
    vars: (Array.isArray(d.vars) ? d.vars : []).slice(0, 200).map((v: Partial<HttpEnvVar>) => ({ key: clip(v?.key, 100), value: clip(v?.value, 8000), secret: v?.secret === true })),
  };
}
export const HTTP_METHODS = METHODS;
export const emptyRequest = (): RequestData => normRequest({ method: 'GET', url: '', headers: [], offParams: [], bodyType: 'none', body: '', auth: { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' } });

export function itemsOf(vaultId: string): Items {
  return {
    groups: entriesOf(vaultId, 'group').map(groupOut).sort((a, b) => byLabel(a.name, b.name)),
    hosts: entriesOf(vaultId, 'host').map(hostOut).sort((a, b) => byLabel(a.label || a.address, b.label || b.address)),
    keys: entriesOf(vaultId, 'key').map(keyOut).sort((a, b) => byLabel(a.label, b.label)),
    identities: entriesOf(vaultId, 'identity').map(identityOut).sort((a, b) => byLabel(a.label, b.label)),
    snippets: entriesOf(vaultId, 'snippet').map(snippetOut).sort((a, b) => byLabel(a.label, b.label)),
    forwards: entriesOf(vaultId, 'forward').map(forwardOut).sort((a, b) => a.localPort - b.localPort),
    requests: entriesOf(vaultId, 'request').map(requestOut).sort((a, b) => byLabel(a.collection, b.collection) || byLabel(a.label, b.label)),
    httpEnvs: entriesOf(vaultId, 'httpenv').map(httpEnvOut).sort((a, b) => byLabel(a.name, b.name)),
  };
}

// 볼 수 있는 모든 볼트의 호스트 (Ctrl+K·SFTP 호스트 고르기)
export async function allHosts(): Promise<Host[]> {
  const out: Host[] = [];
  for (const v of vaults.values()) {
    try {
      await ensureLoaded(v.id);
    } catch {
      continue;
    }
    for (const h of entriesOf(v.id, 'host').map(hostOut)) out.push({ ...h, vaultName: v.teamName ? `${v.teamName} · ${v.name}` : v.name });
  }
  return out.sort((a, b) => byLabel(a.label || a.address, b.label || b.address));
}

export function knownHostsOf(vaultId: string): KnownHost[] {
  return entriesOf(vaultId, 'knownhost')
    .map((e) => ({ id: e.id, vaultId, address: e.data.address, port: e.data.port, keyType: e.data.keyType, fingerprint: e.data.fingerprint, createdAt: e.createdAt, addedBy: e.data.addedByName || null }))
    .sort((a, b) => byLabel(`${a.address}:${a.port}`, `${b.address}:${b.port}`));
}

// 이 호스트의 저장된 지문: 호스트가 있는 볼트 것 + 내가 개인 볼트에 남긴 것 (서로 다르면 불일치로 막힌다)
export function knownFor(vaultId: string, address: string, port: number) {
  const a = address.toLowerCase();
  const pv = personalVault()?.id;
  const sources = pv && pv !== vaultId ? [vaultId, pv] : [vaultId];
  return sources.flatMap((id) =>
    entriesOf(id, 'knownhost')
      .filter((e) => e.data.address === a && e.data.port === port)
      .map((e) => ({ fingerprint: e.data.fingerprint, keyType: e.data.keyType })),
  );
}

// 처음 보는 서버 지문을 어디에 남길지: 편집할 수 있는 볼트면 그 볼트(팀이 함께 씀), 아니면 내 개인 볼트(나에게만)
// (오프라인에서는 팀 볼트를 고칠 수 없으니 내 개인 볼트에 — 다시 연결되면 올라간다)
export function trustTarget(vaultId: string) {
  const v = vaults.get(vaultId);
  const editable = v?.perm === 'edit' && (v.kind === 'personal' || isOnline() || ephemeral);
  return editable ? vaultId : personalVault()?.id ?? vaultId;
}

export const failedCount = (vaultId: string) => failures.get(vaultId) ?? 0;

// ---------- 쓰기 ----------
async function writable(vaultId: string, kind: Kind) {
  const v = vaults.get(vaultId);
  if (!v) throw new Error(t('볼트를 찾을 수 없습니다'));
  if (v.perm !== 'edit') throw new Error(t('이 볼트는 보기 권한만 있습니다'));
  // 팀 볼트는 오프라인에서 보기만 (팀원끼리 어긋나지 않게)
  if (v.kind === 'team' && !isOnline() && !ephemeral) throw new Error(t('오프라인에서는 팀 볼트를 수정할 수 없습니다. 서버에 다시 연결되면 수정해 주세요.'));
  const k = await vaultKey(v);
  if (!k) throw new VaultWaiting(t('아직 이 볼트의 키를 공유받지 못했습니다. 팀 관리자가 앱이나 웹을 열면 자동으로 공유 요청이 뜹니다.'));
  if (!cache.has(vaultId)) await loadVault(v, false);
  const rows = cache.get(vaultId)?.size ?? 0;
  if (failures.get(vaultId) && !rows) throw new Error(t('이 볼트의 항목을 하나도 풀지 못해 쓰기를 막았습니다. 관리자에게 알려 주세요.'));
  return { v, k };
}

// ref: 그 기록이 가리키는 항목(호스트) id — 이름을 그 기록에 묶는다 (openLabel 도 같은 ref 로 푼다)
const sealLabel = (k: { key: E.SymKey }, vaultId: string, label: string | undefined, ref?: string) =>
  label ? E.seal(k.key, label.slice(0, 200), E.labelAad(vaultId, ref)) : Promise.resolve(undefined);

// 서버에 바로 쓸지: 연결돼 있고, 이 PC 에만 두는 볼트가 아니고, 그 항목에 아직 올리지 않은 변경이 없을 때
const direct = (v: Vault, id: string) => usesServer(v) && !dirtyOf.get(v.id)?.[id];
// 서버에 못 쓸 때 이 PC 에 적어 둘 수 있는지 (개인 볼트만 — 사본을 둘 수 있어야 한다)
function canWriteLocal(v: Vault) {
  if (ephemeral) return true;
  return v.kind === 'personal' && O.offlineReady();
}
function assertLocal(v: Vault) {
  if (canWriteLocal(v)) return;
  if (v.kind === 'team') throw new Error(t('오프라인에서는 팀 볼트를 수정할 수 없습니다. 서버에 다시 연결되면 수정해 주세요.'));
  throw new Error(t('서버에 연결할 수 없습니다. 이 PC에는 오프라인 사본을 둘 수 없어 수정한 것을 저장하지 못했습니다.'));
}
function markDirty(vaultId: string, id: string, op: Dirty['op'], base: number | null, label: string | undefined) {
  if (ephemeral) return;
  const dirty = dirtyOf.get(vaultId) ?? {};
  dirty[id] = { op, base, label, at: Date.now() };
  dirtyOf.set(vaultId, dirty);
}

// 받은(또는 이 PC 에서 만든) 암호문과 풀린 내용을 함께 넣는다. 이미 있는 항목은 그 객체를 고친다(화면이 쥐고 있을 수 있다)
// synced: 서버에 올라간 판인지 — 아직 올리지 않은(오프라인) 판은 판 번호로 기억하지 않는다. 올리다 충돌해 서버 것이 남으면
// 그 서버 판이 "예전 판"으로 잘못 숨겨지지 않게
function put<K extends Kind>(vaultId: string, row: RawItem, data: DataOf[K], synced = true): Entry<K> {
  if (!rowsOf.has(vaultId)) rowsOf.set(vaultId, new Map());
  rowsOf.get(vaultId)!.set(row.id, row);
  if (!cache.has(vaultId)) cache.set(vaultId, new Map());
  const map = cache.get(vaultId)!;
  const existing = map.get(row.id) as Entry<K> | undefined;
  const fields = { data, createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy };
  const e = existing ? Object.assign(existing, fields) : ({ id: row.id, kind: row.kind as K, vaultId, ...fields } as Entry<K>);
  map.set(row.id, e as Entry);
  if (synced) noteRev(vaultId, row.id, revOf(data));
  schedulePersist(vaultId);
  return e;
}
// synced: 서버에서도 지워졌는지 — 아직 올리지 않은 지우기는 기억하지 않는다 (올리면 다음 서버 목록에서 사라진 것으로 기억된다)
function drop(vaultId: string, id: string, synced = true) {
  const e = cache.get(vaultId)?.get(id);
  if (e && synced) noteRev(vaultId, id, -revOf(e.data));
  rowsOf.get(vaultId)?.delete(id);
  cache.get(vaultId)?.delete(id);
  schedulePersist(vaultId);
}
// 이 기기에서 저장·지운 판도 기억한다 (다음에 서버 목록을 받기 전에 지운 것도 되살아나지 않게)
function noteRev(vaultId: string, id: string, rev: number) {
  if (ephemeral) return;
  const revs = readRevs(vaultId);
  if (revs[id] === rev) return;
  revs[id] = rev;
  writeRevs(vaultId, revs);
}

async function createItem<K extends Kind>(vaultId: string, kind: K, data: DataOf[K], label?: string, id: string = crypto.randomUUID()): Promise<Entry<K>> {
  const { v, k } = await writable(vaultId, kind);
  const stored = stamp(kind, data) as DataOf[K];
  return withLock(vaultId, async () => {
    const sealed = await E.sealJson(k.key, stored, E.itemAad(vaultId, id, kind));
    const sealedLabel = await sealLabel(k, vaultId, label, id);
    if (direct(v, id)) {
      try {
        return put<K>(vaultId, await api.post<RawItem>(`/api/vaults/${vaultId}/items`, { id, kind, data: sealed, label: sealedLabel }), stored);
      } catch (err) {
        if (!isNetworkError(err) || !canWriteLocal(v)) throw err;
      }
    }
    assertLocal(v);
    const now = Date.now();
    markDirty(vaultId, id, 'create', null, sealedLabel);
    return put<K>(vaultId, { id, kind, data: sealed, createdBy: me?.id ?? null, updatedBy: me?.id ?? null, createdAt: now, updatedAt: now }, stored, false);
  });
}

async function updateItem<K extends Kind>(e: Entry<K>, data: DataOf[K], label?: string): Promise<Entry<K>> {
  if (formatOf(e.data) > ITEM_FORMAT) throw new Error(TOO_NEW());
  const { v, k } = await writable(e.vaultId, e.kind);
  const stored = stamp(e.kind, data, e.data) as DataOf[K];
  return withLock(e.vaultId, async () => {
    const sealed = await E.sealJson(k.key, stored, E.itemAad(e.vaultId, e.id, e.kind));
    const sealedLabel = await sealLabel(k, e.vaultId, label, e.id);
    if (direct(v, e.id)) {
      try {
        return put<K>(e.vaultId, await api.patch<RawItem>(`/api/items/${e.id}`, { data: sealed, baseUpdatedAt: e.updatedAt, label: sealedLabel }), stored);
      } catch (err) {
        if (!isNetworkError(err) || !canWriteLocal(v)) throw err;
      }
    }
    assertLocal(v);
    const prev = rowsOf.get(e.vaultId)?.get(e.id);
    const d = dirtyOf.get(e.vaultId)?.[e.id];
    // 새로 만든 것은 계속 "새로 만듦", 서버에 있던 것은 처음 고칠 때의 서버 판을 기준으로
    markDirty(e.vaultId, e.id, d?.op === 'create' ? 'create' : 'update', d ? d.base : e.updatedAt, sealedLabel ?? d?.label);
    const row: RawItem = {
      id: e.id,
      kind: e.kind,
      data: sealed,
      createdBy: prev?.createdBy ?? e.createdBy,
      updatedBy: me?.id ?? null,
      createdAt: prev?.createdAt ?? e.createdAt,
      updatedAt: Math.max(Date.now(), e.updatedAt + 1),
    };
    return put<K>(e.vaultId, row, stored, false);
  });
}

async function deleteItem(e: Entry, label?: string) {
  if (formatOf(e.data) > ITEM_FORMAT) throw new Error(TOO_NEW());
  const { v, k } = await writable(e.vaultId, e.kind);
  await withLock(e.vaultId, async () => {
    const sealedLabel = await sealLabel(k, e.vaultId, label, e.id);
    if (direct(v, e.id)) {
      try {
        await api.del(`/api/items/${e.id}`, { label: sealedLabel });
        return drop(e.vaultId, e.id);
      } catch (err) {
        if (!isNetworkError(err) || !canWriteLocal(v)) throw err;
      }
    }
    assertLocal(v);
    const dirty = dirtyOf.get(e.vaultId);
    const d = dirty?.[e.id];
    // 서버에 올라간 적 없는 것은 그냥 없앤다
    if (d?.op === 'create') delete dirty![e.id];
    else markDirty(e.vaultId, e.id, 'delete', d ? d.base : e.updatedAt, sealedLabel ?? d?.label);
    drop(e.vaultId, e.id, false);
  });
}

// undefined = 그대로, null/'' = 지우기, 값 = 바꾸기
function merged<T extends object>(base: T, patch: Partial<Record<keyof T, unknown>>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ---------- 검사 (예전에는 서버가 하던 것) ----------
function text(v: unknown, name: string, { min = 0, max = 255 } = {}) {
  const s = typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
  if (s.length < min) throw new Error(t('{name}을(를) 입력해 주세요', { name }));
  if (s.length > max) throw new Error(t('{name}이(가) 너무 깁니다', { name }));
  return s;
}
function secretOf(v: unknown, max = 4096): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new Error(t('값이 올바르지 않습니다'));
  if (v.length > max) throw new Error(t('값이 너무 깁니다'));
  return v;
}
function portOf(v: unknown, name = t('포트')) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t('{name}은(는) 1~65535 사이여야 합니다', { name }));
  return n;
}
function addressOf(v: unknown, name = t('주소')) {
  const s = text(v, name, { min: 1, max: 255 });
  if (/[\s/]/.test(s)) throw new Error(t('{name}에는 공백이나 \'/\'를 사용할 수 없습니다', { name }));
  return s;
}
function refIn(vaultId: string, id: unknown, kind: Kind, name: string): string | null {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id !== 'string' || !entryIn(vaultId, id, kind)) throw new Error(t('{name}은(는) 같은 볼트 안의 것만 연결할 수 있습니다', { name }));
  return id;
}
function tagsOf(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean))];
  if (out.length > 32 || out.some((tag) => tag.length > 40)) throw new Error(t('태그가 너무 많거나 깁니다'));
  return out;
}

function normHost(vaultId: string, d: HostData): HostData {
  return {
    label: text(d.label, t('별칭'), { max: 120 }),
    address: addressOf(d.address),
    port: portOf(d.port ?? 22),
    username: text(d.username, t('사용자 이름'), { max: 120 }),
    password: secretOf(d.password, 1024),
    keyId: refIn(vaultId, d.keyId, 'key', t('키')),
    identityId: refIn(vaultId, d.identityId, 'identity', t('계정 프리셋')),
    groupId: refIn(vaultId, d.groupId, 'group', t('그룹')),
    tags: tagsOf(d.tags),
    os: text(d.os, 'OS', { max: 30 }),
  };
}
function normIdentity(vaultId: string, d: IdentityData): IdentityData {
  return {
    label: text(d.label, t('프리셋 이름'), { min: 1, max: 120 }),
    username: text(d.username, t('사용자 이름'), { min: 1, max: 120 }),
    password: secretOf(d.password, 1024),
    keyId: refIn(vaultId, d.keyId, 'key', t('키')),
  };
}
const BIND = ['127.0.0.1', '0.0.0.0', '::1', '::'];
function normForward(vaultId: string, d: ForwardData): ForwardData {
  if (!BIND.includes(d.bindAddress)) throw new Error(t('묶을 주소는 127.0.0.1, 0.0.0.0, ::1, :: 중 하나입니다'));
  const hostId = refIn(vaultId, d.hostId, 'host', t('호스트'));
  if (!hostId) throw new Error(t('호스트를 골라 주세요'));
  return {
    label: text(d.label, t('이름'), { max: 120 }),
    hostId,
    bindAddress: d.bindAddress,
    localPort: portOf(d.localPort, t('내 PC 포트')),
    remoteHost: addressOf(d.remoteHost, t('대상 주소')),
    remotePort: portOf(d.remotePort, t('대상 포트')),
  };
}

const hostLabel = (d: HostData) => d.label || d.address;
const forwardLabel = (d: ForwardData) => d.label || `${d.localPort} → ${d.remoteHost}:${d.remotePort}`;

// ---------- 화면에서 쓰는 작업 ----------
type HostPayload = Partial<Record<keyof HostData, unknown>>;

export const vaultApi = {
  // 그룹
  async createGroup(vaultId: string, p: { name: string; parentId: string | null }) {
    const data: GroupData = { name: text(p.name, t('그룹 이름'), { min: 1, max: 80 }), parentId: refIn(vaultId, p.parentId, 'group', t('상위 그룹')) };
    return groupOut(await createItem(vaultId, 'group', data, data.name));
  },
  async updateGroup(id: string, p: { name?: string; parentId?: string | null }) {
    const e = findEntry(id) as Entry<'group'>;
    const parentId = p.parentId === undefined ? e.data.parentId : refIn(e.vaultId, p.parentId, 'group', t('상위 그룹'));
    // 자기 자신이나 자손 밑으로 옮기면 순환이 생긴다
    for (let cursor = parentId; cursor; cursor = entryIn(e.vaultId, cursor, 'group')?.data.parentId ?? null) {
      if (cursor === id) throw new Error(t('그룹을 자기 안으로 옮길 수 없습니다'));
    }
    const data: GroupData = { name: p.name === undefined ? e.data.name : text(p.name, t('그룹 이름'), { min: 1, max: 80 }), parentId };
    return groupOut(await updateItem(e, data, data.name));
  },
  // 안에 있던 호스트·하위 그룹은 지운 그룹의 상위로 올린다
  async deleteGroup(id: string) {
    const e = findEntry(id) as Entry<'group'>;
    for (const h of entriesOf(e.vaultId, 'host')) if (h.data.groupId === id) await updateItem(h, { ...h.data, groupId: e.data.parentId }, hostLabel(h.data));
    for (const g of entriesOf(e.vaultId, 'group')) if (g.data.parentId === id) await updateItem(g, { ...g.data, parentId: e.data.parentId }, g.data.name);
    await deleteItem(e, e.data.name);
  },

  // 호스트
  // id: 새 호스트 창을 열 때 미리 정한 것 (아이콘 색이 id 로 정해진다 — 입력하는 동안·저장한 뒤에도 같은 색)
  async createHost(vaultId: string, p: HostPayload, id?: string) {
    const base: HostData = { label: '', address: '', port: 22, username: '', password: null, keyId: null, identityId: null, groupId: null, tags: [], os: '' };
    const data = normHost(vaultId, merged(base, p));
    return hostOut(await createItem(vaultId, 'host', data, hostLabel(data), id));
  },
  hostOs(id: string) {
    try {
      const e = findEntry(id);
      return e.kind === 'host' ? (e as Entry<'host'>).data.os : '';
    } catch {
      return '';
    }
  },
  // 접속해서 알아낸 OS 를 남긴다. 편집 권한이 없거나 그사이 누가 고쳤으면(409) false — 이 기기에만 기억한다.
  async setHostOs(id: string, os: string) {
    let e: Entry<'host'>;
    try {
      e = findEntry(id) as Entry<'host'>;
    } catch {
      return false;
    }
    if (e.kind !== 'host') return false;
    if (e.data.os === os) return true;
    const v = vaults.get(e.vaultId);
    if (v?.perm !== 'edit' || (v.kind === 'team' && !isOnline())) return false;
    try {
      await updateItem(e, { ...e.data, os }, hostLabel(e.data));
      return true;
    } catch {
      return false;
    }
  },
  async updateHost(id: string, p: HostPayload) {
    const e = findEntry(id) as Entry<'host'>;
    const data = normHost(e.vaultId, merged(e.data, p));
    return hostOut(await updateItem(e, data, hostLabel(data)));
  },
  // 그 호스트를 쓰는 포워딩 규칙도 같이 지운다
  async deleteHost(id: string) {
    const e = findEntry(id) as Entry<'host'>;
    for (const f of entriesOf(e.vaultId, 'forward')) if (f.data.hostId === id) await deleteItem(f, forwardLabel(f.data));
    await deleteItem(e, hostLabel(e.data));
  },
  // 복제: 비밀번호까지 그대로 (같은 볼트 안이라 볼트 키로 다시 암호화된다)
  async duplicateHost(id: string) {
    const e = findEntry(id) as Entry<'host'>;
    const data = { ...e.data, label: t('{label} (복사본)', { label: e.data.label || e.data.address }).slice(0, 120) };
    return hostOut(await createItem(e.vaultId, 'host', data, hostLabel(data)));
  },

  // SSH 키: 앱은 ssh2(메인 프로세스)로, 웹은 브라우저에서 읽고 만든다(웹에서 새로 만들기는 Ed25519 만)
  async createKey(vaultId: string, p: { label: string; generate?: string; privateKey?: string; passphrase?: string | null }) {
    const label = text(p.label, t('키 이름'), { min: 1, max: 120 });
    const passphrase = secretOf(p.passphrase, 1024);
    let privateKey: string;
    let info: { keyType: string; publicKey: string; fingerprint: string };
    if (p.generate) {
      if (desktop) {
        const g = await desktop.ssh.generateKey({ type: p.generate, comment: label, passphrase });
        privateKey = g.privateKey;
        info = g;
      } else {
        if (p.generate !== 'ed25519') throw new Error(t('웹에서는 Ed25519 키만 새로 만들 수 있습니다. RSA·ECDSA는 앱에서 만들어 주세요.'));
        const { generateEd25519 } = await import('./ssh/keys');
        const g = await generateEd25519(label, passphrase);
        privateKey = g.privateKey;
        info = g;
      }
    } else {
      privateKey = secretOf(p.privateKey, 32768) ?? '';
      if (!privateKey) throw new Error(t('개인키를 붙여 넣거나 새로 만들어 주세요'));
      if (desktop) info = await desktop.ssh.inspectKey({ privateKey, passphrase, comment: label });
      else {
        const { parsePrivateKey } = await import('./ssh/keys');
        const parsed = await parsePrivateKey(privateKey, passphrase, label);
        parsed.keyPair.dispose();
        info = parsed;
      }
    }
    const data: KeyData = { label, keyType: info.keyType, publicKey: info.publicKey, fingerprint: info.fingerprint, privateKey, passphrase };
    return keyOut(await createItem(vaultId, 'key', data, label));
  },
  async renameKey(id: string, label: string) {
    const e = findEntry(id) as Entry<'key'>;
    const name = text(label, t('키 이름'), { min: 1, max: 120 });
    return keyOut(await updateItem(e, { ...e.data, label: name }, name));
  },
  async deleteKey(id: string) {
    const e = findEntry(id) as Entry<'key'>;
    await deleteItem(e, e.data.label);
  },

  // 계정 프리셋
  async createIdentity(vaultId: string, p: Partial<Record<keyof IdentityData, unknown>>) {
    const data = normIdentity(vaultId, merged<IdentityData>({ label: '', username: '', password: null, keyId: null }, p));
    return identityOut(await createItem(vaultId, 'identity', data, data.label));
  },
  async updateIdentity(id: string, p: Partial<Record<keyof IdentityData, unknown>>) {
    const e = findEntry(id) as Entry<'identity'>;
    const data = normIdentity(e.vaultId, merged(e.data, p));
    return identityOut(await updateItem(e, data, data.label));
  },
  async deleteIdentity(id: string) {
    const e = findEntry(id) as Entry<'identity'>;
    await deleteItem(e, e.data.label);
  },

  // 스니펫
  async createSnippet(vaultId: string, p: { label: string; script: string }) {
    const data: SnippetData = { label: text(p.label, t('이름'), { min: 1, max: 120 }), script: typeof p.script === 'string' ? p.script.slice(0, 20000) : '' };
    return snippetOut(await createItem(vaultId, 'snippet', data, data.label));
  },
  async updateSnippet(id: string, p: { label?: string; script?: string }) {
    const e = findEntry(id) as Entry<'snippet'>;
    const data: SnippetData = { label: p.label === undefined ? e.data.label : text(p.label, t('이름'), { min: 1, max: 120 }), script: p.script === undefined ? e.data.script : p.script.slice(0, 20000) };
    return snippetOut(await updateItem(e, data, data.label));
  },
  async deleteSnippet(id: string) {
    const e = findEntry(id) as Entry<'snippet'>;
    await deleteItem(e, e.data.label);
  },

  // HTTP 요청 도구 (앱 전용)
  async createRequest(vaultId: string, p: Partial<Record<keyof RequestData, unknown>>) {
    const data = normRequest(p);
    if (!data.label.trim()) throw new Error(t('이름을 입력해 주세요'));
    return requestOut(await createItem(vaultId, 'request', data, data.label));
  },
  async updateRequest(id: string, p: Partial<Record<keyof RequestData, unknown>>) {
    const e = findEntry(id) as Entry<'request'>;
    const data = normRequest({ ...e.data, ...p });
    if (!data.label.trim()) throw new Error(t('이름을 입력해 주세요'));
    return requestOut(await updateItem(e, data, data.label));
  },
  async deleteRequest(id: string) {
    const e = findEntry(id) as Entry<'request'>;
    await deleteItem(e, e.data.label);
  },
  async createHttpEnv(vaultId: string, p: Partial<Record<keyof HttpEnvData, unknown>>) {
    const data = normHttpEnv(p);
    if (!data.name.trim()) throw new Error(t('이름을 입력해 주세요'));
    return httpEnvOut(await createItem(vaultId, 'httpenv', data, data.name));
  },
  async updateHttpEnv(id: string, p: Partial<Record<keyof HttpEnvData, unknown>>) {
    const e = findEntry(id) as Entry<'httpenv'>;
    const data = normHttpEnv({ ...e.data, ...p });
    if (!data.name.trim()) throw new Error(t('이름을 입력해 주세요'));
    return httpEnvOut(await updateItem(e, data, data.name));
  },
  async deleteHttpEnv(id: string) {
    const e = findEntry(id) as Entry<'httpenv'>;
    await deleteItem(e, e.data.name);
  },

  // 포트 포워딩 규칙
  async createForward(vaultId: string, p: Partial<Record<keyof ForwardData, unknown>>) {
    const data = normForward(vaultId, merged<ForwardData>({ label: '', hostId: '', bindAddress: '127.0.0.1', localPort: 0, remoteHost: '', remotePort: 0 }, p));
    return forwardOut(await createItem(vaultId, 'forward', data, forwardLabel(data)));
  },
  async updateForward(id: string, p: Partial<Record<keyof ForwardData, unknown>>) {
    const e = findEntry(id) as Entry<'forward'>;
    const data = normForward(e.vaultId, merged(e.data, p));
    return forwardOut(await updateItem(e, data, forwardLabel(data)));
  },
  async deleteForward(id: string) {
    const e = findEntry(id) as Entry<'forward'>;
    await deleteItem(e, forwardLabel(e.data));
  },

  // 알려진 호스트 (서버 지문)
  async trustHost(vaultId: string, p: { address: string; port: number; keyType: string; fingerprint: string }) {
    const target = trustTarget(vaultId);
    if (target !== vaultId) await ensureLoaded(target);
    const data: KnownHostData = { address: p.address.toLowerCase(), port: p.port, keyType: p.keyType, fingerprint: p.fingerprint, addedBy: me?.id ?? null, addedByName: me?.name ?? '' };
    await createItem(target, 'knownhost', data, `${data.address}:${data.port}`);
  },
  async deleteKnownHost(id: string) {
    const e = findEntry(id) as Entry<'knownhost'>;
    await deleteItem(e, `${e.data.address}:${e.data.port}`);
  },

  // 팀 호스트에 연결해 둔 "내 계정 프리셋" (내 개인 볼트에만 저장 — 나에게만 적용)
  myCredential(hostId: string): { identityId: string; label: string } | null {
    const pv = personalVault();
    if (!pv) return null;
    const link = entriesOf(pv.id, 'hostcred').find((e) => e.data.hostId === hostId);
    const identity = link && entryIn(pv.id, link.data.identityId, 'identity');
    return identity ? { identityId: identity.id, label: identity.data.label } : null;
  },
  async setMyCredential(hostId: string, identityId: string) {
    const pv = personalVault();
    if (!pv) return;
    await ensureLoaded(pv.id);
    const host = findEntry(hostId) as Entry<'host'>;
    const at = { address: host.data.address.toLowerCase(), port: host.data.port };
    const link = entriesOf(pv.id, 'hostcred').find((e) => e.data.hostId === hostId);
    if (link) await updateItem(link, { hostId, identityId, ...at });
    else await createItem(pv.id, 'hostcred', { hostId, identityId, ...at });
  },
  async clearMyCredential(hostId: string) {
    const pv = personalVault();
    if (!pv) return;
    for (const e of entriesOf(pv.id, 'hostcred')) if (e.data.hostId === hostId) await deleteItem(e);
  },
};

// ---------- 접속할 때 쓰는 자격증명 ----------
export type Creds = { username: string; password: string | null; privateKey: string | null; passphrase: string | null };

function keyCreds(vaultId: string, keyId: string | null) {
  const k = entryIn(vaultId, keyId, 'key');
  return { privateKey: k?.data.privateKey ?? null, passphrase: k?.data.passphrase ?? null };
}
export function identityCreds(vaultId: string, identityId: string | null): Creds | null {
  const i = entryIn(vaultId, identityId, 'identity');
  if (!i) return null;
  return { username: i.data.username, password: i.data.password, ...keyCreds(vaultId, i.data.keyId) };
}
function merge(base: Creds, extra: Creds | null): Creds {
  if (!extra) return base;
  return {
    username: base.username || extra.username,
    password: base.password ?? extra.password,
    privateKey: base.privateKey ?? extra.privateKey,
    passphrase: base.privateKey ? base.passphrase : extra.passphrase,
  };
}
export const credsComplete = (c: Creds) => Boolean(c.username && (c.password || c.privateKey));

// 1) 호스트에 저장된 것 → 2) 호스트의 계정 프리셋 → 3) 내가 연결해 둔 개인 프리셋
export async function resolveCreds(hostId: string): Promise<{ creds: Creds; address: string; port: number; label: string; vaultId: string }> {
  const e = findEntry(hostId) as Entry<'host'>;
  const h = e.data;
  let creds = merge({ username: h.username, password: h.password, ...keyCreds(e.vaultId, h.keyId) }, identityCreds(e.vaultId, h.identityId));
  if (!credsComplete(creds)) {
    const pv = personalVault();
    if (pv && (await ensureLoaded(pv.id).catch(() => false))) {
      const link = entriesOf(pv.id, 'hostcred').find((x) => x.data.hostId === hostId);
      if (link) {
        // 연결한 뒤 호스트 주소가 바뀌었으면 내 접속 정보를 보내지 않는다 — 팀 편집자가 공유 호스트를 자기 서버로 돌려
        // 팀원의 개인 비밀번호·키를 받아 가지 못하게 (보안 점검 M-6). 주소를 적어 두지 않은 예전 연결은 지금 주소를 적어 둔다
        const now = { address: h.address.toLowerCase(), port: h.port };
        if (link.data.address !== undefined && (link.data.address !== now.address || link.data.port !== now.port)) {
          throw new Error(
            t('내 접속 정보를 연결한 뒤 이 호스트의 주소가 바뀌었습니다({old} → {new}). 바뀐 주소가 맞으면 호스트 설정에서 내 접속 정보를 다시 연결해 주세요.', {
              old: `${link.data.address}:${link.data.port}`,
              new: `${now.address}:${now.port}`,
            }),
          );
        }
        if (link.data.address === undefined) void updateItem(link, { ...link.data, ...now }).catch(() => {});
        creds = merge(creds, identityCreds(pv.id, link.data.identityId));
      }
    }
  }
  return { creds, address: h.address.toLowerCase(), port: h.port, label: hostLabel(h), vaultId: e.vaultId };
}

export function personalIdentities(): Identity[] {
  const pv = personalVault();
  return pv ? entriesOf(pv.id, 'identity').map(identityOut).sort((a, b) => byLabel(a.label, b.label)) : [];
}
export const personalVaultId = () => personalVault()?.id ?? null;

export function hostById(id: string): Host | null {
  try {
    const e = findEntry(id);
    return e.kind === 'host' ? hostOut(e as Entry<'host'>) : null;
  } catch {
    return null;
  }
}

// ---------- 기록 ----------
// 접속은 서버를 거치지 않으니 앱이 직접 알린다 (대상 이름은 볼트 키로 암호화)
// 오프라인이면 모아 뒀다가 다시 연결되면 올린다(flushAudits). 이 PC 에만 두는 개인 볼트(개인 동기화 끔)·임시 모드는 알리지 않는다.
export async function report(vaultId: string, action: string, label: string, detail: Record<string, unknown> = {}) {
  const v = vaults.get(vaultId);
  if (ephemeral || (v && localOnly(v))) return;
  try {
    const k = vaultKeys.get(vaultId);
    const ref = typeof detail.hostId === 'string' ? detail.hostId : undefined;
    const body = { action, label: k ? await sealLabel(k, vaultId, label, ref) : undefined, detail };
    const queue = () => O.queueAudit({ vaultId, ...body, detail: { ...detail, offlineAt: Date.now() } });
    if (!isOnline()) return void (await queue());
    try {
      await api.post(`/api/vaults/${vaultId}/audit`, body);
    } catch (err) {
      if (isNetworkError(err)) await queue();
    }
  } catch {}
}

// 오프라인일 때 모아 둔 기록을 올린다. 다시 끊기면 남은 것은 도로 넣어 둔다
export async function flushAudits() {
  const items = await O.takeAudits();
  for (let i = 0; i < items.length; i++) {
    const { vaultId, ...body } = items[i];
    try {
      await api.post(`/api/vaults/${vaultId}/audit`, body);
    } catch (err) {
      if (isNetworkError(err)) return O.putBackAudits(items.slice(i));
      // 그사이 볼 수 없게 된 볼트 등: 버린다
    }
  }
}

// ref: 그 기록의 항목·호스트 id (detail.id 또는 detail.hostId). 예전(~0.3.2)에 봉한 이름은 볼트에만 묶여 있어 그쪽으로도 풀어 본다
export async function openLabel(vaultId: string, sealed: string | null, ref?: string | null): Promise<string | null> {
  if (!sealed) return null;
  const k = vaultKeys.get(vaultId);
  if (!k) return null;
  for (const aad of ref ? [E.labelAad(vaultId, ref), E.labelAad(vaultId)] : [E.labelAad(vaultId)]) {
    try {
      return await E.openText(k.key, sealed, aad);
    } catch {}
  }
  return null;
}

// ---------- 볼트 키 공유 ----------
const peerKey = (userId: string) => `terminas.peer.${userId}`;

// 이 기기에서 전에 본 그 사람의 공개키와 다르면 알려 준다(암호화를 다시 설정했거나 바꿔치기)
export function peerKeyChanged(userId: string, publicKey: string) {
  try {
    const saved = localStorage.getItem(peerKey(userId));
    return Boolean(saved && saved !== publicKey);
  } catch {
    return false;
  }
}

function rememberPeer(userId: string, publicKey: string) {
  try {
    localStorage.setItem(peerKey(userId), publicKey);
  } catch {}
}
// 이 기기에서 전에 본(공유했거나 공유받은) 사람인지 — 공유 창에서 처음 보는 사람은 기본으로 고르지 않는다
export function peerKnown(userId: string, publicKey: string) {
  try {
    return localStorage.getItem(peerKey(userId)) === publicKey;
  } catch {
    return false;
  }
}

export async function shareVaultKeys(list: PendingShare[]) {
  const a = account;
  if (!a) throw new Error(t('잠겨 있습니다. 암호화 비밀번호로 잠금을 풀어 주세요.'));
  const grants = [];
  for (const p of list) {
    const v = vaults.get(p.vaultId);
    const k = v && (await vaultKey(v));
    if (!k) continue;
    // 내 계정 키로 봉한다 — 받는 사람의 앱이 "내가 공유한 것"임을 확인한다 (보안 점검 H-2)
    grants.push({ vaultId: p.vaultId, userId: p.userId, wrapped: await E.wrapVaultKey(k.raw, p.publicKey, p.vaultId, p.userId, a) });
  }
  if (!grants.length) return 0;
  const res = await api.post<{ added: number }>('/api/vault-keys', { grants });
  for (const p of list) rememberPeer(p.userId, p.publicKey);
  return res.added;
}

// 호스트 편집 화면: 저장된 비밀번호를 계정 프리셋으로 옮길 때만 쓴다 (화면에 보여 주지 않는다)
export function hostPassword(id: string): string | null {
  try {
    const e = findEntry(id);
    return e.kind === 'host' ? (e as Entry<'host'>).data.password : null;
  } catch {
    return null;
  }
}
