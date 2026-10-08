# NEXUS AI — developer commands. Run `make help` for the list.
SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND  := cd backend &&
FRONTEND := cd frontend &&

.PHONY: help setup dev migrate migration test test-backend test-frontend lint format build smoke check clean

help: ## Show available commands
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies, create .env files, apply migrations
	@./scripts/setup.sh

dev: ## Run backend (:8000) and frontend (:3000) with live reload
	@./scripts/dev.sh

migrate: ## Apply database migrations
	$(BACKEND) uv run --frozen alembic upgrade head

migration: ## Create a migration from model changes: make migration name="add projects"
	@test -n "$(name)" || (echo 'usage: make migration name="describe change"' && exit 1)
	$(BACKEND) uv run --frozen alembic revision --autogenerate -m "$(name)"

test: test-backend test-frontend ## Run all unit and integration tests

test-backend: ## Run backend tests (pytest)
	$(BACKEND) uv run --frozen pytest

test-frontend: ## Run frontend tests (vitest)
	$(FRONTEND) npm run test --silent

lint: ## Lint and type-check backend and frontend
	$(BACKEND) uv run --frozen ruff check . && uv run --frozen ruff format --check .
	$(FRONTEND) npm run lint --silent && npm run typecheck --silent

format: ## Auto-format backend code
	$(BACKEND) uv run --frozen ruff check --fix . && uv run --frozen ruff format .

build: ## Production build of the frontend
	$(FRONTEND) npm run build

smoke: ## Boot both servers and verify health end-to-end (stop `make dev` first)
	@./scripts/smoke.sh

check: lint test build smoke ## Everything CI would run

clean: ## Remove build artifacts and caches (keeps .env files and the database)
	rm -rf frontend/.next frontend/coverage .artifacts backend/.pytest_cache backend/.ruff_cache
	find backend -name __pycache__ -type d -prune -exec rm -rf {} +
