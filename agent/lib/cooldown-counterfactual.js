// ---------------------------------------------------------------------------
// agent/lib/cooldown-counterfactual.js — what did the SHORT cooldown let through?
//
// THE FINDING THIS SERVES (Defensive-Drift audit, 2026-08-06, §5.2 item 7).
// `symbolCooldownMinutes` is configured at 5 against a shipped default of 240.
// At the default, these two re-entries are refused:
//
//   JPN225 Sell  close 03-08 20:15:36 → next open 20:53:44   gap 38.1 min
//   JPN225 Sell  close      20:54:45 → next open 21:31:22    gap 36.6 min
//
// They cost −$10,487.68. The control was not broken and did not fail — it was
// turned down to five minutes, and nothing anywhere said so. A gate that is
// configured out of the way is INVISIBLE in exactly the way a gate that fires
// is not: there is no veto line, no log entry, nothing to read afterwards.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It changes no
// behaviour whatsoever. It never vetoes, never lengthens a window, never
// touches a threshold. It answers one question, on the verdict, at the moment
// the entry is allowed through:
//
//   "the shipped default would have refused this — the last close on this
//    symbol was a LOSS of $1,315.92, 38 minutes ago"
//
// so that a five-minute window reads as a CHOICE somebody made rather than an
// invisible default. Changing the number remains the owner's decision, and
// this file exists precisely so that decision can be made against evidence
// instead of against a config screen.
//
// WHY IT ONLY SPEAKS UP FOR LOSSES. Re-entering after a WIN is a normal thing
// a trend-following system does, and flagging it would bury the case that
// matters in noise. The hazard the cooldown guards is re-entering the level
// that just knocked us out.
// ---------------------------------------------------------------------------

/**
 * The shipped default, mirrored from DEFAULTS.symbolCooldownMinutes.
 *
 * Was 240 — the borrowed freqtrade figure — until the owner set it to 60 on
 * 2026-08-06. 60 is the measured number: it refuses both JPN225 re-entries and
 * is the smallest value that does. This constant must stay in step with
 * risk.js, because a counterfactual computed against a default the system no
 * longer ships would be a sentence about nothing.
 */
export const DEFAULT_SYMBOL_COOLDOWN_MIN = 60

// `Number(null)` is 0 and 0 is finite, so a missing P&L would otherwise read as
// a scratch trade — a confident "not a loss" for a figure nobody has. Absent is
// not the same as zero, and here the difference decides whether a re-entry gets
// flagged at all.
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const parseMs = (at) => {
  if (at == null) return null
  const t = new Date(at).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Would a longer cooldown have refused this entry, and was it worth refusing?
 *
 * @param {object} args
 * @param {string|number|null} args.lastCloseAt  most recent close on this symbol
 * @param {number|null} args.lastNetPnl          its realised P&L
 * @param {number} args.configuredMin            the window actually in force
 * @param {number} [args.defaultMin]             the window to compare against
 * @param {number} [args.nowMs]
 *
 * @returns {{minutesSince: number|null, configuredMin: number,
 *   defaultMin: number, lastNetPnl: number|null, lastCloseAt: string|null,
 *   wouldBlockAtDefault: boolean, note: string|null}}
 *
 * `note` is non-null ONLY when the configured window let an entry through that
 * the default would have refused AND the last close was a loss. Everything
 * else — no history, a win, a window already at or above the default, a gap
 * wide enough that both agree — returns note: null and says nothing.
 */
export function cooldownCounterfactual({
  lastCloseAt = null,
  lastNetPnl = null,
  configuredMin,
  defaultMin = DEFAULT_SYMBOL_COOLDOWN_MIN,
  nowMs = Date.now(),
} = {}) {
  const cfg = num(configuredMin) ?? 0
  const def = num(defaultMin) ?? DEFAULT_SYMBOL_COOLDOWN_MIN
  const closedMs = parseMs(lastCloseAt)
  const pnl = num(lastNetPnl)

  const base = {
    minutesSince: null,
    configuredMin: cfg,
    defaultMin: def,
    lastNetPnl: pnl,
    lastCloseAt: closedMs != null ? String(lastCloseAt) : null,
    wouldBlockAtDefault: false,
    note: null,
  }
  if (closedMs == null) return base

  // Round DOWN: "38 minutes ago" should not become 39 and appear to be outside
  // a 38-minute observation. The veto path rounds its remaining wait UP for the
  // opposite and equally deliberate reason.
  const minutesSince = Math.floor(Math.max(0, nowMs - closedMs) / 60_000)
  const wouldBlockAtDefault = def > cfg && minutesSince < def

  const out = { ...base, minutesSince, wouldBlockAtDefault }
  // A win is not the hazard. Zero is not a loss either — a scratch trade tells
  // us nothing about the level.
  if (!wouldBlockAtDefault || pnl == null || pnl >= 0) return out

  out.note =
    `symbol_cooldown configured ${cfg}m; the shipped default of ${def}m would have REFUSED this entry — ` +
    `last close on this symbol was a loss of ${formatUsd(pnl)}, ${minutesSince}m ago`
  return out
}

/** −1315.92 → "$1,315.92". Sign is carried by the surrounding words. */
export function formatUsd(n) {
  const v = Math.abs(Number(n) || 0)
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
