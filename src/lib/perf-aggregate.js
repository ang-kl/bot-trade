// perf-aggregate.js — the ALL ACCOUNTS summary for the Performance ledger.
//
// Owner (2026-07-30): "The current Performance Ledger does not clearly indicate
// whether the displayed information represents all accounts combined or a
// specific selected account… Do not calculate percentages by simply adding
// individual account percentages. Aggregate values using the correct underlying
// balances, limits, realised values and weighted calculations. Document the
// aggregation formula used for every consolidated percentage or forecast metric."
//
// ===========================================================================
// THE AGGREGATION FORMULAS, in full
// ===========================================================================
//
//   balance          Σ balanceᵢ                        (per currency)
//   equity           Σ equityᵢ  where known            (per currency)
//   day P&L          Σ dayᵢ                            (per currency)
//   TP nett today    Σ gwᵢ   (realised winners today)  (per currency)
//   SL nett today    Σ glᵢ   (realised losers today)   (per currency)
//   30d net          Σ n30ᵢ                            (per currency)
//   30d pace/day     (Σ n30ᵢ) / 30                     (per currency)
//   daily stop       Σ capᵢ                            (per cap currency)
//   loss-cap used %  100 × (Σ max(0, −dayᵢ)) / (Σ capᵢ)
//                    — or, for cards carrying the engine reading (WEB-2),
//                    100 × (Σ capLossᵢ) / (Σ capᵢ), capLossᵢ being the
//                    server's measured realised + floating loss; null unless
//                    every account in the group has it
//
// The last line is the one the instruction is about. The WRONG answer is
// mean(usedᵢ) or Σ usedᵢ: two accounts each "50% used" do NOT make the
// portfolio 50% or 100% used, because their caps differ — a 46%-used $43 cap
// and a 0%-used $1,546 cap together are about 1.3% of the combined cap, not 23%.
// The ratio is therefore rebuilt from the underlying money, never from the
// per-account percentages. Same rule for pace: it is derived from summed net,
// not averaged from per-account paces.
//
// ===========================================================================
// WHY EVERY TOTAL IS PER CURRENCY
// ===========================================================================
// This cTrader ID holds SGD accounts (live LOGIN-1 at 33.45 SGD) and USD
// accounts (demo LOGIN-3) at the same time. `SGD 33.45 + USD 51,531.56` is not
// a number — it is two numbers with a plus sign between them. There is no FX
// rate on this payload, and inventing one to produce a single impressive total
// would be the worst possible lie on a capital-safety panel.
//
// So the summary reports a group PER CURRENCY and says how many there are. When
// every in-play account shares one currency (the common case) that is exactly
// one group and reads like a normal total. `mixedCurrency` tells the UI to stop
// implying a single portfolio figure.

