# DIA Cardano Oracle — operator shortcuts.
# All targets delegate to docker compose running from offchain/feeder/.

COMPOSE := docker compose -f feeder/docker-compose.yml --project-directory feeder
UID ?= $(shell id -u)
GID ?= $(shell id -g)
export UID
export GID

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F: '{printf "  %-22s %s\n", $$1, $$NF}'

.PHONY: build
build: ## Build the unified feeder + CLI image
	$(COMPOSE) --profile sqlite build

.PHONY: up
up: ## Start the feeder daemon (sqlite profile)
	$(COMPOSE) --profile sqlite up -d

.PHONY: up-postgres
up-postgres: ## Start the feeder daemon (postgres profile)
	$(COMPOSE) --profile postgres up -d

.PHONY: up-monitoring
up-monitoring: ## Start feeder + Prometheus + Grafana
	$(COMPOSE) --profile sqlite --profile monitoring up -d

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

.PHONY: router-init
router-init: ## Generate router YAML for a client (interactive)
	$(COMPOSE) --profile cli run --rm -it cli feeder init client

.PHONY: evidence
evidence: ## Build M2 evidence pack (requires running feeder + Grafana)
	cd feeder && node --import tsx/esm scripts/m2-evidence/build-stats.ts
	cd feeder && node --import tsx/esm scripts/m2-evidence/build-error-counts.ts
	cd feeder && node --import tsx/esm scripts/m2-evidence/render-dashboards.ts
	@echo "Evidence pack built. See docs/evidence/m2-*/"
