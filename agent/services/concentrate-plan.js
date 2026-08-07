// ---------------------------------------------------------------------------
// agent/services/concentrate-plan.js — the concentrate-to-prove change, as one
// reviewable object instead of thirty console gestures.
//
// Owner, 2026-08-07: "you do it" — on the ordered list at the end of the
// watchlist review. The four items were: get open positions under the cap,
// replace the watchlist, arm the campaign against the REAL equity, pick three
// strategies.
//
// WHY THIS IS A MODULE AND NOT A SCRIPT. Three of those four are config writes
// on the money path, and the fourth is a refusal. A script that did them one at
// a time would leave the account half-converted if any step failed — a
// twenty-symbol list armed against a campaign that never got its start equity,
// which is precisely the partial state campaign-stop.js goes off rather than
// guess at. Shaping the whole change as one value means it can be PRINTED
// before it is APPLIED, and the print is the review.
//
// WHAT IT WILL NOT DO. It never closes a position. The open-position overage
// is the first thing that blocks trading (see `entryBlocker` below) and the
// most tempting thing to automate, and it is money-moving in the strict sense:
// it realises P&L. It is reported, in full, with the count that has to go —
// and left to a human with a full-tier credential.
// ---------------------------------------------------------------------------

/**
 * The twenty. Liquid, tight-spread, and as close to 24-hour as the broker
 * offers, because the binding constraint is SAMPLE SIZE and every hour a
 * symbol cannot trade is an hour it cannot fill a bucket.
 *
 * `why` is not decoration. When this list is wrong — and one of these will be
 * — the next person needs to know which property was being bought.
 */
export const CONCENTRATE_SYMBOLS = Object.freeze([
  { symbol: 'EURUSD', group: 'FX major', why: 'tightest spread on the book; near-24h' },
  { symbol: 'GBPUSD', group: 'FX major', why: 'tight, trends cleanly in the London session' },
  { symbol: 'USDJPY', group: 'FX major', why: 'tight; carries the Asia session' },
  { symbol: 'AUDUSD', group: 'FX major', why: 'tight; Asia-session liquidity' },
  { symbol: 'USDCAD', group: 'FX major', why: 'tight; oil-correlated without oil spreads' },
  { symbol: 'USDCHF', group: 'FX major', why: 'tight; the risk-off leg' },
  { symbol: 'NZDUSD', group: 'FX major', why: 'widest of the majors, still inside any cross' },
  { symbol: 'EURJPY', group: 'FX cross', why: 'the one cross worth its spread — real trend persistence' },
  { symbol: 'GBPJPY', group: 'FX cross', why: 'range is wide enough that the spread is a small fraction of SL' },
  { symbol: 'EURGBP', group: 'FX cross', why: 'tight for a cross; mean-reverts, so it feeds rsi2_reversion' },
  { symbol: 'XAUUSD', group: 'Metal', why: 'near-24h, deep, and the house trend instrument' },
  { symbol: 'XAGUSD', group: 'Metal', why: 'same hours as gold, higher volatility per unit of spread' },
  { symbol: 'US500', group: 'Index', why: 'the deepest index CFD; ~23h' },
  { symbol: 'NAS100', group: 'Index', why: 'deepest by volume; ~23h' },
  { symbol: 'GER40', group: 'Index', why: 'European trend, long hours' },
  { symbol: 'UK100', group: 'Index', why: 'European session, distinct from GER40 in composition' },
  { symbol: 'US30', group: 'Index', why: 'US session, price-weighted so it trends differently to US500' },
  { symbol: 'JPN225', group: 'Index', why: 'the Asia-session index; fills the dead hours' },
  { symbol: 'USOIL', group: 'Energy', why: 'the one energy contract with index-grade liquidity' },
  { symbol: 'BTCUSD', group: 'Crypto', why: 'genuinely 24/7 — the only thing that trades at the weekend' },
])

