# compact-tools — top-level Makefile.
#
# Single entry point for build / lint / test pipelines and for the
# integration-test docker stack. Workspace tasks delegate to `yarn`
# (which delegates to turbo); docker + compactc orchestration lives
# here because Make's recipes run in /bin/sh and support `trap`,
# which yarn's built-in shell does not.

INTEGRATION_DIR := tests/integrations
COMPOSE_FILE    := $(INTEGRATION_DIR)/local-env.yml
LOGS_DIR        := $(INTEGRATION_DIR)/logs
SERVICES        := proof-server indexer node

# One marker file per fixture: Make uses mtime against the .compact
# source to decide whether a re-compile is needed, so `make compile`
# is a no-op when nothing changed (poor man's build cache, free).
COUNTER_OUT := $(INTEGRATION_DIR)/fixtures/artifacts/Counter/contract/index.js
PRIVATE_OUT := $(INTEGRATION_DIR)/fixtures/artifacts/PrivateCounter/contract/index.js

.PHONY: help \
        build test types lint lint-fix clean \
        env-up env-down env-logs env-status \
        compile test-integration

help: ## Show this help.
	@echo "compact-tools — common targets"
	@echo ""
	@echo "  Workspace tasks (delegate to yarn → turbo)"
	@echo "    make build              Build all workspace packages"
	@echo "    make test               Run unit tests"
	@echo "    make types              Type-check all packages"
	@echo "    make lint               Lint with biome"
	@echo "    make lint-fix           Lint and auto-fix"
	@echo "    make clean              Clean build artifacts"
	@echo ""
	@echo "  Integration-test docker stack"
	@echo "    make env-up             Start local Midnight stack (proof-server + indexer + node)"
	@echo "    make env-down           Stop local stack and remove volumes"
	@echo "    make env-logs           Tail all docker stack logs"
	@echo "    make env-status         Show docker container status"
	@echo ""
	@echo "  Integration-test fixtures + run"
	@echo "    make compile            Compile fixture contracts (idempotent via mtime)"
	@echo "    make test-integration   End-to-end: env-up → compile → vitest → env-down"

# ── Workspace tasks ────────────────────────────────────────────────────

build:
	yarn build

test:
	yarn test

types:
	yarn types

lint:
	yarn lint

lint-fix:
	yarn lint:fix

clean:
	yarn clean

# ── Integration-test docker stack ──────────────────────────────────────

env-up: env-down
	docker compose -f $(COMPOSE_FILE) up -d
	@mkdir -p $(LOGS_DIR)
	@for svc in $(SERVICES); do \
		docker compose -f $(COMPOSE_FILE) logs -f --no-log-prefix $$svc > $(LOGS_DIR)/$$svc.log 2>&1 & \
	done
	@echo "Logs streaming to $(LOGS_DIR)/"

env-down:
	@-pkill -f "docker compose -f $(COMPOSE_FILE) logs" 2>/dev/null || true
	docker compose -f $(COMPOSE_FILE) down -v

env-logs:
	tail -f $(LOGS_DIR)/*.log

env-status:
	docker compose -f $(COMPOSE_FILE) ps

# ── Integration-test fixtures ──────────────────────────────────────────
#
# Each fixture has an explicit file dep on its .compact source; Make
# only re-runs `compact compile` when the source is newer than the
# emitted index.js. Idempotent across repeated invocations.

compile: $(COUNTER_OUT) $(PRIVATE_OUT)

$(COUNTER_OUT): $(INTEGRATION_DIR)/fixtures/Counter.compact
	compact compile $< $(INTEGRATION_DIR)/fixtures/artifacts/Counter

$(PRIVATE_OUT): $(INTEGRATION_DIR)/fixtures/PrivateCounter.compact
	compact compile $< $(INTEGRATION_DIR)/fixtures/artifacts/PrivateCounter

# ── End-to-end integration test ────────────────────────────────────────
#
# Runs the whole pipeline in one /bin/sh invocation (note the `\`
# continuations) so the `trap` survives across the chain. Teardown
# fires on success, on any failure, and on Ctrl+C (INT / TERM).

test-integration:
	@trap '$(MAKE) env-down' EXIT INT TERM; \
		rm -rf midnight-level-db && \
		$(MAKE) env-up && \
		$(MAKE) compile && \
		yarn vitest run --config $(INTEGRATION_DIR)/vitest.config.ts
