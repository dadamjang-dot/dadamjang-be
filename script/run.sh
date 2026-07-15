#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-start}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

show_usage() {
  cat <<'USAGE'
usage: ./script/run.sh [mode]

Modes:
  start, run        Start the NestJS dev server (start:dev)
  prod              Start in production mode (start:prod)
  migrate           Run database migrations
  db:up             Start local PostgreSQL container
  db:down           Stop local PostgreSQL container
  lint              Run linter
  test              Run tests
  help              Show this help
USAGE
}

case "$MODE" in
  start|run)
    exec pnpm start:dev
    ;;
  prod)
    exec pnpm start:prod
    ;;
  migrate)
    exec pnpm migrate
    ;;
  db:up)
    exec pnpm db:up
    ;;
  db:down)
    exec pnpm db:down
    ;;
  lint)
    exec pnpm lint
    ;;
  test)
    exec pnpm test
    ;;
  *)
    show_usage >&2
    exit 2
    ;;
esac
