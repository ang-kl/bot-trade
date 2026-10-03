// ---------------------------------------------------------------------------
// agent/services/daily-stop-reading.js — the daily stop IN FORCE on one
// account, read through the risk engine's own functions, for display.
//
// WEB-2 (8,989-A row 4, 25-09-2026). The Performance account cards printed
// "daily stop" as balance × dailyLossPct, a browser formula. The risk engine
// does not enforce that number. Read on production 25-09 13:37 UTC: the card
// figures from the roadmap row, and the engine's own `daily_cap_usd` from its
// latest verdict row per account (risk_events checks_json, dated below; the
// global config still carries floor 200 / tier 3% · 4% at 10,000 and no
// account has an overlay):
//
//   account    card (bal × 3%)   engine daily_cap_usd      what binds
//   46130058   −900              1,191.42  (17-09 21:17Z)  4% large tier
//   47790949   −1,332            1,757.65  (17-09 21:12Z)  4% large tier
//   46979908   −20.87            200       (18-09 21:24Z)  the USD 200 floor
//   43097342   −93.49 SGD        200       (17-09 14:09Z)  the USD 200 floor
//   42993489   −1.54 SGD         200       (11-09 01:30Z)  the USD 200 floor
//   43002148, 43069009: −0; no verdict row yet (balance 0 → floor 200).
//
// Nor is it GET /state/risk-full's `dailyPacing` (capUsd 150, binding 'usd'
// on six accounts): that route calls pacedDailyCap WITHOUT the floor and tier
// knobs, so it reports the flat USD 150 that the tier rule has taken out of
// force. Three numbers for one limit; only the engine's is enforced.
//
// SAME CODE PATH, NOT A THIRD FORMULA. This calls exactly what the per-account
// pre-gate (account-pregate.js accountPregateVerdict) calls, in the same
// order: loadRiskConfig(db, acct) → getAccountBalance(db, acct) →
// dailyLossVerdict(db, cfg, acct, { balance, nowMs }). evaluateTrade calls the
// same dailyLossVerdict on the same merged config and the same balance. So
// the card and the veto cannot disagree about the cap, the binding rule, the
// FX-day anchor (17:00 New York) or the realised figure (which counts NULL
// stop-outs at planned risk, as the gate does). Nothing here writes.
//
// NO LIMIT IS CHANGED. The cap is displayed in the unit the risk config states
// it in: dailyLossLimit and dailyLossFloorUsd are USD, and the % check reads
// the `acct:<id>:account_balance_usd` key. On an account whose broker currency
// is not USD the engine still compares that number with the account's own
// P&L — the open units question H-P2-4 ("native currency stored under _usd").
// This module says so (`unitsComparable: false`, `unitsNote`) and refuses to
// compute a percentage across the two units; it does not convert, relabel or
// correct the engine.
//
// LOSS-CAP USED = (realised loss today + floating loss now) ÷ cap.
//   realised loss  max(0, −engine realised P&L since the FX-day open) — the
//                  number the daily veto compares with the cap
//   floating loss  max(0, −broker open P&L), the account-overview reading;
//                  null when that reading is not complete and fresh
// A floating GAIN does not offset a realised loss: it is not money yet, and
// the veto does not count it. When either part cannot be read, or the units
// are not comparable, the percentage is null and `status` says which — never
// a realised-only figure presented as the whole.
// ---------------------------------------------------------------------------

import { loadRiskConfig, getAccountBalance, dailyLossVerdict } from './risk.js'
import { describeBinding } from './daily-loss-pacing.js'
import { sizingBalanceUsd, conversionView, FX_RATE_UNAVAILABLE } from './account-currency.js'

/** The unit the risk config states the daily cap in (risk.js DEFAULT_RISK_CONFIG). */
export const DAILY_STOP_CURRENCY = 'USD'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const round2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null)
const usd = (v) => `USD ${Number(v).toFixed(2)}`

/**
 * Why this cap, in words. `describeBinding` is the engine's own phrase for
 * 'pct', 'usd' and 'both'; it has no 'floor' branch (it would say "both caps
 * agree"), so the floor is worded here rather than misreported.
 */
