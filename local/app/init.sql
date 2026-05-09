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

CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  seat_limit INT NOT NULL,
  status VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY,
  subscription_id VARCHAR REFERENCES subscriptions(id),
  email VARCHAR UNIQUE NOT NULL,
  password VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
('sub-tasky-001', 'TaskyHub Basic', 2, 'active')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, subscription_id, email, password, name, role) VALUES
('1', 'sub-tasky-001', 'devops@taskyhub.local', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'DevOps Engineer', 'admin'),
('2', 'sub-tasky-001', 'developer@taskyhub.local', '$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW', 'Software Developer', 'user')
ON CONFLICT DO NOTHING;

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
