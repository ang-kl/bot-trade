import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const TABLES = `
  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    bias        TEXT,
    confidence  REAL,
    thesis      TEXT,
    timeframe   TEXT,
    session_fit TEXT,
    trade_at    TEXT,
    price       REAL,
    trade_grade TEXT,
    desk_note   TEXT,
    strategy    TEXT,
    scanned_at  TEXT NOT NULL DEFAULT (datetime('now')),
    loop_id     INTEGER
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol              TEXT NOT NULL,
    consensus_bias      TEXT,
    overall_conviction  REAL,
    consensus_summary   TEXT,
    synthesis           TEXT,
    entry_price         REAL,
    sl_price            REAL,
    tp1_price           REAL,
    tp2_price           REAL,
    auto_trade          INTEGER DEFAULT 0,
    strategy            TEXT,
    risk_note           TEXT,
    minion_reports      TEXT,          -- JSON blob
    analyzed_at         TEXT NOT NULL DEFAULT (datetime('now')),
    scan_id             INTEGER REFERENCES scans(id)
  );

  CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    bias        TEXT,
    confidence  REAL,
    prev_bias   TEXT,
    flipped     INTEGER DEFAULT 0,    -- boolean 0/1
    flip_from   TEXT,
    source      TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS regimes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT NOT NULL,
    atr_14          REAL,
    atr_pct         REAL,
    adx_14          REAL,
    regime          TEXT CHECK(regime IN ('trending','ranging','volatile','quiet')),
    trend_direction TEXT,
    computed_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Broker-truth market hours per symbol: the trading schedule pulled from
  -- cTrader (SYMBOL_BY_ID) so the open/closed gate scales to 1,900+ symbols
  -- without hardcoded category heuristics. schedule_json = array of
  -- {start,end} SECONDS from the week's start in tz_seconds offset; refreshed
  -- periodically by the loop. The heuristic (sessions.js) remains the
  -- fallback for symbols not yet cached.
  CREATE TABLE IF NOT EXISTS symbol_hours (
    symbol        TEXT PRIMARY KEY,
    symbol_id     INTEGER,
    schedule_json TEXT,
    tz            TEXT DEFAULT 'UTC',
    source        TEXT DEFAULT 'ctrader',
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS controller_heartbeats (
    name                 TEXT PRIMARY KEY,
    last_run_at          TEXT,
    last_ok_at           TEXT,
    last_error           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    runs                 INTEGER NOT NULL DEFAULT 0,
    stalled              INTEGER NOT NULL DEFAULT 0,
    fail_alerted         INTEGER NOT NULL DEFAULT 0,
    updated_at           TEXT
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    day                TEXT NOT NULL,
    purpose            TEXT NOT NULL,
    model              TEXT NOT NULL,
    calls              INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, purpose, model)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol                TEXT NOT NULL,
    side                  TEXT,
    entry_price           REAL,
    exit_price            REAL,
    sl_price              REAL,
    tp_price              REAL,
    volume                REAL,
    opened_at             TEXT,
    closed_at             TEXT,
    hold_duration_ms      INTEGER,
    gross_pnl             REAL,
    net_pnl               REAL,
    status                TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
    close_reason          TEXT,
    thesis                TEXT,
    strategy              TEXT,
    conviction            REAL,
    ctrader_position_id   TEXT,
    analysis_id           INTEGER REFERENCES analyses(id),
    -- Trade provenance — parsed from the cTrader label so attribution
    -- queries can GROUP BY without re-parsing on every read.
    label_raw             TEXT,
    source                TEXT,          -- 'autopilot' | 'copilot' | 'manual'
    label_version         TEXT,
    label_strategy        TEXT,
    label_conviction      TEXT,          -- 'high' | 'medium' | 'low'
    label_session         TEXT,
    label_timeframe       TEXT,
    label_regime          TEXT
  );

  CREATE TABLE IF NOT EXISTS monitored_positions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol                TEXT NOT NULL,
    trade_id              INTEGER REFERENCES trades(id),
    side                  TEXT,
    entry_price           REAL,
    current_sl            REAL,
    current_tp            REAL,
    thesis                TEXT,
    invalidation_trigger  TEXT,
    time_cap_at           TEXT,
    initial_risk          REAL,
    mfe_r                 REAL DEFAULT 0,
    mae_r                 REAL DEFAULT 0,
    be_moved              INTEGER DEFAULT 0,
    scaled_out            INTEGER DEFAULT 0,
    strategy              TEXT,
    last_check_action     TEXT,
    last_check_reasoning  TEXT,
    last_check_at         TEXT,
    thesis_status         TEXT,
    paused                INTEGER DEFAULT 0,
    status                TEXT DEFAULT 'active' CHECK(status IN ('active','closed')),
    -- Provenance — mirrors the cTrader label so monitor can scope itself
    -- strictly to autopilot-placed positions.
    source                TEXT,
    label_raw             TEXT,
    -- Broker account the position belongs to (ctrader_account_id at insert
    -- time). Rows from another account are swept to 'closed' on account
    -- switch so they never gate risk checks for the new account.
    account_id            TEXT,
    -- Per-position trade-management rules (break-even / trailing / partial
    -- TPs) enforced by services/trade-guard.js each loop cycle.
    guard_json            TEXT,
    -- Peak floating profit (USD) seen by the Profit Keeper — drives the
    -- ratchet/giveback policy on manual/external positions.
    peak_profit_usd       REAL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS performance_snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    total_trades      INTEGER,
    winning_trades    INTEGER,
    losing_trades     INTEGER,
    win_rate          REAL,
    profit_factor     REAL,
    sharpe_ratio      REAL,
    max_drawdown_pct  REAL,
    total_pnl         REAL,
    avg_win           REAL,
    avg_loss          REAL,
    avg_rr            REAL,
    computed_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    method TEXT,
    path TEXT NOT NULL,
    body TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timeframe TEXT,
    order_id TEXT,
    dir INTEGER,
    level REAL,
    sl REAL,
    tp REAL,
    volume REAL,
    placed_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    status TEXT DEFAULT 'working',
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS risk_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol         TEXT,
    side           TEXT,
    approved       INTEGER,
    veto_reason    TEXT,
    checks_json    TEXT,
    proposal_json  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A hot signal whose own market was closed (stock/index/soft/grain outside
  -- exchange hours) is queued here instead of just being dropped — owner:
  -- "do you separate which one you would trade based on market open?".
  -- resolved once, the first cycle after the market reopens, against a FRESH
  -- re-scan (never against the stale queued price) — see runPendingSignals()
  -- in services/pending-signals.js.
  CREATE TABLE IF NOT EXISTS pending_signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT NOT NULL,
    bias            TEXT,
    conviction      REAL,
    strategy        TEXT,
    timeframe       TEXT,
    market_reason   TEXT,
    status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','fired','expired')),
    queued_at       TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT,
    resolved_at     TEXT,
    resolution_note TEXT
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_scans_symbol_at        ON scans   (symbol, scanned_at);
  CREATE INDEX IF NOT EXISTS idx_analyses_symbol_at     ON analyses(symbol, analyzed_at);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol_at      ON signals (symbol, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_regimes_symbol_at      ON regimes (symbol, computed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_opened    ON trades  (symbol, opened_at);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_closed    ON trades  (symbol, closed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_source_strategy   ON trades  (source, label_strategy, closed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_label_regime      ON trades  (label_regime, closed_at);
  CREATE INDEX IF NOT EXISTS idx_monitored_symbol_at    ON monitored_positions(symbol, last_check_at);
  CREATE INDEX IF NOT EXISTS idx_monitored_source       ON monitored_positions(source, status);
  CREATE INDEX IF NOT EXISTS idx_perf_computed          ON performance_snapshots(computed_at);
  CREATE INDEX IF NOT EXISTS idx_risk_events_at         ON risk_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_risk_events_symbol     ON risk_events(symbol, created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_signals_status ON pending_signals(status, symbol);
`;

