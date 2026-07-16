// ---------------------------------------------------------------------------
// agent/services/stage-matrix.js — the strategy × pipeline-stage matrix.
//
// Owner requirement (2026-07-16): scanning and backtesting must be tunable
// SEPARATELY from live trading, and the scan must "analyse all convictions
// regardless of filters". Each strategy and each confluence filter therefore
// carries an independent on/off per pipeline stage:
//
//   scan      → which strategies the 5-min scan computes signals for, and
//               whether a filter GATES the scan (strict) or merely annotates
//   backtest  → which strategies the nightly autopilot evaluates, and which
//               filters the manual Backtest tab applies
//   trade     → "Auto Trade & Open" — which strategies/filters gate real
//               order placement. NEVER stored here: always derived from and
//               written to the legacy keys (enabled_strategies_json,
//               fib_*_filter) so every older reader/writer (Telegram /pause,
//               autopilot arm/disarm, presets) stays a single source of truth.
//   manage    → "Live Tweak & Close" — whether the monitor phase may amend /
//               close positions opened by that strategy. Broker-side SL/TP
//               and owner-armed per-position guards are never gated here.
//
// Storage: agent_state 'stage_matrix_json' holds ONLY scan/backtest/manage.
// Defaults: strategies scan wide (all on), backtest all on, manage all on;
// filters scan OFF (analyse everything), backtest OFF, so a fresh install
// scans every conviction and only the trade column bites.
// ---------------------------------------------------------------------------

import { STRATEGY_REGISTRY, STRATEGY_KEYS, enabledStrategies } from './strategies.js'

export const STAGES = ['scan', 'backtest', 'trade', 'manage']
export const STAGE_LABELS = {
  scan: 'Scan',
  backtest: 'Back Test',
  trade: 'Auto Trade & Open',
  manage: 'Live Tweak & Close',
}

// Confluence filters (fib-strategy opts). `stateKey` is the legacy live-trade
// flag the trade column derives from / writes to.
export const FILTER_DEFS = [
  { key: 'rsi',  name: 'RSI filter',  stateKey: 'fib_rsi_filter',  optKey: 'rsiFilter'  },
  { key: 'vwap', name: 'VWAP filter', stateKey: 'fib_vwap_filter', optKey: 'vwapFilter' },
  { key: 'fvg',  name: 'FVG filter',  stateKey: 'fib_fvg_filter',  optKey: 'fvgFilter'  },
]
export const FILTER_KEYS = FILTER_DEFS.map(f => f.key)

const STATE_KEY = 'stage_matrix_json'

const DEFAULTS = {
  strategy: { scan: true, backtest: true, manage: true },
  filter: { scan: false, backtest: false },
}

function readStored(db, getState) {
  try {
    const parsed = JSON.parse(getState(db, STATE_KEY) || 'null')
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* corrupt state — defaults below */ }
  return {}
}

/**
 * Full matrix view. Trade column is ALWAYS derived live from the legacy keys;
 * everything else comes from stage_matrix_json with wide-scan defaults.
 *
 * @returns {{ strategies: Array<{key,name,stages}>, filters: Array<{key,name,stages}> }}
 *   stages = { scan: bool, backtest: bool, trade: bool, manage: bool|null }
 *   (filters have manage: null — the monitor phase has no filter concept).
 */
export function loadStageMatrix(db, getState) {
  const stored = readStored(db, getState)
  const tradeOn = new Set(enabledStrategies(db, getState).map(s => s.key))

  const strategies = STRATEGY_REGISTRY.map(s => {
    const row = stored.strategy?.[s.key] || {}
    return {
      key: s.key,
      name: s.name,
      stages: {
        scan: typeof row.scan === 'boolean' ? row.scan : DEFAULTS.strategy.scan,
        backtest: typeof row.backtest === 'boolean' ? row.backtest : DEFAULTS.strategy.backtest,
        trade: tradeOn.has(s.key),
        manage: typeof row.manage === 'boolean' ? row.manage : DEFAULTS.strategy.manage,
      },
    }
  })

  const filters = FILTER_DEFS.map(f => {
    const row = stored.filter?.[f.key] || {}
    return {
      key: f.key,
      name: f.name,
      stages: {
        scan: typeof row.scan === 'boolean' ? row.scan : DEFAULTS.filter.scan,
        backtest: typeof row.backtest === 'boolean' ? row.backtest : DEFAULTS.filter.backtest,
        trade: getState(db, f.stateKey) === 'true',
        manage: null,
      },
    }
  })

  return { strategies, filters }
}

