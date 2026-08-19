import Database from 'better-sqlite3';
import { openJournal } from './lib/wal-open.js';
import { maybeEmergencyReclaim } from './services/emergency-reclaim.js';
// Leaf module — imports nothing, takes `db` as a parameter — so this cannot
// cycle back into db.js. See closeTradeRow for why the stamp lives here.
import { realisedRR, checkTradeConsistency } from './services/trade-consistency.js';

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
    -- 'rejected'    = order sent, broker refused it — provably no position.
    -- 'submitting'  = WRITE-AHEAD INTENT. The row is created before the broker
    --                 is called and promoted to 'open' on ACK, so a timeout or
    --                 a crash mid-flight still leaves the duplicate guard
    --                 (risk.js:809, which reads this table) something to see.
    --                 Without it, an order could be live at the broker with
    --                 nothing in the ledger — the 9x 0066.HK duplicate.
    -- 'unconfirmed' = the submission failed AMBIGUOUSLY. A position may exist.
    --                 Deliberately distinct from 'rejected': one must keep
    --                 blocking re-entry, the other must not.
    --
    -- Adding a value here WITHOUT the migration below is a live trading
    -- outage, not a schema nicety: every INSERT carrying the new status throws
    -- "CHECK constraint failed" at the call site. That is how 'rejected' was
    -- found, and it nearly happened again with 'submitting'.
    status                TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled','rejected','submitting','unconfirmed')),
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

  -- Account Registry (multi-account migration plan, Phase 1 R1 / milestone
  -- M0). Single source of truth for which cTrader accounts exist and which
  -- may trade. account_id is cTrader's INTERNAL ctidTraderAccountId (the
  -- one every API call takes); trader_login is the human-facing number the
  -- cTrader app shows (e.g. 1251247, 5306502). In M0 exactly ONE row is
  -- enabled at a time, mirroring today's single-account behaviour; later
  -- milestones lift that. Managed by services/account-registry.js — no
  -- other writer.
  CREATE TABLE IF NOT EXISTS accounts (
    account_id      TEXT PRIMARY KEY,
    trader_login    TEXT,
    broker_label    TEXT NOT NULL DEFAULT 'cTrader',
    is_live         INTEGER NOT NULL DEFAULT 0,
    base_currency   TEXT,
    leverage        INTEGER,
    enabled         INTEGER NOT NULL DEFAULT 0,
    mode            TEXT NOT NULL DEFAULT 'manage_only', -- 'active' | 'manage_only' | 'paused'
    risk_profile    TEXT,
    symbol_universe TEXT,
    params          TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 3A decision provenance (multi-account plan, non-negotiable): every
  -- controller decision that today only reaches stdout — SKIPS included —
  -- becomes queryable. risk_events already covers risk-gate vetoes; this
  -- table covers everything upstream of the gate (dispatch/style/decay/
  -- override gates) and is deliberately generic so later milestones stamp
  -- more stages without schema changes. Written by services/decision-log.js.
  CREATE TABLE IF NOT EXISTS decision_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT,
    symbol       TEXT,
    timeframe    TEXT,
    strategy     TEXT,
    stage        TEXT NOT NULL,   -- e.g. 'dispatch', 'style_filter', 'lesson_decay', 'watchlist_override'
    decision     TEXT NOT NULL,   -- 'skip' | 'veto' | 'proceed'
    reason       TEXT,
    detail_json  TEXT,
    loop_id      INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- P10 (2026-07-26): the tweak journal's only recoverable source.
  -- monitored_positions keeps current flags (be_moved, scaled_out) and the
  -- LATEST review, not a timeline; action_log is a generic HTTP log;
  -- decision_log covers decisions upstream of the risk gate, not amendments
  -- to a live position. This table is that timeline. Written by
  -- services/position-events.js; never blocks trading (see that module's
  -- header for the non-throwing contract, mirroring decision_log).
  CREATE TABLE IF NOT EXISTS position_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    account_id   TEXT,
    position_id  TEXT,               -- broker position id (ctrader_position_id)
    trade_id     INTEGER REFERENCES trades(id),
    symbol       TEXT NOT NULL,
    kind         TEXT NOT NULL,      -- sl_moved | tp_moved | scale_out | close
                                      -- | trail_armed | trail_tightened
                                      -- | lot_trimmed | paused | resumed
                                      -- | authority_override (§41 observation,
                                      --   written by minute-review.js, not an
                                      --   amendment — see position-events.js)
    from_value   REAL,
    to_value     REAL,
    r_at         REAL,               -- R at the moment of the event
    price_at     REAL,
    reason       TEXT,               -- human sentence, same discipline as decision_log
    source       TEXT,               -- profit_keeper | position_manager | cpp_trail_engine
                                      -- | manual | session_open_guard | weekend_watch
                                      -- | equity_stop | fast_monitor
    detail_json  TEXT
  );

  -- Broker deal history, imported from cTrader's own record (owner
  -- 2026-07-25: read historical trades). DELIBERATELY NOT the 'trades'
  -- table: perf-ledger, edge-health, the metrics snapshot and the lessons
  -- tuner all count every closed 'trades' row with a net_pnl and none of
  -- them filter on source, so importing pre-bot and manual fills there
  -- would silently move the win rate, PF, strategy attribution and lesson
  -- decay keys. This table is broker truth kept alongside, joined to a
  -- local row by position id when one exists, and read only by callers that
  -- ask for it. deal_id is the broker's own primary key, so re-importing an
  -- overlapping window is a no-op.
  -- Durable backtest history (owner 2026-07-28: "backtest history per
  -- symbol"). One row per symbol×timeframe per run — the HTML reports live
  -- on ephemeral disk and vanish on redeploy, so this table is the record
  -- the watchlist page reads. Pruned to the newest ~2000 rows on write.
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at           TEXT NOT NULL,
    strategy         TEXT,
    entry_mode       TEXT,
    bars             INTEGER,
    symbol           TEXT NOT NULL,
    timeframe        TEXT NOT NULL,
    trades           INTEGER,
    losses           INTEGER,          -- 0 with trades > 0 = no losing trade (PF is ∞, stored NULL)
    win_rate_pct     REAL,
    profit_factor    REAL,
    total_profit_pct REAL,
    wf_positive      INTEGER,          -- walk-forward segments that ended positive
    wf_active        INTEGER,          -- walk-forward segments with any trades
    error            TEXT              -- per-symbol fetch/data failure, honestly kept
  );

  CREATE TABLE IF NOT EXISTS broker_deals (
    deal_id          TEXT PRIMARY KEY,
    position_id      TEXT,
    account_id       TEXT,
    symbol           TEXT,
    side             TEXT,             -- the POSITION's side, not the closing deal's
    lots             REAL,
    entry_price      REAL,
    close_price      REAL,
    opened_at        TEXT,             -- from the position's opening deal, NULL if outside the window
    closed_at        TEXT,
    gross_pnl        REAL,
    swap             REAL,
    commission       REAL,
    net_pnl          REAL,
    -- trades.id when this broker deal matches a row we placed. NULL means
    -- the bot has no record of it: pre-bot history, a manual fill, or a
    -- trade lost to a restart.
    matched_trade_id INTEGER,
    imported_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_backtest_runs_symbol   ON backtest_runs(symbol, ran_at);
  CREATE INDEX IF NOT EXISTS idx_backtest_runs_at       ON backtest_runs(ran_at);
  CREATE INDEX IF NOT EXISTS idx_broker_deals_closed    ON broker_deals(closed_at);
  CREATE INDEX IF NOT EXISTS idx_broker_deals_sym_open   ON broker_deals(symbol, opened_at);
  CREATE INDEX IF NOT EXISTS idx_broker_deals_position   ON broker_deals(position_id);
  CREATE INDEX IF NOT EXISTS idx_decision_log_at        ON decision_log (created_at);
  CREATE INDEX IF NOT EXISTS idx_decision_log_sym_stage ON decision_log (symbol, stage, created_at);
  CREATE INDEX IF NOT EXISTS idx_position_events_pos    ON position_events(position_id, at);
  CREATE INDEX IF NOT EXISTS idx_position_events_at     ON position_events(at);
  CREATE INDEX IF NOT EXISTS idx_scans_symbol_at        ON scans   (symbol, scanned_at);
  CREATE INDEX IF NOT EXISTS idx_analyses_symbol_at     ON analyses(symbol, analyzed_at);
  -- The FK child key. Deleting a PARENT row (a scan) with foreign_keys ON
  -- makes SQLite prove no child references it; without this index that is a
  -- full scan of the analyses table PER DELETED SCAN, and the cost never
  -- appears in EXPLAIN QUERY PLAN. With months of scans becoming deletable at
  -- once, that is the difference between a prune that finishes and one that
  -- overruns the watchdog.
  CREATE INDEX IF NOT EXISTS idx_analyses_scan_id       ON analyses(scan_id);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol_at      ON signals (symbol, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_regimes_symbol_at      ON regimes (symbol, computed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_opened    ON trades  (symbol, opened_at);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_closed    ON trades  (symbol, closed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_source_strategy   ON trades  (source, label_strategy, closed_at);
  CREATE INDEX IF NOT EXISTS idx_trades_label_regime      ON trades  (label_regime, closed_at);
  -- Every-cycle breaker reads (2026-07-28 profiling). adaptive-breaker and
  -- edge-watchdog each run "WHERE status='closed' AND label_strategy=? ORDER BY
  -- closed_at DESC" once per enabled strategy — 11 strategies × 2 services × a
  -- full table scan plus a temp-b-tree sort, every five minutes, in a stretch
  -- of the cycle with no I/O to yield on. idx_trades_source_strategy cannot
  -- serve them: it leads with "source", which those queries don't constrain.
  CREATE INDEX IF NOT EXISTS idx_trades_strategy_closed   ON trades  (label_strategy, closed_at DESC, id DESC);
  -- performance-breaker + the QUANT aggregate: "WHERE status='closed'" with no
  -- other predicate had no index at all.
  --
  -- It does NOT help the equity stop's day-PnL sum. Measured with 4k rows and
  -- ANALYZE: that query still plans as a full SCAN, because REPLACE(closed_at,
  -- 'T',' ') is unindexable and status='closed' matches most of the table, so
  -- the index is not selective enough to be worth it. The REPLACE is left
  -- alone deliberately — it exists because two writers store two timestamp
  -- formats, and rewriting it is a live-money correctness change, not an index
  -- change. One bounded scan per cycle is not the read-stall culprit.
  CREATE INDEX IF NOT EXISTS idx_trades_status_closed     ON trades  (status, closed_at);
  -- reconciler's NOT IN (SELECT MAX(id) ... GROUP BY ctrader_position_id) dedupe
  -- sweeps and pending-orders' known-position Set, both full scans before this.
  CREATE INDEX IF NOT EXISTS idx_trades_position_id       ON trades  (ctrader_position_id);
  -- QUANT's "DISTINCT symbol FROM scans WHERE scanned_at > ?" and the 8-hourly
  -- retention DELETE both filter on time alone; idx_scans_symbol_at leads with
  -- symbol, so both walked the whole index.
  CREATE INDEX IF NOT EXISTS idx_scans_at                 ON scans   (scanned_at);
  CREATE INDEX IF NOT EXISTS idx_signals_at               ON signals (recorded_at);
  CREATE INDEX IF NOT EXISTS idx_regimes_at               ON regimes (computed_at);
  -- Read every 3s by fast-monitor and several times per cycle by the loop;
  -- idx_monitored_source leads with "source", which these don't constrain.
  CREATE INDEX IF NOT EXISTS idx_monitored_status         ON monitored_positions(status);
  CREATE INDEX IF NOT EXISTS idx_monitored_symbol_at    ON monitored_positions(symbol, last_check_at);
  CREATE INDEX IF NOT EXISTS idx_monitored_source       ON monitored_positions(source, status);
  CREATE INDEX IF NOT EXISTS idx_perf_computed          ON performance_snapshots(computed_at);
  CREATE INDEX IF NOT EXISTS idx_risk_events_at         ON risk_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_risk_events_symbol     ON risk_events(symbol, created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_signals_status ON pending_signals(status, symbol);
  CREATE INDEX IF NOT EXISTS idx_cup_handle_diag_symbol_at ON cup_handle_diagnostics(symbol, scanned_at);
  -- The funnel readout (services/cup-handle-funnel.js) scans a TIME window
  -- across every symbol, which the (symbol, scanned_at) index cannot serve.
  -- Production holds 2.6M rows here; without this the route is a full table
  -- scan per request, and slow read routes are a defect this repo has already
  -- paid for once.
  CREATE INDEX IF NOT EXISTS idx_cup_handle_diag_at ON cup_handle_diagnostics(scanned_at);
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

  // Performance / concurrency pragmas.
  //
  // The journal open is delegated because it is the one pragma that can fail
  // for a reason outside SQL: a full volume cannot size the WAL's `-shm`
  // file, and the resulting SQLITE_IOERR_SHMSIZE crash-looped this agent for
  // hours on 18-08-2026 while reporting only its mechanism. openJournal logs
  // what the disk actually looked like and falls back to exclusive locking
  // (wal-index in heap, no -shm) so the process can at least boot and run the
  // compaction that reclaims the space.
  const journal = openJournal(db, resolvedPath);
  if (journal.degraded) db.__journalDegraded = journal;

  // A full volume is a deadlock: compaction reclaims the space, compaction
  // runs inside the agent, and the agent cannot boot on a full volume. So the
  // reclaim happens HERE — after the journal is up and before db.exec(TABLES)
  // below, which writes and would be the next thing to fail.
  maybeEmergencyReclaim(db, resolvedPath);
  console.log(`[boot] storage: ${journal.storage} journal=${journal.mode}`);
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
  // Keyed on the NEWEST allowed status, not the oldest: a database sitting at
  // either earlier revision (pre-'rejected' or pre-'submitting') is carried
  // forward by this one pass, and a database already current is skipped.
  if (tradesSql && !tradesSql.includes("'submitting'")) {
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
    // Early-trim shadow (owner 07-08, "ship T2 log-only now"). One trim per
    // POSITION, ever — not one per leg, so that a future add-on-trend cannot
    // re-arm the trim on every add and produce trim/add/trim churn. Written
    // only when the feature is switched from shadow to acting; the shadow pass
    // reads it and never sets it.
    ['early_trimmed',        'INTEGER DEFAULT 0'],
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

  // Repair float-formatted broker position ids (2026-08-02). Some open paths
  // stored ctrader_position_id as "234698574.0" while the broker/deal-history
  // side uses "234698574" — so the P&L backfill never matched (52 closed
  // trades stuck with net_pnl NULL on production, daily-loss gate vetoing
  // every entry), the reconciler's known-id sets missed the row (duplicate
  // adoptions), and the orphan sweep closed the originals with NULL P&L.
  // Writers now normalise via lib/pos-id.js; this one-time pass repairs the
  // rows already on disk. The CAST(...)>0 guard leaves non-numeric ids alone.
  try {
    const fixT = db.prepare(
      `UPDATE trades SET ctrader_position_id = CAST(CAST(ctrader_position_id AS INTEGER) AS TEXT)
        WHERE ctrader_position_id LIKE '%.%' AND CAST(ctrader_position_id AS INTEGER) > 0`
    ).run();
    const fixE = db.prepare(
      `UPDATE position_events SET position_id = CAST(CAST(position_id AS INTEGER) AS TEXT)
        WHERE position_id LIKE '%.%' AND CAST(position_id AS INTEGER) > 0`
    ).run();
    if (fixT.changes || fixE.changes) {
      console.log(`[db] normalised float-formatted position ids: trades=${fixT.changes} position_events=${fixE.changes}`);
    }
  } catch (err) {
    console.error('[db] position-id normalisation failed, continuing:', err.message);
  }

  // Carry-cost awareness: swap rates ride along with the symbol-hours
  // refresh (same ProtoOASymbol fetch — zero extra broker calls). Stored in
  // the broker's own units (points per lot per night, moneyDigits-scaled
  // upstream); NULL until the next refresh touches the symbol.
  const shCols = new Set(db.prepare("PRAGMA table_info(symbol_hours)").all().map(c => c.name));
  for (const [col, type] of [
    ['swap_long', 'REAL'], ['swap_short', 'REAL'], ['swap_rollover_3days', 'INTEGER'],
  ]) {
    if (!shCols.has(col)) db.exec(`ALTER TABLE symbol_hours ADD COLUMN ${col} ${type}`);
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
  // Daily ATR history — the 252-day baseline the vol-gate percentile is
  // measured against (spec §2). One row per symbol per day, so a refresh is
  // idempotent and a backfill can fill gaps without duplicating. Kept in its
  // own table rather than on `regimes` because regimes is written every scan
  // (many rows per symbol per day) and this is deliberately once-daily.
  db.exec(`
    CREATE TABLE IF NOT EXISTS atr_history (
      symbol      TEXT NOT NULL,
      day         TEXT NOT NULL,        -- YYYY-MM-DD, the bar's UTC day
      atr         REAL NOT NULL,
      close       REAL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (symbol, day)
    );
    CREATE INDEX IF NOT EXISTS idx_atr_history_symbol_day ON atr_history(symbol, day DESC);
  `);

  // ------------------------------------------------------------------
  // VOL-GATE (docs/volatility-gate-integration-spec.md), 2026-07-29.
  //
  // The volatility context a trade was OPENED in is a property of that
  // trade, so it lives on `trades` beside confluence_count — not in a
  // side table that would need joining and could go missing. The
  // postmortem carries it forward at close, exactly as it already does
  // for confluence_count, so there is ONE writer per field and no second
  // close handler.
  //
  // Every column is nullable and nothing writes them yet: the gate ships
  // log-only, and until it runs these read NULL, which is the honest
  // "we did not measure this trade" — not a zero that would look like a
  // LOW-vol reading.
  //
  // The spec asked for `trade_outcome_vol_adjusted: WIN|LOSS|WHIPSAW`.
  // Deliberately NOT added: trade_postmortems.classification already
  // carries a richer, established vocabulary (stop_hunt | thesis_wrong |
  // chop | time_cap | inconclusive | clean_win | gave_back), and
  // classifyResult/classifyWin already populate it for wins and losses
  // alike. A second outcome vocabulary for the same event would be the
  // same disease as a second volatility classifier — two answers, no
  // owner. Bucket the existing classification by entry_vol_regime instead.
  const tColsVol = new Set(db.prepare("PRAGMA table_info(trades)").all().map(c => c.name));
  for (const [col, type] of [
    ['entry_vol_regime',            'TEXT'],     // LOW | NORMAL | HIGH
    ['entry_vol_percentile',        'REAL'],     // 0-100 within the 252d ATR history
    ['entry_vol_insufficient',      'INTEGER'],  // 1 = under 252d of history, treated as NORMAL
    ['position_size_ratio_applied', 'REAL'],
    ['stop_loss_expanded_pips',     'REAL'],
    ['confirmation_candles_required', 'INTEGER'],
    ['vol_volume_divergence_flag',  'INTEGER'],  // HIGH vol on thin participation
    ['fvg_origin_vol_regime',       'TEXT'],
    // HOW THE TRADE CAME TO EXIST (audit Part 2, Phase 6). One of
    // lib/trade-origin.js's ORIGINS. `source` and `label_strategy` answer who
    // wrote the label and which strategy was named; neither answers whether
    // this system DECIDED to take the trade. A reconciler-adopted position
    // carries a label because reconciliation parsed one off the broker's
    // position comment — provenance of a string, not of a decision — and
    // counting it as strategy edge is what made the win rate a mixture.
    ['origin',                      'TEXT'],
    // 'write' when stamped at creation, 'backfill' when derived afterwards by
    // scripts/backfill-trade-origin.mjs. Keeps the reversal targeted: rolling
    // back a backfill must not clear origins the write paths recorded.
    ['origin_source',               'TEXT'],
    ['fvg_fill_target_pct',         'INTEGER'],
    ['confluence_tool_count',       'INTEGER'],
    ['confluence_conflict_flagged', 'INTEGER'],
    ['vol_gate_mode',               'TEXT'],     // 'log_only' | 'live' — which mode produced the row
    // UNKNOWABLE, as distinct from UNKNOWN (owner's decision 2026-07-30,
    // "option 2"). A closed trade with net_pnl NULL makes the daily-loss sum
    // untrustworthy, so services/unresolved-pnl.js blocks new entries on it —
    // fail-closed, deliberately, and not to be weakened. But that veto has no
    // expiry, and pnl-backfill can only repair a row while the close is still
    // inside the broker's deal-history window. Once it falls out, the row can
    // NEVER fill: the owner's log showed 77 such rows with the backfill parked
    // on its 6-hour rung attempting zero accounts. A fail-closed brake plus a
    // permanently unfillable input is a closed loop that stops trading for ever.
    //
    // These three columns record that a row is unfillable AS A FINDING, with
    // evidence and a timestamp, so the veto can tell "the backfill has not got
    // to it yet" (keep blocking) from "the broker has no record and never will"
    // (stop blocking, and say so loudly). Nothing about the P&L is invented —
    // net_pnl stays NULL, because it is genuinely unknown.
    ['pnl_unresolvable',            'INTEGER DEFAULT 0'],
    ['pnl_unresolvable_reason',     'TEXT'],
    ['pnl_unresolvable_at',         'TEXT'],
  ]) {
    if (!tColsVol.has(col)) db.exec(`ALTER TABLE trades ADD COLUMN ${col} ${type}`);
  }
  // Mirrored onto the postmortem so a lesson row is self-contained — the
  // lessons tuner reads postmortems, not trades.
  const pmColsVol = new Set(db.prepare("PRAGMA table_info(trade_postmortems)").all().map(c => c.name));
  for (const [col, type] of [
    ['entry_vol_regime',            'TEXT'],
    ['entry_vol_percentile',        'REAL'],
    ['position_size_ratio_applied', 'REAL'],
    ['stop_loss_expanded_pips',     'REAL'],
    ['vol_volume_divergence_flag',  'INTEGER'],
    ['confluence_tool_count',       'INTEGER'],
    ['confluence_conflict_flagged', 'INTEGER'],
    ['vol_gate_mode',               'TEXT'],
  ]) {
    if (!pmColsVol.has(col)) db.exec(`ALTER TABLE trade_postmortems ADD COLUMN ${col} ${type}`);
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
  // The INTENDED HOLD of the position the order would become, in minutes —
  // a different quantity from `expires_at`, which is the deadline for the
  // ORDER to fill. Conflating the two gave every pending fill a time cap
  // measured from placement, so a limit that rested most of its life before
  // filling produced a position that was born at or past its cap (2026-08-10).
  if (!poColNames.has('time_cap_minutes')) {
    db.exec("ALTER TABLE pending_orders ADD COLUMN time_cap_minutes INTEGER");
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

  // Multi-account migration, milestone M1 (docs/multi-account-migration-
  // plan.md Phase 3 M1): every per-account table gains a nullable
  // account_id column, additively. NULL means "written before scoping (or
  // by a global, account-independent pass)" — the boot backfill in
  // services/account-registry.js stamps historical rows with the account
  // they were created under (single-account era ⇒ unambiguous). scans and
  // analyses are account-independent market observations and may stay NULL
  // ("global") by design.
  // A5 (per-account workspaces): action_log and backtest_runs join the scoped
  // set. They are the owner's "logs" and "historical data" asks, and were the
  // last two per-account-meaningful tables still global. Additive and
  // nullable, like every column above — historical rows stay NULL, which reads
  // as "written before scoping", never as "belongs to nobody".
  //
  // regimes, symbol_hours, controller_heartbeats and token_usage stay GLOBAL
  // on purpose: the first two are facts about INSTRUMENTS rather than
  // accounts (duplicating them per account would multiply the broker load),
  // the third is process health and the fourth a process cost.
  for (const table of [
    'trades', 'scans', 'analyses', 'signals', 'pending_orders',
    'broker_orders', 'risk_events', 'trade_postmortems', 'pending_signals',
    'cup_handle_diagnostics', 'performance_snapshots',
    'action_log', 'backtest_runs',
  ]) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    if (!cols.has('account_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
    }
  }

  // §70.9 TRADE LINEAGE. Until 2026-08-04 an approval and the trade it
  // produced were associated only by symbol, side and rough timing — which is
  // why §70.8 could compare approvals to landings in AGGREGATE and never say
  // WHICH approval went nowhere. risk_events.id is a stable identifier; this
  // carries it forward onto the row the approval actually produced, so the
  // chain decision -> order -> position -> economics can be walked in either
  // direction instead of inferred.
  for (const table of ['trades', 'pending_orders']) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    if (!cols.has('risk_event_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN risk_event_id INTEGER`);
    }
  }

  // GO-LIVE PHASE 0 (docs/go-live-plan.md, P0-1/P0-2). Two columns the gate
  // needs and did not have.
  //
  // `realised_rr` — every R:R the system reported was PLANNED, derived from
  // the bracket in perf-ledger.js. So `edge = winPct - requiredWinPct`
  // compared a REALISED win rate against a PLANNED break-even, which only
  // holds if trades finish where we aimed them. Measured 05-08-2026: only
  // 52.5% of closed trades reach a bracket at all and 25% are cut by the time
  // cap, so realised R sits below planned R and the reported edge flatters us.
  //
  // `pnl_price_mismatch` — 56 of 190 decidable closed rows (29.5%) carry a
  // net_pnl whose sign contradicts their own side/entry/exit. A row that
  // disagrees with itself is now marked, not silently averaged in.
  {
    const cols = new Set(db.prepare(`PRAGMA table_info(trades)`).all().map(c => c.name));
    if (!cols.has('realised_rr')) db.exec(`ALTER TABLE trades ADD COLUMN realised_rr REAL`);
    if (!cols.has('pnl_price_mismatch')) db.exec(`ALTER TABLE trades ADD COLUMN pnl_price_mismatch INTEGER`);
    // `exit_price_suspect` — the MAGNITUDE half of the same question, added
    // 08-08-2026. pnl_price_mismatch is a SIGN check, and a sign check cannot
    // see a row that points the right way and is wrong by a factor of fifty.
    // Because the exit-price repair in pnl-backfill.js only fired on the sign
    // flag, those rows were never re-fetched and stayed wrong permanently —
    // while realised R, the Phase 7 counterfactual and the early-trim shadow
    // all read them as fact. Written by services/exit-price-suspects.js, which
    // derives each symbol's money-per-point from the trades themselves and
    // needs no contract table to do it.
    if (!cols.has('exit_price_suspect')) db.exec(`ALTER TABLE trades ADD COLUMN exit_price_suspect INTEGER`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_risk_event ON trades(risk_event_id);
           CREATE INDEX IF NOT EXISTS idx_pending_risk_event ON pending_orders(risk_event_id);`);

  // §70.8 / §69.4.3 TERMINAL DISPOSITION. The lineage above answers "which row
  // did this approval produce" when there IS one. What it could not answer is
  // the case §70.8 is named after: an approval that produced NOTHING. Absence
  // is not a value, so it could only ever be inferred by subtraction, and
  // decision-audit.js's header records what that cost — "96 approved, 79
  // orders, 17 went nowhere" was wrong twice over before the arithmetic was
  // corrected, because the aggregate had no way to name a single row.
  //
  // `disposition` is that value, written by a sweep rather than guessed by a
  // reader. `submitted_at` is the other half: entry_latency_ms already timed
  // submit -> fill, and nothing timed VERDICT -> submit, which is precisely
  // the interval where an approval goes quiet.
  {
    const cols = new Set(db.prepare(`PRAGMA table_info(risk_events)`).all().map(c => c.name));
    if (!cols.has('disposition')) db.exec(`ALTER TABLE risk_events ADD COLUMN disposition TEXT`);
    if (!cols.has('disposition_at')) db.exec(`ALTER TABLE risk_events ADD COLUMN disposition_at TEXT`);
    if (!cols.has('submitted_at')) db.exec(`ALTER TABLE risk_events ADD COLUMN submitted_at TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_risk_events_disposition
             ON risk_events(disposition, created_at);`);

  // §70.8 OPPORTUNITY IDENTITY — the last missing primitive, and the one that
  // made the other two hard to read.
  //
  // Measured in production 05-08-2026 over 75 minutes: 500 risk-gate
  // evaluations resolved to 63 distinct account|symbol|side — a 7.9x
  // re-evaluation rate. Every scan cycle re-scores the same setup and writes
  // another row, so `approved` has never counted opportunities. It counts
  // evaluations, and subtracting a position count from it compares two
  // different units. That is how "276 approved, 59 opened, 217 went nowhere"
  // was produced — the same error shape as the earlier "96 approved, 79
  // orders, 17 went nowhere" recorded in decision-audit.js's header.
  //
  // The lineage column above answers "which row did this approval produce".
  // This one answers the question underneath it: "how many of these rows are
  // the same opportunity". See services/opportunity-identity.js for the rule.
  {
    const cols = new Set(db.prepare(`PRAGMA table_info(risk_events)`).all().map(c => c.name));
    if (!cols.has('opportunity_key')) db.exec(`ALTER TABLE risk_events ADD COLUMN opportunity_key TEXT`);
  }
  // The lookback is (symbol, side, account, newest-first) on every evaluation,
  // i.e. on the hot path. Without this index it is a scan of the whole audit
  // table per proposal.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_risk_events_opportunity
             ON risk_events(opportunity_key, created_at);
           CREATE INDEX IF NOT EXISTS idx_risk_events_lookback
             ON risk_events(symbol, side, account_id, created_at);`);

  // §70.9 P&L RECONCILIATION EVIDENCE. The backfill's "we tried and gave up"
  // record lived in a module-level Map keyed by ACCOUNT — so it was forgotten
  // on every restart, and this service redeploys on every push to main. The
  // evidence mark-unresolvable.js requires before writing a row off therefore
  // reset constantly, and a row nobody could ever fill kept blocking. These
  // columns make the record PER TRADE and durable: how many times the repair
  // has looked at this row, and when it last did.
  {
    const cols = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name));
    if (!cols.has('pnl_attempts')) db.exec('ALTER TABLE trades ADD COLUMN pnl_attempts INTEGER');
    if (!cols.has('pnl_last_attempt_at')) db.exec('ALTER TABLE trades ADD COLUMN pnl_last_attempt_at TEXT');
  }

  // Trade forensics (2026-07-24, Performance Ledger collect-forward): the
  // execution-quality and market-context fields the dashboard's trade
  // anatomy shows. Captured at fill time going FORWARD; historical rows stay
  // NULL and render as "—" — never fabricated.
  {
    const cols = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name));
    for (const [name, type] of [
      ['slippage_price', 'REAL'],      // signed, adverse-positive, price units
      ['spread_at_entry', 'REAL'],     // bid/ask spread when the order fired
      ['entry_latency_ms', 'INTEGER'], // submit → execution-event round trip
      ['commission', 'REAL'],          // broker commission (from deal history)
      ['swap', 'REAL'],                // swap/rollover cost (from deal history)
      ['rvol_open', 'REAL'],           // relative 1m volume at open
      ['vwap_side_open', 'TEXT'],      // 'above' | 'below' session VWAP at open
      ['obv_open', 'TEXT'],            // reserved (no OBV series helper yet)
      // L2 depth at entry (slice 2, 2026-07-24): sidecar book snapshot at
      // submit + size imbalance over the top levels. NULL until the operator
      // enables DEPTH_FEED_ENABLED on the sidecar — never fabricated.
      ['depth_json', 'TEXT'],
      ['depth_imbalance', 'REAL'],
    ]) {
      if (!cols.has(name)) db.exec(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
    }
  }

  // Now that all columns exist, create indexes
  db.exec(INDEXES);

  // -------------------------------------------------------------------------
  // Phase-flag trace (owner 01-08: "re-code how master-switch are ironclad …
  // setup a tracer"). setPhaseFlag() attributes every flip it makes — but an
  // attribution layer only sees writers that use it. These TRIGGERS sit under
  // the table itself, so every physical change to an S.A.T. key leaves a row
  // no matter who wrote it: setPhaseFlag, a raw setState, a raw UPDATE, or a
  // hand-typed sqlite3 command. A flip with a trace row and NO matching audit
  // row is the smoking gun the last two incidents never produced.
  // -------------------------------------------------------------------------
  // Telegram outbox — messages DEFERRED by quiet hours, the master mute or the
  // hourly digest, so they can be summarised and delivered later instead of
  // buzzing a phone at 03:00 SGT. `sent_at IS NULL` is the pending set; rows
  // are stamped only after the digest send resolves, so a Telegram outage
  // leaves the hour pending rather than swallowing it.
  // -------------------------------------------------------------------------
  db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_outbox (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    kind      TEXT NOT NULL DEFAULT 'alert',
    priority  TEXT NOT NULL DEFAULT 'normal',
    text      TEXT NOT NULL,
    reason    TEXT,
    sent_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tg_outbox_pending ON telegram_outbox(sent_at, id);
  `);

  db.exec(`
  CREATE TABLE IF NOT EXISTS phase_flag_trace (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_phase_trace_key_id ON phase_flag_trace(key, id DESC);
  CREATE TRIGGER IF NOT EXISTS trg_phase_flag_insert AFTER INSERT ON agent_state
  WHEN (NEW.key IN ('scan_enabled','analyze_enabled','autotrade_enabled')
     OR NEW.key GLOB 'acct:*:scan_enabled' OR NEW.key GLOB 'acct:*:analyze_enabled' OR NEW.key GLOB 'acct:*:autotrade_enabled')
  BEGIN
    INSERT INTO phase_flag_trace (key, old_value, new_value) VALUES (NEW.key, NULL, NEW.value);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_phase_flag_update AFTER UPDATE OF value ON agent_state
  WHEN (NEW.key IN ('scan_enabled','analyze_enabled','autotrade_enabled')
     OR NEW.key GLOB 'acct:*:scan_enabled' OR NEW.key GLOB 'acct:*:analyze_enabled' OR NEW.key GLOB 'acct:*:autotrade_enabled')
   AND OLD.value IS NOT NEW.value
  BEGIN
    INSERT INTO phase_flag_trace (key, old_value, new_value) VALUES (NEW.key, OLD.value, NEW.value);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_phase_flag_delete AFTER DELETE ON agent_state
  WHEN (OLD.key IN ('scan_enabled','analyze_enabled','autotrade_enabled')
     OR OLD.key GLOB 'acct:*:scan_enabled' OR OLD.key GLOB 'acct:*:analyze_enabled' OR OLD.key GLOB 'acct:*:autotrade_enabled')
  BEGIN
    INSERT INTO phase_flag_trace (key, old_value, new_value) VALUES (OLD.key, OLD.value, NULL);
  END;
  `);

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
// getState/setState are the hottest calls in the process — the stage matrix
// alone does ~6 reads per position per pass, and the 3-second fast-monitor tick
// re-reads them for every open position. Re-`prepare()`ing on every call means
// re-compiling the same two SQL strings hundreds of times a cycle for nothing.
//
// Keyed by the Database handle in a WeakMap so tests that open many short-lived
// DBs (there are dozens) don't accumulate statements, and so nothing has to be
// threaded through the callers.
const stateStmts = new WeakMap();

function stateStatements(db) {
  let cached = stateStmts.get(db);
  if (!cached) {
    cached = {
      get: db.prepare('SELECT value FROM agent_state WHERE key = ?'),
      set: db.prepare(
        'INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
    };
    stateStmts.set(db, cached);
  }
  return cached;
}

export function getState(db, key) {
  const row = stateStatements(db).get.get(key);
  return row ? row.value : null;
}

/**
 * Write a value into the agent_state key/value store (upsert).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string|null} value
 */
// ---------------------------------------------------------------------------
// S.A.T. write authority (owner 01-08: "re-code how master-switch are
// ironclad"). The pipeline flags may only be written through setPhaseFlag(),
// which attributes every flip. This choke point catches the writer class the
// audit trail cannot: code that calls setState directly on a phase key. The
// write still lands (a safety brake must never be blocked by its own
// bookkeeping) but it is logged as PHASE_RAW_WRITE with a captured JS stack —
// so an unattributed flip names its own caller.
// ---------------------------------------------------------------------------
const PHASE_KEY_RE = /^(?:acct:[^:]+:)?(?:scan_enabled|analyze_enabled|autotrade_enabled)$/;
let phaseWriteDepth = 0;
/** setPhaseFlag wraps its write in this; everything else is a raw write. */
export function withPhaseWriteAuthority(fn) {
  phaseWriteDepth++;
  try { return fn(); } finally { phaseWriteDepth--; }
}

export function setState(db, key, value) {
  if (phaseWriteDepth === 0 && PHASE_KEY_RE.test(key)) {
    try {
      const prev = getState(db, key);
      if (prev !== (value ?? null)) {
        const stack = String(new Error().stack || '').split('\n').slice(2, 8).join('\n');
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'PHASE_RAW_WRITE', `/phase/${key}`,
          JSON.stringify({ key, from: prev, to: value ?? null, at: new Date().toISOString(), stack }).slice(0, 2000),
        );
        console.warn(`[phase-trace] RAW write to ${key}: ${prev ?? 'unset'} → ${value ?? 'unset'} — not via setPhaseFlag; stack logged`);
      }
    } catch { /* tracing must never block the write */ }
  }
  stateStatements(db).set.run(key, value);
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
 * `newAccountId` (including legacy NULL rows) is swept.
 *
 * DO NOT use this for an account switch. It was the select-account handler's
 * sweep until 2026-07-28, and that is exactly how switching came to abandon
 * the previous account's open positions — closing their monitor rows stops
 * trailing, the loss cap, the ratchet and time caps while the positions are
 * still live at the broker. A switch must keep every account that still
 * holds exposure: see `accountsWithOpenPositions` below and the retain path
 * in /actions/ctrader-select-account.
 */
export function sweepMonitoredPositionsForAccount(db, newAccountId) {
  return sweepMonitoredPositionsForAccounts(db, [newAccountId]);
}

/**
 * Accounts that still have ACTIVE monitored positions — i.e. real money the
 * bot is currently looking after. Rows with a NULL account_id are excluded:
 * they cannot be attributed to anyone, so they are not evidence that some
 * particular account has exposure.
 *
 * Used by the account switch to decide which accounts must keep being
 * managed after you move on (owner 2026-07-28). Before this, switching
 * closed the old account's monitor rows outright, so trailing stops, the
 * per-position loss cap, the profit ratchet and time caps all stopped for
 * positions that were still open at the broker.
 */
export function accountsWithOpenPositions(db) {
  try {
    return db.prepare(
      `SELECT DISTINCT account_id FROM monitored_positions
        WHERE status = 'active' AND account_id IS NOT NULL`
    ).all().map(r => String(r.account_id));
  } catch {
    return [];
  }
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

  // GO-LIVE PHASE 0. Stamp realised R and the self-consistency verdict at the
  // moment of close, from whatever the row now holds. Done HERE rather than in
  // each caller because there are five of them and only one ever supplied an
  // exit price — the other four would have gone on writing rows nobody
  // checked. Best-effort: a bookkeeping column must never fail a close.
  if (info.changes > 0) {
    try {
      const row = db.prepare(
        `SELECT side, entry_price, exit_price, sl_price, net_pnl FROM trades WHERE id = ?`
      ).get(tradeId);
      if (row) {
        const rr = realisedRR(row);
        const check = checkTradeConsistency(row);
        db.prepare(
          `UPDATE trades SET realised_rr = ?, pnl_price_mismatch = ? WHERE id = ?`
        ).run(rr, check.decidable && !check.ok ? 1 : 0, tradeId);
      }
    } catch { /* never let a close fail over an audit column */ }
  }
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
