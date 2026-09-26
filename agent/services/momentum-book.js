// ---------------------------------------------------------------------------
// agent/services/momentum-book.js — the time-series momentum BOOK
// (owner order 03-09-2026: "build it, switch 15m off, long-only momentum on
// demo & live"; TWO-SIDED since PR-D, 11-09-2026, owner principle 8 —
// "shorts on the momentum book under the 9/10 conviction floor with
// regime-gate alignment").
//
// WHAT IT IS. The cross-sectional shadow (momentum-shadow.js) ranks the scan
// universe by trailing return every hour and logs would-be entries and exits
// with hysteresis. This book turns the shadow's LONG decisions into real
// positions on every account where `tsmom_long` is trade-armed, and manages
// them with a volatility-scaled stop that only ever ratchets in the trade's
// favour, and an exit when the name
// leaves its band. A SHORT row is taken only when direction-policy.js says
// ok: conviction at or above the short floor (longMin × 1.5 = 9/10 on the
// defaults) AND not against an up-trend in `regimes.trend_direction`; the
// row's side is 'short', the order's side SELL, the stop above entry and
// trailing DOWN. Every entry carries a `direction_reason`.
//
// WHAT IT REUSES. Every entry goes through autoTrade() — the risk gate sizes
// it from the stop distance, the spread and drift gates apply, the ledger
// and monitored_positions rows are written the normal way. The position is
// then PAUSED for the keeper (monitored_positions.paused = 1) because the
// keeper's partial-at-1R and bank-at-4R would cut exactly the tail this
// book exists to hold; the book moves the stop itself and the broker always
// holds it. The evidence gate lets the book trade only where it is
// hand-pinned or has earned its record, like every other strategy.
//
// THE HORIZON (PR-K, 16-09-2026, owner "finish the outstanding"; the owner's
// first principle of 07-09-2026: "HORIZON IS THE DESIGN VARIABLE… book
// decisions on the daily close only (trail, entries, exits), not per-minute").
// A rank exit — the ranking's OPINION that a name left its band, flip-exit leg
// included — respects two rules: it is evaluated once per UTC day, and never on
// a position younger than `bookMinHoldHours`. Everything that is not a ranking
// opinion still runs on EVERY pass: the broker's stop, the retry of an exit the
// broker refused, the sweep for an exit decided on a previous day, the weekend
// bank, the loss guardian and the equity stop.
//
// WHICH PATH ENFORCES WHAT — READ THIS BEFORE TRUSTING THE CODE BELOW.
// `runMomentumBook` has TWO exit paths and only one of them carries accounts
// today. `agent/config/momentum-account.json` ships `"accountId": "_all"`
// (PR-B, 11-09-2026, owner principle 9), so `isMomentumAccount()` is true for
// every ENABLED registry account and each one `continue`s into the momentum
// account's daily pass long before the row-cursor code below is reached. As
// shipped, the row-cursor path carries NO ACCOUNT AT ALL — it is dormant
// defence for a config that names specific accounts, or for an account that is
// disabled in the registry while still armed.
//   • The MINIMUM HOLD is therefore enforced in BOTH places, and the one that
//     actually stops a close today is `exitDroppedHoldings` in
//     momentum-account.js. The shared rule lives in book-hold-age.js.
//   • The DAILY CADENCE and its cursor below apply to the row-cursor path
//     only. The momentum-account pass is already once-per-day by construction
//     (its own lastRunMs cursor), so nothing there needed a second cursor.
//   • `bookExitCadence: 'every_pass'` restores the pre-PR-K behaviour on both:
//     the row-cursor cadence is lifted AND the minimum hold with it, from the
//     running system, with no deploy.
// The first draft of PR-K put both rules here only. They were on, configured,
// documented and out of reach of what they guarded — CLAUDE.md failure mode
// #3, found by the checker on 16-09-2026 and recorded here so the next reader
// does not have to re-derive which path trades.
//
// THE PER-ACCOUNT ENTRY BRAKE (PR-P, 16-09-2026, after PR-O armed
// `tsmom_long` on all seven enabled accounts). Every automatic brake a book
// entry passes through counts CLOSED trades — adaptive-breaker 3,
// edge-watchdog 15, strategy-verdicts 30 (the last of these IS on the path
// already: autoTrade → the risk gate → risk.js clause 5b, where under 30
// closes it returns `pending`, never a refusal). On a book that holds for
// 10–60 days none of them can fire inside the horizon they bound, and the
// pooled watchdog verdict is exempt on every armed account because arming IS
// `isHandPinned`. book-open-drawdown.js measures instead what the account is
// holding right now: the open mark-to-market of its OWN book rows as a
// percentage of the risk those rows put up at entry, marked from the trail
// pass's own bar closes. At or above `bookDrawdownPct` (50 by default, over
// `bookDrawdownMinRows` 2+ rows) the account takes NO NEW book entries; it
// needs zero closes and can fire within one loop pass of the account's second
// position going half a stop under water.
//
// IT ALSO REFUSES WHEN IT CANNOT SEE. If fewer than
// `bookDrawdownMinCoveragePct` (60 %) of the account's open rows can be
// priced, the account is blocked for BLINDNESS rather than passed on
// whatever minority could be read — because if the unreadable rows are the
// bleeding ones, the healthy remainder becomes the reading. And whenever
// anything is unread, block or no block, a line naming the coverage goes
// into `summary.skipped` on EVERY pass: a brake that is blind must not be a
// brake that is quiet. Both are the checker's MAJORs of 16-09-2026; the full
// argument, including why failing closed is the right direction here, is in
// book-open-drawdown.js's header.
//
// It is computed ONCE per account here and handed to BOTH entry paths, so the
// two cannot disagree. It gates ENTRIES only — the stop, the rank exits, the
// `exit_pending` retry, the owed-exit sweep and the weekend bank never read
// it, and blocking an entry can only reduce exposure.
//
// Every broker call is injectable (deps) so the tests drive the whole cycle
// against an in-memory DB with fake fills.
// ---------------------------------------------------------------------------

import { freshBookProtection } from './book-stop-amend.js'
import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { armedTradeKeys } from './stage-matrix.js'
import { loadShadowState, loadMomentumShadow } from './momentum-shadow.js'
import { directionFor, trendReadingFor } from './direction-policy.js'
import { checkRegimeGate } from './regime-gate.js'
import { recordDecision } from './decision-log.js'
import { recordPositionEvent } from './position-events.js'
import { roundToDigits } from './trade-guard.js'
import { isMomentumAccount, runMomentumAccountPass, loadMomentumAccount, dailyDue, thresholdMs } from './momentum-account.js'
import { bookEntryWrite } from './book-entry-write.js'
import { bookCloseVolume } from './book-close-volume.js'
import { runMomentumRankExit } from './momentum-rank-exit.js'
import { isSymbolOpenCached } from './symbol-hours.js'
// PR-K: the hold-age rule lives in its own module because the momentum-account
// path enforces the SAME minimum hold and may not import this file (cycle).
import { parseStamp, heldLongEnough as heldLongEnoughFor, heldHours, minHoldMsFor } from './book-hold-age.js'
// PR-P (16-09-2026): the per-account ENTRY brake, measured on open
// mark-to-market. Its own module for the same reason as book-hold-age.js —
// the momentum-account path enforces the SAME rule and may not import this
// file (cycle). See that file's header for why the existing closed-trade
// brakes (3 / 15 / 30 closes) cannot reach a 10–60 day horizon.
import { bookDrawdownConfig, bookEntryBrake, markKey, DEFAULT_BOOK_DRAWDOWN, MIN_PLAUSIBLE_EPOCH_MS } from './book-open-drawdown.js'

/**
 * Trade states that END a book row's claim to be a position (PR-AZ + B3,
 * 18-09-2026). The vocabulary is the schema's (db.js CHECK on trades.status):
 * open / closed / cancelled / rejected / submitting / unconfirmed. Named, not
 * `<> 'open'`: `submitting` and `unconfirmed` are IN FLIGHT and must never
 * retire a row. One set for both loops, so they cannot disagree again.
 */
export const BOOK_TERMINAL_TRADE_STATES = new Set(['closed', 'rejected', 'cancelled'])
export { parseStamp }

export const TSMOM_STRATEGY = 'tsmom_long'
// A held name with no position is re-proposed at most this often per account.
export const RECONCILE_EVERY_MS = 60 * 60_000
// A flip whose exit was deferred is remembered for this long (PR-K). Longer
// than any deferral the cadence can produce, short enough that a ranking
// opinion from last week never enters a position today.
export const PENDING_FLIP_TTL_MS = 3 * 24 * 60 * 60_000
export const MOMENTUM_BOOK_CONFIG_KEY = 'momentum_book_json'
export const MOMENTUM_BOOK_STATE_KEY = 'momentum_book_state_json'

export const DEFAULT_MOMENTUM_BOOK = Object.freeze({
  enabled: false,          // OFF until the owner turns it on
  timeframe: '1d',
  atrPeriod: 20,
  stopAtr: 3,              // initial and trailing stop: 3 × ATR(20) below the close
  maxPositionsPerAccount: 8,
  conviction: 8,           // the scan's autotrade threshold; the ranking's own conviction rides on the row
  // PR-K (16-09-2026, owner "finish the outstanding"). THE HORIZON IS THE
  // DESIGN VARIABLE (owner, 07-09-2026: "book decisions on the daily close
  // only (trail, entries, exits), not per-minute"). Measured over 95 bot
  // deals 09–11 Sep: positions held over 24 h netted −972, and the three
  // largest single losses were this book's RANK exits firing intraday on
  // positions entered for a weeks-long move. Two knobs, both revertible from
  // the running system through POST /actions/momentum-book:
  //   bookExitCadence 'daily'      — a rank exit is evaluated once per UTC
  //                                  day, on the book's own day cursor
  //   bookExitCadence 'every_pass' — the pre-PR-K behaviour, exactly
  //   bookMinHoldHours            — a row younger than this is not rank-exited
  // NEITHER touches the stop, the refused-exit retry or any protection guard.
  // A rank exit is a RANKING OPINION; a stop is protection. Only the opinion
  // moved.
  //
  // WHERE EACH KNOB BITES (checker, 16-09-2026 — the first draft of this PR
  // enforced both only on the row-cursor path below, which carries NO account
  // while agent/config/momentum-account.json says `"accountId": "_all"`):
  //   bookMinHoldHours — enforced on BOTH paths: the momentum-account daily
  //     pass (momentum-account.js exitDroppedHoldings — the path that trades
  //     today) and the row-cursor path here.
  //   bookExitCadence  — 'daily' vs 'every_pass' only governs the ROW-CURSOR
  //     path's rank-exit cursor. The momentum-account path is already daily by
  //     construction (its own lastRunMs cursor); on that path 'every_pass'
  //     means only "lift the minimum hold", which is what the pre-PR-K
  //     behaviour was there.
  bookExitCadence: 'daily',
  bookMinHoldHours: 24,
  // PR-P (16-09-2026): the per-account entry brake. Four knobs, defined and
  // documented in book-open-drawdown.js, spread here so the book has ONE
  // config object and ONE merge route.
  ...DEFAULT_BOOK_DRAWDOWN,
})

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)
// A NUMBER, not something Number() will happily turn into 0 (checker MAJOR 2):
// Number(null), Number(''), Number(false) and Number([]) are all 0 and finite,
// so `clamp` would read a cleared UI field as "no minimum hold at all" — the
// knob disabled by a blank box. Only a real number, or a string that is one,
// counts; anything else falls back to the default.
const clampNum = (v, lo, hi, d) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

