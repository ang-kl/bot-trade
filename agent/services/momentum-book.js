// ---------------------------------------------------------------------------
// agent/services/momentum-book.js — the long-only time-series momentum BOOK
// (owner order 03-09-2026: "build it, switch 15m off, long-only momentum on
// demo & live").
//
// WHAT IT IS. The cross-sectional shadow (momentum-shadow.js) ranks the scan
// universe by trailing return every hour and logs would-be entries and exits
// with hysteresis. This book turns the shadow's LONG decisions into real
// positions on every account where `tsmom_long` is trade-armed, and manages
// them the way a trend follower does: no target, a volatility-scaled stop
// that only ever ratchets up, and an exit when the name leaves the top band.
// Shorts are never taken (the side rule's evidence is not there yet).
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
import { loadShadowState } from './momentum-shadow.js'

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

/** The trailing stop for a long: never lower than before, stopAtr ATRs under the close. Pure. */
export function trailStop({ prevStop, close, atr, stopAtr }) {
  const c = Number(close), a = Number(atr), k = Number(stopAtr)
  if (!(c > 0) || !(a > 0) || !(k > 0)) return Number.isFinite(Number(prevStop)) ? Number(prevStop) : null
  const candidate = c - k * a
  const prev = Number(prevStop)
  return Number.isFinite(prev) ? Math.max(prev, candidate) : candidate
}

/**
 * The synth autoTrade() dispatches: a long at the live price with a
 * volatility stop and NO target — the book's exit is the ranking or the
 * stop. `marketOnly` keeps it off the high-timeframe limit path (the entry
 * is the live quote, not a bar close), `auto_trade` is what the dispatch
 * gate requires. Pure.
 */
