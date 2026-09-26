// ---------------------------------------------------------------------------
// agent/services/fast-monitor.js — fast, volume-aware monitoring of OPEN
// positions between the 5-minute main-loop cycles.
//
// Owner (2026-07-17): "for an active position, monitoring for that
// instrument reduces from 5 minutes to # minutes — and is also based on
// active market volume." So:
//
// - A dedicated ticker (3s by default; startFastMonitor) runs alongside the main loop.
// - Each ACTIVE bot position gets its own cadence:
//     cadence = base (`monitor_interval_min`, default 1m) scaled by the
//     instrument's relative 1-minute volume — busy market → base interval,
//     average → 2×, quiet → 3×. cadenceMs() is the pure, tested policy.
// - A due position is re-priced from a live spot quote and run through the
//   SAME deterministic rules the main loop uses (evaluatePosition →
//   executeBrokerAction): time caps, SL/TP breaches, invalidations now act
//   within about a minute instead of five.
// - External positions stay observe-only; Live Tweak & Close (stage matrix)
//   is honoured; the broker-resident SL/TP remains the tick-level backstop.
//
// Relative volume is refreshed lazily (at most once per 5 minutes per
// symbol, 20×1m bars) so the fast path stays light on the broker API.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { recordDecision } from './decision-log.js'
import { evaluatePosition } from './position-manager.js'
import { rulesForSymbol } from './asset-controllers.js'
import { applyManagedRules } from './managed-exit.js'
import { cachedAtrForSymbol } from './profit-keeper.js'
import { manageStageAllows } from './stage-matrix.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import { BoundedMap } from '../lib/bounded-map.js'
import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { performance } from 'node:perf_hooks'
import { stampFirst, noteBudgetOverrun } from './runtime-record.js'
import { noteDueLateness, latenessEligibility } from './protection-latency.js'
import { recordLimitFillSpread, isPreFill } from './limit-fill-spread.js'
import { ProbeScheduler, probeCap, probeBackoffMs, sideHasFreshQuoteExcluding, selectUnderCap, clampCap } from '../lib/fast-monitor-probes.js'

// ---------------------------------------------------------------------------
// PER-POSITION RECEIPT TIMINGS (V3 M1, P1/P4-1). A pass that re-prices a due
// position writes WHERE its time went: the quote (lastPricingMs — ~0 from the
// sidecar, up to the 6 s broker timeout on a stale or missing quote), which
// source and why (lastQuotePick: sidecar | stale | missing), the outcome, and
// the relVol trendbar fetch (lastVolFetchMs) with the part of it spent parked
// on the shared 4/s historical token bucket (lastTokenWaitMs; null when the
// fetch never reached that step). The #1085 boot's first pass took 43 s, more
// than four 6 s probes — the fetch and the bucket are the candidates, and
// until now nothing measured them.
//
// CARRIED ACROSS not_due PASSES. The tick runs every 3 s and a position is
// due every minute or more, so the receipt was rewritten ~20 times between
// two pricings with all of this blank. Each receipt now starts from the
// preceding one's last* fields; only a pass that actually prices or fetches
// replaces them.
// ---------------------------------------------------------------------------
export const RECEIPT_CARRY_FIELDS = Object.freeze([
  'lastPricedAt', 'lastPricingMs', 'lastQuoteSource', 'lastQuotePick', 'lastOutcome',
  'lastVolFetchAt', 'lastVolFetchMs', 'lastTokenWaitMs',
])
/** The last* fields of the preceding receipt (nulls when there is none). Pure. */
export function carryReceipt(prior) {
  const out = {}
  for (const k of RECEIPT_CARRY_FIELDS) out[k] = prior?.[k] ?? null
  return out
}

// ---------------------------------------------------------------------------
// QUOTES FROM THE SIDECAR (19-09-2026). The tick re-priced every due position
// with its own broker round trip (wsGetSpotOnce, serially) while the sidecar
// already held a live spot subscription for the same symbols. Measured before
// this change: a tick with nothing due took 2 ms, the worst tick in ten
// minutes 51 s, skipShare10m 0.45–0.75 against the goal table's ≤ 10 %. Now
// each tick makes ONE pull per side that has positions (GET /quotes) and
// prices from it; the broker call is the fallback, taken exactly as before
// when the sidecar has no quote for the symbol or its quote is older than
// QUOTE_MAX_AGE_MS (measured on recvMs, the sidecar's receipt clock — the
// broker's own timestamp can be minutes old on a quiet symbol and still be
// the current price).
// ---------------------------------------------------------------------------
export const QUOTE_MAX_AGE_DEFAULT_MS = 10_000
export function quoteMaxAgeMs(env = process.env) {
  const n = Number(env.FAST_MONITOR_QUOTE_MAX_AGE_MS)
  return n > 0 ? n : QUOTE_MAX_AGE_DEFAULT_MS
}

/**
 * Pure: the sidecar's quote for `symbolId` when it is usable. The age is
 * `ageMs` when the body carried the sidecar's own `nowMs` (one clock:
 * checker SHOULD 4 — the sidecar's system_clock and Node's Date.now() can
 * differ by seconds), else nowMs - recvMs on Node's clock (an older sidecar).
 * @returns {{quote: {bid:number, ask:number}|null, source: 'sidecar'|'stale'|'missing'}}
 */
export function pickSidecarQuote(quotes, symbolId, nowMs, maxAgeMs = QUOTE_MAX_AGE_DEFAULT_MS) {
  const q = quotes?.get?.(Number(symbolId))
  if (!q || !Number.isFinite(q.bid) || !Number.isFinite(q.ask) || !(q.bid > 0) || q.ask < q.bid) return { quote: null, source: 'missing' }
  const age = Number.isFinite(q.ageMs) ? q.ageMs : Number.isFinite(q.recvMs) ? nowMs - q.recvMs : Infinity
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return { quote: null, source: 'stale' }
  return { quote: { bid: q.bid, ask: q.ask }, source: 'sidecar' }
}

/**
 * A /quotes body → Map symbolId → {bid, ask, tsMs, recvMs, ageMs}; empty when
 * the feed is absent or the body null. ageMs = body.nowMs - recvMs on the
 * sidecar's clock, null when the body carries no nowMs.
 */
export function quoteMapFrom(body) {
  const m = new Map()
  if (!body || body.feed === 'absent' || !Array.isArray(body.quotes)) return m
  const nowMs = Number(body.nowMs)
  for (const q of body.quotes) {
    const id = Number(q?.symbolId)
    if (!(id > 0)) continue
    const recvMs = Number(q.recvMs) || 0
    m.set(id, {
      bid: q.bid == null ? null : Number(q.bid), ask: q.ask == null ? null : Number(q.ask),
      tsMs: Number(q.tsMs) || 0, recvMs,
      ageMs: Number.isFinite(nowMs) && nowMs > 0 && recvMs > 0 ? nowMs - recvMs : null,
    })
  }
  return m
}

/**
 * The symbol id to look the position up by on its side's sidecar — in the
 * FEED ACCOUNT's id space, because that is the account the feed subscribed
 * as and the space its quote table is keyed in. The sidecar reports it on
 * every /quotes answer (`accountId`): whichever account made the first
 * /connect on that side and stayed in the roster — NOT necessarily what
 * Node calls primary (checker round 2: a non-primary dispatch can make the
 * first /connect, and the selected account can switch later).
 *
 * CHECKER BLOCKER 1 (19-09-2026, round 1): the first cut used the POSITION's
 * own account map. cTrader ids are per account (ctrader-creds.js, 03-09):
 * with the feed account mapping {EURUSD:1, GBPUSD:2} and a same-side account
 * 333 mapping EURUSD→2 in its own space, a EURUSD position on 333 was priced
 * from GBPUSD's quote and the monitor logged a PARTIAL_EXIT on a fictitious
 * +16R. So: the feed account's map (`symbol_id_map:<feedAccountId>`; the
 * global map only when the feed account is the one the global map was built
 * from, `ctrader_account_id`); the position's own id must AGREE with it — a
 * non-primary account with no map on file, or whose own id for the name
 * differs, is not looked up (null → the broker round trip, as before this
 * change). No feed account, or a feed account with no map → null too.
 */
export function sidecarSymbolIdFor(db, pos, globalMap, primaryId, cache = new Map(), feedAccountId = null) {
  const sym = String(pos.symbol || '').toUpperCase()
  const acct = pos.account_id != null ? String(pos.account_id) : null
  const feedAcct = feedAccountId != null ? String(feedAccountId) : null
  if (feedAcct == null) return null
  // the feed's space
  const feedMap = accountMap(db, feedAcct, cache) ?? (primaryId != null && String(primaryId) === feedAcct ? globalMap : null)
  const feedId = feedMap?.[sym]
  if (!(Number(feedId) > 0)) return null
  // the position's own space must agree
  if (acct == null || acct === feedAcct) return Number(feedId)
  const own = accountMap(db, acct, cache) ?? (primaryId != null && String(primaryId) === acct ? globalMap : null)
  const ownId = own?.[sym]
  return Number(ownId) === Number(feedId) ? Number(feedId) : null
}
function accountMap(db, acct, cache) {
  if (cache.has(acct)) return cache.get(acct)
  let m = null
  try { m = getAccountSymbolMap(db, acct)?.map ?? null } catch { m = null }
  cache.set(acct, m)
  return m
}

/**
 * Pure cadence policy: milliseconds between checks for one position.
 * relVol = latest 1m volume ÷ average of the previous bars (NaN = unknown).
 */
