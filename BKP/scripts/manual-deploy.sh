#!/bin/bash
set -e

CUSTOMER_NAME=$1

if [ -z "$CUSTOMER_NAME" ]; then
  echo "Usage: $0 <customer_name>"
  exit 1
fi

cd infra/ansible
ansible-playbook \
  -i inventory/terraform_inventory.yml \
  playbooks/02-deploy-taskyhub.yml \
  --limit "tasky-$CUSTOMER_NAME" \
  --ask-vault-pass
