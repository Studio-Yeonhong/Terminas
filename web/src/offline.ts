// 오프라인 사용 (앱 전용). 서버에 닿지 않을 때도 볼트를 열 수 있게, 서버에서 받은 것을 이 PC 에 둔다(desktop.cache).
// 두는 것은 서버가 주던 그대로의 암호문(볼트 키로 암호화된 항목·봉한 볼트 키·잠긴 키 묶음)이고, 앱 본체가 그 위를
// OS 보호 저장소(Windows DPAPI 등)로 한 번 더 감싼다. 로그아웃하면 이 서버의 사본을 모두 지운다.
// - 개인 볼트: 늘 둔다. 오프라인에서 고친 것은 "올릴 것"으로 적어 두었다가 다시 연결되면 올린다(vault.ts syncVault).
// - 팀 볼트: 마지막으로 서버와 맞춘 때부터 7일(고정)만. 그 기간이 지나면 지운다. 오프라인에서는 보기만.
// - 개인 동기화 끄기: 개인 볼트를 이 PC 에만 둔다(서버에 올리지도 받지도 않고, 개인 볼트의 접속 기록도 보내지 않는다).
import type { Me, Vault } from './api';
import { desktop } from './desktop';

const store = desktop?.cache;
let available: boolean | null = null;

// 이 PC 에 사본을 둘 수 있는지 (앱이고, OS 보호 저장소를 쓸 수 있을 때)
export async function offlineAvailable() {
  if (available === null) available = store ? await store.available().catch(() => false) : false;
  return available;
}
export const offlineReady = () => available === true;

const DAY = 24 * 60 * 60 * 1000;
// 팀 볼트 사본을 쓸 수 있는 기간 (7일 고정 — 팀마다 바꾸지 않는다)
export const TEAM_OFFLINE_DAYS = 7;
// 시계를 이만큼 넘게 되돌리면(팀 사본 기한을 늘리려는 것일 수 있다) 팀 사본을 쓰지 않는다
const CLOCK_SLACK = 10 * 60 * 1000;

export type Kind = 'group' | 'host' | 'key' | 'identity' | 'snippet' | 'forward' | 'knownhost' | 'hostcred' | 'request' | 'httpenv';
export type RawItem = { id: string; kind: Kind; data: string; createdBy: string | null; updatedBy: string | null; createdAt: number; updatedAt: number };
// 이 PC 에서 고쳤고 아직 서버에 올리지 않은 것. base = 마지막으로 서버에서 받은 그 항목의 updatedAt (새로 만든 것은 null)
export type Dirty = { op: 'create' | 'update' | 'delete'; base: number | null; label?: string; at: number };
export type VaultSnap = { v: 1; userId: string; vaultId: string; syncedAt: number; rows: RawItem[]; dirty: Record<string, Dirty> };
export type QueuedAudit = { vaultId: string; action: string; label?: string; detail: Record<string, unknown> };

type State = { v: 1; userId: string; personalSync: boolean; lastSeen: number; lastSync: number };
type MeSnap = { v: 1; userId: string; savedAt: number; me: Me };
type AuditSnap = { v: 1; userId: string; items: QueuedAudit[] };

async function read<T extends { v: number; userId: string }>(name: string): Promise<T | null> {
  if (!(await offlineAvailable())) return null;
  const text = await store!.get(name).catch(() => null);
  if (!text) return null;
  try {
    const value = JSON.parse(text) as T;
    return value?.v === 1 ? value : null;
  } catch {
    return null;
  }
}
async function write(name: string, value: unknown) {
  if (!(await offlineAvailable())) return false;
  return store!.put(name, JSON.stringify(value)).catch(() => false);
}

// ---------- 누구의 사본인지 · 설정 ----------
let state: State | null = null;
let audits: QueuedAudit[] = [];

const saveState = () => (state ? write('state', state) : Promise.resolve(false));

async function loadAudits(userId: string) {
  const snap = await read<AuditSnap>('audit');
  audits = snap && snap.userId === userId ? snap.items : [];
}

