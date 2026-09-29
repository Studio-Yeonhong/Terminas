import { run, now } from './db.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const forbidden = (message = '권한이 없습니다') => new HttpError(403, 'forbidden', message);
export const notFound = (message = '찾을 수 없습니다') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

type Body = Record<string, unknown>;

export function body(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('JSON 객체가 필요합니다');
  return value as Body;
}

export function str(b: Body, key: string, opts: { max?: number; min?: number; optional?: boolean } = {}): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (opts.optional) return undefined;
    throw badRequest(`${key} 값이 필요합니다`);
  }
  if (typeof v !== 'string') throw badRequest(`${key}은(는) 문자열이어야 합니다`);
  const t = v.trim();
  if (opts.min !== undefined && t.length < opts.min) throw badRequest(`${key} 값이 비었습니다`);
  if (t.length > (opts.max ?? 255)) throw badRequest(`${key} 값이 너무 깁니다`);
  return t;
}

// 비밀값: undefined = 그대로, null/'' = 지우기, 문자열 = 바꾸기 (앞뒤 공백을 자르지 않는다)
export function secret(b: Body, key: string, max = 16384): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${key}은(는) 문자열이어야 합니다`);
  if (v.length > max) throw badRequest(`${key} 값이 너무 깁니다`);
  return v;
}

export function nullableId(b: Body, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 64) throw badRequest(`${key} 값이 올바르지 않습니다`);
  return v;
}

export function port(b: Body, key: string): number | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw badRequest('포트는 1~65535 사이여야 합니다');
  return n;
}

export function tags(b: Body, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 32) throw badRequest('태그 형식이 올바르지 않습니다');
  const out = [...new Set(v.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean))];
  if (out.some((t) => t.length > 40)) throw badRequest('태그가 너무 깁니다');
  return out;
}

export function audit(entry: {
  userId?: string | null;
  teamId?: string | null;
  vaultId?: string | null;
  action: string;
  target?: string;
  // 볼트 키로 암호화된 대상 이름(호스트 별칭 등) — 서버는 못 읽고 화면에서 푼다
  targetEnc?: string | null;
  detail?: Record<string, unknown>;
  ip?: string;
}) {
  run(
    'INSERT INTO audit_log (ts, user_id, team_id, vault_id, action, target, target_enc, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    now(),
    entry.userId ?? null,
    entry.teamId ?? null,
    entry.vaultId ?? null,
    entry.action,
    entry.target ?? '',
    entry.targetEnc ?? null,
    JSON.stringify(entry.detail ?? {}),
    entry.ip ?? '',
  );
}