export function momentumBookConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_MOMENTUM_BOOK
  return {
    enabled: r.enabled === true,
    timeframe: typeof r.timeframe === 'string' && r.timeframe.trim() ? r.timeframe.trim() : d.timeframe,
    atrPeriod: Math.round(clamp(r.atrPeriod, 5, 100, d.atrPeriod)),
    stopAtr: clamp(r.stopAtr, 0.5, 10, d.stopAtr),
    maxPositionsPerAccount: Math.round(clamp(r.maxPositionsPerAccount, 1, 50, d.maxPositionsPerAccount)),
    conviction: Math.round(clamp(r.conviction, 1, 10, d.conviction)),
    // PR-K: anything that is not the literal 'every_pass' is 'daily' — the
    // ordered behaviour is the fail-safe direction for a knob that decides
    // whether a weeks-horizon position is cut intraday.
    bookExitCadence: r.bookExitCadence === 'every_pass' ? 'every_pass' : d.bookExitCadence,
    // 0 disables the hold (a rank exit may fire on the first daily pass);
    // nonsense — including null, '', false and [] — falls back to the
    // default, never to 0. The ceiling is 168 h (7 days): a fat-fingered
    // 7200 must not freeze this book's rank exits for a month.
    bookMinHoldHours: clampNum(r.bookMinHoldHours, 0, 168, d.bookMinHoldHours),
    // PR-P: the entry brake's knobs, clamped by their own module so the rule
    // and its validation never live in two places.
    ...bookDrawdownConfig(r),
  }
}

/**
 * Wave 1 of the first-principles audit (19-09-2026, §K·3): the book's master
 * switch boots from the repo like every other subsystem. Diff-by-value like
 * seedMomentumAccountFromConfig: only the keys the file names are patched,
 * and a stored value that already matches is left alone.
 */
export function seedMomentumBookFromConfig(db, { file = null, log = () => {} } = {}) {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/momentum-book.json', import.meta.url), 'utf8'))
  } catch (err) {
    return { applied: false, effective: null, error: `momentum-book.json unreadable: ${err.message}` }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { applied: false, effective: null, error: 'momentum-book.json is not an object' }
  let stored = null
  try { stored = JSON.parse(getState(db, MOMENTUM_BOOK_CONFIG_KEY) || 'null') } catch { stored = null }
  const base = momentumBookConfig(stored)
  const patch = {}
  for (const k of Object.keys(DEFAULT_MOMENTUM_BOOK)) if (k in cfg) patch[k] = cfg[k]
  const next = momentumBookConfig({ ...base, ...patch })
  const same = JSON.stringify(next) === JSON.stringify(base)
  if (!same) {
    setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(next))
    log(`[boot] momentum book: enabled=${next.enabled} maxPositionsPerAccount=${next.maxPositionsPerAccount} cadence=${next.bookExitCadence} minHold=${next.bookMinHoldHours}h (from config/momentum-book.json)`)
  }
  return { applied: !same, effective: next, error: null }
}

export function loadMomentumBook(db) {
  try { return momentumBookConfig(JSON.parse(getState(db, MOMENTUM_BOOK_CONFIG_KEY) || 'null')) } catch { return momentumBookConfig(null) }
}

/** Wilder-free simple ATR over the last `period` bars ({h,l,c}); null when thin. */
export function atrOf(bars, period) {
  const list = Array.isArray(bars) ? bars.filter(b => Number.isFinite(Number(b?.h)) && Number.isFinite(Number(b?.l)) && Number.isFinite(Number(b?.c))) : []
  if (list.length < period + 1) return null
  const slice = list.slice(-(period + 1))
  let sum = 0
  for (let i = 1; i < slice.length; i++) {
    const pc = Number(slice[i - 1].c)
    sum += Math.max(Number(slice[i].h) - Number(slice[i].l), Math.abs(Number(slice[i].h) - pc), Math.abs(Number(slice[i].l) - pc))
  }
  return sum / (slice.length - 1)
}

/**
 * The trailing stop: for a long never lower than before, stopAtr ATRs under
 * the close; for a short (PR-D) never higher than before, stopAtr ATRs
 * above the close. Pure.
 */
export function trailStop({ prevStop, close, atr, stopAtr, side = 'long' }) {
  const c = Number(close), a = Number(atr), k = Number(stopAtr)
  if (!(c > 0) || !(a > 0) || !(k > 0)) return Number.isFinite(Number(prevStop)) ? Number(prevStop) : null
  const short = side === 'short'
  const candidate = short ? c + k * a : c - k * a
  // null is ABSENT, not zero: Number(null) is 0, which the long side's
  // Math.max happened to hide and the short side's Math.min would have
  // taken as the stop (caught by the first short trail test, PR-D).
  const prev = prevStop == null ? NaN : Number(prevStop)
  if (!Number.isFinite(prev)) return candidate
  return short ? Math.min(prev, candidate) : Math.max(prev, candidate)
}

/** Has the trail moved in the trade's favour (up for a long, down for a short)? Pure. */
export function trailImproves({ side = 'long', prevStop, nextStop }) {
  const prev = prevStop == null ? NaN : Number(prevStop), next = nextStop == null ? NaN : Number(nextStop)
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false
  return side === 'short' ? next < prev * (1 - 1e-6) : next > prev * (1 + 1e-6)
}


/**
 * The synth autoTrade() dispatches: a long (or, PR-D, a short) at the live
 * price with a volatility stop. Until the strategy supplies an approved TP1,
 * the shared execution boundary refuses this proposal before dispatch.
 * `marketOnly` keeps it off the high-timeframe limit
 * path (the entry is the live quote, not a bar close), `auto_trade` is what
 * the dispatch gate requires. `directionReason` is the policy's stated
 * reason for the side; without one the side's band is the reason. Pure.
 */
export function buildEntrySynth({ symbol, price, atr, cfg, conviction = null, rankPct = null, side = 'long', directionReason = null }) {
  const p = Number(price), a = Number(atr)
  if (!(p > 0) || !(a > 0)) return null
  if (side !== 'long' && side !== 'short') return null
  const short = side === 'short'
  const sl = short ? p + cfg.stopAtr * a : p - cfg.stopAtr * a
  if (!(sl > 0) || (short ? !(sl > p) : !(sl < p))) return null
  const band = short ? 'bottom band' : 'top band'
  return {
    consensus_bias: side,
    direction_reason: directionReason || (short ? 'tsmom:short_bottom_band' : 'tsmom:long_top_band'),
    entry: p,
    sl,
    tp1: null,
    tp2: null,
    strategy: TSMOM_STRATEGY,
    timeframe: cfg.timeframe,
    overall_conviction: Number.isFinite(Number(conviction)) ? Number(conviction) : cfg.conviction,
    auto_trade: true,
    marketOnly: true,
    time_cap_minutes: null,
    source: 'momentum_book',
    synthesis: `TS momentum ${side} — ${symbol} ranked ${rankPct != null ? Math.round(Number(rankPct) * 100) + 'th pct' : band} by trailing return; stop ${cfg.stopAtr}×ATR(${cfg.atrPeriod}) = ${sl.toFixed(5)}. Entry remains blocked until an approved TP1 is supplied.`,
    invalidation_trigger: short ? 'rank leaves the bottom 40% of the universe, or the trailing stop' : 'rank leaves the top 40% of the universe, or the trailing stop',
  }
}

// ---------------------------------------------------------------------------
// OWED EXITS ARE NOT RETRIED INTO A CLOSED MARKET (Wave 5, §K·15). Block (2)
// below retries a refused exit on EVERY pass — right, because an owed exit
// must not wait a day. But the audit's log had `close failed — MARKET_CLOSED`
// on 26 of 26 passes for one name: a broker call the hours table already
// knew would be refused, and a line per pass saying so. Now the hours are
// asked FIRST; a market known closed defers the close without a broker call
// and is counted in the pass summary as `deferredClosed`. Only the broker's
// own schedule (a symbol_hours row) may defer: a symbol the table has never
// seen is still attempted, whatever the sessions.js heuristic guesses.
//
// ONE LINE PER SYMBOL, not per pass: this process-wide Map remembers which
// account|symbol is currently deferred, prints when a symbol FIRST defers and
// once more when its market is next seen open (the close is then attempted).
// In-memory on purpose — a restart prints the first-defer line once more,
// which is one line, not one per pass.
// ---------------------------------------------------------------------------
const deferredClosed = new Map() // `${accountId}|${symbol}` → first deferred at (ms)
export function _resetDeferredClosedForTests() { deferredClosed.clear() }

export function loadBookState(db) {
  try {
    const s = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY) || 'null')
    if (s && typeof s === 'object') {
      return {
        lastShadowRowId: Number(s.lastShadowRowId) || 0,
        lastRunMs: Number(s.lastRunMs) || 0,
        reconciledAt: s.reconciledAt && typeof s.reconciledAt === 'object' ? s.reconciledAt : {},
        // PR-K: flips whose exit was deferred, waiting to enter the new side.
        pendingFlips: s.pendingFlips && typeof s.pendingFlips === 'object' ? s.pendingFlips : {},
        // PR-K: the book's rank-exit day cursor, ONE PER ACCOUNT — an account
        // whose daily pass ran today must not consume another account's.
        rankExitAt: s.rankExitAt && typeof s.rankExitAt === 'object' ? s.rankExitAt : {},
        // PR-P: the last close the TRAIL pass saw for each carried row,
        // `<accountId>|<SYMBOL>` → { c, at, bt? } — `c` the close, `at` the
        // pass clock, `bt` the BAR's own epoch when the feed supplied a
        // plausible one. The entry brake's only price input.
        // It lives here rather than in a new column because momentum_book's
        // schema is agent/db.js's and this needs no migration; it is rebuilt
        // from the trail pass every loop, so a lost blob costs one pass.
        marks: s.marks && typeof s.marks === 'object' ? s.marks : {},
        // PR-P: why a carried row could not be freshly marked, same keys as
        // `marks`. The brake names the CAUSE, not just the count.
        markFail: s.markFail && typeof s.markFail === 'object' ? s.markFail : {},
      }
    }
  } catch { /* fall through */ }
  return { lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks: {}, markFail: {} }
}