// 서버에서 로그인한 사람을 받으면 부른다. 이 서버에서 전에 다른 사람이 쓰던 사본이면 모두 지우고 새로 시작한다.
export async function bindUser(userId: string) {
  if (!(await offlineAvailable())) return;
  const saved = await read<State>('state');
  if (saved && saved.userId !== userId) {
    await store!.clear().catch(() => {});
    state = null;
  } else state = saved;
  if (!state) {
    state = { v: 1, userId, personalSync: true, lastSeen: Date.now(), lastSync: 0 };
    await saveState();
  }
  await loadAudits(userId);
}

export const personalSync = () => state?.personalSync !== false;
export async function setPersonalSync(on: boolean) {
  if (!state) return;
  state.personalSync = on;
  await saveState();
}
export const lastSync = () => state?.lastSync ?? 0;
export async function markSynced() {
  if (!state) return;
  state.lastSync = Date.now();
  state.lastSeen = Math.max(state.lastSeen, state.lastSync);
  await saveState();
}
const clockRolledBack = () => Boolean(state && Date.now() < state.lastSeen - CLOCK_SLACK);

// ---------- 계정 정보 (/api/me) ----------
export async function saveMe(me: Me) {
  if (!state || state.userId !== me.user.id) return;
  state.lastSeen = Math.max(state.lastSeen, Date.now());
  await write('me', { v: 1, userId: me.user.id, savedAt: Date.now(), me } satisfies MeSnap);
}

// 오프라인으로 켤 때: 이 PC 에 둔 계정 정보 (없거나 다른 사람 것이면 null)
export async function loadMe(): Promise<Me | null> {
  const [snap, saved] = await Promise.all([read<MeSnap>('me'), read<State>('state')]);
  if (!snap || !saved || snap.userId !== saved.userId || snap.me?.user?.id !== snap.userId) return null;
  state = saved;
  await loadAudits(saved.userId);
  return snap.me;
}

// ---------- 팀 볼트 사본의 기한 ----------
// 팀 볼트 사본을 언제까지 쓸 수 있는지 (개인 볼트는 null = 기한 없음)
export function copyExpiresAt(v: Pick<Vault, 'kind'>, syncedAt: number) {
  return v.kind === 'personal' ? null : syncedAt + TEAM_OFFLINE_DAYS * DAY;
}
export function copyUsable(v: Pick<Vault, 'kind'>, syncedAt: number) {
  if (v.kind === 'personal') return true;
  if (clockRolledBack()) return false;
  return Date.now() <= copyExpiresAt(v, syncedAt)!;
}

// ---------- 볼트 사본 ----------
const vaultName = (vaultId: string) => `vault.${vaultId}`;
// 사본마다 마지막으로 서버와 맞춘 때 (기한을 볼 때 파일을 다시 읽지 않으려고)
const snapTimes = new Map<string, number>();
export const snapSyncedAt = (vaultId: string) => snapTimes.get(vaultId);

export async function loadVaultSnap(vaultId: string): Promise<VaultSnap | null> {
  const snap = await read<VaultSnap>(vaultName(vaultId));
  const ok = snap && state && snap.userId === state.userId && snap.vaultId === vaultId && Array.isArray(snap.rows);
  if (!ok) return null;
  snapTimes.set(vaultId, snap.syncedAt);
  return { ...snap, dirty: snap.dirty ?? {} };
}
export async function saveVaultSnap(vaultId: string, syncedAt: number, rows: RawItem[], dirty: Record<string, Dirty>) {
  if (!state) return false;
  state.lastSeen = Math.max(state.lastSeen, Date.now());
  snapTimes.set(vaultId, syncedAt);
  return write(vaultName(vaultId), { v: 1, userId: state.userId, vaultId, syncedAt, rows, dirty } satisfies VaultSnap);
}
export async function dropVaultSnap(vaultId: string) {
  snapTimes.delete(vaultId);
  if (!(await offlineAvailable())) return;
  await store!.remove(vaultName(vaultId)).catch(() => {});
}
async function snapIds() {
  if (!(await offlineAvailable())) return [];
  const names = await store!.list().catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('vault.')).map((n) => n.slice(6));
}