function explainBinding(p, nativeCcy = null) {
  if (!p || p.capUsd == null) return 'both daily checks are off — the day is uncapped'
  if (p.binding === 'floor') {
    // The % check is a fraction of the stored balance, which is the broker's
    // NATIVE money; on a non-USD account it is in that currency, not USD (C·1).
    const pctLabel = nativeCcy && nativeCcy !== DAILY_STOP_CURRENCY ? `${nativeCcy} ${Number(p.pctCapUsd).toFixed(2)}` : (p.pctCapUsd != null ? usd(p.pctCapUsd) : null)
    const other = p.pctCapUsd != null ? `${pctLabel} from the % check`
      : p.usdInForce != null ? `the ${usd(p.usdInForce)} flat cap` : 'no other check'
    return `the ${usd(p.floorUsd)} floor binds — above ${other}`
  }
  return describeBinding(p)
}

/**
 * Loss-cap used, from measured parts only. Pure.
 *
 * @param {{capUsd:number|null, realisedTodayPnl:number|null, openPnl:number|null,
 *          unitsComparable:boolean|null, moneyCurrency:string|null}} a
 */
export function lossCapUsed({ capUsd, realisedTodayPnl, openPnl, unitsComparable, moneyCurrency }) {
  const realisedLoss = finite(realisedTodayPnl) ? round2(Math.max(0, -realisedTodayPnl)) : null
  const floatingLoss = finite(openPnl) ? round2(Math.max(0, -openPnl)) : null
  const base = { pct: null, consumed: null, realisedLoss, floatingLoss }
  if (capUsd == null) return { ...base, status: 'uncapped', reason: 'no daily stop is in force' }
  if (!(capUsd > 0)) return { ...base, status: 'not_read', reason: 'the daily stop is not a positive amount' }
  if (unitsComparable == null) {
    return { ...base, status: 'not_read', reason: "the account's broker currency is not read, so its money cannot be compared with the USD cap" }
  }
  if (unitsComparable === false) {
    return { ...base, status: 'not_comparable', reason: `the cap is configured in ${DAILY_STOP_CURRENCY}; this account's money is ${moneyCurrency} (units question H-P2-4 is open)` }
  }
  if (realisedLoss == null) return { ...base, status: 'not_read', reason: "today's realised P&L could not be read" }
  if (floatingLoss == null) return { ...base, status: 'not_read', reason: 'the floating P&L is not a complete, fresh broker reading' }
  const consumed = round2(realisedLoss + floatingLoss)
  return { ...base, status: 'measured', reason: null, consumed, pct: Math.round((consumed / capUsd) * 100) }
}

/**
 * The daily stop the risk engine enforces on one account right now, plus
 * loss-cap used. Never throws: an engine read that fails is `status:
 * 'not_read'` with the error named, and every figure null.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} accountId
 * @param {{nowMs?:number, moneyCurrency?:string|null, openPnl?:number|null}} [opts]
 *   moneyCurrency — the account's broker-verified currency (account-overview
 *   `currency`), null when unread; openPnl — its broker floating P&L, null
 *   when not a complete fresh reading.
 */
