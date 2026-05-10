## Color Palette & Theme Tokens

The dashboard theme is centralized in CSS variables in [dashboard.html](file:///d:/workdir/taskyhub/local/app/ui/dashboard.html#L16-L62).

- Backgrounds
  - `--bg-page`, `--bg-page-2`: page background gradient stops (light, slightly tinted)
  - `--bg-card`, `--bg-card-solid`: card surfaces (soft glass + solid)
  - `--bg-sidebar`: sidebar background (dark neutral)
- Text
  - `--text-primary`, `--text-secondary`: main/secondary text
  - `--text-sidebar`, `--text-sidebar-soft`, `--text-sidebar-muted`: sidebar text tiers
- Accents
  - `--accent-primary`, `--accent-600`: primary accent (buttons/highlights)
  - `--accent-secondary`, `--accent-secondary-600`: secondary accent (supporting highlight color)
  - `--accent-soft`, `--accent-border`: low-emphasis accent background/border
- Borders
  - `--border-subtle`, `--border-strong`: neutral borders
  - `--border`: alias used by most components (currently maps to `--border-subtle`)
- Status
  - `--status-success`, `--status-warning`, `--status-danger`

Dark mode variables are prepared via `html[data-theme="dark"]` but no UI toggle is wired yet.

## Button System

Buttons are standardized via classes in [dashboard.html](file:///d:/workdir/taskyhub/local/app/ui/dashboard.html#L632-L734):

- Base: all non-nav buttons share consistent height/padding/radius/hover/disabled behavior.
- Variants:
  - `.btn.btn-primary`: main CTAs (save/confirm/assign/create)
  - `.btn.btn-secondary`: supporting actions (test, non-destructive actions)
  - `.btn.btn-ghost`: low-emphasis actions (refresh)
  - `.btn.btn-danger`: destructive actions (cancel)
  - `.btn-sm`: compact size (tables/cards)

## DB Bootstrap / Seed Scripts

These scripts are used to initialize schemas on fresh databases and were updated to match the current app schema (plans/subscriptions/users/integrations/RBAC-related columns):

- Local Docker bootstrap
  - [init.sql](file:///d:/workdir/taskyhub/local/app/init.sql): initializes DB roles + databases, creates TaskyHub tables, seeds default plans/subscription/users.
  - [docker-compose.yml](file:///d:/workdir/taskyhub/local/app/docker-compose.yml): references `./init.sql` for Postgres init and sets `TASKY_SUBSCRIPTION_ID` to a UUID matching the seeded subscription.
- Ansible bootstrap (server)
  - [create_taskyhub_db.sql.j2](file:///d:/workdir/taskyhub/infra/ansible/templates/create_taskyhub_db.sql.j2): creates DB + role (superuser-level).
  - [init_taskyhub_schema.sql.j2](file:///d:/workdir/taskyhub/infra/ansible/templates/init_taskyhub_schema.sql.j2): creates tables/columns and seeds plans + initial users (app-user-level).
  - [init.sql.j2](file:///d:/workdir/taskyhub/infra/ansible/roles/taskyhub_deploy/templates/init.sql.j2): legacy combined initializer; updated to match the same schema so it won’t drift.
  - [init_taskyhub.sql.j2](file:///d:/workdir/taskyhub/infra/ansible/templates/init_taskyhub.sql.j2): legacy combined initializer; updated to match the same schema so it won’t drift.

## Source Of Truth

- Runtime schema “ensure” logic lives in the API server: [ensureSaasSchema](file:///d:/workdir/taskyhub/local/app/api/index.js#L537-L727).
- Bootstrap SQL scripts should bring an empty DB to a compatible baseline so runtime “ensure” does not fail on missing tables/columns.

## Regression / Smoke Checklist

These are the manual checks to run in a real environment after bootstrap:

- Integrations
  - Open Integrations → verify list loads
  - Connect OpenAI → Save → verify status updates and Test works
  - Connect Slack → OAuth redirect → verify status becomes Connected and Test works
- Subscription
  - Open Subscription → verify current plan and available plans load
  - Change plan once (admin) → confirm plan updates
- Users/Team
  - Open Users → confirm list loads without errors
- Monitoring / AE
  - Open Settings → verify Monitoring Dashboard and Workflow Console buttons open their targets

This IDE environment didn’t run containers, so the checklist above is provided as the expected regression path after applying the changes. 