export function cadenceMs(relVol, baseMinutes) {
  const base = Math.max(0.5, Number(baseMinutes) || 1) * 60_000
  if (!Number.isFinite(relVol)) return base * 2 // unknown volume → middle pace
  if (relVol >= 1.5) return base                // busy market → fastest
  if (relVol >= 0.75) return base * 2
  return base * 3                               // quiet market → slowest
}

/**
 * Owner override map (agent_state monitor_overrides_json): SYMBOL → minutes.
 * An override REPLACES the volume-adaptive cadence for that symbol — the
 * owner's word beats the volume read (faster ticker for some, throttle for
 * others). Cleared symbols fall back to auto.
 */
export function loadMonitorOverrides(db) {
  try {
    const parsed = JSON.parse(getState(db, 'monitor_overrides_json') || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** Effective cadence: owner override (minutes) wins; otherwise volume-adaptive. */
export function effectiveCadenceMs(overrideMin, relVol, baseMin) {
  const ov = Number(overrideMin)
  if (Number.isFinite(ov) && ov > 0) return Math.max(15_000, ov * 60_000)
  return cadenceMs(relVol, baseMin)
}

/** relVol from 1m bars: last CLOSED bar's volume vs the average before it. */
export function relVolFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 6) return NaN
  const closed = bars.slice(0, -1) // drop the forming bar
  const last = closed[closed.length - 1]
  const prior = closed.slice(0, -1)
  const avg = prior.reduce((n, b) => n + (b.v || 0), 0) / prior.length
  if (!(avg > 0)) return NaN
  return (last.v || 0) / avg
}

// Owner: "if the market volume is active... if sudden dip or spike what must
// you do?" A spike is a % move since the LAST check that's too fast for the
// elapsed time — pure math over data this ticker already fetches (no extra
// broker call), so it costs nothing to check every tick. SPIKE_HOLD_MS keeps
// a symbol at the fastest cadence for a while after a spike even if relVol
// itself hasn't caught up yet (relVol is a 5min-stale lagging read; a spike
// is the leading signal that a symbol just became "busy").
export const SPIKE_PCT_PER_MIN = 0.4 // % move per minute that counts as a spike
const SPIKE_HOLD_MS = 5 * 60_000

/** True when `mid` moved fast enough since (`prevMid`,`prevAt`) to be a spike. */
export function isSpikeMove(prevMid, prevAt, mid, now, pctPerMin = SPIKE_PCT_PER_MIN) {
  if (prevMid == null || !(prevMid > 0) || mid == null || !(prevAt < now)) return false
  const elapsedMin = Math.max(1 / 60, (now - prevAt) / 60_000) // floor at 1s — avoids a divide-by-near-zero false spike
  const movePct = Math.abs(mid - prevMid) / prevMid * 100
  return (movePct / elapsedMin) >= pctPerMin
}

// Hardening batch (owner-approved build 6a): a quote that stops MOVING while
// its market is open is a different failure from a quote that stops ARRIVING —
// wsGetSpotOnce keeps succeeding, mid stays non-null, every layer looks
// healthy, yet SL/TP decisions are being made on a fossil price (frozen feed,
// stale symbol subscription, broker-side halt). Track the last DISTINCT mid
// per held symbol; unchanged past the threshold while the market is open →
// one owner alert per freeze episode, cleared the moment the price moves.
export const FROZEN_QUOTE_DEFAULT_MIN = 10

/**
 * Pure episode tracker. rec = { mid, changedAt, alerted } | undefined.
 * Returns { rec, alert, recovered } — alert fires at most once per episode.
 */
export function frozenQuoteUpdate(rec, mid, nowMs, thresholdMs) {
  if (!rec || rec.mid !== mid) {
    return { rec: { mid, changedAt: nowMs, alerted: false }, alert: false, recovered: !!rec?.alerted }
  }
  if (!rec.alerted && thresholdMs > 0 && nowMs - rec.changedAt >= thresholdMs) {
    return { rec: { ...rec, alerted: true }, alert: true, recovered: false }
  }
  return { rec, alert: false, recovered: false }
}

// Per-position pacing + per-symbol volume cache. In-memory: a restart just
// re-checks everything once, which is safe.
//
// #123: BOUNDED, because two of these are keyed by POSITION ID and position
// ids are minted per fill and never reused. Plain Maps here gained an entry
// for every position this process ever saw and lost none — a slow leak with
// no ceiling in a process that stays up for weeks, and one with no alarm,
// because a Map does not complain. Eviction is oldest-first rather than a
// flush, for the reason profit-keeper's ATR cache spells out: emptying a warm
// cache at its ceiling stampedes whatever refills it.
//
// The two position-keyed maps are deliberately NOT lru: re-reading "when did
// I last check this position" must not keep a stale entry alive ahead of a
// newer one. The symbol-keyed caches are lru, because there a recent read
// genuinely is evidence the entry is worth keeping.
const POS_MAP_MAX = 2_000     // ~a fortnight of fills on this desk's volume
const SYM_MAP_MAX = 500       // the instrument universe, with headroom
const lastCheckAt = new BoundedMap(POS_MAP_MAX, { name: 'fast_monitor.lastCheckAt' })  // position id → ms
const lastPriceAt = new BoundedMap(POS_MAP_MAX, { name: 'fast_monitor.lastPriceAt' })  // position id → { mid, at }
const spikeUntil = new BoundedMap(SYM_MAP_MAX, { lru: true, name: 'fast_monitor.spikeUntil' })   // symbol → ms
const volCache = new BoundedMap(SYM_MAP_MAX, { lru: true, name: 'fast_monitor.volCache' })       // symbol → { relVol, at }
const quoteFreeze = new BoundedMap(SYM_MAP_MAX, { lru: true, name: 'fast_monitor.quoteFreeze' }) // symbol → { mid, changedAt, alerted }
const VOL_TTL_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). ONE process-wide scheduler so the cap and
// the backoff apply across ticks, exactly like the caches above. See
// `../lib/fast-monitor-probes.js` for the mechanics and what OD-22 leaves
// open (the quiet-symbol-in-an-open-market staleness rule).
// ---------------------------------------------------------------------------
const probeScheduler = new ProbeScheduler({ cap: probeCap(), backoffMs: probeBackoffMs() })
export function _resetFastMonitorProbeSchedulerForTests() { probeScheduler.reset() }
/** Test seam: the cap is normally fixed at process start (env-read once); a test overrides it directly to pin cap behaviour without an env-driven re-import. */
export function _setFastMonitorProbeCapForTests(n) { probeScheduler.cap = clampCap(n) }

/** Sizes and evictions for /state/route-timings-adjacent diagnostics. */
export function fastMonitorMapStats() {
  return [lastCheckAt, lastPriceAt, spikeUntil, volCache, quoteFreeze].map(m => m.stats())
}

// ---------------------------------------------------------------------------
// TRANSITION-GATED DECISION ROWS (owner invariant 1, 31-08-2026).
//
// This monitor runs every 30s over every open position and, until now, its
// skip decisions — "manage stage off for this strategy", "symbol not in the
// map", "no quote" — left NO durable trace: a position could be silently
// unmonitored for a whole session and the decision log would not know. The
// fix is NOT a row per tick (that is 2,880 rows/day/position of noise); it
// is a row per state CHANGE: entering a skip state writes one 'skip' row,
// returning to normal writes one 'proceed' row. In-memory keyed by position
// id; a restart re-announces current skip states once, which is honest.
// ---------------------------------------------------------------------------
const decisionState = new BoundedMap(POS_MAP_MAX, { name: 'fast_monitor.decisionState' }) // position id → state string
export function noteFastDecision(db, pos, state, reason) {
  const prev = decisionState.get(pos.id)
  if (prev === state) return
  decisionState.set(pos.id, state)
  // First sight in the normal state is not a decision worth a row — only
  // entering a skip state, or RECOVERING from one, changes what is true.
  if (prev === undefined && state === 'active') return
  // recordDecision never throws (its own contract).
  recordDecision(db, {
    accountId: pos.account_id != null ? String(pos.account_id) : undefined,
    symbol: pos.symbol, strategy: pos.strategy || null,
    stage: 'fast_monitor',
    decision: state === 'active' ? 'proceed' : 'skip',
    reason: state === 'active' ? `monitoring resumed (was: ${prev})` : reason,
    detail: { positionId: pos.id, state, prev: prev ?? null },
  })
}
// Exported for tests: transitions are process-memory; a test needs a clean slate.
export function _resetFastDecisionStateForTests() { decisionState.clear() }

let running = false

