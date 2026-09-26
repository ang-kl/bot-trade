// daily-stop-display.js — the account card's "daily stop" and "loss-cap used",
// rendered from the server's reading, never computed here.
//
// WEB-2 (8,989-A row 4). The card used to print balance × dailyLossPct, a
// formula the risk engine does not enforce (the engine applies the USD 200
// floor and the 3%/4% balance tiers, and takes the flat cap out of force while
// the tier rule is on): −900 on an account the engine caps at 1,191.42, −0 on
// accounts it caps at 200. `loss-cap used` was hard-coded null. Both now come
// from GET /state/account-overview `accounts[].dailyStop`, which is the
// engine's own dailyLossVerdict (agent/services/daily-stop-reading.js).
//
// This module only turns that reading into words. It computes no cap and no
// percentage, and it never borrows a figure from another account.

const STATES = new Set(['in_force', 'uncapped', 'not_read'])
const USED_STATES = new Set(['measured', 'not_read', 'not_comparable', 'uncapped'])

/**
 * Normalise one account's `dailyStop` reading into the fields the cards use.
 * A missing or malformed reading is `not_read` — never a zero, never a dash
 * that could pass for "no stop".
 *
 * @param {object|null|undefined} ds  accounts[].dailyStop from /state/account-overview
 * @returns {{capState:string, cap:number|null, capCcy:string|null,
 *            used:number|null, usedState:string, capLoss:number|null,
 *            unitsNote:string|null, title:string}}
 */
export function dailyStopView(ds) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const capState = STATES.has(ds?.status) ? ds.status : 'not_read'
  const cap = capState === 'in_force' ? num(ds.capUsd) : null
  const capCcy = typeof ds?.currency === 'string' && ds.currency ? ds.currency : null
  const lc = ds?.lossCapUsed
  const usedState = capState === 'in_force' && cap != null
    ? (USED_STATES.has(lc?.status) ? lc.status : 'not_read')
    : capState === 'uncapped' ? 'uncapped' : 'not_read'
  const used = usedState === 'measured' ? num(lc?.pct) : null
  const capLoss = usedState === 'measured' ? num(lc?.consumed) : null
  const effectiveCapState = capState === 'in_force' && cap == null ? 'not_read' : capState
  const title = [
    effectiveCapState === 'in_force' ? `Daily stop the risk engine enforces: ${[capCcy, cap.toFixed(2)].filter(Boolean).join(' ')} per FX day (from 17:00 New York).` : null,
    effectiveCapState === 'uncapped' ? 'The risk engine enforces no daily stop on this account: both daily checks are off.' : null,
    effectiveCapState === 'not_read' ? `Daily stop not read${ds?.reason ? `: ${ds.reason}` : ''}.` : null,
    ds?.explain ? `Why: ${ds.explain}.` : null,
    num(ds?.balanceUsed) != null ? `Balance the % check used: ${num(ds.balanceUsed).toFixed(2)} (${ds.balanceKey}).` : null,
    lc && lc.realisedLoss != null ? `Realised loss today: ${lc.realisedLoss.toFixed(2)}${num(ds?.estimatedStopoutUsd) ? ` (incl. ${num(ds.estimatedStopoutUsd).toFixed(2)} estimated for stop-outs not yet priced)` : ''}.` : null,
    lc && lc.floatingLoss != null ? `Floating loss now: ${lc.floatingLoss.toFixed(2)}.` : null,
    usedState !== 'measured' && lc?.reason ? `Loss-cap used not shown: ${lc.reason}.` : null,
    ds?.unitsNote || null,
    ds?.engineBlock?.reason ? `Engine verdict now: ${ds.engineBlock.reason}` : null,
  ].filter(Boolean).join(' ')
  // The rest of the SAME reading, for the Data-feed card's line (WEB-9,
  // 8,989-A row 11): why this cap binds (the engine's own phrase), what the
  // engine leaves of it today, whether the engine blocks entries now, and
  // whether the account's money is in the cap's unit. Additive — every field
  // above is unchanged — and nothing is computed: each is the server's value
  // or null. A reading whose state is unrecognised carries none of them.
  const inForce = effectiveCapState === 'in_force'
  const binding = inForce && typeof ds?.binding === 'string' && ds.binding ? ds.binding : null
  const explain = inForce && typeof ds?.explain === 'string' && ds.explain ? ds.explain : null
  const remaining = inForce ? num(ds?.remainingUsd) : null
  const eb = ds?.engineBlock
  const block = effectiveCapState !== 'not_read' && eb && typeof eb === 'object'
    ? { guard: typeof eb.guard === 'string' && eb.guard ? eb.guard : null, reason: typeof eb.reason === 'string' ? eb.reason : null }
    : null
  const unitsComparable = typeof ds?.unitsComparable === 'boolean' ? ds.unitsComparable : null
  return {
    capState: effectiveCapState, cap, capCcy, used, usedState, capLoss, unitsNote: ds?.unitsNote || null, title,
    binding, explain, remaining, block, unitsComparable,
  }
}

/**
 * The Data-feed card's daily stop: the scoped account's OWN account-overview
 * row, through the same dailyStopView the account cards use (cardStopFields).
 * One reading for both, so the card and the account cards cannot disagree.
 * The portfolio scope has no single daily stop — each account has its own —
 * so it is null there.
 *
 * @param {{accounts?: Array<{accountId:string, dailyStop?:object}>}|null|undefined} overview
 * @param {string|null|undefined} acct  the page's account filter ('all' or an id)
 */
