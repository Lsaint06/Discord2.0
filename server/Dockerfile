# syntax=docker/dockerfile:1
# Multi-arch image (linux/amd64, linux/arm64 e.g. NVIDIA Jetson Orin Nano).
# Node's built-in SQLite and Argon2id; image processing uses sharp, whose prebuilt libvips binaries
# (@img/sharp-linux-arm64 / -x64, glibc) are installed by npm ci. Nothing is compiled.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Fail the build early if sharp's native binary for this platform is missing (e.g. a lockfile
# without the linux-arm64 package), instead of failing on the first avatar upload.
RUN node -e "const s = require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips)"

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATABASE_URL=sqlite:/data/discord2.db
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
