# DIA Cardano Oracle — operator shortcuts.
# All targets delegate to docker compose running from offchain/feeder/.

# The compose PROJECT is scoped per network (dia-feeder-<network>) so Preview
# and Mainnet get completely separate containers AND named volumes, and never
# clobber each other: switching networks leaves the other one's container and
# data intact (stopped). The network comes from feeder/.env CARDANO_NETWORK —
# the SAME selector the daemon reads — so the project always matches the network
# the feeder actually runs; there is no second source of truth to drift.
# Ports are shared, so run ONE network at a time. To switch: `make down`, change
# CARDANO_NETWORK in feeder/.env, then `make up` (see feeder/README.md →
# "Network-scoped stacks").
NET_TAG := $(strip $(shell sed -n 's/^CARDANO_NETWORK=//p' feeder/.env 2>/dev/null | tr '[:upper:]' '[:lower:]'))
NET_TAG := $(if $(NET_TAG),$(NET_TAG),preview)
COMPOSE := docker compose -f feeder/docker-compose.yml --project-directory feeder -p dia-feeder-$(NET_TAG)
UID ?= $(shell id -u)
GID ?= $(shell id -g)
export UID
export GID
# Exported so docker-compose interpolates the active network into the per-network
# monitoring mounts (./monitoring/${NET_TAG}/alerts.yml, dashboards, alertmanager).
export NET_TAG

# RUN_ID selects the per-run state dir (state/<network>_run_<RUN_ID>/), the same
# id the CLI deployment used. Exported so `make up RUN_ID=...` (and every feeder
# target) reaches the container's compose `${RUN_ID}` interpolation. Empty -> the
# daemon uses the newest run dir.  e.g.  make up RUN_ID=20260517-063917 MONITORING=1
RUN_ID ?=
export RUN_ID

# Extra arguments forwarded to the runbook targets (run-all / teardown), e.g.
#   make run-all ARGS="--from-step 28 --run-id 20260608-040304"
ARGS ?=

# Fault-drill intent fields for `make inject`. SYMBOL is required; the rest
# override the CLI's network-derived defaults to stage a specific scenario
# (stale TIMESTAMP, drifted PRICE, out-of-order NONCE). See the feeder README
# "Fault-drill intent injection".
SYMBOL ?=
PRICE ?=
TIMESTAMP ?=
NONCE ?=
EXPIRY ?=

# Monitoring toggle. Set MONITORING=1 on any "start" target to ALSO bring up
# Prometheus + Grafana + the renderer sidecar. Without it, only the feeder
# starts. One flag, consistent across up / up-postgres / restart-latest /
# reset-restart — there is no separate "up-monitoring" target.
#   make up                → feeder only
#   make up MONITORING=1   → feeder + Prometheus + Grafana + renderer
#   make down              → stops everything (feeder + monitoring)
MON_PROFILE := $(if $(MONITORING),--profile monitoring,)

# Volume toggle. Set VOLUMES=1 on `down` to ALSO delete this network's named
# volumes (Prometheus TSDB + Grafana data + Alertmanager data) → fresh
# metrics/dashboards on the next `up`. The bind-mounted ../state (feeder DB, logs,
# on-chain deploy) is NOT a named volume and is therefore NEVER touched by this.
# `make fresh` always wipes.
#   make down              → stop, keep volumes (safe default)
#   make down VOLUMES=1    → stop + delete Prometheus + Grafana + Alertmanager volumes
VOL_FLAG := $(if $(VOLUMES),--volumes,)

# One-off feeder sub-commands run through the FEEDER binary inside the image
# (NOT dia-cli). They override the daemon command on the feeder-sqlite service
# so they share its volumes (./state, ./config) and .env. --no-deps avoids
# pulling in any other services; --rm removes the throwaway container.
FEEDER_BIN := node /app/offchain/feeder/dist/cmd/feeder/main.js --config /app/offchain/feeder/config
FEEDER_RUN := $(COMPOSE) --profile sqlite run --rm --no-deps feeder-sqlite $(FEEDER_BIN)
FEEDER_RUN_IT := $(COMPOSE) --profile sqlite run --rm -it --no-deps feeder-sqlite $(FEEDER_BIN)

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F: '{printf "  %-22s %s\n", $$1, $$NF}'

.PHONY: build
build: ## Build the unified feeder + CLI image
	$(COMPOSE) --profile sqlite build

