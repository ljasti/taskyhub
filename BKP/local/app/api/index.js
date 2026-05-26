const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const fsp = require('fs/promises');
const {
  FAILED_EXECUTION_STATUSES,
  normalizeFailureDetails,
  truncateErrorMessage,
  computeWorkflowHealth,
  toNumber,
} = require('./dashboard-utils');

const app = express();
let apiReady = false;

// Security: Set security-related HTTP headers
app.use(helmet());

// Security: Rate limiting to prevent brute-force attacks
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

app.use('/api/', (req, res, next) => {
  if (apiReady) return next();
  if (req.path === '/health') return next();
  return res.status(503).json({ success: false, error: 'Backend is initializing. Please retry in a moment.' });
});

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskyhub-secret';
const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:3000';
const AE_INTERNAL_URL = process.env.AE_INTERNAL_URL || process.env.AE_URL || process.env.N8N_URL || 'http://localhost:5678';
const AE_PUBLIC_URL = process.env.AE_PUBLIC_URL || AE_INTERNAL_URL;
const N8N_PATH_PREFIX = (process.env.TASKY_N8N_PATH_PREFIX || '/ae').trim() || '';
const N8N_API_KEY = (process.env.TASKY_N8N_API_KEY || '').trim();
const N8N_BASIC_AUTH_USER = (process.env.TASKY_N8N_BASIC_AUTH_USER || '').trim();
const N8N_BASIC_AUTH_PASSWORD = process.env.TASKY_N8N_BASIC_AUTH_PASSWORD || '';
const INTEGRATIONS_ENCRYPTION_KEY_B64 = (process.env.TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64 || '').trim();
const TASKY_PUBLIC_URL = (process.env.TASKY_PUBLIC_URL || '').trim();
const TASKY_SLACK_CLIENT_ID = (process.env.TASKY_SLACK_CLIENT_ID || '').trim();
const TASKY_SLACK_CLIENT_SECRET = process.env.TASKY_SLACK_CLIENT_SECRET || '';
const TASKY_SLACK_SCOPES = (process.env.TASKY_SLACK_SCOPES || 'chat:write,channels:read,groups:read,im:read,mpim:read').trim();
const GRAFANA_DASHBOARD_UID = 'taskyhub-overview';
const TASKY_ADMIN_EMAIL = (process.env.TASKY_ADMIN_EMAIL || '').trim();
const TASKY_ADMIN_PASSWORD = process.env.TASKY_ADMIN_PASSWORD || '';
const TASKY_ADMIN_NAME = (process.env.TASKY_ADMIN_NAME || 'DevOps Engineer').trim();
const TASKY_ADMIN_ROLE = (process.env.TASKY_ADMIN_ROLE || 'admin').trim();
const TASKY_ADMIN_IS_SUPER_ADMIN = String(process.env.TASKY_ADMIN_IS_SUPER_ADMIN || 'true').trim().toLowerCase() === 'true';
const TASKY_USER_EMAIL = (process.env.TASKY_USER_EMAIL || '').trim();
const TASKY_USER_PASSWORD = process.env.TASKY_USER_PASSWORD || '';
const TASKY_USER_NAME = (process.env.TASKY_USER_NAME || 'Developer').trim();
const TASKY_USER_ROLE = (process.env.TASKY_USER_ROLE || 'user').trim();
const TASKY_SUBSCRIPTION_ID = (process.env.TASKY_SUBSCRIPTION_ID || '').trim();
const SUPER_ADMIN_EMAILS = (process.env.TASKY_SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const isSuperAdminEmail = (email) => SUPER_ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());

let schemaCaps = {
  tables: {
    plans: false,
    billing_subscriptions: false,
    subscription_usage: false,
    subscription_history: false,
    user_invites: false,
  },
  users: {
    has_customer_id: false,
    has_is_active: false,
    has_last_login_at: false,
    has_is_super_admin: false,
    has_is_owner: false,
    has_updated_at: false,
  },
  subscriptions: {
    has_primary_domain: false,
    has_status: false,
    has_updated_at: false,
  },
};

function integrationsEncryptionConfigured() {
  return Boolean(INTEGRATIONS_ENCRYPTION_KEY_B64);
}

function n8nApiConfigured() {
  return Boolean(N8N_API_KEY) || (Boolean(N8N_BASIC_AUTH_USER) && Boolean(N8N_BASIC_AUTH_PASSWORD));
}

function getPricingPlanSeeds() {
  return [
    {
      code: 'FREE',
      name: 'Free',
      monthly: 0,
      yearly: null,
      maxUsers: 3,
      maxWorkflows: 25,
      maxTasks: 500,
      includedRuns: 1000,
      overage: 200,
      description: 'For trying TaskyHub with a small team.',
      active: true,
    },
    {
      code: 'STARTER',
      name: 'Starter',
      monthly: 1900,
      yearly: 1900 * 10,
      maxUsers: 3,
      maxWorkflows: 10,
      maxTasks: 1000,
      includedRuns: 5000,
      overage: 500,
      description: 'For individuals and very small teams getting started with TaskyHub.',
      active: true,
    },
    {
      code: 'TEAM',
      name: 'Team',
      monthly: 4900,
      yearly: 4900 * 10,
      maxUsers: 10,
      maxWorkflows: 25,
      maxTasks: 10000,
      includedRuns: 25000,
      overage: 400,
      description: 'For small teams who need more workflows, tasks, and executions.',
      active: true,
    },
    {
      code: 'BUSINESS',
      name: 'Business',
      monthly: 9900,
      yearly: 9900 * 10,
      maxUsers: 25,
      maxWorkflows: 100,
      maxTasks: 100000,
      includedRuns: 100000,
      overage: 300,
      description: 'For larger teams with heavy usage and higher limits.',
      active: true,
    },
  ];
}

function validateSeatLimit({ currentUsersCount, seatLimit }) {
  const used = Number(currentUsersCount || 0);
  const limit = Number(seatLimit || 0);
  if (!Number.isFinite(used) || used < 0) return 'Seat limit reached for your subscription plan.';
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (used >= limit) return 'Seat limit reached for your subscription plan.';
  return '';
}

function validatePlanChangeUserCount({ currentUsersCount, planMaxUsers }) {
  const used = Number(currentUsersCount || 0);
  const limit = Number(planMaxUsers || 0);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (used > limit) {
    return `You have ${used} users but the selected plan allows only ${limit}. Please remove users or choose a higher plan.`;
  }
  return '';
}

function requireIntegrationsEncryptionKey() {
  if (!INTEGRATIONS_ENCRYPTION_KEY_B64) {
    throw new Error('TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64 is not set');
  }
  let key;
  try {
    key = Buffer.from(INTEGRATIONS_ENCRYPTION_KEY_B64, 'base64');
  } catch (_e) {
    throw new Error('TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64 must be base64');
  }
  if (key.length !== 32) {
    throw new Error('TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64 must decode to 32 bytes (AES-256)');
  }
  return key;
}

function encryptSecretsJson(secrets) {
  const key = requireIntegrationsEncryptionKey();
  const { randomBytes, createCipheriv } = require('crypto');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets ?? {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  });
}

function decryptSecretsJson(encryptedJson) {
  const key = requireIntegrationsEncryptionKey();
  const { createDecipheriv } = require('crypto');
  const blob = JSON.parse(String(encryptedJson || ''));
  if (!blob || blob.v !== 1 || blob.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted secrets format');
  }
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function getPublicBaseUrl(req) {
  if (TASKY_PUBLIC_URL) return TASKY_PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function getN8nBaseUrlInternal() {
  const base = String(AE_INTERNAL_URL || '').trim().replace(/\/+$/, '');
  const prefix = String(N8N_PATH_PREFIX || '').trim();
  const normalizedPrefix = prefix && prefix !== '/' ? `/${prefix.replace(/^\/+/, '').replace(/\/+$/, '')}` : '';
  return `${base}${normalizedPrefix}`;
}

function buildN8nAuthHeaders() {
  if (N8N_API_KEY) {
    return { 'X-N8N-API-KEY': N8N_API_KEY };
  }
  if (N8N_BASIC_AUTH_USER && N8N_BASIC_AUTH_PASSWORD) {
    const token = Buffer.from(`${N8N_BASIC_AUTH_USER}:${N8N_BASIC_AUTH_PASSWORD}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

async function n8nFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const url = `${getN8nBaseUrlInternal()}${path.startsWith('/') ? path : `/${path}`}`;
  const authHeaders = buildN8nAuthHeaders();
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders,
      ...headers,
    },
    body,
  });
  return res;
}

async function n8nCreateOrUpdateCredential({ n8nCredentialId, name, type, data }) {
  if (!name || !type || !data || typeof data !== 'object') {
    throw new Error('Invalid n8n credential payload');
  }

  if (N8N_API_KEY) {
    const path = n8nCredentialId ? `/api/v1/credentials/${encodeURIComponent(n8nCredentialId)}` : '/api/v1/credentials';
    const method = n8nCredentialId ? 'PATCH' : 'POST';
    const payload = {
      name,
      type,
      data,
      nodesAccess: [{ nodeType: '*' }],
    };
    const res = await n8nFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`n8n credentials API error ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }

  if (N8N_BASIC_AUTH_USER && N8N_BASIC_AUTH_PASSWORD) {
    const path = n8nCredentialId ? `/rest/credentials/${encodeURIComponent(n8nCredentialId)}` : '/rest/credentials';
    const method = n8nCredentialId ? 'PATCH' : 'POST';
    const payload = {
      name,
      type,
      data,
      nodesAccess: [{ nodeType: '*' }],
    };
    const res = await n8nFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`n8n rest credentials error ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }

  throw new Error('n8n auth not configured: set TASKY_N8N_API_KEY or TASKY_N8N_BASIC_AUTH_USER/PASSWORD');
}

// Helper to sanitize AE_URL for proxying
const getAeBaseUrl = () => {
  let url = AE_PUBLIC_URL;
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
};

app.use(express.json());

const allowedOrigins = (process.env.API_ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const allowedOriginHosts = allowedOrigins
  .filter((o) => o !== '*')
  .map((o) => {
    try {
      return new URL(o).hostname;
    } catch (_e) {
      return null;
    }
  })
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        try {
          const parsed = new URL(origin);
          const protocolOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
          if (protocolOk && allowedOriginHosts.includes(parsed.hostname)) {
            return callback(null, true);
          }
        } catch (_e) {
        }
        console.warn(`CORS blocked for origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  })
);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const aePool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.AE_DB_NAME || process.env.N8N_DB_NAME,
  user: process.env.AE_DB_USER || process.env.N8N_DB_USER,
  password: process.env.AE_DB_PASSWORD || process.env.N8N_DB_PASSWORD,
});

// Middleware to log API requests (debugging)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

function generateToken(user) {
  const customerId = user.customer_id || user.subscription_id || user.subscriptionId || '';
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    subscriptionId: customerId,
    customerId,
    isSuperAdmin: Boolean(user.is_super_admin) || isSuperAdminEmail(user.email),
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

function isAllowedDemoLogin(email, password) {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  const normalizedEmail = String(email || '').toLowerCase();
  return (
    (normalizedEmail === 'devops@taskyhub.local' && password === 'admin123') ||
    (normalizedEmail === 'developer@taskyhub.local' && password === 'test123')
  );
}

async function ensureBootstrapAdminUserOnce() {
  if (!TASKY_ADMIN_EMAIL) {
    return true;
  }
  if (!TASKY_ADMIN_PASSWORD) {
    console.warn('Admin bootstrap skipped: TASKY_ADMIN_PASSWORD is not set');
    return true;
  }

  try {
    const subscriptionId = await resolveBootstrapSubscriptionId(TASKY_SUBSCRIPTION_ID);
    if (!subscriptionId) {
      console.warn('Admin bootstrap skipped: no subscription found');
      return true;
    }

    await upsertBootstrapUser({
      subscriptionId,
      email: TASKY_ADMIN_EMAIL,
      password: TASKY_ADMIN_PASSWORD,
      name: TASKY_ADMIN_NAME,
      role: TASKY_ADMIN_ROLE,
      label: 'Admin',
    });
    return true;
  } catch (err) {
    console.error('Admin bootstrap failed:', err.message || err);
    return false;
  }
}

async function resolveBootstrapSubscriptionId(preferredId) {
  let subscriptionId = preferredId;
  if (subscriptionId) {
    const check = await pool.query('SELECT id FROM subscriptions WHERE id = $1 LIMIT 1', [subscriptionId]);
    if (check.rows.length === 0) {
      subscriptionId = '';
    }
  }

  if (!subscriptionId) {
    const fallback = await pool.query('SELECT id FROM subscriptions ORDER BY created_at ASC LIMIT 1');
    subscriptionId = fallback.rows[0]?.id;
  }

  return subscriptionId || '';
}

async function upsertBootstrapUser({ subscriptionId, email, password, name, role, label }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const isSuperAdmin = label === 'Admin' ? TASKY_ADMIN_IS_SUPER_ADMIN || isSuperAdminEmail(email) : false;
  const useExtended =
    schemaCaps.users.has_customer_id &&
    schemaCaps.users.has_is_active &&
    schemaCaps.users.has_is_super_admin &&
    schemaCaps.users.has_updated_at;

  if (useExtended) {
    await pool.query(
      `
        INSERT INTO users (id, subscription_id, customer_id, email, password, name, role, is_active, is_super_admin, updated_at)
        VALUES ($1, $2, $2, $3, $4, $5, $6, true, $7, NOW())
        ON CONFLICT (email)
        DO UPDATE SET
          subscription_id = EXCLUDED.subscription_id,
          customer_id = EXCLUDED.customer_id,
          password = EXCLUDED.password,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          is_active = EXCLUDED.is_active,
          is_super_admin = EXCLUDED.is_super_admin,
          updated_at = NOW()
      `,
      [randomUUID(), subscriptionId, email, passwordHash, name, role, isSuperAdmin]
    );
  } else {
    await pool.query(
      `
        INSERT INTO users (id, subscription_id, email, password, name, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email)
        DO UPDATE SET
          subscription_id = EXCLUDED.subscription_id,
          password = EXCLUDED.password,
          name = EXCLUDED.name,
          role = EXCLUDED.role
      `,
      [randomUUID(), subscriptionId, email, passwordHash, name, role]
    );
  }
  console.log(`${label} bootstrap ensured user exists: ${email}`);
}

async function ensureBootstrapUserOnce(subscriptionId) {
  if (!TASKY_USER_EMAIL) {
    return true;
  }
  if (!TASKY_USER_PASSWORD) {
    console.warn('User bootstrap skipped: TASKY_USER_PASSWORD is not set');
    return true;
  }

  try {
    if (!subscriptionId) {
      console.warn('User bootstrap skipped: no subscription found');
      return true;
    }

    await upsertBootstrapUser({
      subscriptionId,
      email: TASKY_USER_EMAIL,
      password: TASKY_USER_PASSWORD,
      name: TASKY_USER_NAME,
      role: TASKY_USER_ROLE,
      label: 'User',
    });
    return true;
  } catch (err) {
    console.error('User bootstrap failed:', err.message || err);
    return false;
  }
}

async function ensureSaasSchema() {
  const safeQuery = async (sql, params) => {
    try {
      await pool.query(sql, params);
      return true;
    } catch (err) {
      console.error('Schema ensure skipped:', err.message || err);
      return false;
    }
  };

  await safeQuery('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS primary_domain TEXT;`);
  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_id UUID;`);
  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;`);
  await safeQuery(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;`);
  await safeQuery(`UPDATE subscriptions SET status = 'active' WHERE status IS NULL OR status = '';`);
  await safeQuery(`UPDATE subscriptions SET updated_at = NOW() WHERE updated_at IS NULL;`);

  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_id UUID;`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';`);
  await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;`);
  await safeQuery(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';`);
  await safeQuery(`UPDATE users SET customer_id = subscription_id WHERE customer_id IS NULL;`);
  await safeQuery(`UPDATE users SET role = 'member' WHERE role IS NULL OR role = '' OR LOWER(role) IN ('user','developer');`);

  await safeQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_customer_id_fkey') THEN
          ALTER TABLE users
          ADD CONSTRAINT users_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES subscriptions(id);
        END IF;
      END $$;
    `);

  await safeQuery(`
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
    `);

  await safeQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_id_fkey') THEN
          ALTER TABLE subscriptions
          ADD CONSTRAINT subscriptions_plan_id_fkey
          FOREIGN KEY (plan_id) REFERENCES plans(id);
        END IF;
      END $$;
    `);

  await safeQuery(`
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
    `);

  await safeQuery(`
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
    `);

  await safeQuery(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id UUID PRIMARY KEY,
        subscription_id UUID NOT NULL REFERENCES billing_subscriptions(id),
        actor_user_id UUID,
        from_plan_id UUID,
        to_plan_id UUID,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

  await safeQuery(`
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
    `);

  await safeQuery(`
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
    `);

  await safeQuery(`
      CREATE TABLE IF NOT EXISTS integration_oauth_states (
        state TEXT PRIMARY KEY,
        customer_id UUID NOT NULL REFERENCES subscriptions(id),
        user_id UUID NOT NULL REFERENCES users(id),
        integration_type TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

  const planSeeds = getPricingPlanSeeds();

  for (const plan of planSeeds) {
    const seeded = await safeQuery(
      `
      INSERT INTO plans (
        id, code, name, monthly_price_cents, yearly_price_cents,
        max_users, max_workflows, max_tasks,
        included_runs_per_month, overage_price_per_1000_runs,
        description, is_active, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (code)
      DO UPDATE SET
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
        updated_at = NOW()
      `,
      [
        randomUUID(),
        plan.code,
        plan.name,
        plan.monthly,
        plan.yearly,
        plan.maxUsers,
        plan.maxWorkflows,
        plan.maxTasks,
        plan.includedRuns,
        plan.overage,
        plan.description,
        plan.active,
      ]
    );
    if (!seeded) break;
  }

  try {
    const freePlan = await pool.query(`SELECT id FROM plans WHERE code = 'FREE' LIMIT 1`);
    const freePlanId = freePlan.rows[0]?.id;
    if (freePlanId) {
      const customers = await pool.query(`SELECT id FROM subscriptions`);
      for (const customer of customers.rows) {
        const existing = await pool.query(
          `
          SELECT id FROM billing_subscriptions
          WHERE customer_id = $1 AND status IN ('trialing','active','past_due')
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [customer.id]
        );
        if (existing.rows.length > 0) continue;
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        await pool.query(
          `
          INSERT INTO billing_subscriptions (
            id, customer_id, plan_id, billing_cycle, status,
            current_period_start, current_period_end,
            cancel_at_period_end, created_at, updated_at
          )
          VALUES ($1, $2, $3, 'monthly', 'active', $4, $5, false, NOW(), NOW())
          `,
          [randomUUID(), customer.id, freePlanId, now.toISOString(), periodEnd.toISOString()]
        );
      }
    }
  } catch (err) {
    console.error('Billing seed skipped:', err.message || err);
  }
}