/** Numbers only; null/undefined/NaN are absent, never 0. */
const n = (v) => {
  if (v == null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}
/** Σ over the defined values; null when NOTHING was defined (≠ a real 0). */
function sum(rows, pick) {
  let total = 0
  let any = false
  for (const r of rows) {
    const v = n(pick(r))
    if (v != null) { total += v; any = true }
  }
  return any ? total : null
}

/**
 * Consolidate the in-play account cards.
 *
 * @param {Array<{id, name, ccy, bal, day, gw, gl, n30, cap, used, equity,
 *                hasToday, isLive?, dormantButHeld?}>} cards
 * @returns {{
 *   accountCount: number, liveCount: number, demoCount: number, offCount: number,
 *   currencies: string[], mixedCurrency: boolean,
 *   groups: Array<{ccy, accountCount, bal, equity, day, gw, gl, n30, pace30d,
 *                  cap, usedPct, hasToday}>,
 *   primary: object|null,
 * }}
 *   `primary` is the largest group by balance — what a single-line readout
 *   should show when it has room for only one. It is NOT a portfolio total.
 */
export function aggregateAccounts(cards) {
  const rows = Array.isArray(cards) ? cards : []
  const byCcy = new Map()
  for (const c of rows) {
    const key = c.moneyVerified === false ? (c.currentMoneyVerified ? `Account ${c.id} · ${c.ccy} current / recorded close units` : `Account ${c.id} · unverified units`) : c.ccy || '—'
    if (!byCcy.has(key)) byCcy.set(key, [])
    byCcy.get(key).push(c)
  }

  const groups = [...byCcy.entries()].map(([ccy, list]) => {
    // Daily stops in different currencies are not added (WEB-2): the engine
    // states each cap in its own unit, and Σ across units is not a number.
    const capCcys = new Set(list.map(r => r.capCcy ?? null))
    const capCcy = capCcys.size === 1 ? [...capCcys][0] : null
    const cap = capCcys.size > 1 ? null : sum(list, r => r.cap)
    // The realised LOSS today, in money, is what consumes the daily stop.
    // Rebuilt from dayᵢ so the ratio has the same numerator the per-account
    // cards use, rather than trusting their rounded percentages.
    const lossToday = list.reduce((s, r) => {
      const d = n(r.day)
      return s + (d != null && d < 0 ? -d : 0)
    }, 0)
    const n30 = sum(list, r => r.n30)
    // WEB-2: cards built from the engine's reading carry `capLoss` — the
    // server's measured realised + floating loss against the stop, in the
    // stop's unit, or null when a part is unread or the units differ. When
    // every card carries the field, the ratio is Σ capLoss / Σ cap and it is
    // shown only if every account has both readings: one unread account would
    // otherwise make the group look safer than it is. Cards without the field
    // (older callers) keep the realised-only ratio below, unchanged.
    const capLossMode = list.length > 0 && list.every(r => Object.prototype.hasOwnProperty.call(r, 'capLoss'))
    const capLossComplete = capLossMode && list.every(r => n(r.capLoss) != null && n(r.cap) != null)
    const capLoss = capLossComplete ? sum(list, r => r.capLoss) : null
    const usedPct = capLossMode
      ? (capLossComplete && cap && cap > 0 ? Math.round(capLoss / cap * 100) : null)
      // Σloss / Σcap — never the mean of the per-account percentages.
      : list.every(r => r.moneyVerified !== false) && cap && cap > 0 ? Math.min(100, Math.round(lossToday / cap * 100)) : null
    return {
      ccy,
      accountCount: list.length,
      bal: sum(list, r => r.bal),
      equity: sum(list, r => r.equity),
      day: sum(list, r => r.day),
      gw: sum(list, r => r.gw),
      gl: sum(list, r => r.gl),
      n30,
      pace30d: n30 == null ? null : n30 / 30,
      cap,
      capCcy,
      lossToday,
      capLoss,
      usedPct,
      // Why a group has no percentage, in the cards' own words.
      usedState: usedPct != null ? 'measured'
        : capLossMode && list.some(r => r.usedState === 'not_comparable') ? 'not_comparable' : 'not_read',
      hasToday: list.some(r => r.hasToday),
    }
  }).sort((a, b) => (n(b.bal) ?? -Infinity) - (n(a.bal) ?? -Infinity))

  return {
    accountCount: rows.length,
    liveCount: rows.filter(c => c.isLive === true).length,
    demoCount: rows.filter(c => c.isLive === false).length,
    // "OFF" = shown because it still carries risk while disabled in Connect.
    offCount: rows.filter(c => c.dormantButHeld === true).length,
    currencies: groups.map(g => g.ccy),
    mixedCurrency: groups.length > 1,
    groups,
    primary: groups[0] ?? null,
  }
}

/** ALL-scope sentinel. Kept next to the maths so both sides agree on the word. */
export const ALL_SCOPE = 'all'

/**
 * The scope label the page must always show (owner: "At every moment, the user
 * must be able to answer, without inference, 'Am I viewing all accounts or one
 * specific account?'").
 */
export function scopeLabel(scope, cards) {
  if (scope === ALL_SCOPE) {
    const c = Array.isArray(cards) ? cards.length : 0
    return c === 1
      ? 'All accounts · 1 account'
      : `All accounts · consolidated across ${c} account${c === 1 ? '' : 's'}`
  }
  const hit = (cards || []).find(c => String(c.id) === String(scope))
  return hit ? hit.name : `Account ${scope}`
}
