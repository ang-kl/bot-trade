// ---------------------------------------------------------------------------
// agent/services/equity-snapshot.js — the nightly mark-to-market equity
// record, one row per enabled account per pass. Wave 3 of
// docs/first-principles-audit-2026-09-19.md §K (item 11); 07-09 principle 6
// ("judge at the horizon's cadence": a daily equity curve, not a per-minute
// panel, is what a weeks-horizon system is judged on).
//
// WHAT IS RECORDED. balance (the broker's trader record, moneyDigits
// honoured) and the sum of the broker's own net unrealised P&L across the
// account's open positions (ProtoOAGetPositionUnrealizedPnLReq — exact in
// the deposit currency, never a client-side price estimate). equity =
// balance + open P&L. Either read failing leaves that field null and the row
// still written with `error` set: a missing night is a visible gap in the
// curve, not an interpolated point.
//
// CADENCE. Claude · № 13,029 10-Oct (owner, 20:07 SGT: "write your day's
// balance right at the New York regular market close (4:00 PM ET)"). One
// pass a day at 16:00 America/New_York, DST from the tz database (20:00 UTC
// in summer time, 21:00 UTC in winter). It used to be one pass every rolling
// 24 h, which drifted a few minutes a day (07:20 to 08:00 Singapore in
// September and October) and so belonged to no particular market moment.
// The stamp `equity_snapshot_last_at` is persisted BEFORE the work, so a
// restart neither repeats a close nor loses it: a close missed while the
// process was down is caught up within CLOSE_CATCH_UP_MS, and after that the
// day is a visible gap, never a reading taken hours late under its name.
// Every calendar day is read, weekends too: crypto moves a balance then. The
// pass is read-only against the broker and bounded by a deadline the way the
// cross-side equity sweep is. Its own 30-second ticker (startEquityCloseTicker)
// puts the read within half a minute of the bell; the loop's call stays as a
// fallback under the same rule.
//
// ACCOUNTS. Every enabled account, each on its own host — reading what an
// account is worth is not managing it (account-equity.js). The side is read
// ONCE, for routing (owner principle 1: only routing may read it); the
// record itself carries no demo/live mark. Token-refused accounts are
// skipped and named, never asked.
// ---------------------------------------------------------------------------

import { recordAccountMoney, recordDepositCurrency, accountMoney } from './account-money.js'
import { recordAccountHistory } from './account-history.js'
import { recordCashflowWindow } from './account-cashflows.js'
import { getState, setState } from '../db.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { hostForSide } from './account-equity.js'
import { disarmReason } from '../lib/env-disarm.js'

export const EQUITY_SNAPSHOT_LAST_KEY = 'equity_snapshot_last_at'
/** The nominal spacing of two passes: one New York close to the next. */
export const EQUITY_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 4:00 PM, the New York regular-session close, in minutes past midnight. */
export const NY_CLOSE_MINUTE = 16 * 60
/** A close missed while the process was down is still read up to this long after it. */
export const CLOSE_CATCH_UP_MS = 2 * 60 * 60 * 1000
/** How often the ticker asks whether the close has passed. */
export const CLOSE_TICK_MS = 30_000

const NY = 'America/New_York'
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
/** New York's offset from UTC at instant `t`, in ms (−4 h in summer time, −5 h in winter). */
function nyOffsetMs(t) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(t)).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return asUtc - Math.floor(t / 1000) * 1000
}
/** The UTC instant of New York wall-clock y-m-d at `minute` past midnight. */
function nyInstant(y, m, d, minute) {
  const guess = Date.UTC(y, m - 1, d, 0, minute)
  // DST moves at 02:00 local, never near 16:00: one correction is exact.
  return guess - nyOffsetMs(guess - nyOffsetMs(guess))
}

/** The most recent 4:00 PM New York instant at or before `nowMs`. */
export function lastNyCloseMs(nowMs) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]))
  const today = nyInstant(+p.year, +p.month, +p.day, NY_CLOSE_MINUTE)
  if (today <= nowMs) return today
  const y = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - 86_400_000)
  return nyInstant(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), NY_CLOSE_MINUTE)
}

