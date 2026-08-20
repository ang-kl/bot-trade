import { createServer } from 'node:http';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import express from 'express';
import cors from 'cors';
import { initDB, getState, setState } from './db.js';
import { touchSession } from './services/browser-sessions.js';
import { installProcessDiagnostics, startHeartbeatLog } from './lib/diagnostics.js';
import * as clientPresence from './services/client-presence.js';
import { classifyToken, tierAuthorizes } from './lib/auth-tiers.js';
// randomInt comes from node:crypto, NOT from the global `crypto`. The global is
// WebCrypto, which carries getRandomValues and randomUUID but has no randomInt —
// calling it there is a TypeError, and it would have thrown on the login path.
import { randomInt } from 'node:crypto';
import { llmProviderInfo } from './lib/llm-provider.js';
import { tierTable } from './lib/model-router.js';
import { historicalRateStatus } from './lib/ctrader-ws.js';
import { publicPipelineView } from './services/decision-audit.js';
import { readRecentErrors } from './services/error-log.js';
import ctraderOauthRouter from './routes/ctrader-oauth.js';
import { startLagMonitor } from './services/event-loop-lag.js';
import { recordRequest } from './services/route-timing.js';

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
  // D12 (2026-07-27, owner-approved): optional read-only credential. Unset
  // by default — every route behaves exactly as before until this is set.
  // Authorizes GET routes only; never a route that moves money or changes
  // trading config. See lib/auth-tiers.js.
  AGENT_SECRET_READ,
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

// DB_PATH is TRIMMED before use. Found in production 2026-07-28: /health
// reported dbPath as " /data/agent.db" — a leading space in the Railway
// variable. That single character is enough to lose the database: the value is
// no longer an absolute path, so SQLite resolves it against the process cwd and
// writes to "<cwd>/ /data/agent.db" INSIDE the container instead of the mounted
// volume at /data — and every redeploy then wipes the account link, the logins
// and the trade history. Nothing failed loudly, because opening a wrong path
// still succeeds.
//
// So: trim it, and refuse to report persistence we cannot prove.
const rawDbPath = DB_PATH ?? '';
const trimmedDbPath = rawDbPath.trim();
if (DB_PATH && trimmedDbPath !== rawDbPath) {
  console.warn(`[boot] ⚠ DB_PATH had surrounding whitespace (${JSON.stringify(rawDbPath)}) — trimmed to ${JSON.stringify(trimmedDbPath)}. Fix the variable; an untrimmed value silently writes to the container filesystem instead of the volume.`);
}
const resolvedDbPath = trimmedDbPath || './agent.db';

// A configured-but-relative DB_PATH is the same data-loss trap by another
// route, so it gets the same warning rather than passing silently.
if (trimmedDbPath && !isAbsolute(trimmedDbPath)) {
  console.warn(`[boot] ⚠⚠⚠ DB_PATH is not absolute (${JSON.stringify(trimmedDbPath)}) — it resolves against the working directory (${resolve(trimmedDbPath)}), NOT a mounted volume. Every redeploy will wipe the database.`);
}

