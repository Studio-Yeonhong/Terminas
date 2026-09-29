import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // dev-tunnels-ssh 의 Node 전용 경로(브라우저에서는 실행되지 않는다)가 부르는 선택 패키지
  // 브라우저에서 쓰는 SSH(dev-tunnels-ssh)는 Node 의 stream·events·util 을 쓴다 → 브라우저용 구현으로 잇는다.
  // node-rsa 는 Node 전용 경로(브라우저에서는 실행되지 않는다)가 부르는 선택 패키지라 빈 모듈로.
  resolve: {
    alias: {
      stream: 'stream-browserify',
      events: 'events',
      util: 'util',
      'node-rsa': fileURLToPath(new URL('./src/ssh/empty.ts', import.meta.url)),
    },
  },
  server: {
    port: 5380,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5381', ws: true },
      '/updates': { target: 'http://127.0.0.1:5381' },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
