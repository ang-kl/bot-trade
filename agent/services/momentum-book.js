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
import { isMomentumAccount, runMomentumAccountPass } from './momentum-account.js'
import { bookCloseVolume } from './book-close-volume.js'

export const TSMOM_STRATEGY = 'tsmom_long'
// A held name with no position is re-proposed at most this often per account.
export const RECONCILE_EVERY_MS = 60 * 60_000
export const MOMENTUM_BOOK_CONFIG_KEY = 'momentum_book_json'
export const MOMENTUM_BOOK_STATE_KEY = 'momentum_book_state_json'

export const DEFAULT_MOMENTUM_BOOK = Object.freeze({
  enabled: false,          // OFF until the owner turns it on
  timeframe: '1d',
  atrPeriod: 20,
  stopAtr: 3,              // initial and trailing stop: 3 × ATR(20) below the close
  maxPositionsPerAccount: 8,
  conviction: 8,           // the scan's autotrade threshold; the ranking's own conviction rides on the row
})

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)

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
      }
    }
  } catch { /* fall through */ }
  return { lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {} }
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
        if (ma.ran) {
          summary.entries += ma.entries; summary.exits += ma.exits
          summary.momentumAccount = { account: accountId, entries: ma.entries, exits: ma.exits, universe: ma.universe }
          for (const s of ma.skipped) summary.skipped.push(`${accountId} ${s}`)
        }
      } catch (err) { summary.skipped.push(`${accountId}: momentum account pass failed — ${err.message}`) }
      continue
    }

    // EXITS first: the ranking says the name left the band. The shadow rows
    // are read once through the cursor, so a close that FAILED (09-09-2026:
    // LLY.US, volume missing) is flagged on the row and retried every pass
    // until it goes — an exit the ranking called is not dropped on an error.
    const acctExits = new Map(exits)
    // A FLIP: this batch's `enter` on the other side of an open row exits
    // that row first (checker's counterexample, 11-09-2026).
    for (const [symbol, r] of enters) {
      const open = openRow.get(accountId, symbol)
      if (open && (open.side === 'short' ? 'short' : 'long') !== r.side) acctExits.set(symbol, { symbol, flip: true, to: r.side })
    }
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
      if (w.action === 'exit' || (w.action === 'enter' && w.side !== rowSide)) acctExits.set(r.symbol, { symbol: r.symbol, retry: true, owed: true, flip: w.action === 'enter' })
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
      if (!inScanScope(symbol)) { summary.skipped.push(`${accountId} ${symbol}: outside this account's scan universe (momentum-account name)`); continue }
      const out = await tryEnter(symbol, { side: r.side, conviction: r.conviction, rankPct: r.rank_pct, note: `entered on shadow row ${r.id}` })
      if (out === 'capped') { capped = true; break }
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

  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: maxId, lastRunMs: now, reconciledAt: state.reconciledAt || {} }))
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
    open: open.map(o => ({ account: `…${String(o.account_id).slice(-4)}`, symbol: o.symbol, side: o.side, entry: o.entry_price, stop: o.stop, atr: o.atr, enteredAt: o.entered_at, status: o.status })),
    closed: { n: pnl.length, wins: wins.length, winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null, profitFactor: gl > 0 ? Math.round((wins.reduce((a, b) => a + b, 0) / gl) * 100) / 100 : (pnl.length ? null : 0), net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100 },
    note: 'Two-sided (PR-D): longs from the top band; shorts from the bottom band only at conviction ≥ the short floor (9/10 on the defaults) and never against an up-trend reading. Entries and exits come from the momentum shadow ranking; the stop is 3×ATR and only moves in the trade\'s favour; the keeper is paused on these positions.',
  }
}
