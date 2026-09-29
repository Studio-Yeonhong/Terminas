// dev-tunnels-ssh(와 그 의존 모듈: readable-stream·util 등)는 Node 처럼 전역 Buffer·global·process 를 쓴다
// → 브라우저에서 필요한 만큼만 채워 둔다. 이 파일은 SSH 모듈보다 먼저 불러야 한다.
import { Buffer } from 'buffer';

type ProcessLike = {
  env: Record<string, string | undefined>;
  browser: boolean;
  version: string;
  versions: Record<string, string>;
  platform: string;
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void;
  emitWarning(): void;
  cwd(): string;
};

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: typeof globalThis; process?: ProcessLike };
g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= {
  env: {},
  browser: true,
  version: '',
  versions: {},
  platform: 'browser',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  emitWarning: () => {},
  cwd: () => '/',
};
