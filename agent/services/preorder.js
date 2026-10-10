// ---------------------------------------------------------------------------
// agent/services/preorder.js — the risk gate's answer BEFORE an order.
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// The owner asked to see, before an order exists, each signal's numbers and
// the first gate that would block it. The gate already computes all of it —
// R:R against the floor, stop distance, size, money at risk, margin share,
// open count, the daily stop — but only when an order is committed, and the
// callers then persist the verdict (loop.js:796-798, actions.js:6428-6432).
//
// This module asks the SAME gate (risk.evaluateTrade, risk.js:1685) the same
// question with the same proposal, and stops there:
//
//   * nothing is persisted — no persistRiskEvent, no decision_log row, no
//     setState. evaluateTrade and every helper it calls only read (the read-
//     only proof is agent/services/preorder.test.js: total_changes() and the
//     row counts of risk_events, trades, entry_intents and action_log are
//     unchanged, and no write statement is even prepared);
//   * no order, amend or close function is reachable from here;
//   * one broker READ, on the manual path only: the freshest 1m close the
//     manual-order route also reads for its entry estimate (actions.js:6409-
//     6413), through the same helper (wsGetTrendbarsBatch), injectable;
//   * the account's symbol id is resolved WITHOUT fetching (and storing) the
//     account's symbol list: a stale or missing list is reported, not read.
//
// Two inputs, each reproducing its real path's proposal up to its gate call:
//   (i)  a scanner signal by its scans row id → loop.js autoTrade (market
//        path, loop.js:758-796) or, when the HTF rule routes it to a resting
//        limit (loop.js:653-668), closed-market-limits.js:438-460;
//   (ii) manual pad input → POST /actions/manual-order (actions.js:6373-6428).
// The proposals are literal copies; preorder.test.js drives the REAL
// autoTrade, placeClosedMarketLimit and manual-order route on the same state
// and asserts the proposal they persisted equals the one built here, so a
// field added to one path and not the other turns that test red.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import * as risk from './risk.js'
import { usdLossPerLot } from '../lib/contracts.js'
import { synthesizeFibSignal } from './fib-strategy.js'
import { evidenceGate, evidenceRows, summarizeEvidence, loadEvidenceGate } from './evidence-gate.js'
import { readDailyRiskVerdict } from './daily-stop-reading.js'
import { checkRegimeGate, trendReadingFor } from './regime-gate.js'
import { loadLessonTuning, applySlWiden, isDecayed } from './lessons-tuner.js'
import { accountMayTrade } from './watchlists.js'
import { accountPregateVerdict } from './account-pregate.js'
import { loadClosedMarketLimitsConfig } from './closed-market-limits.js'
import { momentumPlanApplies } from './momentum-entry-switch.js'
import { isProducerRetired } from '../lib/entry-producers.js'
import { tfMs, nextBarCloseMs } from '../lib/timeframes.js'
import { getCtraderCreds, credsForRegisteredAccount, resolveSymbolId } from '../lib/ctrader-creds.js'
import { ctraderEnv } from '../lib/ctrader-env.js'
import { wsGetTrendbarsBatch } from '../lib/ctrader-ws.js'

/** The query parameters GET /state/preorder understands; anything else is a 400. */
export const PREORDER_SCAN_PARAMS = Object.freeze(['scanId', 'account'])
export const PREORDER_MANUAL_PARAMS = Object.freeze(['account', 'symbol', 'side', 'lots', 'sl', 'tp'])

/** expectedR is not invented: the exit policy (position-manager.js DEFAULT_RULES) holds no win probability to weigh its outcomes by. */
export const EXPECTED_R_NOT_COMPUTED = Object.freeze({
  value: null,
  reason: 'not computed',
  detail: 'position-manager.js holds breakeven/partial RULES, not a probability of reaching them; an expected R needs one, and none is invented here',
})

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const round = (v, dp = 2) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : null)
const cannot = (reason, extra = {}) => ({ ok: false, cannotCheck: `cannot check: ${reason}`, ...extra })
const bad = (status, error) => ({ ok: false, status, error })
const registered = (db, id) => { try { return !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(String(id)) } catch { return false } }