/** One tick. Deps injectable for tests: { ws, exec: {executeBrokerAction, prepareStatements}, now }. */
export async function runFastMonitor(db, creds, deps = {}) {
  if (running) return { skipped: 'busy' }
  running = true
  try {
    if (!creds?.ready) return { skipped: 'no creds' }
    const now = deps.now ?? (() => Date.now())
    const baseMin = Number(getState(db, 'monitor_interval_min')) || 1

    const loopMod = deps.loop ?? await import('../loop.js')
    const s = loopMod.prepareStatements(db)
    const positions = db.prepare(
      `SELECT * FROM monitored_positions WHERE status = 'active' AND paused IS NOT 1`
    ).all()
    if (positions.length === 0) {
      setState(db, POSITION_WORK_KEY, JSON.stringify({ version: 1, at: new Date(now()).toISOString(), positions: [], complete: true }))
      return { skipped: 'no positions', checked: 0, completed: true }
    }

    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const symbolMap = (() => { try { return JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { return {} } })()
    const overrides = loadMonitorOverrides(db)

    // ONE /quotes pull per side that has positions (see the header block).
    // A position's side is its account's registry row; no row → the creds'
    // side. The pull is bounded (2 s) and any failure is an empty map, i.e.
    // the broker fallback for every position — never a skipped check.
    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const maxAgeMs = deps.quoteMaxAgeMs ?? quoteMaxAgeMs()
    const primaryId = getState(db, 'ctrader_account_id')
    const acctLive = new Map()
    try { for (const r of db.prepare('SELECT account_id, is_live FROM accounts').all()) acctLive.set(String(r.account_id), r.is_live === 1) } catch { /* no registry → creds side */ }
    const sideOf = (pos) => {
      const acct = pos.account_id != null ? String(pos.account_id) : null
      const known = acct != null ? acctLive.get(acct) : undefined
      return typeof known === 'boolean' ? known : (typeof creds.isLive === 'boolean' ? creds.isLive : null)
    }
    const acctMapCache = new Map()
    // The sides with a position to price. The WHOLE table is pulled per
    // side (no ids filter): the lookup ids live in the feed account's space,
    // and which account that is only the answer says (`accountId`). The
    // table is the feed's subscription — tens of symbols — so the filter
    // would save nothing worth a second round trip.
    const sidecarSides = new Set()
    for (const pos of positions) {
      if (pos.source === 'external') continue
      sidecarSides.add(String(sideOf(pos)))
    }
    // The sides are pulled CONCURRENTLY (checker SHOULD 3): two hung sidecars
    // cost one timeout before the first position is priced, not two.
    const quotesBySide = new Map()   // side key → Map symbolId → quote
    const feedAccountBySide = new Map() // side key → the feed's account (its id space), or null
    await Promise.all([...sidecarSides].map(async (key) => {
      const isLive = key === 'true' ? true : key === 'false' ? false : null
      let body = null
      try { body = typeof exec.sidecarQuotes === 'function' ? await exec.sidecarQuotes(isLive) : null } catch { body = null }
      quotesBySide.set(key, quoteMapFrom(body))
      feedAccountBySide.set(key, body && body.feed !== 'absent' && body.accountId != null ? String(body.accountId) : null)
    }))
    const lookupId = (pos) => sidecarSymbolIdFor(db, pos, symbolMap, primaryId, acctMapCache, feedAccountBySide.get(String(sideOf(pos))) ?? null)
    const quoteCounts = { fromSidecar: 0, fromBroker: 0, stale: 0 }

    let previous = []
    try { previous = JSON.parse(getState(db, POSITION_WORK_KEY) || '{}').positions || [] } catch { /* no preceding receipt */ }
    const previousById = new Map((Array.isArray(previous) ? previous : []).map(p => [`${p.accountId}:${p.positionId}`, p]))
    const work = []
    let checked = 0
    let acted = 0
    // Durations on the monotonic clock: `now` may be a test's fixed clock.
    const mono = deps.monoNow ?? (() => performance.now())
    const timing = { priced: 0, pricingMs: 0, brokerQuotes: 0, volFetches: 0, volFetchMs: 0, tokenWaitMs: 0 }

    // M7: positions whose broker fallback probe could not be resolved
    // inline this pass (the scheduler said 'eligible' — a real network call
    // is needed) are finished here, after the PARALLEL BATCH below runs.
    const probeBatch = []

    // Everything that happens once a position HAS a quote (sidecar, a
    // resolved probe, or a reused backoff/pending result): unchanged from
    // before M7, just extracted so both the inline path (sidecar hit,
    // backoff, pending) and the deferred batch path (a fresh broker probe)
    // call the same code.
    const finishWithQuote = async (pos, receipt, q, feedKey, prior, noQuoteReason) => {
      // V3 PO-M3: the spread at a resting limit's fill, from the quote this
      // pass already holds — the first Node can read after the fill. Record
      // only; never throws, never changes what the pass does next.
      if (isPreFill(pos)) recordLimitFillSpread(db, pos, { quote: q, source: receipt.quoteSource, nowMs: now(), reason: 'quote unavailable (market closed or feed gap)' })
      const mid = Number.isFinite(q?.bid) && Number.isFinite(q?.ask) && q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : null
      if (mid == null) {
        receipt.lastOutcome = 'quote_unavailable'
        receipt.state = 'quote_unavailable'
        // B2 (fix round, 26-09-2026): a cap-deferred position gets its own
        // reason, distinguishable in the decision log from an ordinary
        // no-quote pause — it was never even attempted this pass.
        noteFastDecision(db, pos, 'no_quote', noQuoteReason ?? `${pos.symbol}: no quote (market closed or feed gap) — checks paused`)
        return
      }
      noteFastDecision(db, pos, 'active')

      // Frozen-quote watch (FROZEN_QUOTE_MIN, minutes; 0 disables). Only
      // while the market is open — a flat weekend quote is normal, not a
      // frozen feed. One alert per episode, self-clearing on movement.
      const frozenMin = Number(process.env.FROZEN_QUOTE_MIN ?? FROZEN_QUOTE_DEFAULT_MIN)
      if (frozenMin > 0) {
        const fq = frozenQuoteUpdate(quoteFreeze.get(feedKey), mid, now(), frozenMin * 60_000)
        quoteFreeze.set(feedKey, fq.rec)
        if (fq.alert) {
          let open = true
          try { open = isSymbolOpenCached(db, pos.symbol).open !== false } catch { /* unknown → assume open, alert */ }
          if (open) {
            const mins = Math.round((now() - fq.rec.changedAt) / 60_000)
            const msg = `🧊 Frozen quote: ${pos.symbol} has printed ${mid} unchanged for ${mins}m while its market is open — SL/TP decisions may be running on a stale feed. Held position ${pos.side} from ${pos.entry_price}.`
            console.warn(`[fast-monitor] ${msg}`)
            import('./telegram-control.js').then(m => m.notifyOwner(msg)).catch(() => {})
          } else {
            // Closed market → not a freeze; restart the episode quietly.
            quoteFreeze.set(feedKey, { mid, changedAt: now(), alerted: false })
          }
        } else if (fq.recovered) {
          console.log(`[fast-monitor] ${pos.symbol}: quote moving again after freeze`)
        }
      }

      const prevPrice = lastPriceAt.get(pos.id)
      if (isSpikeMove(prevPrice?.mid, prevPrice?.at, mid, now())) {
        spikeUntil.set(feedKey, now() + SPIKE_HOLD_MS)
        console.log(`[fast-monitor] ${pos.symbol}: volatility spike detected — fast-tracking checks for ${Math.round(SPIKE_HOLD_MS / 60000)}m`)
      }
      lastPriceAt.set(pos.id, { mid, at: now() })

      // applyManagedRules, same as the slow monitor: this evaluator ran the
      // raw per-symbol ladder until 2026-08-31, when bank_target_4R closed
      // 0016.HK one minute after HK open — beating the managed trail the
      // slow loop would have applied 30s later. One ruleset, every evaluator.
      const eval_ = evaluatePosition(pos, {
        currentPrice: mid,
        rules: applyManagedRules(db, pos.account_id, rulesForSymbol(db, pos.symbol), { strategy: pos.strategy }),
        // Same cached ATR the slow monitor reads (PR-J). One ruleset, one
        // trail basis, every evaluator — the 0016.HK lesson.
        atr: cachedAtrForSymbol(db, pos.symbol),
      })
      s.updatePositionMetrics.run(
        eval_.updates.mfe_r ?? pos.mfe_r ?? 0,
        eval_.updates.mae_r ?? pos.mae_r ?? 0,
        eval_.updates.be_moved ?? pos.be_moved ?? 0,
        eval_.updates.scaled_out ?? pos.scaled_out ?? 0,
        pos.id,
      )
      checked++
      // V3 M5: the due time this evaluation answers — the carried
      // nextDueAt, read before it is re-armed below.
      const dueAtMs = Date.parse(receipt.nextDueAt ?? '')
      receipt.state = 'evaluated'
      receipt.lastOutcome = 'evaluated'
      receipt.action = eval_.action
      receipt.lastCompletedAt = new Date(now()).toISOString()
      receipt.nextDueAt = new Date(now() + receipt.cadenceMs).toISOString()
      // Due → evaluated lateness, kept only when the gap began with an
      // evaluation (latenessEligibility); the amend below carries it too,
      // so its round trip is recorded as one composite.
      const evaluatedAtMs = Date.parse(receipt.lastCompletedAt)
      const lateOk = latenessEligibility(prior)
      noteDueLateness({ dueAtMs, evaluatedAtMs, ...lateOk })
      const dueTiming = lateOk.eligible ? { dueAtMs, evaluatedAtMs } : { dueAtMs: null, evaluatedAtMs }
      if (eval_.action === 'HOLD') {
        // Same truthfulness fix as the main loop's monitor phase (owner:
        // "why are you not monitoring") — a HOLD verdict used to write
        // nothing, so a position checked every 30-90s for hours looked
        // identical in the UI to one that was never touched.
        s.updatePositionCheck.run('FAST:HOLD', eval_.reason, new Date().toISOString(), 'intact', pos.id)
        // fix-the-exits BB: a cap HOLD carries its stamp (same helper).
        loopMod.stampExitMarks(s, pos, eval_, null)
        return
      }
      const outcome = await loopMod.executeBrokerAction(db, s, pos, eval_, 'fast_monitor', dueTiming)
      // PR-J stamps from the OUTCOME, same helper as the slow monitor.
      loopMod.stampExitMarks(s, pos, eval_, outcome)
      acted++
      receipt.actionOutcome = outcome.error ? 'error' : outcome.skipped ? 'skipped' : 'reported_success'
      receipt.error = outcome.error || null
      const summary = outcome.error
        ? `${eval_.reason} | broker_error: ${outcome.error}`
        : outcome.skipped
          ? `${eval_.reason} | intent_only: ${outcome.reason}`
          : `${eval_.reason} | broker: ${outcome.summary}`
      s.updatePositionCheck.run(
        `FAST:${eval_.action}`,
        summary,
        new Date().toISOString(),
        eval_.action === 'FULL_EXIT' ? 'broken' : 'intact',
        pos.id,
      )
      console.log(`[fast-monitor] ${pos.symbol}: ${eval_.action} — ${summary}`)
    }

    for (const pos of positions) {
      const accountId = pos.account_id != null ? String(pos.account_id) : String(creds.accountId)
      const prior = previousById.get(`${accountId}:${pos.id}`)
      const receipt = { accountId, positionId: pos.id, brokerPositionId: pos.broker_position_id ?? null,
        symbol: pos.symbol, strategy: pos.strategy, owner: 'node_fast_monitor',
        lastCompletedAt: prior?.lastCompletedAt ?? null, nextDueAt: prior?.nextDueAt ?? null,
        lastAttemptAt: null, state: 'not_due', quoteSource: null, error: null,
        ...carryReceipt(prior) }
      work.push(receipt)
      let pricingStart = null
      let priced = false
      const finishPricing = (pickSource) => {
        if (priced || pricingStart == null) return
        priced = true
        const ms = Math.round(mono() - pricingStart)
        receipt.lastPricedAt = new Date(now()).toISOString()
        receipt.lastPricingMs = ms
        receipt.lastQuoteSource = receipt.quoteSource
        receipt.lastQuotePick = pickSource ?? null
        timing.priced++
        timing.pricingMs += ms
        if (receipt.quoteSource === 'broker') timing.brokerQuotes++
      }
      try {
        if (pos.source === 'external') { receipt.state = 'observe_only'; continue }
        if (!manageStageAllows(db, getState, pos.strategy)) {
          // V3 PO-M3: a new PRE fill this pass will not price still gets a
          // record, with the reason no quote was read. Record only.
          if (isPreFill(pos)) recordLimitFillSpread(db, pos, { nowMs: now(), reason: 'not priced: management off for this strategy' })
          receipt.state = 'manage_off'
          noteFastDecision(db, pos, 'manage_off', `Live Tweak & Close is OFF for strategy '${pos.strategy}' — position unmonitored by this pass`)
          continue
        }
        const ownMap = accountMap(db, accountId, acctMapCache)
          ?? ((primaryId == null || String(primaryId) === accountId) && String(creds.accountId) === accountId ? symbolMap : null)
        const knownSide = acctLive.get(accountId)
        const host = typeof knownSide === 'boolean' ? (knownSide ? 'live.ctraderapi.com' : 'demo.ctraderapi.com')
          : accountId === String(creds.accountId) ? creds.host : null
        const symbolId = ownMap?.[String(pos.symbol).toUpperCase()]
        const feedKey = `${host}:${accountId}:${symbolId}`
        if (!host) { receipt.state = 'account_route_unknown'; continue }
        if (!symbolId) {
          receipt.state = 'symbol_unmapped'
          noteFastDecision(db, pos, 'symbol_unmapped', `${pos.symbol} not in symbol_id_map — no quote, no checks`)
          continue
        }

        // Cadence: owner per-symbol override wins; otherwise volume-aware
        // (relVol cached per symbol for 5 minutes — skipped entirely when an
        // override pins the pace, sparing the bar fetch).
        const overrideMin = overrides[String(pos.symbol).toUpperCase()]
        let relVol = NaN
        if (!(Number(overrideMin) > 0)) {
          let vc = volCache.get(feedKey)
          if (!vc || now() - vc.at > VOL_TTL_MS) {
            // V3 M1: timed, with the token-bucket wait reported by the
            // historical step itself (null when it never reached that step).
            let tokenWaitMs = null
            const volStart = mono()
            try {
              const byTf = await ws.wsGetTrendbarsBatch(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, symbolId, ['1m'], 21, 15_000, 0,
                { onTokenWait: (ms) => { tokenWaitMs = (tokenWaitMs ?? 0) + (Number(ms) || 0) }, purpose: 'fast_monitor_volume' })
              relVol = relVolFromBars(byTf['1m'] || [])
            } catch { /* unknown volume → middle pace */ }
            const volMs = Math.round(mono() - volStart)
            receipt.lastVolFetchAt = new Date(now()).toISOString()
            receipt.lastVolFetchMs = volMs
            receipt.lastTokenWaitMs = tokenWaitMs == null ? null : Math.round(tokenWaitMs)
            timing.volFetches++
            timing.volFetchMs += volMs
            timing.tokenWaitMs += Math.round(tokenWaitMs ?? 0)
            vc = { relVol, at: now() }
            volCache.set(feedKey, vc)
          }
          relVol = vc.relVol
          // A recent spike is a leading signal relVol (5min-stale) hasn't
          // caught up to yet — hold this symbol at the fastest cadence
          // regardless of what the lagging volume read says.
          const spikeExpiry = spikeUntil.get(feedKey)
          if (spikeExpiry && now() < spikeExpiry) relVol = Math.max(relVol || 0, 2)
        }
        // During an active spike window the per-position cadence is bypassed
        // entirely — the position re-prices on EVERY ticker tick (default 3s)
        // so profit-banking/exit rules act inside the spike, not after it
        // (owner 2026-07-24: sub-3-second spike losses).
        const spikeActive = (spikeUntil.get(feedKey) || 0) > now()
        const due = spikeActive ||
          now() - (lastCheckAt.get(pos.id) || 0) >= effectiveCadenceMs(overrideMin, relVol, baseMin)
        receipt.cadenceMs = effectiveCadenceMs(overrideMin, relVol, baseMin)
        if (!receipt.nextDueAt) receipt.nextDueAt = new Date(now()).toISOString()
        if (!due) continue
        receipt.lastAttemptAt = new Date(now()).toISOString()
        // B2 (fix round, 26-09-2026): lastCheckAt (the cadence gate) is no
        // longer stamped here unconditionally. A position that ends up
        // DEFERRED by the cap below never got a this-pass verdict at all —
        // stamping it here would make the cadence gate believe it was just
        // checked, starving it behind the same head-of-line symbols every
        // pass. It is stamped instead at each point below where the
        // position actually gets an outcome this pass (sidecar hit,
        // backoff/pending no-quote, or an actually-launched probe).

        // Sidecar first (fresh within maxAgeMs on the sidecar's receipt
        // clock). M7 (V3-SEQUENCE:536-543, OD-22 26-09-2026): the broker
        // fallback no longer runs inline, awaited one at a time in this
        // loop — it is planned through the probe scheduler (cap + backoff)
        // and, when it must actually reach the broker, launched in the
        // PARALLEL BATCH below (after every position here has been looked
        // at), never stacked behind this position's own slot.
        pricingStart = mono()
        const sidecarId = lookupId(pos)
        const pick = sidecarId == null
          ? { quote: null, source: 'missing' }
          : pickSidecarQuote(quotesBySide.get(String(sideOf(pos))), sidecarId, now(), maxAgeMs)
        let q = pick.quote
        receipt.quoteSource = q ? 'sidecar' : 'broker'
        if (q) {
          quoteCounts.fromSidecar++
          lastCheckAt.set(pos.id, now())
          finishPricing(pick.source)
          await finishWithQuote(pos, receipt, q, feedKey, prior)
          continue
        }
        if (pick.source === 'stale') quoteCounts.stale++
        quoteCounts.fromBroker++
        // OD-22: backoff arms only when OTHER symbols on this side are
        // fresh — a quiet SYMBOL, not a feed that has gone stale altogether
        // (V3-SEQUENCE:539). The symbol being probed itself never counts.
        const sideFresh = sideHasFreshQuoteExcluding(quotesBySide.get(String(sideOf(pos))), sidecarId, now(), maxAgeMs)
        const probePlan = probeScheduler.plan(feedKey, { sideHasFreshQuote: sideFresh, nowMs: now() })
        if (probePlan === 'eligible') {
          // Resumed after the parallel batch below, not here — that IS the
          // "results used on the next pass" the spec calls for. No
          // lastCheckAt stamp here either: whether this actually launches
          // (vs. loses the cap and is deferred) is decided in the batch.
          probeBatch.push({ pos, receipt, feedKey, host, accountId, symbolId, pricingStart, finishPricing, prior, pickSource: pick.source })
          continue
        }
        // 'pending' (this key is already being probed by the batch below —
        // never a second concurrent broker call for the same symbol) or
        // 'backoff' (quiet symbol, fresh side, its LAST probe returned no
        // quote — OD-22 and the fix round, 26-09-2026: backoff arms only on
        // a no-quote result, never on a symbol whose last probe actually
        // priced it; ProbeScheduler.plan enforces this).
        //
        // B1 (fix round): NEVER reuse a cached quote for evaluation here,
        // backoff or pending alike — the checker's reproduction was exactly
        // this: a cached 1.1005 quote evaluated against a stop at 1.0950
        // while the broker had already moved to 1.0900, HOLD-ing a position
        // that should have stopped out. Take the no-quote path exactly as
        // fast-monitor did before M7: pause, no decision, no evaluation.
        // `lastQuotePick` keeps its existing stale/missing contract; the
        // probe's own state is recorded separately (`probeState`) so
        // neither masks the other.
        receipt.probeState = probePlan
        lastCheckAt.set(pos.id, now())
        finishPricing(pick.source)
        await finishWithQuote(pos, receipt, null, feedKey, prior)
      } catch (err) {
        receipt.state = 'error'
        receipt.error = err.message
        // A throw after pricing began (a broker quote that threw, an action
        // that failed) is this pass's outcome; one before it leaves the
        // carried receipt alone.
        if (pricingStart != null) {
          finishPricing(null)
          receipt.lastOutcome = 'error'
        }
        console.error('[fast-monitor]', pos.symbol, err.message)
      }
    }

    // M7 PARALLEL BATCH: every position that needed a real broker probe
    // this pass launches together, bounded by the scheduler's cap — never
    // one at a time behind the loop above (the 48-serial-round-trips shape
    // the header measured before the sidecar-first change). A symbol shared
    // by more than one position probes once.
    //
    // B2 (fix round, 26-09-2026): candidates are ordered FAIRLY before the
    // cap is applied — never-probed symbols first, then oldest-probed-first
    // — so a chronically-over-cap batch does not relaunch the same head-of-
    // list symbols pass after pass while the rest starve. `selectUnderCap`
    // itself is order-preserving; the fairness lives entirely in the order
    // it is handed (`probeScheduler.sortFair`).
    if (probeBatch.length > 0) {
      const distinctKeys = probeScheduler.sortFair([...new Set(probeBatch.map(p => p.feedKey))])
      const { launch } = selectUnderCap(distinctKeys, probeScheduler.inflightCount(), probeScheduler.cap)
      const launchSet = new Set(launch)
      const launched = new Map()
      for (const key of launchSet) {
        const item = probeBatch.find(p => p.feedKey === key)
        launched.set(key, probeScheduler.run(key, () =>
          ws.wsGetSpotOnce(item.host, creds.clientId, creds.clientSecret, creds.accessToken, item.accountId, item.symbolId), now()))
      }
      await Promise.all(launched.values())
      for (const item of probeBatch) {
        const { pos, receipt, feedKey, pricingStart: ps, finishPricing: fp, prior, pickSource } = item
        try {
          const wasLaunched = launchSet.has(feedKey)
          // 'probed' when this key was actually launched just now; 'deferred'
          // when the cap was already full and it never reached the broker
          // this pass at all — the NEXT pass's batch re-plans it (now first
          // in line, per sortFair) rather than carrying anything from here.
          // `lastQuotePick` keeps recording WHY the broker was asked
          // (stale/missing, from the sidecar pick) — the probe's own
          // probed/deferred state is separate, so neither masks the other.
          receipt.probeState = wasLaunched ? 'probed' : 'deferred'
          fp(pickSource)
          if (wasLaunched) {
            // B1: only a probe that ACTUALLY ran this pass may price the
            // position — its own fresh result, never an older cached one.
            lastCheckAt.set(pos.id, now())
            const q = probeScheduler.lastResult(feedKey)?.quote ?? null
            await finishWithQuote(pos, receipt, q, feedKey, prior)
          } else {
            // B2: a cap-deferred item was never attempted this pass — no
            // lastCheckAt stamp (it must stay due, not starve behind the
            // symbols that won the cap), no quote of any kind, and its own
            // named reason so the decision log tells the two apart.
            await finishWithQuote(pos, receipt, null, feedKey, prior, `${pos.symbol}: probe deferred (cap) — waiting for a free broker-probe slot`)
          }
        } catch (err) {
          receipt.state = 'error'
          receipt.error = err.message
          if (ps != null) { fp(null); receipt.lastOutcome = 'error' }
          console.error('[fast-monitor]', pos.symbol, err.message)
        }
      }
    }

    setState(db, POSITION_WORK_KEY, JSON.stringify({ version: 1, at: new Date(now()).toISOString(),
      positions: work.slice(0, 2048), total: work.length, complete: work.length <= 2048 }))
    return { checked, acted, completed: true, positions: positions.length, quotes: quoteCounts, sidecarPulls: sidecarSides.size, timing }
  } finally {
    running = false
  }
}

/**
 * Sub-cadence gate for the ticker — "has `everySec` actually elapsed for this
 * sub-task?", measured in TIME.
 *
 * WHY THIS IS NOT `tick % everyTicks(n) === 0` (incident 02-08-2026). The
 * ticker increments `tick` on every interval firing, INCLUDING the firings the
 * overlap guard skips because the previous pass is still running. The
 * sub-cadences were exact modulos on that counter, so a sub-task only ran if a
 * multiple of its period happened to coincide with a tick where the body
 * actually started — and the run-start ticks are a sparse arithmetic
 * progression whose step is the pass duration. When that step shares a factor
 * with the period, the two never meet and the sub-task NEVER RUNS.
 *
 * That is not hypothetical. `cpp_exec` went 26 hours without a single
 * heartbeat — not a failed beat, no beat at all — while a manual probe of the
 * same sidecar answered instantly. `probeCppExec` was never called, so the
 * credential re-push self-heal inside it never ran either: a fix that was
 * deployed, correct, and unreachable. `checkHeartbeats` (the stall alerter),
 * `runPnlWatch`, `runLossCap` and `runProfitRatchet` sat behind the same kind
 * of modulo — the last two ACT on money.
 *
 * Time is the thing these cadences were always specified in; the code comment
 * above even claimed they were "TIME-based". Now they are.
 *
 * Re-anchors from `nowMs` rather than the missed deadline on purpose: a pass
 * that ran late owes one run, not a backlog of them.
 */
// A slow pass must not starve the ticker.
//
// The loop wrapped these in runBudgetedSubPhase for exactly this reason. On
// the fast path the stake is higher: the 3-second tick is what re-prices spike
// windows, and tickRunning makes a long pass skip ticks rather than overlap
// them. So a keeper that hangs on a broker call would silently disable spike
// protection for as long as it hangs.
//
// The work is NOT cancelled — it finishes detached, and its own writes are
// idempotent. Only the WAIT is abandoned, so the tick returns and the ticker
// keeps its cadence.
export async function withBudget(name, budgetMs, work) {
  let timer = null
  const startedAt = Date.now()
  const raced = await Promise.race([
    Promise.resolve().then(work).then(v => ({ value: v }), e => ({ error: e })),
    // NOT unref'd, deliberately. An unref'd budget timer cannot fire when it is
    // the only thing left on the event loop, so the race never settles and the
    // caller silently returns nothing. In the ticker that never happens (the
    // 3s interval keeps the loop alive), which is exactly what makes it the
    // kind of bug you find in production rather than in a test. The timer is
    // short and cleared on both paths, so keeping it referenced costs nothing.
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), budgetMs) }),
  ])
  if (timer) clearTimeout(timer)
  if (raced.timedOut) {
    const msg = `${name} exceeded its ${Math.round(budgetMs / 1000)}s budget after ${Math.round((Date.now() - startedAt) / 1000)}s — wait abandoned, run continues detached`
    console.warn(`[fast-monitor] ${msg}`)
    // V3 M1: counted per 10-minute window — heartbeats keep only last_error.
    noteBudgetOverrun(name, budgetMs, Date.now() - startedAt)
    return { timedOut: true, error: new Error(msg) }
  }
  if (raced.error) return { error: raced.error }
  return { value: raced.value }
}

