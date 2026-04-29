# syntax=docker/dockerfile:1.7

# ---- Stage 1: build the React frontend ----
FROM node:20-bookworm-slim AS web-build
WORKDIR /app
COPY package.json ./
COPY web/package.json web/package.json
RUN npm install --workspace web --ignore-scripts
COPY web ./web
RUN npm run build --workspace web

# ---- Stage 2: install server (with native deps for better-sqlite3 + bcrypt) ----
FROM node:20-bookworm-slim AS server-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY server/package.json server/package.json
RUN npm install --workspace server --omit=dev

# ---- Stage 3: runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# Non-root user
RUN groupadd -r cambiar && useradd -r -g cambiar -d /app cambiar

COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server ./server
COPY config ./config
COPY --from=web-build /app/web/dist ./web/dist
COPY LICENSE NOTICE ./

RUN mkdir -p /app/data && chown -R cambiar:cambiar /app
USER cambiar

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