try {
  const dir = dirname(resolve(resolvedDbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[boot] Created DB directory: ${dir}`);
  }
} catch (err) {
  console.error(`[boot] Cannot create DB directory for ${resolvedDbPath}:`, err.message);
}

console.log(`[boot] Opening database at: ${resolvedDbPath} (absolute: ${resolve(resolvedDbPath)})`);
if (!DB_PATH) {
  console.warn('[boot] ⚠⚠⚠ DB_PATH is NOT set — the database lives inside the container and EVERY REDEPLOY WIPES IT (account link, logins, trade history). Attach a Railway Volume at /data and set DB_PATH=/data/agent.db.');
}
const db = initDB(resolvedDbPath);

// Quote-currency overrides, BEFORE anything can size a position. A wrong entry
// in contracts.js mis-sizes every trade on that symbol by an FX rate, and
// until now correcting one took a code change and a deploy — which is exactly
// how JPN225 stayed wrong long enough to produce a 9,171.76 loss on a 45,211
// account. `symbol_quote_ccy_json` makes it a config edit instead.
// Loaded loudly: a silent override is a second hidden assumption, and hidden
// assumptions are the whole subject here.
try {
  const { setQuoteCurrencyOverrides } = await import('./lib/contracts.js');
  const raw = JSON.parse(getState(db, 'symbol_quote_ccy_json') || 'null');
  const applied = setQuoteCurrencyOverrides(raw);
  if (applied.length) console.log(`[boot] quote-currency overrides active: ${applied.join(', ')}`);
} catch (e) {
  console.warn('[boot] quote-currency overrides NOT applied:', e.message);
}

// Exhaustive lifecycle/crash diagnostics to stdout (owner reads these from
// Railway to find the ~4-min restarts). Installed as early as possible so a
// boot-time error is still captured; the heartbeat reads live loop stats.
// Start sampling event-loop delay before anything heavy runs, so the first
// cycle's phases already have numbers. Idempotent.
startLagMonitor();

installProcessDiagnostics({
  version: APP_VERSION,
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '?').slice(0, 7),
});
startHeartbeatLog(() => ({
  loopCount: Number(getState(db, 'loop_count') || 0),
  lastLoopMs: Number(getState(db, 'last_loop_ms') || 0),
  lastScanMs: Number(getState(db, 'last_scan_ms') || 0),
  lastScanAt: getState(db, 'last_scan_at'),
  openTrades: (() => { try { return db.prepare("SELECT COUNT(*) c FROM trades WHERE status='open'").get().c } catch { return '?' } })(),
  openPositions: (() => { try { return db.prepare("SELECT COUNT(*) c FROM monitored_positions WHERE status='active'").get().c } catch { return '?' } })(),
}));

// Owner 2026-08-03: per-position loss cap to 1% of balance with a $50 floor.
// One-time and idempotent — see migrateLossCapConfig for why a stored config
// makes a default change insufficient, and why this must not re-apply.
try {
  const { migrateLossCapConfig } = await import('./services/loss-cap.js')
  const r = migrateLossCapConfig(db)
  if (r.applied) console.log('[boot] loss cap migrated to 1% of balance with a $50 floor')
} catch (err) { console.error('[boot] loss-cap migration skipped:', err.message) }

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

// Account Registry bootstrap (multi-account plan, M0 shim): make sure the
// currently-selected account exists in the registry and is the single
// enabled row — behaviour-identical to the pre-registry boot.
try {
  const { ensureAccountRegistry, backfillAccountIds } = await import('./services/account-registry.js')
  const reg = ensureAccountRegistry(db)
  console.log(`[boot] account registry: ${reg.total} account(s), enabled=${reg.enabled ?? 'none'}`)
  const bf = backfillAccountIds(db)
  if (bf.backfilled != null) console.log(`[boot] M1 account_id backfill: ${bf.backfilled} historical row(s) stamped to ${bf.accountId}`)
  // Fold the retired per-account autotrade flags into accounts.mode, so
  // "may this account enter" has exactly one home. Idempotent — after the
  // first boot there is nothing left to fold. See services/account-arming.js.
  const { migrateLegacyArmFlags } = await import('./services/account-arming.js')
  migrateLegacyArmFlags(db)
  // Restore the roster invariant: a non-archived mode promises to keep MANAGING
  // the account's open positions, and only membership of the sidecar roster can
  // keep that promise. Idempotent. See services/account-capabilities.js.
  const { repairRosterMembership } = await import('./services/account-capabilities.js')
  // Invariant 5: this REPORTS, it does not write. A restart may not change an
  // explicit `enabled = 0`. Anything it finds needs a person, so it is said
  // loudly and left standing rather than quietly fixed every boot.
  const repair = repairRosterMembership(db)
  if (repair.flagged.length) {
    const names = repair.flagged.map(p => `${p.isLive ? 'LIVE' : 'demo'} ${p.accountId} (${p.mode})`)
    console.warn(
      `[boot] ROSTER INVARIANT VIOLATED — ${repair.flagged.length} account(s) claim MANAGE while OUT of the sidecar roster, ` +
      `holding open positions or working orders nothing can reach: ${names.join(', ')}. ` +
      'NOT auto-enabled (Invariant 5). Re-enable deliberately, or close the work.',
    )
  }
} catch (e) {
  console.warn('[boot] account registry init failed (non-fatal):', e.message)
}

// Move B — one-time additive seed: arm RSI-2 + its backtested GO combos so
// the proven edge trades out of the box. Idempotent (guarded by a state
// flag); additive and reversible (see rsi2-seed.js).
const { seedRsi2GoCombos } = await import('./services/rsi2-seed.js')
const rsi2Seed = seedRsi2GoCombos(db)
if (rsi2Seed.seeded) {
  console.log(`[boot] RSI-2 GO seed applied — strategy armed: ${rsi2Seed.addedStrategy}, combos: ${rsi2Seed.addedCombos?.length ?? 0}${rsi2Seed.note ? ` (${rsi2Seed.note})` : ''}`)
}

// One-time: execute the owner's 2026-07-30 "autoDisarm - leave it OFF" against
// data that predates it. #509 changed only the DEFAULT, and
// loadPerformanceBreakerConfig honours a PRESENT stored key — so an instance
// that stored `autoDisarm: true` when the owner armed it on 2026-07-20 kept
// auto-disarming, and this breaker writes the MASTER autotrade flag, which is an
// absolute veto over every per-account switch. Strips the stored key so the
// documented default applies; preserves every other stored field; guarded by a
// state flag so a later deliberate `true` is never undone.
try {
  const { migrateAutoDisarmOff } = await import('./services/performance-breaker.js')
  const pbMig = migrateAutoDisarmOff(db)
  if (pbMig.migrated) {
    console.log(`[boot] performance-breaker autoDisarm migration applied — stored ${pbMig.was} removed, default (off) now applies`)
  }
} catch (e) {
  console.warn('[boot] performance-breaker autoDisarm migration failed (non-fatal):', e.message)
}

// One-time: turn ON the Strategy Autopilot in full-auto (owner opted in) so it
// auto-backtests the watchlist on the session-adaptive cadence and arms only
// PF≥1.7/win≥60%/≥25-trade combos, disarming NO-GO ones — including on the live
// account. Reversible in Tune / via /actions/autopilot. Runs once.
if (!getState(db, 'autopilot_boot_v1')) {
  if (!getState(db, 'autopilot_mode')) setState(db, 'autopilot_mode', 'auto')
  setState(db, 'autopilot_allow_live', 'true')
  setState(db, 'autopilot_boot_v1', new Date().toISOString())
  console.log('[boot] Strategy Autopilot enabled — auto mode, live arming allowed, session-adaptive cadence')
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
// NEVER let an edge/CDN cache this API (owner enabled Railway CDN caching,
// 2026-07-28). Every response here is live trading state — positions, P&L,
// balances, config — or a money-moving action. A cached copy is a WRONG
// copy, and an edge that caches a response fetched WITH an Authorization
// header could serve it to a request without one (we send only
// `vary: accept-encoding`, not `vary: authorization`).
//
// This app previously sent NO Cache-Control at all, which is precisely the
// condition Railway's "Default TTL" fallback is documented to act on. An
// explicit no-store removes the guesswork: the setting can stay on for
// whatever static assets the platform serves, and the API is exempt by its
// own instruction rather than by a heuristic we do not control.
//
// The in-process response cache in routes/state.js is unaffected — that one
// is ours, lives inside the agent, is bounded to STATE_CACHE_MS, and is what
// actually stops duplicate recomputation.
//
// Cost, stated plainly: `no-store` also stops the BROWSER storing responses,
// so it will no longer send If-None-Match and our 304s go unused. That is a
// bandwidth saving, not a speed one — instant paint comes from the
// sessionStorage SWR layer in src/lib/agent-api.js, which is untouched. A
// weaker `private, no-cache` would keep the 304s, but it relies on every
// intermediary honouring `private` correctly. Trading data is not where we
// spend a correctness budget to save a few kilobytes.
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Vary', 'Authorization, Accept-Encoding')
  next()
});

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

  const tier = classifyToken(token, { agentSecret: AGENT_SECRET, agentSecretRead: AGENT_SECRET_READ, isValidSession });
  if (!tierAuthorizes(tier, req.method)) {
    const why = !token ? 'no token' : tier === 'read' ? `read-tier token on a write route ${token.slice(0, 10)}…` : `stale/unknown token ${token.slice(0, 10)}…`;
    console.warn(`[auth] 401 ${req.method} ${req.path} — ${why}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // THIS is where a revoked session stops. `isValidSession` reads
  // `device_sessions`, and revocation deletes the raw token from it, so the
  // very next request from a revoked browser 401s above — before any route,
  // cache or queue runs. No client-side "disconnected" flag is trusted, and
  // the block survives a restart because the deletion is a durable write.
  //
  // Everything past this point is authenticated, so it is the honest place to
  // stamp server-authoritative last-activity for the session list. Throttled
  // inside touchSession (5s) so the hot path stays a Map lookup.
  // A device session is a 'full'-tier token that is NOT one of the env
  // secrets — classifyToken deliberately collapses both into 'full', so the
  // distinction has to be made here rather than read off the tier.
  const isDeviceSession = tier === 'full' && token !== AGENT_SECRET;
  if (isDeviceSession) {
    try {
      touchSession(db, token, {
        ua: req.headers['user-agent'],
        ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      })
    } catch { /* session bookkeeping must never reject an authorized request */ }
  }

  next();
}

// Request footprints — every non-health call logged with outcome + timing,
// so Railway logs read as an activity journal, not just boot lines.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    console.log(`[http] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    // #125: the log line above is a STREAM — reading it means having the
    // Railway window open at the moment. This keeps the shape in memory so an
    // episode noticed a day later still has numbers. See route-timing.js.
    recordRequest(req.path, ms, Number(res.getHeader('content-length')) || 0);
  });
  next();
});

