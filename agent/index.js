import { createServer } from 'node:http';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import express from 'express';
import cors from 'cors';
import { initDB, getState, setState } from './db.js';

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
  AGENT_SECRET,
  FRONTEND_URL,
  PORT = '3001',
  DB_PATH,
  // cTrader credentials from env — seeded into agent_state at boot so the
  // loop can trade without waiting for the UI to push config.
  CTRADER_ACCESS_TOKEN,
  CTRADER_REFRESH_TOKEN,
  CTRADER_TOKEN_EXPIRES_IN,
  CTRADER_ACCOUNT_ID,
  CTRADER_IS_LIVE,
} = process.env;

if (!AGENT_SECRET) {
  console.error('[agent] FATAL: AGENT_SECRET env var is required — set it in Railway Variables')
  console.error('[agent] Required env vars: AGENT_SECRET, ANTHROPIC_API_KEY')
  console.error('[agent] Optional: CTRADER_ACCESS_TOKEN, CTRADER_ACCOUNT_ID, CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Database — ensure parent directory exists before opening SQLite
// ---------------------------------------------------------------------------

const resolvedDbPath = DB_PATH || './agent.db';
try {
  const dir = dirname(resolve(resolvedDbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[boot] Created DB directory: ${dir}`);
  }
} catch (err) {
  console.error(`[boot] Cannot create DB directory for ${resolvedDbPath}:`, err.message);
}

console.log(`[boot] Opening database at: ${resolvedDbPath}`);
const db = initDB(resolvedDbPath);

// Seed cTrader credentials from env vars if present and not already stored.
// This lets Railway hold the secrets so the agent starts trading immediately
// after deploy — no UI push required.
if (CTRADER_ACCESS_TOKEN && !getState(db, 'ctrader_access_token')) {
  setState(db, 'ctrader_access_token', CTRADER_ACCESS_TOKEN)
  console.log('[boot] cTrader access token seeded from env')
}
// Seed refresh token + expiry so server-side refresh can run even before the
// UI pushes /actions/ctrader-config. Without these the bot dies at 30 days.
if (CTRADER_REFRESH_TOKEN && !getState(db, 'ctrader_refresh_token')) {
  setState(db, 'ctrader_refresh_token', CTRADER_REFRESH_TOKEN)
  console.log('[boot] cTrader refresh token seeded from env')
}
if (CTRADER_TOKEN_EXPIRES_IN && !getState(db, 'ctrader_token_expires_at')) {
  const secs = parseInt(CTRADER_TOKEN_EXPIRES_IN, 10)
  if (Number.isFinite(secs) && secs > 0) {
    setState(db, 'ctrader_token_expires_at', String(Date.now() + secs * 1000))
    console.log(`[boot] cTrader token expiry seeded (+${Math.round(secs / 86400)}d)`)
  }
}
if (CTRADER_ACCOUNT_ID && !getState(db, 'ctrader_account_id')) {
  setState(db, 'ctrader_account_id', CTRADER_ACCOUNT_ID)
  setState(db, 'ctrader_is_live', CTRADER_IS_LIVE === 'true' ? 'true' : 'false')
  console.log('[boot] cTrader account ID seeded from env')
}

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
  } catch {}

  const circuitBreaker = getState(db, 'circuit_breaker_tripped_at')
  const lastError = getState(db, 'last_error')
  const errorsToday = Number(getState(db, 'errors_today') || 0)

  let openPositions = 0
  let openTrades = 0
  try {
    openPositions = db.prepare("SELECT COUNT(*) as c FROM monitored_positions WHERE status = 'active'").get().c
    openTrades = db.prepare("SELECT COUNT(*) as c FROM trades WHERE status = 'open'").get().c
  } catch {}

  const status = circuitBreaker ? 'circuit_breaker_tripped' : 'ok'

  res.json({
    status,
    uptime: process.uptime(),
    loopCount: Number(getState(db, 'loop_count') || 0),
    lastScanAt: getState(db, 'last_scan_at'),
    lastLoopMs: Number(getState(db, 'last_loop_ms') || 0),
    dbSize,
    dbSizeMB: Number((dbSize / 1048576).toFixed(2)),
    errorsToday,
    lastError: lastError || null,
    circuitBreaker: circuitBreaker || null,
    openPositions,
    openTrades,
    scanEnabled: getState(db, 'scan_enabled') !== 'false',
    analyzeEnabled: getState(db, 'analyze_enabled') !== 'false',
    autotradeEnabled: getState(db, 'autotrade_enabled') === 'true',
    memoryMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
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

  server.listen(port, '0.0.0.0', () => {
    console.log(`[agent] listening on 0.0.0.0:${port}`);
    console.log(`[agent] CORS origin: ${FRONTEND_URL || '*'}`);
    console.log(`[agent] DB path: ${DB_PATH || './agent.db'}`);
    console.log(`[agent] ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? 'set' : 'MISSING'}`);
    console.log(`[agent] CTRADER_ACCESS_TOKEN: ${CTRADER_ACCESS_TOKEN ? 'set' : 'not set'}`);
    console.log(`[agent] TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? 'set' : 'not set'}`);
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

process.on('uncaughtException', (err) => {
  console.error('[agent] UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[agent] UNHANDLED REJECTION:', err);
});

console.log('[boot] Starting agent...');
start().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});

export { db };
