# Setup

## Prerequisites
- AWS account + EC2 key pair
- Tools: Terraform, Ansible, AWS CLI
- A DNS zone for `<base_domain>` (example: `taskyhub.xyz`)

## Domain Scheme
- UI: `https://<customer>.<base_domain>` (example: `https://mummy.taskyhub.xyz`)
- AE: `https://ae.<customer>.<base_domain>` (example: `https://ae.mummy.taskyhub.xyz`)

## Secrets (Ansible Vault)
Create or update the encrypted vault file:
- `infra/ansible/vault/secrets.yml`
- Example keys (values must be real secrets):
  - `tasky_db_super_password`
  - `tasky_db_main_password`
  - `tasky_db_ae_password`
  - `tasky_db_grafana_password`
  - `tasky_app_jwt_secret`
  - `tasky_app_admin_email`
  - `tasky_app_admin_password`
  - `tasky_app_user_password`
  - `tasky_grafana_admin_user`
  - `tasky_grafana_admin_password`

## Configure Customer Defaults
Edit:
- `infra/ansible/vars.yml` for `base_domain`, default `customer_name`, and ports.

## Deploy (Recommended)
For per-customer Terraform usage, use the env directory:
```bash
cd infra/terraform/envs/aws/prod/mummy
terraform init
terraform plan
terraform apply
```

Then deploy the app + nginx:
```bash
cd infra/ansible
ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i inventory/terraform_inventory.yml playbook.yml --ask-vault-pass -e "customer_name=mummy"
```
