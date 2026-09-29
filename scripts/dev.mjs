// Local development: API server (5381) + Vite (5380) + fake test sshd (2222) together.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'web', 'package.json'));
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

const procs = [
  ['sshd', [process.execPath, '--env-file-if-exists=../.env', 'dev/test-sshd.ts'], path.join(root, 'server')],
  ['server', [process.execPath, '--watch', '--env-file-if-exists=../.env', 'src/index.ts'], path.join(root, 'server')],
  ['web', [process.execPath, vite], path.join(root, 'web')],
];

const children = procs.map(([name, [cmd, ...args], cwd]) => {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n';
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  child.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