export function makeCadenceGate() {
  const nextAt = new Map()
  return function due(key, everySec, nowMs) {
    const at = nextAt.get(key)
    if (at === undefined || nowMs >= at) {
      nextAt.set(key, nowMs + everySec * 1000)
      return at !== undefined // first sighting arms the timer, it does not fire
    }
    return false
  }
}

/** Where the band writes what it measured; the protection_band controller's declared effect. */
export const PASS_RECORD_KEY = 'fast_monitor_pass_json'
export const POSITION_WORK_KEY = 'fast_monitor_position_work_json'
const RECORD_WINDOW_MS = 10 * 60_000

/** Rolling maximum of {at, ms} samples inside `windowMs` of `nowMs`. Pure. */
export function rollingMax(samples, nowMs, windowMs = RECORD_WINDOW_MS) {
  const kept = (samples || []).filter(s => nowMs - s.at <= windowMs)
  return { kept, max: kept.length ? Math.max(...kept.map(s => s.ms)) : null }
}

/** A band pass overran when it outlived its own cadence. Pure. */
export function bandOverran(bandMs, everyMs) {
  return Number(bandMs) > Number(everyMs)
}

/** The tick path re-writes the pass record at most this often (Wave 5, §K·15). */
export const TICK_RECORD_MIN_MS = 5_000

