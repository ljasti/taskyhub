# TaskyHub Docs (Start Here)

## Setup
- [Setup (tools, AWS, DNS, vault)](SETUP.md)
- [Local run (Docker Compose)](LOCAL_RUN.md)

## Infra
- [Runbook (deploy, destroy, troubleshooting)](RUNBOOK.md)
- [Infrastructure architecture](INFRASTRUCTURE_ARCHITECTURE.md)
- [Naming conventions](NAMING_CONVENTIONS.md)

## App
- [Application architecture](APPLICATION_ARCHITECTURE.md)
- [Architecture diagrams](ARCHITECTURE_DIAGRAMS.md)

## Security & Passwords
- Domain scheme:
  - UI: `https://<customer>.<base_domain>` (example: `https://mummy.taskyhub.xyz`)
  - AE: `https://ae.<customer>.<base_domain>` (example: `https://ae.mummy.taskyhub.xyz`)
- Secrets live in Ansible Vault (`infra/ansible/vault/secrets.yml`) as plaintext.
- Password hashes live only in Postgres (seed/init generates hashes inside DB).

## Operations
- Deploy: [RUNBOOK.md](RUNBOOK.md)
- Destroy: [RUNBOOK.md](RUNBOOK.md)
- Reset admin password: [RUNBOOK.md](RUNBOOK.md)