// The codebase's own words for a veto (src/lib/veto-words.js humanVeto — the
// loop's Telegram alert reads it the same way, loop.js:107). The production
// image ships agent/ only (Dockerfile), so where src/ is absent the label is
// humanVeto's own fallback rule: the code with its underscores as spaces.
let humanVetoFn
async function vetoLabeller() {
  if (humanVetoFn === undefined) {
    try { humanVetoFn = (await import('../../src/lib/veto-words.js')).humanVeto } catch { humanVetoFn = null }
  }
  return (reason) => {
    if (humanVetoFn) { try { return humanVetoFn(reason) } catch { /* fall through */ } }
    return String(reason || '').trim().replace(/_/g, ' ')
  }
}

/**
 * The gate's decision for a hypothetical order. Never persists, never sends.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{scanId?:number|string, account?:string|number, symbol?:string, side?:string, lots?:number|string, sl?:number|string, tp?:number|string}} input
 * @param {{fetchEntry?:(creds:object, symbolId:string|number)=>Promise<number|null>, nowMs?:number}} [deps]
 */
export async function preorderCheck(db, input = {}, deps = {}) {
  if (input.scanId != null && input.scanId !== '') return scanPreorder(db, input, deps)
  return manualPreorder(db, input, deps)
}

// ---------------------------------------------------------------------------
// (i) a scanner signal
// ---------------------------------------------------------------------------

/** The global watchlist row dispatchSymbolSignal reads (loop.js:4555-4564, 1517). */
function globalWatchItem(db, symbol) {
  let parsed = []
  try { parsed = JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]') } catch { parsed = [] }
  const list = (Array.isArray(parsed) ? parsed : []).map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
  return list.find(w => w?.symbol === symbol) || { autoTradeThreshold: 8 }
}

/**
 * The synth the dispatcher would hand autoTrade for this scan row: the raw
 * signal the scan retained in last_scan_results (the batch dispatch reads,
 * loop.js:5113), shaped by the SAME function (synthesizeFibSignal,
 * loop.js:1531); else the analysis dispatchSymbolSignal stored for this row
 * (analyses.scan_id, loop.js:1539-1557). Null when neither is retained.
 */
function scanSynth(db, row, threshold) {
  const bias = String(row.bias || '').toLowerCase()
  if (row.scanned_at && row.scanned_at === getState(db, 'last_scan_at')) {
    let snap = null
    try { snap = JSON.parse(getState(db, 'last_scan_results') || 'null') } catch { snap = null }
    const candidates = [snap?.signalsByStrategy?.[row.symbol]?.[row.strategy], snap?.signals?.[row.symbol]]
    const sig = candidates.find(s => s && s.strategy === row.strategy && (s.timeframe ?? null) === (row.timeframe ?? null)
      && String(s.bias || '').toLowerCase() === bias)
    if (sig) return { synth: synthesizeFibSignal(row.symbol, sig, threshold).synthesis, source: 'last_scan_results' }
  }
  try {
    const a = db.prepare('SELECT synthesis FROM analyses WHERE scan_id = ? ORDER BY id DESC LIMIT 1').get(row.id)
    const synth = a?.synthesis ? JSON.parse(a.synthesis) : null
    if (synth && synth.entry != null) return { synth, source: 'analysis' }
  } catch { /* fall through */ }
  return null
}

/** Would loop.js send this signal as an HTF resting limit (loop.js:653-668)? */
function htfRoutes(db, accountId, synth, nowMs) {
  const htf = risk.loadRiskConfig(db, accountId)?.htfLimitDispatch
  const minTf = String(htf?.minTf ?? '').trim().toLowerCase()
  const minMs = minTf && minTf !== 'off' ? tfMs(minTf) : 0
  const sigMs = synth.timeframe ? tfMs(synth.timeframe) : 0
  const freshMin = Number(htf?.freshnessMin) || 0
  const lastBarCloseMs = sigMs > 0 ? (nextBarCloseMs(synth.timeframe, nowMs) ?? 0) - sigMs : 0
  const fresh = freshMin > 0 && lastBarCloseMs > 0 && (nowMs - lastBarCloseMs) <= freshMin * 60_000
  return minMs > 0 && sigMs >= minMs && synth.marketOnly !== true && !fresh
}

