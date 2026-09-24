import Database from 'better-sqlite3';
import { openJournal } from './lib/wal-open.js';
import { maybeEmergencyReclaim } from './services/emergency-reclaim.js';
import { resetReverifyAttempts } from './services/reverify-reset.js';
// Leaf module — imports nothing, takes `db` as a parameter — so this cannot
// cycle back into db.js. See closeTradeRow for why the stamp lives here.
import { stampRealisedAudit } from './services/trade-consistency.js';

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
    -- PR-J (11-09-2026): when the time cap was reached on a position that was
    -- IN PROFIT and therefore trailed instead of closed. Stamped once; its
    -- presence is what stops the cap branch being re-decided every cycle.
    time_cap_trail_at     TEXT,
    -- PR-J: when the +1R take banked its fraction. One partial per position at
    -- that trigger, ever — without it the remainder is re-banked every pass.
    bank_partial_at       TEXT,
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

  -- Momentum SHADOW (owner "do ¶A·5", 02-09-2026): the cross-sectional
  -- ranking's would-be entries, exits and refusals. applied is 0 on every
  -- row by construction — nothing here is proposed to the gate or traded.
  CREATE TABLE IF NOT EXISTS momentum_shadow (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    action       TEXT NOT NULL,   -- 'enter' | 'exit' | 'refused'
    side         TEXT,            -- 'long' | 'short'
    rank_pct     REAL,            -- 0 weakest … 1 strongest, at this pass
    conviction   INTEGER,         -- 0–10 from rank strength on the side
    price        REAL,            -- last close at this pass
    entry_price  REAL,            -- exit rows: the shadow entry's close
    ret_pct      REAL,            -- exit rows: signed return, fraction
    hold_ms      INTEGER,         -- exit rows
    reason       TEXT,            -- exit band crossed / refusal reason
    timeframe    TEXT,
    universe     INTEGER,         -- names ranked this pass
    applied      INTEGER NOT NULL DEFAULT 0,
    loop_id      INTEGER,
    at           TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_momentum_shadow_at ON momentum_shadow(at);

  -- Momentum BOOK positions (owner order 03-09-2026): the long-only
  -- time-series momentum positions the book opened from the shadow's
  -- ranking and manages itself (trailing stop ratchet, exit on rank). The
  -- manager is PAUSED on these rows (monitored_positions.paused = 1); the
  -- broker always holds the stop.
  CREATE TABLE IF NOT EXISTS momentum_book (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id     INTEGER,
    account_id   TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    position_id  TEXT,
    side         TEXT NOT NULL DEFAULT 'long',
    entry_price  REAL,
    stop         REAL,
    -- The LAST ATR the trail computed for this row, and when it last ran.
    -- Both are written on EVERY pass that reaches the computation, not only
    -- on a pass that moved the stop (PR-AV). Before that they were written
    -- inside the trailImproves branch only, so a row whose 3-ATR trail sat
    -- wider than its current stop -- the correct, common case -- kept a NULL
    -- atr for ever and read exactly like a row the trail never reached.
    atr          REAL,
    trail_checked_at TEXT,
    trail_note   TEXT,            -- why the stop did not move, in the operator's words
    entry_rank   REAL,
    entered_at   TEXT NOT NULL,
    exited_at    TEXT,
    status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'exit_sent' | 'closed'
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_momentum_book_status ON momentum_book(status, account_id);

  -- §7,437·B·4 (08-09-2026): the plan at entry, scored at close. One row per
  -- trade, written with the intent row; nothing on trades survives as "what
  -- we meant" once the fill anchor, the trail and the book have written over
  -- it. Scored columns fill at close.
  CREATE TABLE IF NOT EXISTS trade_plans (
    trade_id         INTEGER PRIMARY KEY,
    account_id       TEXT,
    symbol           TEXT NOT NULL,
    side             TEXT NOT NULL,
    strategy         TEXT,
    family           TEXT,
    timeframe        TEXT,
    planned_entry    REAL,
    planned_sl       REAL,
    planned_tp       REAL,
    planned_r        REAL,
    risk_dist        REAL,
    planned_hold_min INTEGER,
    exit_rule        TEXT,
    source           TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    scored_at        TEXT,
    entry_slippage_r REAL,
    realised_r       REAL,
    hold_min         INTEGER,
    hold_vs_plan     REAL,
    exit_reason      TEXT,
    exit_matched     INTEGER,
    score_note       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trade_plans_scored ON trade_plans(scored_at);

  -- §7,437·B·2 (08-09-2026): what each refused opportunity would have done.
  -- One row per risk_events.opportunity_key, scored against broker bars
  -- after the setup's horizon elapsed. Kept 180 days — longer than the
  -- risk_events rows it summarises, which prune at 90.
  CREATE TABLE IF NOT EXISTS refusal_scores (
    opportunity_key TEXT PRIMARY KEY,
    account_id      TEXT,
    symbol          TEXT NOT NULL,
    side            TEXT,
    strategy        TEXT,
    timeframe       TEXT,
    reason_key      TEXT,
    reason          TEXT,
    entry           REAL,
    sl              REAL,
    tp              REAL,
    first_at        TEXT,
    last_at         TEXT,
    refusals        INTEGER,
    horizon_min     INTEGER,
    scored_at       TEXT,
    outcome         TEXT,   -- target | stop | stop_moved | time_cap | ambiguous | truncated | no_bars | unscorable | fetch_failed
    r_reached       REAL,
    exit_at         TEXT,
    bars_used       INTEGER,
    note            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_refusal_scores_reason ON refusal_scores(reason_key, scored_at);

  -- Account Registry (multi-account migration plan, Phase 1 R1 / milestone
  -- M0). Single source of truth for which cTrader accounts exist and which
  -- may trade. account_id is cTrader's INTERNAL ctidTraderAccountId (the
  -- one every API call takes); trader_login is the human-facing number the
  -- cTrader app shows (e.g. LOGIN-1, LOGIN-5). In M0 exactly ONE row is
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

  -- PR-S (17-09-2026): WHO armed or disarmed a strategy cell, and WHY.
  -- The overlay cell is a bare boolean, so on 17-09 the question "why is
  -- tsmom_long not armed on three accounts" had no answer that outlived the
  -- log window. Written by services/arming-log.js from stage-matrix.js's
  -- single write chokepoint; only writes that CHANGED a cell become rows
  -- (plus decision='held' rows, where an owner pin blocked a disarm — that is
  -- a decision too). Never blocks the write it describes.
  CREATE TABLE IF NOT EXISTS arming_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    scope        TEXT NOT NULL,   -- 'global' | account id
    kind         TEXT NOT NULL,   -- 'strategy' | 'filter'
    key          TEXT NOT NULL,   -- strategy or filter key
    stage        TEXT NOT NULL,   -- scan | backtest | trade | manage
    from_value   TEXT NOT NULL,   -- 'true' | 'false' | 'unset' — an absent cell is not a false one
    to_value     TEXT NOT NULL,
    decision     TEXT NOT NULL,   -- 'set' | 'held' (a pin outvoted a disarm verdict)
    actor        TEXT NOT NULL,   -- see ARMING_ACTORS; an unlisted actor is recorded and reported
    reason       TEXT,
    evidence_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_arming_log_cell ON arming_log(scope, kind, key, stage, id DESC);

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
  -- The C++ sidecar's decisions, pulled from its in-memory ring on every
  -- health probe and made durable HERE (2026-08-31 supervision plan,
  -- invariant 1). The sidecar keeps no DB — it holds the newest ~256
  -- records in memory and Node owns memory. Typed columns rather than
  -- action_log's schemaless bag because the log inspector needs cheap SQL
  -- predicates over component/kind/code. UNIQUE(side, boot_id, seq) makes
  -- the pull idempotent (INSERT OR IGNORE); a boot_id change marks a
  -- sidecar restart. Pruned at 90 days with the other decision sinks.
  CREATE TABLE IF NOT EXISTS cpp_decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    side       TEXT NOT NULL,           -- 'cpp_exec' | 'cpp_exec_demo' | single-sidecar name
    boot_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    ts_ms      INTEGER,                 -- the sidecar's own clock at the decision
    component  TEXT NOT NULL,           -- order_guard | engine | trail | spot_feed | vpo | guard | node
    kind       TEXT NOT NULL,           -- refused | order_submit | order_result | amend_fail | ...
    account_id TEXT,
    symbol_id  INTEGER,
    code       TEXT,
    detail     TEXT,
    UNIQUE(side, boot_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_cpp_decisions_at ON cpp_decisions(at);
  CREATE INDEX IF NOT EXISTS idx_cpp_decisions_kind ON cpp_decisions(component, kind);

  -- P2a (docs/tick-momentum/plan.md §9, 11-09-2026): the durable entry-intent
  -- ledger — the consumption authority for one-use execution permits. One
  -- row per attempt to open new risk; RESERVED → DISPATCHING (redeemed once)
  -- → SENT → ACCEPTED | FILLED | REJECTED, or UNKNOWN when the send's outcome
  -- was never learned — which survives a restart and blocks a resend on the
  -- same account/symbol/side until the broker's evidence resolves it.
  CREATE TABLE IF NOT EXISTS entry_intents (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL,
    environment       TEXT NOT NULL,      -- 'demo' | 'live'
    symbol            TEXT,
    symbol_id         INTEGER,
    side              TEXT NOT NULL,      -- BUY | SELL
    order_type        TEXT,
    volume            REAL,
    sl                REAL,
    tp                REAL,
    producer_id       TEXT NOT NULL,
    basis             TEXT NOT NULL,
    signal_ref        TEXT,
    mode_epoch        INTEGER NOT NULL,
    config_revision   INTEGER,
    permit_id         TEXT NOT NULL UNIQUE,
    permit_expires_at TEXT NOT NULL,
    state             TEXT NOT NULL,      -- RESERVED|DISPATCHING|SENT|ACCEPTED|FILLED|REJECTED|UNKNOWN|RELEASED|EXPIRED
    gateway_instance  TEXT,
    sidecar_boot_id   TEXT,
    client_msg_id     TEXT,
    broker_order_id   TEXT,
    broker_position_id TEXT,
    error_code        TEXT,
    resolution_source TEXT,               -- response | event | reconcile | ring | timeout | operator | epoch
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entry_intents_open ON entry_intents(account_id, state);
  CREATE INDEX IF NOT EXISTS idx_entry_intents_key ON entry_intents(account_id, symbol_id, side, state);

  -- P2b-1: the sidecar's execution-event journal, pulled like cpp_decisions.
  -- A late answer to a request that gave up, or an unsolicited fill, lands
  -- here and settles the intent that was marked UNKNOWN.
  CREATE TABLE IF NOT EXISTS cpp_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             TEXT NOT NULL DEFAULT (datetime('now')),
    side           TEXT NOT NULL,
    boot_id        TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    ts_ms          INTEGER,
    client_msg_id  TEXT,
    payload_type   INTEGER,
    execution_type TEXT,
    order_id       TEXT,
    position_id    TEXT,
    account_id     TEXT,
    symbol_id      INTEGER,
    error_code     TEXT,
    label          TEXT,
    solicited      INTEGER,
    UNIQUE(side, boot_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_cpp_events_msg ON cpp_events(client_msg_id);
  CREATE INDEX IF NOT EXISTS idx_cpp_events_label ON cpp_events(label);

  -- P3b: one row per side per hour from the sidecar's /tick-status, so the
  -- recorder's real events/sec and bytes/day are measured over a day, not
  -- read off a model (docs/tick-momentum/storage-capacity.csv is
  -- SCENARIO_NOT_MEASURED until these rows exist).
  -- P4: the versioned trial ledger (plan §6-§7): every replay run, its
  -- profile hash, data manifest, costs and block results — failures and
  -- abandoned variants included. The evidence importer (P6) reads it.
  CREATE TABLE IF NOT EXISTS tick_trials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL DEFAULT (datetime('now')),
    trial_id      TEXT NOT NULL UNIQUE,
    strategy_id   TEXT NOT NULL,
    version       TEXT NOT NULL,
    profile_hash  TEXT NOT NULL,
    params_json   TEXT NOT NULL,
    sim_json      TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    summary_json  TEXT NOT NULL,
    blocks_json   TEXT NOT NULL,
    note          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tick_trials_profile ON tick_trials(profile_hash);

  CREATE TABLE IF NOT EXISTS tick_status_samples (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    side      TEXT NOT NULL,
    at_ms     INTEGER NOT NULL,
    state     TEXT,
    recording INTEGER,
    events    INTEGER,
    changed   INTEGER,
    dropped   INTEGER,
    gaps      INTEGER,
    bytes_written INTEGER,
    sealed    INTEGER,
    avail_bytes INTEGER,
    symbols   INTEGER,
    per_symbol TEXT,
    UNIQUE(side, at_ms)
  );
  -- P6a: the shadow portfolio's closed trades, pulled from the sidecar's
  -- ledger (POST /tick-shadow) per side. Prices in the feed's wire units,
  -- results in R; the keeper sizes each account's projection from its own
  -- risk budget at read time. UNIQUE(side, boot_id, seq) makes the pull
  -- idempotent across probes and restarts.
  CREATE TABLE IF NOT EXISTS tick_shadow_trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL DEFAULT (datetime('now')),
    side          TEXT NOT NULL,
    boot_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    symbol_id     INTEGER,
    profile_hash  TEXT,
    trade_side    TEXT,
    signal_seq    INTEGER,
    entry_seq     INTEGER,
    exit_seq      INTEGER,
    entry         REAL,
    exit          REAL,
    stop          REAL,
    target        REAL,
    stop_distance REAL,
    reason        TEXT,
    hold_events   INTEGER,
    hold_ms       INTEGER,
    entry_ms      INTEGER,
    exit_ms       INTEGER,
    gross_r       REAL,
    net_r         REAL,
    -- PR-L (16-09-2026): the cost model THIS trade was charged, carried from
    -- the sidecar's ledger. NULL/0 on every row written before PR-L, which is
    -- the truth about them: they were closed spread-only. The shadow view's
    -- sensitivity line strips this back off before re-pricing, so a trade can
    -- never be charged twice or read as if it were closed under another model.
    cost_class    TEXT,
    commission_wire REAL,
    commission_bps REAL,
    slippage_wire REAL,
    slippage_bps  REAL,
    UNIQUE(side, boot_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_tick_shadow_side_profile ON tick_shadow_trades(side, profile_hash, exit_ms);

  -- §2 PR-2a: the ACCOUNT EXECUTION SIMULATION, beside the shared one.
  --
  -- tick_shadow_trades above is the SHARED MARKET-SIGNAL record: one row per
  -- shadow trade, no account column, and it deliberately stays that way. This
  -- table is the other half — for each shared trade and each enabled account,
  -- whether THAT account could actually have executed it under its own
  -- balance, risk budget, drawdown de-risk, minimum lot, lot increment,
  -- margin, existing exposure, open/pending intents and position cap.
  --
  -- A REFUSED SIGNAL IS A ROW, NEVER A DROPPED ONE: executed = 0 with a
  -- first-class reason, which is what makes "why could this account not take
  -- a signal the market gave" answerable instead of invisible.
  --
  -- THE COUNTING RULE. Rows here are EXECUTIONS OF SHARED OBSERVATIONS, not
  -- observations. The evidence count is the number of distinct
  -- shadow_trade_id values; summing rows across accounts multiplies one
  -- observation by the number of accounts and manufactures independent
  -- evidence that does not exist. services/tick-shadow-accounts.js enforces
  -- this and its test pins it by name.
  CREATE TABLE IF NOT EXISTS tick_shadow_account_fills (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    at               TEXT NOT NULL DEFAULT (datetime('now')),
    shadow_trade_id  INTEGER NOT NULL,
    account_id       TEXT NOT NULL,
    side             TEXT,
    profile_hash     TEXT,
    symbol_id        INTEGER,
    symbol           TEXT,
    executed         INTEGER NOT NULL,
    reason           TEXT,              -- NULL when executed; see REFUSAL_REASONS
    lots             REAL,
    lot_step         REAL,
    min_lots         REAL,
    risk_budget_usd  REAL,              -- after the drawdown de-risk AND the shared-signal split
    dd_factor        REAL,
    shared_split     REAL,
    usd_per_r        REAL,              -- the $ a 1R loss costs at the SIZED lots
    margin_required_usd REAL,
    margin_used_usd  REAL,
    margin_cap_usd   REAL,
    commission_usd   REAL,              -- size-aware, both sides (PR-2b)
    gross_usd        REAL,
    net_usd          REAL,
    net_r            REAL,
    cost_class       TEXT,
    cost_basis       TEXT,              -- per_share_with_minimum | per_lot | bps_of_notional | zero
    schedule_hash    TEXT,
    UNIQUE(shadow_trade_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tick_shadow_fills_acct ON tick_shadow_account_fills(account_id, executed, reason);

  -- Immutable, dated current-conditions scenarios. Legacy fill rows above are
  -- the latest projection cache, never historical execution evidence.
  CREATE TABLE IF NOT EXISTS tick_shadow_account_scenarios (
    scenario_id TEXT PRIMARY KEY,
    captured_at TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  );

  -- Speech-act inspection findings (owner invariants 2-4, 31-08-2026): what
  -- each log SAID vs what it was DOING, the principlised next action, and a
  -- falsifier with a deadline. The PARTIAL UNIQUE index is the anti-noise
  -- mechanism — one LIVE finding per subject, structurally (the
  -- 32,115-identical-alerts lesson applied to the inspector itself).
  -- Terminal rows (confirmed/falsified/expired) prune at 90d; live rows
  -- never age out — a proposal does not expire because the owner was busy.
  CREATE TABLE IF NOT EXISTS inspection_findings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    at               TEXT NOT NULL DEFAULT (datetime('now')),
    source           TEXT NOT NULL,
    subject_key      TEXT NOT NULL,
    speech_act       TEXT NOT NULL,   -- assertion|directive|commissive|declaration|refusal
    said             TEXT NOT NULL,
    doing            TEXT NOT NULL,
    finding          TEXT NOT NULL,
    principle_kind   TEXT NOT NULL,   -- code_change|strategy_tweak|timing_change|none
    principle_params TEXT,
    falsifier        TEXT NOT NULL,   -- JSON {prediction, metric, deadlineMs}
    status           TEXT NOT NULL DEFAULT 'open', -- open|auto_applied|proposed|confirmed|falsified|expired
    resolved_at      TEXT,
    resolution       TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_live
    ON inspection_findings(subject_key) WHERE status IN ('open','auto_applied','proposed');

  -- The decision audit's verdict SERIES (it kept only one overwritten state
  -- key, so "how often was the pipeline blocked last week" was unanswerable).
  -- One row per verdict change or per hour; 90d prune.
  CREATE TABLE IF NOT EXISTS decision_audit_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    verdict      TEXT NOT NULL,
    because      TEXT,
    considered   INTEGER, approved INTEGER, vetoed INTEGER, landed INTEGER,
    silent_drops INTEGER, top_block TEXT
  );

  -- Nightly mark-to-market equity per account (first-principles audit
  -- 19-09-2026 §K item 11): balance + the broker's net unrealised P&L, one
  -- row per enabled account per pass, null fields with the error on a night
  -- the broker did not answer. The equity curve the momentum checkpoint is
  -- judged on reads this, not the per-minute panels.
  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             TEXT NOT NULL,
    account_id     TEXT NOT NULL,
    balance_usd    REAL,
    open_pnl_usd   REAL,
    equity_usd     REAL,
    open_positions INTEGER,
    error          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_equity_snapshots_acct_at ON equity_snapshots(account_id, at);

  -- Revision 3 P5d: native observations and independently dated cashflow coverage.
  CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, host TEXT NOT NULL,
    source TEXT NOT NULL, bucket_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL, observation_json TEXT NOT NULL,
    UNIQUE(account_id, host, source, bucket_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_account_history_account_time ON account_history(account_id, received_ms);
  CREATE TABLE IF NOT EXISTS account_cashflows (
    account_id TEXT NOT NULL, host TEXT NOT NULL, event_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
    currency TEXT NOT NULL, delta REAL NOT NULL, operation_type INTEGER NOT NULL, kind TEXT NOT NULL,
    received_ms INTEGER NOT NULL, PRIMARY KEY(account_id, host, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_account_cashflows_account_time ON account_cashflows(account_id,host,at_ms);
  CREATE TABLE IF NOT EXISTS account_cashflow_windows (
    account_id TEXT NOT NULL, host TEXT NOT NULL, currency TEXT NOT NULL,
    from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
    PRIMARY KEY(account_id,host,currency,from_ms,to_ms)
  );

  -- Backtest→live divergence tracker (owner "plan #1", 02-09-2026).
  -- combo_arms: the EVIDENCE a combo was armed on, snapshotted at arm time —
  -- the arm decision used to record nothing about which verdict justified
  -- it, so "armed on evidence X, traded like Y" was unanswerable. Manual
  -- arms get a row with NULL bt_* (armed without evidence — shown, not hidden).
  CREATE TABLE IF NOT EXISTS combo_arms (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    armed_at        TEXT NOT NULL DEFAULT (datetime('now')),
    kind            TEXT NOT NULL,      -- strategy | matrix | pending | manual
    strategy        TEXT,
    symbol          TEXT,
    timeframe       TEXT,
    entry_mode      TEXT,
    bt_pf           REAL,
    bt_win_rate_pct REAL,
    bt_trades       INTEGER,
    bt_wf_positive  INTEGER,
    bt_wf_active    INTEGER,
    bar_min_pf      REAL,
    bar_min_win     REAL,
    bar_min_trades  INTEGER,
    disarmed_at     TEXT,
    disarm_reason   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_combo_arms_open ON combo_arms(strategy, symbol, timeframe, disarmed_at);

  -- autopilot_verdicts: a BOUNDED verdict history. Only the last sweep used
  -- to survive (autopilot_last_verdicts_json, overwritten every 10-30 min),
  -- and backtest_runs is pruned to 2,000 rows on every manual write — so a
  -- full sweep (~1,900 verdicts) cannot live there. Per sweep this keeps
  -- only the verdicts that clear the arm bar or concern an armed combo.
  CREATE TABLE IF NOT EXISTS autopilot_verdicts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at       TEXT NOT NULL DEFAULT (datetime('now')),
    strategy     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    timeframe    TEXT NOT NULL,
    entry_mode   TEXT,
    state        TEXT,
    trades       INTEGER,
    pf           REAL,
    win_rate_pct REAL,
    wf_positive  INTEGER,
    wf_active    INTEGER,
    armable      INTEGER               -- 1 = cleared the arm bar in force at that sweep
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_verdicts_combo ON autopilot_verdicts(strategy, symbol, timeframe, ran_at);

  -- autopilot_sweep_hist (02-09-2026): ONE small row per sweep, binned over
  -- ALL verdicts — autopilot_verdicts keeps only bar-clearing or armed ones,
  -- so no base rate existed for a shrinkage prior. Bins are fixed (see
  -- divergence.js SWEEP_HIST_BINS); counts are stored as JSON arrays in bin
  -- order. Pruned to 90 days by loop.js housekeeping. The shrinkage prior
  -- (strategy-autopilot.js sweepShrinkPrior, #816) is computed from the
  -- sweep's own verdicts in memory, not read back from this table — this
  -- table is the base rate the report shows, not the prior's input.
  CREATE TABLE IF NOT EXISTS autopilot_sweep_hist (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sweep_at  TEXT NOT NULL DEFAULT (datetime('now')),
    combos    INTEGER NOT NULL,         -- verdicts in the sweep (all states)
    pf_bins   TEXT NOT NULL,            -- JSON [n] per PF bin; verdicts with no finite PF are NOT binned
    wr_bins   TEXT NOT NULL,            -- JSON [n] per win-rate bin
    n_bins    TEXT NOT NULL             -- JSON [n] per trade-count bin
  );

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
  -- The watchdog counts account dispatches with mixed SQLite/ISO timestamps.
  -- Keep julianday's exact boundary semantics, but seek only this account's
  -- dispatch receipts instead of scanning every retained scan/skip decision.
  CREATE INDEX IF NOT EXISTS idx_decision_log_dispatch_account
    ON decision_log(account_id, created_at) WHERE stage='dispatch' AND decision='proceed';
  -- Account status needs one latest receipt, not a GROUP BY over all retained
  -- history. Equal timestamps keep the first row id, as the old table scan did.
  CREATE INDEX IF NOT EXISTS idx_decision_log_account_latest
    ON decision_log(account_id, created_at DESC) WHERE account_id IS NOT NULL;
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
  CREATE INDEX IF NOT EXISTS idx_risk_events_account_latest
    ON risk_events(account_id, created_at DESC) WHERE account_id IS NOT NULL;
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
  // WHOLE-PLAN AUDIT 11-09-2026 (plan §11, TM-26): the intent ledger and the
  // permits it issues are only as durable as the journal's sync. NORMAL
  // can lose the last transactions on power loss — an intent RESERVED or
  // SENT that the restart never sees. FULL, pinned by db-pragmas.test.js.
  db.pragma('synchronous = FULL');
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
    // PR-J exit-asymmetry stamps — see the CREATE TABLE above.
    ['time_cap_trail_at',    'TEXT'],
    ['bank_partial_at',      'TEXT'],
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

  // momentum_book: the trail's own record of its last run, for DBs created
  // before PR-AV. Without these a reader cannot tell "the ratchet has never
  // reached this row" from "the ratchet ran and correctly declined to move a
  // stop already tighter than 3 ATRs" -- the two conditions that `atr NULL`
  // collapsed into one.
  const mbColNames = new Set(db.prepare("PRAGMA table_info(momentum_book)").all().map(c => c.name));
  for (const [col, type] of [['trail_checked_at', 'TEXT'], ['trail_note', 'TEXT']]) {
    if (!mbColNames.has(col)) db.exec(`ALTER TABLE momentum_book ADD COLUMN ${col} ${type}`);
  }

  // controller_heartbeats: the controller's own account of its last run
  // (heartbeat.js beat() `detail`), for pre-existing DBs created before the
  // column existed. Guarded like the migrations above.
  const hbColNames = new Set(db.prepare("PRAGMA table_info(controller_heartbeats)").all().map(c => c.name));
  if (!hbColNames.has('last_detail_json')) {
    db.exec('ALTER TABLE controller_heartbeats ADD COLUMN last_detail_json TEXT');
  }

  const equityHistoryCols = new Set(db.prepare('PRAGMA table_info(equity_snapshots)').all().map(c => c.name));
  for (const [name, type] of [['currency','TEXT'], ['broker_host','TEXT'], ['balance_received_at','TEXT'], ['pnl_received_at','TEXT']]) {
    if (!equityHistoryCols.has(name)) db.exec(`ALTER TABLE equity_snapshots ADD COLUMN ${name} ${type}`);
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

  // PR-L (16-09-2026): the shadow ledger's per-trade cost provenance on an
  // existing database. The 236 trades already recorded stay NULL — they were
  // closed under commission 0 / slippage 0 and must keep saying so.
  try {
    const shadowCols = new Set(db.prepare(`PRAGMA table_info(tick_shadow_trades)`).all().map(c => c.name));
    for (const [col, type] of [['cost_class', 'TEXT'], ['commission_wire', 'REAL'], ['commission_bps', 'REAL'], ['slippage_wire', 'REAL'], ['slippage_bps', 'REAL']]) {
      if (!shadowCols.has(col)) db.exec(`ALTER TABLE tick_shadow_trades ADD COLUMN ${col} ${type}`);
    }
  } catch { /* table absent on an old schema */ }

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
    // 02-09-2026 (predict-vs-actual audit). Two facts the ledger threw away:
    //
    // `proposal_entry_price` — the price the signal INTENDED. entry_price
    // held it only until the broker fill was reconciled over it, so once
    // the fill arrived the proposal was gone and `slippage_price` — which
    // keys off an executionPrice the sidecar rarely returns — stayed NULL on
    // 100 of 100 rows although the two numbers it needs both existed at
    // different times. Kept, so slippage is computable after the fact.
    //
    // `broker_sl_initial` — the stop as the BROKER first held it. sl_price is
    // the proposal's stop; the broker re-anchors the stop to the fill, so on
    // 5 of 5 day-one trades the stop that actually existed differed from the
    // stored one and realised R read up to 2R off. Stamped once from the
    // fill ACK or the first reconcile pass before any break-even move.
    if (!cols.has('proposal_entry_price')) db.exec(`ALTER TABLE trades ADD COLUMN proposal_entry_price REAL`);
    if (!cols.has('broker_sl_initial')) db.exec(`ALTER TABLE trades ADD COLUMN broker_sl_initial REAL`);
  }
  // 02-09-2026 (owner plan): the position-event journal carries the
  // MANAGEMENT STATE explicitly — the state the position was in before the
  // event and the state the event moved it to — so the lifecycle sequence
  // (opened → be_moved → scaled_out → trail_* → exit) is a query, not a
  // reconstruction, when a state-conditioned model is worth fitting.
  {
    const cols = new Set(db.prepare(`PRAGMA table_info(position_events)`).all().map(c => c.name));
    if (!cols.has('state_from')) db.exec(`ALTER TABLE position_events ADD COLUMN state_from TEXT`);
    if (!cols.has('state_to')) db.exec(`ALTER TABLE position_events ADD COLUMN state_to TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_risk_event ON trades(risk_event_id);
           CREATE INDEX IF NOT EXISTS idx_pending_risk_event ON pending_orders(risk_event_id);
           CREATE INDEX IF NOT EXISTS idx_position_events_trade ON position_events(trade_id, id);`);

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

  // PR-C REPEAT VETOES (owner principle 7, 11-09-2026). A setup re-scored
  // eight times by the scanner and refused eight times for the same reason
  // used to be eight rows. persistRiskEvent now bumps `repeat_count` and
  // `last_at` on the newest row of the same opportunity_key when the reason
  // head is unchanged and the row is younger than VETO_REPEAT_WINDOW_MS
  // (risk.js). `created_at` remains the first sighting. Additive: existing
  // rows read as repeat_count 1 / last_at NULL, so every SUM(repeat_count)
  // reader equals the old COUNT(*) on un-merged history.
  {
    const cols = new Set(db.prepare(`PRAGMA table_info(risk_events)`).all().map(c => c.name));
    if (!cols.has('repeat_count')) db.exec(`ALTER TABLE risk_events ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1`);
    if (!cols.has('last_at')) db.exec(`ALTER TABLE risk_events ADD COLUMN last_at TEXT`);
  }

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

  // ---------------------------------------------------------------------------
  // POSITION HISTORY (owner, 17-09-2026): one complete record per CLOSED
  // position, joining what the bot decided, what it did while the position
  // was open, and what the broker finally reported — so "what worked and what
  // did not" can be answered from this repository instead of by downloading a
  // statement per account.
  //
  // WHY A NEW TABLE RATHER THAN MORE COLUMNS ON `trades`. Every existing
  // reader of `trades` (perf-ledger, edge-health, the metrics snapshot, the
  // lessons tuner) counts rows without filtering on source — the same reason
  // `broker_deals` is kept separate. This table is derived and additive: it
  // is rebuilt from its sources and nothing keys risk off it.
  //
  // COMPLETENESS IS A GATE, NOT A COERCION (the owner's rule: no null field).
  // A record missing any required field does NOT land here with blanks — it
  // goes to `position_history_incomplete` with `missing_json` naming every
  // field that was absent and why the gate refused. Two streams, so a query
  // over this table is a query over records that are actually whole, and the
  // refused ones stay visible instead of being silently dropped or filled in.
  //
  // `verification_state` is cpp-verify's answer, never ours:
  //   unverified — not checked yet, or the broker fetch was incomplete
  //   verified   — every field agreed with the broker's own deals
  //   disputed   — at least one field disagreed; `disputes_json` names which
  //   absent     — the broker reports no such position in the window
  // It is written only by the verifier's reply, so a record cannot certify
  // itself. Nothing here is recomputed from a price move: the broker's
  // figures are copied.
  db.exec(`
  CREATE TABLE IF NOT EXISTS position_history (
    account_id          TEXT NOT NULL,
    ctrader_position_id TEXT NOT NULL,
    symbol              TEXT NOT NULL,
    symbol_id           INTEGER,
    trade_id            INTEGER,

    -- WHAT THE BOT DECIDED, at entry
    direction           TEXT NOT NULL,
    direction_reason    TEXT NOT NULL,
    strategy            TEXT NOT NULL,
    family              TEXT,
    timeframe           TEXT,
    origin              TEXT NOT NULL,
    risk_event_id       INTEGER,
    conviction          REAL,
    planned_entry       REAL NOT NULL,
    planned_sl          REAL NOT NULL,
    planned_tp          REAL,
    planned_r           REAL,
    risk_dist           REAL NOT NULL,
    planned_hold_min    INTEGER,
    exit_rule           TEXT,

    -- WHAT THE BROKER REPORTED (copied, never recomputed)
    entry_price         REAL NOT NULL,
    exit_price          REAL NOT NULL,
    volume              REAL NOT NULL,
    requested_volume    REAL,               -- C·4: what was asked for; never the fill
    opened_at_ms        INTEGER NOT NULL,
    closed_at_ms        INTEGER NOT NULL,
    hold_ms             INTEGER NOT NULL,
    gross_pnl           REAL NOT NULL,
    commission          REAL NOT NULL,
    swap                REAL NOT NULL,
    net_pnl             REAL NOT NULL,
    realised_r          REAL NOT NULL,

    -- WHAT HAPPENED WHILE IT WAS OPEN
    close_reason        TEXT NOT NULL,
    sl_moves            INTEGER NOT NULL,
    tp_moves            INTEGER NOT NULL,
    scale_outs          INTEGER NOT NULL,
    events_json         TEXT NOT NULL,

    -- PROVENANCE AND VERIFICATION
    sources_json        TEXT NOT NULL,   -- which table each group came from
    verification_state  TEXT NOT NULL DEFAULT 'unverified'
                          CHECK(verification_state IN ('unverified','verified','disputed','absent')),
    verified_at         TEXT,
    verifier_host       TEXT,
    -- PR-AY: the contract version that produced this verdict. NULL means the
    -- verdict predates the stamp, which is stale, not current. The backlog
    -- re-asks anything judged under an older contract, so a fix to the
    -- comparison can reach the records its predecessor got wrong.
    verifier_version    INTEGER,
    disputes_json       TEXT,

    built_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (account_id, ctrader_position_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pos_hist_closed ON position_history(closed_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_pos_hist_verify ON position_history(verification_state, closed_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_pos_hist_strategy ON position_history(strategy, closed_at_ms DESC);

  -- The refused stream. Same identity, no pretence of completeness: whatever
  -- was built is kept as JSON so the gap is inspectable, and missing_json
  -- says exactly which required fields were absent. A record here is a
  -- MEASUREMENT of what this system cannot yet record about its own trades.
  CREATE TABLE IF NOT EXISTS position_history_incomplete (
    account_id          TEXT NOT NULL,
    ctrader_position_id TEXT NOT NULL,
    symbol              TEXT,
    closed_at_ms        INTEGER,
    missing_json        TEXT NOT NULL,
    partial_json        TEXT NOT NULL,
    built_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (account_id, ctrader_position_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pos_hist_inc_closed ON position_history_incomplete(closed_at_ms DESC);
  `);

  // THE CLOSE-TRIGGERED CAPTURE QUEUE (owner, 17-09-2026: "every position
  // close, and after 30 seconds should have the whole closed position
  // history"). A close is detected by the reconciler; the record cannot be
  // built at that instant because the broker's deal history needs a moment to
  // settle, so the position is ENQUEUED with a due time and drained later.
  //
  // WHY A TABLE AND NOT A setTimeout. A timer dies with the process. A
  // position closed 20 seconds before a redeploy would simply never be
  // captured, and nothing would say so — the failure would look identical to
  // a position that was captured fine. The queue is durable, it survives a
  // restart, and a row that keeps failing stays visible with its last error
  // rather than disappearing.
  //
  // `state` is the honest part: `gave_up` rows are NOT deleted. A capture
  // this system could not complete is a fact worth counting, and deleting it
  // would make the queue look permanently healthy.
  db.exec(`
  CREATE TABLE IF NOT EXISTS position_capture_queue (
    account_id   TEXT NOT NULL,
    position_id  TEXT NOT NULL,
    symbol       TEXT,
    due_at_ms    INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    state        TEXT NOT NULL DEFAULT 'pending'
                   CHECK(state IN ('pending','captured','gave_up')),
    last_error   TEXT,
    enqueued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    settled_at   TEXT,
    PRIMARY KEY (account_id, position_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pos_capture_due ON position_capture_queue(state, due_at_ms);
  `);

  // PR-AP: how many times this row was RE-ARMED to chase a verdict, as
  // distinct from `attempts`, which counts tries at building the record.
  //
  // The two must not share a counter. `attempts` reaching MAX_ATTEMPTS means
  // the record could not be BUILT and the row goes terminal `gave_up`; a
  // re-arm means the record is fine and only cpp-verify's answer is missing.
  // Collapsing them would let a verifier outage mark a perfectly good capture
  // as one this system could not record — the opposite of the truth.
  //
  // It exists to make the backlog pass TERMINATE. Without a counter, a row
  // whose verdict never arrives (verifier down, account not authorized) would
  // be re-armed on every pass for ever, re-pulling its deals from the broker
  // each time.
  {
    const cols = new Set(db.prepare('PRAGMA table_info(position_capture_queue)').all().map(c => c.name));
    if (!cols.has('reverify_attempts')) {
      db.exec('ALTER TABLE position_capture_queue ADD COLUMN reverify_attempts INTEGER NOT NULL DEFAULT 0');
    }
  }

  // PR-AY: the verdict's contract version, for DBs created before the column.
  // Without it every verdict already on disk is indistinguishable from one
  // produced by the current comparison rules, so a record the verifier got
  // WRONG can never be re-asked — which is exactly what happened to the ten
  // records disputed on a 100x units error before PR-AW fixed it.
  //
  // NULL is the value every existing verdict takes, and the backlog reads
  // NULL as stale rather than current: absent is not the same as up to date.
  {
    const cols = new Set(db.prepare('PRAGMA table_info(position_history)').all().map(c => c.name));
    if (cols.size && !cols.has('verifier_version')) {
      db.exec('ALTER TABLE position_history ADD COLUMN verifier_version INTEGER');
    }
    // B1 (18-09-2026): WHEN a rebuild moved the record's watched figures.
    // The re-verify cap counts asks of ONE record; a record that changed
    // after its last ask has been asked zero times. The backfill stamps the
    // rows that were reset by #951's boot rebuild before this column
    // existed: `unverified` with a verifier_version is exactly "had a
    // verdict, then rebuilt" (the reset clears the verdict, not the version).
    // C·4 (18-09-2026): the requested size kept beside the fill, never as it.
    if (cols.size && !cols.has('requested_volume')) {
      db.exec('ALTER TABLE position_history ADD COLUMN requested_volume REAL');
    }
    if (cols.size && !cols.has('rebuilt_at')) {
      db.exec('ALTER TABLE position_history ADD COLUMN rebuilt_at TEXT');
      db.exec(`UPDATE position_history SET rebuilt_at = built_at
                WHERE rebuilt_at IS NULL AND verification_state = 'unverified' AND verifier_version IS NOT NULL`);
    }
  }

  // PR-1b (20-09-2026): the risk event a tick fill's REASON lives on.
  // `position_history` REQUIRES direction_reason and reads it only from
  // risk_events via trades.risk_event_id; the tick path writes no risk event
  // at all (signal → order is in-process on the sidecar), and the
  // reconciler's ±5-minute window around the intent's created_at cannot find
  // one for a STANDING permit reserved hours before its fill. So the fire
  // ledger (services/tick-fire-ledger.js) writes the event and stamps its id
  // HERE, and stampAdoptedFromIntent prefers it over the window.
  // `signal_ref` is not free — reserveStandingPermits uses it as the
  // standing-row lookup key — so this is its own column. Additive: every
  // existing row keeps NULL, which reads as "no event written for it".
  {
    const cols = new Set(db.prepare('PRAGMA table_info(entry_intents)').all().map(c => c.name));
    if (cols.size && !cols.has('risk_event_id')) {
      db.exec('ALTER TABLE entry_intents ADD COLUMN risk_event_id INTEGER');
    }
  }

  // PR-AU: give back the attempts spent against a verifier that could not
  // answer. Measured 18-09-2026 04:08 UTC — "0 armed of 18 unverified, 0
  // eligible, 18 at the re-verify cap" — because all three attempts were
  // burned before PR-AR taught the client to POST /connect, so every one met
  // a 409. Runs EXACTLY ONCE and records that it did: see the file for why an
  // idempotent predicate would abolish the cap instead of respecting it.
  try {
    const r = resetReverifyAttempts(db);
    if (r.applied) {
      console.log(`[db] reverify reset: returned the cap on ${r.changes} record(s) whose attempts were spent before the verifier could answer`);
    }
  } catch (err) {
    console.error('[db] reverify reset failed, continuing:', err.message);
  }

  // STOP BEYOND ENTRY ⇒ be_moved (02-09-2026). be_moved was set only by the
  // explicit break-even step (position-manager rule 5, trade-guard's BE) —
  // a TRAIL that carried the stop through entry left the flag at 0. Measured
  // on US30 short trade 1415: seven stop moves, the stop 41 points in
  // profit, be_moved 0 to the close. Readers that took the flag as "has the
  // stop been amended" (reconciler's broker_sl_initial stamp, the
  // session-open guard, the cockpit's "BE pending") were reading a lie.
  // The latch is a trigger so EVERY writer of current_sl — position manager,
  // fast monitor, guard, protect, stop-adopt, restrategize, and whatever
  // comes next — sets it, and a one-shot backfill squares the open rows.
  // One-way: the trigger only ever sets 1, never clears.
  db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_mp_be_moved_latch AFTER UPDATE OF current_sl ON monitored_positions
  WHEN COALESCE(NEW.be_moved, 0) = 0
   AND NEW.entry_price IS NOT NULL AND NEW.current_sl IS NOT NULL
   AND ((UPPER(COALESCE(NEW.side,'')) IN ('LONG','BUY')   AND NEW.current_sl >= NEW.entry_price)
     OR (UPPER(COALESCE(NEW.side,'')) IN ('SHORT','SELL') AND NEW.current_sl <= NEW.entry_price))
  BEGIN
    UPDATE monitored_positions SET be_moved = 1 WHERE id = NEW.id;
  END;
  `);
  db.exec(`
  UPDATE monitored_positions SET be_moved = 1
   WHERE COALESCE(be_moved, 0) = 0 AND status = 'active'
     AND entry_price IS NOT NULL AND current_sl IS NOT NULL
     AND ((UPPER(COALESCE(side,'')) IN ('LONG','BUY')   AND current_sl >= entry_price)
       OR (UPPER(COALESCE(side,'')) IN ('SHORT','SELL') AND current_sl <= entry_price));
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
  //
  // A broker-side close arrives here WITHOUT an exit price, so this stamp is
  // NULL for it — honestly. The price lands later from the broker ledger, and
  // every writer that lands it re-stamps through the same helper
  // (trade-consistency.js stampRealisedAudit); until 02-09-2026 one of them
  // did not, and 10 of 12 bot closes carried no R for life.
  if (info.changes > 0) stampRealisedAudit(db, tradeId);
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
