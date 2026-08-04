// ---------------------------------------------------------------------------
// agent/services/account-chrome.js — the one line of account truth that should
// be visible from every page without navigating to one.
//
// WHY (owner, §5502·C, 2026-08-04): show
//
//   account (Login # · ID #) · currency flag · balance · armed state ·
//   today's drawdown against the N% stop · 24h trade count, Loss / Profit
//
// THE DRAWDOWN NUMBER IS THE STOP'S OWN NUMBER. It is not recomputed here.
// `accountPnlToday` and `evaluateAccount` are imported from equity-stop.js —
// the same two functions the circuit itself calls — and the same FX-day anchor
// via fxDayStartSql. A chrome that computed its own "today's loss" would
// eventually disagree with the thing that actually disarms the account, and
// the operator would believe the number on screen. There is one number.
//
// This matters more since 2026-08-04, when equityStopPct went 0.15 -> 0.08 on
// the three trading accounts: the headroom shrank by nearly half and nothing
// on any screen said how close today was to it.
//
// UNKNOWN IS NOT ZERO, here as everywhere else. A closed trade with a NULL
// net_pnl is counted and reported separately rather than summed as zero — the
// drawdown shown is then a FLOOR, not a total, and the payload says so.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { fxDayStartSql, fxDayOpenMs, loadRiskConfig, getAccountBalance } from './risk.js'
import { accountPnlToday, evaluateAccount, alreadyTrippedToday } from './equity-stop.js'
import { accountArmed } from './account-arming.js'

/**
 * Base-currency → flag. Deliberately a small explicit map rather than a
 * codepoint trick on the first two letters: currency codes are not country
 * codes (EUR, XAU), and a clever transform produces a wrong flag confidently
 * instead of no flag honestly.
 */
const FLAG = Object.freeze({
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CHF: '🇨🇭', AUD: '🇦🇺',
  NZD: '🇳🇿', CAD: '🇨🇦', SGD: '🇸🇬', HKD: '🇭🇰', ZAR: '🇿🇦', SEK: '🇸🇪',
  NOK: '🇳🇴', DKK: '🇩🇰', PLN: '🇵🇱', CZK: '🇨🇿', HUF: '🇭🇺', MXN: '🇲🇽',
  BRL: '🇧🇷', TRY: '🇹🇷', CNH: '🇨🇳', THB: '🇹🇭', IDR: '🇮🇩', INR: '🇮🇳',
})

export function flagFor(currency) {
  return FLAG[String(currency || '').toUpperCase()] ?? null
}

/**
 * Closed trades in the last 24 HOURS — a rolling window, not the FX day.
 *
 * Two different clocks on one line is a real risk of being misread, so it is
 * stated in the payload (`window: '24h'` beside `drawdownWindow: 'fx_day'`)
 * and the UI labels it. They are different on purpose: the drawdown must match
 * the stop's anchor, while "how much did it trade" is a question about the
 * last day of wall-clock time.
 */
export function tradeCount24h(db, accountId, nowMs = Date.now()) {
  const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const r = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)  AS wins,
           SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END) AS losses,
           COALESCE(SUM(CASE WHEN net_pnl > 0  THEN net_pnl END), 0) AS profit,
           COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl END), 0) AS loss,
           SUM(CASE WHEN net_pnl IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM trades
     WHERE status = 'closed'
       AND account_id = ?
       AND REPLACE(closed_at, 'T', ' ') >= ?
  `).get(String(accountId), since)
  return {
    trades: Number(r?.n) || 0,
    wins: Number(r?.wins) || 0,
    losses: Number(r?.losses) || 0,
    profit: Number(r?.profit) || 0,
    // Reported POSITIVE — the UI prefixes its own minus. A signed number here
    // and a minus sign there is how a loss ends up rendered as a gain.
    loss: Math.abs(Number(r?.loss) || 0),
    unknown: Number(r?.unknown) || 0,
  }
}

/** Open positions this account holds right now — the stop only acts if > 0. */
function openPositions(db, accountId) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM monitored_positions WHERE status = 'active' AND account_id = ?`
    ).get(String(accountId))?.n || 0
  } catch { return 0 }
}

/**
 * One chrome row per account in the registry.
 *
 * @returns {Array<{
 *   accountId, login, isLive, enabled, armed, mode,
 *   currency, flag, balance,
 *   drawdown: { pnl, cap, pct, stopPct, headroom, tripped, unknownCount, trustworthy },
 *   day: { trades, wins, losses, profit, loss, unknown },
 * }>}
 */
export function accountChrome(db, { nowMs = Date.now() } = {}) {
  let rows = []
  try {
    rows = db.prepare(
      'SELECT account_id, trader_login, is_live, enabled, mode, base_currency FROM accounts ORDER BY is_live DESC, account_id'
    ).all()
  } catch { return [] }

  const dayStart = fxDayStartSql(nowMs)
  const dayOpen = fxDayOpenMs(nowMs)

  return rows.map(r => {
    const id = String(r.account_id)
    const cfg = loadRiskConfig(db, id)
    const balance = getAccountBalance(db, id)
    const { pnl, unknownCount } = accountPnlToday(db, id, dayStart)
    const open = openPositions(db, id)
    const ev = evaluateAccount({
      pnl, balance,
      stopPct: cfg.equityStopPct,
      fallbackLimit: cfg.dailyLossLimit,
      openPositions: open,
      unknownCount,
    })
    const cap = ev.cap
    // Fraction of the allowance spent. Only meaningful when a cap exists AND
    // the day is actually down — a profitable day has no drawdown to show, and
    // rendering 0% there would imply the stop is "0% of the way to firing"
    // when it is simply not in play.
    const spent = cap && cap > 0 && pnl < 0 ? Math.min(1, Math.abs(pnl) / Math.abs(cap)) : (pnl < 0 ? null : 0)

    const currency = r.base_currency || null
    return {
      accountId: id,
      login: r.trader_login != null ? String(r.trader_login) : null,
      isLive: r.is_live === 1,
      enabled: r.enabled === 1,
      mode: r.mode || null,
      // 'armed' is the ONE fact about whether this account may enter, read
      // through the same helper the gate uses (account-arming.js) rather than
      // re-derived from mode here. PR #624 collapsed six representations of
      // this into one; a seventh in the chrome would undo that.
      armed: (() => { try { return accountArmed(db, id) } catch { return false } })(),
      currency,
      flag: flagFor(currency),
      balance,
      openPositions: open,
      drawdown: {
        pnl,                       // signed; negative = down on the day
        cap,                       // dollars the stop allows, null when unknown
        stopPct: cfg.equityStopPct ?? null,
        spent,                     // 0..1, or null when unknowable
        headroom: cap != null ? Math.max(0, Math.abs(cap) - Math.max(0, -pnl)) : null,
        tripped: alreadyTrippedToday(db, id, dayOpen),
        unknownCount,
        // FALSE means the figure is a floor, not a total: some closed trade
        // today has no realised P&L yet, so the real loss is at least `pnl`.
        trustworthy: unknownCount === 0,
        window: 'fx_day',
      },
      day: { ...tradeCount24h(db, id, nowMs), window: '24h' },
    }
  })
}

/** Which account the UI should show first when nothing is selected. */
export function defaultChromeAccount(db, rows) {
  const selected = getState(db, 'ctrader_account_id')
  if (selected && rows.some(r => r.accountId === String(selected))) return String(selected)
  return rows.find(r => r.enabled && r.armed)?.accountId ?? rows[0]?.accountId ?? null
}
