# Docker runs Budd in hosted mode only (see docs/adr/0002-docker-is-hosted-mode-only.md).

# Pinned by digest so a re-pushed tag can't change what gets built; update both together.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts run: better-sqlite3 ships prebuilt binaries in its npm package.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Keep only this platform's binary, not the other platforms' or SQLite's source.
RUN npm run build && npm prune --omit=dev \
 && cd node_modules/better-sqlite3 && rm -rf deps src binding.gyp build \
 && find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production \
    BUDD_MODE=hosted \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
