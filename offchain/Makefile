# DIA Cardano Oracle — operator shortcuts.
# All targets delegate to docker compose running from offchain/feeder/.

COMPOSE := docker compose -f feeder/docker-compose.yml --project-directory feeder
UID ?= $(shell id -u)
GID ?= $(shell id -g)
export UID
export GID

# Monitoring toggle. Set MONITORING=1 on any "start" target to ALSO bring up
# Prometheus + Grafana + the renderer sidecar. Without it, only the feeder
# starts. One flag, consistent across up / up-postgres / restart-latest /
# reset-restart — there is no separate "up-monitoring" target.
#   make up                → feeder only
#   make up MONITORING=1   → feeder + Prometheus + Grafana + renderer
#   make down              → stops everything (feeder + monitoring)
MON_PROFILE := $(if $(MONITORING),--profile monitoring,)

# One-off feeder sub-commands run through the FEEDER binary inside the image
# (NOT dia-cli). They override the daemon command on the feeder-sqlite service
# so they share its volumes (./state, ./config) and .env. --no-deps avoids
# pulling in any other services; --rm removes the throwaway container.
FEEDER_BIN := node /app/feeder/dist/cmd/feeder/main.js --config /config
FEEDER_RUN := $(COMPOSE) --profile sqlite run --rm --no-deps feeder-sqlite $(FEEDER_BIN)
FEEDER_RUN_IT := $(COMPOSE) --profile sqlite run --rm -it --no-deps feeder-sqlite $(FEEDER_BIN)

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F: '{printf "  %-22s %s\n", $$1, $$NF}'

.PHONY: build
build: ## Build the unified feeder + CLI image
	$(COMPOSE) --profile sqlite build

.PHONY: up
up: ## Start the feeder daemon (add MONITORING=1 for Prometheus + Grafana)
	$(COMPOSE) --profile sqlite $(MON_PROFILE) up -d

.PHONY: up-postgres
up-postgres: ## Start the feeder daemon, Postgres backend (add MONITORING=1 for Prometheus + Grafana)
	$(COMPOSE) --profile postgres $(MON_PROFILE) up -d

.PHONY: down
down: ## Stop everything
	$(COMPOSE) down

.PHONY: logs
logs: ## Tail feeder logs
	$(COMPOSE) logs -f feeder-sqlite

.PHONY: cli
cli: ## Run a CLI command. Usage: make cli CMD="protocol"
	$(COMPOSE) --profile cli run --rm cli $(CMD)

.PHONY: wallet
wallet: ## Create the operator wallet
	$(COMPOSE) --profile cli run --rm cli wallet:create

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

.PHONY: init-bootstrap
init-bootstrap: ## Import config-bootstrap.json from CLI state into feeder/state (feeder init bootstrap)
	$(FEEDER_RUN) init bootstrap

.PHONY: init-client
init-client: ## Import client JSON + generate router YAML interactively (feeder init client)
	$(FEEDER_RUN_IT) init client

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
restart-latest: ## Restart skipping the backlog - reseed checkpoint to tip, keep DB + logs (MONITORING=1 opt)
	-$(COMPOSE) --profile sqlite stop feeder-sqlite
	$(FEEDER_RUN) checkpoint set --from-latest
	$(COMPOSE) --profile sqlite $(MON_PROFILE) up -d

.PHONY: reset
reset: ## Delete feeder runtime state (DB + logs + pairs) and exit; keeps CLI bootstrap files
	$(FEEDER_RUN) reset

.PHONY: reset-restart
reset-restart: ## Restart clean - wipe DB + logs + pairs, reseed checkpoint, start daemon (MONITORING=1 opt)
	-$(COMPOSE) --profile sqlite stop feeder-sqlite
	$(FEEDER_RUN) reset
	$(FEEDER_RUN) checkpoint set --from-latest
	$(COMPOSE) --profile sqlite $(MON_PROFILE) up -d

.PHONY: prune
prune: ## Prune only OLD feeder rows/logs, keeps DB (e.g. make prune MAX_AGE=30m)
	$(FEEDER_RUN) prune $(if $(MAX_AGE),--max-age $(MAX_AGE),)

# Network for the evidence pack. NETWORK=Mainnet for the Mainnet pack.
EVIDENCE_NETWORK ?= Preview

.PHONY: evidence
evidence: ## Build M2 evidence pack into ONE dir (NETWORK=Preview|Mainnet, default Preview)
	@net=$$(echo "$(EVIDENCE_NETWORK)" | tr '[:upper:]' '[:lower:]'); \
	stamp=$$(date -u +%Y%m%d-%H%M%S); \
	db=state/$$net/feeder.sqlite; \
	echo "Building $(EVIDENCE_NETWORK) evidence — stamp=$$stamp db=$$db"; \
	cd feeder && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m2-evidence/build-stats.ts $$db && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) node --import tsx/esm scripts/m2-evidence/build-error-counts.ts $$db && \
	  EVIDENCE_STAMP=$$stamp CARDANO_NETWORK=$(EVIDENCE_NETWORK) GRAFANA_ADMIN_PASSWORD=$${GRAFANA_ADMIN_PASSWORD:-admin} node --import tsx/esm scripts/m2-evidence/render-dashboards.ts; \
	echo "Evidence pack: docs/milestones/evidence/m2-$$net-$$stamp/ (all three outputs share this dir)"
