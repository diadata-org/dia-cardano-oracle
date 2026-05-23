# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Stage 1 — build: compile TypeScript → JavaScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (including devDeps needed for tsc + tsx).
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile.
COPY tsconfig.json ./
COPY cmd ./cmd
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: lean image with only compiled output + prod deps
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Production deps only (no devDeps).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled JS from build stage.
COPY --from=build /app/dist ./dist

# Config is mounted at runtime — create the default mount point.
RUN mkdir -p /config /state && chown -R node:node /config /state

# The feeder HTTP API listens on 8080 by default.
EXPOSE 8080

# Liveness probe — if /healthz returns non-2xx the container is restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

USER node

# Default: daemon mode.
# Override CMD in docker-compose to pass extra flags.
ENTRYPOINT ["node", "dist/cmd/feeder/main.js"]
CMD ["--config", "/config"]