async function refreshSchemaCaps() {
  const next = {
    tables: { ...schemaCaps.tables },
    users: { ...schemaCaps.users },
    subscriptions: { ...schemaCaps.subscriptions },
  };

  try {
    const tablesResult = await pool.query(`
      SELECT
        to_regclass('public.plans') IS NOT NULL AS plans,
        to_regclass('public.billing_subscriptions') IS NOT NULL AS billing_subscriptions,
        to_regclass('public.subscription_usage') IS NOT NULL AS subscription_usage,
        to_regclass('public.subscription_history') IS NOT NULL AS subscription_history,
        to_regclass('public.user_invites') IS NOT NULL AS user_invites
    `);
    const row = tablesResult.rows[0] || {};
    next.tables.plans = Boolean(row.plans);
    next.tables.billing_subscriptions = Boolean(row.billing_subscriptions);
    next.tables.subscription_usage = Boolean(row.subscription_usage);
    next.tables.subscription_history = Boolean(row.subscription_history);
    next.tables.user_invites = Boolean(row.user_invites);
  } catch (_e) {
  }

  try {
    const cols = await pool.query(
      `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'users' AND column_name IN ('customer_id','is_active','is_owner','last_login_at','is_super_admin','updated_at'))
          OR
          (table_name = 'subscriptions' AND column_name IN ('primary_domain','status','updated_at'))
        )
      `
    );
    for (const c of cols.rows) {
      if (c.table_name === 'users') {
        next.users[`has_${c.column_name}`] = true;
      }
      if (c.table_name === 'subscriptions') {
        next.subscriptions[`has_${c.column_name}`] = true;
      }
    }
  } catch (_e) {
  }

  schemaCaps = next;
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      error: 'Missing authorization token' 
    });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const userCols = ['id', 'email', 'role', 'name', 'subscription_id'];
    if (schemaCaps.users.has_customer_id) userCols.push('customer_id');
    if (schemaCaps.users.has_is_active) userCols.push('is_active');
    if (schemaCaps.users.has_is_super_admin) userCols.push('is_super_admin');
    if (schemaCaps.users.has_last_login_at) userCols.push('last_login_at');
    if (schemaCaps.users.has_is_owner) userCols.push('is_owner');
    const userResult = await pool.query(`SELECT ${userCols.join(', ')} FROM users WHERE id = $1`, [decoded.id]);
    const userRow = userResult.rows[0];
    if (!userRow) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }
    if (schemaCaps.users.has_is_active && userRow.is_active === false) {
      return res.status(403).json({ success: false, error: 'User is inactive' });
    }

    req.userRow = userRow;
    next();
  } catch (err) {
    console.error('Auth Middleware Error:', err);
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid or expired token' 
    });
  }
}

function requireAdmin(req, res, next) {
  return requirePermission('TENANT_ADMIN')(req, res, next);
}

function requireSuperAdmin(req, res, next) {
  return requirePermission('SUPER_ADMIN')(req, res, next);
}

function normalizeUserRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'user') return 'member';
  if (raw === 'developer') return 'member';
  if (raw === 'engineering') return 'technical';
  if (raw === 'ops') return 'technical';
  if (raw === 'support') return 'cs';
  if (raw === 'superadmin') return 'super_admin';
  if (['owner', 'admin', 'member', 'viewer', 'cs', 'technical', 'super_admin'].includes(raw)) return raw;
  return 'member';
}

function roleRank(role) {
  switch (normalizeUserRole(role)) {
    case 'super_admin':
      return 4;
    case 'owner':
      return 3;
    case 'admin':
      return 2;
    case 'cs':
      return 1;
    case 'technical':
      return 1;
    case 'member':
      return 1;
    case 'viewer':
      return 0;
    default:
      return -1;
  }
}

function getEffectiveRole(userRowOrToken) {
  const u = userRowOrToken || {};
  const rawRole = normalizeUserRole(u.role);
  const isSuper = u.is_super_admin === true || u.isSuperAdmin === true || rawRole === 'super_admin';
  return isSuper ? 'super_admin' : rawRole;
}

function isTenantAdmin(userRowOrToken) {
  const u = userRowOrToken || {};
  const r = getEffectiveRole(u);
  if (r === 'super_admin') return true;
  if (u.is_owner === true) return true;
  return ['owner', 'admin'].includes(r);
}

function isCs(userRowOrToken) {
  return getEffectiveRole(userRowOrToken) === 'cs';
}

function isTechnical(userRowOrToken) {
  const r = getEffectiveRole(userRowOrToken);
  return r === 'technical' || r === 'super_admin';
}

function isPlatformRole(role) {
  const r = normalizeUserRole(role);
  return ['cs', 'technical', 'super_admin'].includes(r);
}

const CS_CAN_CHANGE_PLAN = String(process.env.TASKY_CS_CAN_CHANGE_PLAN || 'false').trim().toLowerCase() === 'true';

const RBAC_PERMISSIONS = {
  SUPER_ADMIN: (u) => getEffectiveRole(u) === 'super_admin',
  TENANT_ADMIN: (u) => isTenantAdmin(u),

  PLANS_VIEW: (_u) => true,
  SUBSCRIPTION_VIEW: (u) => isTenantAdmin(u) || isCs(u) || isTechnical(u),
  SUBSCRIPTION_CHANGE_PLAN: (u) => getEffectiveRole(u) === 'super_admin' || isTenantAdmin(u) || (CS_CAN_CHANGE_PLAN && isCs(u)),

  USERS_VIEW: (u) => isTenantAdmin(u) || isCs(u),
  USERS_MANAGE: (u) => isTenantAdmin(u),

  WORKFLOWS_VIEW: (u) => isTenantAdmin(u) || isTechnical(u),
  WORKFLOWS_MANAGE: (u) => isTenantAdmin(u) || isTechnical(u),

  MONITORING_VIEW: (u) => isTechnical(u),

  INTEGRATIONS_VIEW: (u) => isTenantAdmin(u) || isTechnical(u),
  INTEGRATIONS_MANAGE: (u) => isTenantAdmin(u) || isTechnical(u),
};

function hasPermission(userRowOrToken, permission) {
  const fn = RBAC_PERMISSIONS[String(permission || '').trim().toUpperCase()];
  if (!fn) return false;
  return Boolean(fn(userRowOrToken));
}

