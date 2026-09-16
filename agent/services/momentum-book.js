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
// them the way a trend follower does: no target, a volatility-scaled stop
// that only ever ratchets in the trade's favour, and an exit when the name
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
// Every broker call is injectable (deps) so the tests drive the whole cycle
// against an in-memory DB with fake fills.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { armedTradeKeys } from './stage-matrix.js'
import { loadShadowState, loadMomentumShadow } from './momentum-shadow.js'
import { directionFor, trendReadingFor } from './direction-policy.js'
import { checkRegimeGate } from './regime-gate.js'
import { recordDecision } from './decision-log.js'
import { roundToDigits } from './trade-guard.js'
import { isMomentumAccount, runMomentumAccountPass, loadMomentumAccount, dailyDue, thresholdMs } from './momentum-account.js'
import { bookCloseVolume } from './book-close-volume.js'
// PR-K: the hold-age rule lives in its own module because the momentum-account
// path enforces the SAME minimum hold and may not import this file (cycle).
import { parseStamp, heldLongEnough as heldLongEnoughFor, heldHours, minHoldMsFor } from './book-hold-age.js'
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
  }
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
 * price with a volatility stop and NO target — the book's exit is the
 * ranking or the stop. `marketOnly` keeps it off the high-timeframe limit
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
    // Stated intent, not an omission: the book trails a stop and never holds a
    // target. autoTrade turns this into allowNoTarget on the market payload.
    noTarget: true,
    time_cap_minutes: null,
    source: 'momentum_book',
    synthesis: `TS momentum ${side} — ${symbol} ranked ${rankPct != null ? Math.round(Number(rankPct) * 100) + 'th pct' : band} by trailing return; stop ${cfg.stopAtr}×ATR(${cfg.atrPeriod}) = ${sl.toFixed(5)}, trailing, no target. Exit when the name leaves the ${band} or the stop is hit.`,
    invalidation_trigger: short ? 'rank leaves the bottom 40% of the universe, or the trailing stop' : 'rank leaves the top 40% of the universe, or the trailing stop',
  }
}

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
      }
    }
  } catch { /* fall through */ }
  return { lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {} }
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
export async function runMomentumBook(db, { accounts = [], credsFor = () => null, deps = {}, now = Date.now(), log = () => {} } = {}) {
  const cfg = loadMomentumBook(db)
  if (!cfg.enabled) return { ran: false, why: 'disabled' }
  const state = loadBookState(db)
  const summary = { ran: true, entries: 0, exits: 0, trailed: 0, skipped: [], accounts: 0 }
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
  const insBook = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
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
  for (const acct of ordered) {
    const accountId = String(acct.accountId)
    let armed = false
    try { armed = armedTradeKeys(db, getState, accountId).has(TSMOM_STRATEGY) } catch { armed = false }
    if (!armed) continue
    if (deps.phasesOn && !deps.phasesOn(accountId)) { summary.skipped.push(`${accountId}: autotrade off`); continue }
    const creds = credsFor(acct)
    if (!creds) { summary.skipped.push(`${accountId}: no credentials`); continue }
    summary.accounts++
    const headroom = headroomOf(acct)
    const marginExhausted = headroom != null && headroom <= 0
    if (marginExhausted) summary.skipped.push(`${accountId}: margin exhausted (headroom $${headroom.toFixed(2)}) — no entries this pass`)

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
      if (openRow.get(accountId, t.symbol)) continue
      // The adopted row carries the trade's own side (PR-D): a SELL fill is a short row.
      insBook.run(t.id, accountId, t.symbol, t.ctrader_position_id != null ? String(t.ctrader_position_id) : null,
        String(t.side || '').toUpperCase() === 'SELL' ? 'short' : 'long',
        t.entry_price, t.sl_price, null, null, new Date(now).toISOString(), `adopted filled order (trade ${t.id})`)
      // The book holds NO target, and the record must say so. A closed-market
      // limit is placed with a 1.5R take profit, so the adopted row inherits
      // `current_tp` / `tp_price`; the book's first trail amend clears the
      // target at the broker, and the target-restore sweep (which reads
      // `monitored_positions.current_tp`) then puts it straight back.
      // Measured 04-09-2026: LLY.US on ACCT-DEMO-1 lost its target at the
      // 08:46 SGT trail and held it again by the evening — a 1.5R cap on a
      // trend position that is meant to run. Cleared here, once, at adoption.
      db.prepare(`UPDATE monitored_positions SET paused = 1, current_tp = NULL WHERE trade_id = ?`).run(t.id)
      db.prepare(`UPDATE trades SET tp_price = NULL WHERE id = ?`).run(t.id)
      summary.adopted++
      log(`momentum book: adopted ${t.symbol} on …${accountId.slice(-4)} (trade ${t.id}, stop ${t.sl_price})`)
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
        const ma = await runMomentumAccountPass(db, { acct, creds, bookCfg: cfg, buildEntrySynth, deps, now, log, marginExhausted })
        // COUNT WHAT WENT OUT, not what the pass called itself (checker,
        // 16-09-2026): the margin-exhausted branch returns `ran: false` AFTER
        // sending its exits, so real closes were reported as zero — which is
        // also what hid from this summary the fact that `accountId: "_all"`
        // routes every account through here and none through the row-cursor
        // path below.
        summary.entries += ma.entries || 0
        summary.exits += ma.exits || 0
        summary.rankExitsDeferred += ma.rankExitsDeferred || 0
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
      try {
        if (row.position_id && deps.close) {
          // The close needs a volume (09-09-2026): broker position first,
          // trade lots × lot size second; none → not sent, row stays open.
          const volume = await bookCloseVolume(db, creds, row, deps)
          if (volume == null) throw new Error('unknown volume — close not sent')
          await deps.close(creds, { positionId: row.position_id, volume })
        }
        const why = acctExits.get(symbol)?.flip ? 'rank exit (flip)' : 'rank exit'
        db.prepare(`UPDATE momentum_book SET status = 'exit_sent', exited_at = ?, note = ? WHERE id = ?`).run(new Date(now).toISOString(), why, row.id)
        summary.exits++
        log(`momentum book: ${why} ${symbol} on …${accountId.slice(-4)}`)
      } catch (err) {
        db.prepare(`UPDATE momentum_book SET note = ? WHERE id = ?`).run(`exit_pending: ${String(err.message).slice(0, 160)}`, row.id)
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
        const result = await deps.autoTrade(db, symbol, synth, may.item || null, { accountId, isLive: !!acct.isLive, producerId: 'cross_sectional_book' })
        if (!result) { summary.skipped.push(`${accountId} ${symbol}: not filled (gate or broker)`); return 'skipped' }
        const t = tradeRowFor.get(symbol, accountId, TSMOM_STRATEGY)
        insBook.run(t?.id ?? null, accountId, symbol, t?.ctrader_position_id != null ? String(t.ctrader_position_id) : null, side,
          t?.entry_price ?? synth.entry, t?.sl_price ?? synth.sl, atr, rankPct, new Date(now).toISOString(), note)
        if (t?.id != null) db.prepare(`UPDATE monitored_positions SET paused = 1 WHERE trade_id = ?`).run(t.id)
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
  for (const row of db.prepare(`SELECT * FROM momentum_book WHERE status = 'open'`).all()) {
    const rowSide = row.side === 'short' ? 'short' : 'long'
    const acct = accounts.find(a => String(a.accountId) === String(row.account_id))
    const creds = acct ? credsFor(acct) : null
    const symbolId = creds && deps.symbolIdFor
      ? await deps.symbolIdFor(creds, row.symbol)
      : deps.symbolMap?.[String(row.symbol).toUpperCase()]
    // A closed trade closes the book row; the reconciler is the authority on the close.
    const t = row.trade_id != null ? db.prepare(`SELECT status FROM trades WHERE id = ?`).get(row.trade_id) : null
    if (t && t.status === 'closed') {
      db.prepare(`UPDATE momentum_book SET status = 'closed', exited_at = COALESCE(exited_at, ?), note = COALESCE(note, '') || ' | trade closed' WHERE id = ?`).run(new Date(now).toISOString(), row.id)
      continue
    }
    if (!creds || symbolId == null || !deps.bars) continue
    try {
      const bars = await deps.bars(creds, symbolId)
      const atr = atrOf(bars, cfg.atrPeriod)
      const close = Number(bars[bars.length - 1]?.c)
      const raw = trailStop({ prevStop: row.stop, close, atr, stopAtr: cfg.stopAtr, side: rowSide })
      // Measured 04-09-2026 (Railway logs, every minute since adoption): the
      // amend sent the raw float — 1053.4199999999998 on LLY.US, 344.358 on
      // GD.US — and the broker refused each one ("more digits than symbol
      // allows"), so the book's "stop that only rises" had never risen once.
      // The entry path never hit this because it sends rounded RELATIVE
      // distances; the amend sends an absolute price and must round it to the
      // symbol's digits itself. digitsFor is the same cached symbol record the
      // limit builder reads (lot-sizing.getVolumeMeta).
      const digits = deps.digitsFor ? await deps.digitsFor(creds, symbolId) : null
      const next = raw != null && digits != null ? roundToDigits(raw, digits) : raw
      if (next != null && trailImproves({ side: rowSide, prevStop: row.stop, nextStop: next })) {
        // A stop-only amend CLEARS the take profit at the broker; the book
        // never holds one, and says so (assertAmendIntent).
        if (row.position_id && deps.amend) await deps.amend(creds, { positionId: row.position_id, stopLoss: next, takeProfit: null })
        db.prepare(`UPDATE momentum_book SET stop = ?, atr = ? WHERE id = ?`).run(next, atr, row.id)
        if (row.trade_id != null) {
          // The amend above clears the target at the broker; the record clears
          // with it, so the target-restore sweep has nothing to put back (rows
          // adopted before 04-09-2026 still carry the limit's 1.5R target).
          db.prepare(`UPDATE trades SET sl_price = ?, tp_price = NULL WHERE id = ?`).run(next, row.trade_id)
          db.prepare(`UPDATE monitored_positions SET current_sl = ?, current_tp = NULL WHERE trade_id = ?`).run(next, row.trade_id)
        }
        summary.trailed++
      }
    } catch (err) { summary.skipped.push(`${row.symbol} trail: ${err.message}`) }
  }

  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: maxId, lastRunMs: now, reconciledAt: state.reconciledAt || {}, rankExitAt: state.rankExitAt || {}, pendingFlips: state.pendingFlips || {} }))
  return summary
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
    open: open.map(o => ({ account: `…${String(o.account_id).slice(-4)}`, symbol: o.symbol, side: o.side, entry: o.entry_price, stop: o.stop, atr: o.atr, enteredAt: o.entered_at, status: o.status })),
    closed: { n: pnl.length, wins: wins.length, winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null, profitFactor: gl > 0 ? Math.round((wins.reduce((a, b) => a + b, 0) / gl) * 100) / 100 : (pnl.length ? null : 0), net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100 },
    note: `Rank exits respect the horizon since PR-K: minimum hold ${cfg.bookMinHoldHours}h on both paths${cfg.bookExitCadence === 'every_pass' ? ' (LIFTED — bookExitCadence is "every_pass", the pre-PR-K restore)' : ', row-cursor cadence "daily"'} — the stop, a refused exit's retry and an exit owed from a previous day still run every pass. Two-sided (PR-D): longs from the top band; shorts from the bottom band only at conviction ≥ the short floor (9/10 on the defaults) and never against an up-trend reading. Entries and exits come from the momentum shadow ranking; the stop is 3×ATR and only moves in the trade's favour; the keeper is paused on these positions.`,
  }
}