/**
 * One pass. `accounts` are the autopilot roster ({accountId,isLive}),
 * `credsFor(acct)` yields broker creds, and `deps` carries every side effect:
 *   autoTrade(db, symbol, synth, watchlistItem, accountOverride) → truthy on fill
 *   bars(creds, symbolId) → [{t,o,h,l,c}] on the book's timeframe
 *   spot(creds, symbolId) → {bid, ask} | null
 *   amend(creds, {positionId, stopLoss}) / close(creds, {positionId, volume})
 *   phasesOn(accountId) → boolean (the per-account autotrade switch)
 *   mayTrade(accountId, symbol) → {ok, item}
 *   symbolMap → {SYMBOL: id}
 */
export async function runMomentumBook(db, { accounts = [], credsFor = () => null, deps = {}, now = Date.now(), log = () => {}, entriesHeld = null } = {}) {
  const cfg = loadMomentumBook(db)
  if (!cfg.enabled) return { ran: false, why: 'disabled' }
  const state = loadBookState(db)
  const summary = { ran: true, entries: 0, exits: 0, trailed: 0, reclassified: 0, deferredClosed: 0, skipped: [], accounts: 0 }
  // S-2 (Wave 2 row 2.1, OD-2 yes 26-09-2026): the loop calls the book on
  // EVERY cycle, outside the scan branch. When that cycle's scan did not run,
  // `entriesHeld` names why: exits, the trail, adoption and reconcile of held
  // rows all run; ENTRIES are held (both paths), exactly as they were when
  // the whole book was skipped with the scan.
  if (entriesHeld) { summary.entriesHeld = String(entriesHeld); summary.skipped.push(`entries held — ${entriesHeld}`) }
  // Every shadow row since the cursor advances it (refusals included, so
  // nothing is re-read); LONG and SHORT entries and exits act (PR-D) — a
  // short row still has to pass directionFor at tryEnter.
  const shadowCfg = loadMomentumShadow(db)
  const all = db.prepare(`SELECT * FROM momentum_shadow WHERE id > ? ORDER BY id ASC`).all(state.lastShadowRowId)
  const maxId = all.length ? all[all.length - 1].id : state.lastShadowRowId
  const rows = all.filter(r => (r.side === 'long' || r.side === 'short') && (r.action === 'enter' || r.action === 'exit'))
  const enters = new Map(), exits = new Map()
  for (const r of rows) {
    // the latest decision per symbol in this batch wins. A FLIP (the
    // checker's counterexample, 11-09-2026: `exit(long)` then `enter(short)`
    // for one name in one batch, the loop having been down for a shadow
    // interval) is NOT an exit dropped by an enter: the account loop below
    // treats an `enter` whose side differs from the open row's side as an
    // exit of that row FIRST, then the entry.
    if (r.action === 'enter') { exits.delete(r.symbol); enters.set(r.symbol, r) }
    else { enters.delete(r.symbol); exits.set(r.symbol, r) }
  }
  // SCOPE (07-09-2026, measured 18:34 SGT, minutes after #853 deployed): the
  // shadow now ranks the momentum universe as well as the scan's symbols, and
  // the row-cursor path below reads every shadow row — so every armed
  // account, live included, was offered XRPUSD, MSFT.US, SOLUSD and V.US it
  // had never scanned (live refused them on its watchlist; two demo accounts
  // bought XRPUSD). The wider universe is the MOMENTUM ACCOUNT's. Accounts on
  // this path keep the universe they had: when the loop passes the scan's
  // symbols, rows and held names outside them are ignored here.
  const scanScope = Array.isArray(deps.scanSymbols) && deps.scanSymbols.length
    ? new Set(deps.scanSymbols.map(s => String(typeof s === 'string' ? s : s?.symbol || '').toUpperCase()).filter(Boolean))
    : null
  const inScanScope = (symbol) => !scanScope || scanScope.has(String(symbol).toUpperCase())
  const openRow = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ? AND symbol = ?`)
  const openCount = db.prepare(`SELECT COUNT(*) AS n FROM momentum_book WHERE status = 'open' AND account_id = ?`)
  // §4-P: rows are written by the one shared `bookEntryWrite`, which also
  // hands the position over in the same transaction. No local INSERT here.
  const tradeRowFor = db.prepare(`SELECT id, ctrader_position_id, entry_price, sl_price FROM trades WHERE symbol = ? AND account_id = ? AND label_strategy = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
  const openTsmomTrades = db.prepare(`SELECT id, symbol, side, ctrader_position_id, entry_price, sl_price FROM trades WHERE account_id = ? AND label_strategy = ? AND status = 'open' AND id NOT IN (SELECT trade_id FROM momentum_book WHERE trade_id IS NOT NULL) ORDER BY id ASC`)
  // A resting tsmom limit on this account for the symbol: the reconcile
  // pass must not stack a second order on top of one still waiting to fill.
  const workingLimit = db.prepare(`SELECT id FROM pending_orders WHERE account_id = ? AND symbol = ? AND status = 'working' AND strategy = ? LIMIT 1`)
  const workingLimitFor = { get: (accountId, symbol) => { try { return workingLimit.get(accountId, symbol, TSMOM_STRATEGY) } catch { return null } } }
  summary.adopted = 0
  summary.reconciled = 0
  // PR-K (16-09-2026): the rank exit's CADENCE and its minimum hold.
  // The cadence clock is the momentum account's, not a new one — the same
  // `dailyDue`/`thresholdMs` pair and the same `dailyRunAfterUtc` threshold
  // (21:05 UTC by default, after the NY and FX day closes), so the book and
  // the momentum account decide on ONE daily close, not two. What is NOT
  // shared is the stored cursor: `momentum_account_state_json:<id>` is the
  // momentum-account pass's own lastRunMs, and stamping it here would make
  // either pass swallow the other's day. The book keeps its cursor in its own
  // state blob, still one entry per account.
  const maCfg = loadMomentumAccount(db)
  const everyPass = cfg.bookExitCadence === 'every_pass'
  /** The start of the book day containing `ms` (the last daily threshold to pass). */
  const bookDayStart = (ms) => { const t = thresholdMs(ms, maCfg.dailyRunAfterUtc); return ms >= t ? t : t - 86_400_000 }
  // THE MINIMUM HOLD, from book-hold-age.js — the SAME rule the momentum
  // account's daily pass applies (age from the OLDEST of the row's entered_at
  // and the trade's opened_at; 'every_pass' lifts it with the cadence, since
  // "reconsidered on the next daily pass" needs a next daily pass to exist).
  const heldLongEnough = (row) => heldLongEnoughFor(db, row, now, cfg)
  const heldWhy = (row) => `held ${heldHours(db, row, now)}h < bookMinHoldHours ${cfg.bookMinHoldHours} — reconsidered on the next daily pass`
  if (minHoldMsFor(cfg) > 0) summary.minHoldHours = cfg.bookMinHoldHours
  summary.rankExitsDeferred = 0
  state.rankExitAt = { ...(state.rankExitAt || {}) }
  state.pendingFlips = { ...(state.pendingFlips || {}) }

  // RICHEST HEADROOM FIRST (owner § 7,453·B, 08-09-2026): the pool orders the
  // accounts, and an exhausted one takes no ENTRIES this pass — its exits,
  // adoption and trail still run, because they need no margin. Unknown
  // headroom (no injected reader, no balance) is not exhausted.
  // null stays null: Number(null) is 0, and 0 is "exhausted" — the first
  // draft read every account with no reader as exhausted (caught by the
  // existing book tests before it shipped).
  const headroomOf = (a) => { try { const h = deps.marginHeadroom ? deps.marginHeadroom(String(a.accountId)) : null; return h == null || !Number.isFinite(Number(h)) ? null : Number(h) } catch { return null } }
  const ordered = deps.marginHeadroom
    ? [...accounts].map((a, i) => ({ a, i, h: headroomOf(a) })).sort((x, y) => ((y.h ?? 0) - (x.h ?? 0)) || (x.i - y.i)).map(x => x.a)
    : accounts
  // HOW MANY WERE CONSIDERED, so "on N account(s)" can never again be read
  // without knowing what N is out of. `summary.accounts` keeps its meaning
  // (the accounts the pass RAN on); `considered` is what was handed in.
  summary.considered = ordered.length
  summary.notArmed = 0
  summary.armCheckFailed = 0
  // E·2 for the book (Wave 1, audit §K·4): every account in this pass shares
  // the same ranking, so each is sized at 1/N of its budget — the gate reads
  // `sharedAccounts` off the account object it is handed.
  for (const acct of ordered.map(a => ({ ...a, sharedAccounts: ordered.length }))) {
    const accountId = String(acct.accountId)
    // THE ARM GATE RECORDS ITS REFUSAL (owner principle 4, measured
    // 16-09-2026): this branch used to `continue` silently while the two
    // below it pushed to `skipped`, so production logged "on 1 account(s)"
    // with no suffix while six of seven enabled accounts were dropped and
    // nothing anywhere said so. A THROW is not a configuration choice and
    // must not read as one — `catch { armed = false }` made the two
    // indistinguishable, so the error is carried out of the catch and
    // reported as its own cause.
    let armed = false
    let armError = null
    try { armed = armedTradeKeys(db, getState, accountId).has(TSMOM_STRATEGY) } catch (err) { armed = false; armError = err }
    if (armError) {
      summary.armCheckFailed++
      summary.skipped.push(`${accountId}: arm check failed — ${armError.message} (NOT a configuration choice; the strategy's armed state is unknown)`)
      continue
    }
    if (!armed) {
      summary.notArmed++
      summary.skipped.push(`${accountId}: ${TSMOM_STRATEGY} not armed`)
      continue
    }
    if (deps.phasesOn && !deps.phasesOn(accountId)) { summary.skipped.push(`${accountId}: autotrade off`); continue }
    const creds = credsFor(acct)
    if (!creds) { summary.skipped.push(`${accountId}: no credentials`); continue }
    summary.accounts++
    const headroom = headroomOf(acct)
    const marginExhausted = headroom != null && headroom <= 0
    if (marginExhausted) summary.skipped.push(`${accountId}: margin exhausted (headroom $${headroom.toFixed(2)}) — no entries this pass`)

    // PR-P (16-09-2026): THE PER-ACCOUNT ENTRY BRAKE, on the book's own
    // horizon. Every automatic brake `tsmom_long` passes through today reads
    // CLOSED trades — 3 for the adaptive breaker, 15 for the edge watchdog,
    // 30 for the strategy verdict the risk gate applies at risk.js clause 5b
    // — and this book holds a position for 10 to 60 DAYS, so none of them can
    // fire inside the horizon they are meant to bound. This one reads the
    // positions the account is ALREADY holding, marked from the trail pass's
    // own bars, and needs no closes at all. Computed ONCE per account here,
    // and handed to BOTH entry paths, so the two can never disagree about
    // whether this account may add exposure.
    //
    // It is evaluated for every account whether or not the margin brake
    // already fired, because the two are different facts and the summary is
    // what an operator reads. It gates ENTRIES only — the exits below it, the
    // stop, the exit_pending retry and the owed-exit sweep never consult it.
    // BOTH LINES ARE PUSHED HERE, for EVERY account, on EVERY pass — not by
    // the path the account happens to take (checker MAJOR 2). The daily pass
    // returns early on `not due`, which is most passes for most accounts, so
    // a reason emitted from inside it would appear once a day; and the first
    // draft emitted nothing at all unless the brake BLOCKED, which made the
    // blind case the silent case. `notice` is present whenever anything on
    // the account could not be read, block or no block.
    const entryBrake = bookEntryBrake(db, { accountId, marks: state.marks, markFail: state.markFail, bookCfg: cfg, now })
    // ONE LINE PER ACCOUNT (checker MINOR 1, second round). The block reason
    // already carries the unread phrase, so emitting the notice alongside it
    // cost a blind account two lines to say one thing — and with seven armed
    // accounts that filled `skipped.slice(0, 4)` twice over, pushing every
    // other reason (margin exhausted, not armed, per-symbol skips) out of the
    // log entirely. `notice` is null whenever `reason` is set.
    if (entryBrake.block) {
      summary.entriesBraked = (summary.entriesBraked || 0) + 1
      if (/UNREADABLE/.test(entryBrake.reason)) summary.entriesBrakedBlind = (summary.entriesBrakedBlind || 0) + 1
      summary.skipped.push(`${accountId}: ${entryBrake.reason}`)
    } else if (entryBrake.notice) {
      summary.skipped.push(`${accountId}: ${entryBrake.notice}`)
    }

    // ADOPTION RUNS FOR EVERY ACCOUNT, the momentum account included
    // (measured 08-09-2026 21:32 SGT: four MSFT.US limits filled at the US
    // open; the three row-cursor accounts adopted theirs with the trailing
    // stop, ACCT-DEMO-3 did not, because this block sat below the momentum
    // account's `continue` and its fill stayed under the keeper).
    // ADOPT FILLS the book did not see land: a closed-market limit placed
    // through autoTrade returns nothing at dispatch and fills hours later as
    // an ordinary tsmom_long trade — which the keeper would then manage with
    // its partial-at-1R and bank-at-4R. Measured 03-09 07:24 SGT: the first
    // pass placed 14 resting limits and the book held 0 rows. Every open
    // tsmom_long trade on this account without a book row is adopted here,
    // the keeper paused, the ATR filled in by the trail pass below.
    for (const t of openTsmomTrades.all(accountId, TSMOM_STRATEGY)) {
      // §4-P: an EXISTING row no longer ends this trade's story. A row that
      // names neither a trade nor a position is the daily pass's orphan (the
      // resting-limit path, where the trade lookup ran before the fill), and
      // skipping it here is what left the fill unadopted for ever — keeper
      // managed, 1.5R capped, exempt from nothing. It is completed instead.
      if (openRow.get(accountId, t.symbol)) continue
      // §4-P (21-09-2026): the row and the keeper hand-over are ONE
      // transaction, through the one shared writer. They were two loose
      // statements here; see the note at the top of book-entry-write.js.
      // The row carries the trade's own side (PR-D): a SELL fill is a short
      // row. The keeper is paused in the same transaction as the row insert,
      // while broker-native TP1 is preserved on both persistence rows.
      const handed = bookEntryWrite(db, {
        accountId,
        row: {
          tradeId: t.id, symbol: t.symbol,
          positionId: t.ctrader_position_id ?? null,
          side: String(t.side || '').toUpperCase() === 'SELL' ? 'short' : 'long',
          entry: t.entry_price, stop: t.sl_price, atr: null, rank: null,
          enteredAt: new Date(now).toISOString(),
          note: `adopted filled order (trade ${t.id})`,
        },
      })
      // Wave 2 (§K·8): a tsmom_long fill the reconciler adopted is THIS
      // book's own resting-limit fill (the daily pass placed it, the market
      // was closed). It is clean bot evidence, not an external position —
      // 19 of 23 book closes were excluded from every edge measure because
      // they carried `reconciler_adopted`.
      try {
        db.prepare(`UPDATE trades SET origin = 'bot_pending_fill', origin_source = 'book_link' WHERE id = ? AND (origin IS NULL OR origin = 'reconciler_adopted')`).run(t.id)
      } catch { /* an older schema without origin columns: the link stands */ }
      summary.adopted++
      // The line says what was actually done, not what was attempted: a trade
      // with no monitor row is adopted into the book but has no keeper to
      // pause, and claiming otherwise is how a true-sounding log lies.
      log(`momentum book: adopted ${t.symbol} on …${accountId.slice(-4)} (trade ${t.id}, stop ${t.sl_price}${handed.handedOver ? '; keeper paused, TP1 preserved' : '; no monitor row to pause'})`)
    }

    // A MOMENTUM ACCOUNT (owner 07-09-2026, §7,386·D1; every enabled account
    // under `_all` since PR-B, 11-09-2026) runs the momentum system on its
    // own terms — target portfolio from the shadow's holdings ∩ the tradable
    // universe, vol-target sizing from THIS account's equity (the pass reads
    // deps.equity(accountId), never a global), one decision per day after
    // the daily close, its own lastRunMs cursor. The row-cursor path below
    // is for accounts the config does not name; the trail pass at the
    // bottom still covers every open book row, these included.
    if (isMomentumAccount(db, accountId)) {
      try {
        // PR-P: the SAME brake object the row-cursor path below uses, computed
        // once above. Passing the verdict rather than the marks is what makes
        // "one brake, not two" true in code and not only in the comment.
        const ma = await runMomentumAccountPass(db, { acct, creds, bookCfg: cfg, buildEntrySynth, deps, now, log, marginExhausted, entryBrake, entriesHeld })
        // COUNT WHAT WENT OUT, not what the pass called itself (checker,
        // 16-09-2026): the margin-exhausted branch returns `ran: false` AFTER
        // sending its exits, so real closes were reported as zero — which is
        // also what hid from this summary the fact that `accountId: "_all"`
        // routes every account through here and none through the row-cursor
        // path below.
        summary.entries += ma.entries || 0
        summary.exits += ma.exits || 0
        summary.rankExitsDeferred += ma.rankExitsDeferred || 0
        summary.deferredClosed += ma.deferredClosed || 0
        if (ma.ran || ma.exits || ma.entries || ma.rankExitsDeferred) {
          summary.momentumAccount = { account: accountId, ran: !!ma.ran, entries: ma.entries, exits: ma.exits, rankExitsDeferred: ma.rankExitsDeferred || 0, universe: ma.universe, why: ma.why || null }
        }
        for (const s of ma.skipped || []) summary.skipped.push(`${accountId} ${s}`)
      } catch (err) { summary.skipped.push(`${accountId}: momentum account pass failed — ${err.message}`) }
      continue
    }

    // THE ROW-CURSOR EXIT PATH. Reminder from the header: while
    // momentum-account.json says `"accountId": "_all"`, execution never
    // reaches here — every enabled account returned at the `continue` above.
    // EXITS first: the ranking says the name left the band. The shadow rows
    // are read once through the cursor, so a close that FAILED (09-09-2026:
    // LLY.US, volume missing) is flagged on the row and retried every pass
    // until it goes — an exit the ranking called is not dropped on an error.
    const acctExits = new Map()
    // PR-K: is the book's rank-exit opinion due on this account today?
    // 'every_pass' restores the pre-PR-K behaviour exactly: always due.
    const rankExitDue = everyPass || dailyDue({ nowMs: now, lastRunMs: Number(state.rankExitAt?.[accountId]) || 0, afterUtc: maCfg.dailyRunAfterUtc, cadence: 'daily' })
    const deferredFlips = new Set()
    // A deferral is RECORDED here and only COUNTED after the exit set is
    // complete (checker MINOR, 16-09-2026): block (2)'s refused-exit retry
    // can re-admit a name block (1) held back, and counting both reported
    // `rankExitsDeferred: 1` — with a "rank exit held" line — for a position
    // that closed on the same pass. First reason per name wins.
    const pendingDeferrals = new Map()
    const deferRankExit = (symbol, why) => { if (!pendingDeferrals.has(symbol)) pendingDeferrals.set(symbol, why) }
    // A DEFERRED FLIP IS REMEMBERED (checker MINOR, 16-09-2026). The shadow's
    // `enter` row for the new side is consumed by `lastShadowRowId` on the
    // pass that defers the flip, so "the reconcile pass will re-propose it"
    // holds only while the shadow still HOLDS that name and its hourly
    // throttle has elapsed — with shadow state absent, or inside the
    // RECONCILE_EVERY_MS window, the new side was simply lost. The book now
    // carries the intent on its own state and enters it on the same pass
    // that finally sends the flip exit: a flip stays ONE pass, as PR-D built
    // it, whether it happens today or at tomorrow's daily close.
    const rememberFlip = (symbol, want) => {
      deferredFlips.add(symbol)
      state.pendingFlips[`${accountId}|${symbol}`] = { symbol, side: want.to, conviction: want.conviction ?? null, rankPct: want.rankPct ?? null, at: now }
    }

    // (1) THE RANKING'S OPINION — the name left its band, or this batch's
    // `enter` is on the other side of an open row (a FLIP; the checker's
    // counterexample, 11-09-2026). PR-K: an opinion is evaluated once per
    // book day and never on a position younger than bookMinHoldHours. The
    // position's STOP is not touched by either rule — it sits at the broker
    // and is hit whenever price hits it; that is what bounds a position the
    // book now carries to the evening.
    const wantRankExit = new Map(exits)
    for (const [symbol, r] of enters) {
      const open = openRow.get(accountId, symbol)
      if (open && (open.side === 'short' ? 'short' : 'long') !== r.side) wantRankExit.set(symbol, { symbol, flip: true, to: r.side, conviction: r.conviction, rankPct: r.rank_pct })
    }
    for (const [symbol, want] of wantRankExit) {
      const row = openRow.get(accountId, symbol)
      if (!row) continue
      if (!rankExitDue) {
        deferRankExit(symbol, `cadence ${cfg.bookExitCadence}: rank exits are decided once per UTC day after ${maCfg.dailyRunAfterUtc}Z`)
        // A flip whose exit waits must not enter the other side this pass, or
        // the book holds BOTH sides of the name (owner principle 8's whole
        // point is direction). tryEnter's open-row check already refuses it;
        // this says so by name in the summary rather than by accident.
        if (want?.flip) rememberFlip(symbol, want)
        continue
      }
      if (!heldLongEnough(row)) {
        deferRankExit(symbol, heldWhy(row))
        if (want?.flip) rememberFlip(symbol, want)
        continue
      }
      acctExits.set(symbol, want)
    }

    // (2) EVERY PASS, CADENCE OR NO CADENCE — an exit the broker REFUSED.
    // 09-09-2026: LLY.US came back MARKET_CLOSED / volume missing. An owed
    // exit that only retries once a day is an exit that may never go, and
    // this is an order already sent, not a fresh opinion: neither the daily
    // cadence nor the min hold may touch it.
    for (const r of db.prepare(`SELECT symbol FROM momentum_book WHERE status = 'open' AND account_id = ? AND note LIKE 'exit_pending:%'`).all(accountId)) {
      if (!acctExits.has(r.symbol)) acctExits.set(r.symbol, { symbol: r.symbol, retry: true })
    }
    // And the ranking's LAST WORD (09-09-2026, the LLY.US residue): a row
    // whose close was refused BEFORE the flag existed carries no flag, and
    // the cursor never re-reads the exit row. So any open row whose newest
    // shadow enter/exit row for the symbol says `exit`, written AFTER the
    // row was entered, is an exit still owed. Rows the shadow never ranked
    // (adopted names) have no word and are untouched; a re-entry after an
    // exit has a newer `enter` word, or an entered_at after the exit.
    // ... or says `enter` on the OTHER side (a flip whose exit was missed):
    // the same owed exit.
    const lastWord = db.prepare(`SELECT action, side, at FROM momentum_shadow WHERE symbol = ? AND action IN ('enter', 'exit') ORDER BY id DESC LIMIT 1`)
    for (const r of db.prepare(`SELECT b.symbol, b.side, b.entered_at FROM momentum_book b LEFT JOIN trades t ON t.id = b.trade_id WHERE b.status = 'open' AND b.account_id = ? AND (t.status IS NULL OR t.status = 'open')`).all(accountId)) {
      if (acctExits.has(r.symbol)) continue
      const w = lastWord.get(r.symbol)
      if (!w || !(String(w.at) > String(r.entered_at || ''))) continue
      const rowSide = r.side === 'short' ? 'short' : 'long'
      if (!(w.action === 'exit' || (w.action === 'enter' && w.side !== rowSide))) continue
      // PR-K. This sweep reconstructs an exit from the ranking's last word,
      // so it has to say WHICH DAY that word is from, or it would re-admit
      // every deferred intraday exit one pass later and the cadence would be
      // decoration (failure mode #3: a guard whose trigger is out of reach).
      //   • a word from a PREVIOUS book day = an exit DECIDED on a past day
      //     and never executed. It goes on EVERY pass, not only the daily
      //     one — an owed exit that waits for 21:05 is an exit that may sit
      //     owed for a day. The min hold still applies: the book day rolls
      //     at 21:05, so "previous day" can be ninety minutes ago, and the
      //     owner's floor on how long a position is held is not something a
      //     clock boundary may lift.
      //   • a word from TODAY = today's opinion. It waits for today's daily
      //     pass and the min hold, exactly like the fresh rows above.
      const decidedMs = parseStamp(w.at)
      const fromPreviousDay = Number.isFinite(decidedMs) ? decidedMs < bookDayStart(now) : true
      const row = openRow.get(accountId, r.symbol)
      if (!fromPreviousDay && !rankExitDue) { deferRankExit(r.symbol, `cadence ${cfg.bookExitCadence}: today's rank exit waits for the daily pass after ${maCfg.dailyRunAfterUtc}Z`); continue }
      if (row && !heldLongEnough(row)) { deferRankExit(r.symbol, heldWhy(row)); continue }
      acctExits.set(r.symbol, { symbol: r.symbol, retry: true, owed: true, flip: w.action === 'enter' })
    }
    // The exit set is final: count the deferrals that survived it, and drop
    // the flip bookkeeping for any name block (2) or (3) admitted after all.
    for (const [symbol, why] of pendingDeferrals) {
      if (acctExits.has(symbol)) { deferredFlips.delete(symbol); delete state.pendingFlips[`${accountId}|${symbol}`]; continue }
      summary.rankExitsDeferred++
      summary.skipped.push(`${accountId} ${symbol}: rank exit held — ${why}`)
    }

    for (const [symbol] of acctExits) {
      const row = openRow.get(accountId, symbol)
      if (!row) continue
      // Hours first (Wave 5, §K·15): a market the BROKER's schedule says is
      // closed gets no broker call. The row keeps its note (exit_pending /
      // owed), the retry stays owed, and the pass counts it. Only a
      // symbol_hours row (source 'broker') may defer: with no row,
      // isSymbolOpenCached falls to the sessions.js heuristic, which calls
      // US500 closed at 02:00 UTC and XTIUSD closed outside New York — a
      // wrongly deferred exit on an open market is the worse error, so the
      // heuristic and an error both ATTEMPT the close (one refused line at
      // worst).
      const deferKey = `${accountId}|${symbol}`
      let hours = { open: true, source: 'unknown' }
      try { hours = (deps.isSymbolOpen ?? isSymbolOpenCached)(db, symbol, new Date(now)) } catch { hours = { open: true, source: 'error' } }
      if (hours.open === false && hours.source === 'broker') {
        summary.deferredClosed++
        // A flip whose exit waits for the market keeps its other side on the
        // book's own state, exactly as the cadence deferral does — the
        // cursor has consumed the shadow's `enter` row, so nothing else would.
        const want = acctExits.get(symbol)
        if (want?.flip && want.to) rememberFlip(symbol, want)
        if (!deferredClosed.has(deferKey)) {
          deferredClosed.set(deferKey, now)
          log(`momentum book: exit of ${symbol} on …${accountId.slice(-4)} deferred — market closed (${hours.source}); retried when it opens, not per pass`)
        }
        continue
      }
      if (deferredClosed.has(deferKey)) {
        const since = deferredClosed.get(deferKey)
        deferredClosed.delete(deferKey)
        log(`momentum book: market open for ${symbol} on …${accountId.slice(-4)} — resuming the deferred exit (deferred ${Math.round((now - since) / 60_000)} min)`)
      }
      try {
        if (row.position_id && deps.close) {
          const coordinated = await runMomentumRankExit(db, creds, row, deps)
          if (!coordinated.handled) {
            const volume = await bookCloseVolume(db, creds, row, deps)
            if (volume == null) throw new Error('unknown volume — close not sent')
            await deps.close(creds, { positionId: row.position_id, volume })
          }
        }
        const why = acctExits.get(symbol)?.flip ? 'rank exit (flip)' : 'rank exit'
        db.prepare(`UPDATE momentum_book SET status = 'exit_sent', exited_at = ?, note = ? WHERE id = ?`).run(new Date(now).toISOString(), why, row.id)
        // Journal the close for the reconciler's attribution (fix-the-exits
        // BA). The trade row itself is NOT closed here: exit_sent is the
        // broker's acceptance, the fill is what the reconciler sees.
        // Wave 2 (§K·8): journal by trade id when the position id is still
        // unknown (a resting-limit fill the reconciler adopted) — the
        // reconciler's attribution matches on either key, and 17 of 23 book
        // closes read "closed at the broker" because this line required the
        // position id.
        if (row.position_id || row.trade_id) {
          recordPositionEvent(db, {
            accountId, positionId: row.position_id || null, tradeId: row.trade_id, symbol, kind: 'close',
            reason: why, source: 'momentum_book',
          })
        }
        summary.exits++
        log(`momentum book: ${why} ${symbol} on …${accountId.slice(-4)}`)
      } catch (err) {
        // `status = 'open'`: a failure after the row reached exit_sent (the
        // journal line throwing) must not relabel a sent exit as owed.
        db.prepare(`UPDATE momentum_book SET note = ? WHERE id = ? AND status = 'open'`).run(`exit_pending: ${String(err.message).slice(0, 160)}`, row.id)
        summary.skipped.push(`${accountId} ${symbol}: close failed — ${err.message}`)
      }
    }
    // PR-K: the day's rank-exit pass has now run ON THIS ACCOUNT, whether or
    // not anything was exited — stamp this account's own cursor so it runs
    // once per book day and one account's pass never consumes another's.
    // A close that FAILED is not forfeited by the stamp: the row carries the
    // exit_pending flag and block (2) above retries it on EVERY pass.
    if (rankExitDue && !everyPass) state.rankExitAt[accountId] = now


    // A remembered flip whose old row is no longer open enters the other side
    // in THIS pass (below, with the ordinary entries). The record is dropped
    // whether the entry is then taken or refused: a refusal is the direction
    // policy's answer, not something to re-ask every day.
    const flipEntries = []
    for (const [key, fl] of Object.entries(state.pendingFlips)) {
      if (!key.startsWith(`${accountId}|`)) continue
      if (!(now - Number(fl.at || 0) <= PENDING_FLIP_TTL_MS)) { delete state.pendingFlips[key]; summary.skipped.push(`${accountId} ${fl.symbol}: deferred flip entry expired (older than ${PENDING_FLIP_TTL_MS / 86_400_000}d)`); continue }
      if (openRow.get(accountId, fl.symbol)) continue    // the old row is still open — the flip exit has not gone yet
      delete state.pendingFlips[key]
      if (enters.has(fl.symbol)) continue                 // this batch carries the enter row itself
      flipEntries.push(fl)
    }

    // ONE ENTRY ATTEMPT, shared by the shadow's fresh `enter` rows and the
    // reconcile pass below. Returns 'entered' | 'skipped' | 'capped'.
    // PR-D: `side` is the shadow's side; the direction policy decides whether
    // this account may take it (a short needs the 9/10 floor and no up-trend
    // reading), and its reason rides the synth as direction_reason.
    const tryEnter = async (symbol, { side = 'long', conviction = null, rankPct = null, note }) => {
      if (marginExhausted) return 'capped'
      if (entriesHeld) return 'capped'   // S-2: the scan did not run this cycle
      // PR-P. 'capped', not 'skipped': the caller stops offering this account
      // names for the rest of the pass, exactly as the margin brake and
      // maxPositionsPerAccount do. The reason was pushed to summary.skipped
      // once above, per account, rather than once per symbol — a brake that
      // prints forty identical lines pushes every other reason out of the
      // four the loop logs.
      if (entryBrake.block) return 'capped'
      if (openRow.get(accountId, symbol)) return 'skipped'
      // A short's conviction must be a NUMBER (checker item h): no fallback
      // to the book's default for the side that needs the 9/10 floor.
      const dp = directionFor({ side, conviction: side === 'short' ? conviction : (conviction ?? cfg.conviction), trendDirection: trendReadingFor(db, symbol), cfg: shadowCfg })
      if (!dp.ok) { summary.skipped.push(`${accountId} ${symbol}: ${dp.reason}`); return 'skipped' }
      // THE REGIME GATE ON THE BOOK'S PATH (checker MAJOR 1, 11-09-2026: only
      // dispatchSymbolSignal called it, so trend-in-quiet, the stale posture
      // and the owner's on switch never reached a book entry). A block is a
      // decision_log skip row, the same shape PR-C gives the scan's blocks.
      const rg = checkRegimeGate(db, TSMOM_STRATEGY, side, symbol)
      if (rg.block) {
        try { recordDecision(db, { accountId, symbol, strategy: TSMOM_STRATEGY, stage: 'regime_gate', decision: 'skip', reason: rg.reason }) } catch { /* provenance never blocks */ }
        summary.skipped.push(`${accountId} ${symbol}: ${rg.reason}`); return 'skipped'
      }
      // The account's daily fundable universe (§7,437·B·3): a name whose
      // minimum lot this account cannot fund is skipped by name, before any
      // bars or quotes are fetched for it. Unknown is not a block.
      if (deps.fundable) {
        const fu = deps.fundable(accountId, symbol)
        if (fu && fu.ok === false) { summary.skipped.push(`${accountId} ${symbol}: ${fu.reason}`); return 'skipped' }
      }
      if ((openCount.get(accountId)?.n || 0) >= cfg.maxPositionsPerAccount) { summary.skipped.push(`${accountId}: at maxPositionsPerAccount`); return 'capped' }
      const may = deps.mayTrade ? deps.mayTrade(accountId, symbol) : { ok: true, item: null }
      if (!may.ok) { summary.skipped.push(`${accountId} ${symbol}: ${may.reason}`); return 'skipped' }
      // THIS ACCOUNT's id (03-09-2026): `symbolIdFor(creds, symbol)` reads the
      // account's own symbol list; the shared map is the fallback only for
      // callers that inject no resolver (tests). The first pass with the
      // shared map read LLY.US at 6.56 on ACCT-LIVE-1 and ordered it.
      const symbolId = deps.symbolIdFor
        ? await deps.symbolIdFor(creds, symbol)
        : deps.symbolMap?.[String(symbol).toUpperCase()]
      if (symbolId == null) { summary.skipped.push(`${accountId} ${symbol}: not in this account's symbol list`); return 'skipped' }
      try {
        const bars = deps.bars ? await deps.bars(creds, symbolId) : []
        const atr = atrOf(bars, cfg.atrPeriod)
        const q = deps.spot ? await deps.spot(creds, symbolId) : null
        // A long lifts the ask, a short hits the bid (PR-D).
        const live = side === 'short' ? Number(q?.bid) : Number(q?.ask)
        const price = live > 0 ? live : Number(bars[bars.length - 1]?.c)
        const synth = buildEntrySynth({ symbol, price, atr, cfg, conviction, rankPct, side, directionReason: dp.reason })
        if (!synth) { summary.skipped.push(`${symbol}: no usable price/ATR`); return 'skipped' }
        const result = await deps.autoTrade(db, symbol, synth, may.item || null, { accountId, isLive: !!acct.isLive, producerId: 'cross_sectional_book', sharedAccounts: ordered.length })
        if (!result) { summary.skipped.push(`${accountId} ${symbol}: not filled (gate or broker)`); return 'skipped' }
        const t = tradeRowFor.get(symbol, accountId, TSMOM_STRATEGY)
        // §4-P (21-09-2026): through the ONE shared writer. This site was the
        // drift the shared rule exists to end — it paused the monitor and
        // stopped there, leaving `monitored_positions.current_tp` and
        // `trades.tp_price` set. A closed-market limit carries a 1.5R take
        // profit, so a row entered here kept a 1.5R ceiling on a weeks-horizon
        // position and the target-restore sweep put it back at the broker
        // after the trail amend cleared it. The other two writers already
        // cleared both; this one did not.
        bookEntryWrite(db, {
          accountId,
          row: {
            tradeId: t?.id ?? null, symbol, positionId: t?.ctrader_position_id ?? null, side,
            entry: t?.entry_price ?? synth.entry, stop: t?.sl_price ?? synth.sl,
            atr, rank: rankPct, enteredAt: new Date(now).toISOString(), note,
          },
        })
        summary.entries++
        log(`momentum book: ${side} ${symbol} on …${accountId.slice(-4)} @ ${synth.entry} stop ${synth.sl.toFixed(5)} (${note}; ${dp.reason})`)
        return 'entered'
      } catch (err) { summary.skipped.push(`${accountId} ${symbol}: ${err.message}`); return 'skipped' }
    }

    // ENTRIES: one per symbol per account, capped, sized by the gate.
    let capped = false
    for (const [symbol, r] of enters) {
      // PR-K: a flip whose exit was deferred does not enter the other side —
      // the book is never left holding both sides. The shadow still holds the
      // new side, so the reconcile pass below re-proposes it once the daily
      // pass has actually exited the old row.
      if (deferredFlips.has(symbol)) { summary.skipped.push(`${accountId} ${symbol}: flip entry waits for its flip exit (rank-exit cadence ${cfg.bookExitCadence})`); continue }
      if (!inScanScope(symbol)) { summary.skipped.push(`${accountId} ${symbol}: outside this account's scan universe (momentum-account name)`); continue }
      const out = await tryEnter(symbol, { side: r.side, conviction: r.conviction, rankPct: r.rank_pct, note: `entered on shadow row ${r.id}` })
      if (out === 'capped') { capped = true; break }
    }
    // The other leg of a flip deferred on an earlier pass, now that its exit
    // has gone: same gates, same sizing, stated on the row.
    for (const fl of flipEntries) {
      if (capped) break
      if (!inScanScope(fl.symbol)) { summary.skipped.push(`${accountId} ${fl.symbol}: outside this account's scan universe (momentum-account name)`); continue }
      const out = await tryEnter(fl.symbol, { side: fl.side, conviction: fl.conviction, rankPct: fl.rankPct, note: `flip entry ${fl.side} after the deferred flip exit` })
      if (out === 'capped') capped = true
    }

    // RECONCILE (owner "build it", 03-09-2026, §7,272·B): the shadow emits an
    // `enter` row only on the flat→long transition, so a name it keeps holding
    // whose order never filled — a closed-market limit that expired, a gate
    // refusal on the day — was never tried again. Every pass, each long the
    // shadow holds on an armed account with no open book row and no working
    // tsmom limit is re-proposed at the current price, at most once per
    // symbol per account per RECONCILE_EVERY_MS so a standing refusal
    // (duplicate_symbol on a bot-held name) is not re-logged every cycle.
    if (!capped) {
      let held = {}
      try { held = loadShadowState(db).holdings || {} } catch { held = {} }
      for (const [symbol, h] of Object.entries(held)) {
        if ((h?.side !== 'long' && h?.side !== 'short') || enters.has(symbol)) continue
        if (!inScanScope(symbol)) continue
        if (openRow.get(accountId, symbol)) continue
        if (workingLimitFor.get(accountId, symbol)) continue
        const key = `${accountId}|${symbol}`
        const last = Number(state.reconciledAt?.[key]) || 0
        if (now - last < RECONCILE_EVERY_MS) continue
        state.reconciledAt = { ...(state.reconciledAt || {}), [key]: now }
        summary.reconciled++
        const out = await tryEnter(symbol, { side: h.side, conviction: h.entryConviction ?? null, rankPct: h.entryRank ?? null, note: `reconciled: shadow still holds ${symbol} ${h.side}` })
        if (out === 'capped') break
      }
    }
  }

  // TRAIL: every open book position, every pass — the stop only moves in the
  // trade's favour (up for a long, down for a short — PR-D).
  // PR-K DELIBERATELY DOES NOT TOUCH THIS PASS. A stop is protection, not an
  // opinion: it is what bounds a position the book now carries from a morning
  // rank-out to the evening pass, so it keeps being maintained on every loop
  // and the broker keeps holding it. Only the RANKING moved to daily.
  // PR-P: the marks the entry brake reads on the NEXT pass, and WHY a row
  // could not be freshly marked when it could not. Rebuilt from the rows the
  // book still CARRIES — `open` AND `exit_sent`, the same status set
  // momentumBookReport and momentumAccountReport use — so a closed position's
  // price can never keep weighing on an account's reading, and a row whose
  // bars failed this pass keeps its last honest mark instead of silently
  // becoming "unmarked".
  //
  // `exit_sent` IS STILL CARRIED EXPOSURE (checker MAJOR 1, 16-09-2026): the
  // close has been SENT, not confirmed, and the row only becomes `closed`
  // when a later pass sees the trade gone. Reading only `open` meant the
  // brake went blind on the pass AFTER the book decided an account's
  // positions were bad — it rank-exited two rows and the account's reading
  // dropped to `rows: 0`, which took the "nothing to be blind about"
  // carve-out and emitted NO line at all. The carry below is deliberately
  // OUTSIDE the trail loop, which still selects `open` only: an `exit_sent`
  // row keeps the last mark it had while open, and nothing about the exit
  // path — no amend, no stop, no retry — is touched by this.
  // PR-AX: `exit_sent` IS NO LONGER A DEAD END.
  //
  // MEASURED 18-09-2026 from /state/momentum-book: 28 rows `open`, every one
  // carrying a fresh trail stamp; 8 rows `exit_sent`, not one stamped, the
  // oldest fifteen days old. The only branch that moves a row to `closed`
  // lives inside the trail loop below — and that loop selects `status =
  // 'open'`. So a row that reached `exit_sent` could never be reclassified by
  // the code whose whole job is to reclassify it. The state only accumulated,
  // and the report — which counts `open` + `exit_sent` — presented 36 open
  // book positions where 28 were open.
  //
  // WHY THIS IS A SEPARATE SWEEP AND NOT A WIDER LOOP QUERY. Widening the
  // trail loop to walk `exit_sent` was the first version of this fix, and it
  // turned PR-P MAJOR 1 red: walking those rows RE-PRICES them, which
  // replaces the carried marks the entry brake judges an account on. That
  // test also states the rule directly — the trail "selects `open` only, and
  // must keep doing so — trailing an exited row is exit behaviour" — and it
  // is right. An exit that was REFUSED leaves the row `open` with an
  // `exit_pending` note and is retried every pass, so it keeps its trail;
  // `exit_sent` means the broker ACCEPTED the close. There is no untrailed
  // live position here, only a status that could not advance.
  //
  // So this touches exactly one thing: a row whose trade has REACHED A
  // TERMINAL STATE stops claiming to be part of the book.
  //
  // TERMINAL IS TWO STATES, NOT ONE (Codex review on #946, verified against
  // reconciler.js:489). The reconciler de-duplicates trades that share one
  // broker position: the newest row is kept and the older ones are set to
  // `rejected` — deliberately not `closed`, because a closed duplicate gets
  // the same broker P&L stamped onto it by the backfill and one real loss
  // gets counted once per duplicate row.
  //
  // Nothing relinks `momentum_book.trade_id` when that happens. So a book row
  // pointing at a de-duplicated trade would never match a `= 'closed'`
  // predicate and would sit in `exit_sent` for ever — the exact dead end this
  // sweep exists to remove, reintroduced through a state the first version
  // did not enumerate.
  //
  // THE VOCABULARY IS THE SCHEMA'S, not a guess: db.js CHECKs trades.status
  // against open / closed / cancelled / rejected / submitting / unconfirmed.
  // Terminal for a book row is closed, rejected and cancelled; `submitting`
  // and `unconfirmed` are IN FLIGHT and must not retire anything.
  //
  // NAMED, not `<> 'open'`: with two in-flight states in that list, a
  // negation would retire a row the moment an order was mid-submission. A new
  // terminal state gets added here deliberately, which is also how `rejected`
  // was found in the first place (db.js:43).
  {
    const done = db.prepare(`SELECT id,
                                    COALESCE((SELECT t.status FROM trades t WHERE t.id = momentum_book.trade_id), 'open') AS tstatus
                               FROM momentum_book WHERE status = 'exit_sent'
                              AND COALESCE((SELECT t.status FROM trades t WHERE t.id = momentum_book.trade_id), 'open')
                                  IN (${[...BOOK_TERMINAL_TRADE_STATES].map(x => `'${x}'`).join(', ')})`).all()
    for (const r of done) {
      db.prepare(`UPDATE momentum_book SET status = 'closed', exited_at = COALESCE(exited_at, ?), note = COALESCE(note, '') || ' | trade ' || ? WHERE id = ?`)
        .run(new Date(now).toISOString(), r.tstatus, r.id)
    }
    summary.reclassified = done.length
  }

  const prevMarks = state.marks || {}
  const markFail = {}
  const nextMarks = {}
  // The SAME predicate the brake reads (book-open-drawdown.js OPEN_ROWS_SQL):
  // a row whose trade is closed is not exposure whatever its own status says,
  // and nothing in this repo ever moves a row out of 'exit_sent'. Carrying a
  // mark for one would keep a dead position weighing on the account for ever.
  for (const r of db.prepare(`SELECT account_id, symbol FROM momentum_book
                               WHERE status IN ('open', 'exit_sent')
                                 AND COALESCE((SELECT t.status FROM trades t WHERE t.id = momentum_book.trade_id), 'open') NOT IN ('closed', 'rejected', 'cancelled')`).all()) {
    const k = markKey(r.account_id, r.symbol)
    if (prevMarks[k]) nextMarks[k] = prevMarks[k]
  }
  // PR-AV: the trail's work is recorded on EVERY pass that reaches it, not
  // only on a pass that moved the stop.
  //
  // THE DEFECT, measured 18-09-2026 from /state/momentum-book: five of 36 open
  // rows carried `atr: null`, two of them open since 07-09. The stored `atr`
  // was written in one place only -- inside the `trailImproves` branch below --
  // so a row whose 3-ATR trail sat WIDER than its current stop never wrote one.
  // That is the correct and common outcome of a wide trail, and it was
  // indistinguishable in the read from a row the ratchet had never reached at
  // all. The stored value was never an INPUT to anything (the trail recomputes
  // ATR from bars every pass), so nothing traded wrong -- but the only panel
  // that answers "is the ratchet alive on this row" could not tell a working
  // ratchet from a dead one. Failure mode #3, in its reporting half: two
  // conditions with different remedies collapsed into one null.
  //
  // So: every branch below that ends this row's pass says what it decided.
  const noteTrail = (id, note, atr = null) => {
    try {
      db.prepare(`UPDATE momentum_book SET trail_checked_at = ?, trail_note = ?, atr = COALESCE(?, atr) WHERE id = ?`)
        // `atr == null` FIRST: Number(null) is 0 and Number.isFinite(0) is
        // true, so the obvious one-liner writes a real-looking ATR of zero
        // onto a row that could not compute one — the same null-is-not-zero
        // trap trailStop's own comment warns about, walked straight into on
        // the first draft of this fix and caught by the thin-bars test.
        .run(new Date(now).toISOString(), String(note).slice(0, 200),
          atr == null || !Number.isFinite(Number(atr)) ? null : Number(atr), id)
    } catch { /* the trail must not fail on its own bookkeeping */ }
  }
  for (const row of db.prepare(`SELECT b.*, mp.current_tp
                                  FROM momentum_book b
                                  LEFT JOIN monitored_positions mp
                                    ON mp.trade_id = b.trade_id AND mp.status = 'active'
                                 WHERE b.status = 'open'`).all()) {
    const rowSide = row.side === 'short' ? 'short' : 'long'
    const mk = markKey(row.account_id, row.symbol)
    const acct = accounts.find(a => String(a.accountId) === String(row.account_id))
    const creds = acct ? credsFor(acct) : null
    const symbolId = creds && deps.symbolIdFor
      ? await deps.symbolIdFor(creds, row.symbol)
      : deps.symbolMap?.[String(row.symbol).toUpperCase()]
    // A TERMINAL trade closes the book row; the reconciler is the authority
    // on the close. B3 (18-09-2026): terminal is closed, rejected AND
    // cancelled — the same three PR-AZ enumerated for exit_sent rows. This
    // branch read `= 'closed'` alone, so an OPEN book row whose trade the
    // reconciler de-duplicated to `rejected` (or whose order was cancelled
    // before it filled) kept being trailed as a live position for ever: the
    // blind spot PR-AZ removed on one loop, still open on the other.
    const t = row.trade_id != null ? db.prepare(`SELECT status FROM trades WHERE id = ?`).get(row.trade_id) : null
    if (t && BOOK_TERMINAL_TRADE_STATES.has(t.status)) {
      db.prepare(`UPDATE momentum_book SET status = 'closed', exited_at = COALESCE(exited_at, ?), note = COALESCE(note, '') || ' | trade ' || ? WHERE id = ?`).run(new Date(now).toISOString(), t.status, row.id)
      // No mark to drop here: the carry above already excludes any row whose
      // TRADE is closed, which is the same condition this branch fires on. A
      // `delete nextMarks[mk]` sat here in the first draft of this fix and was
      // unreachable — a line no mutation could turn red, which is this repo's
      // definition of decoration. The carry predicate is the single place the
      // rule lives.
      continue
    }
    // Still carried: its previous mark stands (carried above) until a fresher
    // one is read. A pass that cannot reach the broker must not read as "this
    // position has no price" — that is the shape of a guard going quiet on an
    // outage. WHY it could not be re-read is recorded, because the remedy for
    // "this symbol does not resolve on this account" is nothing like the
    // remedy for "the broker was down for one pass" and the operator cannot
    // tell them apart from a count (checker MAJOR 2).
    if (!creds || symbolId == null || !deps.bars) {
      markFail[mk] = !acct ? 'account not in this pass' : !creds ? 'no credentials this pass' : symbolId == null ? 'symbol does not resolve on this account' : 'no bars reader'
      noteTrail(row.id, `not reached: ${markFail[mk]}`)
      continue
    }
    let trailStage = 'bars'
    try {
      const bars = await deps.bars(creds, symbolId)
      const atr = atrOf(bars, cfg.atrPeriod)
      const close = Number(bars[bars.length - 1]?.c)
      // PR-P: the mark. The same bar close the trail below prices its stop
      // from — one price, one horizon, no second feed to drift from the first.
      // TWO STAMPS, and the brake prefers the first (checker MINOR 3): `bt`
      // is the BAR's own epoch (ctrader-ws.js builds `t` from
      // utcTimestampInMinutes), `at` is the pass clock. Stamping the fetch
      // time alone meant a feed that kept answering with the same frozen bar
      // was never stale to the brake — staleness could only fire when the
      // fetch FAILED. A bar `t` that is not a plausible epoch (the tests'
      // index, a zeroed field) is not written, and the brake falls back to
      // `at` for that row and says so in the read.
      if (close > 0) {
        const bt = Number(bars[bars.length - 1]?.t)
        nextMarks[mk] = Number.isFinite(bt) && bt >= MIN_PLAUSIBLE_EPOCH_MS ? { c: close, at: now, bt } : { c: close, at: now }
      }
      const raw = trailStop({ prevStop: row.stop, close, atr, stopAtr: cfg.stopAtr, side: rowSide })
      // Measured 04-09-2026 (Railway logs, every minute since adoption): the
      // amend sent the raw float — 1053.4199999999998 on LLY.US, 344.358 on
      // GD.US — and the broker refused each one ("more digits than symbol
      // allows"), so the book's "stop that only rises" had never risen once.
      // The entry path never hit this because it sends rounded RELATIVE
      // distances; the amend sends an absolute price and must round it to the
      // symbol's digits itself. digitsFor is the same cached symbol record the
      // limit builder reads (lot-sizing.getVolumeMeta).
      trailStage = 'symbol metadata'
      const digits = deps.digitsFor ? await deps.digitsFor(creds, symbolId) : null
      const next = raw != null && digits != null ? roundToDigits(raw, digits) : raw
      if (next == null || !trailImproves({ side: rowSide, prevStop: row.stop, nextStop: next })) {
        // THE COMMON CASE, and the one that used to leave no trace. A 3-ATR
        // trail is wide: for a short it only improves when close + 3*ATR falls
        // below the stop already standing. Saying so — with the candidate and
        // the standing stop — is what lets an operator distinguish "working,
        // declined" from "never ran" without reading this file.
        noteTrail(row.id,
          atr == null
            ? `no ATR: ${cfg.atrPeriod}-period ATR needs ${cfg.atrPeriod + 1} bars, got ${Array.isArray(bars) ? bars.length : 0}`
            : next == null
              ? `no trail candidate (close ${close})`
              // `next` here is the RATCHET's output (Math.max/min of the
              // candidate and the standing stop), so on a declined pass it
              // simply equals the standing stop and says nothing. The
              // operator needs the unclamped candidate — what the trail
              // WOULD have set — which is the close offset by stopAtr ATRs.
              : `declined: ${cfg.stopAtr}xATR from close ${close} puts the trail at ` +
                `${Math.round((rowSide === 'short' ? close + cfg.stopAtr * atr : close - cfg.stopAtr * atr) * 1e5) / 1e5}; ` +
                `the standing stop ${row.stop} is already tighter`,
          atr)
      } else {
        // The adapter reads both protection legs from the broker immediately
        // before sending and again afterwards. A stale local TP must neither
        // overwrite a newer broker TP nor freeze a safer stop on a legacy row.
        trailStage = 'broker protection'
        if (!row.position_id || !deps.amend) throw new Error('book stop cannot be confirmed: no broker position or amendment adapter')
        const result = await deps.amend(creds, { positionId: row.position_id, stopLoss: next,
          takeProfit: Number(row.current_tp) > 0 ? Number(row.current_tp) : null, side: rowSide })
        const confirmed = result?.protection
        const stop = Number(confirmed?.stopLoss)
        if (!freshBookProtection(confirmed) || !(stop > 0) || (rowSide === 'short' ? stop > next : stop < next)) {
          throw new Error('book stop not confirmed by fresh broker read-back')
        }
        const tp = Number(confirmed.takeProfit) > 0 ? Number(confirmed.takeProfit) : null
        trailStage = 'book persistence'
        db.transaction(() => {
          db.prepare(`UPDATE momentum_book SET stop = ?, atr = ? WHERE id = ?`).run(stop, atr, row.id)
          if (row.trade_id != null) {
            db.prepare(`UPDATE trades SET sl_price = ? WHERE id = ?`).run(stop, row.trade_id)
            db.prepare(`UPDATE monitored_positions SET current_sl = ?, current_tp = ? WHERE trade_id = ?`).run(stop, tp, row.trade_id)
          }
        })()
        noteTrail(row.id, `${result.unchanged ? 'broker already tighter' : 'trailed'} ${row.stop} -> ${stop} on ${cfg.stopAtr}xATR ${atr}${tp == null ? '; TP1 still missing, decision required' : ''}`, atr)
        if (!result.unchanged) summary.trailed++

      }
    } catch (err) {
      // PR-P: the trail already names this one; the brake needs the same fact
      // in a form it can put next to the row it could not price.
      const failure = `${trailStage === 'bars' ? 'bars unavailable' : `${trailStage} failed`}: ${String(err.message).slice(0, 120)}`
      // A protection failure does not invalidate a bar that was read successfully.
      if (trailStage === 'bars') markFail[mk] = failure
      noteTrail(row.id, `${trailStage === 'bars' ? 'not reached: ' : ''}${failure}`)
      summary.skipped.push(`${row.symbol} trail: ${err.message}`)
    }
  }

  // THE ROLL-UP GOES FIRST, because the only place this summary is printed
  // (loop.js: `mb.skipped.slice(0, 4)`) shows four entries at most — a count
  // that arrives fifth is a count nobody reads. It is unshifted only when
  // accounts were actually dropped, so a clean pass keeps its log line
  // unchanged. Nothing else in the summary is reordered or redefined.
  // PR-P: the entry brake's own roll-up, for the same reason the count below
  // has one — loop.js prints `mb.skipped.slice(0, 4)`, and with seven armed
  // accounts the per-account lines alone can fill that window and still not
  // say how many accounts are affected. Unshifted only when something was
  // braked, so a clean pass keeps its log line unchanged. It goes in BEFORE
  // the considered roll-up so that one stays at [0].
  if (summary.entriesBraked) {
    // The denominator is the accounts the pass actually RAN on (checker
    // MINOR 2): `considered` counts accounts handed in, including ones
    // dropped before the brake was ever consulted, which makes the ratio
    // read better than it is. The blind count rides along because it is the
    // half an operator has to act on, and with seven accounts the per-account
    // lines below can fall outside the four the loop prints.
    const blind = summary.entriesBrakedBlind ? `, ${summary.entriesBrakedBlind} because the book cannot be priced` : ''
    summary.skipped.unshift(`entry brake: ${summary.entriesBraked} of ${summary.accounts} account(s) taking no new book entries${blind} — see the per-account lines`)
  }
  if (summary.accounts < summary.considered) {
    const why = []
    if (summary.notArmed) why.push(`${summary.notArmed} not armed for ${TSMOM_STRATEGY}`)
    if (summary.armCheckFailed) why.push(`${summary.armCheckFailed} arm check failed`)
    summary.skipped.unshift(`considered ${summary.considered} account(s), ran on ${summary.accounts}${why.length ? ` — ${why.join(', ')}` : ''}`)
  }
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: maxId, lastRunMs: now, reconciledAt: state.reconciledAt || {}, rankExitAt: state.rankExitAt || {}, pendingFlips: state.pendingFlips || {}, marks: nextMarks, markFail }))
  writeMomentumBookPass(db, summary, now)
  return summary
}

