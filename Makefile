VAE_HOME ?= $(HOME)/defuss-vae
# An upstream checkout keeps the CLI under plugin/; an installed agent plugin passes VAE=<plugin>/scripts/vae.py.
VAE ?= $(VAE_HOME)/plugin/scripts/vae.py
# The example server is the only service: detached, pid in tmp/, stdout|stderr in var/log/ (both gitignored).
NAME ?= example
N ?= 50
LOG = var/log/$(NAME)
PID = tmp/$(NAME).pid
ALIVE = [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null
.DEFAULT_GOAL := help
.PHONY: help setup build lint policy test coverage e2e verify bench start stop restart status log metrics clean vae-init vae-gate release-verify browsers lock-check bench-frameworks

help: ## list available commands
	@awk -F':.*## ' '/^[a-zA-Z0-9_ -]+:.*## /{printf "  %-12s %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

setup: ## install dependencies with Bun; commit the generated lockfile before release
	@if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

build: ## build ESM, CommonJS and declarations using pkgroll
	bun run build

policy: ## enforce deterministic repository invariants
	python3 .vae/checks/policy.py

lint: build policy ## lint and strict TypeScript checking
	bun run lint
	bun run typecheck

test: build ## run real HTTP tests on both runtimes
	bun run test
	bun run test:bun

coverage: build ## enforce Node coverage thresholds and emit VAE TOTAL
	bun run coverage

browsers: ## install Chromium and WebKit for packed media tests
	bunx playwright install chromium webkit

e2e: build ## install the packed artifact and test both runtimes and browser engines
	REQUIRE_BUN=1 REQUIRE_BROWSERS=1 bun run e2e

verify: lint test coverage e2e ## complete local and CI gate

lock-check: ## require the exact Bun lockfile to be tracked and installable
	@test -f bun.lock || (echo 'Missing bun.lock; run make setup and commit the generated lockfile'; exit 1)
	@git ls-files --error-unmatch bun.lock >/dev/null
	bun install --frozen-lockfile

# The release gate's upstream packages: the published releases unless a variable names another spec or an absolute
# tarball path. $(or) also replaces an empty value, which an unset CI variable gives.
UPSTREAM = DEFUSS_RPC_PACKAGE='$(or $(DEFUSS_RPC_PACKAGE),defuss-rpc@4.1.0)' DEFUSS_MCP_PACKAGE='$(or $(DEFUSS_MCP_PACKAGE),defuss-mcp@0.6.2)' DEFUSS_O11Y_PACKAGE='$(or $(DEFUSS_O11Y_PACKAGE),defuss-o11y@0.3.0)'
release-verify: lock-check ## mandatory actual upstream protocol and browser interoperability gate
	REQUIRE_UPSTREAM=1 $(UPSTREAM) $(MAKE) verify

bench: build ## process-isolated transport benchmarks on Node and Bun
	bun run bench
	bun run bench:bun

bench-frameworks: build ## compare the common HTTP fixture contract across installed frameworks
	bun run bench:frameworks

# Own process group (setsid, else job control) so stop reaps children too.
start: build ## serve the example frontend and health endpoint on Bun, detached (make log, make stop)
	@mkdir -p var/log tmp
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; exit 0; fi; \
	if command -v setsid >/dev/null 2>&1; then nohup setsid bun examples/server.ts >$(LOG).stdout 2>$(LOG).stderr </dev/null & \
	else set -m; nohup bun examples/server.ts >$(LOG).stdout 2>$(LOG).stderr </dev/null & set +m; fi; \
	echo $$! >$(PID); sleep 1; \
	if $(ALIVE); then echo "running pid=$$(cat $(PID))"; else echo "dead; see: make log"; exit 1; fi

stop: ## SIGTERM the example server group, SIGKILL after 5 s
	@if $(ALIVE); then p=$$(cat $(PID)); kill -s TERM -- -$$p 2>/dev/null || kill -s TERM $$p; \
	i=0; while kill -0 $$p 2>/dev/null && [ $$i -lt 50 ]; do sleep 0.1; i=$$((i+1)); done; \
	kill -s KILL -- -$$p 2>/dev/null || true; fi; rm -f $(PID); echo stopped

restart: stop start ## stop, then start the example server

status: ## running | dead (stale pid) | stopped, as LSB exit codes 0 | 1 | 3
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; \
	elif [ -f $(PID) ]; then echo "dead pid=$$(cat $(PID)); see: make log"; exit 1; \
	else echo stopped; exit 3; fi

log: ## tail the example server stdout and stderr (N=50 lines)
	@for f in $(LOG).stdout $(LOG).stderr; do [ -f $$f ] && { echo "== $$f"; tail -n $(N) $$f; }; done; \
	ls $(LOG).* >/dev/null 2>&1 || echo "∅ no logs for $(NAME)"

metrics: build ## print the byte size of every built artifact
	@wc -c dist/*.mjs dist/*.cjs

clean: ## clear generated artifacts
	rm -rf dist coverage output tmp

vae-init: ## initialize project with the installed defuss-vae CLI
	python3 $(VAE) init --repo .

vae-gate: ## run the installed defuss-vae gate
	python3 $(VAE) gate --repo .
