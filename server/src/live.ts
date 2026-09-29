// 로그인 세션에 묶여 오래 열려 있는 연결(웹 SSH 중계).
// 로그아웃·키 초기화처럼 세션이 끝나는 곳에서 함께 닫는다 (보안 검토 F-05).
// 다른 모듈을 가져오지 않는다 — auth 와 relay 가 서로를 부르지 않게 하는 칸막이.
export type Live = { sessionHash: string; userId: string; close: (code: number, reason: string) => void };

const live = new Set<Live>();

export function trackLive(entry: Live) {
  live.add(entry);
  return () => void live.delete(entry);
}

export function endLive(match: (entry: Live) => boolean, reason = 'session ended') {
  for (const entry of [...live]) if (match(entry)) entry.close(4401, reason);
}