/**
 * E·2's shared-signal count, read-only (loop.js:1801-1838): the roster's
 * accounts not exhausted in the margin pool and admitted by the account
 * pre-gate's verdict. The loop asks accountPregate, which records a skip row
 * for a refused account; accountPregateVerdict is the same verdict without
 * the row (account-pregate.js:64). Also returns this account's pool entry.
 */
async function sharedSignalCount(db, accountId) {
  const { getAutopilotAccounts } = await import('../loop.js')
  const accounts = getAutopilotAccounts(db)
  const byId = new Map(accounts.map(a => [String(a.accountId), a]))
  let pool = accounts.map(a => ({ acct: a, accountId: String(a.accountId), status: null, exhausted: false }))
  try {
    let rates = null
    try { rates = risk.scanRates(db) } catch { rates = null }
    pool = risk.accountMarginPool(db, risk.loadRiskConfig(db), accounts.map(a => a.accountId), { rates })
      .map(p => ({ ...p, acct: byId.get(p.accountId) }))
      .filter(p => p.acct)
  } catch { /* the loop falls back to the plain roster, nobody exhausted */ }
  const n = pool.map(p => p.acct).reduce((count, a) => {
    const pe = pool.find(p => String(p.accountId) === String(a.accountId))
    if (pe?.exhausted) return count
    try { if (!accountPregateVerdict(db, a.accountId).ok) return count } catch { /* accountPregate fails open */ }
    return count + 1
  }, 0)
  return { n, inRoster: byId.has(String(accountId)), poolEntry: pool.find(p => String(p.accountId) === String(accountId)) || null }
}