// ---------------------------------------------------------------------------
// THE FRONTEND AND THE OAUTH EXCHANGE — both moved off Vercel.
//
// Owner, 17-08-2026: "I am paying a lot at vercel. I want to decomm. the
// bot-trade at Vercel." Vercel served the ONLY browser UI (GET / here returned
// 502 — nothing was mounted) plus /api/ctrader, so deleting the project without
// this leaves Telegram as the sole interface.
//
// The trading loop, every controller, and — checked first, because it is the
// one that would have mattered — the cTrader TOKEN REFRESH all run here
// already, straight against Spotware in lib/ctrader-auth.js. Nothing about the
// broker connection depended on Vercel.
//
// BOTH MOUNT BEFORE authMiddleware, matching what Vercel did. The bundle is a
// public static asset (it holds no secret; the browser authenticates afterwards
// with a device session or the secret), and the OAuth endpoints are called
// precisely because the browser has no credential yet.
// ---------------------------------------------------------------------------
app.use('/api/ctrader', ctraderOauthRouter());

// dist/ is built by `npm run build` at the repo root. When it is absent — a
// dev container that never built, or a deploy that skipped it — serve nothing
// rather than 404-ing every API path through a broken fallback: the agent's
// job is trading, and it must boot without a frontend.
const DIST_DIR = resolve(dirname(new URL(import.meta.url).pathname), '../dist');
const HAS_DIST = (() => { try { return fs.existsSync(resolve(DIST_DIR, 'index.html')); } catch { return false; } })();
if (HAS_DIST) {
  app.use(express.static(DIST_DIR, { index: 'index.html', maxAge: '1h' }));
  console.log(`[http] serving frontend from ${DIST_DIR}`);
} else {
  console.warn('[http] no dist/index.html — frontend not served (API unaffected)');
}

