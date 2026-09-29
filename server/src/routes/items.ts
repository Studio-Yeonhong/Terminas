// 볼트 항목: 서버는 암호문(data)과 종류·볼트·시각만 다룬다. 내용 검사(주소 형식 등)는 앱·웹이 한다.
// 암호문에는 "어느 항목·어느 볼트·어떤 종류"가 묶여 있어(AAD) 서버가 다른 곳에 옮겨 붙이면 풀리지 않는다.
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import { all, get, now, run, tx } from '../db.ts';
import { isTeamManager, requireVault, teamRole, vaultAccess, type User, type VaultRow } from '../access.ts';
import { audit, badRequest, body, conflict, HttpError, notFound } from '../http.ts';
import { Throttle } from '../password.ts';

// request·httpenv: HTTP 요청 도구(앱 전용)의 저장한 요청·환경 변수. 서버는 다른 항목처럼 암호문만 보관하고,
// HTTP 요청을 대신 보내는 기능은 서버에 없다 (요청은 사용자 PC 의 앱에서만 나간다).
const KINDS = new Set(['group', 'host', 'key', 'identity', 'snippet', 'forward', 'knownhost', 'hostcred', 'request', 'httpenv']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEALED = /^v1\.[A-Za-z0-9+/]+=*$/;
const MAX_DATA = 64 * 1024;
// 볼트 하나에 둘 수 있는 항목 수 (누구나 가입하는 서버의 남용 막기)
const MAX_ITEMS = 5000;
// 저장 용량: 볼트 하나 16MB, 팀 전체 64MB (항목 목록을 한 번에 읽어도 서버 메모리가 버티게 — 보안 점검 M-4)
const MAX_VAULT_MB = 16;
const MAX_TEAM_MB = 64;
// 쓰기·기록 속도: 사람마다 10분에 저장 3000번, 앱이 알리는 접속 기록 1200개 (넘은 기록은 조용히 버린다)
const writeThrottle = new Throttle(3000, 10 * 60 * 1000);
const auditThrottle = new Throttle(1200, 10 * 60 * 1000);

function checkWriteRate(user: User) {
  if (writeThrottle.blocked(user.id)) throw new HttpError(429, 'too_many', '저장 요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.');
  writeThrottle.fail(user.id);
}

// 이 볼트(와 팀)에 bytes 만큼 더 저장해도 되는지 (고칠 때는 old 만큼 빠진다)
function checkRoom(vault: VaultRow, bytes: number, old = 0) {
  const used = get<{ n: number }>('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM items WHERE vault_id = ?', vault.id)!.n;
  if (used - old + bytes > MAX_VAULT_MB * 1024 * 1024) throw badRequest(`볼트 하나에 저장할 수 있는 용량(${MAX_VAULT_MB}MB)을 넘었습니다`);
  if (!vault.team_id) return;
  const team = get<{ n: number }>('SELECT COALESCE(SUM(LENGTH(i.data)), 0) AS n FROM items i JOIN vaults v ON v.id = i.vault_id WHERE v.team_id = ?', vault.team_id)!.n;
  if (team - old + bytes > MAX_TEAM_MB * 1024 * 1024) throw badRequest(`팀 하나에 저장할 수 있는 용량(${MAX_TEAM_MB}MB)을 넘었습니다`);
}

type ItemRow = { id: string; vault_id: string; kind: string; data: string; created_by: string | null; updated_by: string | null; created_at: number; updated_at: number };

const itemOut = (r: ItemRow) => ({ id: r.id, kind: r.kind, data: r.data, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });

function sealed(value: unknown, name: string, max = MAX_DATA): string {
  if (typeof value !== 'string' || value.length > max || !SEALED.test(value)) throw badRequest(`${name} 는 암호화된 값이어야 합니다`);
  return value;
}

// 기록에 남길 대상 이름: 볼트 키로 암호화한 것만 받는다
function auditLabel(b: Record<string, unknown>): string | null {
  return b.label === undefined || b.label === null ? null : sealed(b.label, 'label', 2048);
}

const ACTION: Record<string, string> = {
  group: 'group',
  host: 'host',
  key: 'key',
  identity: 'identity',
  snippet: 'snippet',
  forward: 'forward',
  knownhost: 'knownhost',
  hostcred: 'hostcred',
  request: 'request',
  httpenv: 'httpenv',
};

function loadItem(user: User, id: string, need: 'edit' | 'view'): { row: ItemRow; vault: VaultRow } {
  const row = get<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  if (!row) throw notFound();
  const vault = requireVault(user, row.vault_id, need);
  return { row, vault };
}

// 앱이 스스로 알리는 접속 기록 (서버는 접속에 끼지 않으므로 앱의 보고로만 안다)
// http_request: 앱이 HTTP 요청을 보낼 때마다. 대상(메서드·주소)은 볼트 키로 암호화된 이름으로만 받는다
const CLIENT_ACTIONS = new Set(['ssh_connect', 'ssh_disconnect', 'ssh_error', 'sftp_connect', 'sftp_disconnect', 'forward_start', 'forward_stop', 'hostkey_mismatch', 'http_request']);
const HTTP_FAIL = new Set(['timeout', 'dns', 'refused', 'reset', 'tls', 'cancelled', 'error']);
const OFFLINE_AUDIT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function itemRoutes(app: FastifyInstance) {
  app.get('/api/vaults/:vaultId/items', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    requireVault(user, vaultId, 'view');
    return all<ItemRow>('SELECT * FROM items WHERE vault_id = ? ORDER BY created_at', vaultId).map(itemOut);
  });

  app.post('/api/vaults/:vaultId/items', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const b = body(req.body);
    const kind = String(b.kind ?? '');
    if (!KINDS.has(kind)) throw badRequest('항목 종류가 올바르지 않습니다');
    // 서버 지문(알려진 호스트)도 편집 권한이 있어야 쓴다. 보기 권한인 사람이 공용 볼트에 지문을 넣으면
    // 다른 사람의 접속 신뢰를 미리 차지할 수 있다(보안 검토 F-01). 보기 권한인 사람의 확인은 자기 개인 볼트에 남긴다.
    const vault = requireVault(user, vaultId, 'edit');
    if (kind === 'hostcred' && vault.kind !== 'personal') throw badRequest('내 접속 정보 연결은 개인 볼트에만 둡니다');
    if (get<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE vault_id = ?', vaultId)!.n >= MAX_ITEMS) throw badRequest(`볼트 하나에 항목은 ${MAX_ITEMS}개까지 둘 수 있습니다`);
    const id = String(b.id ?? '');
    if (!UUID.test(id)) throw badRequest('id가 올바르지 않습니다');
    const data = sealed(b.data, 'data');
    if (get('SELECT 1 AS x FROM items WHERE id = ?', id)) throw conflict('같은 id의 항목이 이미 있습니다');
    checkWriteRate(user);
    checkRoom(vault, data.length);
    run(
      'INSERT INTO items (id, vault_id, kind, data, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      vaultId,
      kind,
      data,
      user.id,
      user.id,
      now(),
      now(),
    );
    audit({ userId: user.id, teamId: vault.team_id, vaultId, action: kind === 'knownhost' ? 'hostkey_trust' : `${ACTION[kind]}_create`, targetEnc: auditLabel(b), detail: { id }, ip: req.ip });
    return itemOut(get<ItemRow>('SELECT * FROM items WHERE id = ?', id)!);
  });

  app.patch('/api/items/:id', async (req) => {
    const user = requireUser(req);
    const { row, vault } = loadItem(user, (req.params as { id: string }).id, 'edit');
    const b = body(req.body);
    const data = sealed(b.data, 'data');
    // 다른 사람이 먼저 고쳤으면 덮어쓰지 않는다
    if (b.baseUpdatedAt !== undefined && Number(b.baseUpdatedAt) !== row.updated_at) throw conflict('다른 사람이 먼저 수정했습니다. 새로 불러온 뒤 다시 시도해 주세요.');
    checkWriteRate(user);
    checkRoom(vault, data.length, row.data.length);
    run('UPDATE items SET data = ?, updated_by = ?, updated_at = ? WHERE id = ?', data, user.id, Math.max(now(), row.updated_at + 1), row.id);
    audit({ userId: user.id, teamId: vault.team_id, vaultId: vault.id, action: `${ACTION[row.kind] ?? row.kind}_update`, targetEnc: auditLabel(b), detail: { id: row.id }, ip: req.ip });
    return itemOut(get<ItemRow>('SELECT * FROM items WHERE id = ?', row.id)!);
  });

  app.delete('/api/items/:id', async (req) => {
    const user = requireUser(req);
    const { row, vault } = loadItem(user, (req.params as { id: string }).id, 'edit');
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    // 오프라인에서 지운 것을 나중에 올릴 때: 그사이 다른 곳에서 고쳤으면 지우지 않는다 (고친 쪽을 살린다)
    if (b.baseUpdatedAt !== undefined && Number(b.baseUpdatedAt) !== row.updated_at) throw conflict('다른 곳에서 먼저 수정한 항목이라 지우지 않았습니다.');
    run('DELETE FROM items WHERE id = ?', row.id);
    audit({ userId: user.id, teamId: vault.team_id, vaultId: vault.id, action: row.kind === 'knownhost' ? 'knownhost_delete' : `${ACTION[row.kind] ?? row.kind}_delete`, targetEnc: auditLabel(b), detail: { id: row.id }, ip: req.ip });
    return { ok: true };
  });

  // 개인 볼트의 서버 사본 비우기: 앱에서 개인 동기화를 끄면서 "서버에서 지우기"를 고른 때. 이 PC 의 사본은 앱이 들고 있다.
  // 개인 볼트만 (팀 볼트는 팀이 함께 쓰는 것이라 한 번에 비우지 않는다)
  app.delete('/api/vaults/:vaultId/items', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const vault = requireVault(user, vaultId, 'edit');
    if (vault.kind !== 'personal') throw badRequest('개인 볼트만 한 번에 비울 수 있습니다');
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    if (b.confirm !== 'CLEAR') throw badRequest('확인 값이 없습니다');
    const deleted = run('DELETE FROM items WHERE vault_id = ?', vaultId).changes;
    audit({ userId: user.id, teamId: null, vaultId, action: 'vault_clear', detail: { items: deleted }, ip: req.ip });
    return { deleted };
  });

  app.post('/api/vaults/:vaultId/audit', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const vault = requireVault(user, vaultId, 'view');
    const b = body(req.body);
    const action = String(b.action ?? '');
    if (!CLIENT_ACTIONS.has(action)) throw badRequest('기록 종류가 올바르지 않습니다');
    // 기록을 끝없이 쌓지 못하게: 넘으면 받은 것으로 하고 버린다 (앱은 기록 실패를 사용자에게 보이지 않는다)
    if (auditThrottle.blocked(user.id)) return { ok: true, dropped: true };
    auditThrottle.fail(user.id);
    const d = (b.detail && typeof b.detail === 'object' ? b.detail : {}) as Record<string, unknown>;
    const detail: Record<string, unknown> = {};
    if (typeof d.hostId === 'string' && UUID.test(d.hostId)) detail.hostId = d.hostId;
    if (typeof d.seconds === 'number' && Number.isFinite(d.seconds)) detail.seconds = Math.max(0, Math.round(d.seconds));
    if (typeof d.reason === 'string') detail.reason = d.reason.slice(0, 160);
    if (typeof d.via === 'string') detail.via = d.via.slice(0, 20);
    // HTTP 요청: 응답 코드·걸린 시간·실패 종류만 (주소·헤더·본문은 받지 않는다)
    if (typeof d.status === 'number' && Number.isInteger(d.status) && d.status >= 0 && d.status < 1000) detail.status = d.status;
    if (typeof d.ms === 'number' && Number.isFinite(d.ms)) detail.ms = Math.max(0, Math.round(d.ms));
    if (typeof d.fail === 'string' && HTTP_FAIL.has(d.fail)) detail.fail = d.fail;
    // 오프라인일 때 한 일: 앱이 모아 뒀다가 다시 연결되면 올린다. 실제로 한 때(앱 시계)를 따로 남긴다 — 최근 30일 안만
    if (typeof d.offlineAt === 'number' && Number.isFinite(d.offlineAt)) {
      const at = Math.round(d.offlineAt);
      if (at <= now() + 60_000 && at >= now() - OFFLINE_AUDIT_MAX_AGE) detail.offlineAt = at;
    }
    audit({ userId: user.id, teamId: vault.team_id, vaultId, action, targetEnc: auditLabel(b), detail, ip: req.ip });
    return { ok: true };
  });

  // ---------- 기록 ----------
  // 편집 권한이면 볼트 전체 기록(팀 볼트면 팀 관리 기록 포함), 보기 권한이면 내 기록만
  app.get('/api/vaults/:vaultId/logs', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const access = vaultAccess(user, vaultId);
    if (!access) throw notFound('볼트를 찾을 수 없습니다');
    const before = Number((req.query as { before?: string }).before) || Number.MAX_SAFE_INTEGER;
    // 팀 관리 기록(초대·팀원·역할 — 팀원 IP·초대한 이메일이 담긴다)은 팀 관리자에게만. 볼트 편집자는 그 볼트의 기록만
    const manager = access.vault.kind === 'team' && isTeamManager(teamRole(user.id, access.vault.team_id!));
    const where =
      access.perm === 'edit'
        ? access.vault.kind === 'team'
          ? manager
            ? '(a.vault_id = ? OR (a.vault_id IS NULL AND a.team_id = ?))'
            : '(a.vault_id = ? AND ? IS NOT NULL)'
          : '(a.vault_id = ? OR (a.vault_id IS NULL AND a.team_id IS NULL AND a.user_id = ?))'
        : '(a.vault_id = ? AND a.user_id = ?)';
    const second = access.perm === 'edit' && access.vault.kind === 'team' ? access.vault.team_id : user.id;
    return all<{ id: number; ts: number; action: string; target: string; targetEnc: string | null; detail: string; ip: string; userName: string | null; userEmail: string | null }>(
      `SELECT a.id, a.ts, a.action, a.target, a.target_enc AS targetEnc, a.detail, a.ip, u.name AS userName, u.email AS userEmail
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where} AND a.id < ?
        ORDER BY a.id DESC LIMIT 200`,
      vaultId,
      second,
      before,
    ).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  });

  // ---------- 볼트 키 ----------
  // 아무도 키를 갖지 않은 빈 볼트(새로 만든 볼트)는 편집 권한이 있는 사람이 처음 키를 만든다
  app.post('/api/vaults/:vaultId/key', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const vault = requireVault(user, vaultId, 'edit');
    if (!user.public_key) throw badRequest('먼저 암호화 비밀번호를 설정해 주세요');
    const wrapped = sealed(body(req.body).wrapped, 'wrapped', 1024);
    tx(() => {
      if (get('SELECT 1 AS x FROM vault_keys WHERE vault_id = ? LIMIT 1', vaultId)) throw conflict('이 볼트에는 이미 키가 있습니다. 관리자에게 공유를 요청해 주세요.');
      if (get('SELECT 1 AS x FROM items WHERE vault_id = ? LIMIT 1', vaultId)) throw conflict('볼트 키를 가진 사람이 없어 기존 항목을 풀 수 없습니다.');
      run('INSERT INTO vault_keys (vault_id, user_id, wrapped, wrapped_by, created_at) VALUES (?, ?, ?, ?, ?)', vaultId, user.id, wrapped, user.id, now());
    });
    audit({ userId: user.id, teamId: vault.team_id, vaultId, action: 'vault_key_init', target: vault.name, ip: req.ip });
    return { ok: true };
  });

  // 내 볼트 키를 내 계정 키로 다시 봉해 둔다: 봉한 공개키가 내 것이면 나만 만들 수 있는 암호문이라, 다른 기기에서 열 때
  // 서버가 만들어 넣은 키가 아님을 확인할 수 있다 (보안 점검 H-2). 이미 이 볼트 키를 받은 사람이 자기 것만 바꾼다
  app.put('/api/vaults/:vaultId/key/mine', async (req) => {
    const user = requireUser(req);
    const { vaultId } = req.params as { vaultId: string };
    const vault = requireVault(user, vaultId, 'view');
    const wrapped = sealed(body(req.body).wrapped, 'wrapped', 1024);
    const res = run('UPDATE vault_keys SET wrapped = ?, wrapped_by = ? WHERE vault_id = ? AND user_id = ?', wrapped, user.id, vaultId, user.id);
    if (!res.changes) throw notFound('볼트 키를 찾을 수 없습니다');
    audit({ userId: user.id, teamId: vault.team_id, vaultId, action: 'vault_key_rewrap', ip: req.ip });
    return { ok: true };
  });

  // 내가 관리하는 팀 볼트 중, 볼 권한은 있는데 아직 볼트 키를 못 받은 사람
  app.get('/api/vault-keys/pending', async (req) => {
    const user = requireUser(req);
    return all<{ vaultId: string; vaultName: string; teamName: string; userId: string; email: string; name: string; publicKey: string; keysCreatedAt: number | null }>(
      `SELECT v.id AS vaultId, v.name AS vaultName, t.name AS teamName, u.id AS userId, u.email, u.name, u.public_key AS publicKey, u.keys_created_at AS keysCreatedAt
         FROM vaults v
         JOIN teams t ON t.id = v.team_id
         JOIN team_members me ON me.team_id = v.team_id AND me.user_id = ? AND me.role IN ('owner', 'admin')
         JOIN vault_keys mine ON mine.vault_id = v.id AND mine.user_id = me.user_id
         JOIN team_members tm ON tm.team_id = v.team_id
         JOIN users u ON u.id = tm.user_id
        WHERE v.kind = 'team' AND u.public_key IS NOT NULL AND u.disabled = 0
          AND (tm.role IN ('owner', 'admin') OR EXISTS (SELECT 1 FROM vault_members vm WHERE vm.vault_id = v.id AND vm.user_id = u.id))
          AND NOT EXISTS (SELECT 1 FROM vault_keys vk WHERE vk.vault_id = v.id AND vk.user_id = u.id)
        ORDER BY t.name, v.name, u.email`,
      user.id,
    );
  });

  app.post('/api/vault-keys', async (req) => {
    const user = requireUser(req);
    const grants = body(req.body).grants;
    if (!Array.isArray(grants) || !grants.length || grants.length > 200) throw badRequest('공유할 항목이 없습니다');
    let added = 0;
    for (const g of grants as Record<string, unknown>[]) {
      const vaultId = String(g?.vaultId ?? '');
      const userId = String(g?.userId ?? '');
      const wrapped = sealed(g?.wrapped, 'wrapped', 1024);
      const vault = get<VaultRow>('SELECT * FROM vaults WHERE id = ?', vaultId);
      if (!vault || vault.kind !== 'team') throw notFound('볼트를 찾을 수 없습니다');
      const myRole = get<{ role: string }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', vault.team_id, user.id)?.role;
      if (myRole !== 'owner' && myRole !== 'admin') throw notFound('볼트를 찾을 수 없습니다');
      if (!get('SELECT 1 AS x FROM vault_keys WHERE vault_id = ? AND user_id = ?', vaultId, user.id)) throw badRequest('내가 이 볼트 키를 갖고 있지 않습니다');
      const target = get<User>('SELECT * FROM users WHERE id = ?', userId);
      if (!target?.public_key || !vaultAccess(target, vaultId)) throw badRequest('그 사람은 이 볼트를 볼 수 없거나 아직 암호화 설정을 하지 않았습니다');
      const res = run(
        'INSERT INTO vault_keys (vault_id, user_id, wrapped, wrapped_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        vaultId,
        userId,
        wrapped,
        user.id,
        now(),
      );
      if (res.changes) {
        added++;
        audit({ userId: user.id, teamId: vault.team_id, vaultId, action: 'vault_key_share', target: target.email, ip: req.ip });
      }
    }
    return { added };
  });
}
