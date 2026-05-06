#!/bin/sh
set -e

if [ -f /usr/share/nginx/html/config.template.js ]; then
  if [ -z "$API_URL" ]; then
    export API_URL="http://localhost:4000/api"
  fi
  envsubst '$API_URL' < /usr/share/nginx/html/config.template.js > /usr/share/nginx/html/config.js
fi

exec "$@"
