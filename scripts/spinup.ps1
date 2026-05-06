# Windows Configuration Script for TaskyHub Infrastructure Deployment
# Prerequisites: Terraform, Ansible, AWS CLI configured

param(
    [string]$ConfigFile = ".env"
)

# Load configuration from config.env if it exists
if (Test-Path $ConfigFile) {
    Write-Host "Loading configuration from $ConfigFile..." -ForegroundColor Green
    Get-Content $ConfigFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            [Environment]::SetEnvironmentVariable($name, $value)
        }
    }
} else {
    Write-Host "Configuration file not found. Please create config.env with required variables." -ForegroundColor Red
    exit 1
}

# Validate required environment variables
$requiredVars = @(
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'KEY_PAIR_NAME',
    'CUSTOMER_NAME',
    'DOMAIN_NAME',
    'N8N_PASSWORD',
    'ADMIN_PASSWORD',
    'USER_PASSWORD',
    'SSH_KEY_PATH'
)

foreach ($var in $requiredVars) {
    if (-not (Test-Path env:$var)) {
        Write-Host "ERROR: $var is not set in config.env" -ForegroundColor Red
        exit 1
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "TaskyHub Infrastructure Deployment Script" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "Configuration Details:" -ForegroundColor Yellow
Write-Host "  Customer: $env:CUSTOMER_NAME"
Write-Host "  Domain: $env:DOMAIN_NAME"
Write-Host "  AWS Region: $env:AWS_REGION"
Write-Host "  Instance Type: $env:INSTANCE_TYPE"

$confirmation = Read-Host "`nDo you want to proceed with deployment? (yes/no)"
if ($confirmation -ne 'yes') {
    Write-Host "Deployment cancelled." -ForegroundColor Red
    exit 0
}

# Navigate to terraform directory
Push-Location ../infra/terraform

Write-Host "`n[1/5] Initializing Terraform..." -ForegroundColor Cyan
terraform init

Write-Host "`n[2/5] Creating terraform.auto.tfvars with your configuration..." -ForegroundColor Cyan
$tfvars = @"
aws_region           = "$env:AWS_REGION"
key_pair_name        = "$env:KEY_PAIR_NAME"
customer_name        = "$env:CUSTOMER_NAME"
domain_name          = "$env:DOMAIN_NAME"
n8n_admin_password   = "$env:N8N_PASSWORD"
admin_password       = "$env:ADMIN_PASSWORD"
user_password        = "$env:USER_PASSWORD"
"@
Set-Content -Path "terraform.auto.tfvars" -Value $tfvars

Write-Host "`n[3/5] Planning Terraform deployment..." -ForegroundColor Cyan
terraform plan -out=tfplan

Write-Host "`n[4/5] Applying Terraform configuration..." -ForegroundColor Cyan
terraform apply -auto-approve tfplan

# Get the instance public IP
$instance_ip = terraform output -raw instance_public_ip
Write-Host "`nInstance provisioned with IP: $instance_ip" -ForegroundColor Green

# Save instance IP for later use
$instance_ip | Out-File -FilePath "../INSTANCE_IP.txt"

Pop-Location

# Wait for instance to be ready
Write-Host "`n[5/5] Waiting for instance to be ready (60 seconds)..." -ForegroundColor Cyan
Start-Sleep -Seconds 60

# Navigate to ansible directory
Push-Location ../infra/ansible

Write-Host "`nUpdating Ansible configuration..." -ForegroundColor Cyan

# Update inventory.ini with the instance IP
(Get-Content inventory.ini) -replace '<INSTANCE_PUBLIC_IP>', $instance_ip | Set-Content inventory.ini

# Update ansible.cfg SSH key path
(Get-Content ansible.cfg) -replace '~/.ssh/your-key-pair.pem', $env:SSH_KEY_PATH | Set-Content ansible.cfg

# Update vars.yml with customer configuration
$varsyml = @"
---
customer_name: $env:CUSTOMER_NAME
domain_name: $env:DOMAIN_NAME

n8n_admin_user: admin
n8n_admin_password: $env:N8N_PASSWORD
n8n_timezone: Asia/Kolkata

admin_username: admin
admin_password: $env:ADMIN_PASSWORD
user_username: user
user_password: $env:USER_PASSWORD

app_base_path: "/opt/$env:CUSTOMER_NAME"
n8n_path: "/opt/$env:CUSTOMER_NAME/n8n"
ui_path: "/opt/$env:CUSTOMER_NAME/ui"
data_path: "/opt/$env:CUSTOMER_NAME/data"
"@
Set-Content -Path "vars.yml" -Value $varsyml

Write-Host "Running Ansible playbook to configure server..." -ForegroundColor Cyan
ansible-playbook playbook.yml -i inventory.ini

Pop-Location

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
Write-Host "Instance IP: $instance_ip" -ForegroundColor Yellow
Write-Host "Access Application: https://$env:DOMAIN_NAME" -ForegroundColor Yellow
Write-Host "`nCredentials:" -ForegroundColor Yellow
Write-Host "  Admin: admin / $env:ADMIN_PASSWORD"
Write-Host "  User: user / $env:USER_PASSWORD"
Write-Host "`nn8n Access:" -ForegroundColor Yellow
Write-Host "  URL: https://$env:DOMAIN_NAME/n8n"
Write-Host "  User: admin / $env:N8N_PASSWORD"
Write-Host "`nIMPORTANT: Update your Namecheap DNS to point to $instance_ip`n" -ForegroundColor Cyan