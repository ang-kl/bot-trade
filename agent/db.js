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
