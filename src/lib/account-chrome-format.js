// ---------------------------------------------------------------------------
// src/lib/account-chrome-format.js — the formatting decisions for the account
// chrome, separated from the component so they can be tested without a DOM.
//
// Every function here answers one question the chrome line asks, and each has
// an explicit "we don't know" answer. A frame that renders 0 where it means
// "no data" is worse than one that renders a dash, because 0 is a number an
// operator will act on.
// ---------------------------------------------------------------------------

/** `5203012 · 46130058` — the login the broker shows, then the id we key on. */
export function accountLabel(row) {
  const login = row?.login ? String(row.login) : null
  const id = row?.accountId ? String(row.accountId) : null
  if (login && id) return `${login} · ${id}`
  return login || id || '—'
}

/** Money, with the account's own currency and no false precision. */
export function money(n, currency) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'USD',
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(v)
  } catch {
    // An unrecognised currency code must not blank the whole line.
    return `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`
  }
}

/** Plain 1,234.56 — for the Loss / Profit pair, which carry their own labels. */
export function amount(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const ARM_LABEL = Object.freeze({ armed: 'ARMED', disarmed: 'DISARMED' })

/**
 * Armed state, as a word plus a tone.
 *
 * `enabled` and `armed` are different facts (PR #624): enabled = the bot
 * watches this account, armed = it may enter. An account that is armed but not
 * enabled is not a contradiction to paper over — it is a state worth naming,
 * so it gets its own label rather than being folded into one of the other two.
 */
export function armState(row) {
  if (!row) return { label: '—', tone: 'muted', help: 'no account' }
  if (row.armed && row.enabled) return { label: 'ARMED', tone: 'up', help: 'may open new positions' }
  if (!row.armed && row.enabled) return { label: 'MANAGE-ONLY', tone: 'warn', help: 'watched and managed, but will not open new positions' }
  if (row.armed && !row.enabled) return { label: 'ARMED · OFF', tone: 'warn', help: 'armed but disabled in the registry — the bot is not watching it' }
  return { label: 'DISARMED', tone: 'muted', help: 'not watched, will not open positions' }
}

/**
 * Today's drawdown against the stop, e.g. `−2.1% / 8.0%`.
 *
 * Four distinct outcomes, because collapsing them loses the thing an operator
 * needs to know:
 *   tripped  — the stop already fired today
 *   spent    — down, with a live cap: how much of the allowance is gone
 *   flat/up  — not down, so the stop is not in play
 *   unknown  — no usable cap; say so rather than imply safety
 */
export function drawdownText(dd, currency) {
  if (!dd) return { text: '—', tone: 'muted', title: 'no drawdown data' }
  const stopPctText = dd.stopPct != null ? `${(Number(dd.stopPct) * 100).toFixed(1)}%` : '—'
  const floorNote = dd.trustworthy === false
    ? ` · at least this: ${dd.unknownCount} closed trade(s) today still have no realised P&L`
    : ''

  if (dd.tripped) {
    return {
      text: `STOPPED · ${stopPctText}`, tone: 'down',
      title: `The equity stop already fired today. ${money(dd.pnl, currency)} against a ${money(dd.cap, currency)} cap.${floorNote}`,
    }
  }
  if (dd.cap == null) {
    return {
      text: `— / ${stopPctText}`, tone: 'muted',
      title: `No usable cap: the stop needs a balance and a percentage, and one of them is missing.${floorNote}`,
    }
  }
  if (!(Number(dd.pnl) < 0)) {
    return {
      text: `0% / ${stopPctText}`, tone: 'muted',
      title: `Not down on the day (${money(dd.pnl, currency)}), so the ${stopPctText} equity stop is not in play.${floorNote}`,
    }
  }
  const spentPct = Number(dd.spent) * 100
  const ofBalancePct = dd.stopPct != null ? Number(dd.stopPct) * 100 * Number(dd.spent) : null
  return {
    // Shown as a fraction OF BALANCE against the stop, not as "% of the cap
    // used" — "−2.1% / 8.0%" reads directly against the number in the config,
    // whereas "26% used" needs a second calculation to mean anything.
    text: `${ofBalancePct != null ? `−${ofBalancePct.toFixed(1)}%` : `${spentPct.toFixed(0)}%`} / ${stopPctText}`,
    tone: spentPct >= 75 ? 'down' : spentPct >= 50 ? 'warn' : 'muted',
    title: `Down ${money(dd.pnl, currency)} today against a ${money(dd.cap, currency)} stop — ${money(dd.headroom, currency)} of headroom left (${spentPct.toFixed(0)}% of the allowance spent).${floorNote}`,
  }
}

/** `7 trades · Loss 1,204.55 · Profit 980.10` for the rolling 24h window. */
export function dayText(day) {
  if (!day) return { trades: '—', loss: '—', profit: '—', title: 'no trade data' }
  const unknownNote = day.unknown > 0
    ? ` ${day.unknown} of them have no realised P&L yet, so both figures are floors.`
    : ''
  return {
    trades: String(day.trades ?? 0),
    loss: amount(day.loss),
    profit: amount(day.profit),
    net: Number(day.profit || 0) - Number(day.loss || 0),
    title: `${day.trades ?? 0} trade(s) closed in the last 24 hours — ${day.wins ?? 0} up, ${day.losses ?? 0} down.${unknownNote} This window is wall-clock, unlike the drawdown, which follows the FX day the stop is anchored to.`,
  }
}