function requirePermission(permission) {
  const perm = String(permission || '').trim().toUpperCase();
  return (req, res, next) => {
    const user = req.userRow || req.user || null;
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!hasPermission(user, perm)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

function canManageWorkspaceUsers(requestingUserRow) {
  if (!requestingUserRow) return false;
  if (requestingUserRow.is_super_admin) return true;
  const r = roleRank(requestingUserRow.role);
  return r >= 2;
}

function canChangeUserRole({ actor, target, nextRole }) {
  if (!actor || !target) return false;
  if (actor.is_super_admin) return true;
  if (isPlatformRole(target.role) || isPlatformRole(nextRole)) return false;
  const actorRank = roleRank(actor.role);
  const targetRank = roleRank(target.role);
  const desiredRank = roleRank(nextRole);
  if (actorRank < 2) return false;
  if (actor.subscription_id !== target.subscription_id) return false;
  if (targetRank === 3 && actorRank !== 3) return false;
  if (desiredRank === 3 && actorRank !== 3) return false;
  if (actorRank < targetRank) return false;
  return desiredRank >= 0;
}

function redactSensitive(value) {
  const raw = String(value ?? '');
  if (!raw) return raw;
  if (/^bearer\s+/i.test(raw)) return '****';
  if (raw.length >= 32) return '****';
  return raw;
}

function isSensitiveKey(key) {
  return /pass(word)?|token|secret|api[_-]?key|authorization|cookie|jwt|bearer|refresh|private|credential/i.test(String(key || ''));
}

function deepRedact(value, depth = 0) {
  if (depth > 6) return '****';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitive(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '****' : deepRedact(v, depth + 1);
    }
    return out;
  }
  return '****';
}

async function logActivity({
  customerId,
  userId = null,
  sourceType = 'system',
  sourceId = null,
  action,
  severity = 'info',
  messageInternal,
  messageUser,
  metadata = {},
}) {
  const internalText = String(messageInternal ?? '').trim();
  const userText = String(messageUser ?? '').trim();
  const fallbackText = userText || internalText;
  if (!customerId || !action || !fallbackText) return;

  const cleanSeverity = ['info', 'warning', 'error'].includes(severity) ? severity : 'info';
  const cleanAction = String(action).trim().toUpperCase().slice(0, 80);
  const cleanSourceType = String(sourceType || 'system').trim().toLowerCase().slice(0, 32);
  const cleanMessage = fallbackText.slice(0, 500);
  const cleanInternal = internalText ? internalText.slice(0, 800) : null;
  const cleanUser = userText ? userText.slice(0, 500) : null;
  const cleanMetadata = deepRedact(metadata);

  try {
    await pool.query(
      `
      INSERT INTO activity_logs (id, customer_id, user_id, source_type, source_id, action, severity, message, message_internal, message_user, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        randomUUID(),
        String(customerId),
        userId ? String(userId) : null,
        cleanSourceType,
        sourceId ? String(sourceId) : null,
        cleanAction,
        cleanSeverity,
        cleanMessage,
        cleanInternal,
        cleanUser,
        JSON.stringify(cleanMetadata ?? {}),
      ]
    );
  } catch (err) {
    console.error('Activity log write failed:', err.message || err);
  }
}

async function readTailLines(filePath, limit) {
  const maxLines = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const maxBytes = 1024 * 1024;

  await fsp.access(filePath);

  const stat = await fsp.stat(filePath);
  const readSize = Math.min(stat.size, maxBytes);
  const start = Math.max(stat.size - readSize, 0);

  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, start);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (start > 0) {
      lines.shift();
    }
    return lines.filter(Boolean).slice(-maxLines);
  } finally {
    await handle.close();
  }
}

app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'taskyhub-api',
    uptime: process.uptime(),
    db: 'disconnected',
    ae: 'disconnected'
  };

  try {
    // Check Database connection
    await pool.query('SELECT 1');
    health.db = 'connected';

    // Check Automation Engine (n8n) connection
    try {
      await aePool.query('SELECT 1');
      health.ae = 'connected';
    } catch (aeErr) {
      console.error('Healthcheck AE Error:', aeErr.message);
      health.status = 'degraded';
    }

    res.json(health);
  } catch (err) {
    console.error('Healthcheck DB Error:', err.message);
    health.status = 'error';
    res.status(503).json(health);
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.get('/api/hash/:password', async (req, res) => {
    try {
      const hash = await bcrypt.hash(req.params.password, 10);
      res.json({ hash });
    } catch (err) {
      res.status(500).json({ error: 'Failed to hash password' });
    }
  });
}

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const normalizedEmail = String(email).trim();
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [normalizedEmail]
    );
    const user = result.rows[0];

    if (!user) {
      console.warn(`Login failed: user not found for email ${normalizedEmail}`);
      await logActivity({
        customerId: 'unknown',
        userId: null,
        sourceType: 'system',
        sourceId: null,
        action: 'LOGIN_FAILED',
        severity: 'warning',
        messageInternal: 'Login failed: user not found',
        messageUser: 'Login failed. Please check your email and password.',
        metadata: { email: normalizedEmail },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    const demoLoginAllowed = isAllowedDemoLogin(email, password);

    if (!passwordMatch && !demoLoginAllowed) {
      console.warn(`Login failed: invalid password for email ${normalizedEmail}`);
      await logActivity({
        customerId: user.subscription_id,
        userId: user.id,
        sourceType: 'system',
        sourceId: null,
        action: 'LOGIN_FAILED',
        severity: 'warning',
        messageInternal: 'Login failed: invalid password',
        messageUser: 'Login failed. Please check your email and password.',
        metadata: { email: normalizedEmail },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    const customerId = user.customer_id || user.subscription_id;
    try {
      await pool.query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
    } catch (_e) {
    }
    await logActivity({
      customerId,
      userId: user.id,
      sourceType: 'system',
      sourceId: null,
      action: 'LOGIN_SUCCESS',
      severity: 'info',
      messageInternal: 'Login successful',
      messageUser: 'Signed in successfully.',
      metadata: { email: normalizedEmail },
    });
    return res.json({ 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        role: user.role, 
        name: user.name, 
        subscriptionId: customerId,
        customerId,
        isSuperAdmin: Boolean(user.is_super_admin),
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/login', (req, res) => {
  res.status(405).json({ success: false, error: 'Use POST /api/login' });
});

app.get('/api/admin/ae/logs', authMiddleware, requirePermission('MONITORING_VIEW'), async (req, res) => {
  const logFilePath = process.env.AE_LOG_FILE_PATH || '/var/log/ae/n8n.log';

  try {
    const lines = await readTailLines(logFilePath, req.query.limit);
    res.json({ lines });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      return res.status(404).json({ error: 'AE log file not available' });
    }
    console.error('AE logs error:', err);
    res.status(500).json({ error: 'Failed to read AE logs' });
  }
});

function toPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

async function queryActivityLogs({
  customerId,
  viewerUserId,
  restrictToViewer,
  adminView,
  page,
  pageSize,
  severity,
  sourceType,
  sourceId,
  action,
  dateFrom,
  dateTo,
  search,
}) {
  const filters = ['l.customer_id = $1'];
  const params = [String(customerId)];

  if (restrictToViewer && viewerUserId) {
    params.push(String(viewerUserId));
    filters.push(`(l.user_id IS NULL OR l.user_id = $${params.length})`);
  }

  if (severity) {
    params.push(String(severity));
    filters.push(`l.severity = $${params.length}`);
  }
  if (sourceType) {
    params.push(String(sourceType));
    filters.push(`l.source_type = $${params.length}`);
  }
  if (sourceId) {
    params.push(String(sourceId));
    filters.push(`l.source_id = $${params.length}`);
  }
  if (action) {
    params.push(String(action).toUpperCase());
    filters.push(`l.action = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom.toISOString());
    filters.push(`l.created_at >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo.toISOString());
    filters.push(`l.created_at <= $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search)}%`);
    if (adminView) {
      filters.push(`COALESCE(l.message_internal, l.message_user, l.message, '') ILIKE $${params.length}`);
    } else {
      filters.push(`COALESCE(l.message_user, l.message, '') ILIKE $${params.length}`);
    }
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM activity_logs l ${whereClause}`, params);
  const total = Number(countResult.rows[0]?.total || 0);

  const offset = (page - 1) * pageSize;
  params.push(pageSize);
  params.push(offset);

  const rowsResult = await pool.query(
    `
    SELECT
      l.id,
      l.customer_id,
      l.user_id,
      l.source_type,
      l.source_id,
      l.action,
      l.severity,
      l.message,
      l.message_internal,
      l.message_user,
      l.metadata,
      l.created_at,
      u.name AS actor_name,
      u.email AS actor_email
    FROM activity_logs l
    LEFT JOIN users u ON u.id::text = l.user_id
    ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return { total, rows: rowsResult.rows };
}

app.get('/api/activity-logs', authMiddleware, requirePermission('MONITORING_VIEW'), async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1, 1, 1000000);
    const pageSize = toPositiveInt(req.query.pageSize, 25, 1, 100);
    const dateFrom = parseDate(req.query.dateFrom);
    const dateTo = parseDate(req.query.dateTo);

    const { total, rows } = await queryActivityLogs({
      customerId: req.user.subscriptionId,
      viewerUserId: req.user.id,
      restrictToViewer: true,
      adminView: false,
      page,
      pageSize,
      severity: req.query.severity ? String(req.query.severity) : null,
      sourceType: req.query.sourceType ? String(req.query.sourceType) : null,
      sourceId: req.query.sourceId ? String(req.query.sourceId) : null,
      action: req.query.action ? String(req.query.action) : null,
      dateFrom,
      dateTo,
      search: req.query.search ? String(req.query.search) : null,
    });

    const logs = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      severity: row.severity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      action: row.action,
      actor: row.user_id ? { name: String(row.user_id) === String(req.user.id) ? 'You' : 'User' } : { name: 'System' },
      messageUser: row.message_user || row.message || '',
    }));

    res.json({ page, pageSize, total, logs });
  } catch (err) {
    console.error('Activity logs error:', err);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

app.get('/api/admin/activity-logs', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1, 1, 1000000);
    const pageSize = toPositiveInt(req.query.pageSize, 25, 1, 100);
    const dateFrom = parseDate(req.query.dateFrom);
    const dateTo = parseDate(req.query.dateTo);

    const { total, rows } = await queryActivityLogs({
      customerId: req.user.subscriptionId,
      viewerUserId: req.user.id,
      restrictToViewer: false,
      adminView: true,
      page,
      pageSize,
      severity: req.query.severity ? String(req.query.severity) : null,
      sourceType: req.query.sourceType ? String(req.query.sourceType) : null,
      sourceId: req.query.sourceId ? String(req.query.sourceId) : null,
      action: req.query.action ? String(req.query.action) : null,
      dateFrom,
      dateTo,
      search: req.query.search ? String(req.query.search) : null,
    });

    const logs = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      severity: row.severity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      action: row.action,
      actor: row.user_id ? { name: row.actor_name || 'User', email: row.actor_email || null } : { name: 'System', email: null },
      messageInternal: row.message_internal || row.message || '',
      messageUser: row.message_user || null,
      metadata: deepRedact(row.metadata || {}),
    }));

    res.json({ page, pageSize, total, logs });
  } catch (err) {
    console.error('Admin activity logs error:', err);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

app.get('/api/workflows/:workflowId/activity-logs', authMiddleware, async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1, 1, 1000000);
    const pageSize = toPositiveInt(req.query.pageSize, 25, 1, 100);
    const { total, rows } = await queryActivityLogs({
      customerId: req.user.subscriptionId,
      viewerUserId: req.user.id,
      restrictToViewer: true,
      adminView: false,
      page,
      pageSize,
      severity: req.query.severity ? String(req.query.severity) : null,
      sourceType: 'workflow',
      sourceId: String(req.params.workflowId),
      action: req.query.action ? String(req.query.action) : null,
      dateFrom: parseDate(req.query.dateFrom),
      dateTo: parseDate(req.query.dateTo),
      search: req.query.search ? String(req.query.search) : null,
    });
    const logs = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      severity: row.severity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      action: row.action,
      actor: row.user_id ? { name: String(row.user_id) === String(req.user.id) ? 'You' : 'User' } : { name: 'System' },
      messageUser: row.message_user || row.message || '',
    }));
    res.json({ page, pageSize, total, logs });
  } catch (err) {
    console.error('Workflow activity logs error:', err);
    res.status(500).json({ error: 'Failed to fetch workflow activity logs' });
  }
});

app.get('/api/tasks/:taskId/activity-logs', authMiddleware, async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1, 1, 1000000);
    const pageSize = toPositiveInt(req.query.pageSize, 25, 1, 100);
    const { total, rows } = await queryActivityLogs({
      customerId: req.user.subscriptionId,
      viewerUserId: req.user.id,
      restrictToViewer: true,
      adminView: false,
      page,
      pageSize,
      severity: req.query.severity ? String(req.query.severity) : null,
      sourceType: 'task',
      sourceId: String(req.params.taskId),
      action: req.query.action ? String(req.query.action) : null,
      dateFrom: parseDate(req.query.dateFrom),
      dateTo: parseDate(req.query.dateTo),
      search: req.query.search ? String(req.query.search) : null,
    });
    const logs = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      severity: row.severity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      action: row.action,
      actor: row.user_id ? { name: String(row.user_id) === String(req.user.id) ? 'You' : 'User' } : { name: 'System' },
      messageUser: row.message_user || row.message || '',
    }));
    res.json({ page, pageSize, total, logs });
  } catch (err) {
    console.error('Task activity logs error:', err);
    res.status(500).json({ error: 'Failed to fetch task activity logs' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const userCols = ['id', 'email', 'role', 'name', 'subscription_id'];
    if (schemaCaps.users.has_customer_id) userCols.push('customer_id');
    if (schemaCaps.users.has_is_active) userCols.push('is_active');
    if (schemaCaps.users.has_is_super_admin) userCols.push('is_super_admin');
    if (schemaCaps.users.has_last_login_at) userCols.push('last_login_at');
    if (schemaCaps.users.has_is_owner) userCols.push('is_owner');
    const userResult = await pool.query(`SELECT ${userCols.join(', ')} FROM users WHERE id = $1`, [req.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const effectiveCustomerId = user.customer_id || user.subscription_id || customerId;
    const customerResult = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [effectiveCustomerId]);
    const customer = customerResult.rows[0] || null;

    let billingSubscription = null;
    if (schemaCaps.tables.plans && schemaCaps.tables.billing_subscriptions) {
      try {
        const billingResult = await pool.query(
          `
          SELECT
            s.*,
            p.code AS plan_code,
            p.name AS plan_name,
            p.monthly_price_cents,
            p.yearly_price_cents,
            p.max_users,
            p.max_workflows,
            p.max_tasks,
            p.included_runs_per_month,
            p.overage_price_per_1000_runs,
            p.description AS plan_description,
            p.is_active AS plan_is_active
          FROM billing_subscriptions s
          JOIN plans p ON p.id = s.plan_id
          WHERE s.customer_id = $1 AND s.status IN ('trialing','active','past_due')
          ORDER BY s.created_at DESC
          LIMIT 1
          `,
          [effectiveCustomerId]
        );
        billingSubscription = billingResult.rows[0] || null;
      } catch (_e) {
      }
    }

    return res.json({ 
      user: { 
        id: user.id, 
        email: user.email, 
        role: user.role, 
        name: user.name,
        subscriptionId: effectiveCustomerId,
        customerId: effectiveCustomerId,
        isActive: schemaCaps.users.has_is_active ? user.is_active !== false : true,
        isSuperAdmin: Boolean(user.is_super_admin) || isSuperAdminEmail(user.email),
        isOwner: schemaCaps.users.has_is_owner ? user.is_owner === true : false,
        is_owner: schemaCaps.users.has_is_owner ? user.is_owner === true : false,
        lastLoginAt: schemaCaps.users.has_last_login_at ? user.last_login_at : null,
      }, 
      subscription: customer,
      customer,
      billingSubscription,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function mapIntegrationToN8nCredential({ integration, secrets }) {
  const type = String(integration || '').trim().toLowerCase();
  if (!type) {
    throw new Error('integration is required');
  }

  if (type === 'openai') {
    const apiKey = String(secrets?.apiKey || '').trim();
    if (!apiKey) throw new Error('secrets.apiKey is required for openai');
    return {
      n8nType: 'openAiApi',
      n8nData: { apiKey },
    };
  }

  if (type === 'slack') {
    const accessToken = String(secrets?.accessToken || '').trim();
    if (!accessToken) throw new Error('secrets.accessToken is required for slack');
    return {
      n8nType: 'slackApi',
      n8nData: { accessToken },
    };
  }

  throw new Error(`Unsupported integration: ${type}`);
}

app.get('/api/integrations/credentials', authMiddleware, requirePermission('INTEGRATIONS_VIEW'), async (req, res) => {
  try {
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const tableCheck = await pool.query(`SELECT to_regclass('public.integration_credentials') IS NOT NULL AS ok`);
    if (!tableCheck.rows[0]?.ok) {
      return res.status(503).json({ success: false, error: 'Integrations storage is not initialized yet.' });
    }

    const result = await pool.query(
      `
      SELECT id, integration_type, label, n8n_credential_id, status, last_error, created_at, updated_at
      FROM integration_credentials
      WHERE customer_id = $1
      ORDER BY created_at DESC
      `,
      [customerId]
    );
    return res.json({ credentials: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/integrations/oauth/slack/start', authMiddleware, requirePermission('INTEGRATIONS_MANAGE'), async (req, res) => {
  try {
    if (!integrationsEncryptionConfigured()) {
      return res.status(503).json({ success: false, error: 'Integrations are not configured on this server.' });
    }
    if (!n8nApiConfigured()) {
      return res.status(503).json({ success: false, error: 'Automation Engine API auth is not configured on this server.' });
    }
    if (!TASKY_SLACK_CLIENT_ID || !TASKY_SLACK_CLIENT_SECRET) {
      return res.status(503).json({ success: false, error: 'Slack OAuth is not configured on this server.' });
    }
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ success: false, error: 'label is required' });

    const publicBase = getPublicBaseUrl(req);
    if (!publicBase) return res.status(500).json({ success: false, error: 'Unable to resolve public URL for OAuth callback.' });

    const state = randomUUID();
    const redirectUri = `${publicBase}/api/integrations/oauth/slack/callback`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `
      INSERT INTO integration_oauth_states (state, customer_id, user_id, integration_type, label, expires_at)
      VALUES ($1, $2, $3, 'slack', $4, $5)
      `,
      [state, customerId, req.user.id, label, expiresAt]
    );

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', TASKY_SLACK_CLIENT_ID);
    url.searchParams.set('scope', TASKY_SLACK_SCOPES);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return res.json({ authorizeUrl: url.toString() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/integrations/oauth/slack/callback', async (req, res) => {
  try {
    const code = String(req.query?.code || '').trim();
    const state = String(req.query?.state || '').trim();
    const error = String(req.query?.error || '').trim();
    const publicBase = getPublicBaseUrl(req);

    const redirectToIntegrations = (status, message) => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (message) qs.set('message', message.slice(0, 200));
      const base = publicBase || '';
      if (!base) return res.status(500).send('OAuth callback failed: missing public base URL');
      return res.redirect(`${base}/dashboard/integrations?${qs.toString()}`);
    };

    if (error) {
      return redirectToIntegrations('error', `Slack OAuth error: ${error}`);
    }
    if (!code || !state) {
      return redirectToIntegrations('error', 'Missing code/state from Slack');
    }
    if (!TASKY_SLACK_CLIENT_ID || !TASKY_SLACK_CLIENT_SECRET) {
      return redirectToIntegrations('error', 'Slack OAuth is not configured on this server.');
    }
    if (!integrationsEncryptionConfigured()) {
      return redirectToIntegrations('error', 'Integrations are not configured on this server.');
    }
    if (!n8nApiConfigured()) {
      return redirectToIntegrations('error', 'Automation Engine API auth is not configured on this server.');
    }

    const stateRow = await pool.query(
      `
      SELECT state, customer_id, user_id, label, expires_at
      FROM integration_oauth_states
      WHERE state = $1 AND integration_type = 'slack'
      LIMIT 1
      `,
      [state]
    );
    const row = stateRow.rows[0];
    if (!row) {
      return redirectToIntegrations('error', 'Invalid or expired OAuth state');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(`DELETE FROM integration_oauth_states WHERE state = $1`, [state]);
      return redirectToIntegrations('error', 'Expired OAuth state');
    }
    await pool.query(`DELETE FROM integration_oauth_states WHERE state = $1`, [state]);

    const redirectUri = `${publicBase}/api/integrations/oauth/slack/callback`;
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TASKY_SLACK_CLIENT_ID,
        client_secret: TASKY_SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson || tokenJson.ok !== true) {
      const msg = tokenJson?.error ? `Slack token exchange failed: ${tokenJson.error}` : 'Slack token exchange failed';
      return redirectToIntegrations('error', msg);
    }

    const accessToken = String(tokenJson?.access_token || '').trim();
    if (!accessToken) {
      return redirectToIntegrations('error', 'Slack OAuth did not return an access token');
    }

    const encrypted = encryptSecretsJson({
      accessToken,
      teamId: tokenJson?.team?.id || '',
      teamName: tokenJson?.team?.name || '',
      authedUserId: tokenJson?.authed_user?.id || '',
      scope: tokenJson?.scope || '',
    });
    const id = randomUUID();
    await pool.query(
      `
      INSERT INTO integration_credentials (id, customer_id, user_id, integration_type, label, encrypted_secrets_json, status)
      VALUES ($1, $2, $3, 'slack', $4, $5, 'active')
      `,
      [id, row.customer_id, row.user_id, row.label, encrypted]
    );

    try {
      const { n8nType, n8nData } = mapIntegrationToN8nCredential({ integration: 'slack', secrets: { accessToken } });
      const n8nName = `TaskyHub/${row.customer_id}/${row.label}`;
      const n8nResponse = await n8nCreateOrUpdateCredential({
        n8nCredentialId: null,
        name: n8nName,
        type: n8nType,
        data: n8nData,
      });
      const n8nCredentialId = String(n8nResponse.id || n8nResponse.data?.id || '');
      await pool.query(
        `UPDATE integration_credentials SET n8n_credential_id = $2, updated_at = NOW(), last_error = '' WHERE id = $1`,
        [id, n8nCredentialId || null]
      );
    } catch (syncErr) {
      await pool.query(
        `UPDATE integration_credentials SET status = 'error', updated_at = NOW(), last_error = $2 WHERE id = $1`,
        [id, String(syncErr?.message || syncErr || 'n8n sync failed').slice(0, 500)]
      );
    }

    return redirectToIntegrations('success', 'Slack connected');
  } catch (err) {
    console.error(err);
    return res.status(500).send('OAuth callback failed');
  }
});

app.post('/api/integrations/credentials', authMiddleware, requirePermission('INTEGRATIONS_MANAGE'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (!integrationsEncryptionConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Integrations are not configured on this server. Missing TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64.',
      });
    }
    if (!n8nApiConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Automation Engine API auth is not configured on this server. Set TASKY_N8N_API_KEY or TASKY_N8N_BASIC_AUTH_*.',
      });
    }
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const { integration, label, secrets } = req.body || {};
    const integrationType = String(integration || '').trim().toLowerCase();
    const cleanLabel = String(label || '').trim();
    if (!integrationType) return res.status(400).json({ success: false, error: 'integration is required' });
    if (!cleanLabel) return res.status(400).json({ success: false, error: 'label is required' });
    if (!secrets || typeof secrets !== 'object') return res.status(400).json({ success: false, error: 'secrets object is required' });

    const encrypted = encryptSecretsJson(secrets);
    const id = randomUUID();

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO integration_credentials (id, customer_id, user_id, integration_type, label, encrypted_secrets_json)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [id, customerId, req.user.id, integrationType, cleanLabel, encrypted]
    );
    await client.query('COMMIT');

    let n8nCredentialId = null;
    try {
      const { n8nType, n8nData } = mapIntegrationToN8nCredential({ integration: integrationType, secrets });
      const n8nName = `TaskyHub/${customerId}/${cleanLabel}`;
      const n8nResponse = await n8nCreateOrUpdateCredential({
        n8nCredentialId: null,
        name: n8nName,
        type: n8nType,
        data: n8nData,
      });
      n8nCredentialId = String(n8nResponse.id || n8nResponse.data?.id || '');
      await pool.query(
        `UPDATE integration_credentials SET n8n_credential_id = $2, updated_at = NOW(), last_error = '' WHERE id = $1`,
        [id, n8nCredentialId || null]
      );
    } catch (syncErr) {
      await pool.query(
        `UPDATE integration_credentials SET status = 'error', updated_at = NOW(), last_error = $2 WHERE id = $1`,
        [id, String(syncErr?.message || syncErr || 'n8n sync failed').slice(0, 500)]
      );
    }

    const out = await pool.query(
      `
      SELECT id, integration_type, label, n8n_credential_id, status, last_error, created_at, updated_at
      FROM integration_credentials
      WHERE id = $1
      `,
      [id]
    );
    return res.status(201).json({ credential: out.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.patch('/api/integrations/credentials/:id', authMiddleware, requirePermission('INTEGRATIONS_MANAGE'), async (req, res) => {
  try {
    if (!integrationsEncryptionConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Integrations are not configured on this server. Missing TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64.',
      });
    }
    if (!n8nApiConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Automation Engine API auth is not configured on this server. Set TASKY_N8N_API_KEY or TASKY_N8N_BASIC_AUTH_*.',
      });
    }
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const id = String(req.params.id || '').trim();
    const { label, secrets } = req.body || {};
    const cleanLabel = label !== undefined ? String(label || '').trim() : null;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const existing = await pool.query(
      `SELECT * FROM integration_credentials WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [id, customerId]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Credential not found' });

    const nextLabel = cleanLabel !== null ? cleanLabel : String(row.label || '');
    const nextEncrypted = secrets && typeof secrets === 'object' ? encryptSecretsJson(secrets) : null;

    await pool.query(
      `
      UPDATE integration_credentials
      SET label = COALESCE($2, label),
          encrypted_secrets_json = COALESCE($3, encrypted_secrets_json),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, cleanLabel !== null ? nextLabel : null, nextEncrypted]
    );

    if (secrets && typeof secrets === 'object') {
      try {
        const { n8nType, n8nData } = mapIntegrationToN8nCredential({
          integration: row.integration_type,
          secrets,
        });
        const n8nName = `TaskyHub/${customerId}/${nextLabel}`;
        const n8nResponse = await n8nCreateOrUpdateCredential({
          n8nCredentialId: row.n8n_credential_id || null,
          name: n8nName,
          type: n8nType,
          data: n8nData,
        });
        const returnedId = String(n8nResponse.id || n8nResponse.data?.id || '');
        await pool.query(
          `UPDATE integration_credentials SET status = 'active', last_error = '', n8n_credential_id = COALESCE($2, n8n_credential_id), updated_at = NOW() WHERE id = $1`,
          [id, returnedId || null]
        );
      } catch (syncErr) {
        await pool.query(
          `UPDATE integration_credentials SET status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [id, String(syncErr?.message || syncErr || 'n8n sync failed').slice(0, 500)]
        );
      }
    }

    const out = await pool.query(
      `
      SELECT id, integration_type, label, n8n_credential_id, status, last_error, created_at, updated_at
      FROM integration_credentials
      WHERE id = $1
      `,
      [id]
    );
    return res.json({ credential: out.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/integrations/credentials/:id/test', authMiddleware, requirePermission('INTEGRATIONS_MANAGE'), async (req, res) => {
  try {
    if (!integrationsEncryptionConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Integrations are not configured on this server. Missing TASKY_INTEGRATIONS_ENCRYPTION_KEY_B64.',
      });
    }
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const existing = await pool.query(
      `SELECT id, integration_type, encrypted_secrets_json FROM integration_credentials WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [id, customerId]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Credential not found' });

    const secrets = decryptSecretsJson(row.encrypted_secrets_json);
    const type = String(row.integration_type || '').toLowerCase();

    if (type === 'openai') {
      const apiKey = String(secrets?.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ success: false, error: 'Missing OpenAI apiKey' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const testRes = await fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        const body = await testRes.text();
        if (!testRes.ok) {
          return res.status(400).json({ success: false, ok: false, error: `OpenAI test failed ${testRes.status}: ${body.slice(0, 200)}` });
        }
        return res.json({ success: true, ok: true });
      } finally {
        clearTimeout(timeout);
      }
    }

    if (type === 'slack') {
      const accessToken = String(secrets?.accessToken || '').trim();
      if (!accessToken) return res.status(400).json({ success: false, error: 'Missing Slack accessToken' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const testRes = await fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        const body = await testRes.json().catch(() => null);
        if (!testRes.ok || !body || body.ok !== true) {
          return res.status(400).json({ success: false, ok: false, error: `Slack test failed: ${body?.error || 'unknown'}` });
        }
        return res.json({ success: true, ok: true });
      } finally {
        clearTimeout(timeout);
      }
    }

    return res.status(400).json({ success: false, error: `Unsupported integration type for test: ${type}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/users', authMiddleware, requirePermission('USERS_VIEW'), async (req, res) => {
  try {
    const customerId = req.user?.customerId || req.user?.subscriptionId;
    const cols = ['id', 'email', 'role', 'name', 'created_at'];
    if (schemaCaps.users.has_is_active) cols.push('is_active');
    if (schemaCaps.users.has_last_login_at) cols.push('last_login_at');
    const result = await pool.query(`SELECT ${cols.join(', ')} FROM users WHERE subscription_id = $1 ORDER BY created_at ASC`, [
      customerId,
    ]);
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function getEffectiveMaxUsersForCustomer(customerId) {
  const customerResult = await pool.query('SELECT seat_limit FROM subscriptions WHERE id = $1', [customerId]);
  const seatLimit = Number(customerResult.rows[0]?.seat_limit);
  if (Number.isFinite(seatLimit) && seatLimit > 0) return seatLimit;
  if (schemaCaps.tables.billing_subscriptions && schemaCaps.tables.plans) {
    try {
      const billingResult = await pool.query(
        `
        SELECT p.max_users
        FROM billing_subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = $1 AND s.status IN ('trialing','active','past_due')
        ORDER BY s.created_at DESC
        LIMIT 1
        `,
        [customerId]
      );
      const planLimit = Number(billingResult.rows[0]?.max_users);
      if (Number.isFinite(planLimit) && planLimit > 0) return planLimit;
    } catch (_e) {
    }
  }
  return 1;
}

async function getActiveUsersCount(customerId) {
  const sql = schemaCaps.users.has_is_active
    ? `SELECT COUNT(*)::int AS count FROM users WHERE subscription_id = $1 AND (is_active IS NULL OR is_active = true)`
    : `SELECT COUNT(*)::int AS count FROM users WHERE subscription_id = $1`;
  const result = await pool.query(sql, [customerId]);
  return Number(result.rows[0]?.count || 0);
}

app.post('/api/users', authMiddleware, requirePermission('USERS_MANAGE'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestingUserResult = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );
    const requestingUser = requestingUserResult.rows[0];

    if (!canManageWorkspaceUsers(requestingUser)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only workspace admins may manage users' });
    }

    const subscriptionResult = await client.query(
      'SELECT * FROM subscriptions WHERE id = $1',
      [requestingUser.subscription_id]
    );
    const subscription = subscriptionResult.rows[0];

    if (!subscription) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Subscription not found' });
    }

    const currentUsersCount = await getActiveUsersCount(subscription.id);
    const seatLimit = Number(subscription.seat_limit);
    const maxUsersAllowed = await getEffectiveMaxUsersForCustomer(subscription.id);
    const effectiveLimit = Number.isFinite(seatLimit) && seatLimit > 0 ? seatLimit : maxUsersAllowed;
    const seatError = validateSeatLimit({ currentUsersCount, seatLimit: effectiveLimit });
    if (seatError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: seatError });
    }

    const { email, password, name, role } = req.body;
    if (!email || !password || !name || !role) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'name, email, password, and role are required' });
    }

    const existingUserResult = await client.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (existingUserResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A user with that email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUserId = randomUUID();

    const normalizedRole = normalizeUserRole(role);
    if (!requestingUser.is_super_admin && isPlatformRole(normalizedRole)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only super admins may assign CS/Technical roles' });
    }
    const useExtended =
      schemaCaps.users.has_customer_id && schemaCaps.users.has_is_active && schemaCaps.users.has_updated_at;

    const newUserResult = useExtended
      ? await client.query(
          'INSERT INTO users (id, subscription_id, customer_id, email, password, name, role, is_active, updated_at) VALUES ($1, $2, $2, $3, $4, $5, $6, true, NOW()) RETURNING id, email, role, name',
          [newUserId, subscription.id, email, hashedPassword, name, normalizedRole]
        )
      : await client.query(
          'INSERT INTO users (id, subscription_id, email, password, name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, name',
          [newUserId, subscription.id, email, hashedPassword, name, normalizedRole]
        );

    await client.query('COMMIT');
    await logActivity({
      customerId: subscription.id,
      userId: requestingUser.id,
      sourceType: 'system',
      sourceId: newUserResult.rows[0]?.id,
      action: 'USER_INVITED',
      severity: 'info',
      messageInternal: `User invited: ${String(email).trim()}`,
      messageUser: 'A user was invited to your workspace.',
      metadata: { invitedEmail: String(email).trim(), role: String(role).trim() },
    });
    res.status(201).json({ user: newUserResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/users/invite', authMiddleware, requirePermission('USERS_MANAGE'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actorResult = await client.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const actor = actorResult.rows[0];
    if (!canManageWorkspaceUsers(actor)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only workspace admins may invite users' });
    }

    const { email, role = 'member', expiresInHours = 72 } = req.body || {};
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'email is required' });
    }

    const customerId = actor.customer_id || actor.subscription_id;
    const maxUsersAllowed = await getEffectiveMaxUsersForCustomer(customerId);
    const currentUsersCount = await getActiveUsersCount(customerId);
    const seatError = validateSeatLimit({ currentUsersCount, seatLimit: maxUsersAllowed });
    if (seatError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: seatError });
    }

    const existingUser = await client.query('SELECT 1 FROM users WHERE subscription_id = $1 AND LOWER(email) = LOWER($2)', [
      customerId,
      cleanEmail,
    ]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A user with that email already exists in this workspace' });
    }

    const token = randomUUID();
    const inviteId = randomUUID();
    const hours = Math.min(Math.max(Number(expiresInHours) || 72, 1), 168);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const normalizedRole = normalizeUserRole(role) || 'member';
    if (!actor.is_super_admin && isPlatformRole(normalizedRole)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only super admins may assign CS/Technical roles' });
    }

    await client.query(
      `
      INSERT INTO user_invites (id, customer_id, email, role, token, expires_at, invited_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [inviteId, customerId, cleanEmail, normalizedRole, token, expiresAt, actor.id]
    );

    await client.query('COMMIT');

    await logActivity({
      customerId,
      userId: actor.id,
      sourceType: 'system',
      sourceId: inviteId,
      action: 'USER_INVITE_CREATED',
      severity: 'info',
      messageInternal: `Invite created for ${cleanEmail}`,
      messageUser: 'Invite created.',
      metadata: { invitedEmail: cleanEmail, role: normalizedRole },
    });

    res.status(201).json({
      invite: {
        id: inviteId,
        email: cleanEmail,
        role: normalizedRole,
        expiresAt,
        token,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/users/accept-invite', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { token, password, name } = req.body || {};
    const cleanToken = String(token || '').trim();
    const cleanPassword = String(password || '');
    const cleanName = String(name || '').trim() || 'User';
    if (!cleanToken || !cleanPassword) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'token and password are required' });
    }

    const inviteResult = await client.query(
      `
      SELECT * FROM user_invites
      WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()
      LIMIT 1
      `,
      [cleanToken]
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invite is invalid or expired' });
    }

    const existingUser = await client.query(
      'SELECT 1 FROM users WHERE subscription_id = $1 AND LOWER(email) = LOWER($2)',
      [invite.customer_id, invite.email]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A user with that email already exists' });
    }

    const maxUsersAllowed = await getEffectiveMaxUsersForCustomer(invite.customer_id);
    const currentUsersCount = await getActiveUsersCount(invite.customer_id);
    const seatError = validateSeatLimit({ currentUsersCount, seatLimit: maxUsersAllowed });
    if (seatError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: seatError });
    }

    const hashedPassword = await bcrypt.hash(cleanPassword, 10);
    const newUserId = randomUUID();
    const normalizedRole = normalizeUserRole(invite.role) || 'member';
    const useExtended =
      schemaCaps.users.has_customer_id && schemaCaps.users.has_is_active && schemaCaps.users.has_updated_at;

    const created = useExtended
      ? await client.query(
          `
          INSERT INTO users (id, subscription_id, customer_id, email, password, name, role, is_active, updated_at)
          VALUES ($1, $2, $2, $3, $4, $5, $6, true, NOW())
          RETURNING id, email, role, name, subscription_id
          `,
          [newUserId, invite.customer_id, invite.email, hashedPassword, cleanName, normalizedRole]
        )
      : await client.query(
          `
          INSERT INTO users (id, subscription_id, email, password, name, role)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, email, role, name, subscription_id
          `,
          [newUserId, invite.customer_id, invite.email, hashedPassword, cleanName, normalizedRole]
        );

    await client.query('UPDATE user_invites SET accepted_at = NOW() WHERE id = $1', [invite.id]);
    await client.query('COMMIT');

    await logActivity({
      customerId: invite.customer_id,
      userId: created.rows[0]?.id,
      sourceType: 'system',
      sourceId: invite.id,
      action: 'USER_INVITE_ACCEPTED',
      severity: 'info',
      messageInternal: `Invite accepted for ${String(invite.email).trim()}`,
      messageUser: 'Invite accepted.',
      metadata: { email: String(invite.email).trim(), role: normalizeUserRole(invite.role) || 'member' },
    });

    res.status(201).json({ user: created.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.patch('/api/users/:id', authMiddleware, requirePermission('USERS_MANAGE'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actorResult = await client.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const actor = actorResult.rows[0];
    if (!canManageWorkspaceUsers(actor)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only workspace admins may update users' });
    }

    const targetResult = await client.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    if (!actor.is_super_admin && String(actor.subscription_id) !== String(target.subscription_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot manage users outside your workspace' });
    }

    const updates = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isActive')) {
      if (schemaCaps.users.has_is_active) {
        params.push(Boolean(req.body.isActive));
        updates.push(`is_active = $${params.length}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
      const desiredRole = normalizeUserRole(req.body.role);
      if (!canChangeUserRole({ actor, target, nextRole: desiredRole })) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not allowed to change role' });
      }
      params.push(desiredRole);
      updates.push(`role = $${params.length}`);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No updates provided' });
    }

    const tailSet = schemaCaps.users.has_updated_at ? ', updated_at = NOW()' : '';
    const returningCols = ['id', 'email', 'role', 'name'];
    if (schemaCaps.users.has_is_active) returningCols.push('is_active');
    if (schemaCaps.users.has_last_login_at) returningCols.push('last_login_at');

    params.push(req.params.id);
    const updated = await client.query(
      `UPDATE users SET ${updates.join(', ')}${tailSet} WHERE id = $${params.length} RETURNING ${returningCols.join(', ')}`,
      params
    );
    await client.query('COMMIT');

    await logActivity({
      customerId: target.customer_id || target.subscription_id,
      userId: actor.id,
      sourceType: 'system',
      sourceId: target.id,
      action: 'USER_UPDATED',
      severity: 'info',
      messageInternal: `User updated: ${String(target.email).trim()}`,
      messageUser: 'User updated.',
      metadata: { updates: req.body || {} },
    });

    res.json({ user: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/subscriptions', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : '';
    const plan = req.query.plan ? String(req.query.plan).trim().toUpperCase() : '';
    const customer = req.query.customer ? String(req.query.customer).trim() : '';
    const customerId = req.query.customerId ? String(req.query.customerId).trim() : '';
    const trialEndingSoon = String(req.query.trialEndingSoon || '').trim();

    const filters = [];
    const params = [];
    if (status) {
      params.push(status);
      filters.push(`LOWER(s.status) = $${params.length}`);
    }
    if (plan) {
      params.push(plan);
      filters.push(`p.code = $${params.length}`);
    }
    const customerFilter = customerId || customer;
    if (customerFilter) {
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerFilter);
      if (looksLikeUuid) {
        params.push(customerFilter);
        filters.push(`c.id = $${params.length}`);
      } else {
        params.push(`%${customerFilter}%`);
        filters.push(`(c.name ILIKE $${params.length} OR c.primary_domain ILIKE $${params.length})`);
      }
    }
    if (trialEndingSoon) {
      const days = Math.min(Math.max(Number(trialEndingSoon) || 7, 1), 90);
      params.push(days);
      filters.push(`s.status = 'trialing' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= NOW() + ($${params.length}::text || ' days')::interval`);
    }

    const query = `
      SELECT
        c.id AS customer_id,
        c.name AS customer_name,
        c.primary_domain,
        c.status AS customer_status,
        c.seat_limit,
        s.id AS subscription_id,
        s.status AS subscription_status,
        s.billing_cycle,
        s.trial_ends_at,
        s.current_period_start,
        s.current_period_end,
        s.cancel_at_period_end,
        s.external_billing_id,
        p.id AS plan_id,
        p.code AS plan_code,
        p.name AS plan_name,
        p.monthly_price_cents,
        p.yearly_price_cents,
        p.max_users,
        p.max_workflows,
        p.max_tasks,
        p.included_runs_per_month,
        p.overage_price_per_1000_runs,
        COALESCE(u.users_used, 0) AS users_used
      FROM billing_subscriptions s
      JOIN subscriptions c ON c.id = s.customer_id
      JOIN plans p ON p.id = s.plan_id
      LEFT JOIN (
        SELECT subscription_id, COUNT(*) FILTER (WHERE is_active IS NULL OR is_active = true) AS users_used
        FROM users
        GROUP BY subscription_id
      ) u ON u.subscription_id = c.id
      WHERE s.status IN ('trialing','active','past_due','cancelled')
      ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY c.name ASC
    `;

    const result = await pool.query(query, params);
    const rows = result.rows.map((row) => {
      const seatLimit = Number(row.seat_limit);
      const planMaxUsers = Number(row.max_users);
      const usersAllowed = Number.isFinite(seatLimit) && seatLimit > 0 ? seatLimit : planMaxUsers;
      return {
        customer: {
          id: row.customer_id,
          name: row.customer_name,
          primaryDomain: row.primary_domain,
          status: row.customer_status,
        },
        plan: {
          id: row.plan_id,
          code: row.plan_code,
          name: row.plan_name,
          monthlyPriceCents: row.monthly_price_cents,
          yearlyPriceCents: row.yearly_price_cents,
          limits: {
            maxUsers: planMaxUsers,
            maxWorkflows: Number(row.max_workflows),
            maxTasks: Number(row.max_tasks),
            includedRunsPerMonth: Number(row.included_runs_per_month),
          },
          overagePricePer1000Runs: row.overage_price_per_1000_runs,
        },
        subscription: {
          id: row.subscription_id,
          status: row.subscription_status,
          billingCycle: row.billing_cycle,
          trialEndsAt: row.trial_ends_at,
          currentPeriodStart: row.current_period_start,
          currentPeriodEnd: row.current_period_end,
          cancelAtPeriodEnd: row.cancel_at_period_end,
          externalBillingId: row.external_billing_id,
        },
        usage: {
          usersUsed: Number(row.users_used),
          usersAllowed,
          runsUsed: 0,
          runsAllowed: Number(row.included_runs_per_month),
        },
      };
    });

    res.json({ subscriptions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function normalizeBillingCycle(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'yearly' ? 'yearly' : 'monthly';
}

function normalizeSubscriptionStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'trialing' || v === 'active' || v === 'past_due' || v === 'suspended' || v === 'cancelled') return v;
  return '';
}

function canTransitionSubscriptionStatus(fromStatus, toStatus) {
  const from = normalizeSubscriptionStatus(fromStatus);
  const to = normalizeSubscriptionStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;
  if (from === 'cancelled') return false;
  if (to === 'trialing') return from === 'trialing';
  if (from === 'suspended') return to === 'active' || to === 'cancelled' || to === 'suspended';
  if (from === 'trialing') return to === 'active' || to === 'suspended' || to === 'cancelled';
  if (from === 'active' || from === 'past_due') return to === 'active' || to === 'suspended' || to === 'cancelled' || to === 'past_due';
  return false;
}

async function insertSubscriptionHistory(client, { subscriptionId, actorUserId, fromPlanId, toPlanId, note }) {
  if (!schemaCaps.tables.subscription_history) return;
  await client.query(
    `
    INSERT INTO subscription_history (id, subscription_id, actor_user_id, from_plan_id, to_plan_id, note)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), subscriptionId, actorUserId, fromPlanId || null, toPlanId || null, String(note || '').trim() || null]
  );
}

async function getSubscriptionDetailById(client, subscriptionId) {
  const billingResult = await client.query(
    `
    SELECT
      s.*,
      p.code AS plan_code,
      p.name AS plan_name,
      p.monthly_price_cents,
      p.yearly_price_cents,
      p.max_users,
      p.max_workflows,
      p.max_tasks,
      p.included_runs_per_month,
      p.overage_price_per_1000_runs,
      p.description AS plan_description,
      c.id AS customer_id,
      c.name AS customer_name,
      c.primary_domain,
      c.status AS customer_status,
      c.seat_limit
    FROM billing_subscriptions s
    JOIN plans p ON p.id = s.plan_id
    JOIN subscriptions c ON c.id = s.customer_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [subscriptionId]
  );
  const billing = billingResult.rows[0] || null;
  if (!billing) return null;

  const usersUsed = await getActiveUsersCount(billing.customer_id);
  const usersAllowed = await getEffectiveMaxUsersForCustomer(billing.customer_id);

  const history = schemaCaps.tables.subscription_history
    ? await client.query(
        `
        SELECT h.*, p1.code AS from_plan_code, p2.code AS to_plan_code
        FROM subscription_history h
        LEFT JOIN plans p1 ON p1.id = h.from_plan_id
        LEFT JOIN plans p2 ON p2.id = h.to_plan_id
        WHERE h.subscription_id = $1
        ORDER BY h.created_at DESC
        LIMIT 50
        `,
        [billing.id]
      )
    : { rows: [] };

  return {
    customer: {
      id: billing.customer_id,
      name: billing.customer_name,
      primaryDomain: billing.primary_domain,
      status: billing.customer_status,
      seatLimit: billing.seat_limit,
    },
    subscription: {
      id: billing.id,
      customerId: billing.customer_id,
      status: billing.status,
      billingCycle: billing.billing_cycle,
      trialEnd: billing.trial_ends_at,
      currentPeriodStart: billing.current_period_start,
      currentPeriodEnd: billing.current_period_end,
      cancelAtPeriodEnd: billing.cancel_at_period_end,
      externalBillingId: billing.external_billing_id,
      plan: {
        id: billing.plan_id,
        code: billing.plan_code,
        name: billing.plan_name,
        monthlyPriceCents: billing.monthly_price_cents,
        yearlyPriceCents: billing.yearly_price_cents,
        limits: {
          maxUsers: Number(billing.max_users),
          maxWorkflows: Number(billing.max_workflows),
          maxTasks: Number(billing.max_tasks),
          includedRunsPerMonth: Number(billing.included_runs_per_month),
        },
        overagePricePer1000Runs: billing.overage_price_per_1000_runs,
        description: billing.plan_description,
      },
      usage: {
        usersUsed,
        usersAllowed,
        runsUsed: 0,
        runsAllowed: Number(billing.included_runs_per_month),
        workflowsCount: 0,
        tasksCount: 0,
      },
      history: history.rows.map((h) => ({
        id: h.id,
        createdAt: h.created_at,
        actorUserId: h.actor_user_id,
        fromPlanId: h.from_plan_id,
        toPlanId: h.to_plan_id,
        fromPlanCode: h.from_plan_code,
        toPlanCode: h.to_plan_code,
        note: h.note,
      })),
    },
  };
}

app.get('/api/admin/subscriptions/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    if (!schemaCaps.tables.billing_subscriptions || !schemaCaps.tables.plans) {
      return res.status(501).json({ error: 'Billing subscriptions are not enabled in this environment' });
    }
    const subscriptionId = req.params.id;
    const detail = await getSubscriptionDetailById(pool, subscriptionId);
    if (!detail) return res.status(404).json({ error: 'Subscription not found' });
    res.json(detail);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/subscriptions', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!schemaCaps.tables.billing_subscriptions || !schemaCaps.tables.plans) {
      return res.status(501).json({ error: 'Billing subscriptions are not enabled in this environment' });
    }

    const body = req.body || {};
    const customerId = String(body.customerId || '').trim();
    const planId = String(body.planId || '').trim();
    const billingCycle = normalizeBillingCycle(body.billingCycle);
    const trialEndRaw = body.trialEnd;
    const trialEnd = trialEndRaw ? new Date(trialEndRaw) : null;
    if (!customerId || !planId) return res.status(400).json({ error: 'customerId and planId are required' });
    if (trialEnd && Number.isNaN(trialEnd.getTime())) return res.status(400).json({ error: 'trialEnd must be a valid date' });

    await client.query('BEGIN');

    const customerResult = await client.query('SELECT id FROM subscriptions WHERE id = $1', [customerId]);
    if (customerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer not found' });
    }

    const planResult = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
    const plan = planResult.rows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Plan not found' });
    }
    if (plan.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Plan is inactive' });
    }

    const existing = await client.query(
      `
      SELECT id FROM billing_subscriptions
      WHERE customer_id = $1 AND status IN ('trialing','active','past_due')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [customerId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Customer already has an active subscription', subscriptionId: existing.rows[0].id });
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const status = trialEnd && trialEnd.getTime() > now.getTime() ? 'trialing' : 'active';
    const subId = randomUUID();
    await client.query(
      `
      INSERT INTO billing_subscriptions (
        id, customer_id, plan_id, billing_cycle, status,
        trial_ends_at, current_period_start, current_period_end,
        cancel_at_period_end, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),NOW())
      `,
      [subId, customerId, planId, billingCycle, status, trialEnd ? trialEnd.toISOString() : null, now.toISOString(), periodEnd.toISOString()]
    );

    await insertSubscriptionHistory(client, {
      subscriptionId: subId,
      actorUserId: req.user.id,
      fromPlanId: null,
      toPlanId: planId,
      note: 'Subscription assigned via admin',
    });

    await client.query('COMMIT');
    const detail = await getSubscriptionDetailById(pool, subId);
    res.status(201).json(detail);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/subscriptions/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!schemaCaps.tables.billing_subscriptions || !schemaCaps.tables.plans) {
      return res.status(501).json({ error: 'Billing subscriptions are not enabled in this environment' });
    }
    const subscriptionId = req.params.id;
    const body = req.body || {};

    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM billing_subscriptions WHERE id = $1', [subscriptionId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const updates = [];
    const values = [];
    const set = (field, value) => {
      values.push(value);
      updates.push(`${field} = $${values.length}`);
    };

    let desiredPlanId = null;
    if (Object.prototype.hasOwnProperty.call(body, 'planId')) {
      desiredPlanId = String(body.planId || '').trim();
      if (!desiredPlanId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'planId cannot be empty' });
      }
      const planResult = await client.query('SELECT * FROM plans WHERE id = $1', [desiredPlanId]);
      const plan = planResult.rows[0];
      if (!plan) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Plan not found' });
      }
      if (plan.is_active === false) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Plan is inactive' });
      }

      const usersUsed = await getActiveUsersCount(current.customer_id);
      const desiredMaxUsers = Number(plan.max_users);
      if (Number.isFinite(desiredMaxUsers) && desiredMaxUsers > 0 && usersUsed > desiredMaxUsers) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Change would reduce limits below current usage',
          blocking: { users: { used: usersUsed, limit: desiredMaxUsers } },
        });
      }

      if (String(current.plan_id) !== desiredPlanId) set('plan_id', desiredPlanId);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'billingCycle')) {
      const cycle = normalizeBillingCycle(body.billingCycle);
      if (cycle && String(current.billing_cycle || '') !== cycle) set('billing_cycle', cycle);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'cancelAtPeriodEnd')) {
      set('cancel_at_period_end', Boolean(body.cancelAtPeriodEnd));
    }

    if (Object.prototype.hasOwnProperty.call(body, 'trialEnd')) {
      const raw = body.trialEnd;
      const next = raw ? new Date(raw) : null;
      if (next && Number.isNaN(next.getTime())) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'trialEnd must be a valid date' });
      }
      if (normalizeSubscriptionStatus(current.status) !== 'trialing' && next) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'trialEnd can only be set while subscription is trialing' });
      }
      set('trial_ends_at', next ? next.toISOString() : null);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const desired = normalizeSubscriptionStatus(body.status);
      if (!desired) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (!canTransitionSubscriptionStatus(current.status, desired)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Invalid status transition: ${current.status} -> ${desired}` });
      }
      if (String(current.status) !== desired) set('status', desired);
      if (normalizeSubscriptionStatus(current.status) === 'trialing' && desired !== 'trialing') {
        set('trial_ends_at', null);
      }
      if (desired === 'cancelled') {
        set('cancel_at_period_end', false);
        set('current_period_end', new Date().toISOString());
      }
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(subscriptionId);
    await client.query(`UPDATE billing_subscriptions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);

    await insertSubscriptionHistory(client, {
      subscriptionId,
      actorUserId: req.user.id,
      fromPlanId: desiredPlanId ? current.plan_id : null,
      toPlanId: desiredPlanId ? desiredPlanId : null,
      note: 'Subscription updated via admin',
    });

    await client.query('COMMIT');
    const detail = await getSubscriptionDetailById(pool, subscriptionId);
    res.json(detail);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/subscriptions/:id/cancel', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!schemaCaps.tables.billing_subscriptions || !schemaCaps.tables.plans) {
      return res.status(501).json({ error: 'Billing subscriptions are not enabled in this environment' });
    }
    const subscriptionId = req.params.id;
    const body = req.body || {};
    const immediate = Boolean(body.immediate);

    await client.query('BEGIN');
    const currentResult = await client.query('SELECT * FROM billing_subscriptions WHERE id = $1', [subscriptionId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }
    const status = normalizeSubscriptionStatus(current.status);
    if (status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.json({ success: true });
    }

    if (immediate) {
      await client.query(
        `UPDATE billing_subscriptions SET status = 'cancelled', cancel_at_period_end = false, current_period_end = NOW(), updated_at = NOW() WHERE id = $1`,
        [subscriptionId]
      );
      await insertSubscriptionHistory(client, {
        subscriptionId,
        actorUserId: req.user.id,
        fromPlanId: current.plan_id,
        toPlanId: current.plan_id,
        note: 'Subscription cancelled immediately via admin',
      });
    } else {
      await client.query(`UPDATE billing_subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`, [subscriptionId]);
      await insertSubscriptionHistory(client, {
        subscriptionId,
        actorUserId: req.user.id,
        fromPlanId: current.plan_id,
        toPlanId: current.plan_id,
        note: 'Subscription set to cancel at period end via admin',
      });
    }

    await client.query('COMMIT');
    const detail = await getSubscriptionDetailById(pool, subscriptionId);
    res.json(detail);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/subscriptions/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const allowDangerous =
      process.env.NODE_ENV !== 'production' && String(process.env.TASKY_ALLOW_DANGEROUS_ADMIN_DELETE || '').trim().toLowerCase() === 'true';
    if (!allowDangerous) return res.status(403).json({ error: 'Delete is disabled in this environment' });
    if (String(req.query.confirm || '') !== 'DELETE') return res.status(400).json({ error: "Missing confirm=DELETE" });

    if (!schemaCaps.tables.billing_subscriptions) {
      return res.status(501).json({ error: 'Billing subscriptions are not enabled in this environment' });
    }

    const subscriptionId = req.params.id;
    await client.query('BEGIN');
    if (schemaCaps.tables.subscription_history) {
      await client.query('DELETE FROM subscription_history WHERE subscription_id = $1', [subscriptionId]);
    }
    const deleted = await client.query('DELETE FROM billing_subscriptions WHERE id = $1 RETURNING id, customer_id', [subscriptionId]);
    if (deleted.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/customers/:customerId/users', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = String(req.params.customerId || '').trim();
    const customerResult = await pool.query('SELECT id FROM subscriptions WHERE id = $1', [customerId]);
    if (customerResult.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

    const cols = ['id', 'email', 'role', 'name', 'created_at'];
    if (schemaCaps.users.has_is_active) cols.push('is_active');
    if (schemaCaps.users.has_last_login_at) cols.push('last_login_at');
    const result = await pool.query(`SELECT ${cols.join(', ')} FROM users WHERE subscription_id = $1 ORDER BY created_at ASC`, [
      customerId,
    ]);
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/customers/:customerId/users', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const customerId = String(req.params.customerId || '').trim();
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const role = normalizeUserRole(body.role || 'member');
    const name = String(body.name || '').trim() || String(email.split('@')[0] || 'User').trim() || 'User';
    const providedPassword = Object.prototype.hasOwnProperty.call(body, 'password') ? String(body.password || '') : '';

    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!role) return res.status(400).json({ error: 'role is required' });

    await client.query('BEGIN');
    const customerResult = await client.query('SELECT id FROM subscriptions WHERE id = $1', [customerId]);
    if (customerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer not found' });
    }

    const currentUsersCount = await getActiveUsersCount(customerId);
    const seatLimitRow = await client.query('SELECT seat_limit FROM subscriptions WHERE id = $1', [customerId]);
    const seatLimit = Number(seatLimitRow.rows[0]?.seat_limit);
    const maxUsersAllowed = await getEffectiveMaxUsersForCustomer(customerId);
    const effectiveLimit = Number.isFinite(seatLimit) && seatLimit > 0 ? seatLimit : maxUsersAllowed;
    const seatError = validateSeatLimit({ currentUsersCount, seatLimit: effectiveLimit });
    if (seatError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: seatError });
    }

    const existingUserResult = await client.query('SELECT 1 FROM users WHERE subscription_id = $1 AND LOWER(email) = LOWER($2)', [
      customerId,
      email,
    ]);
    if (existingUserResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A user with that email already exists in this workspace' });
    }

    const tempPassword = providedPassword || randomUUID().replace(/-/g, '').slice(0, 12);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const newUserId = randomUUID();
    const useExtended = schemaCaps.users.has_customer_id && schemaCaps.users.has_is_active && schemaCaps.users.has_updated_at;

    const created = useExtended
      ? await client.query(
          `
          INSERT INTO users (id, subscription_id, customer_id, email, password, name, role, is_active, updated_at)
          VALUES ($1, $2, $2, $3, $4, $5, $6, true, NOW())
          RETURNING id, email, role, name, subscription_id, is_active, created_at
          `,
          [newUserId, customerId, email, hashedPassword, name, role]
        )
      : await client.query(
          `
          INSERT INTO users (id, subscription_id, email, password, name, role)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, email, role, name, subscription_id, created_at
          `,
          [newUserId, customerId, email, hashedPassword, name, role]
        );

    await client.query('COMMIT');
    await logActivity({
      customerId,
      userId: req.user.id,
      sourceType: 'system',
      sourceId: created.rows[0]?.id,
      action: 'ADMIN_USER_CREATED',
      severity: 'info',
      messageInternal: `Admin created user: ${String(email).trim()}`,
      messageUser: 'A user was added to the workspace.',
      metadata: { email, role },
    });

    res.status(201).json({ user: created.rows[0], temporaryPassword: providedPassword ? undefined : tempPassword });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/customers/:customerId/users/:userId', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const customerId = String(req.params.customerId || '').trim();
    const userId = String(req.params.userId || '').trim();
    const body = req.body || {};

    await client.query('BEGIN');
    const targetResult = await client.query('SELECT * FROM users WHERE id = $1 AND subscription_id = $2', [userId, customerId]);
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const values = [];
    const set = (field, value) => {
      values.push(value);
      updates.push(`${field} = $${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(body, 'role')) {
      const desiredRole = normalizeUserRole(body.role);
      if (!desiredRole) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid role' });
      }
      set('role', desiredRole);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'is_active') || Object.prototype.hasOwnProperty.call(body, 'isActive')) {
      if (!schemaCaps.users.has_is_active) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'User activation is not supported by the current schema' });
      }
      const desiredActive = Object.prototype.hasOwnProperty.call(body, 'isActive') ? Boolean(body.isActive) : Boolean(body.is_active);
      set('is_active', desiredActive);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(userId);
    const tailSet = schemaCaps.users.has_updated_at ? ', updated_at = NOW()' : '';
    const returningCols = ['id', 'email', 'role', 'name', 'created_at'];
    if (schemaCaps.users.has_is_active) returningCols.push('is_active');
    if (schemaCaps.users.has_last_login_at) returningCols.push('last_login_at');
    const updated = await client.query(
      `UPDATE users SET ${updates.join(', ')}${tailSet} WHERE id = $${values.length} RETURNING ${returningCols.join(', ')}`,
      values
    );
    await client.query('COMMIT');

    await logActivity({
      customerId,
      userId: req.user.id,
      sourceType: 'system',
      sourceId: userId,
      action: 'ADMIN_USER_UPDATED',
      severity: 'info',
      messageInternal: `Admin updated user: ${String(target.email).trim()}`,
      messageUser: 'User updated.',
      metadata: { updates: body },
    });

    res.json({ user: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/customers/:customerId/users/:userId', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const customerId = String(req.params.customerId || '').trim();
    const userId = String(req.params.userId || '').trim();

    await client.query('BEGIN');
    const targetResult = await client.query('SELECT * FROM users WHERE id = $1 AND subscription_id = $2', [userId, customerId]);
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    if (schemaCaps.users.has_is_active) {
      await client.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [userId]);
    } else {
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    }

    await client.query('COMMIT');
    await logActivity({
      customerId,
      userId: req.user.id,
      sourceType: 'system',
      sourceId: userId,
      action: 'ADMIN_USER_REMOVED',
      severity: 'warning',
      messageInternal: `Admin removed user: ${String(target.email).trim()}`,
      messageUser: 'User removed.',
      metadata: {},
    });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/customers/:id/subscription', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = req.params.id;
    const customerResult = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [customerId]);
    const customer = customerResult.rows[0];
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const billingResult = await pool.query(
      `
      SELECT
        s.*,
        p.code AS plan_code,
        p.name AS plan_name,
        p.monthly_price_cents,
        p.yearly_price_cents,
        p.max_users,
        p.max_workflows,
        p.max_tasks,
        p.included_runs_per_month,
        p.overage_price_per_1000_runs,
        p.description AS plan_description
      FROM billing_subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1
      `,
      [customerId]
    );
    const billing = billingResult.rows[0] || null;

    const usersUsed = await getActiveUsersCount(customerId);
    const usersAllowed = await getEffectiveMaxUsersForCustomer(customerId);

    const historyResult = await pool.query(
      `
      SELECT h.*, p1.code AS from_plan_code, p2.code AS to_plan_code
      FROM subscription_history h
      LEFT JOIN plans p1 ON p1.id = h.from_plan_id
      LEFT JOIN plans p2 ON p2.id = h.to_plan_id
      WHERE h.subscription_id = $1
      ORDER BY h.created_at DESC
      LIMIT 50
      `,
      [billing?.id || '00000000-0000-0000-0000-000000000000']
    );

    res.json({
      customer,
      subscription: billing
        ? {
            id: billing.id,
            customerId: billing.customer_id,
            status: billing.status,
            billingCycle: billing.billing_cycle,
            trialEndsAt: billing.trial_ends_at,
            currentPeriodStart: billing.current_period_start,
            currentPeriodEnd: billing.current_period_end,
            cancelAtPeriodEnd: billing.cancel_at_period_end,
            externalBillingId: billing.external_billing_id,
            plan: {
              id: billing.plan_id,
              code: billing.plan_code,
              name: billing.plan_name,
              monthlyPriceCents: billing.monthly_price_cents,
              yearlyPriceCents: billing.yearly_price_cents,
              limits: {
                maxUsers: Number(billing.max_users),
                maxWorkflows: Number(billing.max_workflows),
                maxTasks: Number(billing.max_tasks),
                includedRunsPerMonth: Number(billing.included_runs_per_month),
              },
              overagePricePer1000Runs: billing.overage_price_per_1000_runs,
              description: billing.plan_description,
            },
            usage: {
              usersUsed,
              usersAllowed,
              runsUsed: 0,
              runsAllowed: Number(billing.included_runs_per_month),
              workflowsCount: 0,
              tasksCount: 0,
            },
            history: historyResult.rows.map((h) => ({
              id: h.id,
              createdAt: h.created_at,
              actorUserId: h.actor_user_id,
              fromPlanId: h.from_plan_id,
              toPlanId: h.to_plan_id,
              fromPlanCode: h.from_plan_code,
              toPlanCode: h.to_plan_code,
              note: h.note,
            })),
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/customers/:id/subscription/change-plan', authMiddleware, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const customerId = req.params.id;
    const { planId, planCode, billingCycle, force } = req.body || {};

    const desiredPlanResult = planId
      ? await client.query('SELECT * FROM plans WHERE id = $1 LIMIT 1', [planId])
      : await client.query('SELECT * FROM plans WHERE code = $1 LIMIT 1', [String(planCode || '').trim().toUpperCase()]);
    const desiredPlan = desiredPlanResult.rows[0];
    if (!desiredPlan) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Plan not found' });
    }
    if (desiredPlan.is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Plan is inactive' });
    }

    const currentSubResult = await client.query(
      `
      SELECT * FROM billing_subscriptions
      WHERE customer_id = $1 AND status IN ('trialing','active','past_due')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [customerId]
    );
    const currentSub = currentSubResult.rows[0];

    const usersUsed = await getActiveUsersCount(customerId);
    const desiredMaxUsers = Number(desiredPlan.max_users);
    if (!force && Number.isFinite(desiredMaxUsers) && desiredMaxUsers > 0 && usersUsed > desiredMaxUsers) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Downgrade would reduce limits below current usage',
        blocking: { users: { used: usersUsed, limit: desiredMaxUsers } },
      });
    }

    const cycle = String(billingCycle || currentSub?.billing_cycle || 'monthly').trim().toLowerCase() === 'yearly' ? 'yearly' : 'monthly';

    let subId = currentSub?.id;
    if (!subId) {
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      subId = randomUUID();
      await client.query(
        `
        INSERT INTO billing_subscriptions (
          id, customer_id, plan_id, billing_cycle, status,
          current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'active', $5, $6, false, NOW(), NOW())
        `,
        [subId, customerId, desiredPlan.id, cycle, now.toISOString(), periodEnd.toISOString()]
      );
    } else {
      await client.query(
        `UPDATE billing_subscriptions SET plan_id = $1, billing_cycle = $2, updated_at = NOW() WHERE id = $3`,
        [desiredPlan.id, cycle, subId]
      );
    }

    await client.query(
      `
      INSERT INTO subscription_history (id, subscription_id, actor_user_id, from_plan_id, to_plan_id, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        randomUUID(),
        subId,
        req.user.id,
        currentSub?.plan_id || null,
        desiredPlan.id,
        'Plan changed via admin',
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/customers/:id/subscription/cancel', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = req.params.id;
    await pool.query(
      `
      UPDATE billing_subscriptions
      SET cancel_at_period_end = true, updated_at = NOW()
      WHERE customer_id = $1 AND status IN ('trialing','active','past_due')
      `,
      [customerId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/customers/:id/subscription/resume', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = req.params.id;
    await pool.query(
      `
      UPDATE billing_subscriptions
      SET cancel_at_period_end = false, updated_at = NOW()
      WHERE customer_id = $1 AND status IN ('trialing','active','past_due')
      `,
      [customerId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/customers/:id/suspend', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = req.params.id;
    await pool.query(`UPDATE subscriptions SET status = 'suspended', updated_at = NOW() WHERE id = $1`, [customerId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/customers/:id/unsuspend', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const customerId = req.params.id;
    await pool.query(`UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = $1`, [customerId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/plans', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY monthly_price_cents ASC, name ASC');
    res.json({ plans: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/plans', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const id = randomUUID();
    const plan = {
      monthly_price_cents: Number(body.monthly_price_cents) || 0,
      yearly_price_cents: body.yearly_price_cents === null || body.yearly_price_cents === undefined ? null : Number(body.yearly_price_cents) || 0,
      max_users: Number(body.max_users) || 1,
      max_workflows: Number(body.max_workflows) || 0,
      max_tasks: Number(body.max_tasks) || 0,
      included_runs_per_month: Number(body.included_runs_per_month) || 0,
      overage_price_per_1000_runs:
        body.overage_price_per_1000_runs === null || body.overage_price_per_1000_runs === undefined
          ? null
          : Number(body.overage_price_per_1000_runs) || 0,
      description: String(body.description || '').trim(),
      is_active: body.is_active !== false,
    };
    await pool.query(
      `
      INSERT INTO plans (
        id, code, name, monthly_price_cents, yearly_price_cents,
        max_users, max_workflows, max_tasks,
        included_runs_per_month, overage_price_per_1000_runs,
        description, is_active, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
      `,
      [
        id,
        code,
        name,
        plan.monthly_price_cents,
        plan.yearly_price_cents,
        plan.max_users,
        plan.max_workflows,
        plan.max_tasks,
        plan.included_runs_per_month,
        plan.overage_price_per_1000_runs,
        plan.description,
        plan.is_active,
      ]
    );
    const created = await pool.query('SELECT * FROM plans WHERE id = $1', [id]);
    res.status(201).json({ plan: created.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/admin/plans/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const current = await pool.query('SELECT * FROM plans WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    const body = req.body || {};

    const fields = [];
    const values = [];
    const set = (name, value) => {
      values.push(value);
      fields.push(`${name} = $${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(body, 'name')) set('name', String(body.name || '').trim());
    if (Object.prototype.hasOwnProperty.call(body, 'monthly_price_cents')) set('monthly_price_cents', Number(body.monthly_price_cents) || 0);
    if (Object.prototype.hasOwnProperty.call(body, 'yearly_price_cents'))
      set(
        'yearly_price_cents',
        body.yearly_price_cents === null || body.yearly_price_cents === undefined ? null : Number(body.yearly_price_cents) || 0
      );
    if (Object.prototype.hasOwnProperty.call(body, 'max_users')) set('max_users', Number(body.max_users) || 1);
    if (Object.prototype.hasOwnProperty.call(body, 'max_workflows')) set('max_workflows', Number(body.max_workflows) || 0);
    if (Object.prototype.hasOwnProperty.call(body, 'max_tasks')) set('max_tasks', Number(body.max_tasks) || 0);
    if (Object.prototype.hasOwnProperty.call(body, 'included_runs_per_month')) set('included_runs_per_month', Number(body.included_runs_per_month) || 0);
    if (Object.prototype.hasOwnProperty.call(body, 'overage_price_per_1000_runs'))
      set(
        'overage_price_per_1000_runs',
        body.overage_price_per_1000_runs === null || body.overage_price_per_1000_runs === undefined
          ? null
          : Number(body.overage_price_per_1000_runs) || 0
      );
    if (Object.prototype.hasOwnProperty.call(body, 'description')) set('description', String(body.description || '').trim());
    if (Object.prototype.hasOwnProperty.call(body, 'is_active')) set('is_active', body.is_active !== false);

    if (fields.length === 0) return res.status(400).json({ error: 'No updates provided' });
    values.push(id);
    await pool.query(`UPDATE plans SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);
    const updated = await pool.query('SELECT * FROM plans WHERE id = $1', [id]);
    res.json({ plan: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/users', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT u.id, u.email, u.role, u.name, u.is_active, u.is_super_admin, u.last_login_at, u.created_at,
             c.id AS customer_id, c.name AS customer_name
      FROM users u
      LEFT JOIN subscriptions c ON c.id = u.subscription_id
      ORDER BY c.name ASC NULLS LAST, u.email ASC
      `
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/admin/users/:id', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const fields = [];
    const values = [];
    const set = (name, value) => {
      values.push(value);
      fields.push(`${name} = $${values.length}`);
    };
    if (Object.prototype.hasOwnProperty.call(body, 'isActive')) set('is_active', Boolean(body.isActive));
    if (Object.prototype.hasOwnProperty.call(body, 'isSuperAdmin')) set('is_super_admin', Boolean(body.isSuperAdmin));
    if (Object.prototype.hasOwnProperty.call(body, 'role')) set('role', normalizeUserRole(body.role));
    if (fields.length === 0) return res.status(400).json({ error: 'No updates provided' });
    values.push(req.params.id);
    const updated = await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id, email, role, name, is_active, is_super_admin, last_login_at`,
      values
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================
// Dashboard Endpoints
// ======================

app.get('/api/dashboard/overview', authMiddleware, async (req, res) => {
  try {
    console.log('Fetching dashboard overview data...');
    let totalWorkflows = 0;
    let activeWorkflows = 0;
    let inactiveWorkflows = 0;
    let totalExecutions = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;
    let runningExecutions = 0;
    let averageExecutionTimeMs = 0;
    let last24hExecutions = 0;
    let last7dExecutions = 0;
    let topWorkflows = [];
    let topFailedWorkflows = [];

    const workflowsResult = await aePool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE active = true) as active FROM workflow_entity');
    totalWorkflows = parseInt(workflowsResult.rows[0].total);
    activeWorkflows = parseInt(workflowsResult.rows[0].active);
    inactiveWorkflows = totalWorkflows - activeWorkflows;

    // Keep failure summary aligned with table queries using canonical failed statuses.
    const executionsResult = await aePool.query(`
        SELECT 
          COUNT(DISTINCT id) as total,
          COUNT(DISTINCT id) FILTER (WHERE status = 'success') as successful,
          COUNT(DISTINCT id) FILTER (
            WHERE LOWER(COALESCE(status, '')) = ANY($1::text[])
          ) as failed,
          COUNT(DISTINCT id) FILTER (WHERE status = 'running') as running,
          AVG(COALESCE(EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt")) * 1000, 0)) as avg_duration,
          COUNT(DISTINCT id) FILTER (WHERE "startedAt" >= NOW() - INTERVAL '24 HOURS') as last_24h,
          COUNT(DISTINCT id) FILTER (WHERE "startedAt" >= NOW() - INTERVAL '7 DAYS') as last_7d
        FROM execution_entity
      `, [FAILED_EXECUTION_STATUSES]);
    totalExecutions = toNumber(executionsResult.rows[0].total, 0);
    successfulExecutions = toNumber(executionsResult.rows[0].successful, 0);
    failedExecutions = toNumber(executionsResult.rows[0].failed, 0);
    runningExecutions = toNumber(executionsResult.rows[0].running, 0);
    averageExecutionTimeMs = toNumber(executionsResult.rows[0].avg_duration, 0);
    last24hExecutions = toNumber(executionsResult.rows[0].last_24h, 0);
    last7dExecutions = toNumber(executionsResult.rows[0].last_7d, 0);

    const topWorkflowsResult = await aePool.query(`
      SELECT 
        w.id as "workflowId",
        w.name as workflow_name,
        COUNT(DISTINCT e.id) as execution_count
      FROM workflow_entity w
      LEFT JOIN execution_entity e ON w.id = e."workflowId"
      WHERE LOWER(COALESCE(CAST(w.active AS text), 'false')) IN ('true', 't', '1', 'yes', 'y')
      GROUP BY w.id, w.name
      HAVING COUNT(DISTINCT e.id) > 0
      ORDER BY execution_count DESC
      LIMIT 10
    `);
    topWorkflows = topWorkflowsResult.rows;

    const topFailedWorkflowsResult = await aePool.query(`
      SELECT 
        w.id as "workflowId",
        w.name as workflow_name,
        COUNT(DISTINCT e.id) as failure_count
      FROM workflow_entity w
      LEFT JOIN execution_entity e ON w.id = e."workflowId" AND (
        LOWER(COALESCE(e.status, '')) = ANY($1::text[])
      )
      GROUP BY w.id, w.name
      HAVING COUNT(DISTINCT e.id) > 0
      ORDER BY failure_count DESC, w.name ASC
      LIMIT 10
    `, [FAILED_EXECUTION_STATUSES]);
    topFailedWorkflows = topFailedWorkflowsResult.rows;

    console.log('Dashboard overview data fetched successfully');
    res.json({
      success: true,
      data: {
        totalWorkflows,
        activeWorkflows,
        inactiveWorkflows,
        totalExecutions,
        successfulExecutions,
        failedExecutions,
        runningExecutions,
        successRate: totalExecutions > 0 
          ? parseFloat(((successfulExecutions / totalExecutions) * 100).toFixed(2))
          : 0,
        failureRate: totalExecutions > 0
          ? parseFloat(((failedExecutions / totalExecutions) * 100).toFixed(2))
          : 0,
        averageExecutionTimeMs,
        last24hExecutions,
        last7dExecutions,
        topWorkflows,
        topFailedWorkflows
      }
    });
  } catch (err) {
    console.error('Overview API Error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

app.get('/api/workflows', authMiddleware, requirePermission('WORKFLOWS_VIEW'), async (req, res) => {
  try {
    let workflows = [];
    try {
      const result = await aePool.query('SELECT * FROM workflow_entity ORDER BY "updatedAt" DESC');
      workflows = result.rows;
    } catch (e) {
      console.error('Error fetching workflows:', e);
    }
    res.json({ workflows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function getSubscriptionPlanForCustomer(customerId) {
  const result = await pool.query(
    `
    SELECT
      s.id AS subscription_id,
      s.name,
      s.status,
      s.seat_limit,
      s.current_period_start,
      s.current_period_end,
      p.id AS plan_id,
      p.code AS plan_code,
      p.name AS plan_name,
      p.monthly_price_cents,
      p.yearly_price_cents,
      p.max_users,
      p.max_workflows,
      p.max_tasks,
      p.included_runs_per_month,
      p.overage_price_per_1000_runs,
      p.description AS plan_description
    FROM subscriptions s
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [customerId]
  );
  return result.rows[0] || null;
}

function toPlanObject(row) {
  if (!row || !row.plan_code) return null;
  return {
    code: String(row.plan_code),
    name: String(row.plan_name || ''),
    monthly_price_cents: Number(row.monthly_price_cents || 0),
    yearly_price_cents: row.yearly_price_cents === null || row.yearly_price_cents === undefined ? null : Number(row.yearly_price_cents),
    max_users: Number(row.max_users || 0),
    max_workflows: Number(row.max_workflows || 0),
    max_tasks: Number(row.max_tasks || 0),
    included_runs_per_month: Number(row.included_runs_per_month || 0),
    overage_price_per_1000_runs: row.overage_price_per_1000_runs === null || row.overage_price_per_1000_runs === undefined ? null : Number(row.overage_price_per_1000_runs),
    description: String(row.plan_description || ''),
  };
}

async function getCurrentUserSubscriptionPayload(userId) {
  const userResult = await pool.query('SELECT subscription_id FROM users WHERE id = $1', [userId]);
  const subscriptionId = userResult.rows[0]?.subscription_id;
  if (!subscriptionId) return null;
  const row = await getSubscriptionPlanForCustomer(subscriptionId);
  if (!row) return null;
  const currentUserCount = await getActiveUsersCount(subscriptionId);
  return {
    subscription_id: String(row.subscription_id),
    name: String(row.name || ''),
    status: String(row.status || 'active'),
    seat_limit: Number(row.seat_limit || 0),
    current_user_count: Number(currentUserCount || 0),
    plan: toPlanObject(row),
    current_period_start: row.current_period_start ? new Date(row.current_period_start).toISOString() : null,
    current_period_end: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
  };
}

app.post('/api/workflows', authMiddleware, requirePermission('WORKFLOWS_MANAGE'), async (req, res) => {
  try {
    const requestingUserResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const requestingUser = requestingUserResult.rows[0];
    if (!hasPermission(requestingUser, 'WORKFLOWS_MANAGE')) {
      return res.status(403).json({ error: 'Only technical users or workspace admins may create workflows' });
    }

    const customerId = requestingUser.subscription_id;
    const subRow = await getSubscriptionPlanForCustomer(customerId);
    const maxWorkflows = subRow?.plan_code ? Number(subRow.max_workflows || 0) : 0;
    if (subRow?.plan_code) {
      const maxTasks = Number(subRow.max_tasks || 0);
      const includedRuns = Number(subRow.included_runs_per_month || 0);
      if (maxTasks > 0 || includedRuns > 0) {
        console.warn('Task/run limits are not enforced yet', {
          plan: String(subRow.plan_code),
          maxTasks,
          includedRunsPerMonth: includedRuns,
        });
      }
    }
    let currentWorkflows = 0;
    try {
      const count = await aePool.query('SELECT COUNT(*)::int AS count FROM workflow_entity');
      currentWorkflows = Number(count.rows[0]?.count || 0);
    } catch (e) {
      console.warn('Workflow limit check skipped: failed to count workflows:', e?.message || e);
    }

    if (maxWorkflows > 0 && currentWorkflows >= maxWorkflows) {
      return res.status(400).json({ error: `Workflow limit reached for your subscription plan (${currentWorkflows}/${maxWorkflows}).` });
    }

    const desiredName = String(req.body?.name || '').trim() || 'New Workflow';
    const payload = {
      name: desiredName,
      nodes: [],
      connections: {},
      settings: {},
      active: false,
    };

    const path = N8N_API_KEY ? '/api/v1/workflows' : '/rest/workflows';
    const n8nRes = await n8nFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await n8nRes.text();
    if (!n8nRes.ok) {
      return res.status(502).json({ error: `Automation Engine error ${n8nRes.status}: ${text.slice(0, 500)}` });
    }
    const created = JSON.parse(text);
    return res.status(201).json({ workflow: created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/executions', authMiddleware, requirePermission('MONITORING_VIEW'), async (req, res) => {
  try {
    const { workflowId, status, startDate, endDate, limit = 50, offset = 0 } = req.query;
    let executions = [];
    
    try {
      let query = `
        SELECT 
          e.*, 
          w.name as workflow_name,
          COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0) as duration_ms
        FROM execution_entity e 
        JOIN workflow_entity w ON e."workflowId" = w.id 
        WHERE 1=1
      `;
      const params = [];
      let paramIndex = 1;

      if (workflowId) {
        query += ` AND e."workflowId" = $${paramIndex}`;
        params.push(workflowId);
        paramIndex++;
      }

      if (status) {
        query += ` AND e.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (startDate) {
        query += ` AND e."startedAt" >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        query += ` AND e."startedAt" <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      query += ` ORDER BY e."startedAt" DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(parseInt(limit), parseInt(offset));

      const result = await aePool.query(query, params);
      executions = result.rows;
    } catch (e) {
      console.error('Error fetching executions:', e);
    }
    
    res.json({ executions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/plans', authMiddleware, async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        code,
        name,
        monthly_price_cents,
        yearly_price_cents,
        max_users,
        max_workflows,
        max_tasks,
        included_runs_per_month,
        overage_price_per_1000_runs,
        description
      FROM plans
      WHERE is_active = true
        AND code IN ('STARTER','TEAM','BUSINESS')
      ORDER BY monthly_price_cents ASC, code ASC
      `
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/subscription', authMiddleware, requirePermission('SUBSCRIPTION_VIEW'), async (req, res) => {
  try {
    const payload = await getCurrentUserSubscriptionPayload(req.user.id);
    if (!payload) return res.status(404).json({ error: 'Subscription not found' });
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/subscription/change-plan', authMiddleware, requirePermission('SUBSCRIPTION_CHANGE_PLAN'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT id, subscription_id, role, is_owner, is_super_admin FROM users WHERE id = $1', [
      req.user.id,
    ]);
    const user = userResult.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'User not found' });
    }

    const allowed = hasPermission(user, 'SUBSCRIPTION_CHANGE_PLAN');
    if (!allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only workspace admins may change the subscription plan.' });
    }

    const planCode = String(req.body?.plan_code || '').trim().toUpperCase();
    if (!planCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'plan_code is required' });
    }

    const planResult = await client.query('SELECT * FROM plans WHERE code = $1 AND is_active = true LIMIT 1', [planCode]);
    const plan = planResult.rows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Unknown plan_code: ${planCode}` });
    }

    const subscriptionId = String(user.subscription_id || '').trim();
    const subResult = await client.query('SELECT * FROM subscriptions WHERE id = $1 LIMIT 1', [subscriptionId]);
    const subscription = subResult.rows[0];
    if (!subscription) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const userCountResult = await client.query(
      schemaCaps.users.has_is_active
        ? `SELECT COUNT(*)::int AS count FROM users WHERE subscription_id = $1 AND (is_active IS NULL OR is_active = true)`
        : `SELECT COUNT(*)::int AS count FROM users WHERE subscription_id = $1`,
      [subscriptionId]
    );
    const userCount = Number(userCountResult.rows[0]?.count || 0);
    const allowedUsers = Number(plan.max_users || 0);
    const planError = validatePlanChangeUserCount({ currentUsersCount: userCount, planMaxUsers: allowedUsers });
    if (planError) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: planError,
      });
    }

    const now = new Date();
    const periodStart = now.toISOString();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    await client.query(
      `
      UPDATE subscriptions
      SET plan_id = $1,
          seat_limit = $2,
          current_period_start = $3,
          current_period_end = $4,
          updated_at = NOW()
      WHERE id = $5
      `,
      [plan.id, Number(plan.max_users || 0), periodStart, periodEnd.toISOString(), subscriptionId]
    );

    await client.query('COMMIT');
    const payload = await getCurrentUserSubscriptionPayload(req.user.id);
    return res.json(payload);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/grafana/dashboard', authMiddleware, requirePermission('MONITORING_VIEW'), async (req, res) => {
  try {
    const { from = 'now-6h', to = 'now', workflowId, status } = req.query;
    
    let grafanaUrl = `${GRAFANA_URL}/d/${GRAFANA_DASHBOARD_UID}/taskyhub-overview?orgId=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&kiosk`;
    
    if (workflowId) {
      grafanaUrl += `&var-workflowId=${encodeURIComponent(workflowId)}`;
    }
    
    if (status) {
      grafanaUrl += `&var-status=${encodeURIComponent(status)}`;
    }

    res.json({
      success: true,
      data: {
        dashboardUrl: grafanaUrl,
        dashboardUid: GRAFANA_DASHBOARD_UID
      }
    });
  } catch (err) {
    console.error('Grafana Dashboard API Error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const aeBaseUrl = getAeBaseUrl();
    const forwardedProtoRaw = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHostRaw = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
    const effectiveProto = forwardedProtoRaw || 'http';
    const effectiveHost = forwardedHostRaw;
    const publicGrafanaUrl = effectiveHost ? `${effectiveProto}://${effectiveHost}/grafana/` : '/grafana/';
    const isInternalGrafanaUrl = /^http:\/\/(grafana|localhost|127\.0\.0\.1)(:|\/|$)/i.test(String(GRAFANA_URL || ''));
    res.json({
      grafanaUrl: isInternalGrafanaUrl ? publicGrafanaUrl : GRAFANA_URL,
      aeUrl: aeBaseUrl,
      n8nUrl: aeBaseUrl // Keep for backward compatibility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/debug/schema', authMiddleware, requireSuperAdmin, async (req, res) => {
  try {
    const tablesResult = await pool.query(`
      SELECT
        to_regclass('public.users') IS NOT NULL AS users,
        to_regclass('public.subscriptions') IS NOT NULL AS subscriptions,
        to_regclass('public.plans') IS NOT NULL AS plans,
        to_regclass('public.billing_subscriptions') IS NOT NULL AS billing_subscriptions,
        to_regclass('public.integration_credentials') IS NOT NULL AS integration_credentials
    `);
    const tables = tablesResult.rows[0] || {};

    const expectedColumns = {
      users: ['id', 'email', 'role', 'subscription_id', 'customer_id', 'is_active', 'is_owner', 'is_super_admin', 'last_login_at'],
      subscriptions: ['id', 'name', 'seat_limit', 'primary_domain', 'status', 'plan_id', 'current_period_start', 'current_period_end'],
      plans: ['id', 'code', 'name', 'max_users', 'max_workflows', 'max_tasks', 'included_runs_per_month', 'is_active'],
      billing_subscriptions: ['id', 'customer_id', 'plan_id', 'status', 'current_period_start', 'current_period_end'],
      integration_credentials: ['id', 'customer_id', 'integration_type', 'label', 'status', 'n8n_credential_id', 'created_at'],
    };

    const colsResult = await pool.query(
      `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      `,
      [Object.keys(expectedColumns)]
    );
    const present = new Map();
    for (const row of colsResult.rows) {
      const key = `${row.table_name}.${row.column_name}`;
      present.set(key, true);
    }

    const columns = {};
    for (const [tableName, cols] of Object.entries(expectedColumns)) {
      columns[tableName] = {};
      for (const col of cols) {
        columns[tableName][col] = present.get(`${tableName}.${col}`) === true;
      }
    }

    res.json({
      schemaCaps,
      config: {
        integrationsEncryptionConfigured: integrationsEncryptionConfigured(),
        n8nApiConfigured: n8nApiConfigured(),
      },
      tables,
      columns,
    });
  } catch (err) {
    console.error('Schema debug error:', err);
    res.status(500).json({ error: 'Failed to load schema debug data' });
  }
});

app.get('/api/failures', authMiddleware, requirePermission('MONITORING_VIEW'), async (req, res) => {
  try {
    const { workflowId, startDate, endDate, limit = 50, offset = 0 } = req.query;
    let failures = [];
    let failureRate = 0;
    
    try {
      let query = `
        SELECT 
          e.id as execution_id,
          e."workflowId",
          w.name as workflow_name,
          e.status,
          e."startedAt" as start_time,
          e."stoppedAt" as end_time,
          NULL::jsonb as data,
          COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0) as duration_ms
        FROM execution_entity e 
        JOIN workflow_entity w ON e."workflowId" = w.id 
        WHERE (
          LOWER(COALESCE(e.status, '')) = ANY($1::text[])
        )
      `;
      const params = [];
      let paramIndex = 2;

      if (workflowId) {
        query += ` AND e."workflowId" = $${paramIndex}`;
        params.push(workflowId);
        paramIndex++;
      }

      if (startDate) {
        query += ` AND e."startedAt" >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        query += ` AND e."startedAt" <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      query += ` ORDER BY e."startedAt" DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(parseInt(limit), parseInt(offset));

      const failuresResult = await aePool.query(query, [FAILED_EXECUTION_STATUSES, ...params]);
      failures = failuresResult.rows.map((failure) => {
        const { failedNode, errorMessage, errorType, stackTrace } = normalizeFailureDetails(failure);
        return {
          ...failure,
          failedNode,
          errorType,
          errorMessage,
          stackTrace,
          errorMessageShort: truncateErrorMessage(errorMessage, 180),
        };
      });

      const statsResult = await aePool.query(`
        SELECT 
          COUNT(DISTINCT id) as total_executions,
          COUNT(DISTINCT id) FILTER (
            WHERE LOWER(COALESCE(status, '')) = ANY($1::text[])
          ) as failed_executions
        FROM execution_entity
        WHERE "startedAt" >= NOW() - INTERVAL '7 days'
      `, [FAILED_EXECUTION_STATUSES]);
      
      const total = toNumber(statsResult.rows[0].total_executions, 0);
      const failed = toNumber(statsResult.rows[0].failed_executions, 0);
      failureRate = total > 0 ? (failed / total) * 100 : 0;
      
    } catch (e) {
      console.error('Error fetching failures:', e);
    }

    res.json({ failures, failureRate: parseFloat(failureRate.toFixed(2)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/trends', authMiddleware, async (req, res) => {
  try {
    const trendsResult = await aePool.query(`
      SELECT 
        DATE_TRUNC('hour', "startedAt") as hour,
        COUNT(DISTINCT id) as total,
        COUNT(DISTINCT id) FILTER (WHERE status = 'success') as successful,
        COUNT(DISTINCT id) FILTER (
          WHERE LOWER(COALESCE(status, '')) = ANY($1::text[])
        ) as failed
      FROM execution_entity
      WHERE "startedAt" >= NOW() - INTERVAL '24 HOURS'
      GROUP BY DATE_TRUNC('hour', "startedAt")
      ORDER BY hour ASC
    `, [FAILED_EXECUTION_STATUSES]);
    res.json({
      success: true,
      data: trendsResult.rows
    });
  } catch (err) {
    console.error('Trends API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard/performance', authMiddleware, async (req, res) => {
  try {
    const performanceResult = await aePool.query(`
      SELECT 
        w.id,
        w.name,
        w.active,
        COUNT(DISTINCT e.id) as total_executions,
        COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'success') as successful_executions,
        COUNT(DISTINCT e.id) FILTER (
          WHERE LOWER(COALESCE(e.status, '')) = ANY($1::text[])
        ) as failed_executions,
        COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'running') as running_executions,
        AVG(COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0)) as avg_duration,
        MAX(e."startedAt") as last_execution_at,
        MAX(CASE WHEN e."startedAt" = (SELECT MAX("startedAt") FROM execution_entity WHERE "workflowId" = w.id) THEN e.status END) as last_status
      FROM workflow_entity w
      LEFT JOIN execution_entity e ON w.id = e."workflowId"
      GROUP BY w.id, w.name, w.active
      ORDER BY total_executions DESC
    `, [FAILED_EXECUTION_STATUSES]);
    
    const workflowsWithHealth = performanceResult.rows.map(wf => {
      const health = computeWorkflowHealth(wf);
      return {
        ...wf,
        successRate: parseFloat(health.successRate.toFixed(2)),
        failureRate: parseFloat(health.failureRate.toFixed(2)),
        healthScore: health.healthScore,
        healthCategory: health.healthCategory,
      };
    });
    
    res.json({
      success: true,
      data: workflowsWithHealth
    });
  } catch (err) {
    console.error('Performance API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard/failures/detailed', authMiddleware, async (req, res) => {
  try {
    console.log('Fetching detailed failures...');
    const detailedFailuresResult = await aePool.query(`
      SELECT 
        e.id,
        e."workflowId",
        w.name as workflow_name,
        e.status,
        e."startedAt",
        e."stoppedAt",
        NULL::jsonb as data,
        COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0) as duration_ms
      FROM execution_entity e 
      LEFT JOIN workflow_entity w ON e."workflowId" = w.id 
      WHERE (
        LOWER(COALESCE(e.status, '')) = ANY($1::text[])
      )
      ORDER BY e."startedAt" DESC
      LIMIT 50
    `, [FAILED_EXECUTION_STATUSES]);
    
    console.log('Detailed failures query complete, rows:', detailedFailuresResult.rows.length);
    
    const failuresWithDetails = detailedFailuresResult.rows.map(failure => {
      const { failedNode, errorMessage, errorType, stackTrace } = normalizeFailureDetails(failure);
      return {
        ...failure,
        failedNode,
        errorMessage,
        stackTrace,
        errorMessageShort: truncateErrorMessage(errorMessage, 180),
        errorType
      };
    });
    
    console.log('Detailed failures processed');
    res.json({
      success: true,
      data: failuresWithDetails
    });
  } catch (err) {
    console.error('Detailed Failures API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard/insights', authMiddleware, async (req, res) => {
  try {
    const insights = [];
    
    const failureStatsResult = await aePool.query(`
      SELECT 
        COUNT(*) as total_failures,
        COUNT(*) FILTER (WHERE "startedAt" >= NOW() - INTERVAL '1 HOUR') as failures_last_hour
      FROM execution_entity 
      WHERE (
        LOWER(COALESCE(status, '')) = ANY($1::text[])
      )
    `, [FAILED_EXECUTION_STATUSES]);
    
    const totalFailures = parseInt(failureStatsResult.rows[0].total_failures);
    const failuresLastHour = parseInt(failureStatsResult.rows[0].failures_last_hour);
    
    if (failuresLastHour > 10) {
      insights.push({
        type: 'warning',
        message: `High failure rate detected: ${failuresLastHour} failures in last hour`
      });
    }
    
    if (totalFailures > 50) {
      insights.push({
        type: 'error',
        message: `Total failures: ${totalFailures}, consider reviewing your workflows`
      });
    }
    
    const topFailedResult = await aePool.query(`
      SELECT 
        w.name as workflow_name,
        COUNT(DISTINCT e.id) as failure_count
      FROM workflow_entity w
      JOIN execution_entity e ON w.id = e."workflowId"
      WHERE (
        LOWER(COALESCE(e.status, '')) = ANY($1::text[])
      )
      GROUP BY w.id, w.name
      ORDER BY failure_count DESC
      LIMIT 3
    `, [FAILED_EXECUTION_STATUSES]);
    
    topFailedResult.rows.forEach(wf => {
      insights.push({
        type: 'warning',
        message: `Workflow "${wf.workflow_name}" has ${wf.failure_count} failures`
      });
    });
    
    res.json({
      success: true,
      data: insights
    });
  } catch (err) {
    console.error('Insights API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function pollWorkflowFailures() {
  if (!TASKY_SUBSCRIPTION_ID) return;

  try {
    const result = await aePool.query(
      `
      SELECT
        e.id as execution_id,
        e.status,
        e.data,
        e."workflowId" as workflow_id,
        w.name as workflow_name,
        e."startedAt" as started_at
      FROM execution_entity e
      JOIN workflow_entity w ON w.id = e."workflowId"
      WHERE LOWER(COALESCE(e.status, '')) = ANY($1::text[])
        AND e."startedAt" >= NOW() - INTERVAL '15 minutes'
      ORDER BY e."startedAt" DESC
      LIMIT 20
      `,
      [FAILED_EXECUTION_STATUSES]
    );

    for (const row of result.rows) {
      const executionId = String(row.execution_id);
      const exists = await pool.query(
        `SELECT 1 FROM activity_logs WHERE customer_id = $1 AND action = 'WORKFLOW_RUN_FAILED' AND metadata->>'executionId' = $2 LIMIT 1`,
        [String(TASKY_SUBSCRIPTION_ID), executionId]
      );
      if (exists.rows.length > 0) continue;

      const details = normalizeFailureDetails({ status: row.status, data: row.data });
      const shortReason = truncateErrorMessage(details.errorMessage || '');
      const workflowName = String(row.workflow_name || 'Workflow').trim();
      const internalMessage = shortReason ? `Workflow "${workflowName}" failed: ${shortReason}` : `Workflow "${workflowName}" failed`;
      const userMessage = `Workflow "${workflowName}" failed. Check your workflow steps and connected accounts.`;

      await logActivity({
        customerId: TASKY_SUBSCRIPTION_ID,
        userId: null,
        sourceType: 'workflow',
        sourceId: String(row.workflow_id),
        action: 'WORKFLOW_RUN_FAILED',
        severity: 'error',
        messageInternal: internalMessage,
        messageUser: userMessage,
        metadata: {
          executionId,
          workflowId: String(row.workflow_id),
          workflowName,
          status: String(row.status || ''),
          failedNode: details.failedNode,
          errorType: details.errorType,
        },
      });
    }
  } catch (err) {
    console.error('Workflow failure poller error:', err.message || err);
  }
}

async function waitForDatabase() {
  let attemptsRemaining = 40;
  while (attemptsRemaining > 0) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      attemptsRemaining -= 1;
      if (attemptsRemaining <= 0) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

async function bootstrapUsersWithRetry() {
  let attemptsRemaining = 20;
  while (attemptsRemaining > 0) {
    const adminDone = await ensureBootstrapAdminUserOnce();
    if (adminDone) {
      const subscriptionId = await resolveBootstrapSubscriptionId(TASKY_SUBSCRIPTION_ID);
      const userDone = await ensureBootstrapUserOnce(subscriptionId);
      if (userDone) return true;
    }
    attemptsRemaining -= 1;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function startServer() {
  try {
    await waitForDatabase();
    try {
      await ensureSaasSchema();
    } catch (err) {
      console.error('Schema ensure failed:', err.message || err);
    }
    await refreshSchemaCaps();
    try {
      await bootstrapUsersWithRetry();
    } catch (err) {
      console.error('Bootstrap users failed:', err.message || err);
    }
    apiReady = true;

    app.listen(PORT, () => {
      console.log(`TaskyHub API listening on port ${PORT}`);
    });

    setTimeout(() => {
      pollWorkflowFailures();
      setInterval(pollWorkflowFailures, 60000);
    }, 15000);
  } catch (err) {
    console.error('Startup failed:', err.message || err);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  getPricingPlanSeeds,
  normalizeUserRole,
  roleRank,
  getEffectiveRole,
  hasPermission,
  isPlatformRole,
  validateSeatLimit,
  validatePlanChangeUserCount,
  toPlanObject,
};
