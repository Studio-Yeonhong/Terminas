// 자동 잠금: 한동안 아무 입력이 없으면 잠근다(볼트 키를 메모리에서 지우고 암호화 비밀번호를 다시 묻는다).
// 기기마다 따로 정한다. 기본은 웹 15분, 앱은 끔(앱은 "이 PC 에서 기억" 이 있으므로).
import { desktop } from './desktop';

const KEY = 'terminas.autolock';
const FLAG = 'terminas.autolocked';
export const AUTOLOCK_CHOICES = [0, 5, 10, 15, 30, 60, 240];

export function autoLockMinutes(): number {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null && AUTOLOCK_CHOICES.includes(Number(v))) return Number(v);
  } catch {}
  return desktop ? 0 : 15;
}

export function setAutoLockMinutes(minutes: number) {
  try {
    localStorage.setItem(KEY, String(minutes));
  } catch {}
}

// 잠금 화면에 "자동으로 잠겼습니다" 를 한 번 보여 주려고 남긴다
export function markAutoLocked() {
  try {
    sessionStorage.setItem(FLAG, '1');
  } catch {}
}
export function takeAutoLocked() {
  try {
    const v = sessionStorage.getItem(FLAG) === '1';
    sessionStorage.removeItem(FLAG);
    return v;
  } catch {
    return false;
  }
}

// 입력이 멈춘 뒤 minutes 분이 지나면 onIdle. 창을 다시 볼 때(절전 뒤 등)도 바로 확인한다.
export function watchIdle(getMinutes: () => number, onIdle: () => void) {
  let last = Date.now();
  let fired = false;
  const touch = () => {
    last = Date.now();
  };
  const check = () => {
    const minutes = getMinutes();
    if (!minutes || fired) return;
    if (Date.now() - last >= minutes * 60_000) {
      fired = true;
      onIdle();
    }
  };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
  for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });
  const onVisible = () => document.visibilityState === 'visible' && check();
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(check, 15_000);
  return () => {
    for (const e of events) window.removeEventListener(e, touch, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}

// 잠그기·로그아웃처럼 일부러 페이지를 떠날 때는 "나가시겠습니까?" 를 띄우지 않는다
let leaving = false;
export const allowLeave = () => {
  leaving = true;
};
export const isLeaving = () => leaving;
