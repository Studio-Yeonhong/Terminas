// Isolated security review: no production database, credentials or SSH targets.
// Run from the repository root: node security-review/reproduce.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as E from '../web/src/e2ee.ts';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'terminas-security-review-'));
const results = [];
const sockets = [];
let child, tcp;
const record = (name, evidence) => { results.push({ name, ...evidence }); console.log(JSON.stringify(results.at(-1))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const placeholder = net.createServer();
const port = await listen(placeholder);
await new Promise(r => placeholder.close(r));
const base = `http://127.0.0.1:${port}`;
async function start(production) {
  child = spawn(process.execPath, ['src/index.ts'], {
    cwd: path.join(root, 'server'), windowsHide: true,
    env: { ...process.env, NODE_ENV: production ? 'production' : 'development', SHELL_PORT: String(port), SHELL_HOST: '127.0.0.1',
      SHELL_PUBLIC_URL: base, SHELL_DATA_DIR: data, SHELL_UPDATES_DIR: path.join(data, 'updates'), SHELL_LOG_FILE: path.join(data, 'server.log'),
      SHELL_DEV_LOGIN: production ? '0' : '1', SHELL_BOOTSTRAP_ADMINS: 'owner@example.test,outsider@example.test',
      SHELL_TRUST_PROXY: '0', SHELL_EXIT_WITH_PARENT: '0', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${stderr}`);
    try { if ((await fetch(`${base}/api/auth/config`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error('Test server did not start');
}
async function stop() { if (child && child.exitCode === null) { const p = once(child, 'exit'); child.kill(); await p; } child = null; }
async function api(method, p, token, body, extra = {}) {
  const res = await fetch(base + p, { method, headers: { 'x-shell': '1', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function login(email) { const r = await api('POST', '/api/auth/dev-login-token', null, { email }); if (!r.body.token) throw new Error('Login failed'); return r.body.token; }
function connectWs(token, host, targetPort, origin = base) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/relay?host=${encodeURIComponent(host)}&port=${targetPort}`, { headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  sockets.push(ws);
  const events = []; ws.on('message', (b, binary) => events.push(binary ? { binary: b.toString() } : JSON.parse(b.toString())));
  ws.on('error', e => events.push({ error: e.message }));
  ws.on('close', (code, reason) => events.push({ close: code, reason: reason.toString() }));
  return { ws, events };
}
try {
  await start(false);
  const owner = await login('owner@example.test');
  const outsider = await login('outsider@example.test');
  const team = (await api('POST', '/api/teams', owner, { name: 'Security review fixture' })).body;
  await api('POST', `/api/teams/${team.id}/invites`, owner, { email: 'viewer@example.test', role: 'member' });
  const viewer = await login('viewer@example.test');
  const me = (await api('GET', '/api/me', owner)).body;
  const viewerMe = (await api('GET', '/api/me', viewer)).body;
  const ownerCrypto = await E.createAccount(me.user.id, 'fixture-password-not-used-elsewhere');
  const viewerCrypto = await E.createAccount(viewerMe.user.id, 'fixture-password-not-used-elsewhere');
  for (const [token, keys] of [[owner, ownerCrypto], [viewer, viewerCrypto]]) await api('POST', '/api/me/keys', token, keys);
  const vaultKey = E.randomBytes(32);
  const wrapped = await E.wrapVaultKey(vaultKey, ownerCrypto.publicKey, team.vaultId, me.user.id);
  await api('POST', `/api/vaults/${team.vaultId}/key`, owner, { wrapped });
  await api('POST', '/api/vault-keys', owner, { grants: [{ vaultId: team.vaultId, userId: viewerMe.user.id, wrapped: await E.wrapVaultKey(vaultKey, viewerCrypto.publicKey, team.vaultId, viewerMe.user.id) }] });
  const hostId = crypto.randomUUID();
  const host = await api('POST', `/api/vaults/${team.vaultId}/items`, owner, { id: hostId, kind: 'host', data: await E.seal(vaultKey, JSON.stringify({ address: 'host.example.test', port: 22 }), E.itemAad(team.vaultId, hostId, 'host')) });
  record('access-controls', {
    anonymous: (await api('GET', '/api/me')).status,
    crossTeamRead: (await api('GET', `/api/vaults/${team.vaultId}/items`, outsider)).status,
    viewerHostCreate: (await api('POST', `/api/vaults/${team.vaultId}/items`, viewer, { id: crypto.randomUUID(), kind: 'host', data: 'v1.YQ==' })).status,
    viewerHostEdit: (await api('PATCH', `/api/items/${hostId}`, viewer, { data: 'v1.YQ==' })).status,
    viewerHostDelete: (await api('DELETE', `/api/items/${hostId}`, viewer)).status,
    foreignOriginCookieRequest: (await api('POST', '/api/auth/logout', null, {}, { origin: 'https://foreign.example.test', cookie: `ss_sid=${owner}` })).status,
  });
  const knownId = crypto.randomUUID();
  const inserted = await api('POST', `/api/vaults/${team.vaultId}/items`, viewer, { id: knownId, kind: 'knownhost', data: await E.seal(vaultKey, JSON.stringify({ address: 'host.example.test', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:attacker-fixture', addedByName: 'Fixture' }), E.itemAad(team.vaultId, knownId, 'knownhost')) });
  const ownerItems = (await api('GET', `/api/vaults/${team.vaultId}/items`, owner)).body;
  const insertedRow = ownerItems.find(r => r.id === knownId);
  const plain = JSON.parse(await E.openText(vaultKey, insertedRow.data, E.itemAad(team.vaultId, knownId, 'knownhost')));
  const source = fs.readFileSync(path.join(root, 'web/src/connect.ts'), 'utf8');
  const verdictSource = source.slice(source.indexOf('export function hostKeyVerdict'), source.indexOf('\nconst MISMATCH')).replace('export ', '').replace('known: Known, keyType: string, fingerprint: string', 'known, keyType, fingerprint').replaceAll(' as const', '').replace(')!.fingerprint', ').fingerprint');
  const verdict = vm.runInNewContext(`${verdictSource}; hostKeyVerdict`)([plain], plain.keyType, plain.fingerprint);
  record('viewer-shared-host-key-injection', { insertStatus: inserted.status, ownerDecrypts: plain.fingerprint === 'SHA256:attacker-fixture', verdict: verdict.state, existingDifferentSameTypeVerdict: vm.runInNewContext(`${verdictSource}; hostKeyVerdict`)([plain, { keyType: plain.keyType, fingerprint: 'SHA256:real-fixture' }], plain.keyType, plain.fingerprint).state });
  // Confirm AEAD context binding without using real secrets.
  let rejected = false;
  try { await E.openText(vaultKey, host.body.data, E.itemAad(team.vaultId, crypto.randomUUID(), 'host')); } catch { rejected = true; }
  record('aead-context-binding', { modifiedItemIdRejected: rejected });

  await stop();
  await start(true);
  tcp = net.createServer(s => { s.write('SSH-2.0-security-review-fixture\r\n'); s.on('data', b => s.write(b)); });
  const targetPort = await listen(tcp);
  const normal = connectWs(owner, '127.0.0.1', targetPort);
  const mapped = connectWs(owner, '::ffff:7f00:1', targetPort);
  const unauth = connectWs(null, '::ffff:7f00:1', targetPort);
  const foreign = connectWs(owner, '::ffff:7f00:1', targetPort, 'https://foreign.example.test');
  await sleep(300);
  record('production-relay-loopback-policy', { normal: normal.events, ipv6MappedHex: mapped.events, anonymous: unauth.events, foreignOrigin: foreign.events });
  const logout = await api('POST', '/api/auth/logout', owner, {});
  if (mapped.ws.readyState === WebSocket.OPEN) mapped.ws.send(Buffer.from('after-logout-fixture'));
  await sleep(200);
  record('relay-after-logout', { logoutStatus: logout.status, freshApiStatus: (await api('GET', '/api/me', owner)).status, oldRelayEchoes: mapped.events.some(e => e.binary === 'after-logout-fixture') });
  // Account reset is destructive: test only our synthetic viewer and its personal item.
  const pv = viewerMe.vaults.find(v => v.kind === 'personal').id;
  await api('POST', `/api/vaults/${pv}/items`, viewer, { id: crypto.randomUUID(), kind: 'host', data: 'v1.YQ==' });
  const reset = await api('POST', '/api/me/keys/reset', viewer, { confirm: 'RESET', publicKey: ownerCrypto.publicKey, bundle: ownerCrypto.bundle, proof: ownerCrypto.proof });
  record('reset-with-session-only', { status: reset.status, personalItemsRemaining: (await api('GET', `/api/vaults/${pv}/items`, viewer)).body.length });

  // Exercise exact desktop copy/list source with mock SFTP endpoints. No files on any real remote are touched.
  const desktop = fs.readFileSync(path.join(root, 'desktop/src/ssh.js'), 'utf8');
  const listFn = desktop.slice(desktop.indexOf('async function listDir('), desktop.indexOf('\nasync function removeRecursive'));
  const copyFn = desktop.slice(desktop.indexOf('function copyRemote('), desktop.indexOf('// ---------- 포트 포워딩'));
  const written = [];
  const from = { readdir: (_p, cb) => cb(null, [{ filename: '../../outside.txt', attrs: { mode: 0o100644, size: 1, mtime: 0 } }]) };
  const to = {};
  const context = { posix: path.posix, S_IFMT: 0o170000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,
    call: fn => new Promise((resolve, reject) => fn((err, value) => err ? reject(err) : resolve(value))),
    rstat: async (_s, p) => ({ mode: p === '/source/folder' ? 0o040755 : 0o100644 }),
    isDir: a => (a.mode & 0o170000) === 0o040000,
    sftpOf: id => id === 'source' ? from : to, text: v => v,
    runJob: async (_w, _j, fn) => fn({ signal: { aborted: false }, state: {}, add() {}, fileDone() {} }),
    mkdirp: async () => {}, rexists: async () => false, existsError: p => new Error(p),
    tmpName: (d, n) => path.posix.join(d, `.${n}.part`), xfer: async () => {}, renameOver: async (_s, _a, dst) => written.push(dst),
  };
  const copyRemote = vm.runInNewContext(`${listFn}\n${copyFn}\ncopyRemote`, context);
  await copyRemote({}, { fromConn: 'source', toConn: 'destination', toDir: '/approved', paths: ['/source/folder'], overwrite: false, jobId: 'fixture' });
  record('desktop-sftp-copy-path-traversal', { destination: '/approved', maliciousFilename: '../../outside.txt', writtenPaths: written, escaped: written.includes('/outside.txt'), method: 'exact production functions with mock endpoints' });
} finally {
  for (const s of sockets) s.terminate();
  if (tcp) await new Promise(r => tcp.close(r));
  await stop();
  // Keep sanitized evidence only. All test credentials and DBs are in this unique temporary directory.
  fs.writeFileSync(path.join(root, 'security-review/results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  const resolved = fs.realpathSync(data);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('terminas-security-review-')) fs.rmSync(resolved, { recursive: true, force: true });
}
