#!/usr/bin/env bash
set -euo pipefail

# local/app/local-single-shot.sh
# Single-shot local runner for TaskyHub:
# - Builds and starts the Docker Compose stack
# - Waits for service readiness (compose healthchecks + HTTP probes)
# - Prints a concise status summary for usability
#
# Run:
#   chmod +x local/app/local-single-shot.sh
#   ./local/app/local-single-shot.sh
#
# Data sources:
# - local/app/docker-compose.yml defines ports, services, and healthchecks
# - Health endpoints:
#   - UI:     http://localhost:8080/
#   - API:    http://localhost:4000/api/health
#   - AE/n8n: http://localhost:5678/healthz
#   - Grafana:http://localhost:3000/api/health

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

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

print_header "Starting Local Stack (docker compose up -d --build)"
docker compose up -d --build

print_header "Waiting for Containers (compose healthchecks)"
wait_service_healthy postgres
wait_service_healthy api
wait_service_healthy ui
wait_service_healthy n8n || true
wait_service_healthy grafana || true

print_header "HTTP Health Checks (localhost)"
wait_http_ok "UI" "http://localhost:8080/"
wait_http_ok "API health" "http://localhost:4000/api/health"
wait_http_ok "AE/n8n health" "http://localhost:5678/healthz"
wait_http_ok "Grafana health" "http://localhost:3000/api/health"

print_header "docker compose ps"
docker compose ps

print_header "Ready"
echo "- UI:     http://localhost:8080/"
echo "- API:    http://localhost:4000/ (health: /api/health)"
echo "- AE/n8n: http://localhost:5678/"
echo "- Grafana:http://localhost:3000/"

