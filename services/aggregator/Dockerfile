# Built from the workspace root, because the aggregator depends on the
# @stellar-oracle/types and @stellar-oracle/vault-client workspace packages:
#
#   docker build -f services/aggregator/Dockerfile .

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci --ignore-scripts \
 && npm run build:packages \
 && npm run build:aggregator

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Re-resolve production dependencies only, from the same lockfile.
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/vault-client/package.json packages/vault-client/
COPY api/package.json api/
COPY services/aggregator/package.json services/aggregator/
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY --from=builder /app/packages/types/dist packages/types/dist
COPY --from=builder /app/packages/vault-client/dist packages/vault-client/dist
COPY --from=builder /app/services/aggregator/dist dist

EXPOSE 4000 4001 4002
CMD ["node", "dist/index.js"]
