// ---------------------------------------------------------------------------
// agent/services/scoreboard.js — the phone scoreboard: the last 20 closed
// trades and the last N days, per account, at a glance.
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// WHY. The owner trades from a small phone and could not see the last 20
// trades, their profit factor or their win rate at a glance. The forward
// tracker's latest-20 block (performance-targets.js metrics()) withholds
// every figure while any one of the 20 lacks broker lifecycle proof, so each
// account read "not assessed" with no numbers at all. This reader shows what
// the LEDGER recorded, says so, and leaves that verdict untouched.
//
// REPORTING ONLY. No gate, risk limit, verdict or write path reads this, and
// it writes nothing.
//
// THE POPULATION. A `trades` row with status 'closed', a finite numeric
// net_pnl and a non-empty account_id — unstamped legacy rows belong to no
// account and are counted, not credited (the goal cards' unstamped:'exclude'
// rule, goal-tracker.js). A row whose close_reason names `superseded` is the
// duplicate reconcile adoption (cross-account-duplicates.js voids the twin
// with "duplicate_adoption: superseded by trade …"); it is the same position
// counted twice, so it is excluded. Newest first by closed_at_ms, falling back
// to closed_at (shared/formulas.js closedAtMs); id breaks ties.
//
// BOT VERSUS EXTERNAL. `source` is this codebase's ownership field: the
// reconciler stamps an intent-owned adoption 'autopilot' precisely so it reads
// as the bot's own to every source whitelist (reconciler.js, the
// "indistinguishable from a bar entry to all six source whitelists" note), and
// stamps a position with no owner evidence 'external'; a human-opened one is
// 'manual'. The set {'external', 'manual'} is the rule the guards already use
// for "a position this bot did not open": naked-position-guard.js HUMAN_SOURCES,
// loss-guardian.js scope 'external' (`source === 'external' || source ===
// 'manual'`) and profit-keeper.js (`mp.source IN ('external', 'manual')`).
//
// MONEY STAYS IN ITS ACCOUNT. Every money figure is one account's, in that
// account's deposit currency, read from the SAME source as the goal tracker's
// `balanceCurrency` (balance-unit.js balanceUnit → account-money.js). Money is
// never added across accounts. R is unit-free, so the pooled line carries R
// and counts only.
//
// R. `realised_rr` counts only when it is finite and the exit price is not
// flagged suspect (`exit_price_suspect = 1`, db.js: the magnitude half of the
// exit-price check). A suspect row keeps its money figure and drops its R.
// ---------------------------------------------------------------------------
import { closedAtMs } from '../shared/formulas.js'
import { balanceUnit } from './balance-unit.js'
import { listAccounts } from './account-registry.js'

export const SCOREBOARD_TRADES = 20
export const SCOREBOARD_DEFAULT_DAYS = 30
export const SCOREBOARD_MAX_DAYS = 365
const DAY = 86_400_000
const REASON_CHARS = 48

/** Not this system's decision (see the header for where the rule comes from). */
export const EXTERNAL_SOURCES = Object.freeze(['external', 'manual'])