// The SPA fallback goes here — BEFORE authMiddleware — and the reason is
// worth stating because I got it backwards first.
//
// I originally mounted it last, after the API routers, on the argument that
// ordering was what stopped it swallowing /state. Every unit test passed and
// the UI returned 401 on every path: authMiddleware sits between, so a request
// for /connect was rejected before the fallback ever saw it. The page was
// unreachable while the tests were green.
//
// What actually makes this safe is `isSpaPath`, an EXPLICIT exclusion list —
// not position. With that, running early is both safe and necessary: the HTML
// shell is a public asset and must be served without a credential, exactly as
// Vercel served it.
mountSpaFallback();

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
    // NOT Math.random(). It is not a CSPRNG — V8 seeds it from a source an
    // attacker can influence and its output is predictable from observed values,
    // so a login code built from it is guessable in a way a 6-digit space
    // already makes tight. Finding P1-5, validated 2026-07-30. randomInt is
    // rejection-sampled over the crypto pool, so the distribution stays uniform
    // across the full 100000-999999 range (a plain `% 900000` would not).
    //
    // The session token minted on success already used getRandomValues; this was
    // the one weak link, and it was the link an attacker would actually attack.
    const code = String(randomInt(100000, 1000000))
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
// Health endpoint — PUBLIC LIVENESS, AUTHENTICATED DETAIL
//
// S-0, owner-approved 2026-07-30 ("put clients / dbPathAbsolute / recentErrors
// behind auth on /health"), pulled ahead of the Safe Implementation Prompt's
// PHASE-8 because it was exposed on a public URL and touches nothing in the
// trading path. Finding P1-6, validated in
// docs/safe-implementation-first-response-2026-07-30.md.
//
// WHAT WAS LEAKING. This handler skips auth (see authMiddleware) and returned
// the whole payload to anyone. That included:
//   * `clients` — the browser-presence roster, whose rows carry `ip` per tab
//     (services/client-presence.js). An anonymous GET returned the OWNER'S
//     BROWSER IP ADDRESSES. That is the severe one.
//   * `dbPath` / `dbPathAbsolute` — the container filesystem layout.
//   * `recentErrors` / `lastError` — internal error strings.
//   * `memoryMB`, `loopPhaseMs`, `loopPhaseLag`, `loopCpuProfile`,
//     `historicalRate`, `llmTiers` — internal timing and provider detail.
//
// WHAT STAYS PUBLIC, and why exactly this much. Two consumers need an
// unauthenticated 200:
//   * Railway's healthcheck, which only reads the status code.
//   * src/App.jsx's AgentDownBanner, which fetches /health with NO bearer and
//     only tests `res.ok` — it must keep working, because it is the owner's
//     "the agent is unreachable" alarm and breaking it would trade a small
//     information leak for a blind spot on the whole agent being down.
// So the public shape is liveness only: status, version, commit, uptime. The
// commit is already printed in the web app's own build stamp, so withholding it
// here would protect nothing.
//
// Everything else requires the bearer. `authenticated: false` is included in the
// public body on purpose — a caller that expected the full payload gets a
// positive signal that it needs a token, rather than silently reading a dozen
// missing fields as nulls.
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  // Same classification the middleware uses. Any recognised tier — including
  // the read-only one — may see the detail; none of it moves money.
  const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
    ? String(req.headers.authorization).slice(7)
    : ''
  const authed = classifyToken(bearer, {
    agentSecret: AGENT_SECRET,
    agentSecretRead: AGENT_SECRET_READ,
    isValidSession,
  }) != null
  // dbSize used to default to 0 when statSync threw — which is how a soak
  // digest came to report "dbSize 0" and conclude the database was being wiped
  // on every redeploy, when in fact the file simply was not at the path this
  // handler resolved (relative './agent.db' against the process cwd). An
  // unknown size now reports null, and the resolved path plus whether it is on
  // a configured volume are reported alongside, so persistence is a fact you
  // can read rather than something to infer from a zero.
  //
  // 2026-07-28: this handler re-derived the path from the raw env var, so an
  // untrimmed DB_PATH made it stat a path nothing was ever written to — dbSize
  // came back null while the DB itself was fine. It now reports the path SQLite
  // ACTUALLY opened (db.name), which is the only authoritative answer, and
  // dbPersistent means "that file is where we can prove it is" rather than
  // merely "the variable was set".
  const openedPath = db.name || resolvedDbPath;
  let dbSize = null;
  try {
    dbSize = fs.statSync(openedPath).size;
  } catch { /* leave null — unknown, not empty */ }

  const circuitBreaker = getState(db, 'circuit_breaker_tripped_at')
  const lastError = getState(db, 'last_error')
  const errorsToday = Number(getState(db, 'errors_today') || 0)
  const recentErrors = readRecentErrors(db)

  let openPositions = 0
  let openTrades = 0
  try {
    openPositions = db.prepare("SELECT COUNT(*) as c FROM monitored_positions WHERE status = 'active'").get().c
    openTrades = db.prepare("SELECT COUNT(*) as c FROM trades WHERE status = 'open'").get().c
  } catch { /* non-fatal */ }

  const status = circuitBreaker ? 'circuit_breaker_tripped' : 'ok'

  // Deploy indicator. This used to read "the Docker build context is agent/, so
  // APP_VERSION can't read the repo-root package.json (always 0.0.000)" — true
  // until the Dockerfile moved to the repo root, which is why it is corrected
  // here rather than left as a stale explanation of a number that changed. The
  // image now writes /app/package.json carrying the real version, so
  // APP_VERSION reports it. Railway still injects the commit as
  // RAILWAY_GIT_COMMIT_SHA — compare it to `main`'s HEAD to confirm the deploy
  // is current, since a version alone cannot distinguish two builds of it. `llmProvider` reveals whether OPENAI_API_KEY is
  // actually live on this service (else the LLM monitor falls back to Anthropic
  // and errors on a dry credit balance).
  const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 7) || null
  // Reported through the SAME router the calls use, so /health can never claim
  // a model the agent is not actually calling. llmTiers lists all three so the
  // rename (OPENAI_DEFAULT_MODEL → OPENAI_MODEL_DEFAULT) and the two new tiers
  // are verifiable from outside without shell access to the box.
  const llmInfo = llmProviderInfo(process.env)
  const llmProvider = `${llmInfo.provider}:${llmInfo.model}`
  const llmTiers = process.env.OPENAI_API_KEY ? tierTable(process.env) : null

  // The public liveness subset. Deliberately built FIRST and returned early, so
  // there is no path where a new field is added below and silently becomes
  // public by omission — the default for anything new is authenticated.
  // THE ONE DELIBERATE ADDITION to the public liveness subset (owner
  // 2026-08-03: "no, I cannot help you" — the diagnosis has to be readable
  // without a human relaying an authenticated payload by hand).
  //
  // `publicPipelineView` is a counts-and-stage-names projection: the verdict,
  // how many decisions were made, how many reached the risk gate, and which
  // stage blocked. It carries NO symbol, side, price, volume, P&L, balance or
  // account id — services/decision-audit.test.js asserts that by scanning the
  // serialised output for each of them.
  //
  // The justification for widening the allowlist at all: this is the same
  // CLASS of operational fact as `status` and `uptime`, which are already
  // public. It says the machine is stuck and where. It says nothing about
  // what is being traded, in which direction, or with how much. Everything
  // else in this handler stays authenticated by default, and the guard below
  // still precedes the full payload so that remains true for new fields.
  let pipeline = null
  try {
    const raw = getState(db, 'decision_audit_last_json')
    if (raw) pipeline = publicPipelineView(JSON.parse(raw))
  } catch { pipeline = null }

  if (!authed) {
    return res.json({
      status,
      version: APP_VERSION,
      commit,
      uptime: process.uptime(),
      authenticated: false,
      pipeline,
    })
  }

  res.json({
    status,
    version: APP_VERSION,
    commit,
    authenticated: true,
    llmTiers,
    llmProvider,
    uptime: process.uptime(),
    loopCount: Number(getState(db, 'loop_count') || 0),
    lastScanAt: getState(db, 'last_scan_at'),
    lastLoopMs: Number(getState(db, 'last_loop_ms') || 0),
    lastScanMs: Number(getState(db, 'last_scan_ms') || 0),
    // Hang forensics (owner-approved watchdog, 2026-07-27): the phase the
    // loop is in RIGHT NOW and when the cycle started — a frozen loop names
    // its stuck phase here instead of needing Railway log archaeology.
    loopPhase: getState(db, 'loop_phase') || 'idle',
    loopStartedAt: getState(db, 'loop_started_at') || null,
    // Per-sub-phase ms from the last completed cycle, slowest first. Until
    // 2026-07-28 loop_phase read 'monitoring N positions' for everything from
    // the breakers through the retention DELETEs, so read-stall reports blamed
    // the monitor phase for a window it barely occupies. This names the real
    // owner of the time.
    loopPhaseMs: (() => {
      try { return JSON.parse(getState(db, 'loop_phase_ms_json') || 'null') } catch { return null }
    })(),
    // Event-loop delay per phase from the last completed cycle, worst first.
    // maxMs is how long a ready-to-run callback actually waited — i.e. the
    // worst extra latency an HTTP request could have taken purely from being
    // queued behind the loop during that phase. Low maxMs beside high
    // loopPhaseMs means the phase was WAITING, not blocking, and a read stall
    // in that window has a cause outside this process.
    loopPhaseLag: (() => {
      try { return JSON.parse(getState(db, 'loop_phase_lag_json') || 'null') } catch { return null }
    })(),
    // V8 CPU profile of the armed phase(s), from the last cycle that ran one.
    // Null unless CPU_PROFILE_PHASES is set — see services/cpu-profile.js.
    // loopPhaseLag settles WHETHER a phase burns CPU; this settles WHICH
    // function does, by self time, including native frames (sync SQLite, TLS,
    // GC) that no hand-placed timer can see.
    loopCpuProfile: (() => {
      try { return JSON.parse(getState(db, 'loop_cpu_profile_json') || 'null') } catch { return null }
    })(),
    watchdogMinutes: Number(process.env.LOOP_WATCHDOG_MINUTES ?? 12),
    // Broker pacing (incident 2026-07-28): historical requests (trendbars,
    // deals) are capped at 5/s by cTrader and we were sending 20-40/s. A
    // non-zero `queued` here means work is waiting on the limiter — the
    // honest reading of "the broker is the bottleneck right now".
    historicalRate: historicalRateStatus(),
    dbSize,
    dbSizeMB: dbSize == null ? null : Math.round((dbSize / 1048576) * 100) / 100,
    dbPath: openedPath,
    dbPathAbsolute: resolve(openedPath),
    // false = the DB lives in the container filesystem; a rebuild loses it.
    // Requires an absolute configured path AND a file we can actually stat —
    // a set-but-malformed DB_PATH (leading space, relative value) used to
    // report true while writing inside the container.
    dbPersistent: Boolean(trimmedDbPath) && isAbsolute(trimmedDbPath) && dbSize != null,
    errorsToday,
    lastError: lastError || null,
    // A count with no causes is unactionable — production once showed
    // errorsToday: 21 next to an April lastError. Every increment now goes
    // through recordError(), and this is the bounded ring it maintains:
    // newest first, repeats collapsed into `n`.
    recentErrors: recentErrors.slice(0, 5),
    circuitBreaker: circuitBreaker || null,
    openPositions,
    openTrades,
    scanEnabled: getState(db, 'scan_enabled') !== 'false',
    analyzeEnabled: getState(db, 'analyze_enabled') !== 'false',
    autotradeEnabled: getState(db, 'autotrade_enabled') === 'true',
    memoryMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
    // Dashboard-tab presence (owner 2026-07-28): how many browser tabs have
    // the app open right now, and from which timezones — each visible tab
    // polls the agent every 5-20s, so this is the query-load multiplier.
    clients: clientSummaryOrNull(),
  });
});

