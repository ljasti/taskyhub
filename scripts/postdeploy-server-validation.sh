#!/usr/bin/env bash

set -euo pipefail

CUSTOMER_NAME="${1:-mummy}"
APP_USER="th_db_${CUSTOMER_NAME}"
APP_DB="th_db_${CUSTOMER_NAME}"
API_CONTAINER="${CUSTOMER_NAME}_api"
PG_CONTAINER="${CUSTOMER_NAME}_postgres"
LOGIN_EMAIL="admin@taskyhub.local"
LOGIN_PASSWORD="Admin123!"
APP_DB_PASSWORD="${2:-TaskyDBPass2026!}"   # from your secrets.yml

echo "=== TaskyHub health check (${CUSTOMER_NAME}) ==="

echo
echo "1) Checking containers..."
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E "${API_CONTAINER}|${PG_CONTAINER}" || {
  echo "ERROR: ${API_CONTAINER} or ${PG_CONTAINER} container not running"
  exit 1
}

echo
echo "2) Checking PostgreSQL connection and permissions (as app user)..."
docker exec -i "$PG_CONTAINER" \
  env PGPASSWORD="$APP_DB_PASSWORD" \
  psql -h localhost -p 5432 -U "$APP_USER" -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
-- Show what privileges the app user has on users/subscriptions
SELECT table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = '$APP_USER'
  AND table_name IN ('users', 'subscriptions')
ORDER BY table_name, privilege_type;

-- Try queries as app user (same as API)
SELECT * FROM users LIMIT 1;
SELECT * FROM subscriptions LIMIT 1;
SQL

echo "PostgreSQL check OK."

echo
echo "3) Checking API /login endpoint..."
HTTP_CODE=$(curl -s -o /tmp/taskyhub_login_response.json -w "%{http_code}" \
  -X POST http://localhost:4000/api/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$LOGIN_EMAIL\",\"password\":\"$LOGIN_PASSWORD\"}")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: /api/login returned HTTP $HTTP_CODE"
  echo "Response body:"
  cat /tmp/taskyhub_login_response.json
  echo
  echo "Recent API logs:"
  docker logs "$API_CONTAINER" | tail -40
  exit 1
fi

echo "API /login responded with 200 OK."
echo "Response body:"
cat /tmp/taskyhub_login_response.json
echo

echo "=== Health check PASSED ==="