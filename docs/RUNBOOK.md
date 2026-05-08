# TaskyHub Operations Runbook

## Prerequisites
- Terraform >= 1.5
- Ansible >= 2.15
- SSH keys available for: `ubuntu` (initial hardening), then `supertasky` (post-hardening)
- AWS credentials configured

## New Customer Deployment

### Recommended (Terraform -> Hardening). App deploy is manual.
```bash
chmod +x scripts/spinup.sh
./scripts/spinup.sh .env
```

## Manual Deployment (Existing Infrastructure)
```bash
cd infra/ansible
ansible-playbook -i inventory/static_inventory.yml playbooks/02-deploy-taskyhub.yml
```

## Manual App Deployment (after hardening)
After `spinup.sh` completes, the inventory switches to `supertasky`. Deploy manually:

```bash
cd infra/ansible
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbooks/02-deploy-taskyhub.yml --limit tasky-<customer>
```

### If your inventory still uses `ubuntu`
If you did hardening manually (not via `spinup.sh`), update `infra/ansible/inventory/terraform_inventory.yml` so the host uses `supertasky`:

```yaml
ansible_user: supertasky
ansible_ssh_private_key_file: /path/to/your/key.pem
```

Then rerun the command above.

### Vault note (if enabled)
If you are using `infra/ansible/vault/secrets.yml` with ansible-vault encryption, run:

```bash
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbooks/02-deploy-taskyhub.yml --limit tasky-<customer> --ask-vault-pass
```

## SSH Access After Hardening
```bash
# Super admin
ssh supertasky@<server-ip>

# App operator
ssh tasky@<server-ip>

# Ubuntu user (DISABLED)
# Will not work after hardening
```

## Update Dynamic Inventory
```bash
cd infra/terraform
terraform refresh
# Inventory auto-updates in infra/ansible/inventory/terraform_inventory.yml
```

## Troubleshooting

### Reset Ubuntu User (Emergency)
```bash
ssh supertasky@<server-ip>
sudo usermod -s /bin/bash ubuntu
sudo passwd -u ubuntu
```

### Check Hardening Status
```bash
cd infra/ansible
ansible tasky_servers -i inventory/terraform_inventory.yml -m shell -a "grep supertasky /etc/passwd"
```
