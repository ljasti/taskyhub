const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const {
  FAILED_EXECUTION_STATUSES,
  normalizeFailureDetails,
  truncateErrorMessage,
  computeWorkflowHealth,
  toNumber,
} = require('./dashboard-utils');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskyhub-secret';
const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:3000';
const AE_URL = process.env.AE_URL || 'http://localhost:5678';
const GRAFANA_DASHBOARD_UID = 'taskyhub-overview';

app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'taskyhub_db',
  user: process.env.DB_USER || 'taskyhub_user',
  password: process.env.DB_PASSWORD || 'taskyhub_pwd',
});

const aePool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.AE_DB_NAME || 'ae_db',
  user: process.env.AE_DB_USER || 'ae_user',
  password: process.env.AE_DB_PASSWORD || 'ae_pwd',
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

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'taskyhub-api', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', service: 'taskyhub-api', db: 'disconnected' });
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
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    const demoLoginAllowed = isAllowedDemoLogin(email, password);

    if (!passwordMatch && !demoLoginAllowed) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
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
              OR data::text ILIKE '%"error"%'
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
        OR e.data::text ILIKE '%"error"%'
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
    res.json({
      grafanaUrl: GRAFANA_URL,
      aeUrl: AE_URL
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
          e.data,
          COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0) as duration_ms
        FROM execution_entity e 
        JOIN workflow_entity w ON e."workflowId" = w.id 
        WHERE (
          LOWER(COALESCE(e.status, '')) = ANY($1::text[])
          OR e.data::text ILIKE '%"error"%'
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
              OR data::text ILIKE '%"error"%'
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
            OR data::text ILIKE '%"error"%'
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
            OR e.data::text ILIKE '%"error"%'
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
        e.data,
        COALESCE(EXTRACT(EPOCH FROM (e."stoppedAt" - e."startedAt")) * 1000, 0) as duration_ms
      FROM execution_entity e 
      LEFT JOIN workflow_entity w ON e."workflowId" = w.id 
      WHERE (
        LOWER(COALESCE(e.status, '')) = ANY($1::text[])
        OR e.data::text ILIKE '%"error"%'
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
        OR data::text ILIKE '%"error"%'
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
        OR e.data::text ILIKE '%"error"%'
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

app.listen(PORT, () => {
  console.log(`TaskyHub API listening on port ${PORT}`);
});