async function scanPreorder(db, input, deps) {
  const nowMs = Number.isFinite(Number(deps.nowMs)) ? Number(deps.nowMs) : Date.now()
  const scanId = Number(input.scanId)
  if (!Number.isInteger(scanId) || scanId <= 0) return bad(400, 'scanId must be a positive integer')
  const row = db.prepare('SELECT id, symbol, bias, confidence, timeframe, strategy, price, scanned_at FROM scans WHERE id = ?').get(scanId)
  if (!row) return bad(404, `scan ${scanId} not found`)
  const bias = String(row.bias || '').toLowerCase()
  if (bias !== 'long' && bias !== 'short') return cannot(`scan ${scanId} is not a directional signal (bias ${row.bias ?? 'none'})`)
  if (input.account != null && input.account !== '' && !registered(db, input.account)) return bad(400, `account ${String(input.account)} is not in the registry`)
  // autoTrade's account: the dispatched account, else the primary (loop.js:456).
  const accountId = input.account != null && input.account !== '' ? String(input.account) : (getState(db, 'ctrader_account_id') || null)
  if (!accountId) return cannot('no account named and no primary account recorded')

  const symbol = row.symbol
  const wItem = globalWatchItem(db, symbol)
  const threshold = wItem.autoTradeThreshold || 8
  const found = scanSynth(db, row, threshold)
  if (!found) return cannot(`the levels of scan ${scanId} are not retained: it is not in the current scan batch and no analysis was stored for it`)
  // A copy: the lesson tuner below replaces the stop the way autoTrade does.
  const synth = { ...found.synth }
  if (wItem.override_bias) {
    return cannot(`the watchlist sets override_bias=${wItem.override_bias} for ${symbol}; the dispatcher's override (loop.js:1676-1724) is not reproduced by the dry run`)
  }
  if (momentumPlanApplies('scan_dispatch', { accountId })) {
    return cannot('the momentum entry plan reads the live broker quote before the gate (loop.js:728-749); not reproduced by the dry run')
  }

  // The dispatch steps this dry run reproduces, in the real path's order.
  const upstream = []
  const step = (stage, blocked, reason = null) => { upstream.push({ stage, ok: !blocked, reason: blocked ? reason : null }) }
  step('autotrade_master', getState(db, 'autotrade_enabled') !== 'true', 'autotrade is off (the master switch)')
  step('auto_trade_threshold', !synth.auto_trade, `conviction ${synth.overall_conviction ?? 'n/a'} is below the auto-trade threshold ${threshold}`)
  {
    const rg = checkRegimeGate(db, synth.strategy, synth.consensus_bias, symbol)
    step('regime_gate', !!rg.block, rg.reason)
  }
  const shared = await sharedSignalCount(db, accountId)
  step('entry_roster', !shared.inRoster, `account …${String(accountId).slice(-4)} is not in the entry roster (registry mode/enabled)`)
  {
    const pe = shared.poolEntry
    step('margin_pool', !!pe?.exhausted, pe?.unfunded ? 'unfunded account (broker balance 0) — no budget to size against'
      : pe?.status ? `margin exhausted on this account (used $${pe.status.usedMargin.toFixed(2)} vs cap $${pe.status.cap.toFixed(2)}, ${pe.status.source})` : 'margin exhausted on this account')
  }
  {
    let v = null
    try { v = accountPregateVerdict(db, accountId) } catch { v = null }
    step('account_pregate', !!(v && !v.ok), v?.reason)
  }
  const member = accountMayTrade(db, accountId, symbol)
  step('account_watchlist', !member.ok, member.reason)
  const acctItem = { ...wItem, ...(member.ok ? member.item : {}) }

  // ---- autoTrade (loop.js:446-796) ----------------------------------------
  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'                                     // loop.js:464
  const requestedVol = Number(acctItem?.maxVolume) > 0 ? Number(acctItem.maxVolume) : null             // loop.js:469
  {
    const missing = !ctraderEnv('clientId') || !ctraderEnv('clientSecret') || !getState(db, 'ctrader_access_token')
    step('credentials', missing, 'cTrader credentials not configured')
  }
  step('producer_retired', isProducerRetired('scan_dispatch'), 'producer_retired: scan_dispatch')
  {
    let eg = null
    try { eg = evidenceGate(db, { strategy: synth.strategy || null, accountId }) } catch { eg = null } // fail-open, loop.js:640
    step('evidence_gate', !!(eg && !eg.allowed), eg ? `evidence_gate: ${eg.reason}` : null)
  }

  let route = 'market'
  try { if (htfRoutes(db, accountId, synth, nowMs)) route = 'htf_limit' } catch { route = 'htf_error' }
  if (route === 'htf_error') return cannot('the HTF limit rule could not be evaluated; loop.js places no market order in that case (loop.js:686-689)')

  let proposal
  if (route === 'htf_limit') {
    // placeClosedMarketLimit returns `skipped: 'off'` before its gate when
    // the resting-limit feature is off, and the loop places nothing
    // (closed-market-limits.js:359, loop.js:683).
    step('htf_limit', !loadClosedMarketLimitsConfig(db).on, 'htf_limit_off: this signal would rest as a limit order and closed-market limits are off — no order is placed')
    // closed-market-limits.js:438-460 — the HTF branch runs BEFORE the lesson
    // tuner, so this synth carries the scan's own stop.
    proposal = {
      symbol, side,
      direction_reason: synth.direction_reason ?? null,
      trend_at_evaluation: trendReadingFor(db, symbol),
      entry: synth.entry ?? null, sl: synth.sl ?? null,
      tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
      requestedVolume: requestedVol ?? null,
      strategy: synth.strategy || null,
      timeframe: synth.timeframe ?? null,
      conviction: synth.overall_conviction ?? null,
      sizing: synth.sizing ?? null,
      sizedVolume: synth.sizedVolume ?? null,
      source: 'htf_limit',
      accountId: accountId ?? null,
    }
  } else {
    // Lesson tuner (loop.js:701-720): the widened stop the gate will read.
    try {
      const tuned = applySlWiden({ strategy: synth.strategy, entry: synth.entry, sl: synth.sl }, loadLessonTuning(db, accountId))
      if (tuned.note) synth.sl = tuned.signal.sl
      step('lesson_decay', isDecayed(db, symbol, synth.strategy, synth.timeframe), 'alpha_decay_cooloff')
    } catch { /* tuner is optional — never blocks a trade */ }
    const trendAtEvaluation = trendReadingFor(db, symbol)
    // loop.js:758-794, field for field.
    proposal = {
      symbol,
      side,
      direction_reason: synth.direction_reason ?? null,
      trend_at_evaluation: trendAtEvaluation,
      entry: synth.entry ?? null,
      sl: synth.sl ?? null,
      tp1: synth.tp1 ?? null,
      tp2: synth.tp2 ?? null,
      requestedVolume: requestedVol,
      strategy: synth.strategy || null,
      timeframe: synth.timeframe ?? null,
      conviction: synth.overall_conviction ?? null,
      sizing: synth.sizing ?? null,
      sizedVolume: synth.sizedVolume ?? null,
      sharedAccounts: shared.n ?? null,
      source: synth.source || 'auto_signal',
      accountId,
    }
  }

  const config = risk.loadRiskConfig(db, accountId)                                                  // loop.js:795
  const result = risk.evaluateTrade(db, proposal, config)                                            // loop.js:796
  return assemble(db, {
    kind: 'scan', route, accountId, proposal, result, config, upstream,
    signal: { scanId, source: found.source, scannedAt: row.scanned_at },
    strategyGate: 'evidence_gate',
    notChecked: [
      'armed scope and the roster-wide stage gate', 'style filter', 'block_next_trade', 'fundable universe',
      'account horizon', 'account phases', 'per-account stage gate', 'profit ratchet', 'sidecar roster',
      'per-symbol strategy gate', 'market hours (account calendar)', 'entry-mode fence at the execution boundary',
      'symbol id and broker minimum volume after approval',
      ...(route === 'htf_limit' ? ['resting-limit idempotency and pending-order cap'] : ['entry-drift and spread gates at send']),
    ],
  })
}

