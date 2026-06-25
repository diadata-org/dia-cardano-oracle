# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# DIA Cardano Oracle — single self-contained image.
#
# The build context is the REPO ROOT (see docker-compose.yml build.context), so
# the image mirrors the whole repo under /app:
#
#   /app/contracts/aiken      Aiken sources + the compiled plutus.json blueprint
#   /app/offchain/cli         CLI: src + dist + node_modules + scripts
#   /app/offchain/shared      shared lib: OpenAPI builder + Swagger UI + public/
#   /app/offchain/feeder      feeder daemon: src + dist + node_modules
#   /app/offchain/indexer     indexer query service: src + dist + node_modules
#
# It also carries the full toolchain — Node, the Aiken compiler, and bash — so
# every workflow (compile contracts, deploy, run the daemon, tear down) runs
# inside the container with nothing missing and nothing in another place. The
# paths mirror the host, so a relative path resolves the same here as under npm.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

# System toolchain.
#   python3 / make / g++   : native node addons (better-sqlite3)
#   bash / util-linux       : run-all-cli.sh (bash shebang; `script` keeps a PTY)
#   curl / ca-certificates  : fetch the Aiken compiler
#   git                     : `aiken build` pulls stdlib/fuzz from GitHub
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ bash util-linux curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Aiken compiler, pinned to contracts/aiken/aiken.toml::compiler.
ENV AIKEN_VERSION=v1.1.21
RUN curl -sSfL https://install.aiken-lang.org | bash \
 && /root/.aiken/bin/aikup install "${AIKEN_VERSION}" \
 && cp -L /root/.aiken/bin/aiken /usr/local/bin/aiken \
 && aiken --version

WORKDIR /app

# --- CLI: install deps (layer cached on package.json) then build ---
COPY offchain/cli/package.json offchain/cli/package-lock.json* ./offchain/cli/
RUN cd offchain/cli && npm ci
COPY offchain/cli/tsconfig.json ./offchain/cli/
COPY offchain/cli/src ./offchain/cli/src
COPY offchain/cli/scripts ./offchain/cli/scripts
RUN cd offchain/cli && npm run build

# --- shared: install deps then build (feeder + indexer link file:../shared, so
#     it must exist and be built before their npm ci). Carries the vendored
#     Swagger UI assets under public/, served by both APIs at runtime. ---
COPY offchain/shared/package.json offchain/shared/package-lock.json* ./offchain/shared/
RUN cd offchain/shared && npm ci
COPY offchain/shared/tsconfig.json ./offchain/shared/
COPY offchain/shared/src ./offchain/shared/src
COPY offchain/shared/public ./offchain/shared/public
RUN cd offchain/shared && npm run build

# --- feeder: install deps then build ---
COPY offchain/feeder/package.json offchain/feeder/package-lock.json* ./offchain/feeder/
RUN cd offchain/feeder && npm ci
COPY offchain/feeder/tsconfig.json ./offchain/feeder/
COPY offchain/feeder/cmd ./offchain/feeder/cmd
COPY offchain/feeder/src ./offchain/feeder/src
RUN cd offchain/feeder && npm run build

# --- indexer: install deps (it links file:../cli, built above) then build ---
COPY offchain/indexer/package.json offchain/indexer/package-lock.json* ./offchain/indexer/
RUN cd offchain/indexer && npm ci
COPY offchain/indexer/tsconfig.json ./offchain/indexer/
COPY offchain/indexer/src ./offchain/indexer/src
RUN cd offchain/indexer && npm run build

# --- contracts: Aiken sources + the committed plutus.json blueprint ---
COPY contracts ./contracts

# Convenience wrapper: `dia-cli <command>` from any shell / service.
RUN printf '#!/bin/sh\nexec node /app/offchain/cli/dist/index.js "$@"\n' > /usr/local/bin/dia-cli \
 && chmod +x /usr/local/bin/dia-cli

# Runtime mount points (config + state trees) must be writable by the
# unprivileged runtime user. The baked code/node_modules stay root-owned but
# world-readable, so node reads them fine; only these mount dirs need node
# ownership (a recursive chown over node_modules adds minutes to every build).
RUN mkdir -p /app/offchain/state /app/offchain/feeder/config \
 && chown node:node /app/offchain/state /app/offchain/feeder/config

# 8080 = feeder API; 3001 = indexer API (each compose service maps its own).
EXPOSE 8080 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health/live >/dev/null || exit 1

USER node

# Default service = feeder daemon. Each compose service sets its own working_dir
# and may override the command (CLI, aiken, run-all, teardown, …).
WORKDIR /app/offchain/feeder
CMD ["node", "/app/offchain/feeder/dist/cmd/feeder/main.js", "--config", "/app/offchain/feeder/config"]
