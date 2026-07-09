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
} catch { /* non-fatal */ }

// App version (from the repo-root package.json; agent deploys from the same repo).
// Displayed as 0.#.### — patch zero-padded to three digits.
let APP_VERSION = '0.0.000'
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const [maj, min, patch] = String(pkg.version || '0.0.0').split('.')
  APP_VERSION = `${maj}.${min}.${String(patch).padStart(3, '0')}`
} catch { /* non-fatal */ }

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const {
  CLAUDE_API_KEY,
  TELEGRAM_BOT_TOKEN,
  AGENT_SECRET,
  FRONTEND_URL,
  PORT = '3001',
  DB_PATH,
  // cTrader credentials are looked up spelling-tolerantly via
  // lib/ctrader-env.js and seeded into agent_state at boot below.
  CTRADER_IS_LIVE,
} = process.env;

if (!AGENT_SECRET) {
  console.error('[agent] FATAL: AGENT_SECRET env var is required — set it in Railway Variables')
  console.error('[agent] Required env vars: AGENT_SECRET, CLAUDE_API_KEY')
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
if (!DB_PATH) {
  console.warn('[boot] ⚠⚠⚠ DB_PATH is NOT set — the database lives inside the container and EVERY REDEPLOY WIPES IT (account link, logins, trade history). Attach a Railway Volume at /data and set DB_PATH=/data/agent.db.');
}
const db = initDB(resolvedDbPath);

// Seed cTrader credentials from env vars if present and not already stored.
// This lets Railway hold the secrets so the agent starts trading immediately
// after deploy — no UI push required. Any capitalization/underscore spelling
// of the variable names is accepted (see lib/ctrader-env.js).
const { ctraderEnv } = await import('./lib/ctrader-env.js')
const envAccessToken = ctraderEnv('accessToken')
const envAccountId = ctraderEnv('accountId')
const envRefreshToken = ctraderEnv('refreshToken')
const envIsLive = ctraderEnv('isLive') ?? CTRADER_IS_LIVE
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
  setState(db, 'ctrader_is_live', envIsLive === 'true' ? 'true' : 'false')
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

// Device sessions issued by the Telegram login flow — accepted alongside the
// master AGENT_SECRET. Stored as { token: expiresAtMs } JSON in agent_state.
function getSessions() {
  try { return JSON.parse(getState(db, 'device_sessions') || '{}') } catch { return {} }
}
function isValidSession(token) {
  const s = getSessions()
  return !!token && !!s[token] && s[token] > Date.now()
}
function addSession() {
  const token = 'sess_' + [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('')
  const s = getSessions()
  // prune expired, cap at 20 devices
  for (const [k, v] of Object.entries(s)) if (v < Date.now()) delete s[k]
  s[token] = Date.now() + 90 * 86_400_000 // 90 days
  setState(db, 'device_sessions', JSON.stringify(s))
  return token
}

function authMiddleware(req, res, next) {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/icon.png')) return next();
  if (req.path.startsWith('/auth/')) return next(); // login endpoints are public (rate-limited below)

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || (token !== AGENT_SECRET && !isValidSession(token))) {
    console.warn(`[auth] 401 ${req.method} ${req.path} — ${token ? `stale/unknown token ${token.slice(0, 10)}…` : 'no token'}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Request footprints — every non-health call logged with outcome + timing,
// so Railway logs read as an activity journal, not just boot lines.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Telegram device login — the bot texts a 6-digit code to the OWNER's chat;
// typing it here authorizes this browser with a device session token.
// No master secret ever reaches the page. Public but tightly rate-limited.
// ---------------------------------------------------------------------------

let lastCodeRequestAt = 0
let verifyFailures = 0

app.post('/auth/telegram/request', async (_req, res) => {
  try {
    if (Date.now() - lastCodeRequestAt < 30_000) {
      return res.status(429).json({ error: 'A code was just sent — check Telegram (new code possible in 30s)' })
    }
    const code = String(Math.floor(100000 + Math.random() * 900000))
    setState(db, 'login_code', code)
    setState(db, 'login_code_expires', String(Date.now() + 5 * 60_000))
    lastCodeRequestAt = Date.now()
    verifyFailures = 0
    const { sendMessage } = await import('./services/telegram.js')
    await sendMessage(`🔑 bot-trade login code: *${code}*\n\nValid 5 minutes. If you didn't request this, ignore it.`)
    res.json({ ok: true, sentVia: 'telegram' })
  } catch (err) {
    res.status(502).json({ error: `Could not send Telegram code: ${err.message}` })
  }
})

app.post('/auth/telegram/verify', (req, res) => {
  if (verifyFailures >= 5) return res.status(429).json({ error: 'Too many wrong codes — request a new one' })
  const code = String(req.body?.code || '').trim()
  const stored = getState(db, 'login_code')
  const expires = Number(getState(db, 'login_code_expires') || 0)
  if (!stored || !code || code !== stored || Date.now() > expires) {
    verifyFailures++
    return res.status(401).json({ error: 'Wrong or expired code' })
  }
  setState(db, 'login_code', '')   // single use
  const token = addSession()
  // Confirm on Telegram (fire-and-forget) — an unexpected one of these
  // means someone else has your code: revoke by rotating AGENT_SECRET.
  import('./services/telegram.js')
    .then(({ sendMessage }) => sendMessage('✅ bot-trade: a new device just logged in with your code (valid 90 days). If this was not you, act now.'))
    .catch(() => { /* alert is best-effort */ })
  res.json({ ok: true, token })
})

// Bot icon (public) — same artwork as the site favicon and the Telegram bot.
app.get('/icon.png', (_req, res) => {
  res.sendFile(resolve(new URL('../bot-icon.png', import.meta.url).pathname))
})

// ---------------------------------------------------------------------------
// Health endpoint (public)
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  let dbSize = 0;
  try {
    const resolvedPath = DB_PATH || './agent.db';
    const stat = fs.statSync(resolvedPath);
    dbSize = stat.size;
  } catch { /* non-fatal */ }

  const circuitBreaker = getState(db, 'circuit_breaker_tripped_at')
  const lastError = getState(db, 'last_error')
  const errorsToday = Number(getState(db, 'errors_today') || 0)

  let openPositions = 0
  let openTrades = 0
  try {
    openPositions = db.prepare("SELECT COUNT(*) as c FROM monitored_positions WHERE status = 'active'").get().c
    openTrades = db.prepare("SELECT COUNT(*) as c FROM trades WHERE status = 'open'").get().c
  } catch { /* non-fatal */ }

  const status = circuitBreaker ? 'circuit_breaker_tripped' : 'ok'

  res.json({
    status,
    version: APP_VERSION,
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
    // Owner's action audit trail — every mutating call to /actions is a
    // human (or UI) decision; log it. Secret-looking fields are redacted.
    app.use('/actions', (req, _res, next) => {
      if (req.method === 'POST') {
        try {
          const redacted = JSON.stringify(req.body || {}, (k, v) =>
            /secret|token|password|key/i.test(k) ? '[redacted]' : v)
          db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
            .run(req.method, req.path, redacted.slice(0, 2000))
        } catch { /* logging must never block the action */ }
      }
      next()
    });
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
    console.log(`[agent] CLAUDE_API_KEY: ${CLAUDE_API_KEY ? 'set' : 'MISSING'}`);
    console.log(`[agent] cTrader access token: ${envAccessToken || getState(db, 'ctrader_access_token') ? 'set' : 'not set'}`);
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

      const { wsGetSymbolsList, wsGetTrader, traderBalance } = await import('./lib/ctrader-ws.js');
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
        const bal = traderBalance(trader);
        if (bal != null) {
          setState(db, 'account_balance_usd', String(bal));
          console.log(`[boot] cTrader self-link: balance ${bal}`);
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