// ---------------------------------------------------------------------------
// (ii) manual pad input
// ---------------------------------------------------------------------------

/** The freshest 1m close — the manual-order route's entry estimate (actions.js:6409-6413). */
async function brokerEntry(creds, symbolId) {
  const bars = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1m'], 5, 30_000, 0, { purpose: 'preorder' })
  const m1 = bars['1m'] || []
  return m1.length > 0 ? m1[m1.length - 1].c : null
}

async function manualPreorder(db, input, deps) {
  // The route's own validation, in its order (actions.js:6376-6391).
  const symbol = String(input.symbol || '').toUpperCase().trim()
  const side = String(input.side || '').toUpperCase()
  const { sl, tp, lots, account } = input
  if (!symbol) return bad(400, 'symbol required')
  if (side !== 'BUY' && side !== 'SELL') return bad(400, "side must be 'BUY' or 'SELL'")
  if (sl == null || sl === '' || !Number.isFinite(Number(sl))) return bad(400, 'sl (stop-loss price) required — no manual orders without a stop')
  if (account != null && account !== '' && !registered(db, account)) return bad(400, `account ${String(account)} is not in the registry`)
  const creds = account != null && account !== '' ? credsForRegisteredAccount(db, account) : getCtraderCreds(db)
  if (!creds?.ready) return cannot('cTrader credentials not configured')
  // ready:false — resolve from the stored lists only; the route's resolver
  // would FETCH and STORE a stale account's list (ctrader-creds.js:330-337).
  const resolved = await resolveSymbolId(db, { ...creds, ready: false }, symbol)
  if (!resolved.id) return cannot(`${resolved.reason || `symbol id unknown for ${symbol}`} (the dry run does not fetch and store the account's symbol list)`)
  let entry = null
  try {
    entry = await (deps.fetchEntry || brokerEntry)(creds, resolved.id)
  } catch (err) {
    return cannot(`could not fetch a current price for ${symbol} (${String(err?.message || err).slice(0, 160)})`)
  }
  if (entry == null) return cannot(`could not fetch a current price for ${symbol}`)
  const { manualDirectionReason } = await import('../routes/actions.js')
  // actions.js:6415-6427, field for field. The pad sends no directionReason.
  const proposal = {
    symbol, side, entry,
    sl: Number(sl),
    tp1: tp != null && Number.isFinite(Number(tp)) ? Number(tp) : null,
    requestedVolume: Number(lots) > 0 ? Number(lots) : 0.01,
    strategy: 'manual',
    direction_reason: manualDirectionReason(input.directionReason, side),
    conviction: null,
    source: 'manual',
    accountId: creds?.accountId ?? null,
  }
  const config = risk.loadRiskConfig(db, creds?.accountId ?? null)                                   // actions.js:6428
  const result = risk.evaluateTrade(db, proposal, config)
  return assemble(db, {
    kind: 'manual', route: 'manual_market', accountId: creds?.accountId ?? null, proposal, result, config,
    upstream: [], strategyGate: 'not_consulted',
    entrySource: { kind: 'broker_1m_close', symbolId: String(resolved.id), symbolSource: resolved.source },
    notChecked: ['broker minimum volume after approval (actions.js:6440-6446)', 'execution guard at send (actions.js:6475-6479)'],
  })
}