/**
 * The tick's two shares over the window (Wave 5, §K·15), pure:
 *   skipShare — ticks skipped because the previous pass was still running,
 *               over the ticks the window EXPECTED (window / everyMs);
 *   busyShare — Σ tick ms over the window, i.e. how much of it a pass owned.
 * `windowMs` is the measured window: the full 10 minutes once the monitor
 * has been up that long, the uptime before that — a monitor two minutes old
 * is judged on two minutes, not on eight it never ran. Both are 0..1 with
 * three decimals; null when the window is empty.
 */
export function tickShares({ sampleMs = [], skipped = 0, windowMs, everyMs }) {
  const w = Number(windowMs), e = Number(everyMs)
  if (!(w > 0) || !(e > 0)) return { skipShare: null, busyShare: null, expectedTicks: null }
  const expectedTicks = Math.max(1, Math.round(w / e))
  const busy = sampleMs.reduce((a, b) => a + (Number(b) || 0), 0)
  const r3 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000
  return { skipShare: r3(skipped / expectedTicks), busyShare: r3(busy / w), expectedTicks }
}

/**
 * The 60-SECOND PROTECTION BAND — everything that used to sit inside the
 * 3-second tick behind `due('pnl_watch', 60)`: P&L watch, the per-position
 * loss cap on every account, the profit ratchet, trade guards, profit keeper,
 * loss guardian, the protection audit, and the watchdog band (cpp probe, log
 * inspector, stall check, account authorization). Exported so a test can run
 * one pass directly; startFastMonitor schedules it on its own ticker.
 */
