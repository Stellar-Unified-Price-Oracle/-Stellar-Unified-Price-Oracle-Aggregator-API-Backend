# Built from the workspace root, because the API depends on the
# @stellar-oracle/types and @stellar-oracle/vault-client workspace packages:
#
#   docker build -f api/Dockerfile .

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci --ignore-scripts \
 && npm run build:packages \
 && npm run build:api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Pull the patched Alpine packages (libssl3 among them) that clear the
# HIGH-severity OS CVEs the container scan gates on.
RUN apk upgrade --no-cache

# Re-resolve production dependencies only, from the same lockfile.
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/vault-client/package.json packages/vault-client/
COPY api/package.json api/
COPY services/aggregator/package.json services/aggregator/
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

COPY --from=builder /app/packages/types/dist packages/types/dist
COPY --from=builder /app/packages/vault-client/dist packages/vault-client/dist
COPY --from=builder /app/api/dist dist

EXPOSE 3000 3001
CMD ["node", "dist/index.js"]
