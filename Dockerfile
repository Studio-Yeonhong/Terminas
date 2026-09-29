# Terminas server (API + web UI) in one image. The desktop app is built separately (desktop/).
#   docker compose up -d        (see docker-compose.yml and docs/self-hosting.md)

# ---- 1) web UI ----
FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
# only the web workspace's packages (not Electron)
RUN npm ci --workspace web --include-workspace-root=false --ignore-scripts
COPY web web
RUN npm run build --workspace web

# ---- 2) server ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    SHELL_HOST=0.0.0.0 \
    SHELL_PORT=5280 \
    SHELL_DATA_DIR=/data \
    SHELL_CONSOLE_HOST=127.0.0.1 \
    SHELL_CONSOLE_PORT=5282
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN npm ci --workspace server --include-workspace-root=false --omit=dev \
 && npm cache clean --force \
 && mkdir -p /data \
 && chown node:node /data
COPY server/src server/src
COPY server/scripts server/scripts
COPY --from=web /src/web/dist web/dist
USER node
VOLUME /data
# 5282 = admin console: publish it only on the host's 127.0.0.1 (docker-compose.yml)
# 관리 콘솔(5282)은 내보내지 않는다 — docker-compose.yml 이 컨테이너 안 0.0.0.0 + 호스트의 127.0.0.1 로만 연다
EXPOSE 5280
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.SHELL_PORT + '/api/auth/config').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/src/index.ts"]
