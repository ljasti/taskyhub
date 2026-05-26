# System Requirements & Security

## Developer Tooling (Required)
- Terraform: >= 1.7
- Ansible: >= 2.16
- Node.js: >= 20 (API/UI build and local dev)
- Docker Engine + Docker Compose plugin: current stable
- AWS CLI: v2
- SSH client (OpenSSH) for connecting to EC2 and running Ansible

## Infrastructure Sizing (Typical)
- EC2 instance types (cost-friendly):
  - t3.small (x86) for general use
  - t4g.small (ARM) for cost/performance (requires compatible AMIs/images)
- Root volume:
  - 30–50 GB gp3 (Docker images + logs + Postgres data need headroom)
- Expected container usage (rule of thumb):
  - TaskyHub UI: low CPU/RAM
  - TaskyHub API: moderate CPU/RAM under load
  - Postgres: most sensitive to RAM and disk IOPS
  - AE (n8n): moderate CPU/RAM, depends on workflow volume
  - Grafana: low to moderate CPU/RAM

## Ports & Exposure
- External (Internet-facing):
  - 80/tcp: Nginx (HTTP → HTTPS redirect + ACME challenge)
  - 443/tcp: Nginx (HTTPS)
- Internal (containers / localhost on EC2):
  - TaskyHub API: 4000 (proxied via Nginx at `/api/`)
  - TaskyHub UI: 80 (proxied via Nginx as the main site)
  - AE (n8n): 5678 (proxied via Nginx on `ae.<customer>.<base_domain>`)
  - Postgres: 5432 (only for containers on the Docker network)
  - Grafana: 3000 (typically proxied or accessed privately)
- Access model:
  - Only Nginx is meant to be reachable from the public Internet.
  - App services bind to localhost on the host and/or Docker network unless explicitly exposed.

## Security Standards Implemented
- Secrets management:
  - Plaintext secrets stored in Ansible Vault (`infra/ansible/vault/secrets.yml`)
  - No bcrypt hashes stored in Vault (hashes live only in Postgres)
- Password security:
  - Application passwords are bcrypt-hashed before storing in the database
- Transport security:
  - HTTPS via Let’s Encrypt
  - Certificates include the correct hostnames (UI + AE domains)
- Access control:
  - RBAC in the app (admin vs user behavior/views)
- Database isolation:
  - Separate Postgres roles/users per database purpose (main app, AE, Grafana)
  - Least-privilege grants per role

## Security Improvements to Implement (Planned)
- Add IP restrictions (security groups, allowlists) and/or WAF in front of Nginx
- Centralized logging + alerting (API logs, Nginx access/error logs, AE logs, Postgres logs)
- Regular patching:
  - Base OS updates on EC2
  - Regular rebuilds of container images to pick up security fixes
- Harden Nginx:
  - Strong TLS settings
  - Security headers
  - Rate limiting where appropriate
- Backups + disaster recovery:
  - Automated Postgres backups (snapshots and/or logical backups)
  - Restore testing procedure