// Keep the in-flight promise after the caller's wait expires. A timeout must
// not start a second copy on the next band. Locks are scoped to the database.
const bandFlights = new WeakMap()
export function bandSingleFlight(db, key, work) {
  let flights = bandFlights.get(db)
  if (!flights) { flights = new Map(); bandFlights.set(db, flights) }
  if (flights.has(key)) return flights.get(key)
  const pass = Promise.resolve().then(work).finally(() => {
    if (flights.get(key) === pass) flights.delete(key)
  })
  flights.set(key, pass)
  return pass
}

export async function runBandStep(db, key, work, budgetMs = 5_000) {
  const result = await withBudget(key, budgetMs, () => bandSingleFlight(db, key, work))
  if (result.error) throw result.error
  if (result.value?.errors?.length) throw new Error(result.value.errors.join(' · '))
  return result.value
}

export async function runProtectionBand(db, creds, deps = {}, nowMs = Date.now()) {
  const due = deps.due ?? makeCadenceGate()
  const hbMod = deps.heartbeat ?? await import('./heartbeat.js')
  const failures = []
  const step = (key, work) => runBandStep(db, key, work, deps.jobBudgetMs ?? 5_000)
  // P&L drift watch — Telegram warns when an open trade crosses ±N% of
  // balance (owner audit: nothing warned on drift).
  try {
    if (creds?.ready) {
      const { runPnlWatch } = await import('./pnl-watch.js')
      await step('pnl_watch', () => runPnlWatch(db, creds))
    }
  } catch (err) {
    failures.push(err.message)
    console.error('[fast-monitor] pnl-watch failed:', err.message)
  }
  // Hard per-position loss cap (owner 2026-07-28, the GOOGL −$900 case):
  // same 60s broker-truth cadence, but this one ACTS — closes a position
  // whose floating loss breached the $/% cap instead of only messaging.
  try {
    if (creds?.ready) {
      // ACROSS EVERY ENABLED ACCOUNT, not just the selected one. Until
      // 2026-08-03 this called runLossCap(db, creds) — one account — so
      // every other account ran with no per-position loss cap. A USDZAR
      // position reached −$2,186 against an $800 cap because the cap was
      // never asked about that account.
      const { runLossCapAllAccounts } = await import('./loss-cap.js')
      const lc = await step('loss_cap', () => runLossCapAllAccounts(db, creds))
      if (lc.closes || lc.errors.length) console.log(`[fast-monitor] loss-cap: ${lc.accounts} account(s), ${lc.closes} close(s), ${lc.errors.length} error(s) ${lc.errors.join(' · ')}`)
    }
  } catch (err) {
    failures.push(err.message)
    console.error('[fast-monitor] loss-cap failed:', err.message)
  }
  // Profit ratchet v2 (owner-approved A4, reworked 01-08): PER-ACCOUNT
  // equity staircases — soft warning band, hysteresis on the hard floor,
  // per-account halt/flatten, auto re-arm. Never touches the S.A.T. keys.
  try {
    if (creds?.ready) {
      const { runProfitRatchet } = await import('./profit-ratchet.js')
      const pr = await step('profit_ratchet', () => runProfitRatchet(db, creds))
      for (const a of pr?.accounts || []) {
        if (a.triggered) console.log(`[fast-monitor] profit-ratchet TRIGGERED on ${a.accountId} at equity ${a.equity} — ${a.closes} close(s)`)
        else if (a.rearmed) console.log(`[fast-monitor] profit-ratchet re-armed on ${a.accountId} at equity ${a.equity}`)
      }
    }
  } catch (err) {
    failures.push(err.message)
    console.error('[fast-monitor] profit-ratchet failed:', err.message)
  }
  // TRADE GUARDS + PROFIT KEEPER — MOVED here from the loop, not copied.
  //
  // §43 wants protection on its own path; §36.2.3 forbids duplicating an
  // ACTING one: "Two components must not unknowingly write the same stop."
  // The audit also restores targets; its own lock prevents overlapping sweeps.
  // These two MOVE stops and CLOSE positions, so their LOOP call sites are
  // gone — the loop no longer runs them at all.
  //
  // CORRECTION (2026-08-04): this comment used to claim they run "here and
  // ONLY here". That was written about loop.js and was wrong the moment
  // the guardian existed — guardian.js also calls runTradeGuards and
  // runProfitKeeper on every ≥0.05% price move, which is deliberate (§70.6
  // wants price-shaped rules on a price trigger) but means TWO clocks
  // enter the same module. Neither module had a re-entrancy guard, and
  // `withBudget` below abandons the WAIT rather than the work, so a slow
  // pass was still running when the next one started.
  //
  // The invariant now lives in the layers themselves: acting-layer.js's
  // singleFlight means a second caller JOINS the pass in flight instead of
  // starting another. Two clocks, one pass.
  //
  // Five-second waits bound the eight I/O steps to 40 seconds, leaving room
  // in the default 60-second band. Work is not cancelled; a later band joins
  // the same pending pass. This cannot bound synchronous event-loop stalls.
  // Budgeted: the loop wrapped them in runBudgetedSubPhase for the same
  // reason, and the stake is higher here because a hung pass would hold
  // the band past its cadence — which the band's own record now reports.
  // V3 F1: a close deferred behind an in-flight momentum partial is not a
  // failure (the beat stays ok) but it is said, with its reason.
  const deferredText = r => r.deferred?.length ? `; deferred (momentum close in flight): ${r.deferred.join(' · ')}` : ''
  for (const job of [
    { key: 'trade_guards', label: 'Trade guards', mod: './trade-guard.js', fn: 'runTradeGuards',
      say: r => (r.slMoves || r.partialCloses || r.deferred?.length) ? `${r.slMoves} SL move(s), ${r.partialCloses} partial close(s)${deferredText(r)}` : null },
    { key: 'profit_keeper', label: 'Profit Keeper', mod: './profit-keeper.js', fn: 'runProfitKeeper',
      say: r => (r.slMoves || r.closes || r.deferred?.length) ? `${r.slMoves} lock(s), ${r.closes} close(s)${deferredText(r)}` : null },
    // The safety net for LOSING and NAKED positions the Profit Keeper will
    // not touch. Last of the level-4 writers off the loop, and the one
    // that most needed to be: it is what puts a stop on a position that
    // has none.
    { key: 'loss_guardian', label: 'Loss Guardian', mod: './loss-guardian.js', fn: 'runLossGuardian',
      say: r => (r.stops || r.closes || r.deferred?.length) ? `${r.stops} protective stop(s), ${r.closes} close(s)${deferredText(r)}` : null },
  ]) {
    try {
      if (!creds?.ready) break
      const m = await import(job.mod)
      const res = await withBudget(job.key, deps.jobBudgetMs ?? 5_000, () => bandSingleFlight(db, job.key, () => m[job.fn](db, creds, {
        notify: (text) => import('./telegram-control.js').then(t => t.notifyOwner(text)).catch(() => {}),
      })))
      if (res.error) {
        failures.push(res.error.message)
        console.error(`[fast-monitor] ${job.label} failed:`, res.error.message)
        hbMod.beat(db, job.key, { ok: false, error: res.error.message })
      } else {
        const line = job.say(res.value || {})
        if (line) console.log(`[fast-monitor] ${job.label}: ${line}`)
        if (res.value?.errors?.length) console.error(`[fast-monitor] ${job.label} errors: ${res.value.errors.join(' · ')}`)
        if (res.value?.errors?.length) failures.push(...res.value.errors)
        hbMod.beat(db, job.key, { ok: !res.value?.errors?.length, error: res.value?.errors?.join(' · ') || null })
      }
    } catch (err) {
      failures.push(err.message)
      console.error(`[fast-monitor] ${job.label} threw:`, err.message)
      try { hbMod.beat(db, job.key, { ok: false, error: err.message }) } catch { /* heartbeat is best-effort */ }
    }
  }
  // PROTECTION AUDIT — Operating Goal Plan §43, the Non-Negotiable Rule:
  // protection must have its OWN functioning and observable path, not a
  // seat on the strategy loop.
  //
  // It had one home, inside the loop's per-account reconcile block, where
  // it shared a phase with order_monitor. On 2026-08-04 both went stalled
  // at the same instant — 961s old against a 314s expectation — because
  // that one phase had not completed. For sixteen minutes nothing asked
  // whether the open positions still had stops at the broker, and the only
  // layer still working was the broker's own.
  //
  // This path does not depend on the loop. The band has its own ticker and
  // its own overlap guard, and it is where the loop's watchdog lives — so it
  // keeps auditing precisely when the loop is the thing that broke. §70.7:
  // the five-minute loop is never the sole position protector.
  //
  // UNDER THE SAME BUDGET AS EVERY OTHER BAND JOB (17-09-2026, third review).
  // It was the one job without one, and it became the one job that can block on
  // the broker: since the applier re-reads each position LIVE before amending,
  // a pass can open several WS sessions, serially. `wsReconcile` is
  // `withRetry(..., 2)` at a 25s timeout with 2s/4s backoff — 81s worst case
  // for a single read — so one hung apply parked the whole band, flipped
  // `protection_band` red, and because this block runs AFTER the keeper and the
  // guardian, delayed the next pass's stop ratchet. Protection having its own
  // path (§43) is not protection having an unbounded one.
  try {
    if (creds?.ready) {
      const { runProtectionAuditBothSides } = await import('./naked-position-guard.js')
      const paRes = await withBudget('protection_audit', deps.jobBudgetMs ?? 5_000,
        () => bandSingleFlight(db, 'protection_audit', () => runProtectionAuditBothSides(db, creds, deps)))
      if (paRes.error) throw paRes.error
      const pa = paRes.value
      // V3 M1: the first all-account Node protection audit after boot, and
      // the first one that reached every obliged account without an error.
      const auditClean = pa.errors.length === 0 && !pa.blind
      stampFirst('protectionAudit', { ok: auditClean, accounts: pa.accounts, errors: pa.errors.length, unauditable: pa.unauditable.length })
      if (auditClean) stampFirst('cleanProtectionAudit', { accounts: pa.accounts, unauditable: pa.unauditable.length })
      if (pa.naked || pa.targetless || pa.phantom) {
        console.warn(`[fast-monitor] protection audit: ${pa.naked} naked, ${pa.targetless} targetless, ${pa.phantom} stop disagreement(s) across ${pa.accounts} account(s)`)
      }
      if (pa.errors.length) failures.push(...pa.errors)
      if (pa.blind) failures.push('protection audit did not reach a required account set')
      if (pa.errors.length) console.error(`[fast-monitor] protection audit errors: ${pa.errors.join(' · ')}`)
      if (pa.unauditable.length) console.warn(`[fast-monitor] protection audit could not reach: ${pa.unauditable.join(' · ')}`)
      // BEAT ON THIS PATH TOO. The controller is what tells the operator
      // protection is being checked; if only the loop could beat it, this
      // path could run perfectly while the panel still read "stalled".
      //
      // An UNAUDITABLE account does not fail the beat — see
      // runProtectionAuditBothSides. LOGIN-4's token does not cover it,
      // and letting that hold the controller red forever would train the
      // operator to ignore the one light that says their positions are
      // being checked.
      //
      // `blind` is the counterweight to that: an account the broker refuses
      // does not fail the beat, but a sweep that reached NO account verified
      // nothing, and green there would claim protection nobody checked.
      hbMod.beat(db, 'protection_audit', {
        ok: pa.errors.length === 0 && !pa.blind,
        error: pa.errors.length
          ? pa.errors.join(' · ')
          : pa.blind
            ? `no account could be audited — ${pa.unauditable.join(' · ') || 'nothing reachable'}`
            : null,
      })
    }
  } catch (err) {
    failures.push(err.message)
    console.error('[fast-monitor] protection-audit failed:', err.message)
    stampFirst('protectionAudit', { ok: false, error: err.message })
    try { hbMod.beat(db, 'protection_audit', { ok: false, error: err.message }) } catch { /* heartbeat is best-effort */ }
  }
  // WATCHDOG BAND. Sub-cadences gated by `due()` — see makeCadenceGate for
  // why they are not tick counts.
  try {
    if (due('cpp_probe', 120, nowMs)) {
      try { await step('cpp_probe', () => hbMod.probeCppExec(db)) } catch (err) {
        failures.push(err.message)
        console.error('[fast-monitor] sidecar probe failed:', err.message)
      }
    }
    // The log inspector (owner invariants 2-4, 31-08) runs HERE, not in
    // loop.js, deliberately: it must keep inspecting when the 5-minute
    // loop is the broken thing — the same reasoning that moved the
    // protection audit onto this band.
    if (due('log_inspector', 300, nowMs)) {
      try {
        const { runLogInspector } = await import('./log-inspector.js')
        const { getState: gs, setState: ss } = await import('../db.js')
        const notify = (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {})
        // No disarm actuator is handed in (02-09-2026): the inspector
        // reports, the live evaluators act.
        const out = runLogInspector(db, { now: nowMs, notify, io: { getState: gs, setState: ss } })
        hbMod.beat(db, 'log_inspector', { ok: !out.errors?.length, error: out.errors?.length ? out.errors.join(' · ').slice(0, 300) : null })
        if (out.inserted || out.falsified) {
          console.log(`[fast-monitor] log inspector: +${out.inserted} finding(s), ${out.autoApplied} auto, ${out.confirmed}/${out.falsified}/${out.expired} confirmed/falsified/expired`)
        }
      } catch (err) {
        failures.push(err.message)
        console.error('[fast-monitor] log inspector failed:', err.message)
        try { hbMod.beat(db, 'log_inspector', { ok: false, error: err.message }) } catch { /* best effort */ }
      }
    }
    if (due('watchdog', 60, nowMs)) {
      const notify = (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {})
      hbMod.checkHeartbeats(db, { notify })
      // Separate question, same band: checkHeartbeats asks "is the sidecar
      // alive", this asks "is every enabled account actually reachable
      // through it". On 05-08-2026 the first answered yes for twelve hours
      // while four accounts were unreachable and nothing traded.
      // NO `?.` — deliberately. An optional call turns "this watchdog is not
      // wired up" into silence, which is the failure mode this whole check
      // exists to end (twelve hours of it on 05-08). A rename or a stubbed
      // deps.heartbeat should throw into the enclosing catch and log
      // "[fast-monitor] watchdog failed" — loud and findable. checkHeartbeats
      // above is called the same way.
      hbMod.checkAccountAuthorization(db, { notify })
    }
  } catch (err) {
    failures.push(err.message)
    console.error('[fast-monitor] watchdog failed:', err.message)
  }
  if (failures.length) throw new Error(failures.join(' · '))
}

