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

import { readFileSync } from 'node:fs'
import { STRATEGY_REGISTRY, STRATEGY_KEYS, enabledStrategies } from './strategies.js'
import { recordArmingChange } from './arming-log.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'

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

// PER-ACCOUNT OVERLAY (owner 04-08-2026: "i try to change the setup for
// different account but it didn't work" — arming a strategy armed it
// everywhere, because this file only ever had one global key).
//
// Same shape as the risk-config overlay: a PARTIAL matrix stored under the
// account, merged OVER the global one. Only the cells actually saved for an
// account enter its overlay; every other cell keeps following the global
// setting, so a global change still reaches accounts that never diverged.
// No overlay = byte-identical to the old behaviour.
export const acctMatrixKey = (accountId) => `acct:${accountId}:stage_matrix_json`
export const acctEnabledKey = (accountId) => `acct:${accountId}:enabled_strategies_json`

const DEFAULTS = {
  strategy: { scan: true, backtest: true, manage: true },
  filter: { scan: false, backtest: false },
}

// Kill naked Fib. The audit found the live default was a NAKED 61.8% fade with
// every confluence filter OFF — a setup the code itself says "has no documented
// standalone edge", and the source of the ~16% live win rate. So the RSI
// confluence filter is now TRADE-armed BY DEFAULT: a fade that disagrees with
// momentum (long not into RSI weakness / short not into strength) still appears
// in the scan (annotated) but is VETOED at Auto Trade & Open. An explicit stored
// value always wins, so the owner can turn it back off in Tune → no naked fib
// unless they opt in. Other filters keep their off-by-default behaviour.
function filterTradeDefault(raw, key) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return key === 'rsi'
}

function readJson(db, getState, key) {
  try {
    const parsed = JSON.parse(getState(db, key) || 'null')
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* corrupt state — treated as absent, never as "all off" */ }
  return null
}

function readStored(db, getState, accountId = null) {
  const global = readJson(db, getState, STATE_KEY) || {}
  if (accountId == null) return global
  const overlay = readJson(db, getState, acctMatrixKey(accountId))
  if (!overlay) return global
  // Cell-level merge: { strategy: { fib: { scan: false } } } over the global,
  // so an overlay that names ONE cell cannot silently reset its neighbours.
  const out = {}
  for (const kind of ['strategy', 'filter']) {
    const g = global[kind] || {}
    const o = overlay[kind] || {}
    const merged = {}
    for (const k of new Set([...Object.keys(g), ...Object.keys(o)])) {
      merged[k] = { ...(g[k] || {}), ...(o[k] || {}) }
    }
    out[kind] = merged
  }
  return out
}

/** Which cells this account has pinned — the UI badges these, so an override
 *  can never be invisible. Shape: ['strategy:fib_618_fade:trade', …]. */
export function stageOverlayKeys(db, getState, accountId) {
  if (accountId == null) return []
  const overlay = readJson(db, getState, acctMatrixKey(accountId)) || {}
  const out = []
  for (const kind of ['strategy', 'filter']) {
    for (const [key, cells] of Object.entries(overlay[kind] || {})) {
      for (const [stage, v] of Object.entries(cells || {})) {
        if (typeof v === 'boolean') out.push(`${kind}:${key}:${stage}`)
      }
    }
  }
  // LEGACY WHOLESALE LIST. Before 05-08-2026 an account's trade column was one
  // list that REPLACED the global, so the only honest badge was a wildcard:
  // "every trade cell on this account is pinned", which is what
  // `strategy:*:trade` said. Accounts still carrying that list report the same
  // thing until `migrateTradeOverlay` converts them, because it IS still true
  // of them — every cell is pinned, just not individually.
  if (readJson(db, getState, acctEnabledKey(accountId))) {
    for (const s of STRATEGY_REGISTRY) out.push(`strategy:${s.key}:trade`)
  }
  return out
}

/**
 * Clear ONE strategy's trade-stage pin on EVERY account, so the global
 * setting governs it again. Two places a pin can live: the per-account
 * overlay cell (`strategy.<key>.trade`) and the legacy wholesale list. Both
 * are cleared. Accounts are found from the registry AND from any per-account
 * state key, so an account the registry no longer lists cannot keep a pin
 * the owner cannot see.
 *
 * @returns {string[]} account ids whose pin was actually removed
 */
