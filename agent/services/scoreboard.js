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
import { cashflowCoverage } from './account-history.js'

export const SCOREBOARD_TRADES = 20
export const SCOREBOARD_DEFAULT_DAYS = 30
export const SCOREBOARD_MAX_DAYS = 365
const DAY = 86_400_000
const SGT = 8 * 3_600_000
const REASON_CHARS = 48
/** Nightly balance rows shown per account (about a month of passes). */
export const SCOREBOARD_NIGHTS = 31

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

/**
 * Claude · № 13,024 10-Oct (owner after № 13,017: "Is there a record in the
 * storage of Bot-trade the daily balance of account recorded so that we can
 * check pattern"). The record exists: `equity_snapshots`, one row per enabled
 * account per nightly pass (equity-snapshot.js, since 18-09-2026): the
 * broker's balance, its net open P&L, equity and the open count. This turns
 * the newest rows into the night-by-night line the card shows. PURE.
 *
 * ONE UNIT. A night is shown only in the account's verified currency. Rows the
 * pass wrote before it recorded a unit (currency NULL) or in another unit are
 * counted, never drawn on the same line.
 *
 * A BALANCE CHANGE IS NOT A TRADING RESULT until the cash flows are known.
 * `flowsOf(prev, night)` answers the external flows (deposits, withdrawals)
 * inside the span from the cashflow ledger: { status: 'read', external } when
 * its windows cover the span, 'unclassified' or 'unread' otherwise, with
 * external null. A change across two broker hosts has no single unit: null.
 *
 * @param {object[]} rows equity_snapshots rows, any order
 * @param {{currency?: string|null, flowsOf?: Function, limit?: number}} opts
 */
