#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-$SCRIPT_DIR/../local/app}"

if [[ ! -f "$APP_DIR/docker-compose.yml" ]]; then
  echo "ERROR: docker-compose.yml not found in $APP_DIR" >&2
  exit 1
fi

echo "Using app directory: $APP_DIR"
cd "$APP_DIR"

echo "Stopping and removing previous containers, networks, and volumes..."
docker compose down -v --remove-orphans

echo "Removing stale local images built by compose (best effort)..."
docker compose rm -fsv || true

echo "Starting fresh compose stack..."
docker compose up -d --build

echo "Done. Fresh local stack is running."