export function unpinTradeStageEverywhere(db, { getState, setState }, key, { actor = 'owner_route', reason = 'global kill switch cleared the per-account pins' } = {}) {
  const ids = new Set()
  try { for (const r of db.prepare(`SELECT account_id FROM accounts`).all()) ids.add(String(r.account_id)) } catch { /* no registry */ }
  try {
    for (const r of db.prepare(`SELECT key FROM agent_state WHERE key LIKE 'acct:%:stage_matrix_json' OR key LIKE 'acct:%:enabled_strategies_json'`).all()) {
      const m = /^acct:(.+):(stage_matrix_json|enabled_strategies_json)$/.exec(r.key)
      if (m) ids.add(m[1])
    }
  } catch { /* no state table */ }
  const touched = []
  for (const acct of [...ids].sort()) {
    let changed = false
    const overlay = readJson(db, getState, acctMatrixKey(acct))
    if (overlay?.strategy?.[key] && typeof overlay.strategy[key].trade === 'boolean') {
      const before = overlay.strategy[key].trade
      delete overlay.strategy[key].trade
      if (!Object.keys(overlay.strategy[key]).length) delete overlay.strategy[key]
      setState(db, acctMatrixKey(acct), JSON.stringify(overlay))
      // PR-S: an unpin is a real arming change — the cell stops being the
      // owner's word and starts following the global again. `to: undefined`
      // records it as 'unset', which is not the same fact as 'false'.
      recordArmingChange(db, { scope: acct, kind: 'strategy', key, stage: 'trade', from: before, to: undefined, actor, reason })
      changed = true
    }
    const legacy = readJson(db, getState, acctEnabledKey(acct))
    if (Array.isArray(legacy) && legacy.includes(key)) {
      setState(db, acctEnabledKey(acct), JSON.stringify(legacy.filter(k => k !== key)))
      // PR-S (checker, 17-09-2026): the overlay branch above recorded and this
      // one did not — an un-migrated account's arming went from true to
      // following-the-global with no row, from a path BOTH owner kill switches
      // reach. Measured: armedTradeKeys true before, false after, ledger empty.
      recordArmingChange(db, {
        scope: acct, kind: 'strategy', key, stage: 'trade', from: true, to: undefined,
        actor, reason: `${reason} (legacy wholesale list)`,
      })
      changed = true
    }
    if (changed) touched.push(acct)
  }
  return touched
}

/** The trade-armed strategy keys FOR ONE ACCOUNT (its own list, or global). */
/**
 * Which strategies are TRADE-armed for this account: its own overlay when it
 * has one, the global list otherwise.
 *
 * Exported 05-08-2026 because strategy-liveness.js was calling the GLOBAL
 * `enabledStrategies` to decide its ARMED/OFF badge while the card itself was
 * account-scoped. An owner who armed a strategy per account saw the card go on
 * saying "Not armed", with no account named — because the badge was not about
 * an account at all. This is the function that answers the question the badge
 * was asking.
 */
export function armedTradeKeys(db, getState, accountId) {
  const global = new Set(enabledStrategies(db, getState).map(s => s.key))
  if (accountId == null) return global

  // CELL-LEVEL MERGE, matching scan/backtest/manage (owner 05-08-2026, on the
  // Pipeline card: "the pipeline cards doesn't reconcile the top and bottom").
  //
  // It did not reconcile because in ONE table the four columns overrode
  // differently. Scan, Backtest and Manage merge cell by cell — a cell you
  // never touched keeps following the global. Trade used to REPLACE the global
  // list wholesale, so touching one trade cell silently froze all fifteen for
  // that account, and no global change reached it again. Both demo accounts
  // were in exactly that state ("strategy:*:trade" pinned).
  //
  // Now all four behave the same: an overlay cell wins where it exists, the
  // global shows through everywhere else.
  const overlay = readJson(db, getState, acctMatrixKey(accountId))?.strategy || {}
  const legacy = readJson(db, getState, acctEnabledKey(accountId))
  const legacySet = Array.isArray(legacy)
    ? new Set(legacy.filter(k => STRATEGY_KEYS.includes(k)))
    : null

  const out = new Set()
  for (const key of STRATEGY_KEYS) {
    const cell = overlay[key]?.trade
    if (typeof cell === 'boolean') { if (cell) out.add(key); continue }
    // An un-migrated account still reads its wholesale list, so behaviour is
    // byte-identical until migrateTradeOverlay runs.
    if (legacySet) { if (legacySet.has(key)) out.add(key); continue }
    if (global.has(key)) out.add(key)
  }
  return out
}