// 오프라인으로 켤 때 보일 볼트: 개인 볼트 + 기한 안의 사본이 있는 팀 볼트 (기한이 지난 사본은 여기서 지운다)
export async function offlineVaults(me: Me): Promise<Vault[]> {
  const out: Vault[] = [];
  for (const v of me.vaults) {
    if (v.kind === 'personal') {
      out.push(v);
      continue;
    }
    const snap = await loadVaultSnap(v.id);
    if (snap && copyUsable(v, snap.syncedAt)) out.push(v);
    else if (snap) await dropVaultSnap(v.id);
  }
  return out;
}

// 서버에서 새 볼트 목록을 받았을 때: 더는 볼 수 없는 볼트(팀·볼트에서 빠짐)의 사본을 지운다
export async function pruneSnaps(me: Me) {
  for (const id of await snapIds()) if (!me.vaults.some((x) => x.id === id)) await dropVaultSnap(id);
}

// 로그인이 끝났을 때(401/403 — 팀에서 빠졌거나 계정이 막혔을 수 있다): 팀 볼트 사본을 모두 지운다.
// 개인 볼트 사본은 남긴다(내 것이고, 올리지 못한 변경이 있을 수 있다). 계정 정보 사본에서도 팀을 뺀다.
export async function dropTeamSnaps() {
  if (!(await offlineAvailable())) return;
  const snap = await read<MeSnap>('me');
  if (!snap) return;
  const personal = new Set(snap.me.vaults.filter((v) => v.kind === 'personal').map((v) => v.id));
  for (const id of await snapIds()) if (!personal.has(id)) await dropVaultSnap(id);
  await write('me', { ...snap, me: { ...snap.me, teams: [], vaults: snap.me.vaults.filter((v) => v.kind === 'personal') } } satisfies MeSnap);
}

// ---------- 오프라인일 때 한 접속 기록 (다시 연결되면 올린다) ----------
const AUDIT_MAX = 2000;
export async function queueAudit(item: QueuedAudit) {
  if (!state) return;
  audits = [...audits, item].slice(-AUDIT_MAX);
  await write('audit', { v: 1, userId: state.userId, items: audits } satisfies AuditSnap);
}
export async function takeAudits() {
  const out = audits;
  audits = [];
  if (state && out.length) await write('audit', { v: 1, userId: state.userId, items: [] } satisfies AuditSnap);
  return out;
}
export async function putBackAudits(items: QueuedAudit[]) {
  if (!state || !items.length) return;
  audits = [...items, ...audits].slice(-AUDIT_MAX);
  await write('audit', { v: 1, userId: state.userId, items: audits } satisfies AuditSnap);
}
export const queuedAudits = () => audits.length;

// ---------- 로그아웃 전에: 이 PC 에만 있는 것 ----------
export async function unsyncedSummary(): Promise<{ changes: number; localOnly: boolean }> {
  if (!(await offlineAvailable())) return { changes: 0, localOnly: false };
  const saved = state ?? (await read<State>('state'));
  if (!saved) return { changes: 0, localOnly: false };
  let changes = 0;
  for (const id of await snapIds()) {
    const snap = await read<VaultSnap>(vaultName(id));
    if (snap && snap.userId === saved.userId) changes += Object.keys(snap.dirty ?? {}).length;
  }
  return { changes, localOnly: saved.personalSync === false };
}

// 이 서버의 사본을 모두 지운다 (로그아웃은 앱 본체가 알아서 지운다)
export async function clearAll() {
  if (!(await offlineAvailable())) return;
  const userId = state?.userId;
  await store!.clear().catch(() => {});
  audits = [];
  snapTimes.clear();
  state = userId ? { v: 1, userId, personalSync: true, lastSeen: Date.now(), lastSync: 0 } : null;
  await saveState();
}