/**
 * The loop's hold line (S-2 small round, item 3, 26-09-2026): "momentum book:
 * N exit(s) held for a closed market (exit_pending); entries held — why".
 * It printed on every cycle while entries were held, so all weekend with no
 * crypto to scan. Now it prints only when an exit was held for a closed
 * market THIS pass, or when the entries-held reason differs from the one last
 * printed (a reason appearing, changing, or clearing). A pass that did not
 * run (book off) prints nothing and keeps the last reason. Returns
 * `{ line, reason }`: `line` is null when there is nothing to print; the
 * caller keeps `reason` for the next pass.
 */
export function bookHoldLogLine(summary, lastReason = null) {
  const last = lastReason ?? null
  if (!summary?.ran) return { line: null, reason: last }
  const reason = summary.entriesHeld ? String(summary.entriesHeld) : null
  const deferred = Number(summary.deferredClosed) || 0
  if (!(deferred > 0 || reason !== last)) return { line: null, reason }
  const tail = reason ? `; entries held — ${reason}` : last ? '; entries no longer held' : ''
  return { line: `momentum book: ${deferred} exit(s) held for a closed market (exit_pending)${tail}`, reason }
}

// F6 (absorbed by S-2, Wave 2 row 2.1): the `momentum_book` heartbeat's
// record — the pass's own counts, dated, written on EVERY pass that ran
// (nothing to do included) so "never ran" and "ran, nothing to do" differ.
// A disabled book writes nothing and the controller reads dormant.
export const MOMENTUM_BOOK_PASS_KEY = 'momentum_book_pass_json'
export function writeMomentumBookPass(db, summary, now = Date.now()) {
  try {
    setState(db, MOMENTUM_BOOK_PASS_KEY, JSON.stringify({
      at: new Date(now).toISOString(),
      accounts: summary.accounts, considered: summary.considered ?? null,
      entries: summary.entries, exits: summary.exits, trailed: summary.trailed,
      deferredClosed: summary.deferredClosed || 0, rankExitsDeferred: summary.rankExitsDeferred || 0,
      entriesHeld: summary.entriesHeld || null,
      skipped: (summary.skipped || []).slice(0, 8),
    }))
  } catch { /* the record is observation; the pass has already run */ }
}

