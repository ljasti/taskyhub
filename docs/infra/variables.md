# Variables & Precedence (Terraform + Ansible)

## Terraform Variables (Where We Set Them)
- `variables.tf`: declares variables and may include `default` values.
- `terraform.tfvars`: optional per-directory values (commonly for local testing).
- `*.auto.tfvars`: optional per-directory values loaded automatically (useful for env/customer folders).
- Environment variables: `TF_VAR_<name>=...`
- CLI flags:
  - `-var 'name=value'`
  - `-var-file=some.tfvars`

## Terraform Precedence (What Wins)
Terraform resolves conflicts using a fixed precedence order. In our repo, you will most commonly use `-var-file` or `*.auto.tfvars` in the env/customer directory. Terraform’s official precedence order is: command line `-var/-var-file` (and HCP Terraform) > `*.auto.tfvars` > `terraform.tfvars(.json)` > environment `TF_VAR_*` > `variable` defaults. [web:4]

### Example: `instance_type`
Assume `variables.tf` contains:
```hcl
variable "instance_type" {
  type    = string
  default = "t3.micro"
}
```

If you set values in multiple places:
- `terraform.tfvars`: `instance_type = "t3.small"`
- environment: `TF_VAR_instance_type=t3.medium`
- CLI: `terraform plan -var='instance_type=t3.large'`

Then Terraform uses: `t3.large` (CLI wins). [web:4]

## Ansible Variables (Where We Set Them)
In this repo, we primarily use:
- **Role defaults**: safe baseline values (lowest precedence).
- **Inventory group vars**: shared host settings (for the `tasky_servers` group).
- **Playbook `vars_files`**:
  - `infra/ansible/vault/secrets.yml` (encrypted plaintext secrets)
  - `infra/ansible/vars.yml` (customer/domain/ports defaults)
- **Facts and `set_fact`**: dynamic values computed during a run.
- **Extra vars (`-e`)**: temporary overrides at runtime (highest precedence).

## Ansible Precedence (What Wins)
Ansible has a detailed precedence order; for TaskyHub the important rule is: **extra vars (`-e`) override everything**. [web:3]

From low → high (subset we use):
- Role defaults (`roles/*/defaults/main.yml`) [web:3]
- Inventory `group_vars/` and `host_vars/` [web:3]
- Playbook `vars_files` (including vault file) [web:3]
- `set_fact` (when used) [web:3]
- Extra vars (`-e`) (highest) [web:3]

## TaskyHub Example: `tasky_app_admin_password`
- **Usually defined in Vault**:
  - `infra/ansible/vault/secrets.yml` (encrypted file loaded by playbooks).
- **Override for a one-off run** (highest precedence):
```bash
cd infra/ansible
ansible-playbook -i inventory/terraform_inventory.yml playbook.yml \
  --ask-vault-pass \
  -e "customer_name=mummy tasky_app_admin_password=TEMP_PASSWORD"
```
This does not modify the vault file; it only overrides the value for that run. [web:3]