const finiteNumber = v => {
  if (v == null || typeof v === 'boolean') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const accountOf = r => {
  if (r?.account_id == null) return null
  const s = String(r.account_id).trim()
  return s || null
}
const round = (v, digits) => {
  if (v == null || !Number.isFinite(v)) return null
  const f = 10 ** digits
  return Math.round(v * f) / f
}
const timeOf = r => {
  const t = closedAtMs(r)
  return t != null && Number.isFinite(t) && t > 0 ? t : null
}
/** Newest first; an unknown close time sorts last; id breaks ties (newest id first). */
const newestFirst = (a, b) => (timeOf(b) ?? -Infinity) - (timeOf(a) ?? -Infinity) || Number(b.id ?? 0) - Number(a.id ?? 0)

export const isSuperseded = r => /superseded/i.test(String(r?.close_reason ?? ''))
export const isExternal = r => EXTERNAL_SOURCES.includes(String(r?.source ?? '').trim().toLowerCase())
/** The R a row contributes, or null (absent, non-finite, or a suspect exit price). */
export const scoredR = r => (Number(r?.exit_price_suspect) === 1 ? null : finiteNumber(r?.realised_rr))

/**
 * Why a row is outside the population, or null when it is in.
 * @returns {null|'not_closed'|'unpriced'|'unstamped'|'superseded'}
 */
export function exclusionOf(r) {
  if (r?.status !== 'closed') return 'not_closed'
  if (finiteNumber(r.net_pnl) == null) return 'unpriced'
  if (accountOf(r) == null) return 'unstamped'
  if (isSuperseded(r)) return 'superseded'
  return null
}

/**
 * The figures over one set of rows. Losses and their averages are MAGNITUDES
 * (≥ 0), as in account-analytics.js. A scratch (net exactly 0) is a zero, not
 * a win: it sits in the win-rate denominator and in neither average.
 */
export function scoreMetrics(rows) {
  let wins = 0, losses = 0, zeros = 0, grossWin = 0, grossLoss = 0, net = 0
  let rScored = 0, rSum = 0, rPos = 0, rNeg = 0
  for (const r of rows) {
    const v = finiteNumber(r.net_pnl)
    net += v
    if (v > 0) { wins++; grossWin += v } else if (v < 0) { losses++; grossLoss -= v } else zeros++
    const x = scoredR(r)
    if (x != null) {
      rScored++; rSum += x
      if (x > 0) rPos += x; else if (x < 0) rNeg -= x
    }
  }
  const n = rows.length
  const avgWin = wins ? grossWin / wins : null
  const avgLoss = losses ? grossLoss / losses : null
  return {
    n, wins, losses, zeros,
    winRatePct: n ? round(wins / n * 100, 2) : null,
    grossWin: round(grossWin, 2),
    grossLoss: round(grossLoss, 2),
    // null with no losing trade: the UI says "no losses", never a number.
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    payoff: avgWin != null && avgLoss ? round(avgWin / avgLoss, 2) : null,
    net: n ? round(net, 2) : null,
    expectancy: n ? round(net / n, 2) : null,
    rScored,
    expectancyR: rScored ? round(rSum / rScored, 3) : null,
    profitFactorR: rNeg > 0 ? round(rPos / rNeg, 2) : null,
  }
}

/** Only the fields the phone list shows. R is withheld on a suspect exit. */
function listRow(r) {
  const t = timeOf(r)
  const reason = r.close_reason == null ? null : String(r.close_reason)
  return {
    id: r.id ?? null,
    symbol: r.symbol ?? null,
    side: r.side ?? null,
    strategy: r.label_strategy || r.strategy || null,
    close_reason: reason == null ? null : reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason,
    net_pnl: round(finiteNumber(r.net_pnl), 2),
    realised_rr: round(scoredR(r), 3),
    closed_at: t == null ? null : new Date(t).toISOString(),
    source: r.source ?? null,
  }
}

const shortLabel = id => `…${String(id).slice(-4)}`
/** Pooled figures carry no money: R and counts only. */
const unitFree = m => ({ n: m.n, wins: m.wins, losses: m.losses, zeros: m.zeros, winRatePct: m.winRatePct,
  rScored: m.rScored, expectancyR: m.expectancyR, profitFactorR: m.profitFactorR })

/**
 * PURE. No database access.
 *
 * @param {object[]} rows trades rows (id, status, account_id, symbol, side,
 *   strategy, label_strategy, close_reason, net_pnl, realised_rr,
 *   exit_price_suspect, closed_at, closed_at_ms, source)
 * @param {{now?: number, days?: number, account?: string,
 *   accounts?: Array<{accountId: string, currency?: string|null, registered?: boolean, enabled?: boolean|null, login?: string|null}>,
 *   excluded?: Record<string, number>}} opts
 *   account: 'all' (default) or one account id. accounts: the roster to show
 *   (an account with no closes still gets its card); an account found only in
 *   the rows is added as unregistered. excluded: counts the caller already
 *   dropped before handing the rows over, added to this function's own.
 */
export function buildScoreboard(rows, { now = Date.now(), days = SCOREBOARD_DEFAULT_DAYS, account = 'all', accounts = [], excluded = {} } = {}) {
  const only = account == null || account === 'all' ? null : String(account)
  const from = now - days * DAY
  const dropped = { unpriced: 0, unstamped: 0, superseded: 0, ...excluded }
  const byAccount = new Map()
  const roster = new Map()
  for (const a of accounts) {
    const id = a?.accountId == null ? null : String(a.accountId)
    if (!id || (only && id !== only)) continue
    roster.set(id, a)
    byAccount.set(id, [])
  }
  const seen = new Set()
  for (const r of rows || []) {
    const why = exclusionOf(r)
    if (why === 'not_closed') continue
    if (why) { dropped[why] = (dropped[why] || 0) + 1; continue }
    const id = accountOf(r)
    if (only && id !== only) continue
    // A row handed over twice (the reader's top-N and window buffers can
    // both hold it) counts once.
    const key = r.id == null ? null : `${id}:${r.id}`
    if (key != null) { if (seen.has(key)) continue; seen.add(key) }
    if (!byAccount.has(id)) byAccount.set(id, [])
    byAccount.get(id).push(r)
  }
  const pooledWindow = []
  const out = [...byAccount].map(([id, list]) => {
    list.sort(newestFirst)
    const reg = roster.get(id) || null
    const bot = list.filter(r => !isExternal(r))
    const last = list.slice(0, SCOREBOARD_TRADES)
    const window = list.filter(r => { const t = timeOf(r); return t != null && t >= from && t <= now })
    pooledWindow.push(...window)
    const currency = typeof reg?.currency === 'string' && /^[A-Z]{3}$/.test(reg.currency) ? reg.currency : null
    return {
      accountId: id,
      label: shortLabel(id),
      login: reg?.login ?? null,
      currency,
      registered: reg ? reg.registered !== false : false,
      enabled: reg?.enabled ?? null,
      closedN: list.length,
      lastCloseAt: list.length && timeOf(list[0]) != null ? new Date(timeOf(list[0])).toISOString() : null,
      last20: {
        ...scoreMetrics(last),
        externalN: last.filter(isExternal).length,
        newestAt: last.length && timeOf(last[0]) != null ? new Date(timeOf(last[0])).toISOString() : null,
        oldestAt: last.length && timeOf(last.at(-1)) != null ? new Date(timeOf(last.at(-1))).toISOString() : null,
        rows: last.map(listRow),
        // The 20 newest of the bot's own closes — its own selection, not the
        // bot rows that happen to sit among the 20 above.
        bot: scoreMetrics(bot.slice(0, SCOREBOARD_TRADES)),
      },
      days30: {
        days,
        from: new Date(from).toISOString(),
        ...scoreMetrics(window),
        externalN: window.filter(isExternal).length,
        bot: scoreMetrics(window.filter(r => !isExternal(r))),
      },
    }
  })
  return {
    at: new Date(now).toISOString(),
    account: only ?? 'all',
    days,
    trades: SCOREBOARD_TRADES,
    accounts: out,
    pooled: {
      note: 'R and counts only: money is never added across accounts.',
      days30: unitFree(scoreMetrics(pooledWindow)),
      days30Bot: unitFree(scoreMetrics(pooledWindow.filter(r => !isExternal(r)))),
    },
    excluded: dropped,
    population: "trades with status 'closed', a finite net_pnl and an account_id; close reasons naming 'superseded' (duplicate adoptions) excluded",
    botRule: "bot = source not in ('external', 'manual')",
    rRule: 'R counts only when realised_rr is finite and exit_price_suspect is not 1',
    note: 'Recorded ledger figures per account, in that account\'s deposit currency. Not the broker-proven forward assessment; reporting only.',
  }
}

/**
 * Read the rows the scoreboard needs and build it. Run inside the report
 * worker (performance-populations.js `scoreboard`), so the scan never sits on
 * the event loop protection shares. The SQL reads only the columns used, and
 * the iteration keeps a BOUNDED buffer per account: the 20 newest closes, the
 * 20 newest bot closes, and the closes inside the window. Nothing else is
 * retained, so memory does not grow with the table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{account?: string, days?: number, now?: number}} [opts]
 */
export function readScoreboard(db, { account = 'all', days = SCOREBOARD_DEFAULT_DAYS, now = Date.now() } = {}) {
  const only = account == null || account === 'all' ? null : String(account)
  const from = now - days * DAY
  const sql = `SELECT id, status, account_id, symbol, side, strategy, label_strategy, close_reason, net_pnl,
      realised_rr, exit_price_suspect, closed_at, closed_at_ms, source
    FROM trades WHERE status = 'closed'${only ? ' AND account_id = ?' : ''}`
  const excluded = { unpriced: 0, unstamped: 0, superseded: 0 }
  const buffers = new Map() // account → { top: [], topBot: [], window: [] }
  const trim = list => { list.sort(newestFirst); list.length = Math.min(list.length, SCOREBOARD_TRADES) }
  for (const r of db.prepare(sql).iterate(...(only ? [only] : []))) {
    const why = exclusionOf(r)
    if (why === 'not_closed') continue
    if (why) { excluded[why]++; continue }
    const id = accountOf(r)
    let b = buffers.get(id)
    if (!b) { b = { top: [], topBot: [], window: [] }; buffers.set(id, b) }
    const t = timeOf(r)
    if (t != null && t >= from && t <= now) { b.window.push(r); continue }
    b.top.push(r)
    if (!isExternal(r)) b.topBot.push(r)
    if (b.top.length > 10 * SCOREBOARD_TRADES) trim(b.top)
    if (b.topBot.length > 10 * SCOREBOARD_TRADES) trim(b.topBot)
  }
  const rows = []
  for (const b of buffers.values()) {
    trim(b.top); trim(b.topBot)
    rows.push(...b.window, ...b.top, ...b.topBot)
  }
  let registry = []
  try { registry = listAccounts(db) } catch { registry = [] }
  const registered = new Map(registry.map(a => [String(a.account_id), a]))
  const ids = only ? [only]
    : [...new Set([...registry.filter(a => a.enabled === 1).map(a => String(a.account_id)), ...buffers.keys()])]
  const accounts = ids.map(id => {
    const reg = registered.get(id) || null
    let currency = null
    try { currency = balanceUnit(db, id).currency } catch { currency = null }
    return { accountId: id, currency, registered: !!reg, enabled: reg ? reg.enabled === 1 : null, login: reg?.trader_login ?? null }
  })
  return buildScoreboard(rows, { now, days, account: only ?? 'all', accounts, excluded })
}