export function dailyStopReading(db, accountId, { nowMs = Date.now(), moneyCurrency = null, openPnl = null } = {}) {
  const acct = String(accountId)
  const ccy = typeof moneyCurrency === 'string' && moneyCurrency.trim() ? moneyCurrency.trim().toUpperCase() : null
  let unitsComparable = ccy == null ? null : ccy === DAILY_STOP_CURRENCY
  let unitsNote = unitsComparable === false
    ? `The risk engine compares this ${DAILY_STOP_CURRENCY}-configured cap with this account's ${ccy} P&L; units question H-P2-4 is open and nothing here converts it.`
    : null
  let balance, balanceNative, verdict, money = null, fx = null
  try {
    // The pre-gate's three calls, in its order (account-pregate.js).
    const config = loadRiskConfig(db, acct)
    // C·1 PR-2: the same conversion the pre-gate and the gate apply. On a
    // converted account every figure below is USD, including the native
    // balance and P&L valued at the table's rate; a refused conversion is
    // the engine's own block and is reported as such, not as a USD cap.
    balanceNative = getAccountBalance(db, acct)
    money = sizingBalanceUsd(db, acct, { balance: balanceNative, now: nowMs })
    balance = money.balanceUsd
    verdict = dailyLossVerdict(db, config, acct, { balance, nowMs, money })
    if (money.conversion !== 'identity') {
      fx = conversionView(money)
      if (money.conversion === 'fx_table') {
        unitsComparable = true
        unitsNote = `The engine values this account's ${money.currency} money in ${DAILY_STOP_CURRENCY} at ${Number(money.rate).toPrecision(6)} (${money.rateSymbol} ${money.ratePrice}, ${money.rateAgeMin} min old) from the FX rate table; the figures here are ${DAILY_STOP_CURRENCY}.`
      } else {
        unitsComparable = false
        unitsNote = `${FX_RATE_UNAVAILABLE}: ${money.detail}. The engine blocks the day rather than assume a rate; the % figure shown is in ${money.currency} against ${money.currency} P&L, with the USD floor and flat cap not applied.`
      }
    }
  } catch (err) {
    const reason = `engine read failed: ${String(err?.message || err)}`
    return {
      accountId: acct, status: 'not_read', reason, currency: DAILY_STOP_CURRENCY,
      capUsd: null, binding: null, explain: null, parts: null,
      balanceUsed: null, balanceKey: `acct:${acct}:account_balance_usd`,
      dayAnchor: 'fx_day_17_00_new_york', dayStartSql: null,
      realisedTodayPnl: null, estimatedStopoutUsd: null, remainingUsd: null, engineBlock: null,
      moneyCurrency: ccy, unitsComparable, unitsNote, fx,
      lossCapUsed: { status: 'not_read', reason: 'the daily stop could not be read', pct: null, consumed: null, realisedLoss: null, floatingLoss: finite(openPnl) ? round2(Math.max(0, -openPnl)) : null },
    }
  }
  const p = verdict.pacing
  const capUsd = round2(p.capUsd)
  const realisedTodayPnl = round2(verdict.todayPnl)
  const converted = money?.conversion === 'fx_table'
  const refused = money?.conversion === 'refused'
  // The floating P&L is the broker's native money too: valued at the same
  // rate as everything else, or left native beside a native % figure.
  const openPnlUsed = converted && finite(openPnl) ? openPnl * money.rate : openPnl
  return {
    accountId: acct,
    status: capUsd == null ? 'uncapped' : 'in_force',
    reason: null,
    capUsd,
    // Refused: the % figure is native (see unitsNote); converted or USD: USD.
    currency: refused ? money.currency : DAILY_STOP_CURRENCY,
    binding: p.binding,
    explain: explainBinding(p, converted ? DAILY_STOP_CURRENCY : (refused ? money.currency : ccy)),
    parts: {
      pctCapUsd: round2(p.pctCapUsd),
      tierPct: p.tierPct ?? null,
      flatCapUsd: round2(p.usdCapUsd),
      flatInForceUsd: round2(p.usdInForce),
      floorUsd: p.floorUsd ?? null,
      floorBinding: !!p.floorBinding,
    },
    // What the % check took a fraction of: the engine's own balance read
    // (the account's `_usd` key; null when never stamped, when the % check is
    // inapplicable and only the flat/floor checks remain).
    balanceUsed: finite(balance) ? (converted ? round2(balance) : balance) : (refused && finite(balanceNative) ? balanceNative : null),
    balanceNative: finite(balanceNative) ? balanceNative : null,
    balanceKey: `acct:${acct}:account_balance_usd`,
    fx,
    dayAnchor: 'fx_day_17_00_new_york',
    dayStartSql: verdict.dayStartSql ?? null,
    realisedTodayPnl,
    estimatedStopoutUsd: verdict.checks?.daily_pnl_estimated_stopout_usd ?? null,
    remainingUsd: round2(p.remainingUsd),
    // The engine's own verdict right now: daily_loss_limit_hit, campaign_stop
    // or unknown_daily_pnl, with its reason line. Null when it would admit.
    engineBlock: verdict.block ? { guard: verdict.guard, reason: verdict.reason } : null,
    moneyCurrency: ccy,
    unitsComparable,
    unitsNote,
    lossCapUsed: lossCapUsed({ capUsd, realisedTodayPnl, openPnl: openPnlUsed, unitsComparable, moneyCurrency: refused ? money.currency : ccy }),
  }
}
