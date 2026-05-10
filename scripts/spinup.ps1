# Windows Configuration Script for TaskyHub Infrastructure Deployment
# Prerequisites: Terraform, Ansible, AWS CLI configured

param(
    [string]$ConfigFile = ".env"
)

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
    'INSTANCE_TYPE',
    'CUSTOMER_NAME',
    'UI_DOMAIN',
    'UI_PORT',
    'API_DOMAIN',
    'API_PORT',
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
Write-Host "  UI Domain: $env:UI_DOMAIN:$env:UI_PORT"
Write-Host "  API Domain: $env:API_DOMAIN:$env:API_PORT"
Write-Host "  AWS Region: $env:AWS_REGION"
Write-Host "  Instance Type: $env:INSTANCE_TYPE"

$confirmation = Read-Host "`nDo you want to proceed with deployment? (yes/no)"
if ($confirmation -ne 'yes') {
    Write-Host "Deployment cancelled." -ForegroundColor Red
    exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")

# Navigate to terraform directory
Push-Location (Join-Path $repoRoot "infra/terraform")

Write-Host "`n[1/5] Initializing Terraform..." -ForegroundColor Cyan
terraform init

Write-Host "`nClearing stale taint (if present)..." -ForegroundColor Cyan
try {
    terraform untaint aws_instance.tasky_server | Out-Null
} catch {
    # No taint present; continue.
}

Write-Host "`n[2/5] Creating terraform.auto.tfvars with your configuration..." -ForegroundColor Cyan
$tfvars = @"
aws_region           = "$env:AWS_REGION"
instance_type        = "$env:INSTANCE_TYPE"
key_pair_name        = "$env:KEY_PAIR_NAME"
ssh_private_key_path = "$env:SSH_KEY_PATH"
customer_name        = "$env:CUSTOMER_NAME"
ui_domain            = "$env:UI_DOMAIN"
ui_port               = "$env:UI_PORT"
api_domain           = "$env:API_DOMAIN"
api_port             = "$env:API_PORT"
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
Push-Location (Join-Path $repoRoot "infra/ansible")

Write-Host "`nGenerating hardening inventory..." -ForegroundColor Cyan
$inventoryPath = "inventory/terraform_inventory.yml"
$inventory = @"
all:
  children:
    tasky_servers:
      hosts:
        tasky-$env:CUSTOMER_NAME:
          ansible_host: $instance_ip
          ansible_user: ubuntu
          ansible_ssh_private_key_file: $env:SSH_KEY_PATH
          ansible_become: yes
          ansible_ssh_common_args: '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
          customer_name: $env:CUSTOMER_NAME
"@
Set-Content -Path $inventoryPath -Value $inventory

Write-Host "`nRunning security hardening..." -ForegroundColor Cyan
$env:ANSIBLE_HOST_KEY_CHECKING = "False"
ansible-playbook -i $inventoryPath playbooks/01-hardening.yml --limit "tasky-$env:CUSTOMER_NAME"

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Infrastructure + Hardening Complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
Write-Host "Instance IP: $instance_ip" -ForegroundColor Yellow
Write-Host "`nNext (manual app deployment):" -ForegroundColor Yellow
Write-Host "  cd infra/ansible"
Write-Host "  ansible-playbook -i inventory/terraform_inventory.yml playbooks/02-deploy-taskyhub.yml --limit tasky-$env:CUSTOMER_NAME"
Write-Host "`nIMPORTANT: Update your DNS to point to $instance_ip`n" -ForegroundColor Cyan

Pop-Location