// ---------------------------------------------------------------------------
// the gate's figures, read from the gate
// ---------------------------------------------------------------------------

async function assemble(db, { kind, route, accountId, proposal, result, config, upstream, notChecked, strategyGate, signal = null, entrySource = null }) {
  const c = result.checks || {}
  const label = await vetoLabeller()
  const blockedUpstream = upstream.find(u => !u.ok) || null
  // FIRST BLOCK: the first dispatch step that stops this order, else the
  // gate's own veto. The gate still ran, so its numbers are reported either way.
  const firstBlock = blockedUpstream
    ? { stage: blockedUpstream.stage, reason: blockedUpstream.reason, label: label(blockedUpstream.reason) }
    : !result.approved
      ? { stage: 'risk_gate', reason: result.veto_reason, label: label(result.veto_reason) }
      : null

  const entry = num(proposal.entry)
  // The stop and target the order would carry (risk.js:2617-2631 overrides).
  const sl = result.stop_override?.sl ?? num(proposal.sl)
  const tp = result.target_override?.tp1 ?? num(proposal.tp1)
  const stopDistance = num(c.sl_distance) ?? (entry != null && sl != null ? Math.abs(entry - sl) : null)  // risk.js:2209/2235
  // Size: the approved volume; on a veto, the risk-budget size the gate had
  // reached before refusing (risk.js:2405), else nothing.
  const volume = result.approved ? num(result.adjusted_volume) : num(c.risk_based_volume)
  const volumeBasis = result.approved ? 'approved' : volume != null ? 'risk_budget_before_veto' : null
  // Money at risk: the gate's own figure when the size is its risk-budget
  // size (risk_based_usd, risk.js:2406); otherwise the size × the gate's USD
  // loss per lot on the gate's stop distance — usdLossPerLot with the gate's
  // rate table and broker lot size, the formula risk.js:2395 uses.
  let moneyAtRisk = null
  if (volume != null && volume === num(c.risk_based_volume) && num(c.risk_based_usd) != null) moneyAtRisk = num(c.risk_based_usd)
  else if (volume != null && stopDistance != null && entry != null) {
    const perLot = usdLossPerLot(proposal.symbol, stopDistance, entry, risk.scanRates(db), c.units_per_lot?.source === 'broker' ? c.units_per_lot.value : null)
    moneyAtRisk = Number.isFinite(perLot) ? round(volume * perLot) : null
  }
  // Today's stop left: the gate's own daily figure when it reached step 1
  // (risk.js:1938 → daily_budget_left_usd), else the engine's daily reader
  // (daily-stop-reading.js:68, the same dailyLossVerdict).
  let dailyStopLeft = 'daily_budget_left_usd' in c ? num(c.daily_budget_left_usd) : undefined
  let dailyUncapped = 'daily_cap_uncapped' in c ? !!c.daily_cap_uncapped : undefined
  if (dailyStopLeft === undefined && accountId != null) {
    try {
      const v = readDailyRiskVerdict(db, accountId).verdict
      dailyStopLeft = num(v.checks?.daily_budget_left_usd)
      dailyUncapped = !!v.checks?.daily_cap_uncapped
    } catch { dailyStopLeft = null }
  }
  if (dailyStopLeft === undefined) dailyStopLeft = null
  const shareOfStopLeft = moneyAtRisk != null && dailyStopLeft != null && dailyStopLeft > 0 ? round((moneyAtRisk / dailyStopLeft) * 100, 1) : null
  // Margin: the gate's own figures (risk.js:2493-2520, 2557-2559).
  let marginShare = null
  if (num(c.margin_cap_usd) != null && num(c.margin_used_usd) != null) {
    const headroom = num(c.margin_cap_usd) - num(c.margin_used_usd)
    const required = num(c.margin_required_usd)
    marginShare = {
      requiredUsd: required, usedUsd: num(c.margin_used_usd), capUsd: num(c.margin_cap_usd), headroomUsd: round(headroom),
      pctOfHeadroom: required != null && headroom > 0 ? round((required / headroom) * 100, 1) : null,
      maxPctOfHeadroom: c.margin_headroom_share?.share != null ? round(c.margin_headroom_share.share * 100, 1) : null,
    }
  }
  let openPositions = num(c.open_positions)                                                          // risk.js:1955
  if (openPositions == null && accountId != null) {
    try { openPositions = risk.countedPositionsWithTickFires(db, accountId).counted.length } catch { openPositions = null }
  }
  let rrFloor = null
  try { rrFloor = risk.effectiveRrFloor(db, accountId, proposal.strategy) } catch { rrFloor = null } // risk.js:705

  return {
    ok: true,
    kind,
    route,
    accountId: accountId != null ? String(accountId) : null,
    approved: !firstBlock,
    firstBlock,
    gate: {
      approved: !!result.approved,
      vetoReason: result.veto_reason ?? null,
      sizingNote: result.sizing_note ?? null,
      adjustedVolume: num(result.adjusted_volume),
      stopOverride: result.stop_override ?? null,
      targetOverride: result.target_override ?? null,
    },
    checks: c,
    numbers: {
      entry, sl, tp,
      rr: num(c.rr),
      rrFloor,
      stopDistance,
      volume, volumeBasis,
      moneyAtRisk,
      // Every money figure above is the gate's unit: USD (risk.js:1723-1732).
      currency: 'USD',
      dailyStopLeft,
      dailyStopUncapped: dailyUncapped ?? null,
      shareOfStopLeft,
      marginShare,
      openPositions,
      maxPositions: num(config?.maxOpenPositions),
    },
    strategy: strategyRecord(db, { strategy: proposal.strategy, accountId, gate: strategyGate }),
    expectedR: EXPECTED_R_NOT_COMPUTED,
    proposal,
    upstream,
    notChecked,
    ...(signal ? { signal } : {}),
    ...(entrySource ? { entrySource } : {}),
    note: 'Dry run: the risk gate evaluated this order and nothing was recorded or sent. A real order re-reads every figure at the moment it is placed.',
  }
}