/**
 * Convert an account's legacy wholesale trade list into per-cell overlay pins.
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION: every strategy in the list is pinned
 * true and every strategy absent from it is pinned false, which is precisely
 * what the wholesale list meant. Nothing about what the account trades changes
 * on the day of the migration. What changes is that the owner can now UNPIN a
 * single cell and have it follow the global again — which the wholesale list
 * made impossible without clearing the whole list.
 *
 * Idempotent: an account with no legacy list is left alone.
 *
 * @returns {{migrated: boolean, accountId: string, pinned: number}}
 */
/**
 * Is this strategy's trade cell an EXPLICIT true on this account's overlay?
 * Only the routes and the owner's overlay migration write a true cell (the
 * autopilot writes the global list, the breaker writes false), so a true
 * pin is the owner's word — the evidence gate and the breaker exemption
 * both read it.
 */
export function isHandPinned(db, getState, accountId, key) {
  if (accountId == null) return false
  const cell = readJson(db, getState, acctMatrixKey(String(accountId)))?.strategy?.[key]?.trade
  return cell === true
}

export function migrateTradeOverlay(db, { getState, setState }, accountId) {
  const acct = String(accountId)
  const legacy = readJson(db, getState, acctEnabledKey(acct))
  if (!Array.isArray(legacy)) return { migrated: false, accountId: acct, pinned: 0 }
  const armed = new Set(legacy.filter(k => STRATEGY_KEYS.includes(k)))

  const stored = readJson(db, getState, acctMatrixKey(acct)) || {}
  stored.strategy = stored.strategy || {}
  let pinned = 0
  const pinnedKeys = []
  for (const key of STRATEGY_KEYS) {
    // An existing explicit cell is the owner's newer word — never overwrite it.
    if (typeof stored.strategy[key]?.trade === 'boolean') continue
    stored.strategy[key] = { ...stored.strategy[key], trade: armed.has(key) }
    pinnedKeys.push(key)
    pinned++
  }
  setState(db, acctMatrixKey(acct), JSON.stringify(stored))
  // PR-S (checker, 17-09-2026): this is NOT the no-op the ledger's first draft
  // assumed. Effective arming does not move — the wholesale list meant the same
  // thing — but the AUTHORITY over it does: an explicit cell is a hand pin, and
  // a hand pin is what exempts a cell from the breaker and the watchdog
  // (`isHandPinned`). Measured: isHandPinned false → true across the migration
  // with no row. `from` and `to` are the same value on purpose, so `decision:
  // 'held'` carries it past rule 1 — the row exists to record the change of
  // authority, which rule 1 cannot see because the boolean did not move.
  for (const key of pinnedKeys) {
    recordArmingChange(db, {
      scope: acct, kind: 'strategy', key, stage: 'trade',
      from: armed.has(key), to: armed.has(key), decision: 'held',
      actor: 'migration',
      reason: 'legacy wholesale list converted to explicit cells — this cell is now a hand pin and is exempt from the breaker and the watchdog',
      evidence: { migratedFrom: 'acct_enabled_list', nowHandPinned: true },
    })
  }
  // Drop the legacy list only AFTER the pins are written, so a crash between
  // the two leaves the account on the old-but-correct path rather than on the
  // global list it was deliberately diverging from.
  setState(db, acctEnabledKey(acct), '')
  return { migrated: true, accountId: acct, pinned }
}

/**
 * Full matrix view. Trade column is ALWAYS derived live from the legacy keys;
 * everything else comes from stage_matrix_json with wide-scan defaults.
 *
 * @returns {{ strategies: Array<{key,name,stages}>, filters: Array<{key,name,stages}> }}
 *   stages = { scan: bool, backtest: bool, trade: bool, manage: bool|null }
 *   (filters have manage: null — the monitor phase has no filter concept).
 */
