# yootri has no build step, so there is nothing here that compiles anything.
# This file exists to make the two things you actually do — serve the folder and
# run the checks CI runs — one word each, and to keep the dev URL spelled
# `localhost`, which is what makes Google sign-in work locally.
#
#   make dev              serve on http://localhost:8000/ and open a browser
#   make dev PORT=8001    when 8000 is taken
#   make dev OPEN=0       do not open a browser
#   make stop             free port 8000 (a server outlives a closed terminal)
#   make check            everything CI runs: unit tests + repo hygiene

PORT ?= 8000
OPEN ?= 1

.DEFAULT_GOAL := dev
.PHONY: dev stop test hygiene check help

## dev: serve at http://localhost:8000/ (PORT=8001 to change)
dev:
	@PORT=$(PORT) OPEN=$(OPEN) node tools/dev-server.mjs

## stop: stop whatever is serving on PORT (a dev server outlives a closed terminal)
stop:
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -z "$$pids" ]; then \
		echo "  Nothing is listening on port $(PORT)."; \
	else \
		for pid in $$pids; do \
			echo "  Stopping $$(ps -o comm= -p $$pid 2>/dev/null | xargs) (pid $$pid) on port $(PORT)."; \
		done; \
		kill $$pids; \
	fi

## test: run the engine unit tests
test:
	@npm test

## hygiene: nothing private, no credentials, no broken links
hygiene:
	@node .github/scripts/check-repo-hygiene.mjs

## check: everything CI runs, before you push
check: test hygiene

## help: list these targets
help:
	@echo
	@echo "  yootri"
	@echo
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -e 's/^## /  make /' -e 's/:/\t/' | expand -t 20
	@echo