function clientSummaryOrNull() {
  try {
    // Sync require-shape: presence is a plain in-memory module, no I/O.
    return clientPresence.clientSummary()
  } catch { return null }
}

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
          // A5: stamp the account this action was taken under. The TRADING
          // account, not a viewed one — an action changes the world, and the
          // world it changed is the one the agent is trading. A body that
          // names its own accountId wins, because per-account routes act on
          // the account they were given rather than the selected one.
          let acct = null
          try { acct = req.body?.accountId != null ? String(req.body.accountId) : (getState(db, 'ctrader_account_id') || null) } catch { acct = null }
          db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
            .run(req.method, req.path, redacted.slice(0, 2000), acct)
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
// SPA FALLBACK — mirrors vercel.json's rewrite: /((?!api/).*) → /index.html
//
// Registered HERE, after every API router, and that ordering is the whole
// correctness argument. Mounted earlier it would answer /state and /actions
// with the HTML shell before their routers ever ran — the API would "work"
// while returning a web page, which is the kind of green-looking failure this
// codebase has been bitten by repeatedly.
//
// GET only, and the API prefixes are excluded EXPLICITLY as well as by
// ordering. Belt and braces: a genuine 404 inside /state must stay a JSON 404
// for the client to handle, not become an index.html the fetch then fails to
// parse with a message that points nowhere near the real problem.
// ---------------------------------------------------------------------------
export function isSpaPath(path) {
  return !/^\/(api|state|actions|auth|health|icon\.png)(\/|$)/.test(path)
}