# Write the monitoring thresholds from infrastructure.<network>.yaml::alerting.*
# into that network's own directory (monitoring/<network>/alerts.yml, its Grafana
# dashboards, and alertmanager.yml). NET_TAG (= CARDANO_NETWORK from feeder/.env,
# lowercased) selects both the source YAML and the target directory. Run by hand
# to refresh the files, and automatically as a prerequisite of `up` / `up-postgres`
# so Prometheus + Grafana always load values that match the active network's YAML.
# It is a fast, host-side tsx run (no Docker) and a no-op when files are current.
.PHONY: generate-monitoring
generate-monitoring: ## Write monitoring thresholds from infrastructure.<network>.yaml::alerting.* (idempotent)
	cd feeder && node --import tsx/esm scripts/monitoring/generate-monitoring.ts --network $(NET_TAG)

.PHONY: up
up: generate-monitoring ## Start the feeder daemon + indexer (add MONITORING=1 for Prometheus + Grafana)
	$(COMPOSE) --profile sqlite --profile indexer $(MON_PROFILE) up -d

.PHONY: up-postgres
up-postgres: generate-monitoring ## Start the feeder daemon (Postgres) + indexer (add MONITORING=1 for Prometheus + Grafana)
	$(COMPOSE) --profile postgres --profile indexer $(MON_PROFILE) up -d

# Indexer-only / feeder-pause helpers — used to run the on-chain consumer demo
# without the feeder competing for the operator wallet + the Pair UTxOs. The
# indexer reads the chain directly, so it serves the already-published pairs
# fine while the feeder is paused.
.PHONY: up-indexer
up-indexer: ## Start ONLY the indexer (no feeder). For consuming/demoing the live pairs.
	$(COMPOSE) --profile indexer up -d indexer

.PHONY: stop-feeder
stop-feeder: ## Pause ONLY the feeder daemon, leaving the indexer running (e.g. for the on-chain consumer demo).
	-$(COMPOSE) --profile sqlite stop feeder-sqlite

.PHONY: start-feeder
start-feeder: ## Resume the feeder daemon after `stop-feeder`.
	$(COMPOSE) --profile sqlite start feeder-sqlite

# Every service is gated behind a profile, and `docker compose down` only
# touches services whose profile is active. Without listing them all here,
# `down` matches nothing and leaves the feeder + monitoring stack running.
.PHONY: down
down: ## Stop everything for the CURRENT network (all profiles incl. monitoring: Alertmanager + Pushgateway; other network untouched). Add VOLUMES=1 to ALSO delete the Prometheus + Grafana + Alertmanager volumes (fresh metrics; ../state/contracts untouched).
	$(COMPOSE) --profile sqlite --profile postgres --profile cli --profile indexer --profile monitoring down $(VOL_FLAG) --remove-orphans

# Stops BOTH network stacks regardless of feeder/.env — use it when you are not
# sure which network is up, or to tear everything down before maintenance.
ALL_PROFILES := --profile sqlite --profile postgres --profile cli --profile indexer --profile monitoring
.PHONY: down-all
down-all: ## Stop EVERY network's stack (dia-feeder-preview AND dia-feeder-mainnet)
	-docker compose -f feeder/docker-compose.yml --project-directory feeder -p dia-feeder-preview $(ALL_PROFILES) down --remove-orphans
	-docker compose -f feeder/docker-compose.yml --project-directory feeder -p dia-feeder-mainnet $(ALL_PROFILES) down --remove-orphans

.PHONY: logs
logs: ## Tail feeder logs
	$(COMPOSE) logs -f feeder-sqlite

.PHONY: logs-indexer
logs-indexer: ## Tail indexer logs
	$(COMPOSE) logs -f indexer

.PHONY: cli
cli: ## Run a CLI command. Usage: make cli CMD="protocol"
	$(COMPOSE) --profile cli run --rm cli $(CMD)

.PHONY: wallet
wallet: ## Create the operator wallet
	$(COMPOSE) --profile cli run --rm cli wallet:create

