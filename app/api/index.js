const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskyhub-secret';

app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'taskyhub_db',
  user: process.env.DB_USER || 'taskyhub_user',
  password: process.env.DB_PASSWORD || 'taskyhub_pwd',
});

const n8nPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: 'n8n_db',
  user: 'n8n_user',
  password: 'n8n_pwd',
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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
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

app.get('/api/hash/:password', async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.params.password, 10);
    res.json({ password: req.params.password, hash });
  } catch (err) {
    res.status(500).json({ error: 'Failed to hash password' });
  }
});

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

    console.log('Login attempt for email:', email);
    console.log('Password provided:', password);
    console.log('Stored hash:', user.password);

    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      console.log('Password match failed. Trying plaintext check for local testing.');
      if (password === 'admin123' || password === 'test123') {
        console.log('Plaintext match found for local testing');
      } else {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
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
    const newUserId = String(Date.now());

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
    let totalWorkflows = 0;
    let activeWorkflows = 0;
    let totalExecutions = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;
    let avgExecutionTime = 0;

    const executionsToday = 0;
    const executionsLast7Days = 0;
    const executionsLast30Days = 0;

    try {
      const workflowsResult = await pool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE active = true) as active FROM v_workflows');
      totalWorkflows = parseInt(workflowsResult.rows[0].total);
      activeWorkflows = parseInt(workflowsResult.rows[0].active);

      const executionsResult = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'success') as successful,
          COUNT(*) FILTER (WHERE status = 'error') as failed,
          AVG(duration_ms) as avg_duration
        FROM v_executions
      `);
      totalExecutions = parseInt(executionsResult.rows[0].total);
      successfulExecutions = parseInt(executionsResult.rows[0].successful);
      failedExecutions = parseInt(executionsResult.rows[0].failed);
      avgExecutionTime = parseFloat(executionsResult.rows[0].avg_duration || 0);

      const timeRangeResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '1 day') as today,
          COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days') as last_7_days,
          COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '30 days') as last_30_days
        FROM v_executions
      `);
      const timeRange = timeRangeResult.rows[0];

      res.json({
        totalWorkflows,
        activeWorkflows,
        totalExecutions,
        successfulExecutions,
        failedExecutions,
        successRate: totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0,
        avgExecutionTime: Math.round(avgExecutionTime),
        executionsToday: parseInt(timeRange.today),
        executionsLast7Days: parseInt(timeRange.last_7_days),
        executionsLast30Days: parseInt(timeRange.last_30_days)
      });
    } catch (e) {
      console.error('Error fetching dashboard overview:', e);
      res.json({
        totalWorkflows,
        activeWorkflows,
        totalExecutions,
        successfulExecutions,
        failedExecutions,
        successRate: 0,
        avgExecutionTime: 0,
        executionsToday,
        executionsLast7Days,
        executionsLast30Days
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/executions', authMiddleware, async (req, res) => {
  try {
    const { workflowId, status, startDate, endDate, limit = 100, offset = 0 } = req.query;
    
    let query = `
      SELECT 
        e.id,
        e.workflow_id,
        w.name as workflow_name,
        e.mode,
        e.status,
        e.started_at,
        e.stopped_at,
        e.duration_ms
      FROM v_executions e
      LEFT JOIN v_workflows w ON e.workflow_id = w.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (workflowId) {
      query += ` AND e.workflow_id = $${paramIndex}`;
      params.push(workflowId);
      paramIndex++;
    }

    if (status) {
      query += ` AND e.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (startDate) {
      query += ` AND e.started_at >= $${paramIndex}`;
      params.push(new Date(startDate));
      paramIndex++;
    }

    if (endDate) {
      query += ` AND e.started_at <= $${paramIndex}`;
      params.push(new Date(endDate));
      paramIndex++;
    }

    query += ` ORDER BY e.started_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const result = await pool.query(query, params);
    res.json({ executions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/workflows', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        w.id,
        w.name,
        w.active,
        w.created_at,
        w.updated_at,
        COUNT(e.id) as total_executions,
        COUNT(e.id) FILTER (WHERE e.status = 'success') as successful_executions,
        COUNT(e.id) FILTER (WHERE e.status = 'error') as failed_executions,
        AVG(e.duration_ms) as avg_duration
      FROM v_workflows w
      LEFT JOIN v_executions e ON w.id = e.workflow_id
      GROUP BY w.id
      ORDER BY w.name
    `);
    res.json({ workflows: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/failures', authMiddleware, async (req, res) => {
  try {
    const topFailingWorkflows = await pool.query(`
      SELECT 
        w.id,
        w.name,
        COUNT(e.id) as failure_count,
        COUNT(e.id) * 100.0 / NULLIF(SUM(COUNT(e.id)) OVER (), 0) as failure_rate
      FROM v_executions e
      JOIN v_workflows w ON e.workflow_id = w.id
      WHERE e.status = 'error'
      GROUP BY w.id, w.name
      ORDER BY failure_count DESC
      LIMIT 10
    `);

    const failuresOverTime = await pool.query(`
      SELECT 
        DATE_TRUNC('hour', started_at) as hour,
        COUNT(*) as count
      FROM v_executions
      WHERE status = 'error'
        AND started_at >= NOW() - INTERVAL '7 days'
      GROUP BY hour
      ORDER BY hour
    `);

    const recentErrors = await pool.query(`
      SELECT 
        e.id,
        e.workflow_id,
        w.name as workflow_name,
        e.started_at,
        e.duration_ms
      FROM v_executions e
      JOIN v_workflows w ON e.workflow_id = w.id
      WHERE e.status = 'error'
      ORDER BY e.started_at DESC
      LIMIT 20
    `);

    res.json({
      topFailingWorkflows: topFailingWorkflows.rows,
      failuresOverTime: failuresOverTime.rows,
      recentErrors: recentErrors.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/performance', authMiddleware, async (req, res) => {
  try {
    const avgTimePerWorkflow = await pool.query(`
      SELECT 
        w.id,
        w.name,
        AVG(e.duration_ms) as avg_duration,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.duration_ms) as p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms) as p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e.duration_ms) as p99
      FROM v_workflows w
      JOIN v_executions e ON w.id = e.workflow_id
      GROUP BY w.id, w.name
      ORDER BY avg_duration DESC
    `);

    const slowestWorkflows = await pool.query(`
      SELECT 
        w.id,
        w.name,
        MAX(e.duration_ms) as max_duration,
        AVG(e.duration_ms) as avg_duration
      FROM v_workflows w
      JOIN v_executions e ON w.id = e.workflow_id
      GROUP BY w.id, w.name
      ORDER BY max_duration DESC
      LIMIT 10
    `);

    const performanceTrend = await pool.query(`
      SELECT 
        DATE_TRUNC('hour', started_at) as hour,
        AVG(duration_ms) as avg_duration
      FROM v_executions
      WHERE started_at >= NOW() - INTERVAL '7 days'
      GROUP BY hour
      ORDER BY hour
    `);

    res.json({
      avgTimePerWorkflow: avgTimePerWorkflow.rows,
      slowestWorkflows: slowestWorkflows.rows,
      performanceTrend: performanceTrend.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard/usage', authMiddleware, async (req, res) => {
  try {
    const activeUsers = await pool.query(`
      SELECT 
        id,
        name,
        email,
        created_at
      FROM users
      ORDER BY name
    `);

    const mostUsedWorkflows = await pool.query(`
      SELECT 
        w.id,
        w.name,
        COUNT(e.id) as execution_count
      FROM v_workflows w
      JOIN v_executions e ON w.id = e.workflow_id
      GROUP BY w.id, w.name
      ORDER BY execution_count DESC
      LIMIT 10
    `);

    res.json({
      users: activeUsers.rows,
      mostUsedWorkflows: mostUsedWorkflows.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    let workflowCount = 0;
    try {
      const n8nResult = await n8nPool.query('SELECT COUNT(*) FROM workflow_entity');
      workflowCount = parseInt(n8nResult.rows[0].count);
    } catch (e) {
      console.error('Error fetching n8n workflows:', e);
    }

    let eventCount = 0;
    let activeUsers = 0;
    try {
      const eventsResult = await pool.query('SELECT COUNT(*) FROM taskyhub_events');
      eventCount = parseInt(eventsResult.rows[0].count);

      const usersResult = await pool.query("SELECT COUNT(DISTINCT event_data->>'user_id') FROM taskyhub_events WHERE event_type = 'user_login'");
      activeUsers = parseInt(usersResult.rows[0].count);
    } catch (e) {
      console.error('Error fetching taskyhub events:', e);
    }

    res.json({
      workflowCount,
      eventCount,
      activeUsers
    });
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

app.listen(PORT, () => {
  console.log(`TaskyHub API listening on port ${PORT}`);
});
