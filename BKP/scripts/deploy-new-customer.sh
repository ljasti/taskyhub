#!/bin/bash
set -e

CUSTOMER_NAME=$1

if [ -z "$CUSTOMER_NAME" ]; then
  echo "Usage: $0 <customer_name>"
  exit 1
fi

echo "========================================="
echo "Deploying TaskyHub for: $CUSTOMER_NAME"
echo "========================================="

# Step 1: Terraform
cd infra/terraform
terraform init
terraform apply \
  -var="customer_name=$CUSTOMER_NAME" \
  -auto-approve

# Step 2: Wait for provisioning to complete
echo "Waiting for Ansible hardening to complete..."
sleep 60

# Step 3: Manual deployment (if not auto-provisioned)
cd ../ansible
ansible-playbook \
  -i inventory/terraform_inventory.yml \
  playbooks/02-deploy-taskyhub.yml \
  --limit "tasky-$CUSTOMER_NAME"

echo "========================================="
echo "Deployment Complete!"
echo "========================================="
