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
  ANTHROPIC_MAP_KEY_API,
  TELEGRAM_BOT_TOKEN,
  AGENT_SECRET,
  FRONTEND_URL,
  PORT = '3001',
  DB_PATH,
  // cTrader credentials from env — seeded into agent_state at boot so the
  // loop can trade without waiting for the UI to push config.
  CTRADER_ACCESS_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_IS_LIVE,
} = process.env;

if (!AGENT_SECRET) {
  console.error('[agent] FATAL: AGENT_SECRET env var is required — set it in Railway Variables')
  console.error('[agent] Required env vars: AGENT_SECRET, ANTHROPIC_MAP_KEY_API')
  console.error('[agent] Optional: CTRADER_ACCESS_TOKEN, CTRADER_ACCOUNT_ID, CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID')
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
// after deploy — no UI push required. Both CANONICAL_CASE and the
// cTrader_Mixed_Case spellings are accepted.
const envAccessToken = CTRADER_ACCESS_TOKEN || process.env.cTrader_Access_Token
const envAccountId = CTRADER_ACCOUNT_ID || process.env.cTrader_Account_ID
const envRefreshToken = process.env.CTRADER_REFRESH_TOKEN || process.env.cTrader_Refresh_Token
if (envAccessToken && !getState(db, 'ctrader_access_token')) {
  setState(db, 'ctrader_access_token', envAccessToken)
  console.log('[boot] cTrader access token seeded from env')
}
if (envRefreshToken && !getState(db, 'ctrader_refresh_token')) {
  setState(db, 'ctrader_refresh_token', envRefreshToken)
  console.log('[boot] cTrader refresh token seeded from env')
}
if (envAccountId && !getState(db, 'ctrader_account_id')) {
  setState(db, 'ctrader_account_id', String(envAccountId))
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
    console.log(`[agent] ANTHROPIC_MAP_KEY_API: ${ANTHROPIC_MAP_KEY_API ? 'set' : 'MISSING'}`);
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

  // Self-link cTrader when credentials exist (env-seeded or pushed earlier)
  // but the symbol map or balance is missing — so setting
  // CTRADER_ACCESS_TOKEN + CTRADER_ACCOUNT_ID (+ CTRADER_IS_LIVE) in the
  // host's variables is ALL the configuration needed; no UI steps required.
  // Fire-and-forget: a failure here must never block boot.
  ;(async () => {
    try {
      const { getCtraderCreds, getSymbolMap } = await import('./lib/ctrader-creds.js');
      const creds = getCtraderCreds(db);
      if (!creds.ready) return;
      const haveMap = Object.keys(getSymbolMap(db)).length > 0;
      const haveBalance = getState(db, 'account_balance_usd') != null;
      if (haveMap && haveBalance) return;

      const { wsGetSymbolsList, wsGetTrader } = await import('./lib/ctrader-ws.js');
      if (!haveMap) {
        const data = await wsGetSymbolsList(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId);
        const map = {};
        for (const s of (data.symbol || [])) {
          if (s.symbolName && s.symbolId != null) map[String(s.symbolName).toUpperCase()] = s.symbolId;
        }
        if (Object.keys(map).length > 0) {
          setState(db, 'symbol_id_map', JSON.stringify(map));
          console.log(`[boot] cTrader self-link: ${Object.keys(map).length} symbols mapped`);
        }
      }
      if (!haveBalance) {
        const trader = await wsGetTrader(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId);
        if (trader.balance != null) {
          setState(db, 'account_balance_usd', String(trader.balance / 100));
          console.log(`[boot] cTrader self-link: balance ${trader.balance / 100}`);
        }
        if (trader.leverageInCents != null) {
          setState(db, 'account_leverage', String(trader.leverageInCents / 100));
        }
      }
    } catch (err) {
      console.warn('[boot] cTrader self-link failed (will still work via the Connect tab):', err.message);
    }
  })();

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
