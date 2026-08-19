# --- screp parser (static Go binary) ---
FROM golang:1.26-alpine AS screp
RUN CGO_ENABLED=0 go install github.com/icza/screp/cmd/screp@v1.13.3

# --- dependencies ---
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# hoisted layout: Next's standalone file-tracing can't follow pnpm's symlink store
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted

# --- build ---
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
ENV SCREP_PATH=/usr/local/bin/screp REPLAYS_DIR=/data/replays
RUN addgroup -S dojo && adduser -S dojo -G dojo && mkdir -p /data/replays && chown -R dojo:dojo /data/replays
COPY --from=screp /go/bin/screp /usr/local/bin/screp
COPY --from=build --chown=dojo:dojo /app/.next/standalone ./
COPY --from=build --chown=dojo:dojo /app/.next/static ./.next/static
COPY --from=build --chown=dojo:dojo /app/public ./public
USER dojo
EXPOSE 3000
CMD ["node", "server.js"]