/**
 * Is the day's pass due? Yes once the latest New York close has passed and
 * no pass has run since it, within CLOSE_CATCH_UP_MS of that close. A stamp
 * that is missing, unparseable or in the future counts as no pass (the
 * housekeeping rule), but still only inside the window: never off the bell.
 */
export function equitySnapshotDue(db, nowMs = Date.now()) {
  const close = lastNyCloseMs(nowMs)
  if (nowMs - close > CLOSE_CATCH_UP_MS) return false
  const last = Date.parse(getState(db, EQUITY_SNAPSHOT_LAST_KEY) ?? '')
  if (!Number.isFinite(last) || last > nowMs) return true
  return last < close
}

/**
 * Read one account's balance and open P&L and write one row. Never throws.
 * deps: { ws } injectable for tests.
 */
export async function snapshotAccountEquity(db, creds, accountId, { deps = {}, now = Date.now(), isCurrent = () => true } = {}) {
  accountId = String(accountId)
  const out = { accountId, balance: null, openPnl: null, equity: null, openPositions: null, currency: null, error: null }
  const errors = [], clock = deps.clock ?? Date.now
  let balanceReceivedAt = null, pnlReceivedAt = null
  try {
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const host = creds.host
    if (!host) throw new Error('no broker host for this account')
    // Independent reads share the existing pool; a balance failure does not
    // turn the P&L into zero or prevent that independent observation.
    let trader = null
    await Promise.all([
      (async () => {
        try {
          trader = await ws.wsGetTrader(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId)
          balanceReceivedAt = clock()
          const bal = ws.traderBalance(trader)
          if (Number.isFinite(bal) && bal >= 0) out.balance = bal
          else errors.push('balance unreadable')
        } catch (err) { errors.push(`balance: ${err?.message ?? err}`) }
      })(),
      (async () => {
        try {
          const pnl = await ws.wsGetUnrealizedPnl(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId)
          pnlReceivedAt = clock()
          if (!pnl || typeof pnl !== 'object' || Array.isArray(pnl)) throw new Error('P&L response unavailable')
          const vals = Object.values(pnl)
          out.openPositions = vals.length
          if (vals.some(v => typeof v?.net !== 'number' || !Number.isFinite(v.net))) throw new Error('P&L incomplete')
          out.openPnl = Number(vals.reduce((sum, v) => sum + v.net, 0).toFixed(2))
        } catch (err) { errors.push(`open pnl: ${err?.message ?? err}`) }
      })(),
    ])
    if (!isCurrent()) return { ...out, error: 'snapshot deadline elapsed' }
    if (trader && typeof ws.wsGetAssets === 'function') {
      try {
        const assets = await ws.wsGetAssets(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, 5000)
        const asset = (assets.asset || []).find(a => String(a.assetId) === String(trader.depositAssetId))
        if (isCurrent()) recordDepositCurrency(db, { accountId, host, depositAssetId: trader.depositAssetId,
          currency: /^[A-Z]{3}$/.test(asset?.name) ? asset.name : asset?.displayName, receivedAt: clock() })
      } catch { /* no verified currency; never default to USD */ }
    }
    if (isCurrent() && trader) {
      recordAccountMoney(db, { accountId, host, trader, balance: out.balance, receivedAt: balanceReceivedAt })
      out.currency = accountMoney(db, accountId, { now: clock() }).observation?.currency ?? null
    }
    if (out.balance != null && out.openPnl != null) out.equity = Number((out.balance + out.openPnl).toFixed(2))
    if (isCurrent() && out.currency && typeof ws.wsGetCashflowHistory === 'function') {
      try {
        const to = clock(), from = Math.max(0, to - 604800_000)
        const response = await ws.wsGetCashflowHistory(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, from, to)
        if (isCurrent()) out.cashflows = recordCashflowWindow(db, { accountId, host, currency: out.currency, from, to, response, receivedAt: clock() })
      } catch (err) { out.cashflowError = err.message }
    }
  } catch (err) { errors.push(err?.message ?? String(err)) }
  if (!isCurrent()) return { ...out, error: 'snapshot deadline elapsed' }
  out.error = errors.length ? errors.join(' · ') : null
  try {
    // Historical column names are retained for migrations; currency metadata
    // declares the native units. A missing historical currency stays unknown.
    db.prepare(`INSERT INTO equity_snapshots
      (at, account_id, balance_usd, open_pnl_usd, equity_usd, open_positions, error, currency, broker_host, balance_received_at, pnl_received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(new Date(now).toISOString(), accountId, out.balance, out.openPnl, out.equity, out.openPositions, out.error,
        out.currency, creds.host, balanceReceivedAt == null ? null : new Date(balanceReceivedAt).toISOString(),
        pnlReceivedAt == null ? null : new Date(pnlReceivedAt).toISOString())
    recordAccountHistory(db, { accountId, host: creds.host, source: 'nightly_equity', receivedAt: Math.max(balanceReceivedAt || 0, pnlReceivedAt || 0) || clock(),
      balance: out.balance, equity: out.equity, openPnl: out.openPnl, currency: out.currency,
      balanceReceivedAt, pnlReceivedAt, equitySource: 'balance_plus_broker_pnl', openPositions: out.openPositions, error: out.error })
  } catch (err) { out.error = `${out.error ? out.error + ' · ' : ''}write: ${err?.message ?? err}` }
  return out
}

/**
 * The nightly pass: every enabled account, concurrent, bounded.
 * Stamps the cadence key BEFORE the work (a pass that throws must not re-run
 * every cycle). Returns counts for the log line and the heartbeat.
 */
export async function runEquitySnapshot(db, creds, { deps = {}, now = Date.now(), timeoutMs = 15_000 } = {}) {
  const out = { swept: 0, written: 0, failed: 0, timedOut: 0, skipped: [], results: [] }
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, new Date(now).toISOString())
  let rows = []
  try {
    rows = db.prepare(`SELECT account_id, is_live FROM accounts WHERE enabled = 1 ORDER BY account_id`).all()
  } catch { return out }
  const refused = deps.tokenRefused ?? tokenRefusedAccounts(db)
  const asked = rows.filter(r => !refused.has(String(r.account_id)))
  out.skipped = rows.filter(r => refused.has(String(r.account_id))).map(r => String(r.account_id))
  if (asked.length === 0) return out
  out.swept = asked.length

  let timer = null, expired = false
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { expired = true; resolve('__deadline__') }, timeoutMs) })
  try {
    const settled = await Promise.all(asked.map(async (r) => {
      const task = snapshotAccountEquity(db, { ...creds, host: hostForSide(r.is_live === 1) }, r.account_id, { deps, now, isCurrent: () => !expired })
      const won = await Promise.race([task, deadline])
      return won === '__deadline__'
        ? { accountId: String(r.account_id), equity: null, error: `no answer within ${timeoutMs}ms`, timedOut: true }
        : won
    }))
    for (const res of settled) {
      out.results.push(res)
      if (res.equity == null) { out.failed += 1; if (res.timedOut) out.timedOut += 1 } else out.written += 1
    }
    return out
  } finally { clearTimeout(timer) }
}

/**
 * Claude · № 13,029 10-Oct: the close ticker. Every CLOSE_TICK_MS it asks
 * equitySnapshotDue and, when the close has passed, runs the pass with the
 * process's own credentials. One pass at a time; the stamp is written before
 * the work, so the loop's fallback call and this one never both read a close.
 * Inert in a disarmed (staging) environment. Returns a stop function.
 * deps: { env, clock, setInterval, clearInterval, intervalMs, log, beat, run } for tests.
 */
export function startEquityCloseTicker(db, getCreds, deps = {}) {
  if (disarmReason(deps.env)) return () => {}
  const clock = deps.clock ?? Date.now, log = deps.log ?? (m => console.log(m))
  const run = deps.run ?? runEquitySnapshot
  let running = false
  const tick = async () => {
    if (running) return null
    const now = clock()
    if (!equitySnapshotDue(db, now)) return null
    const c = getCreds(db)
    if (!c?.clientId || !c?.clientSecret || !c?.accessToken) return null
    running = true
    try {
      const snap = await run(db, { clientId: c.clientId, clientSecret: c.clientSecret, accessToken: c.accessToken }, { now })
      const gaps = snap.results.filter(r => r.equity == null).map(r => `…${String(r.accountId).slice(-4)}: ${r.error ?? 'no equity'}`).join(' · ')
      log(`Equity snapshot (New York close): ${snap.written}/${snap.swept} account(s) written` + (snap.failed ? ` — ${gaps}` : '')
        + (snap.skipped?.length ? ` — skipped ${snap.skipped.length} (token refused)` : ''))
      const ok = !(snap.swept > 0 && snap.written === 0)
      try { (deps.beat ?? (await import('./heartbeat.js')).beat)(db, 'equity_snapshot', { ok, error: ok ? null : `0/${snap.swept} written` }) } catch { /* the record is the row */ }
      return snap
    } catch (err) {
      try { (deps.beat ?? (await import('./heartbeat.js')).beat)(db, 'equity_snapshot', { ok: false, error: err?.message ?? String(err) }) } catch { /* best effort */ }
      return null
    } finally { running = false }
  }
  const timer = (deps.setInterval ?? setInterval)(() => { void tick().catch(() => {}) }, deps.intervalMs ?? CLOSE_TICK_MS)
  timer?.unref?.()
  const stop = () => { (deps.clearInterval ?? clearInterval)(timer) }
  stop.tick = tick
  return stop
}

/**
 * The curve: rows per account, oldest first, over `days`. `accountId` null =
 * every account. Each point carries the balance, open P&L and equity the
 * broker reported that night, or null with the error that night.
 */
export function equityCurve(db, { accountId = null, days = 90, now = Date.now() } = {}) {
  const since = new Date(now - Math.max(1, days) * 86400_000).toISOString()
  const rows = db.prepare(
    `SELECT at, account_id, balance_usd, open_pnl_usd, equity_usd, open_positions, error, currency, broker_host, balance_received_at, pnl_received_at
       FROM equity_snapshots
      WHERE at >= ? ${accountId != null ? 'AND account_id = ?' : ''}
      ORDER BY account_id, at`,
  ).all(...(accountId != null ? [since, String(accountId)] : [since]))
  const byAccount = {}
  for (const r of rows) {
    const id = String(r.account_id)
    if (!byAccount[id]) byAccount[id] = { accountId: id, points: [] }
    byAccount[id].points.push({
      at: r.at, currency: r.currency, host: r.broker_host,
      balanceReceivedAt: r.balance_received_at, pnlReceivedAt: r.pnl_received_at,
      unitEvidence: r.currency ? 'broker_deposit_currency' : 'legacy_currency_unrecorded',
      balance: r.balance_usd,
      openPnl: r.open_pnl_usd,
      equity: r.equity_usd,
      openPositions: r.open_positions,
      error: r.error,
    })
  }
  const accounts = Object.values(byAccount).map(a => {
    const pts = a.points.filter(p => p.equity != null)
    const consistentUnits = pts.length > 0 && pts.every(p => p.currency === pts[0].currency && p.host === pts[0].host)
    const currency = consistentUnits ? pts[0].currency : null
    const first = pts[0]?.equity ?? null
    const last = pts[pts.length - 1]?.equity ?? null
    let peak = -Infinity, maxDd = 0
    for (const p of pts) { if (p.equity > peak) peak = p.equity; const dd = peak - p.equity; if (dd > maxDd) maxDd = dd }
    return {
      ...a, currency, cashflowsReconciled: false,
      nights: a.points.length,
      nightsRead: pts.length,
      first, last,
      change: currency && first != null && last != null ? Number((last - first).toFixed(2)) : null,
      recordedEquityChange: consistentUnits && first != null && last != null ? Number((last - first).toFixed(2)) : null,
      maxDrawdownUsd: currency === 'USD' && pts.length ? Number(maxDd.toFixed(2)) : null,
      maxSampledDrawdown: consistentUnits && pts.length ? Number(maxDd.toFixed(2)) : null,
      drawdownBasis: 'sampled equity, cashflows unadjusted; not exact intraminute drawdown',
    }
  })
  return {
    at: new Date(now).toISOString(),
    since,
    lastPassAt: getState(db, EQUITY_SNAPSHOT_LAST_KEY) || null,
    accounts,
    note: 'One row per enabled account per nightly pass: balance + the broker\'s net unrealised P&L = equity. A night the broker did not answer is a point with null equity and the error, never an interpolated value.',
  }
}
