# TaskyHub Naming Conventions

## Customer Identifiers
- **Format:** lowercase, max 10 chars, alphanumeric only
- **Examples:** `acmecorp`, `besty`, `globalinc`

## Server Users
- **SuperTasky:** `supertasky` - Super admin with sudo privileges
- **Tasky:** `tasky` - Application operator with limited sudo
- **Disabled:** `ubuntu` - Default user, disabled after hardening

## Database Users (PostgreSQL)
- **Main DB User:** `th_db_{customer}` - Example: `th_db_besty`
- **AE DB User:** `th_ae_{customer}` - Example: `th_ae_besty`
- **Grafana DB User:** `th_grafana_{customer}` - Example: `th_grafana_besty`

## Database Names
- **Main DB:** `th_db_{customer}` - Example: `th_db_besty`
- **AE DB:** `th_ae_{customer}` - Example: `th_ae_besty`
- **Grafana DB:** `th_grafana_{customer}` - Example: `th_grafana_besty`

## Application Users (TaskyHub Web App)
- Seeded users are defined by email/password variables in Ansible Vault.

## Docker Containers
- **Prefix:** `{customer}_` - Example: `besty_postgres`, `besty_ae`

## Subscription IDs
- **Format:** `sub-{customer}-{tier}` - Example: `sub-besty-premium`

## Hostnames
- **UI:** `{customer}.{base_domain}` - Example: `mummy.taskyhub.xyz`
- **AE:** `ae.{customer}.{base_domain}` - Example: `ae.mummy.taskyhub.xyz`
