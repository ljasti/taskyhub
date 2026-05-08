#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${1:-$SCRIPT_DIR/../terraform}"
SSH_KEY_PATH="${2:-${SSH_KEY_PATH:-}}"
ANSIBLE_USER="${3:-${ANSIBLE_USER:-ubuntu}}"
OUTPUT_FILE="${4:-$SCRIPT_DIR/inventory.ini}"

if [[ -z "$SSH_KEY_PATH" ]]; then
  echo "ERROR: SSH key path required. Pass as arg2 or set SSH_KEY_PATH env var." >&2
  exit 1
fi

INSTANCE_IP="$(terraform -chdir="$TF_DIR" output -raw instance_public_ip)"

cat > "$OUTPUT_FILE" <<EOF
[servers]
tasky-server ansible_host=$INSTANCE_IP ansible_user=$ANSIBLE_USER ansible_ssh_private_key_file=$SSH_KEY_PATH
EOF

echo "Inventory generated at $OUTPUT_FILE for $INSTANCE_IP"