export function feedDailyStopView(overview, acct) {
  if (String(acct) === 'all') return null
  const row = (overview?.accounts || []).find(r => r != null && String(r.accountId) === String(acct))
  return dailyStopView(row?.dailyStop)
}

// Which guard in the engine's dailyLossVerdict (agent/services/risk.js)
// raised the block the reading carries (`engineBlock.guard`). Only
// `daily_loss_limit_hit` is the daily stop itself; the other two block
// through the same verdict but are different facts, and printing them beside
// the stop as a bare "entries blocked now" would read as the stop.
const BLOCK_WORDS = {
  daily_loss_limit_hit: 'entries blocked now: the daily stop is hit',
  campaign_stop: 'entries blocked now by the campaign stop (not the daily stop)',
  unknown_daily_pnl: "entries blocked now: today's P&L is unresolved (not the daily stop)",
}

/**
 * What the Data-feed card prints after `daily stop <stop><day>`: the engine's
 * reason the cap binds, what is left of it today, and the engine's block —
 * every word from the same view `dailyStopWords` reads, never a second
 * reading. `note` is the reading's own units note (a non-USD account).
 *
 * "Left today" is the engine's `remainingUsd` (cap − today's REALISED loss
 * only — floating is not subtracted here, unlike the account card's
 * "loss-cap used", which counts floating too; F3, WEB-9 checker nit: the two
 * figures measure different things and must say so, or a card reading "left
 * today: $1,130" beside another reading "used: 12%" looks like one
 * disagreeing number instead of two different questions). It is printed only
 * when the account's money is in the cap's unit: on a non-USD account the
 * engine subtracts that account's own P&L from a USD-configured cap
 * (H-P2-4), and the result is not a USD figure — the same reason the reading
 * refuses a loss-cap percentage there.
 *
 * @param {ReturnType<typeof dailyStopView>|null|undefined} view
 * @param {(n:number, d?:number) => string} money  the page's formatter
 * @returns {{text: string, note: string|null}}  text starts with ' · ' when non-empty
 */
export function dailyStopDetail(view, money) {
  const v = view || {}
  const parts = []
  if (v.capState === 'in_force' && v.cap != null) {
    if (v.explain) parts.push(v.explain)
    parts.push(v.unitsComparable === true
      ? (v.remaining != null ? `${money(v.remaining, 0)}${v.capCcy ? ` ${v.capCcy}` : ''} left today on realised P&L (floating not counted)` : 'left today not read')
      : v.unitsComparable === false ? 'left today not comparable' : 'left today not read')
  }
  if (v.block) {
    const g = v.block.guard
    parts.push(BLOCK_WORDS[g] || (g ? `entries blocked now by ${g}` : 'entries blocked now (guard not reported)'))
  }
  return { text: parts.map(p => ` · ${p}`).join(''), note: v.unitsNote || null }
}

/**
 * The two phrases a card prints. `money(n, 0)` is the page's formatter.
 * @returns {{stop:string, used:string}}
 */
export function dailyStopWords(view, money) {
  const v = view || {}
  // A card built without the state fields (older callers, fixtures) is read
  // from its numbers: a cap is in force, a missing one is not read.
  const capState = v.capState ?? (v.cap != null ? 'in_force' : 'not_read')
  const usedState = v.usedState ?? (v.used != null ? 'measured' : 'not_read')
  const stop = capState === 'in_force' && v.cap != null
    ? `−${money(v.cap, 0)}${v.capCcy ? ` ${v.capCcy}` : ''}`
    : capState === 'uncapped' ? 'off (both checks off)' : 'not read'
  const used = usedState === 'measured' && v.used != null ? `${v.used}%`
    : usedState === 'not_comparable' ? 'not comparable'
      : usedState === 'uncapped' ? '—' : 'not read'
  // The engine's day is the FX day (17:00 New York), not the page's calendar
  // day — said beside a cap, and only beside one.
  const day = capState === 'in_force' && v.cap != null ? ' (FX day)' : ''
  return { stop, used, day }
}

/** The card's colour for loss-cap used — the page's existing thresholds. */
export function usedColour(used, { P_MU, P_DN, P_WRN, P_ACC }) {
  return used == null ? P_MU : used > 66 ? P_DN : used > 33 ? P_WRN : P_ACC
}

/**
 * The stop fields one Performance account card carries, from THAT account's
 * own /state/account-overview row. The row's `balance` and `dailyLossPct`
 * are deliberately not consulted: their product is the formula the engine
 * does not enforce, and a missing reading is "not read", not a fallback.
 *
 * @param {object|null|undefined} row  accounts[i] of /state/account-overview
 * @param {{P_MU:string, P_DN:string, P_WRN:string, P_ACC:string}} palette
 */
export function cardStopFields(row, palette) {
  const v = dailyStopView(row?.dailyStop)
  return {
    cap: v.cap, used: v.used, capState: v.capState, capCcy: v.capCcy, usedState: v.usedState,
    capLoss: v.capLoss, stopTitle: v.title, usedCol: usedColour(v.used, palette),
  }
}
