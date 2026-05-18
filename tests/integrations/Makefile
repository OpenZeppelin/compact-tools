COMPOSE_FILE := local-env.yml
LOGS_DIR := logs
SERVICES := proof-server indexer node

.PHONY: env-up env-down env-logs env-status compile

## Start local Midnight stack (proof-server + indexer + node)
env-up: env-down
	docker compose -f $(COMPOSE_FILE) up -d
	@mkdir -p $(LOGS_DIR)
	@for svc in $(SERVICES); do \
		docker compose -f $(COMPOSE_FILE) logs -f --no-log-prefix $$svc > $(LOGS_DIR)/$$svc.log 2>&1 & \
	done
	@echo "Logs streaming to $(LOGS_DIR)/"

## Stop the local stack and remove volumes
env-down:
	@-pkill -f "docker compose -f $(COMPOSE_FILE) logs" 2>/dev/null || true
	docker compose -f $(COMPOSE_FILE) down -v

## Tail all logs
env-logs:
	tail -f $(LOGS_DIR)/*.log

## Show container status
env-status:
	docker compose -f $(COMPOSE_FILE) ps

## Compile the fixture contract
compile:
	compact compile fixtures/Counter.compact fixtures/artifacts/Counter