# Stage a fault-drill intent: the CLI signs it with our authorized key and drops
# it into the run's inject/ dir, where the daemon's file injector picks it up and
# pushes a real on-chain update — alongside the live DIA feed. RUN_ID selects the
# run dir (newest when empty). The signed file is archived under inject/processed/
# after it is processed. See the feeder README "Fault-drill intent injection".
.PHONY: inject
inject: ## Stage a fault-drill intent into the run's inject/ dir. Usage: make inject SYMBOL=BTC/USD PRICE=6500000000000 [TIMESTAMP=… NONCE=… EXPIRY=…]
	@test -n "$(SYMBOL)" || { echo "SYMBOL is required, e.g. make inject SYMBOL=BTC/USD PRICE=6500000000000"; exit 1; }
	@runid="$(RUN_ID)"; \
	 if [ -z "$$runid" ]; then \
	   latest=$$(ls -d state/$(NET_TAG)_run_* 2>/dev/null | sort | tail -1); \
	   test -n "$$latest" || { echo "no run dir under state/$(NET_TAG)_run_* — deploy first or pass RUN_ID="; exit 1; }; \
	   runid=$${latest#state/$(NET_TAG)_run_}; \
	 fi; \
	 slug=$$(echo "$(SYMBOL)" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$$//'); \
	 out="../state/$(NET_TAG)_run_$$runid/inject/$$slug.signed.json"; \
	 echo "make inject: $(SYMBOL) → state/$(NET_TAG)_run_$$runid/inject/$$slug.signed.json"; \
	 $(COMPOSE) --profile cli run --rm cli intent:create-and-sign \
	   --symbol "$(SYMBOL)" \
	   $(if $(PRICE),--price "$(PRICE)",) \
	   $(if $(TIMESTAMP),--timestamp "$(TIMESTAMP)",) \
	   $(if $(NONCE),--nonce "$(NONCE)",) \
	   $(if $(EXPIRY),--expiry "$(EXPIRY)",) \
	   --out "$$out"

.PHONY: protocol-init
protocol-init: ## Initialise protocol: init, parameterize, reference-scripts, bootstrap
	$(COMPOSE) --profile cli run --rm cli protocol:init
	$(COMPOSE) --profile cli run --rm cli config:parameterize
	$(COMPOSE) --profile cli run --rm cli config:reference-scripts
	$(COMPOSE) --profile cli run --rm cli config:bootstrap

.PHONY: client-init
client-init: ## Register one client: init, bootstrap, parameterize, publish reference scripts
	$(COMPOSE) --profile cli run --rm cli client:init
	$(COMPOSE) --profile cli run --rm cli receiver:bootstrap
	$(COMPOSE) --profile cli run --rm cli receiver:parameterize
	$(COMPOSE) --profile cli run --rm cli reference-scripts:publish-client

.PHONY: contracts-build
contracts-build: ## Compile the Aiken contracts in-image (regenerates contracts/aiken/plutus.json)
	$(COMPOSE) --profile cli run --rm --workdir /app/contracts/aiken --entrypoint aiken cli build

.PHONY: contracts-check
contracts-check: ## Run the Aiken contract test suite in-image
	$(COMPOSE) --profile cli run --rm --workdir /app/contracts/aiken --entrypoint aiken cli check

.PHONY: run-all
run-all: ## Full on-chain deployment runbook end to end. Pass ARGS="--from-step N --run-id ID"
	$(COMPOSE) --profile cli run --rm --entrypoint bash cli scripts/run-all-cli.sh $(ARGS)

.PHONY: teardown
teardown: ## Decommission runbook (recover ADA). Pass ARGS="--run-id ID --from-step N --skip-singleton-burns"
	$(COMPOSE) --profile cli run --rm --entrypoint bash cli scripts/run-teardown-cli.sh $(ARGS)

.PHONY: init-router
init-router: ## Generate a router YAML from a client's JSON, interactively (feeder init router)
	$(FEEDER_RUN_IT) init router

.PHONY: checkpoint-get
checkpoint-get: ## Print the current scanner checkpoint
	$(FEEDER_RUN) checkpoint get

.PHONY: checkpoint-latest
checkpoint-latest: ## Seed the scanner checkpoint to the current chain tip (only new intents)
	$(FEEDER_RUN) checkpoint set --from-latest

.PHONY: restart
restart: ## Restart the feeder daemon with no data changes
	$(COMPOSE) --profile sqlite restart feeder-sqlite

.PHONY: restart-latest
restart-latest: ## Restart feeder + indexer skipping the backlog - reseed checkpoint to tip, keep DB + logs (MONITORING=1 opt)
	-$(COMPOSE) --profile sqlite stop feeder-sqlite
	$(FEEDER_RUN) checkpoint set --from-latest
	$(COMPOSE) --profile sqlite --profile indexer $(MON_PROFILE) up -d

.PHONY: reset
reset: ## Delete feeder runtime state (DB + logs + pairs) and exit; keeps CLI bootstrap files
	$(FEEDER_RUN) reset

.PHONY: reset-restart
reset-restart: ## Restart clean - wipe DB + logs + pairs, reseed checkpoint, start feeder + indexer (MONITORING=1 opt). Does NOT rebuild the image — use `fresh` after CODE changes.
	-$(COMPOSE) --profile sqlite stop feeder-sqlite
	$(FEEDER_RUN) reset
	$(FEEDER_RUN) checkpoint set --from-latest
	$(COMPOSE) --profile sqlite --profile indexer $(MON_PROFILE) up -d

# THE command after changing CODE (TypeScript): rebuilds the image so the new
# code actually runs, then wipes ALL runtime state for a clean slate. The
# on-chain deploy in ../state (config-bootstrap.json, clients/<id>.json) is kept.
# For config-only (YAML) changes, `reset-restart` is enough (no rebuild needed).
.PHONY: fresh
fresh: generate-monitoring ## FULL clean restart on CURRENT code — stop + wipe Prometheus/Grafana volumes, REBUILD image, wipe feeder DB+logs+pairs, reseed checkpoint, start feeder + indexer. Keeps on-chain deploy. (MONITORING=1 for Prom+Grafana)
	$(COMPOSE) --profile sqlite --profile postgres --profile cli --profile indexer --profile monitoring down --volumes --remove-orphans
	$(COMPOSE) --profile sqlite build
	$(FEEDER_RUN) reset
	$(FEEDER_RUN) checkpoint set --from-latest
	$(COMPOSE) --profile sqlite --profile indexer $(MON_PROFILE) up -d

.PHONY: prune
prune: ## Prune only OLD feeder rows/logs, keeps DB (e.g. make prune MAX_AGE=30m)
	$(FEEDER_RUN) prune $(if $(MAX_AGE),--max-age $(MAX_AGE),)

.PHONY: check-thresholds
check-thresholds: ## Fail if monitoring/ thresholds drift from infrastructure.<network>.yaml::alerting.*
	cd feeder && node --import tsx/esm --test src/config/__tests__/threshold-drift.test.ts

# Network for the evidence pack: read from feeder/.env (CARDANO_NETWORK) — the
# SAME source of truth the running feeder uses. No hardcoded default. Override
# on the CLI only if you must: make evidence EVIDENCE_NETWORK=Mainnet
EVIDENCE_NETWORK ?= $(strip $(shell sed -n 's/^CARDANO_NETWORK=//p' feeder/.env 2>/dev/null))

.PHONY: evidence
evidence: ## Build the COMPLETE M2 evidence pack into ONE dir (network from feeder/.env CARDANO_NETWORK)
	@if [ -z "$(EVIDENCE_NETWORK)" ]; then \
	  echo "ERROR: CARDANO_NETWORK not set in feeder/.env — cannot pick evidence network." >&2; exit 1; \
	fi; \
	net=$$(echo "$(EVIDENCE_NETWORK)" | tr '[:upper:]' '[:lower:]'); \
	if [ -n "$(RUN_ID)" ]; then sdir=state/$${net}_run_$(RUN_ID); \
	else sdir=$$(ls -d state/$${net}_run_*/ 2>/dev/null | sort | tail -1); sdir=$${sdir%/}; sdir=$${sdir:-state/$$net}; fi; \
	runid=$${sdir##*_run_}; [ "$$runid" = "$$sdir" ] && runid=$$(date -u +%Y%m%d-%H%M%S); \
	stamp=$$runid; base=docs/milestones/evidence/m2-$$net-$$stamp; \
	if [ -e "$$base" ]; then n=1; while [ -e "$$base-$$(printf '%02d' $$n)" ]; do n=$$((n+1)); done; stamp=$$stamp-$$(printf '%02d' $$n); fi; \
	out=docs/milestones/evidence/m2-$$net-$$stamp; \
	db=$$(pwd)/$$sdir/feeder.sqlite; \
	echo "Building $(EVIDENCE_NETWORK) COMPLETE evidence pack — stamp=$$stamp db=$$db"; \
	EVIDENCE_STAMP=$$stamp EVIDENCE_NETWORK=$$net \
	  GRAFANA_ADMIN_PASSWORD=$${GRAFANA_ADMIN_PASSWORD:-admin} \
	  feeder/scripts/m2-evidence/package-m2-evidence.sh && \
	cd feeder && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m2-evidence/build-stats.ts $$db && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m2-evidence/build-error-counts.ts $$db; \
	echo "Complete evidence pack: $$out/"

.PHONY: evidence3
evidence3: ## Build the COMPLETE M3 evidence pack into ONE dir (network from feeder/.env CARDANO_NETWORK)
	@if [ -z "$(EVIDENCE_NETWORK)" ]; then \
	  echo "ERROR: CARDANO_NETWORK not set in feeder/.env — cannot pick evidence network." >&2; exit 1; \
	fi; \
	net=$$(echo "$(EVIDENCE_NETWORK)" | tr '[:upper:]' '[:lower:]'); \
	if [ -n "$(RUN_ID)" ]; then sdir=state/$${net}_run_$(RUN_ID); \
	else sdir=$$(ls -d state/$${net}_run_*/ 2>/dev/null | sort | tail -1); sdir=$${sdir%/}; sdir=$${sdir:-state/$$net}; fi; \
	runid=$${sdir##*_run_}; [ "$$runid" = "$$sdir" ] && runid=$$(date -u +%Y%m%d-%H%M%S); \
	stamp=$$runid; base=docs/milestones/evidence/m3-$$net-$$stamp; \
	if [ -e "$$base" ]; then n=1; while [ -e "$$base-$$(printf '%02d' $$n)" ]; do n=$$((n+1)); done; stamp=$$stamp-$$(printf '%02d' $$n); fi; \
	out=docs/milestones/evidence/m3-$$net-$$stamp; \
	db=$$(pwd)/$$sdir/feeder.sqlite; \
	echo "Building $(EVIDENCE_NETWORK) COMPLETE M3 evidence pack — stamp=$$stamp db=$$db"; \
	EVIDENCE_STAMP=$$stamp EVIDENCE_NETWORK=$$net \
	  GRAFANA_ADMIN_PASSWORD=$${GRAFANA_ADMIN_PASSWORD:-admin} \
	  feeder/scripts/m3-evidence/package-m3-evidence.sh && \
	cd feeder && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m3-evidence/build-stats.ts $$db && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m3-evidence/build-error-counts.ts $$db; \
	echo "Complete M3 evidence pack: $$out/"

.PHONY: evidence4
evidence4: ## Build the M4 evidence pack (indexer + consumer demo + the 4 Grafana dashboards). Needs the stack up with monitoring (make up MONITORING=1). Pass EVIDENCE_ONCHAIN_LOG=path to embed an on-chain demo run.
	@if [ -z "$(EVIDENCE_NETWORK)" ]; then \
	  echo "ERROR: CARDANO_NETWORK not set in feeder/.env — cannot pick evidence network." >&2; exit 1; \
	fi; \
	net=$$(echo "$(EVIDENCE_NETWORK)" | tr '[:upper:]' '[:lower:]'); \
	if [ -n "$(RUN_ID)" ]; then sdir=state/$${net}_run_$(RUN_ID); \
	else sdir=$$(ls -d state/$${net}_run_*/ 2>/dev/null | sort | tail -1); sdir=$${sdir%/}; sdir=$${sdir:-state/$$net}; fi; \
	runid=$${sdir##*_run_}; [ "$$runid" = "$$sdir" ] && runid=$$(date -u +%Y%m%d-%H%M%S); \
	echo "Building $(EVIDENCE_NETWORK) M4 evidence pack — stamp=$$runid (indexer URL resolved by the packager from feeder/.env)"; \
	EVIDENCE_STAMP=$$runid EVIDENCE_NETWORK=$$net \
	  INDEXER_URL=$(INDEXER_URL) \
	  GRAFANA_ADMIN_PASSWORD=$${GRAFANA_ADMIN_PASSWORD:-admin} \
	  EVIDENCE_ONCHAIN_LOG=$${EVIDENCE_ONCHAIN_LOG:-} RUN_ID=$(RUN_ID) \
	  feeder/scripts/m4-evidence/package-m4-evidence.sh
