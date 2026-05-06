-- Create separate databases
CREATE DATABASE taskyhub_db;
CREATE DATABASE n8n_db;
CREATE DATABASE grafana_db;

-- Create users
CREATE USER taskyhub_user WITH PASSWORD 'taskyhub_pwd';
CREATE USER n8n_user WITH PASSWORD 'n8n_pwd';
CREATE USER grafana_user WITH PASSWORD 'grafana_pwd';

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

INSERT INTO subscriptions (id, name, seat_limit, status) VALUES
('sub-tasky-001', 'TaskyHub Basic', 2, 'active')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, subscription_id, email, password, name, role) VALUES
('1', 'sub-tasky-001', 'devops@taskyhub.local', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'DevOps Engineer', 'admin'),
('2', 'sub-tasky-001', 'developer@taskyhub.local', '$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW', 'Software Developer', 'user')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS taskyhub_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR NOT NULL,
  event_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Let's create a view in taskyhub_db that references n8n_db (for easier queries)
-- First, grant taskyhub_user access to n8n_db
GRANT CONNECT ON DATABASE n8n_db TO taskyhub_user;
GRANT USAGE, SELECT ON SCHEMA public TO taskyhub_user;

-- Now create some views and sample data
CREATE OR REPLACE VIEW v_workflows AS
SELECT id, name, active, created_at, updated_at
FROM n8n_db.public.workflow_entity;

CREATE OR REPLACE VIEW v_executions AS
SELECT 
  id,
  workflow_id,
  mode,
  status,
  started_at,
  stopped_at,
  COALESCE(EXTRACT(EPOCH FROM (stopped_at - started_at)) * 1000, 0) AS duration_ms
FROM n8n_db.public.execution_entity;

-- Insert sample taskyhub events
INSERT INTO taskyhub_events (event_type, event_data, created_at) VALUES
('workflow_execution', '{"workflow_id": 1, "status": "success", "duration_ms": 1234}', NOW() - INTERVAL '1 hour'),
('workflow_execution', '{"workflow_id": 2, "status": "success", "duration_ms": 890}', NOW() - INTERVAL '30 minutes'),
('workflow_execution', '{"workflow_id": 1, "status": "success", "duration_ms": 1567}', NOW() - INTERVAL '15 minutes'),
('user_login', '{"user_id": "1", "email": "devops@taskyhub.local"}', NOW() - INTERVAL '5 minutes');

GRANT ALL ON TABLE taskyhub_events TO taskyhub_user;
GRANT USAGE, SELECT ON SEQUENCE taskyhub_events_id_seq TO taskyhub_user;
GRANT SELECT ON v_workflows TO taskyhub_user;
GRANT SELECT ON v_executions TO taskyhub_user;

-- Also grant grafana user access to taskyhub_db tables so Grafana can query them
GRANT CONNECT ON DATABASE taskyhub_db TO grafana_user;
GRANT USAGE ON SCHEMA public TO grafana_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO grafana_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_user;

-- Let's also switch to n8n_db and insert some sample data so our dashboard has something to show!
\connect n8n_db;

-- Insert sample workflows
INSERT INTO workflow_entity (id, name, active, created_at, updated_at) VALUES
(1, 'Daily Report Generation', true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '5 minutes'),
(2, 'Customer Onboarding', true, NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 minutes'),
(3, 'Payment Processing', true, NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 minute'),
(4, 'Backup System', false, NOW() - INTERVAL '10 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Insert sample executions
INSERT INTO execution_entity (id, workflow_id, mode, status, started_at, stopped_at) VALUES
(1, 1, 'manual', 'success', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours 2 minutes'),
(2, 2, 'trigger', 'success', NOW() - INTERVAL '1 hour 30 minutes', NOW() - INTERVAL '1 hour 28 minutes'),
(3, 3, 'trigger', 'success', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '59 minutes'),
(4, 1, 'trigger', 'success', NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '44 minutes'),
(5, 3, 'trigger', 'error', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '29 minutes'),
(6, 2, 'trigger', 'success', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '19 minutes'),
(7, 3, 'trigger', 'success', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes'),
(8, 1, 'manual', 'success', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes 30 seconds')
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON workflow_entity TO taskyhub_user;
GRANT SELECT ON execution_entity TO taskyhub_user;