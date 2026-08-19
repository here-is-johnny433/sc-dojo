# Capa B — OpenBW re-simulation worker.
# Pure JS + WASM: no native addons, no StarCraft install, no build toolchain.
# The Blizzard game data lives in ./data/bwdata on the host and is bind-mounted
# read-only at /bwdata — it is deliberately NOT copied into this image.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY vendor/ ./vendor/
COPY lib/ ./lib/
COPY index.js run-one.js verify.js ./

# The runtime uid comes from docker-compose (`user: "100:101"`), so the files
# written into the shared `replays` volume belong to the same user the web
# container runs as.
CMD ["node", "index.js"]