/**
 * Start the tickers. Returns a stop() handle (tests, shutdown).
 *
 * TWO TICKERS, TWO OVERLAP GUARDS (owner § 7,453·C, 08-09-2026). Until this
 * change one 3-second interval carried both the spike re-pricing pass AND,
 * behind a once-a-minute gate, the whole protection band — so the band's
 * 30-60 seconds of broker calls skipped the spike ticks it ran across, and a
 * slow spike pass pushed the band late. Now:
 *
 *   · the TICK (tickMs, default 3s) re-prices open positions and runs the
 *     session-open guard; it beats `fast_monitor`;
 *   · the BAND (bandMs, default 60s) runs runProtectionBand; it beats
 *     `protection_band` — ok only when it finished inside its cadence — and
 *     writes PASS_RECORD_KEY: last and 10-minute-max durations of both
 *     tickers, skipped counts, and whether the band overran.
 *
 * Each ticker skips its own next firing while its previous pass is still
 * running (incident 2026-07-28: stacked passes opened dozens of broker
 * sockets), and neither can skip the other's. The band doubles as the
 * reliability watchdog — deliberately independent of the main loop so a
 * silently dead main loop is still detected.
 */
export function startFastMonitor(db, getCreds, deps = {}) {
  const due = deps.due ?? makeCadenceGate()
  const clock = deps.clock ?? (() => Date.now())
  // Owner 2026-07-24: default tick 3s (was 30s) so spike windows re-price at
  // tick speed; FAST_MONITOR_MS overrides, floored at 1s to keep broker RPC
  // volume inside the 50 req/s connection budget.
  const tickMs = deps.tickMs ?? Math.max(1_000, Number(process.env.FAST_MONITOR_MS) || 3_000)
  const bandMs = deps.bandMs ?? Math.max(5_000, Number(process.env.PROTECTION_BAND_MS) || 60_000)
  const tickSamples = []
  const bandSamples = []
  const tickSkips = []       // { at } per skipped tick, kept for the window
  const quoteSamples = []    // { at, fromSidecar, fromBroker, stale } per PRICED pass, kept for the window
  let tickRunning = false
  let skipped = 0
  let bandRunning = false
  let bandSkipped = 0
  let lastTick = null
  let lastCompletedAt = null
  // { fromSidecar, fromBroker, stale, at, checked } from the last pass that
  // ACTUALLY PRICED something. 20-09-2026: a pass where no position was due
  // — the common case at a 3s tick against per-position cadences of a minute
  // or more — used to overwrite this with an all-zero object (truthy), so
  // the record could read all-zero for minutes while the monitor was in fact
  // pricing on every pass that had something due. `at` is this pass's own
  // timestamp, not the record's write time, so staleness is verifiable.
  let lastQuotes = null
  // V3 M1: the per-pass timing of the last pass that priced or fetched
  // anything — where a long tick went (see RECEIPT_CARRY_FIELDS above).
  let lastTiming = null
  let lastBand = { ms: null, overran: false }
  let lastTickRecordAt = 0
  const startedMs = clock()

  // Written by the band ticker after every band pass, and — Wave 5 (§K·15) —
  // by the TICK path too, throttled to TICK_RECORD_MIN_MS: until then the
  // record only existed once the band had run, and the tick's skip count
  // reached the log throttled (skipped === 1 || skipped % 20 === 0), so the
  // printed count under-reported and nothing served the share. The band's
  // last figures are kept so a tick-written record does not blank them.
  const writeRecord = (nowMs, band = lastBand) => {
    try {
      lastBand = band
      const tk = rollingMax(tickSamples, nowMs)
      const bd = rollingMax(bandSamples, nowMs)
      tickSamples.splice(0, tickSamples.length, ...tk.kept)
      bandSamples.splice(0, bandSamples.length, ...bd.kept)
      const skipsKept = tickSkips.filter(s => nowMs - s.at <= RECORD_WINDOW_MS)
      tickSkips.splice(0, tickSkips.length, ...skipsKept)
      const quotesKept = quoteSamples.filter(s => nowMs - s.at <= RECORD_WINDOW_MS)
      quoteSamples.splice(0, quoteSamples.length, ...quotesKept)
      const shares = tickShares({
        sampleMs: tk.kept.map(s => s.ms), skipped: skipsKept.length,
        windowMs: Math.min(RECORD_WINDOW_MS, Math.max(tickMs, nowMs - startedMs)), everyMs: tickMs,
      })
      // 10-minute window over PRICED passes only (§ header). `sidecarSharePct`
      // is against fromSidecar+fromBroker — `stale` is already counted inside
      // fromBroker (the fallback path), not a third source.
      const q10 = quotesKept.reduce((acc, s) => {
        acc.fromSidecar += s.fromSidecar; acc.fromBroker += s.fromBroker; acc.stale += s.stale; acc.passes++
        return acc
      }, { fromSidecar: 0, fromBroker: 0, stale: 0, passes: 0 })
      const q10Total = q10.fromSidecar + q10.fromBroker
      const quotes10m = q10.passes
        ? { ...q10, sidecarSharePct: q10Total ? Math.round((q10.fromSidecar / q10Total) * 1000) / 10 : null }
        : null
      setState(db, PASS_RECORD_KEY, JSON.stringify({
        at: new Date(nowMs).toISOString(),
        tick: {
          everyMs: tickMs, lastCompletedAt, lastMs: lastTick, max10mMs: tk.max, skippedTicks: skipped,
          skipped10m: skipsKept.length, skipShare10m: shares.skipShare, busyShare10m: shares.busyShare,
          // 19-09-2026: where the last pass's prices came from (see the
          // header block) — the acceptance read for the sidecar path. This is
          // the LAST PRICED pass, stamped with its own `at`/`checked`; a pass
          // that priced nothing never overwrites it (20-09-2026).
          quotes: lastQuotes,
          // 20-09-2026: the same figure over the last 10 minutes of priced
          // passes, so the acceptance read is not one sample wide.
          quotes10m,
          lastTiming,
        },
        band: { everyMs: bandMs, lastMs: band.ms, max10mMs: bd.max, overran: band.overran, skippedBands: bandSkipped },
      }))
    } catch (err) {
      console.error('[fast-monitor] pass record not written:', err.message)
    }
  }
  const writeTickRecord = (nowMs) => {
    if (nowMs - lastTickRecordAt < TICK_RECORD_MIN_MS) return
    lastTickRecordAt = nowMs
    writeRecord(nowMs)
  }

  // Returns { err, quotes, checked }; an injected runTick may still return a
  // bare error or null (older tests), which the caller below reads the same
  // way (and `checked` simply reads as undefined ⇒ 0).
  const runTick = deps.runTick ?? (async (creds) => {
    let tickErr = null
    let quotes = null
    let checked = 0
    let completed = false
    let timing = null
    try {
      const r = await runFastMonitor(db, creds, deps)
      completed = r?.completed === true
      if (r?.quotes) { quotes = r.quotes; checked = r.checked ?? 0 }
      timing = r?.timing ?? null
    } catch (err) {
      tickErr = err
      console.error('[fast-monitor] tick failed:', err.message)
    }
    // Session-open guard — every tick, but a no-op outside the first
    // minutes after a major session opens: locks SL to breakeven on
    // positions already in decent profit, since opens are where reversals
    // hit hardest (owner: XAUUSD +$218 → −$261 across a session open).
    try {
      if (creds?.ready) {
        const { runSessionOpenGuard } = await import('./session-open-guard.js')
        await runSessionOpenGuard(db, creds, {
          ...deps,
          notify: (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
      }
    } catch (err) {
      console.error('[fast-monitor] session-open-guard failed:', err.message)
    }
    return { err: tickErr, quotes, checked, completed, timing }
  })

  const t = setInterval(async () => {
    if (tickRunning) {
      skipped++
      tickSkips.push({ at: clock() })
      writeTickRecord(clock())
      // Still beat — a busy monitor is not a stalled one, and skipping the
      // heartbeat would trip the watchdog's stall alert on our own backlog.
      try {
        const hb = deps.heartbeat ?? await import('./heartbeat.js')
        hb.beat(db, 'fast_monitor', { ok: true, error: null, detail: { busy: true, skipped, completed: false, lastCompletedAt } })
      } catch { /* heartbeat is best-effort */ }
      // console.LOG, not warn (2026-08-22). Overlap protection working is not
      // an error: this is the ticker declining to start a second pass while
      // the first is still going, which is the guard doing its job.
      if (skipped === 1 || skipped % 20 === 0) console.log(`[fast-monitor] previous pass still running — skipped ${skipped} tick(s)`)
      return
    }
    tickRunning = true
    const startedAt = clock()
    try {
      // ONE creds read per tick: this was called five times per tick, each
      // doing several getState reads plus a JSON.parse of the symbol map.
      const creds = getCreds(db)
      const r = await runTick(creds, startedAt)
      const tickErr = r instanceof Error ? r : (r?.err ?? null)
      // 20-09-2026: adopt the pass's quotes only when it PRICED something —
      // see the `lastQuotes` declaration above. An all-zero object (the
      // common case: nothing was due at this 3s tick) is truthy and must not
      // overwrite the last pass that actually priced.
      const q = r?.quotes
      if (q && (q.fromSidecar || 0) + (q.fromBroker || 0) + (q.stale || 0) > 0) {
        lastQuotes = { ...q, at: new Date(startedAt).toISOString(), checked: r.checked ?? 0 }
        quoteSamples.push({ at: startedAt, fromSidecar: q.fromSidecar || 0, fromBroker: q.fromBroker || 0, stale: q.stale || 0 })
      }
      const ms = clock() - startedAt
      if (!tickErr && r?.completed === true) lastCompletedAt = new Date(clock()).toISOString()
      lastTick = ms
      tickSamples.push({ at: startedAt, ms })
      const tm = r?.timing
      if (tm && ((tm.priced || 0) + (tm.volFetches || 0)) > 0) lastTiming = { ...tm, passMs: ms, at: new Date(startedAt).toISOString() }
      // V3 M1: the first tick after boot, with its outcome.
      stampFirst('fastTick', { ms, ok: !tickErr, completed: r?.completed === true, checked: r?.checked ?? null })
      writeTickRecord(clock())
      try {
        const hb = deps.heartbeat ?? await import('./heartbeat.js')
        hb.beat(db, 'fast_monitor', { ok: !tickErr, error: tickErr?.message ?? null, detail: { ms, skipped, completed: !tickErr && r?.completed === true, checked: r?.checked ?? null, lastCompletedAt } })
      } catch { /* heartbeat is best-effort */ }
      skipped = 0
    } finally {
      tickRunning = false
    }
  }, tickMs)
  t.unref?.()

  const runBand = deps.runBand ?? ((creds, nowMs) => runProtectionBand(db, creds, { ...deps, due }, nowMs))
  const b = setInterval(async () => {
    if (bandRunning) {
      bandSkipped++
      if (bandSkipped === 1 || bandSkipped % 10 === 0) console.log(`[fast-monitor] protection band still running — skipped ${bandSkipped} band tick(s)`)
      return
    }
    bandRunning = true
    const startedAt = clock()
    let bandErr = null
    try {
      const creds = getCreds(db)
      try { await runBand(creds, startedAt) } catch (err) { bandErr = err; console.error('[fast-monitor] protection band failed:', err.message) }
      const endedAt = clock()
      const ms = endedAt - startedAt
      const overran = bandOverran(ms, bandMs)
      bandSamples.push({ at: startedAt, ms })
      // V3 M1: the first protection band after boot — did it complete, and
      // inside its cadence?
      stampFirst('band', { ms, overran, ok: !bandErr && !overran, error: bandErr ? bandErr.message : null })
      if (overran) console.warn(`[fast-monitor] protection band took ${Math.round(ms / 1000)}s — over its ${Math.round(bandMs / 1000)}s cadence`)
      writeRecord(endedAt, { ms, overran })
      try {
        const hb = deps.heartbeat ?? await import('./heartbeat.js')
        hb.beat(db, 'protection_band', {
          ok: !bandErr && !overran,
          error: bandErr ? bandErr.message : overran ? `band took ${Math.round(ms / 1000)}s, over its ${Math.round(bandMs / 1000)}s cadence` : null,
          detail: { ms, overran, skippedBands: bandSkipped },
        })
      } catch { /* heartbeat is best-effort */ }
      bandSkipped = 0
    } finally {
      bandRunning = false
    }
  }, bandMs)
  b.unref?.()
  return () => { clearInterval(t); clearInterval(b) }
}
