DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taskyhub_user') THEN
    CREATE ROLE taskyhub_user LOGIN PASSWORD 'taskyhub_pwd';
  ELSE
    ALTER ROLE taskyhub_user WITH LOGIN PASSWORD 'taskyhub_pwd';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_user') THEN
    CREATE ROLE n8n_user LOGIN PASSWORD 'n8n_pwd';
  ELSE
    ALTER ROLE n8n_user WITH LOGIN PASSWORD 'n8n_pwd';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_user') THEN
    CREATE ROLE grafana_user LOGIN PASSWORD 'grafana_pwd';
  ELSE
    ALTER ROLE grafana_user WITH LOGIN PASSWORD 'grafana_pwd';
  END IF;
END
$$;

SELECT 'CREATE DATABASE taskyhub_db OWNER taskyhub_user'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'taskyhub_db') \gexec
SELECT 'CREATE DATABASE n8n_db OWNER n8n_user'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'n8n_db') \gexec
SELECT 'CREATE DATABASE grafana_db OWNER grafana_user'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'grafana_db') \gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE taskyhub_db TO taskyhub_user;
GRANT ALL PRIVILEGES ON DATABASE n8n_db TO n8n_user;
GRANT ALL PRIVILEGES ON DATABASE grafana_db TO grafana_user;

-- Connect to each database and grant schema privileges
\connect taskyhub_db;
GRANT ALL ON SCHEMA public TO taskyhub_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO taskyhub_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO taskyhub_user;

\connect n8n_db;
GRANT ALL ON SCHEMA public TO n8n_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO n8n_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO n8n_user;

\connect grafana_db;
GRANT ALL ON SCHEMA public TO grafana_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO grafana_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO grafana_user;

---------------------------------------------------
-- Switch to taskyhub_db and create app tables
---------------------------------------------------
\connect taskyhub_db;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  yearly_price_cents INTEGER,
  max_users INTEGER NOT NULL DEFAULT 1,
  max_workflows INTEGER NOT NULL DEFAULT 10,
  max_tasks INTEGER NOT NULL DEFAULT 100,
  included_runs_per_month INTEGER NOT NULL DEFAULT 0,
  overage_price_per_1000_runs INTEGER,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  seat_limit INTEGER NOT NULL DEFAULT 0,
  primary_domain TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  plan_id UUID,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_id_fkey') THEN
    ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey
    FOREIGN KEY (plan_id) REFERENCES plans(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  customer_id UUID,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_customer_id_fkey') THEN
    ALTER TABLE users
    ADD CONSTRAINT users_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES subscriptions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES subscriptions(id),
  plan_id UUID NOT NULL REFERENCES plans(id),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'active',
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 month'),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  external_billing_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_usage (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES billing_subscriptions(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  workflows_count INTEGER NOT NULL DEFAULT 0,
  tasks_count INTEGER NOT NULL DEFAULT 0,
  runs_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscription_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS subscription_history (
  id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES billing_subscriptions(id),
  actor_user_id UUID,
  from_plan_id UUID,
  to_plan_id UUID,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_invites (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES subscriptions(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  invited_by UUID,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_credentials (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES subscriptions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  integration_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  encrypted_secrets_json TEXT NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  n8n_credential_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state TEXT PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES subscriptions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  integration_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  user_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  action TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  message_internal TEXT,
  message_user TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS message_internal TEXT;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS message_user TEXT;

CREATE INDEX IF NOT EXISTS activity_logs_customer_created_at_idx
ON activity_logs (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS activity_logs_source_idx
ON activity_logs (customer_id, source_type, source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS activity_logs_severity_idx
ON activity_logs (customer_id, severity, created_at DESC);

INSERT INTO subscriptions (id, name, seat_limit, status) VALUES
('11111111-1111-1111-1111-111111111111', 'TaskyHub Workspace', 10, 'active')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  seat_limit = EXCLUDED.seat_limit,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO plans (
  id, code, name, monthly_price_cents, yearly_price_cents,
  max_users, max_workflows, max_tasks,
  included_runs_per_month, overage_price_per_1000_runs,
  description, is_active, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'FREE', 'Free', 0, NULL, 3, 25, 500, 1000, 200, 'For trying TaskyHub with a small team.', true, NOW()),
  ('00000000-0000-0000-0000-000000000002', 'STARTER', 'Starter', 1900, 19000, 3, 10, 1000, 5000, 500, 'For individuals and very small teams getting started with TaskyHub.', true, NOW()),
  ('00000000-0000-0000-0000-000000000003', 'TEAM', 'Team', 4900, 49000, 10, 25, 10000, 25000, 400, 'For small teams who need more workflows, tasks, and executions.', true, NOW()),
  ('00000000-0000-0000-0000-000000000004', 'BUSINESS', 'Business', 9900, 99000, 25, 100, 100000, 100000, 300, 'For larger teams with heavy usage and higher limits.', true, NOW())
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  monthly_price_cents = EXCLUDED.monthly_price_cents,
  yearly_price_cents = EXCLUDED.yearly_price_cents,
  max_users = EXCLUDED.max_users,
  max_workflows = EXCLUDED.max_workflows,
  max_tasks = EXCLUDED.max_tasks,
  included_runs_per_month = EXCLUDED.included_runs_per_month,
  overage_price_per_1000_runs = EXCLUDED.overage_price_per_1000_runs,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

UPDATE subscriptions
SET
  plan_id = '00000000-0000-0000-0000-000000000002'::uuid,
  current_period_start = COALESCE(current_period_start, NOW()),
  current_period_end = COALESCE(current_period_end, NOW() + INTERVAL '1 month'),
  updated_at = NOW()
WHERE id = '11111111-1111-1111-1111-111111111111'::uuid;

INSERT INTO users (
  id, subscription_id, customer_id, email, password, name, role,
  is_active, is_owner, is_super_admin, updated_at
) VALUES
  (
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'devops@taskyhub.local',
    crypt('admin123', gen_salt('bf', 10)),
    'DevOps Engineer',
    'admin',
    true,
    true,
    true,
    NOW()
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'developer@taskyhub.local',
    crypt('test123', gen_salt('bf', 10)),
    'Software Developer',
    'member',
    true,
    false,
    false,
    NOW()
  )
ON CONFLICT (email) DO UPDATE SET
  subscription_id = EXCLUDED.subscription_id,
  customer_id = EXCLUDED.customer_id,
  password = EXCLUDED.password,
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active,
  is_owner = EXCLUDED.is_owner,
  is_super_admin = EXCLUDED.is_super_admin,
  updated_at = NOW();

-- Also grant grafana user access to taskyhub_db tables so Grafana can query them
GRANT CONNECT ON DATABASE taskyhub_db TO grafana_user;
GRANT USAGE ON SCHEMA public TO grafana_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO grafana_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_user;

-- Grant taskyhub_user access to n8n_db
GRANT CONNECT ON DATABASE n8n_db TO taskyhub_user;
\connect n8n_db;
GRANT USAGE ON SCHEMA public TO taskyhub_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO taskyhub_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO taskyhub_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO taskyhub_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO taskyhub_user;