export function loadStageMatrix(db, getState, accountId = null) {
  const stored = readStored(db, getState, accountId)
  const tradeOn = armedTradeKeys(db, getState, accountId)

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
        trade: filterTradeDefault(getState(db, f.stateKey), f.key),
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
 *
 * PR-S (17-09-2026): `actor` and `reason` travel WITH the write. They are not
 * optional decoration — they are the only durable record of why a cell holds
 * the value it holds, and without them the answer to "why is this strategy off
 * on this account" lives in a log line that scrolls away. `actor` defaults to
 * 'unattributed' so no caller can be broken by the change, and
 * `stage-matrix.test.js` pins that every production caller supplies a real
 * one: a default nobody is forced off is a default everybody keeps.
 */
export function setStage(db, { kind, key, stage, on, accountId = null, actor = 'unattributed', reason = null, evidence = null }, { getState, setState }) {
  // With an accountId every write lands in that account's OVERLAY and nothing
  // else moves: the global matrix, and every other account, are untouched.
  const acct = accountId == null ? null : String(accountId)
  if (!STAGES.includes(stage)) throw new Error(`unknown stage '${stage}' — valid: ${STAGES.join(', ')}`)
  const flag = on === true
  const attribution = { actor, reason, evidence }

  if (kind === 'strategy') {
    if (!STRATEGY_KEYS.includes(key)) throw new Error(`unknown strategy '${key}' — valid: ${STRATEGY_KEYS.join(', ')}`)
    if (stage === 'trade') {
      const enabled = armedTradeKeys(db, getState, acct)
      // Captured BEFORE the mutation below: on the global branch the "cell" is
      // membership of this list, and there is no stored cell to read it back
      // from afterwards.
      const wasArmed = enabled.has(key)
      if (flag) enabled.add(key); else enabled.delete(key)
      const keys = STRATEGY_KEYS.filter(k => enabled.has(k)) // registry order
      // NOTE: a global OFF here does NOT clear per-account pins. The owner's
      // kill switch (the /actions/strategies and /actions/stage-matrix
      // routes) does that via unpinTradeStageEverywhere; the adaptive
      // breaker also calls this function and applies its own never-go-dark
      // rule per scope, which a blanket unpin would silently override.
      if (acct) {
        // ONE CELL, like every other column. The global list and the legacy
        // cup_handle_enabled flag stay exactly as they were — an account
        // arming a strategy must not arm it for anyone else.
        //
        // Writing the whole list here is what froze an account's entire trade
        // column the first time one cell was touched. Migrate any legacy list
        // first so the other fourteen cells keep the value they had, then pin
        // just this one.
        migrateTradeOverlay(db, { getState, setState }, acct)
        writeCell(db, { getState, setState }, acct, 'strategy', key, 'trade', flag, attribution)
        return loadStageMatrix(db, getState, acct)
      }
      setState(db, 'enabled_strategies_json', JSON.stringify(keys))
      // Back-compat: the old cup-handle toggle reads this flag.
      setState(db, 'cup_handle_enabled', enabled.has('cup_handle') ? 'true' : 'false')
      // The global list is not a stored cell, so its before/after is the
      // membership captured above — recorded here rather than in writeCell.
      recordArmingChange(db, { scope: null, kind: 'strategy', key, stage: 'trade', from: wasArmed, to: flag, ...attribution })
      return loadStageMatrix(db, getState)
    }
    writeCell(db, { getState, setState }, acct, 'strategy', key, stage, flag, attribution)
    return loadStageMatrix(db, getState, acct)
  }

  if (kind === 'filter') {
    const def = FILTER_DEFS.find(f => f.key === key)
    if (!def) throw new Error(`unknown filter '${key}' — valid: ${FILTER_KEYS.join(', ')}`)
    if (stage === 'manage') throw new Error('filters have no Live Tweak & Close cell')
    if (stage === 'trade') {
      if (acct) {
        writeCell(db, { getState, setState }, acct, 'filter', key, 'trade', flag, attribution)
        return loadStageMatrix(db, getState, acct)
      }
      const wasOn = filterTradeDefault(getState(db, def.stateKey), def.key)
      setState(db, def.stateKey, flag ? 'true' : 'false')
      recordArmingChange(db, { scope: null, kind: 'filter', key, stage: 'trade', from: wasOn, to: flag, ...attribution })
      return loadStageMatrix(db, getState)
    }
    writeCell(db, { getState, setState }, acct, 'filter', key, stage, flag, attribution)
    return loadStageMatrix(db, getState, acct)
  }

  throw new Error(`unknown kind '${kind}' — valid: strategy, filter`)
}

/**
 * Write ONE cell into the global matrix, or into an account's overlay.
 *
 * PR-S: this is the single chokepoint for every stored cell, so the ledger
 * row is written here and nowhere else. The previous value is read from the
 * same `stored` object the write is about to replace — `undefined` when the
 * cell has never been written, which the ledger keeps distinct from `false`.
 */
function writeCell(db, { getState, setState }, accountId, kind, key, stage, flag, attribution = {}) {
  const target = accountId == null ? STATE_KEY : acctMatrixKey(accountId)
  const stored = readJson(db, getState, target) || {}
  stored[kind] = stored[kind] || {}
  const before = stored[kind][key]?.[stage]
  stored[kind][key] = { ...stored[kind][key], [stage]: flag }
  setState(db, target, JSON.stringify(stored))
  recordArmingChange(db, { scope: accountId, kind, key, stage, from: before, to: flag, ...attribution })
}

/**
 * Disarm one strategy's trade cell EVERYWHERE it is armed: the global list,
 * and every registered account whose overlay pin (or legacy wholesale list)
 * keeps it armed independently of the global.
 *
 * Why this exists (measured 2026-08-31): the owner's 28-08 global disarm and
 * the adaptive-breaker's own donchian_breakout disarm both wrote ONLY
 * enabled_strategies_json — while five of seven accounts carried per-account
 * trade pins from the 04-08 overlay migration. Those accounts kept proposing
 * fib_618_fade et al. into the risk gate (363 of the last 400 risk events were
 * vetoed proposals from globally-disarmed strategies). A disarm that a pin can
 * silently outvote is failure mode #3: a guard whose trigger is out of reach
 * of what it guards.
 *
 * `neverZero` (default true) honours the adaptive-breaker's never-go-dark
 * invariant PER SCOPE: a scope (global, or one account) is only disarmed if
 * at least one other strategy stays trade-armed there. The edge watchdog
 * passes false — its owner mandate ("no alpha decay") has always allowed it
 * to retire the last strategy standing, and its existing tests pin that.
 *
 * @returns {string[]} scopes changed: 'global' and/or account ids.
 */
export function disarmStrategyEverywhere(db, io, key, { neverZero = true, exemptHandPinned = false, ownVerdictScopes = [], actor = 'unattributed', reason = null, evidence = null } = {}) {
  const { getState } = io
  const changed = []
  const held = []
  // THE PIN HOLDS AGAINST A POOLED VERDICT ONLY (checker, 11-09-2026). With
  // `_all` pins every enabled account carries an explicit trade:true for
  // every strategy, so an exemption that held every pin left a guard unable
  // to disarm anything anywhere. A pin is the owner's word to MEASURE the
  // strategy on that account — not to ignore that account's own losses. A
  // scope named here had the verdict measured on ITS OWN closes, and its
  // cell is written false like any other; the other pins still hold.
  const own = new Set((ownVerdictScopes || []).map(String))
  const scopes = [null]
  try {
    for (const r of db.prepare('SELECT account_id FROM accounts').all()) scopes.push(String(r.account_id))
  } catch { /* no accounts table — global only */ }
  for (const scope of scopes) {
    const armed = armedTradeKeys(db, getState, scope)
    if (!armed.has(key)) continue
    if (neverZero && ![...armed].some(k => k !== key)) continue // last armed here — hold
    // HAND-PINNED ARMS ARE EXEMPT (owner, 03-09-2026 00:50 SGT; every scope
    // since PR-B, 11-09-2026, owner principle 1). An account whose overlay
    // carries an explicit trade:true for this strategy was armed on purpose
    // to be MEASURED — the split's point is to record the loss, not to
    // prevent it. Only routes and the owner's overlay migration write a true
    // cell (the autopilot writes the global list, the breaker writes false),
    // so an explicit true on an account scope is the owner's word, whichever
    // environment the account is. The global list is never a pin.
    if (exemptHandPinned && scope != null && !own.has(scope)) {
      const cell = readJson(db, getState, acctMatrixKey(scope))?.strategy?.[key]?.trade
      if (cell === true) {
        held.push(scope)
        // PR-S rule 2: a pin that outvoted a verdict is a DECISION, and "why
        // is this still armed" is the same question as "why is this off".
        // Recorded with the verdict it held against, so the owner can see
        // what their pin is costing rather than only that it exists.
        recordArmingChange(db, {
          scope, kind: 'strategy', key, stage: 'trade', from: true, to: true, decision: 'held',
          actor, reason: reason ? `${reason} — HELD by the owner's pin on this account` : 'held by the owner\'s pin on this account',
          evidence: { ...(evidence || {}), heldBy: 'hand_pin', ownVerdictScope: false },
        })
        continue
      }
    }
    setStage(db, { kind: 'strategy', key, stage: 'trade', on: false, accountId: scope, actor, reason, evidence }, io)
    changed.push(scope == null ? 'global' : scope)
  }
  if (exemptHandPinned) changed.held = held
  return changed
}

/**
 * OWNER-DECLARED HAND PINS FROM THE REPO (owner order 09-09-2026, §7,522·B·2:
 * the rsi2_reversion / rsi_meanrev demo cohort). The pinning route
 * (POST /actions/stage-matrix with an accountId) needs the bearer token, lost
 * on 07-09, so the declaration lives in agent/config/strategy-pins.json —
 * { "<accountId>": ["strategy", …] } — and is applied at boot, same rule as
 * the horizon and momentum-account seeds: idempotent, an explicit true cell
 * already present is left alone, a route call changes it live until the next
 * boot re-applies the file. A pin is the owner's word: the evidence gate
 * admits it (isHandPinned) and the adaptive breaker holds it on every scope.
 * Unknown strategies and malformed entries are skipped and named; a missing
 * or unreadable file reports and changes nothing.
 *
 * PR-B (owner principle 9, 11-09-2026): the key `_all` pins its list on
 * EVERY enabled registry account — including one enabled after the file was
 * first applied, on its first boot, because the seed-once record is kept per
 * account. An explicit per-id key still wins over `_all` for that account.
 */
export function seedStrategyPinsFromConfig(db, io, { file = null, log = () => {} } = {}) {
  const out = { applied: [], unchanged: [], skipped: [], error: null }
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
  } catch (err) {
    out.error = `strategy-pins.json unreadable: ${err.message}`
    return out
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { out.error = 'strategy-pins.json is not an object'; return out }
  const { getState, setState } = io
  // SEED ONCE (10-09-2026). The file is the owner's initial declaration, not
  // a setting re-asserted on every boot. Measured: the watchdog disarmed
  // donchian_breakout, vwap_trend and rsi2_reversion on ACCT-LIVE-1 at 20:59
  // SGT (demo pins held, #870), and the next boot re-pinned all of them
  // ("strategy pins: 5 applied") — the #870 loop again, on the live account,
  // where the guard's word is the one that must stand. A pin the seed has
  // applied (or found) before is recorded here and never re-applied; what
  // a guard or a human does to it afterwards persists across deploys. A
  // key newly added to the file is still applied on its first boot.
  out.held = []
  let seeded = {}
  try { seeded = JSON.parse(getState(db, 'strategy_pins_seeded_json') || '{}') || {} } catch { seeded = {} }
  let dirty = false
  const entries = Object.entries(cfg).filter(([k]) => !k.startsWith('_')) // `_note` etc. are the file's own notes
  if (Array.isArray(cfg._all)) {
    let ids = []
    try { ids = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { ids = [] }
    const named = new Set(entries.map(([k]) => k))
    for (const id of ids) if (!named.has(id)) entries.push([id, cfg._all])
  } else if ('_all' in cfg) {
    out.skipped.push('_all: malformed')
  }
  // `_reseed` (PR-V, owner order 17-09-2026): entries "<accountId>:<strategy>[:token]"
  // that issue a FRESH seed order for a cell the bare key has already spent.
  //
  // Needed because the seed-once record is keyed on the strategy, so once a
  // pin has been applied and later disarmed, this file can never put it back —
  // which is correct as a default (it is what stops the #870 re-pin loop) and
  // is exactly why an explicit re-order needs its own identity. The whole
  // string is the identity, so `tsmom_long:2` is a different order from
  // `tsmom_long` and is likewise applied at most once.
  //
  // Appended AFTER the per-id and `_all` entries so it cannot displace them:
  // a per-id key suppresses `_all` for that id, and re-arming one cell must
  // not quietly stop an account inheriting future strategies.
  if (Array.isArray(cfg._reseed)) {
    for (const item of cfg._reseed) {
      if (typeof item !== 'string') { out.skipped.push(`${JSON.stringify(item)}: _reseed entry is not a string`); continue }
      const [acct, strategy, ...rest] = item.split(':')
      if (!acct || !strategy) { out.skipped.push(`${item}: _reseed entry needs <accountId>:<strategy>`); continue }
      entries.push([acct, [rest.length ? `${strategy}:${rest.join(':')}` : strategy]])
    }
  } else if ('_reseed' in cfg) {
    out.skipped.push('_reseed: malformed')
  }
  // `_trial` (Wave 1 of the first-principles audit, 19-09-2026): ONE account
  // per strategy on a pre-registered trial — ON there, OFF everywhere else.
  // The listed ids ride as ordinary ON entries (`<strategy>` under a per-id
  // seed record `trial:<strategy>`); every other enabled account gets an OFF
  // order for that strategy, applied by the `_off` path below.
  const offOrders = new Map() // accountId -> Set(strategy)
  let enabledIds = []
  try { enabledIds = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { enabledIds = [] }
  const trialOn = new Map() // accountId -> Set(strategy)
  if (cfg._trial && typeof cfg._trial === 'object' && !Array.isArray(cfg._trial)) {
    for (const [strategy, ids] of Object.entries(cfg._trial)) {
      if (!Array.isArray(ids) || !ids.every(x => /^[0-9]+$/.test(String(x)))) { out.skipped.push(`_trial ${strategy}: malformed`); continue }
      const listed = new Set(ids.map(String))
      for (const id of listed) {
        if (!trialOn.has(id)) trialOn.set(id, new Set())
        trialOn.get(id).add(strategy)
        entries.push([id, [`${strategy}:trial`]])
      }
      for (const id of enabledIds) if (!listed.has(id)) { if (!offOrders.has(id)) offOrders.set(id, new Set()); offOrders.get(id).add(strategy) }
    }
  } else if ('_trial' in cfg) {
    out.skipped.push('_trial: malformed')
  }
  // `_off` (Wave 1): switch OFF, for every enabled account, the strategies
  // named — unless a per-id key or `_trial` names that strategy ON for the
  // account (an explicit ON wins). Seed-once like everything else here, under
  // the record `off:<strategy>`, so a human re-arming a cell afterwards is
  // not undone on the next boot.
  if (Array.isArray(cfg._off)) {
    const explicitOn = new Map()
    for (const [id, keys] of entries) {
      if (!Array.isArray(keys)) continue
      if (!explicitOn.has(id)) explicitOn.set(id, new Set())
      for (const e of keys) explicitOn.get(id).add(String(e).split(':')[0])
    }
    for (const id of enabledIds) {
      for (const strategy of cfg._off) {
        if (explicitOn.get(id)?.has(strategy)) continue
        if (!offOrders.has(id)) offOrders.set(id, new Set()); offOrders.get(id).add(strategy)
      }
    }
  } else if ('_off' in cfg) {
    out.skipped.push('_off: malformed')
  }
  out.off = []
  for (const [accountId, keys] of entries) {
    if (!/^[0-9]+$/.test(accountId) || !Array.isArray(keys)) { out.skipped.push(`${accountId}: malformed`); continue }
    const done = new Set(Array.isArray(seeded[accountId]) ? seeded[accountId] : [])
    for (const entry of keys) {
      // A `_reseed` entry carries a token after the strategy (`tsmom_long:2`).
      // The token is the seed RECORD's identity; the strategy is what is armed.
      const key = String(entry).split(':')[0]
      if (!STRATEGY_KEYS.includes(key)) { out.skipped.push(`${accountId}: unknown strategy '${key}'`); continue }
      const tag = `${accountId}:${entry}`
      const pinned = isHandPinned(db, getState, accountId, key)
      if (done.has(entry)) { (pinned ? out.unchanged : out.held).push(tag); continue }
      if (pinned) { out.unchanged.push(tag) } else {
        setStage(db, {
          kind: 'strategy', key, stage: 'trade', on: true, accountId,
          actor: 'boot_seed', reason: 'declared in agent/config/strategy-pins.json',
          evidence: { file: 'agent/config/strategy-pins.json', seededOnce: true },
        }, { getState, setState })
        out.applied.push(tag)
        log(`[boot] strategy pin …${accountId.slice(-4)}: ${key} ON for Auto Trade & Open (from config/strategy-pins.json)`)
      }
      done.add(entry); dirty = true
    }
    seeded[accountId] = [...done]
  }
  for (const [accountId, strategies] of offOrders) {
    const done = new Set(Array.isArray(seeded[accountId]) ? seeded[accountId] : [])
    for (const key of strategies) {
      if (!STRATEGY_KEYS.includes(key)) { out.skipped.push(`${accountId}: unknown strategy '${key}' in _off/_trial`); continue }
      const record = `off:${key}`
      const tag = `${accountId}:${key}`
      if (done.has(record)) { out.unchanged.push(`${tag}:off`); continue }
      if (isHandPinned(db, getState, accountId, key)) {
        setStage(db, {
          kind: 'strategy', key, stage: 'trade', on: false, accountId,
          actor: 'boot_seed', reason: 'declared OFF in agent/config/strategy-pins.json (_off/_trial — no positive live record, or on trial elsewhere)',
          evidence: { file: 'agent/config/strategy-pins.json', seededOnce: true },
        }, { getState, setState })
        out.off.push(tag)
        log(`[boot] strategy pin …${accountId.slice(-4)}: ${key} OFF for Auto Trade & Open (from config/strategy-pins.json _off/_trial)`)
      } else {
        out.unchanged.push(`${tag}:off`)
      }
      done.add(record); dirty = true
    }
    seeded[accountId] = [...done]
  }
  if (dirty) setState(db, 'strategy_pins_seeded_json', JSON.stringify(seeded))
  return out
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
export function tradeStageGate(db, getState, { strategy, filtersFailed, accountId = null } = {}) {
  const m = loadStageMatrix(db, getState, accountId)
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

  // No fallback to 'fib_618_fade' in any of the four queries below (owner,
  // 2026-07-22: caught Pipeline's Fib row silently absorbing every row with
  // no strategy attribution — the same lost-label rows Edge Health honestly
  // buckets as "Manual / external" via alpha-decay.js's COALESCE(label_
  // strategy, strategy) with NO third default). A null/missing strategy here
  // simply isn't in STRATEGY_KEYS, so `bump()` is skipped for it — the row
  // is excluded from every strategy's column instead of inflating Fib's.

  try {
    const rows = db.prepare(
      `SELECT strategy AS k,
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
      `SELECT json_extract(proposal_json, '$.strategy') AS k,
              SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN approved = 1 THEN 0 ELSE COALESCE(repeat_count, 1) END) AS fail
         FROM risk_events
        WHERE datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY k`
    ).all()
    for (const r of rows) if (STRATEGY_KEYS.includes(r.k)) bump('strategy', r.k, 'trade', r.ok, r.fail)
  } catch { /* risk_events unreadable — zeros */ }

  try {
    const rows = db.prepare(
      `SELECT ${strategyAttrSql()} AS k,
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

/**
 * Would ANY of these accounts trade this strategy right now?
 *
 * The loop evaluates the trade gate ONCE per signal, before it fans out to
 * accounts. With per-account overlays that single verdict can no longer be
 * authoritative — one account may have armed a strategy the global matrix has
 * off. So the signal-level check becomes a UNION (an optimisation: stop early
 * only when nobody could act on it) and the real decision moves inside the
 * fan-out, where the account is known.
 *
 * An empty or unknown roster returns the GLOBAL verdict — never a silent
 * "yes", and never a silent "no".
 */
export function anyAccountTradeGate(db, getState, { strategy, filtersFailed, accountIds } = {}) {
  const ids = Array.isArray(accountIds) ? accountIds.filter(a => a != null) : []
  if (ids.length === 0) return tradeStageGate(db, getState, { strategy, filtersFailed })
  let last = null
  for (const id of ids) {
    const g = tradeStageGate(db, getState, { strategy, filtersFailed, accountId: String(id) })
    if (g.ok) return g
    last = g
  }
  return last
}

/**
 * How much each registry account has armed, per stage.
 *
 * Owner, 04-08-2026: "have a count of tick/cross per account." The matrix
 * renders ONE scope at a time, so comparing accounts meant switching the pill
 * and counting cells by eye.
 *
 * IT LIVES HERE, next to loadStageMatrix, because a tally is only worth
 * anything if it counts the SAME merged matrix the cells render from. It was
 * first written inline in the state route, and the write route then answered
 * without it — so a freshly-flipped tick disagreed with the tally underneath
 * it until the next poll (caught in review on #609). Two call sites, one
 * implementation, no room for them to drift.
 */
export function accountStageTallies(db, getState) {
  let rows = []
  try {
    rows = db.prepare(
      'SELECT account_id, trader_login, is_live, enabled, mode FROM accounts ORDER BY is_live, account_id'
    ).all()
  } catch { return [] }
  return rows.map(r => {
    const id = String(r.account_id)
    const m = loadStageMatrix(db, getState, id)
    const stages = {}
    for (const s of [...(m.strategies || []), ...(m.filters || [])]) {
      for (const [stage, on] of Object.entries(s.stages || {})) {
        if (on == null) continue          // not applicable — counted neither way
        stages[stage] = stages[stage] || { on: 0, off: 0 }
        stages[stage][on ? 'on' : 'off'] += 1
      }
    }
    return {
      accountId: id,
      traderLogin: r.trader_login ?? null,
      isLive: r.is_live === 1,
      enabled: r.enabled === 1,
      mode: r.mode ?? null,
      stages,
      pinned: stageOverlayKeys(db, getState, id).length,
    }
  })
}