export function buildEntrySynth({ symbol, price, atr, cfg, conviction = null, rankPct = null }) {
  const p = Number(price), a = Number(atr)
  if (!(p > 0) || !(a > 0)) return null
  const sl = p - cfg.stopAtr * a
  if (!(sl > 0) || !(sl < p)) return null
  return {
    consensus_bias: 'long',
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
    synthesis: `TS momentum long — ${symbol} ranked ${rankPct != null ? Math.round(Number(rankPct) * 100) + 'th pct' : 'top band'} by trailing return; stop ${cfg.stopAtr}×ATR(${cfg.atrPeriod}) = ${sl.toFixed(5)}, trailing, no target. Exit when the name leaves the top band or the stop is hit.`,
    invalidation_trigger: 'rank leaves the top 40% of the universe, or the trailing stop',
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
  // Every shadow row since the cursor advances it (shorts and refusals
  // included, so nothing is re-read); only LONG entries and exits act.
  const all = db.prepare(`SELECT * FROM momentum_shadow WHERE id > ? ORDER BY id ASC`).all(state.lastShadowRowId)
  const maxId = all.length ? all[all.length - 1].id : state.lastShadowRowId
  const rows = all.filter(r => r.side === 'long' && (r.action === 'enter' || r.action === 'exit'))
  const enters = new Map(), exits = new Map()
  for (const r of rows) {
    // the latest decision per symbol in this batch wins
    if (r.action === 'enter') { exits.delete(r.symbol); enters.set(r.symbol, r) }
    else { enters.delete(r.symbol); exits.set(r.symbol, r) }
  }
  const openRow = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ? AND symbol = ?`)
  const openCount = db.prepare(`SELECT COUNT(*) AS n FROM momentum_book WHERE status = 'open' AND account_id = ?`)
  const insBook = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                              VALUES (?, ?, ?, ?, 'long', ?, ?, ?, ?, ?, 'open', ?)`)
  const tradeRowFor = db.prepare(`SELECT id, ctrader_position_id, entry_price, sl_price FROM trades WHERE symbol = ? AND account_id = ? AND label_strategy = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
  const openTsmomTrades = db.prepare(`SELECT id, symbol, ctrader_position_id, entry_price, sl_price FROM trades WHERE account_id = ? AND label_strategy = ? AND status = 'open' AND id NOT IN (SELECT trade_id FROM momentum_book WHERE trade_id IS NOT NULL) ORDER BY id ASC`)
  // A resting tsmom limit on this account for the symbol: the reconcile
  // pass must not stack a second order on top of one still waiting to fill.
  const workingLimit = db.prepare(`SELECT id FROM pending_orders WHERE account_id = ? AND symbol = ? AND status = 'working' AND strategy = ? LIMIT 1`)
  const workingLimitFor = { get: (accountId, symbol) => { try { return workingLimit.get(accountId, symbol, TSMOM_STRATEGY) } catch { return null } } }
  summary.adopted = 0
  summary.reconciled = 0

  for (const acct of accounts) {
    const accountId = String(acct.accountId)
    let armed = false
    try { armed = armedTradeKeys(db, getState, accountId).has(TSMOM_STRATEGY) } catch { armed = false }
    if (!armed) continue
    if (deps.phasesOn && !deps.phasesOn(accountId)) { summary.skipped.push(`${accountId}: autotrade off`); continue }
    const creds = credsFor(acct)
    if (!creds) { summary.skipped.push(`${accountId}: no credentials`); continue }
    summary.accounts++

    // EXITS first: the ranking says the name left the band.
    for (const [symbol] of exits) {
      const row = openRow.get(accountId, symbol)
      if (!row) continue
      try {
        if (row.position_id && deps.close) await deps.close(creds, { positionId: row.position_id })
        db.prepare(`UPDATE momentum_book SET status = 'exit_sent', exited_at = ?, note = 'rank exit' WHERE id = ?`).run(new Date(now).toISOString(), row.id)
        summary.exits++
        log(`momentum book: rank exit ${symbol} on …${accountId.slice(-4)}`)
      } catch (err) { summary.skipped.push(`${accountId} ${symbol}: close failed — ${err.message}`) }
    }

    // ADOPT FILLS the book did not see land: a closed-market limit placed
    // through autoTrade returns nothing at dispatch and fills hours later as
    // an ordinary tsmom_long trade — which the keeper would then manage with
    // its partial-at-1R and bank-at-4R. Measured 03-09 07:24 SGT: the first
    // pass placed 14 resting limits and the book held 0 rows. Every open
    // tsmom_long trade on this account without a book row is adopted here,
    // the keeper paused, the ATR filled in by the trail pass below.
    for (const t of openTsmomTrades.all(accountId, TSMOM_STRATEGY)) {
      if (openRow.get(accountId, t.symbol)) continue
      insBook.run(t.id, accountId, t.symbol, t.ctrader_position_id != null ? String(t.ctrader_position_id) : null,
        t.entry_price, t.sl_price, null, null, new Date(now).toISOString(), `adopted filled order (trade ${t.id})`)
      db.prepare(`UPDATE monitored_positions SET paused = 1 WHERE trade_id = ?`).run(t.id)
      summary.adopted++
      log(`momentum book: adopted ${t.symbol} on …${accountId.slice(-4)} (trade ${t.id}, stop ${t.sl_price})`)
    }

    // ONE ENTRY ATTEMPT, shared by the shadow's fresh `enter` rows and the
    // reconcile pass below. Returns 'entered' | 'skipped' | 'capped'.
    const tryEnter = async (symbol, { conviction = null, rankPct = null, note }) => {
      if (openRow.get(accountId, symbol)) return 'skipped'
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
        const price = Number(q?.ask) > 0 ? Number(q.ask) : Number(bars[bars.length - 1]?.c)
        const synth = buildEntrySynth({ symbol, price, atr, cfg, conviction, rankPct })
        if (!synth) { summary.skipped.push(`${symbol}: no usable price/ATR`); return 'skipped' }
        const result = await deps.autoTrade(db, symbol, synth, may.item || null, { accountId, isLive: !!acct.isLive })
        if (!result) { summary.skipped.push(`${accountId} ${symbol}: not filled (gate or broker)`); return 'skipped' }
        const t = tradeRowFor.get(symbol, accountId, TSMOM_STRATEGY)
        insBook.run(t?.id ?? null, accountId, symbol, t?.ctrader_position_id != null ? String(t.ctrader_position_id) : null,
          t?.entry_price ?? synth.entry, t?.sl_price ?? synth.sl, atr, rankPct, new Date(now).toISOString(), note)
        if (t?.id != null) db.prepare(`UPDATE monitored_positions SET paused = 1 WHERE trade_id = ?`).run(t.id)
        summary.entries++
        log(`momentum book: long ${symbol} on …${accountId.slice(-4)} @ ${synth.entry} stop ${synth.sl.toFixed(5)} (${note})`)
        return 'entered'
      } catch (err) { summary.skipped.push(`${accountId} ${symbol}: ${err.message}`); return 'skipped' }
    }

    // ENTRIES: one per symbol per account, capped, sized by the gate.
    let capped = false
    for (const [symbol, r] of enters) {
      const out = await tryEnter(symbol, { conviction: r.conviction, rankPct: r.rank_pct, note: `entered on shadow row ${r.id}` })
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
        if (h?.side !== 'long' || enters.has(symbol)) continue
        if (openRow.get(accountId, symbol)) continue
        if (workingLimitFor.get(accountId, symbol)) continue
        const key = `${accountId}|${symbol}`
        const last = Number(state.reconciledAt?.[key]) || 0
        if (now - last < RECONCILE_EVERY_MS) continue
        state.reconciledAt = { ...(state.reconciledAt || {}), [key]: now }
        summary.reconciled++
        const out = await tryEnter(symbol, { conviction: h.entryConviction ?? null, rankPct: h.entryRank ?? null, note: `reconciled: shadow still holds ${symbol} long` })
        if (out === 'capped') break
      }
    }
  }

  // TRAIL: every open book position, every pass — the stop only rises.
  for (const row of db.prepare(`SELECT * FROM momentum_book WHERE status = 'open'`).all()) {
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
      const next = trailStop({ prevStop: row.stop, close, atr, stopAtr: cfg.stopAtr })
      if (next != null && Number.isFinite(Number(row.stop)) && next > Number(row.stop) * (1 + 1e-6)) {
        // A stop-only amend CLEARS the take profit at the broker; the book
        // never holds one, and says so (assertAmendIntent).
        if (row.position_id && deps.amend) await deps.amend(creds, { positionId: row.position_id, stopLoss: next, takeProfit: null })
        db.prepare(`UPDATE momentum_book SET stop = ?, atr = ? WHERE id = ?`).run(next, atr, row.id)
        if (row.trade_id != null) {
          db.prepare(`UPDATE trades SET sl_price = ? WHERE id = ?`).run(next, row.trade_id)
          db.prepare(`UPDATE monitored_positions SET current_sl = ? WHERE trade_id = ?`).run(next, row.trade_id)
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
    open: open.map(o => ({ account: `…${String(o.account_id).slice(-4)}`, symbol: o.symbol, entry: o.entry_price, stop: o.stop, atr: o.atr, enteredAt: o.entered_at, status: o.status })),
    closed: { n: pnl.length, wins: wins.length, winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null, profitFactor: gl > 0 ? Math.round((wins.reduce((a, b) => a + b, 0) / gl) * 100) / 100 : (pnl.length ? null : 0), net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100 },
    note: 'Long only. Entries and exits come from the momentum shadow ranking; the stop is 3×ATR and only rises; the keeper is paused on these positions.',
  }
}
