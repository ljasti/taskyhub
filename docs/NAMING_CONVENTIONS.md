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
- **Main DB:** `th_app_{customer}` - Example: `th_app_besty`
- **AE DB:** `th_ae_{customer}` - Example: `th_ae_besty`
- **Grafana DB:** `th_grafana_{customer}` - Example: `th_grafana_besty`

## Application Users (TaskyHub Web App)
- **Default Admin:** `th-{customer}-admin` - Example: `th-besty-admin`
- **Default User:** `th-{customer}-user` - Example: `th-besty-user`
- **Custom Format:** `{customer_prefix}-{role}` (customizable per client)

## Docker Containers
- **Prefix:** `{customer}_` - Example: `besty_postgres`, `besty_ae`

## Subscription IDs
- **Format:** `sub-{customer}-{tier}` - Example: `sub-besty-premium`

## Hostnames
- **Format:** `tasky-{customer}.{domain}` - Example: `tasky.amroth.life`
