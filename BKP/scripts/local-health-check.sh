#!/usr/bin/env bash
set -euo pipefail

# scripts/local-health-check.sh
# Local readiness + health verification for the TaskyHub Docker Compose stack.
#
# What it checks:
# - Docker Compose services are up and report "healthy" (when healthcheck is defined)
# - HTTP endpoints respond successfully:
#   - UI:     http://localhost:8080/
#   - API:    http://localhost:4000/api/health
#   - AE/n8n: http://localhost:5678/healthz
#   - Grafana:http://localhost:3000/api/health
#
# Usage:
#   ./scripts/local-health-check.sh
#   ./scripts/local-health-check.sh /absolute/path/to/local/app
#
# Data sources:
# - local/app/docker-compose.yml defines the services and healthchecks
# - localhost ports are mapped by docker-compose.yml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-$SCRIPT_DIR/../local/app}"

if [[ ! -f "$APP_DIR/docker-compose.yml" ]]; then
  echo "ERROR: docker-compose.yml not found in $APP_DIR" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose is not available (need Docker Compose v2)" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required for HTTP health checks" >&2
  exit 1
fi

cd "$APP_DIR"

MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-120}"
SLEEP_SECONDS="${SLEEP_SECONDS:-2}"

deadline_epoch=$(( $(date +%s) + MAX_WAIT_SECONDS ))

print_header() {
  echo
  echo "================================================================================"
  echo "$1"
  echo "================================================================================"
}

wait_until() {
  local description="$1"
  shift
  local cmd=( "$@" )

  echo "- Waiting: $description (timeout ${MAX_WAIT_SECONDS}s)"
  while true; do
    if "${cmd[@]}" >/dev/null 2>&1; then
      echo "  OK: $description"
      return 0
    fi
    if (( $(date +%s) >= deadline_epoch )); then
      echo "  ERROR: Timeout waiting for $description" >&2
      return 1
    fi
    sleep "$SLEEP_SECONDS"
  done
}

service_container_id() {
  local service="$1"
  docker compose ps -q "$service" 2>/dev/null | head -n 1
}

container_health_status() {
  local container_id="$1"
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null
}

wait_service_healthy() {
  local service="$1"
  local container_id
  container_id="$(service_container_id "$service")"
  if [[ -z "$container_id" ]]; then
    echo "  ERROR: Service '$service' has no container (is it running?)" >&2
    return 1
  fi
  wait_until "service '$service' to be healthy/running" bash -lc "
    status=\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' '$container_id' 2>/dev/null || true)
    [[ \"\$status\" == \"healthy\" || \"\$status\" == \"running\" ]]
  "
}

wait_http_ok() {
  local name="$1"
  local url="$2"
  wait_until "$name ($url)" bash -lc "curl -fsS --max-time 3 '$url' >/dev/null"
}

print_header "Local Stack Status (docker compose ps)"
docker compose ps || true

print_header "Waiting for Containers"
wait_service_healthy postgres
wait_service_healthy api
wait_service_healthy ui
wait_service_healthy n8n || wait_service_healthy ae || true
wait_service_healthy grafana || true

print_header "HTTP Health Checks (localhost)"
wait_http_ok "UI" "http://localhost:8080/"
wait_http_ok "API health" "http://localhost:4000/api/health"
wait_http_ok "AE/n8n health" "http://localhost:5678/healthz"
wait_http_ok "Grafana health" "http://localhost:3000/api/health"

print_header "Summary"
echo "- UI:     http://localhost:8080/"
echo "- API:    http://localhost:4000/ (health: /api/health)"
echo "- AE/n8n: http://localhost:5678/"
echo "- Grafana:http://localhost:3000/"
echo
echo "All checks passed."

