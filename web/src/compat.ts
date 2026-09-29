// 앱과 서버가 서로 맞는지. 앱은 화면을 안에 들고 있어서, 직접 운영하는 서버가 앱보다 오래됐거나 새로우면 기능이 어긋날 수 있다.
// 서버: GET /api/auth/config 의 api(서버 API 수준) · minAppApi(받아 주는 가장 낮은 앱 수준) — server/src/auth.ts 의 API_LEVEL·MIN_APP_LEVEL
import type { AuthConfig } from './api';

// 이 화면(앱)의 수준. 서버에 새로 생긴 API 를 화면이 쓰기 시작하면 NEEDS_SERVER_API 를 올린다.
export const APP_API = 1;
export const NEEDS_SERVER_API = 1;

export type Compat = 'ok' | 'server_old' | 'app_old';

export function compatWith(cfg: AuthConfig): Compat {
  if ((cfg.api ?? 0) < NEEDS_SERVER_API) return 'server_old';
  if ((cfg.minAppApi ?? 0) > APP_API) return 'app_old';
  return 'ok';
}
