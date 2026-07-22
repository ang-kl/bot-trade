import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

// Extracted so the in-place migration below (SQLite can't ALTER a CHECK
// constraint) can rebuild the table with the exact same shape it's created
// with fresh, instead of a second, driftable copy of the DDL.
const TRADES_TABLE_SQL = `
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
    -- 'rejected' = order sent, no broker fill found on reconcile (owner hit
    -- "CHECK constraint failed" — this value was already written by
    -- reconcile-trades and already queried by /state/trades, but never
    -- allowed here until now).
    status                TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled','rejected')),
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
`;

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

  ${TRADES_TABLE_SQL}

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
    -- Per-position override (owner spec): a human-opened position is in the
    -- Profit Keeper's scope by default (per the account-wide on/off + scope
    -- setting) — ticking this OFF excludes just this one position, same as
    -- if it had its own guard_json rule. 0/NULL = follow the global policy.
    keeper_opt_out        INTEGER DEFAULT 0,
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

  -- Mirror of the broker's resting ENTRY orders (limit/stop), synced every
  -- reconcile. Owner: "even if Scan/Analyze/Autotrade are OFF, these pending
  -- orders will execute and you don't monitor" — resting orders live at the
  -- BROKER and fill regardless of the bot's switches. This gives them a durable
  -- record + lifecycle (working → gone) so a fill is never a surprise and the
  -- history survives a restart. SL/TP legs bound to open positions are excluded
  -- (they close, not open) — only standalone entry orders are recorded.
  CREATE TABLE IF NOT EXISTS broker_orders (
    order_id    TEXT PRIMARY KEY,
    symbol      TEXT,
    side        TEXT,
    order_type  TEXT,
    volume      REAL,
    limit_price REAL,
    stop_price  REAL,
    sl          REAL,
    tp          REAL,
    label       TEXT,
    is_bot      INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'working',   -- working | gone (filled or cancelled)
    first_seen  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT,
    gone_at     TEXT
  );

  -- Post-loss playback: after each losing trade, the sweep stores WHAT THE
  -- MARKET DID next (stop_hunt / thesis_wrong / chop / time_cap) plus the
  -- replay bars, so losses teach instead of just hurting (owner: "playback
  -- after each loss to understand what the market is happening").
  CREATE TABLE IF NOT EXISTS trade_postmortems (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id       INTEGER UNIQUE REFERENCES trades(id),
    symbol         TEXT,
    strategy       TEXT,
    timeframe      TEXT,
    side           TEXT,
    entry_price    REAL,
    exit_price     REAL,
    sl_price       REAL,
    net_pnl        REAL,
    r_multiple     REAL,
    classification TEXT,          -- stop_hunt | thesis_wrong | chop | time_cap | inconclusive
    detail         TEXT,
    bars_json      TEXT,          -- [[t,o,h,l,c,v], ...] replay window
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

  -- Cup & Handle Silence Diagnostics (Part A, owner-approved 2026-07-22):
  -- one row per scan cycle per symbol/timeframe cup_handle is evaluated on,
  -- recording which checklist gate stopped the best-progressed candidate.
  -- Turns "it hasn't fired in a week" into a diagnosis. Additive only —
  -- computeCupHandleSignal's own trading logic is untouched.
  CREATE TABLE IF NOT EXISTS cup_handle_diagnostics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    timeframe     TEXT,
    scanned_at    TEXT NOT NULL,
    bias          TEXT,          -- 'long' (classic cup_handle) or 'short' (inv_cup_handle); NULL on old rows predating the inverted pattern
    uptrend_ok    INTEGER,
    cup_found     INTEGER,
    blocked_at    TEXT,          -- best_candidate.blocked_at, or NULL if no candidate at all
    candidate_json TEXT,         -- full best_candidate object, or NULL
    loop_id       INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  CREATE INDEX IF NOT EXISTS idx_cup_handle_diag_symbol_at ON cup_handle_diagnostics(symbol, scanned_at);
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

  // One-time rebuild: 'rejected' was always a valid trades.status value in
  // the APP (reconcile-trades writes it, /state/trades queries for it) but
  // the CHECK constraint on pre-existing databases never allowed it — every
  // reconcile pass that found an order with no broker fill crashed with
  // "CHECK constraint failed: status IN ('open','closed','cancelled')"
  // instead of recording the rejection (owner hit this live). SQLite can't
  // ALTER a CHECK constraint in place, so this rebuilds the table exactly
  // once, preserving every row — a fresh DB already gets the fixed
  // constraint from TABLES above and skips this entirely.
  // Self-heal a leftover temp table from a run that was killed mid-migration
  // (e.g. a platform restart landing between the rename and the drop) —
  // production hit "no such table: trades_pre_rejected_status_migration"
  // from exactly this. Note `db.exec(TABLES)` above already ran `CREATE
  // TABLE IF NOT EXISTS trades`, so if the kill landed right after the
  // rename (before the real CREATE TABLE), `trades` exists again here too —
  // as an EMPTY stub — so "does trades exist" can't tell real data from
  // that stub. Row counts can: the real data always lands in whichever
  // table still has rows.
  const staleTemp = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trades_pre_rejected_status_migration'`
  ).get();
  if (staleTemp) {
    const tradesRows = db.prepare(`SELECT COUNT(*) n FROM trades`).get()?.n ?? 0;
    const tempRows = db.prepare(`SELECT COUNT(*) n FROM trades_pre_rejected_status_migration`).get()?.n ?? 0;
    if (tradesRows === 0 && tempRows > 0) {
      // `trades` is TABLES's just-created empty stub — the temp table holds
      // the real data; swap it back in.
      db.exec('DROP TABLE trades');
      db.exec('ALTER TABLE trades_pre_rejected_status_migration RENAME TO trades');
    } else {
      // `trades` already has the real data (a prior attempt finished the
      // copy before being killed on the final drop) — the temp table is a
      // redundant snapshot.
      db.exec('DROP TABLE trades_pre_rejected_status_migration');
    }
  }

  const tradesSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trades'`).get()?.sql || '';
  if (tradesSql && !tradesSql.includes("'rejected'")) {
    try {
      const fkWasOn = db.pragma('foreign_keys', { simple: true });
      db.pragma('foreign_keys = OFF');
      // Explicit column list on both sides — never rely on physical column
      // order matching between the old table (columns appended over time via
      // ALTER TABLE ADD COLUMN) and the freshly-declared one.
      const TRADES_COLS = [
        'id', 'symbol', 'side', 'entry_price', 'exit_price', 'sl_price', 'tp_price', 'volume',
        'opened_at', 'closed_at', 'hold_duration_ms', 'gross_pnl', 'net_pnl', 'status', 'close_reason',
        'thesis', 'strategy', 'conviction', 'ctrader_position_id', 'analysis_id', 'label_raw', 'source',
        'label_version', 'label_strategy', 'label_conviction', 'label_session', 'label_timeframe', 'label_regime',
      ];
      const oldCols = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name));
      const copyCols = TRADES_COLS.filter(c => oldCols.has(c));
      // legacy_alter_table: modern RENAME rewrites FOREIGN KEY references in
      // OTHER tables' stored schemas to follow the rename — so renaming
      // trades away pointed monitored_positions.trade_id at the temp table,
      // and dropping the temp left the FK dangling ("no such table:
      // main.trades_pre_rejected_status_migration" on every insert; owner
      // hit it live via the pending-order manager). Legacy mode renames
      // ONLY the table itself — exactly right for a rename-as-rebuild.
      db.pragma('legacy_alter_table = ON');
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS trades_pre_rejected_status_migration');
        db.exec('ALTER TABLE trades RENAME TO trades_pre_rejected_status_migration');
        db.exec(TRADES_TABLE_SQL);
        db.exec(`INSERT INTO trades (${copyCols.join(', ')}) SELECT ${copyCols.join(', ')} FROM trades_pre_rejected_status_migration`);
        db.exec('DROP TABLE trades_pre_rejected_status_migration');
      })();
      db.pragma('legacy_alter_table = OFF');
      if (fkWasOn) db.pragma('foreign_keys = ON');
    } catch (err) {
      // Never let a migration failure take the whole server down — the app
      // still works against whatever schema is currently on disk (with
      // 'rejected' writes failing loudly at the call site, same as before
      // this migration existed) rather than crash-looping on every boot.
      console.error('[db] trades CHECK-constraint migration failed, continuing on existing schema:', err.message);
    }
  }

  // Repair dangling FK references left by the PRE-legacy_alter_table version
  // of the migration above: renaming `trades` away rewrote referencing FKs
  // (monitored_positions.trade_id) to point at the temp table, and dropping
  // the temp left them dangling — every INSERT into a referencing table then
  // failed with "no such table: main.trades_pre_rejected_status_migration"
  // (owner hit 24 straight pending-order-manager failures live). The temp
  // table never holds anything but a moment-in-time copy of trades, so any
  // surviving reference to it MEANS trades — rewrite the stored schema text
  // back. Direct sqlite_master surgery needs defensive mode off (unsafeMode)
  // and writable_schema; RESET reloads the schema so this connection sees
  // the fix immediately. Verified by integrity_check before continuing.
  try {
    const dangling = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name != 'trades_pre_rejected_status_migration'
        AND sql LIKE '%trades_pre_rejected_status_migration%'`
    ).all();
    const tempExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trades_pre_rejected_status_migration'`
    ).get();
    if (dangling.length > 0 && !tempExists) {
      const fkWasOn = db.pragma('foreign_keys', { simple: true });
      db.pragma('foreign_keys = OFF');
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare(
        `UPDATE sqlite_master
           SET sql = replace(replace(sql, '"trades_pre_rejected_status_migration"', 'trades'), 'trades_pre_rejected_status_migration', 'trades')
         WHERE type = 'table' AND sql LIKE '%trades_pre_rejected_status_migration%'`
      ).run();
      db.pragma('writable_schema = RESET');
      db.unsafeMode(false);
      if (fkWasOn) db.pragma('foreign_keys = ON');
      const integrity = db.pragma('integrity_check', { simple: true });
      console.log(`[db] repaired dangling trades-migration FK reference in: ${dangling.map(d => d.name).join(', ')} (integrity: ${integrity})`);
    }
  } catch (err) {
    console.error('[db] dangling-FK repair failed, continuing:', err.message);
  }

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
    ['keeper_opt_out',       'INTEGER DEFAULT 0'],
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
    // Millisecond-precision close timestamp, written in JS (Date.now()) —
    // closed_at (TEXT via SQLite datetime('now')) is second-precision and
    // stays for existing readers; this is the one hold_duration_ms and the
    // close-completeness sweep key off of.
    ['closed_at_ms',     'INTEGER'],
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

  // Trade-Lesson Extraction (owner spec): flat controller-consumable fields
  // on every postmortem + confluence capture at entry.
  const pmCols = db.prepare("PRAGMA table_info(trade_postmortems)").all();
  const pmColNames = new Set(pmCols.map(c => c.name));
  for (const [col, type] of [["result", "TEXT"], ["lesson", "TEXT"], ["alpha_decay", "TEXT"], ["entry_quality", "TEXT"]]) {
    if (!pmColNames.has(col)) db.exec(`ALTER TABLE trade_postmortems ADD COLUMN ${col} ${type}`);
  }
  const tCols2 = db.prepare("PRAGMA table_info(trades)").all();
  if (!new Set(tCols2.map(c => c.name)).has("confluence_count")) {
    db.exec("ALTER TABLE trades ADD COLUMN confluence_count INTEGER");
  }

  // Pending-orders migration — carry the STRATEGY that queued the order so
  // the set-order ledger can show strategy + timeframe (owner: "pending
  // order should have Strategy plus Time-Frame").
  const poCols = db.prepare("PRAGMA table_info(pending_orders)").all();
  const poColNames = new Set(poCols.map(c => c.name));
  if (!poColNames.has('strategy')) {
    db.exec("ALTER TABLE pending_orders ADD COLUMN strategy TEXT");
  }

  // Inverted Cup & Handle (owner-directed 2026-07-22): diagnostics rows now
  // come from either direction — tag which one so they don't read as
  // identical (blocked_at values are shared strings across both).
  const chdCols = db.prepare("PRAGMA table_info(cup_handle_diagnostics)").all();
  const chdColNames = new Set(chdCols.map(c => c.name));
  if (!chdColNames.has('bias')) {
    db.exec("ALTER TABLE cup_handle_diagnostics ADD COLUMN bias TEXT");
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

// SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' (UTC, no offset) —
// Date.parse needs a 'T' separator and an explicit zone to read it back.
function sqliteTimeToMs(text) {
  if (!text) return null;
  const iso = String(text).includes('T') ? text : `${String(text).replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ONE place a trade row is marked closed (converges loop.js's
 * markTradeClosed and reconciler.js's three close sites). Every caller gets
 * the same idempotency guarantee: `WHERE id = ? AND status = 'open'`, so a
 * trade already closed by one path can never be double-processed by another
 * racing to close it too (the loop.js call site had no such guard before —
 * confirmed gap, "two closes fired for one trade_id must result in exactly
 * one write").
 *
 * Stamps closed_at_ms (Date.now(), millisecond precision) alongside the
 * existing closed_at (SQLite datetime('now'), second precision, kept for
 * existing readers) and computes hold_duration_ms from the trade's own
 * opened_at, parsed the same way closed_at_ms's SQL sibling would be.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} tradeId
 * @param {{exitPrice?: number|null, closeReason?: string|null, grossPnl?: number|null, netPnl?: number|null, closedAtMs?: number}} [opts]
 * @returns {{changed: boolean, holdDurationMs: number|null}}
 */
export function closeTradeRow(db, tradeId, {
  exitPrice = null, closeReason = null, grossPnl = null, netPnl = null, closedAtMs = Date.now(),
} = {}) {
  const row = db.prepare('SELECT opened_at FROM trades WHERE id = ?').get(tradeId);
  const openedAtMs = row ? sqliteTimeToMs(row.opened_at) : null;
  const holdDurationMs = openedAtMs != null ? closedAtMs - openedAtMs : null;
  const info = db.prepare(`
    UPDATE trades
    SET status = 'closed', closed_at = datetime('now'), closed_at_ms = ?,
        hold_duration_ms = COALESCE(?, hold_duration_ms),
        exit_price = COALESCE(?, exit_price),
        close_reason = COALESCE(?, close_reason),
        gross_pnl = COALESCE(?, gross_pnl),
        net_pnl = COALESCE(?, net_pnl)
    WHERE id = ? AND status = 'open'
  `).run(closedAtMs, holdDurationMs, exitPrice, closeReason, grossPnl, netPnl, tradeId);
  return { changed: info.changes > 0, holdDurationMs };
}

/**
 * Persist one Cup & Handle diagnostics trace (see traceCupHandleSearch /
 * traceInvCupHandleSearch in services/cup-handle.js). Called only when
 * cup_handle and/or inv_cup_handle is enabled for the scan — the trace
 * itself is opts-in, computed for free alongside the existing scan, so
 * this is the only new write. `bias` ('long' | 'short') distinguishes
 * which direction produced the row — required going forward now that two
 * directions can both write here; null on rows from before the inverted
 * pattern existed.
 */
export function insertCupHandleDiagnostic(db, { symbol, timeframe, scanned_at, bias = null, uptrend_ok, cup_found, best_candidate, loop_id = null }) {
  db.prepare(`
    INSERT INTO cup_handle_diagnostics (symbol, timeframe, scanned_at, bias, uptrend_ok, cup_found, blocked_at, candidate_json, loop_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol, timeframe || null, scanned_at, bias,
    uptrend_ok ? 1 : 0, cup_found ? 1 : 0,
    best_candidate ? (best_candidate.blocked_at ?? null) : null,
    best_candidate ? JSON.stringify(best_candidate) : null,
    loop_id,
  );
}
