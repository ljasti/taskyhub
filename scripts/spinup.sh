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

# Source the config file
set -a
source "$CONFIG_FILE"
set +a

# Validate required environment variables
required_vars=(
    'AWS_ACCESS_KEY_ID'
    'AWS_SECRET_ACCESS_KEY'
    'AWS_REGION'
    'KEY_PAIR_NAME'
    'CUSTOMER_NAME'
    'DOMAIN_NAME'
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
print_info "TaskyHub Infrastructure Deployment Script"
print_info "========================================"
echo ""

print_warning "Configuration Details:"
echo "  Customer: $CUSTOMER_NAME"
echo "  Domain: $DOMAIN_NAME"
echo "  AWS Region: $AWS_REGION"
echo "  Instance Type: ${INSTANCE_TYPE:-t3.medium}"

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
print_info "[2/5] Creating terraform.auto.tfvars with your configuration..."
cat > terraform.auto.tfvars << EOF
aws_region           = "$AWS_REGION"
key_pair_name        = "$KEY_PAIR_NAME"
customer_name        = "$CUSTOMER_NAME"
domain_name          = "$DOMAIN_NAME"
n8n_admin_password   = "$N8N_PASSWORD"
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

# Get the instance public IP
instance_ip=$(terraform output -raw instance_public_ip)
print_success "Instance provisioned with IP: $instance_ip"

# Save instance IP for later use
echo "$instance_ip" > ../INSTANCE_IP.txt

# Navigate to ansible directory
cd "$SCRIPT_DIR/../infra/ansible"

print_info ""
print_info "[5/5] Waiting for instance to be ready (60 seconds)..."
sleep 60

print_info ""
print_info "Updating Ansible configuration..."

# Update inventory.ini with the instance IP
sed -i "s/<INSTANCE_PUBLIC_IP>/$instance_ip/g" inventory.ini
print_success "Updated inventory.ini"

# Update ansible.cfg SSH key path (escape backslashes for sed)
ssh_key_escaped=$(echo "$SSH_KEY_PATH" | sed 's/[\/&]/\\&/g')
sed -i "s|~/.ssh/your-key-pair.pem|$ssh_key_escaped|g" ansible.cfg
print_success "Updated ansible.cfg"

# Update vars.yml with customer configuration
cat > vars.yml << EOF
---
customer_name: $CUSTOMER_NAME
domain_name: $DOMAIN_NAME

n8n_admin_user: admin
n8n_admin_password: $N8N_PASSWORD
n8n_timezone: Asia/Kolkata

admin_username: admin
admin_password: $ADMIN_PASSWORD
user_username: user
user_password: $USER_PASSWORD

app_base_path: "/opt/$CUSTOMER_NAME"
n8n_path: "/opt/$CUSTOMER_NAME/n8n"
ui_path: "/opt/$CUSTOMER_NAME/ui"
data_path: "/opt/$CUSTOMER_NAME/data"
EOF

print_success "Generated vars.yml"

print_info ""
print_info "Running Ansible playbook to configure server..."
ansible-playbook playbook.yml -i inventory.ini

echo ""
print_success "========================================"
print_success "Deployment Complete!"
print_success "========================================"
echo ""

print_warning "Instance IP: $instance_ip"
print_warning "Access Application: https://$DOMAIN_NAME"
echo ""

print_warning "Credentials:"
echo "  Admin: admin / $ADMIN_PASSWORD"
echo "  User: user / $USER_PASSWORD"
echo ""

print_warning "n8n Access:"
echo "  URL: https://$DOMAIN_NAME/n8n"
echo "  User: admin / $N8N_PASSWORD"
echo ""

print_info "IMPORTANT: Update your Namecheap DNS to point to $instance_ip"
echo ""
