// 서버와 닿는지 (앱 전용 오프라인 사용). api.ts 가 요청마다 알려 주고, 화면(store)은 끊기면 다시 붙어 보는 일을 돌린다.
// 다른 모듈을 가져오지 않는다 — api.ts·offline.ts·vault.ts 가 모두 이것을 쓴다.

let online = true;
const listeners = new Set<() => void>();
const wakers = new Set<() => void>();

export const isOnline = () => online;

export function setOnline(value: boolean) {
  if (online === value) return;
  online = value;
  for (const fn of listeners) fn();
}

export function onNetChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// 끊긴 동안 어떤 요청이 성공하면 기다리지 말고 곧바로 다시 붙어 본다
export function wakeReconnect() {
  for (const fn of wakers) fn();
}
export function onWake(fn: () => void) {
  wakers.add(fn);
  return () => void wakers.delete(fn);
}

// 서버를 쓸 수 없는 것: 앱 본체가 연결 자체를 못 했거나(0), 서버 앞의 게이트웨이(Cloudflare 등)가 서버를 못 찾았거나,
// 서버가 이 앱이 너무 오래됐다고 받지 않을 때(426 — 이때도 이 PC 의 사본으로 이어 가고, 업데이트하면 다시 붙는다)
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
export const unreachableStatus = (status: number) => status === 0 || status === 426 || GATEWAY.has(status);

// 서버가 이 앱을 받지 않는다(426) — 화면이 "앱을 업데이트해 주세요"를 띄운다
const outdatedListeners = new Set<() => void>();
export function markAppOutdated() {
  for (const fn of outdatedListeners) fn();
}
export function onAppOutdated(fn: () => void) {
  outdatedListeners.add(fn);
  return () => void outdatedListeners.delete(fn);
}
