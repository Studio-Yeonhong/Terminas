import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'shell.db'));
// secure_delete: 지우거나 고친 행의 옛 내용을 0 으로 덮는다 (파일에 옛 값이 남지 않게)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');

type Param = SQLInputValue | undefined | boolean;

const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

function stmt(sql: string) {
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

function norm(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return stmt(sql).all(...norm(params)) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql).get(...norm(params)) as T | undefined;
}

export function run(sql: string, ...params: Param[]) {
  return stmt(sql).run(...norm(params));
}

let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

const migrations: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    google_sub TEXT UNIQUE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (team_id, email)
  );
  CREATE INDEX invites_email ON invites(email);

  CREATE TABLE vaults (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    dek TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK ((kind = 'personal' AND owner_id IS NOT NULL AND team_id IS NULL)
        OR (kind = 'team' AND team_id IS NOT NULL AND owner_id IS NULL))
  );
  CREATE INDEX vaults_team ON vaults(team_id);
  CREATE INDEX vaults_owner ON vaults(owner_id);

  CREATE TABLE vault_members (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('edit', 'view')),
    PRIMARY KEY (vault_id, user_id)
  );
  CREATE INDEX vault_members_user ON vault_members(user_id);

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX groups_vault ON groups(vault_id);

  CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    key_type TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    private_key_enc TEXT NOT NULL,
    passphrase_enc TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX keys_vault ON keys(vault_id);

  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT,
    key_id TEXT REFERENCES keys(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX identities_vault ON identities(vault_id);

  CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    label TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL DEFAULT '',
    password_enc TEXT,
    key_id TEXT REFERENCES keys(id) ON DELETE SET NULL,
    identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    os TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX hosts_vault ON hosts(vault_id);

  -- 팀 호스트에 자격증명이 없을 때 각자 개인 볼트의 아이덴티티를 연결해 둔다
  CREATE TABLE host_personal_credentials (
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
    PRIMARY KEY (host_id, user_id)
  );

  CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    script TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX snippets_vault ON snippets(vault_id);

  CREATE TABLE known_hosts (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (vault_id, address, port)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    team_id TEXT,
    vault_id TEXT,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_vault ON audit_log(vault_id, id);
  CREATE INDEX audit_team ON audit_log(team_id, id);
  CREATE INDEX audit_user ON audit_log(user_id, id);
  `,
  `
  -- 데스크톱 앱 로그인: 시스템 브라우저에서 Google 로그인 → 앱으로 일회용 코드 전달
  ALTER TABLE oauth_states ADD COLUMN desktop_port INTEGER;
  ALTER TABLE oauth_states ADD COLUMN desktop_challenge TEXT;
  CREATE TABLE desktop_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE port_forwards (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
    local_port INTEGER NOT NULL,
    remote_host TEXT NOT NULL,
    remote_port INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX port_forwards_vault ON port_forwards(vault_id);
  `,
  `
  -- 종단간 암호화로 전환: 볼트 안의 항목(호스트·키·프리셋·스니펫·포워딩·알려진 호스트)은
  -- 앱·웹이 볼트 키로 통째로 암호화해서 보낸다. 서버는 종류·볼트·시각만 안다.
  -- 예전 표(서버 마스터 키로 암호화)는 버린다 — 서버가 풀 수 있던 비밀값을 남기지 않는다.
  DROP TABLE host_personal_credentials;
  DROP TABLE port_forwards;
  DROP TABLE known_hosts;
  DROP TABLE snippets;
  DROP TABLE hosts;
  DROP TABLE identities;
  DROP TABLE keys;
  DROP TABLE groups;

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_vault ON items(vault_id);

  -- 볼트 키를 사람마다 그 사람 공개키로 봉해 둔다
  CREATE TABLE vault_keys (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped TEXT NOT NULL,
    wrapped_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, user_id)
  );
  CREATE INDEX vault_keys_user ON vault_keys(user_id);

  -- 공개키와, 암호화 비밀번호·복구 키로 잠근 계정 키 묶음(서버는 못 푼다)
  ALTER TABLE users ADD COLUMN public_key TEXT;
  ALTER TABLE users ADD COLUMN key_bundle TEXT;
  ALTER TABLE users ADD COLUMN key_proof TEXT;
  ALTER TABLE users ADD COLUMN keys_created_at INTEGER;

  -- 기록의 대상 이름(호스트 별칭 등)도 볼트 키로 암호화해서 받는다
  ALTER TABLE audit_log ADD COLUMN target_enc TEXT;

  UPDATE vaults SET dek = '';
  DELETE FROM meta WHERE key = 'key_check';
  `,
  `
  -- 전환 전 기록에 평문으로 남은 호스트 이름·주소·지문을 지운다 (새 기록은 대상 이름을 암호화해서 받는다)
  UPDATE audit_log SET target = '', detail = '{}'
   WHERE target_enc IS NULL
     AND (action LIKE 'host%' OR action LIKE 'key\\_%' ESCAPE '\\' OR action LIKE 'identity%' OR action LIKE 'snippet%'
          OR action LIKE 'group%' OR action LIKE 'forward%' OR action LIKE 'ssh%' OR action LIKE 'sftp%' OR action LIKE 'knownhost%');
  `,
  `
  -- 보안 검토 F-01: 팀 볼트의 알려진 호스트 중, 지금 그 볼트를 편집할 수 없는 사람이 넣은 것은 버린다
  DELETE FROM items
   WHERE kind = 'knownhost'
     AND vault_id IN (SELECT id FROM vaults WHERE kind = 'team')
     AND NOT EXISTS (
       SELECT 1 FROM vaults v JOIN team_members tm ON tm.team_id = v.team_id AND tm.user_id = items.created_by
        WHERE v.id = items.vault_id
          AND (tm.role IN ('owner', 'admin')
               OR EXISTS (SELECT 1 FROM vault_members vm WHERE vm.vault_id = v.id AND vm.user_id = items.created_by AND vm.permission = 'edit')));
  `,
  `
  -- 2단계 인증(OTP): 사람마다 켜고 끈다(처음엔 모두 꺼짐). 비밀값은 서버 키로 암호화(totp.ts).
  -- 세션은 Google 로그인만 끝나면 mfa_ok = 0 으로 시작해 코드를 넣어야 1 이 된다 (OTP 를 안 켠 사람은 처음부터 1).
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_pending_at INTEGER;
  ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN mfa_ok INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sessions ADD COLUMN mfa_fails INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE totp_recovery (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  `,
  `
  -- 아이디·비밀번호 로그인(SHELL_PASSWORD_LOGIN=1): 비밀번호는 scrypt 해시만(password.ts).
  -- 초대 코드: 그런 서버에서 초대받은 사람이 처음 비밀번호를 정할 때 낸다(해시만, 7일).
  ALTER TABLE users ADD COLUMN password_hash TEXT;
  ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
  ALTER TABLE invites ADD COLUMN code_hash TEXT;
  ALTER TABLE invites ADD COLUMN code_expires_at INTEGER;
  `,
  `
  -- 오프라인 사용: 팀 볼트 사본을 며칠까지 보여 줄지 팀마다 정하려던 칸. 2026-09-29 부터 7일 고정이라 쓰지 않는다
  -- (0.3.1 앱 잠깐 동안만 읽었다 — 이제 서버가 보내지 않으면 앱은 7일로 본다). 마이그레이션 순서를 지키려고 남겨 둔다.
  ALTER TABLE teams ADD COLUMN offline_days INTEGER NOT NULL DEFAULT 7;
  `,
  `
  -- 보안 점검(09-29): 2단계 인증 코드를 틀린 횟수는 세션이 아니라 사람마다 센다 (다시 로그인해도 이어진다).
  -- 다섯 번 틀리면 잠그고, 거듭 잠길수록 길게 (auth.ts mfaFailed)
  ALTER TABLE users ADD COLUMN mfa_fails INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN mfa_locked_until INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN mfa_lock_level INTEGER NOT NULL DEFAULT 0;
  `,
];

function migrate() {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = version; v < migrations.length; v++) {
    tx(() => {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      if (version > 0) db.exec("INSERT INTO meta (key, value) VALUES ('vacuum_pending', '1') ON CONFLICT (key) DO UPDATE SET value = '1'");
    });
  }
  // 지운 예전 값(암호문·평문 기록)이 빈 페이지·WAL 에 남지 않게 파일을 새로 쓴다. 잠겨서 못 하면 다음 시작 때 다시.
  if (db.prepare("SELECT 1 AS x FROM meta WHERE key = 'vacuum_pending'").get()) {
    try {
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec("DELETE FROM meta WHERE key = 'vacuum_pending'");
    } catch (err) {
      console.warn('[db] VACUUM 을 다음 시작 때 다시 합니다:', (err as Error).message);
    }
  }
}

migrate();

// 계정 키 증명(key_proof)은 원문이 아니라 해시로만 둔다 — DB 를 읽은 사람이 그 값으로 키 묶음을 바꿔치기하지 못하게 (보안 점검 09-29).
// 예전에 원문으로 둔 것은 켤 때 한 번 바꾼다 (h1: 이 붙은 것이 해시)
for (const r of db.prepare("SELECT id, key_proof FROM users WHERE key_proof IS NOT NULL AND key_proof NOT LIKE 'h1:%'").all() as { id: string; key_proof: string }[]) {
  db.prepare('UPDATE users SET key_proof = ? WHERE id = ?').run(`h1:${createHash('sha256').update(r.key_proof).digest('hex')}`, r.id);
}

export function now() {
  return Date.now();
}

export function newId() {
  return crypto.randomUUID();
}
