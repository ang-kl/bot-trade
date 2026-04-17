import { createServer } from 'node:http';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import cors from 'cors';
import { initDB, getState } from './db.js';

// Load .env file if present (no dotenv dependency needed)
try {
  const envPath = resolve(process.cwd(), '.env')
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    const val = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) process.env[key] = val
  }
} catch {}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const {
  ANTHROPIC_API_KEY,
  MASSIVE_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AGENT_SECRET = 'change-me',
  FRONTEND_URL,
  PORT = '3001',
  DB_PATH,
} = process.env;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = initDB(DB_PATH);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// ---------------------------------------------------------------------------
// Auth middleware — skip for GET /health
// ---------------------------------------------------------------------------

function authMiddleware(req, res, next) {
  if (req.method === 'GET' && req.path === '/health') return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || token !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Health endpoint (public)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  let dbSize = 0;
  try {
    const resolvedPath = DB_PATH || './agent.db';
    const stat = fs.statSync(resolvedPath);
    dbSize = stat.size;
  } catch {
    // DB file may not exist yet
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    loopCount: Number(getState(db, 'loop_count') || 0),
    lastScanAt: getState(db, 'last_scan_at'),
    dbSize,
  });
});

// ---------------------------------------------------------------------------
// Mount route modules
// ---------------------------------------------------------------------------

async function mountRoutes() {
  try {
    const { default: stateRouter } = await import('./routes/state.js');
    app.use('/state', stateRouter(db));
  } catch (err) {
    console.warn('[boot] routes/state.js not loaded:', err.message);
  }

  try {
    const { default: actionsRouter } = await import('./routes/actions.js');
    app.use('/actions', actionsRouter(db));
  } catch (err) {
    console.warn('[boot] routes/actions.js not loaded:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  await mountRoutes();

  const server = createServer(app);
  const port = Number(PORT);

  server.listen(port, () => {
    console.log(`[agent] listening on :${port}`);
    console.log(`[agent] CORS origin: ${FRONTEND_URL || '*'}`);
    console.log(`[agent] DB path: ${DB_PATH || './agent.db'}`);
  });

  // Start the main scan loop (non-blocking import so server boots even if
  // loop.js hasn't been created yet)
  try {
    const { startLoop } = await import('./loop.js');
    startLoop(db);
    console.log('[agent] scan loop started');
  } catch (err) {
    console.warn('[agent] loop.js not loaded — loop will not run:', err.message);
  }

  // ----- Graceful shutdown ------------------------------------------------
  const shutdown = (signal) => {
    console.log(`\n[agent] received ${signal}, shutting down...`);
    server.close(() => {
      try {
        db.close();
      } catch { /* already closed */ }
      console.log('[agent] goodbye');
      process.exit(0);
    });

    // Force exit after 10 s if connections linger
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});

export { db };