/**
 * Three strategies, chosen to be ORTHOGONAL rather than individually best.
 *
 * This is a judgement, not a measurement, and it should be labelled as one: no
 * strategy on this system has reached the 25-trade arming bar, so there is no
 * ranking to defer to. The reasoning is structural — one breakout, one
 * continuation, one reversion — so that the volatility gate cannot silence all
 * three at once. A trio of trend strategies would go quiet together in the
 * same regime and the quiet would look like "no edge" rather than "no setups".
 */
export const CONCENTRATE_STRATEGIES = Object.freeze([
  'donchian_breakout',  // breakout — fires in expansion
  'ema_pullback',       // continuation — fires mid-trend, the highest-frequency of the three
  'rsi2_reversion',     // reversion — fires in compression, when the other two cannot
])

/**
 * Why each dropped symbol is dropped, keyed by symbol. Held here rather than
 * generated, because "removed 18 symbols" is not a reviewable statement and
 * "removed COCOA: spread routinely exceeds maxSpreadFracOfSL" is.
 */
export const DROP_REASONS = Object.freeze({
  'LHX.US': 'US single name — ~6.5 trading hours, and the category that produced the four-way GD.US cluster',
  US2000: 'small-cap index — US cash hours only, and the widest spread of the US index set',
  FRA40: 'redundant against GER40 — same session, same driver, so it doubles exposure without doubling sample',
  WHEAT: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  CORN: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  COTTON: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  SUGAR: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  COFFEE: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  COCOA: 'soft — wide spread against maxSpreadFracOfSL, limited exchange hours',
  COPPER: 'thin outside LME hours; borderline, cut to keep the list short',
  NATGAS: 'widest spread and the most gap-prone contract on the book',
  XPDUSD: 'palladium — thin, and the spread is a large fraction of any sane stop',
  XPTUSD: 'platinum — thin, and the spread is a large fraction of any sane stop',
  NZDCAD: 'FX cross with no major inside it that we trade — spread of two majors, trend quality of neither',
  AUDCAD: 'FX cross — 2-4x the spread of AUDUSD with no compensating advantage',
  GBPAUD: 'FX cross — widest of the kept crosses, and it duplicates GBPUSD/AUDUSD exposure',
  EURCAD: 'FX cross — spread cost without a distinct driver',
  EURAUD: 'FX cross — spread cost without a distinct driver',
})

/**
 * Diff a current watchlist against the target.
 *
 * `current` accepts the two shapes the watchlist has historically been stored
 * in — bare strings and `{symbol, enabled}` objects — because both are still
 * in the database and a plan that only understood one would silently report
 * every symbol as an addition.
 *
 * @param {Array<string|object>} current
 * @param {ReadonlyArray<object>} target
 * @returns {{keep:string[], add:object[], remove:Array<{symbol:string, why:string}>}}
 */
export function watchlistPlan(current, target = CONCENTRATE_SYMBOLS) {
  const have = new Set(
    (Array.isArray(current) ? current : [])
      .map(s => (typeof s === 'string' ? s : s?.symbol))
      .filter(Boolean)
      .map(s => String(s).toUpperCase().trim())
  )
  const want = new Map(target.map(t => [t.symbol, t]))
  const keep = [...want.keys()].filter(s => have.has(s))
  const add = [...want.values()].filter(t => !have.has(t.symbol))
  const remove = [...have]
    .filter(s => !want.has(s))
    .sort()
    .map(symbol => ({
      symbol,
      // An unlisted symbol is still removed — it is simply not in the twenty.
      // Saying so is more honest than inventing a microstructure reason for
      // something nobody wrote a reason for.
      why: DROP_REASONS[symbol] || 'not in the concentrate-to-prove twenty',
    }))
  return { keep, add, remove }
}

/**
 * Build the campaign config from the account's LIVE equity.
 *
 * The whole reason this is a function and not a literal: every written figure
 * for this account has been stale within a day. The proposal used 46,073, the
 * tests used 46,073, and the account actually reads 45,418.81. A campaign
 * anchored to a number typed yesterday measures drawdown from a balance that
 * never existed, and it does so silently — the arithmetic works perfectly on
 * the wrong basis.
 *
 * Returns null on an unreadable equity rather than a partial config, which
 * campaignConfig() would refuse anyway; returning null here makes the refusal
 * legible at the call site instead of two modules away.
 *
 * @param {number|null} equity
 * @param {{pct?:number, startAt?:string, label?:string}} opts
 * @returns {object|null}
 */