/**
 * Flip one cell. Trade-stage writes go to the LEGACY keys (single source of
 * truth); scan/backtest/manage go to stage_matrix_json.
 * Throws on unknown kind/key/stage or filter+manage (no such cell).
 */
export function setStage(db, { kind, key, stage, on }, { getState, setState }) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage '${stage}' — valid: ${STAGES.join(', ')}`)
  const flag = on === true

  if (kind === 'strategy') {
    if (!STRATEGY_KEYS.includes(key)) throw new Error(`unknown strategy '${key}' — valid: ${STRATEGY_KEYS.join(', ')}`)
    if (stage === 'trade') {
      const enabled = new Set(enabledStrategies(db, getState).map(s => s.key))
      if (flag) enabled.add(key); else enabled.delete(key)
      const keys = STRATEGY_KEYS.filter(k => enabled.has(k)) // registry order
      setState(db, 'enabled_strategies_json', JSON.stringify(keys))
      // Back-compat: the old cup-handle toggle reads this flag.
      setState(db, 'cup_handle_enabled', enabled.has('cup_handle') ? 'true' : 'false')
      return loadStageMatrix(db, getState)
    }
    const stored = readStored(db, getState)
    stored.strategy = stored.strategy || {}
    stored.strategy[key] = { ...stored.strategy[key], [stage]: flag }
    setState(db, STATE_KEY, JSON.stringify(stored))
    return loadStageMatrix(db, getState)
  }

  if (kind === 'filter') {
    const def = FILTER_DEFS.find(f => f.key === key)
    if (!def) throw new Error(`unknown filter '${key}' — valid: ${FILTER_KEYS.join(', ')}`)
    if (stage === 'manage') throw new Error('filters have no Live Tweak & Close cell')
    if (stage === 'trade') {
      setState(db, def.stateKey, flag ? 'true' : 'false')
      return loadStageMatrix(db, getState)
    }
    const stored = readStored(db, getState)
    stored.filter = stored.filter || {}
    stored.filter[key] = { ...stored.filter[key], [stage]: flag }
    setState(db, STATE_KEY, JSON.stringify(stored))
    return loadStageMatrix(db, getState)
  }

  throw new Error(`unknown kind '${kind}' — valid: strategy, filter`)
}

/** Registry entries the SCAN column arms (wide by default — all strategies). */
export function scanStageStrategies(db, getState) {
  const { strategies } = loadStageMatrix(db, getState)
  const on = new Set(strategies.filter(s => s.stages.scan).map(s => s.key))
  return STRATEGY_REGISTRY.filter(s => on.has(s.key))
}

/** Registry entries the BACKTEST column arms (nightly autopilot universe). */
export function backtestStageStrategies(db, getState) {
  const { strategies } = loadStageMatrix(db, getState)
  const on = new Set(strategies.filter(s => s.stages.backtest).map(s => s.key))
  return STRATEGY_REGISTRY.filter(s => on.has(s.key))
}

/**
 * Filter options for runFibScan, resolved per stage column:
 * - scan column ON  → strict {} — the filter gates the scan (legacy behaviour)
 * - scan OFF, trade ON → { mode: 'annotate' } — signal survives, failure is
 *   recorded in signal.filters_failed so Auto Trade & Open can veto it
 * - both OFF → null — the filter is not computed at all
 */
export function scanFilterOptions(db, getState) {
  const { filters } = loadStageMatrix(db, getState)
  const opts = {}
  for (const def of FILTER_DEFS) {
    const row = filters.find(f => f.key === def.key)
    if (row.stages.scan) opts[def.optKey] = {}
    else if (row.stages.trade) opts[def.optKey] = { mode: 'annotate' }
    else opts[def.optKey] = null
  }
  return opts
}

/**
 * "Auto Trade & Open" gate for one signal: the strategy's trade cell must be
 * ON, and no trade-armed filter may appear in the signal's filters_failed.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function tradeStageGate(db, getState, { strategy, filtersFailed } = {}) {
  const m = loadStageMatrix(db, getState)
  const stratKey = strategy || 'fib_618_fade'
  const stratRow = m.strategies.find(s => s.key === stratKey)
  // Unknown strategy label → block: never open a trade the matrix can't name.
  if (!stratRow) return { ok: false, reason: `strategy '${stratKey}' not in the registry` }
  if (!stratRow.stages.trade) return { ok: false, reason: `strategy '${stratKey}' is OFF in Auto Trade & Open` }
  const failed = Array.isArray(filtersFailed) ? filtersFailed : []
  for (const f of m.filters) {
    if (f.stages.trade && failed.includes(f.key)) {
      return { ok: false, reason: `${f.name} failed at scan and is armed for Auto Trade & Open` }
    }
  }
  return { ok: true, reason: null }
}

/**
 * "Live Tweak & Close" gate: may the monitor phase amend/close positions of
 * this strategy? Unlabelled/unknown strategies are ALWAYS managed — a legacy
 * position must never be stranded by a matrix edit.
 */
export function manageStageAllows(db, getState, strategyKey) {
  if (!strategyKey || !STRATEGY_KEYS.includes(strategyKey)) return true
  const { strategies } = loadStageMatrix(db, getState)
  const row = strategies.find(s => s.key === strategyKey)
  return row ? row.stages.manage : true
}

/**
 * Per-cell usage counts for the Tune table ("# successful used / # failure"),
 * last 30 days. Sources:
 * - scan:     analyses per strategy — ok = reached the auto-trade bar,
 *             fail = analysed but below it
 * - backtest: last autopilot sweep (autopilot_last_verdicts_json) —
 *             ok = GO combos, fail = NO-GO/thin
 * - trade:    risk_events by proposal strategy — ok = approved, fail = vetoed
 * - manage:   closed trades by label_strategy — ok = net win, fail = net loss
 * Filters carry no per-filter ledger yet → null counts (UI renders '—').
 * Every source is best-effort: a broken table yields zeros, never a throw.
 */
export function stageMatrixStats(db, getState) {
  const stats = {}
  const bump = (kind, key, stage, ok, fail) => {
    stats[`${kind}|${key}|${stage}`] = { ok: ok || 0, fail: fail || 0 }
  }

  try {
    const rows = db.prepare(
      `SELECT COALESCE(strategy, 'fib_618_fade') AS k,
              SUM(CASE WHEN auto_trade = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN auto_trade = 1 THEN 0 ELSE 1 END) AS fail
         FROM analyses
        WHERE datetime(analyzed_at) >= datetime('now', '-30 days')
        GROUP BY k`
    ).all()
    for (const r of rows) if (STRATEGY_KEYS.includes(r.k)) bump('strategy', r.k, 'scan', r.ok, r.fail)
  } catch { /* analyses unreadable — zeros */ }

  try {
    const verdicts = JSON.parse(getState(db, 'autopilot_last_verdicts_json') || '[]')
    const per = {}
    for (const v of Array.isArray(verdicts) ? verdicts : []) {
      if (!v?.strategy) continue
      per[v.strategy] = per[v.strategy] || { ok: 0, fail: 0 }
      if (v.state === 'go') per[v.strategy].ok++; else per[v.strategy].fail++
    }
    for (const [k, c] of Object.entries(per)) if (STRATEGY_KEYS.includes(k)) bump('strategy', k, 'backtest', c.ok, c.fail)
  } catch { /* corrupt verdicts — zeros */ }

  try {
    const rows = db.prepare(
      `SELECT COALESCE(json_extract(proposal_json, '$.strategy'), 'fib_618_fade') AS k,
              SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN approved = 1 THEN 0 ELSE 1 END) AS fail
         FROM risk_events
        WHERE datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY k`
    ).all()
    for (const r of rows) if (STRATEGY_KEYS.includes(r.k)) bump('strategy', r.k, 'trade', r.ok, r.fail)
  } catch { /* risk_events unreadable — zeros */ }

  try {
    const rows = db.prepare(
      `SELECT COALESCE(label_strategy, strategy, 'fib_618_fade') AS k,
              SUM(CASE WHEN COALESCE(net_pnl, gross_pnl, 0) > 0 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN COALESCE(net_pnl, gross_pnl, 0) > 0 THEN 0 ELSE 1 END) AS fail
         FROM trades
        WHERE status = 'closed'
          AND datetime(closed_at) >= datetime('now', '-30 days')
        GROUP BY k`
    ).all()
    for (const r of rows) if (STRATEGY_KEYS.includes(r.k)) bump('strategy', r.k, 'manage', r.ok, r.fail)
  } catch { /* trades unreadable — zeros */ }

  return stats
}

/** Matrix + stats + column metadata in one payload for GET /state/stage-matrix. */
export function stageMatrixView(db, getState) {
  return {
    columns: STAGES.map(s => ({ key: s, label: STAGE_LABELS[s] })),
    ...loadStageMatrix(db, getState),
    stats: stageMatrixStats(db, getState),
    windowDays: 30,
  }
}
