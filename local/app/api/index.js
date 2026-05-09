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

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskyhub-secret';
const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:3000';
const AE_INTERNAL_URL = process.env.AE_INTERNAL_URL || process.env.AE_URL || process.env.N8N_URL || 'http://localhost:5678';
const AE_PUBLIC_URL = process.env.AE_PUBLIC_URL || AE_INTERNAL_URL;
const GRAFANA_DASHBOARD_UID = 'taskyhub-overview';
const TASKY_ADMIN_EMAIL = (process.env.TASKY_ADMIN_EMAIL || '').trim();
const TASKY_ADMIN_PASSWORD = process.env.TASKY_ADMIN_PASSWORD || '';
const TASKY_ADMIN_NAME = (process.env.TASKY_ADMIN_NAME || 'DevOps Engineer').trim();
const TASKY_ADMIN_ROLE = (process.env.TASKY_ADMIN_ROLE || 'admin').trim();
const TASKY_USER_EMAIL = (process.env.TASKY_USER_EMAIL || '').trim();
const TASKY_USER_PASSWORD = process.env.TASKY_USER_PASSWORD || '';
const TASKY_USER_NAME = (process.env.TASKY_USER_NAME || 'Developer').trim();
const TASKY_USER_ROLE = (process.env.TASKY_USER_ROLE || 'user').trim();
const TASKY_SUBSCRIPTION_ID = (process.env.TASKY_SUBSCRIPTION_ID || '').trim();

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

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
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
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    subscriptionId: user.subscription_id,
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
    let subscriptionId = TASKY_SUBSCRIPTION_ID;

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

    if (!subscriptionId) {
      console.warn('Admin bootstrap skipped: no subscription found');
      return;
    }

    const passwordHash = await bcrypt.hash(TASKY_ADMIN_PASSWORD, 10);

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
      [randomUUID(), subscriptionId, TASKY_ADMIN_EMAIL, passwordHash, TASKY_ADMIN_NAME, TASKY_ADMIN_ROLE]
    );

    console.log(`Admin bootstrap ensured user exists: ${TASKY_ADMIN_EMAIL}`);
    return true;
  } catch (err) {
    console.error('Admin bootstrap failed:', err.message || err);
    return false;
  }
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

    const passwordHash = await bcrypt.hash(TASKY_USER_PASSWORD, 10);

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
      [randomUUID(), subscriptionId, TASKY_USER_EMAIL, passwordHash, TASKY_USER_NAME, TASKY_USER_ROLE]
    );

    console.log(`User bootstrap ensured user exists: ${TASKY_USER_EMAIL}`);
    return true;
  } catch (err) {
    console.error('User bootstrap failed:', err.message || err);
    return false;
  }
}

function authMiddleware(req, res, next) {
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
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
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
    await logActivity({
      customerId: user.subscription_id,
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
        subscriptionId: user.subscription_id 
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

setImmediate(() => {
  let attemptsRemaining = 20;
  const attempt = async () => {
    const adminDone = await ensureBootstrapAdminUserOnce();
    if (adminDone) {
      let subscriptionId = TASKY_SUBSCRIPTION_ID;
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

      const userDone = await ensureBootstrapUserOnce(subscriptionId);
      if (userDone) return;
    }
    attemptsRemaining -= 1;
    if (attemptsRemaining <= 0) return;
    setTimeout(attempt, 3000);
  };
  attempt();
});

app.get('/api/admin/ae/logs', authMiddleware, requireAdmin, async (req, res) => {
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

app.get('/api/activity-logs', authMiddleware, async (req, res) => {
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

app.get('/api/admin/activity-logs', authMiddleware, requireAdmin, async (req, res) => {
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
    const userResult = await pool.query(
      'SELECT id, email, role, name, subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const subResult = await pool.query(
      'SELECT * FROM subscriptions WHERE id = $1',
      [user.subscription_id]
    );
    const subscription = subResult.rows[0];

    return res.json({ 
      user: { 
        id: user.id, 
        email: user.email, 
        role: user.role, 
        name: user.name 
      }, 
      subscription 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, role, name FROM users WHERE subscription_id = $1',
      [req.user.subscriptionId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/users', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestingUserResult = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );
    const requestingUser = requestingUserResult.rows[0];

    if (!requestingUser || requestingUser.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only subscription admins may invite users' });
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

    const currentUsersResult = await client.query(
      'SELECT COUNT(*) FROM users WHERE subscription_id = $1',
      [subscription.id]
    );
    const currentUsersCount = parseInt(currentUsersResult.rows[0].count);
    if (currentUsersCount >= subscription.seat_limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Subscription seat limit reached' });
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

    const newUserResult = await client.query(
      'INSERT INTO users (id, subscription_id, email, password, name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, name',
      [newUserId, subscription.id, email, hashedPassword, name, role]
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

app.get('/api/workflows', authMiddleware, async (req, res) => {
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

app.get('/api/executions', authMiddleware, async (req, res) => {
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

app.get('/api/subscription', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const subscriptionId = userResult.rows[0].subscription_id;

    const subscriptionResult = await pool.query(
      'SELECT * FROM subscriptions WHERE id = $1',
      [subscriptionId]
    );
    const subscription = subscriptionResult.rows[0];

    if (!subscription) return res.status(404).json({ error: 'Subscription not found' });

    const usersResult = await pool.query(
      'SELECT id, email, role, name FROM users WHERE subscription_id = $1',
      [subscriptionId]
    );
    const users = usersResult.rows;

    res.json({ 
      subscription: { 
        ...subscription, 
        currentUsers: users.length 
      }, 
      users 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/grafana/dashboard', authMiddleware, async (req, res) => {
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
    res.json({
      grafanaUrl: GRAFANA_URL,
      aeUrl: aeBaseUrl,
      n8nUrl: aeBaseUrl // Keep for backward compatibility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/failures', authMiddleware, async (req, res) => {
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

setTimeout(() => {
  pollWorkflowFailures();
  setInterval(pollWorkflowFailures, 60000);
}, 15000);

app.listen(PORT, () => {
  console.log(`TaskyHub API listening on port ${PORT}`);
});