/**
 * The strategy's last 20 closes on this account — the evidence gate's own
 * population (clean bot closes with known P&L, the account's rows plus
 * unscoped legacy rows, over its window: evidence-gate.js:63) and its own
 * summariser (summarizeEvidence, evidence-gate.js:90) — and what admits it.
 */
function strategyRecord(db, { strategy, accountId, gate }) {
  if (!strategy) return { key: null, last20: null, allowedBy: 'unlabelled', allowed: false }
  let last20 = null
  try {
    const cfg = loadEvidenceGate(db)
    const rows = evidenceRows(db, { strategy: String(strategy), accountId, windowDays: cfg.windowDays })
    const s = summarizeEvidence(rows.slice(-20))
    last20 = { n: s.closes, winRatePct: s.winRate, profitFactor: s.profitFactor, windowDays: cfg.windowDays }
  } catch { last20 = null }
  if (gate !== 'evidence_gate') {
    return { key: String(strategy), last20, allowedBy: 'not_consulted', allowed: null, note: 'the manual-order route does not consult the evidence gate' }
  }
  let eg = null
  try { eg = evidenceGate(db, { strategy, accountId }) } catch { eg = null }
  return { key: String(strategy), last20, allowedBy: eg?.via ?? 'unreadable', allowed: eg ? !!eg.allowed : null }
}