// ---------------------------------------------------------------------------
// Seed sensible defaults into agent_state
// ---------------------------------------------------------------------------

const SEED_STATE = {
  last_scan_at: null,
  loop_count: '0',
  armed: 'false',
  scan_enabled: 'true',
  analyze_enabled: 'true',
  autotrade_enabled: 'false',
  watchlist_json: '["BTCUSD","EURUSD","GBPUSD","USDJPY","XAUUSD","USTEC","US30"]',
  errors_today: '0',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite database, enable WAL mode, create tables &
 * indexes, and seed default agent_state rows.
 *
 * @param {string} [dbPath] — file path; falls back to DB_PATH env or ./agent.db
 * @returns {import('better-sqlite3').Database}
 */
export function initDB(dbPath) {
  const resolvedPath = dbPath || process.env.DB_PATH || './agent.db';
  const db = new Database(resolvedPath);

  // Performance / concurrency pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Create schema (indexes created after migrations to avoid referencing
  // columns that don't exist yet on pre-existing DBs)
  db.exec(TABLES);

  // In-place migrations for pre-existing DBs
  const mpCols = db.prepare("PRAGMA table_info(monitored_positions)").all();
  const mpColNames = new Set(mpCols.map(c => c.name));
  const mpMigrations = [
    ['paused',               'INTEGER DEFAULT 0'],
    ['invalidation_trigger', 'TEXT'],
    ['time_cap_at',          'TEXT'],
    ['initial_risk',         'REAL'],
    ['mfe_r',                'REAL DEFAULT 0'],
    ['mae_r',                'REAL DEFAULT 0'],
    ['be_moved',             'INTEGER DEFAULT 0'],
    ['scaled_out',           'INTEGER DEFAULT 0'],
    ['strategy',             'TEXT'],
    ['source',               'TEXT'],
    ['label_raw',            'TEXT'],
    ['account_id',           'TEXT'],
    ['guard_json',           'TEXT'],
    ['peak_profit_usd',      'REAL'],
    // Tamper watch — last-seen broker truth for change detection (manual
    // reversals, volume edits, hand-moved SL/TP in the cTrader app).
    ['broker_volume_units',  'REAL'],
    ['broker_sl',            'REAL'],
    ['broker_tp',            'REAL'],
  ];
  for (const [col, type] of mpMigrations) {
    if (!mpColNames.has(col)) {
      db.exec(`ALTER TABLE monitored_positions ADD COLUMN ${col} ${type}`);
    }
  }

  // Trades table migration — add label provenance columns for pre-existing DBs
  const tCols = db.prepare("PRAGMA table_info(trades)").all();
  const tColNames = new Set(tCols.map(c => c.name));
  const tMigrations = [
    ['label_raw',        'TEXT'],
    ['source',           'TEXT'],
    ['label_version',    'TEXT'],
    ['label_strategy',   'TEXT'],
    ['label_conviction', 'TEXT'],
    ['label_session',    'TEXT'],
    ['label_timeframe',  'TEXT'],
    ['label_regime',     'TEXT'],
  ];
  for (const [col, type] of tMigrations) {
    if (!tColNames.has(col)) {
      db.exec(`ALTER TABLE trades ADD COLUMN ${col} ${type}`);
    }
  }

  // Signals table migration
  const sCols = db.prepare("PRAGMA table_info(signals)").all();
  const sColNames = new Set(sCols.map(c => c.name));
  if (!sColNames.has('source')) {
    db.exec("ALTER TABLE signals ADD COLUMN source TEXT");
  }

  // Scans table migration — which strategy produced the signal (the scan
  // covers 5 registry strategies now; the UI must not imply fib-only).
  const scCols = db.prepare("PRAGMA table_info(scans)").all();
  const scColNames = new Set(scCols.map(c => c.name));
  if (!scColNames.has('strategy')) {
    db.exec("ALTER TABLE scans ADD COLUMN strategy TEXT");
  }

  const aCols = db.prepare("PRAGMA table_info(analyses)").all();
  const aColNames = new Set(aCols.map(c => c.name));
  const aMigrations = [
    ['invalidation_trigger', 'TEXT'],
    ['time_cap_minutes',     'INTEGER'],
  ];
  for (const [col, type] of aMigrations) {
    if (!aColNames.has(col)) {
      db.exec(`ALTER TABLE analyses ADD COLUMN ${col} ${type}`);
    }
  }

  // Now that all columns exist, create indexes
  db.exec(INDEXES);

  // Seed agent_state defaults (skip keys that already exist)
  const upsert = db.prepare(
    'INSERT OR IGNORE INTO agent_state (key, value) VALUES (?, ?)',
  );
  const seedTx = db.transaction(() => {
    for (const [k, v] of Object.entries(SEED_STATE)) {
      upsert.run(k, v);
    }
  });
  seedTx();

  return db;
}

/**
 * Read a value from the agent_state key/value store.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string|null}
 */
export function getState(db, key) {
  const row = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Write a value into the agent_state key/value store (upsert).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string|null} value
 */
export function setState(db, key, value) {
  db.prepare(
    'INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * Close active monitored positions that belong to none of the given broker
 * accounts, so they stop gating risk checks (open-position cap, currency
 * exposure) the moment the account configuration changes. Rows with a NULL
 * account_id predate account stamping; they are swept only when
 * `sweepNull` is true (i.e. the account they were created under is no
 * longer part of the configuration).
 *
 * An empty or entirely-invalid keep list sweeps NOTHING — a malformed
 * request must never mass-close the monitor view.
 *
 * Broker state is untouched — this only clears the local monitor/gating view.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string|number>} keepAccountIds accounts whose rows stay active
 * @param {{sweepNull?: boolean}} [opts]
 * @returns {number} count of rows swept
 */
export function sweepMonitoredPositionsForAccounts(db, keepAccountIds, { sweepNull = true } = {}) {
  const keep = [...new Set((keepAccountIds || []).filter(id => id != null).map(String))];
  if (keep.length === 0) return 0;
  const placeholders = keep.map(() => '?').join(', ');
  const nullClause = sweepNull ? 'account_id IS NULL OR' : 'account_id IS NOT NULL AND';
  const res = db.prepare(
    `UPDATE monitored_positions
     SET status = 'closed',
         last_check_action = 'closed_account_switch',
         last_check_reasoning = 'Account switched — position belongs to a different broker account',
         last_check_at = datetime('now')
     WHERE status = 'active'
       AND (${nullClause} account_id NOT IN (${placeholders}))`,
  ).run(...keep);
  return res.changes;
}

/**
 * Single-account convenience wrapper: everything not belonging to
 * `newAccountId` (including legacy NULL rows) is swept. Used by
 * /actions/ctrader-select-account, which collapses roles to one account.
 */
export function sweepMonitoredPositionsForAccount(db, newAccountId) {
  return sweepMonitoredPositionsForAccounts(db, [newAccountId]);
}