function mountSpaFallback() {
  if (!HAS_DIST) return
  app.get(/.*/, (req, res, next) => {
    if (!isSpaPath(req.path)) return next()
    res.sendFile(resolve(DIST_DIR, 'index.html'))
  })
  console.log('[http] SPA fallback mounted for non-API GETs')
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  await mountRoutes();

  const server = createServer(app);
  const port = Number(PORT);

  server.listen(port, '0.0.0.0', async () => {
    console.log(`[agent] listening on 0.0.0.0:${port}`);
    console.log(`[agent] CORS origin: ${FRONTEND_URL || '*'}`);
    console.log(`[agent] DB path: ${DB_PATH || './agent.db'}`);
    // LLM provider (position-monitor fallback only): OpenAI is primary when
    // OPENAI_API_KEY is set, else Anthropic via CLAUDE_API_KEY.
    const { llmProviderInfo } = await import('./lib/llm-provider.js');
    const llm = llmProviderInfo();
    const llmKeyOk = llm.provider === 'openai' ? !!process.env.OPENAI_API_KEY : !!CLAUDE_API_KEY;
    const { llmPaused } = await import('./lib/llm-provider.js');
    if (llmPaused()) {
      // Said plainly at boot, because a paused subsystem that says nothing is
      // indistinguishable from a broken one — and this file has paid for that
      // distinction more than once today.
      console.log('[agent] LLM: PAUSED by LLM_PAUSED — no LLM calls will be made. Deterministic trading is unaffected. Unset LLM_PAUSED to resume; API keys are untouched.');
    } else {
      console.log(`[agent] LLM provider: ${llm.provider} (${llm.model}) — key ${llmKeyOk ? 'set' : 'MISSING (monitor LLM fallback disabled; deterministic trading still runs)'}`);
    }
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
        const { setAccountState } = await import('./services/account-registry.js');
        if (bal != null) {
          setState(db, 'account_balance_usd', String(bal));
          setAccountState(db, creds.accountId, 'account_balance_usd', String(bal));
          console.log(`[boot] cTrader self-link: balance ${bal}`);
        }
        if (trader.leverageInCents != null) {
          setState(db, 'account_leverage', String(trader.leverageInCents / 100));
          setAccountState(db, creds.accountId, 'account_leverage', String(trader.leverageInCents / 100));
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
    // Drop keep-alive sockets (the monitor UI polls every 30s and holds
    // them open) so server.close() can actually complete.
    try { server.closeAllConnections?.(); } catch { /* Node < 18.2 */ }

    // If something still lingers, force-quit — but with exit code 0: a
    // SIGTERM-initiated shutdown is intentional, and a non-zero code here
    // made Railway flag EVERY deploy handover as "Deploy Crashed!".
    setTimeout(() => {
      try { db.close(); } catch { /* already closed */ }
      console.log('[agent] forced exit after drain timeout');
      process.exit(0);
    }, 10_000).unref();
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