/** The read: config, the open book, and what has closed. */
export function momentumBookReport(db) {
  const cfg = loadMomentumBook(db)
  const state = loadBookState(db)
  let open = [], closed = []
  try {
    open = db.prepare(`SELECT * FROM momentum_book WHERE status IN ('open', 'exit_sent') ORDER BY entered_at`).all()
    closed = db.prepare(`SELECT b.*, t.net_pnl FROM momentum_book b LEFT JOIN trades t ON t.id = b.trade_id WHERE b.status = 'closed' ORDER BY b.exited_at DESC LIMIT 200`).all()
  } catch { /* zeros stand */ }
  const pnl = closed.map(c => Number(c.net_pnl)).filter(Number.isFinite)
  const wins = pnl.filter(x => x > 0)
  const gl = Math.abs(pnl.filter(x => x < 0).reduce((a, b) => a + b, 0))
  return {
    reportOnly: true,
    config: cfg,
    lastRunAt: state.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
    lastShadowRowId: state.lastShadowRowId,
    // PR-K: when each account last ran its rank-exit pass, so "why is this
    // still open?" has an answer that is read, not inferred.
    rankExit: {
      cadence: cfg.bookExitCadence,
      minHoldHours: cfg.bookMinHoldHours,
      minHoldAppliesTo: 'both paths (the momentum-account daily pass and the row-cursor path)',
      cadenceAppliesTo: 'the row-cursor path only — the momentum-account daily pass is daily by construction',
      // EMPTY IS THE NORMAL READING while momentum-account.json says "_all":
      // every enabled account goes through the daily pass, so the row-cursor
      // cursor below is never stamped. It is not "the daily pass never ran".
      rowCursorLastPassAt: Object.fromEntries(Object.entries(state.rankExitAt || {}).map(([id, ms]) => [`…${String(id).slice(-4)}`, Number(ms) ? new Date(Number(ms)).toISOString() : null])),
      pendingFlips: Object.keys(state.pendingFlips || {}).length,
    },
    // PR-P: the entry brake AS READ RIGHT NOW, per account that holds open
    // rows — not "is it configured on". A guard is worth reading only if the
    // number it measures is visible next to the number it is compared with,
    // so `drawdownPct` and `limitPct` sit side by side, and the rows it could
    // NOT measure are counted rather than folded into a healthy-looking
    // average (failure mode #3: the panel that reports healthy because the
    // input never reached it).
    entryBrake: (() => {
      // `open` here is already the carried set ('open' + 'exit_sent'), which
      // is the same set the brake measures (checker MAJOR 1).
      const ids = [...new Set(open.map(o => String(o.account_id)))]
      const out = {}
      for (const id of ids) {
        const b = bookEntryBrake(db, { accountId: id, marks: state.marks, markFail: state.markFail, bookCfg: cfg })
        out[`…${id.slice(-4)}`] = { blocking: b.block, ...b.read }
      }
      return { note: 'Open mark-to-market on this account\'s own book rows, as a percentage of the risk they put up at entry. At or above limitPct the account takes no NEW book entries. It ALSO refuses when coveragePct (rows it can price / rows open) is under minCoveragePct — a reading built on a minority of the book is not the book\'s reading — and whatever it cannot read is named in the loop log every pass, blocking or not. Exits, stops and the owed-exit retry never consult it. ageBasis says whether staleness was measured on the bar\'s own stamp or on the fetch clock.', accounts: out }
    })(),
    // PR-AV: `atr` alone could not say whether the ratchet was alive on a row.
    // `trailCheckedAt` and `trailNote` are the trail's own account of its last
    // pass — a null `atr` next to a fresh stamp reading "declined: …" is a
    // working ratchet; a null `atr` with NO stamp is one that has never run.
    open: open.map(o => ({ account: `…${String(o.account_id).slice(-4)}`, symbol: o.symbol, side: o.side, entry: o.entry_price, stop: o.stop, atr: o.atr, trailCheckedAt: o.trail_checked_at ?? null, trailNote: o.trail_note ?? null, enteredAt: o.entered_at, status: o.status })),
    closed: { n: pnl.length, wins: wins.length, winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null, profitFactor: gl > 0 ? Math.round((wins.reduce((a, b) => a + b, 0) / gl) * 100) / 100 : (pnl.length ? null : 0), net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100 },
    note: `Rank exits respect the horizon since PR-K: minimum hold ${cfg.bookMinHoldHours}h on both paths${cfg.bookExitCadence === 'every_pass' ? ' (LIFTED — bookExitCadence is "every_pass", the pre-PR-K restore)' : ', row-cursor cadence "daily"'} — the stop, a refused exit's retry and an exit owed from a previous day still run every pass. Two-sided (PR-D): longs from the top band; shorts from the bottom band only at conviction ≥ the short floor (9/10 on the defaults) and never against an up-trend reading. Entries and exits come from the momentum shadow ranking; the stop is 3×ATR and only moves in the trade's favour; the keeper is paused on these positions.`,
  }
}