export function campaignFor(equity, { pct = 0.08, startAt = null, label = 'concentrate-to-prove' } = {}) {
  const eq = Number(equity)
  const p = Number(pct)
  if (!Number.isFinite(eq) || eq <= 0) return null
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null
  if (typeof startAt !== 'string' || startAt.length < 10) return null
  return {
    maxDrawdownPct: p,
    startEquity: Math.round(eq * 100) / 100,
    startAt,
    label: typeof label === 'string' && label ? label : 'concentrate-to-prove',
  }
}

/**
 * The thing that outranks the watchlist.
 *
 * `maxOpenPositions` is checked with `>=` in the risk gate, so an account
 * sitting AT the cap is already refusing every proposal. Changing the symbol
 * list on such an account changes nothing observable, and the absence of
 * trades then reads as "the new list does not fire" — a wrong conclusion drawn
 * from a real silence. This is reported first, and loudly, for that reason.
 *
 * @param {{openPositions:number|null, maxOpenPositions:number}} a
 */
export function entryBlocker({ openPositions, maxOpenPositions }) {
  // `Number(null)` is 0, which is finite — so a missing count would read as
  // "zero positions open, nothing blocked", the single most dangerous wrong
  // answer this function can give. Reject the empty values by identity first.
  const open = openPositions == null || openPositions === '' ? NaN : Number(openPositions)
  const cap = maxOpenPositions == null || maxOpenPositions === '' ? NaN : Number(maxOpenPositions)
  if (!Number.isFinite(open) || !Number.isFinite(cap) || cap <= 0) {
    return { blocked: null, mustClose: null, reason: 'open-position count or cap unreadable — cannot say whether entries are blocked' }
  }
  if (open < cap) return { blocked: false, mustClose: 0, reason: null }
  const mustClose = open - cap + 1
  return {
    blocked: true,
    mustClose,
    reason: `max_positions=${open}/${cap} — the risk gate vetoes on >=, so EVERY entry is refused before the watchlist is consulted. `
      + `Close ${mustClose} position(s) to reach ${cap - 1}, or raise maxOpenPositions. `
      + `Nothing else in this plan takes effect until that is done.`,
  }
}

/**
 * The whole change, as one printable object. Pure — the caller owns every read.
 *
 * @param {{current:Array, equity:number|null, openPositions:number|null,
 *          maxOpenPositions:number, startAt:string, campaignPct?:number,
 *          label?:string, strategies?:string[]}} a
 */
export function concentratePlan({
  current,
  equity,
  openPositions,
  maxOpenPositions,
  startAt,
  campaignPct = 0.08,
  label = 'concentrate-to-prove',
  strategies = CONCENTRATE_STRATEGIES,
}) {
  const blocker = entryBlocker({ openPositions, maxOpenPositions })
  const watchlist = watchlistPlan(current)
  const campaign = campaignFor(equity, { pct: campaignPct, startAt, label })
  const budgetUsd = campaign ? Math.round(campaign.startEquity * campaign.maxDrawdownPct * 100) / 100 : null
  return {
    blocker,
    watchlist,
    campaign,
    // The two numbers worth putting next to each other: the campaign's whole
    // loss budget, and what one maximum day costs against it. On the 4% tier
    // that ratio is 2 — two full-cap days ends the campaign. That is arguably
    // correct and definitely worth seeing before arming rather than after.
    budgetUsd,
    strategies: [...strategies],
    // No campaign means no arming, and the reason has to travel with the plan
    // or the response reads as a success that quietly skipped a step.
    warnings: [
      ...(campaign ? [] : ['campaign NOT armed — equity, percentage or start time was unreadable, and a partial campaign is off by design']),
      ...(blocker.blocked ? [blocker.reason] : []),
      ...(watchlist.add.length === 0 && watchlist.remove.length === 0 ? ['watchlist already matches the target — nothing to change'] : []),
    ],
  }
}
