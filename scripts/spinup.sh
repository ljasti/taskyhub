#!/bin/bash

# TaskyHub Infrastructure Deployment Script (Bash)
# Prerequisites: Terraform, Ansible, AWS CLI configured

set -e

CONFIG_FILE="${1:-.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${CYAN}$1${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}$1${NC}"
}

print_error() {
    echo -e "${RED}$1${NC}"
}

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    print_error "Configuration file not found: $CONFIG_FILE"
    print_info "Please create $CONFIG_FILE or copy from config.env.example:"
    print_info "  cp config.env.example $CONFIG_FILE"
    exit 1
fi

print_info "Loading configuration from $CONFIG_FILE..."

# Source the config file (CRLF-safe for Windows-edited .env files)
set -a
source <(tr -d '\r' < "$CONFIG_FILE")
set +a

SUPERTASKY_KEY_PATH="${SUPERTASKY_KEY_PATH:-$SSH_KEY_PATH}"

# Validate required environment variables
required_vars=(
    'AWS_ACCESS_KEY_ID'
    'AWS_SECRET_ACCESS_KEY'
    'AWS_REGION'
    'KEY_PAIR_NAME'
    'INSTANCE_TYPE'
    'CUSTOMER_NAME'
    'UI_DOMAIN'
    'UI_PORT'
    'API_DOMAIN'
    'API_PORT'
    'N8N_PASSWORD'
    'ADMIN_PASSWORD'
    'USER_PASSWORD'
    'SSH_KEY_PATH'
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        print_error "ERROR: $var is not set in $CONFIG_FILE"
        exit 1
    fi
done

echo ""
print_info "========================================"
print_info "TaskyHub Infrastructure + Hardening Script"
print_info "========================================"
echo ""

print_warning "Configuration Details:"
echo "  Customer: $CUSTOMER_NAME"
echo "  UI Domain: $UI_DOMAIN:$UI_PORT"
echo "  API Domain: $API_DOMAIN:$API_PORT"
echo "  AWS Region: $AWS_REGION"
echo "  Instance Type: $INSTANCE_TYPE"

echo ""
read -p "Do you want to proceed with deployment? (yes/no): " confirmation
if [ "$confirmation" != "yes" ]; then
    print_error "Deployment cancelled."
    exit 0
fi

# Navigate to terraform directory
cd "$SCRIPT_DIR/../infra/terraform"

print_info ""
print_info "[1/5] Initializing Terraform..."
terraform init

print_info ""
print_info "Clearing stale taint (if present)..."
terraform untaint aws_instance.tasky_server >/dev/null 2>&1 || true

print_info ""
print_info "[2/5] Creating terraform.auto.tfvars with your configuration..."
cat > terraform.auto.tfvars << EOF
aws_region           = "$AWS_REGION"
instance_type        = "$INSTANCE_TYPE"
key_pair_name        = "$KEY_PAIR_NAME"
ssh_private_key_path = "$SSH_KEY_PATH"
customer_name        = "$CUSTOMER_NAME"
ui_domain            = "$UI_DOMAIN"
ui_port               = "$UI_PORT"
api_domain           = "$API_DOMAIN"
api_port             = "$API_PORT"
ae_admin_password    = "$N8N_PASSWORD"
admin_password       = "$ADMIN_PASSWORD"
user_password        = "$USER_PASSWORD"
EOF

print_success "terraform.auto.tfvars created"

print_info ""
print_info "[3/5] Planning Terraform deployment..."
terraform plan -out=tfplan

print_info ""
print_info "[4/5] Applying Terraform configuration..."
terraform apply -auto-approve tfplan

# Get the instance public IP (strip CR for WSL/Windows interop)
instance_ip="$(terraform output -raw instance_public_ip | tr -d '\r')"
if [ -z "$instance_ip" ]; then
    print_error "Failed to read instance_public_ip from terraform output"
    exit 1
fi
print_success "Instance provisioned with IP: $instance_ip"

# Save instance IP for later use
echo "$instance_ip" > ../INSTANCE_IP.txt

# Navigate to ansible directory
cd "$SCRIPT_DIR/../infra/ansible"

print_info ""
print_info "[5/5] Waiting for instance to be ready (60 seconds)..."
sleep 60

print_info ""
print_info "Generating hardening inventory..."

cat > inventory/terraform_inventory.yml << EOF
all:
  children:
    tasky_servers:
      hosts:
        tasky-$CUSTOMER_NAME:
          ansible_host: $instance_ip
          ansible_user: ubuntu
          ansible_ssh_private_key_file: $SSH_KEY_PATH
          ansible_become: yes
          ansible_ssh_common_args: '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
          customer_name: $CUSTOMER_NAME
EOF
print_success "Generated inventory/terraform_inventory.yml"

print_info ""
print_info "Running security hardening + user management..."
ANSIBLE_HOST_KEY_CHECKING=False ANSIBLE_ROLES_PATH="$SCRIPT_DIR/../infra/ansible/roles" ansible-playbook -i inventory/terraform_inventory.yml playbooks/01-hardening.yml --limit "tasky-$CUSTOMER_NAME"

print_info ""
print_info "Switching inventory to supertasky for manual app deployment..."
cat > inventory/terraform_inventory.yml << EOF
all:
  children:
    tasky_servers:
      hosts:
        tasky-$CUSTOMER_NAME:
          ansible_host: $instance_ip
          ansible_user: supertasky
          ansible_ssh_private_key_file: $SUPERTASKY_KEY_PATH
          ansible_become: yes
          ansible_ssh_common_args: '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
          customer_name: $CUSTOMER_NAME
EOF

echo ""
print_success "========================================"
print_success "Infrastructure + Hardening Complete!"
print_success "========================================"
echo ""

print_warning "Instance IP: $instance_ip"
print_warning "Server hardened. Ubuntu login should now be disabled."
echo ""

print_warning "Next (manual app deployment):"
echo "  cd infra/ansible"
echo "  ansible-playbook -i inventory/terraform_inventory.yml playbooks/02-deploy-taskyhub.yml --limit tasky-$CUSTOMER_NAME"
echo "  # ensure ansible_user is switched to supertasky in inventory before this step"
echo ""

print_info "IMPORTANT: Update your Namecheap DNS to point to $instance_ip"
echo ""