export function nightlyRecord(rows, { currency = null, flowsOf = () => null, limit = SCOREBOARD_NIGHTS } = {}) {
  const all = [...(rows || [])].filter(r => Number.isFinite(Date.parse(r?.at ?? '')))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const ccy = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null
  const unitUnrecorded = all.filter(r => r.currency == null).length
  const otherUnit = ccy ? all.filter(r => r.currency != null && r.currency !== ccy).length : 0
  const own = ccy ? all.filter(r => r.currency === ccy) : []
  const kept = own.slice(-limit)
  let prev = own.length > kept.length ? own[own.length - kept.length - 1] : null
  const nights = []
  for (const r of kept) {
    const balance = finiteNumber(r.balance_usd)
    const prevBalance = prev ? finiteNumber(prev.balance_usd) : null
    const sameHost = prev != null && prev.broker_host === r.broker_host
    const change = balance != null && prevBalance != null && sameHost ? round(balance - prevBalance, 2) : null
    let flows = null
    if (change != null) {
      try { flows = flowsOf(prev, r) ?? null } catch { flows = null }
    }
    nights.push({
      at: new Date(Date.parse(r.at)).toISOString(),
      balance, openPnl: finiteNumber(r.open_pnl_usd), equity: finiteNumber(r.equity_usd),
      openPositions: Number.isInteger(r.open_positions) ? r.open_positions : null,
      error: r.error ? String(r.error).slice(0, 120) : null,
      balanceChange: change,
      flows: flows ? { status: flows.status, external: flows.status === 'read' ? round(finiteNumber(flows.external) ?? 0, 2) : null } : null,
    })
    prev = r
  }
  const valued = nights.filter(n => n.balance != null)
  const steps = nights.map(n => n.balanceChange).filter(v => v != null)
  return {
    currency: ccy,
    shown: nights.length,
    unitUnrecorded,
    otherUnit,
    earlierOwn: own.length - kept.length,
    firstAt: valued[0]?.at ?? null,
    lastAt: valued.at(-1)?.at ?? null,
    change: valued.length > 1 ? round(valued.at(-1).balance - valued[0].balance, 2) : null,
    up: steps.filter(v => v > 0).length,
    down: steps.filter(v => v < 0).length,
    flat: steps.filter(v => v === 0).length,
    // Oldest first: the order a line is drawn in.
    nights,
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
  // Claude · № 12,990: "today" is the owner's calendar day, Singapore time.
  const sgtDayStart = now - ((now + SGT) % DAY)
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
      // Claude · № 12,990 10-Oct: display facts for the account line (see readScoreboard).
      isLive: typeof reg?.isLive === 'boolean' ? reg.isLive : null,
      mode: reg?.mode ?? null,
      leverage: typeof reg?.leverage === 'number' && reg.leverage > 0 ? reg.leverage : null,
      openNow: Number.isInteger(reg?.openNow) ? reg.openNow : null,
      closedToday: list.filter(r => { const t = timeOf(r); return t != null && t >= sgtDayStart && t <= now }).length,
      closedN: list.length,
      // Every included close of the account (readScoreboard counts them during its scan);
      // closedN above counts only the rows handed to this function.
      closedTotal: Number.isInteger(reg?.closedTotal) ? reg.closedTotal : list.length,
      // Claude · № 13,024: the stored nightly balance line (nightlyRecord), when the reader had it.
      nightly: reg?.nightly && Array.isArray(reg.nightly.nights) ? reg.nightly : null,
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
    nightlyRule: 'nightly = equity_snapshots rows (one broker read per enabled account per nightly pass) in the account\'s verified currency; a balance change counts deposits and withdrawals unless flows.status is read',
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
  const totals = new Map() // account → every included close (the account line's all-time count)
  const trim = list => { list.sort(newestFirst); list.length = Math.min(list.length, SCOREBOARD_TRADES) }
  for (const r of db.prepare(sql).iterate(...(only ? [only] : []))) {
    const why = exclusionOf(r)
    if (why === 'not_closed') continue
    if (why) { excluded[why]++; continue }
    const id = accountOf(r)
    totals.set(id, (totals.get(id) ?? 0) + 1) // Claude · № 12,990: every included close, not only the buffered ones
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
  // Claude · № 12,990 10-Oct (owner: "where are the account details like Live ·
  // 1251247 · 42993489 · SGD and the leverage and how many trade"): the
  // registry's display facts, the stored leverage and the ledger's open count.
  // Display only — nothing here gates anything (owner principle 1).
  let openCounts = new Map()
  try {
    openCounts = new Map(db.prepare(`SELECT account_id, COUNT(*) AS n FROM trades WHERE status = 'open' AND account_id IS NOT NULL GROUP BY account_id`)
      .all().map(r => [String(r.account_id), r.n]))
  } catch { openCounts = new Map() }
  // A plain SELECT, not db.js getState: that helper also prepares an UPSERT,
  // and this reader runs on the report worker's read-only connection.
  let leverageOf = () => null
  try {
    const q = db.prepare('SELECT value FROM agent_state WHERE key = ?')
    leverageOf = id => { const v = Number(q.get(`acct:${id}:account_leverage`)?.value); return Number.isFinite(v) && v > 0 ? v : null }
  } catch { leverageOf = () => null }
  // Claude · № 13,024 10-Oct: the nightly balance record (nightlyRecord). The
  // newest rows by the (account_id, at) index; the cash-flow coverage of each
  // span from the same ledger account-history.js reads. Read only.
  let nightlyRows = () => []
  try {
    const q = db.prepare(`SELECT at, balance_usd, open_pnl_usd, equity_usd, open_positions, error, currency, broker_host
      FROM equity_snapshots WHERE account_id = ? ORDER BY at DESC LIMIT ?`)
    nightlyRows = id => q.all(id, SCOREBOARD_NIGHTS + 1)
  } catch { nightlyRows = () => [] }
  const accounts = ids.map(id => {
    const reg = registered.get(id) || null
    let currency = null
    try { currency = balanceUnit(db, id).currency } catch { currency = null }
    let leverage = null
    try { leverage = leverageOf(id) } catch { leverage = null }
    let nightly = null
    try {
      nightly = nightlyRecord(nightlyRows(id), { currency, flowsOf: (prev, night) => {
        const c = cashflowCoverage(db, { accountId: id, host: night.broker_host, currency,
          from: Date.parse(prev.at), to: Date.parse(night.at) })
        return c.complete ? { status: 'read', external: c.externalNet }
          : { status: c.reason === 'cashflow_classification_unknown' ? 'unclassified' : 'unread', external: null }
      } })
    } catch { nightly = null }
    return {
      accountId: id, currency, registered: !!reg, enabled: reg ? reg.enabled === 1 : null, login: reg?.trader_login ?? null,
      isLive: reg ? reg.is_live === 1 : null, mode: reg?.mode ?? null, leverage, openNow: openCounts.get(id) ?? 0,
      closedTotal: totals.get(id) ?? 0, nightly,
    }
  })
  return buildScoreboard(rows, { now, days, account: only ?? 'all', accounts, excluded })
}
