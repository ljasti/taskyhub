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

# Deploy to a static inventory host
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/static_inventory.yml playbook.yml --ask-vault-pass -e "customer_name=mummy"
```

## Manual App Deployment (after hardening)
After `spinup.sh` completes, the inventory switches to `supertasky`. Deploy manually:

```bash
cd infra/ansible

# Full deploy (hardening is separate; this runs app deploy + nginx/certbot)
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbook.yml --limit tasky-<customer> --ask-vault-pass -e "customer_name=<customer>"
```

### Safety Net & Version Control
- **Git**: This repository is managed by Git. Always commit changes to the runbook or playbooks. If you accidentally overwrite a file, use `git restore <file_path>` to recover it.
- **VS Code Timeline**: Use the "Timeline" view in VS Code to see local history and restore previous versions of files if they weren't committed yet.

## Database Initialization Testing
To test the DB initialization for a new customer (e.g., `mummy`):

1. **Run Ansible with the customer name**:
   ```bash
   cd infra/ansible
   ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbooks/02-deploy-taskyhub.yml --limit tasky-mummy --ask-vault-pass -e "customer_name=mummy"
   ```

2. **Verify Database and Roles**:
   ```bash
   docker exec -it mummy_postgres psql -U postgres
   ```
   In `psql`:
   ```sql
   \l              -- Check if th_db_mummy exists
   \du             -- Check if th_db_mummy role exists
   
   \c th_db_mummy  -- Connect to customer DB
   
   \dt+ public.*   -- Verify tables (users, subscriptions) exist
   \dp public.users -- Check privileges for the app user
   SELECT email, role FROM users; -- Verify seeded accounts
   ```

3. **Run Health Check**:
   ```bash
   ./scripts/postdeploy-server-validation.sh mummy
   ```
   Confirm:
   - No `permission denied for table users`.
   - `AE_DB_NAME`, `AE_DB_USER`, `AE_DB_PASSWORD`: Connection details for the Automation Engine database.

## Domain & Port Configuration
The stack is fully parameterized by domain and port, allowing multiple tenants to run on different host ports or domains.

- `ui_domain`: The domain where the UI is hosted (e.g., `taskyhub.xyz`).
- `ui_port`: The host port for the UI container (default: `8080`).
- `api_domain`: The domain where the API is hosted (usually same as `ui_domain`).
- `api_port`: The host port for the API container (default: `4000`).
- `grafana_port`: The host port for Grafana (default: `3000`).

## Nginx Reverse Proxy
Nginx is used to route subdomain traffic to the correct container ports on the host.

### Configuration
Managed via [03-nginx-proxy.yml](file:///d:/workdir/taskyhub/infra/ansible/playbooks/03-nginx-proxy.yml):
- `{{ customer_name }}.{{ base_domain }}` → `localhost:{{ ui_host_port }}`
- `ae.{{ customer_name }}.{{ base_domain }}` → `localhost:{{ ae_host_port }}`

### Deployment
```bash
cd infra/ansible
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbooks/03-nginx-proxy.yml --limit tasky-mummy --ask-vault-pass -e "customer_name=mummy"
```

### DNS Setup (Manual)
You must create the following A records in your DNS provider (e.g., Route 53 or Namecheap):
1. `{{ customer_name }}.taskyhub.xyz` → `[EC2_PUBLIC_IP]`
2. `ae.{{ customer_name }}.taskyhub.xyz` → `[EC2_PUBLIC_IP]`

### How to Test
1. **UI Access**:
   Open `https://mummy.taskyhub.xyz` in your browser.
2. **AE Access**:
   Open `https://ae.mummy.taskyhub.xyz` in your browser.
3. **Verify with Curl**:
   ```bash
   curl -I https://mummy.taskyhub.xyz
   curl -I https://ae.mummy.taskyhub.xyz
   ```

### API Verification
   Check the browser's Network tab. API calls should go to `https://{{ ui_domain }}/api/...`.
4. **CORS Verification**:
   If you see CORS errors, ensure `API_ALLOWED_ORIGINS` includes `https://{{ ui_domain }}` and `https://{{ ae_domain }}`.

### Troubleshooting "permission denied for table users"
If you see this error in API logs:
1. **Check DB User vs GRANTs**:
   ```bash
   docker exec -it mummy_postgres psql -U postgres -d th_db_mummy
   ```
   Then run:
   ```sql
   \dp public.users
   ```
   Verify that the role `th_db_mummy` has `arwd` (SELECT, INSERT, UPDATE, DELETE) privileges.
2. **Verify API Environment**:
   Check the running API container's environment:
   ```bash
   docker inspect mummy_api | jq '.[0].Config.Env'
   ```
   Ensure `DB_USER` and `DB_NAME` match the intended tenant.
3. **Test API Login Manually**:
   ```bash
   curl -X POST http://localhost:4000/api/login \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@taskyhub.local","password":"your-password"}'
   ```

### If your inventory still uses `ubuntu`
If you did hardening manually (not via `spinup.sh`), update `infra/ansible/inventory/terraform_inventory.yml` so the host uses `supertasky`:

```yaml
ansible_user: supertasky
ansible_ssh_private_key_file: /path/to/your/key.pem
```

Then rerun the command above.

### Vault note (if enabled)
If you are using `infra/ansible/vault/secrets.yml` with ansible-vault encryption, ensure you always include `--ask-vault-pass` in your commands.

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
