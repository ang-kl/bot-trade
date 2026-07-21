// risk-criteria.js — turn a risk-gate `checks` object (+ the veto_reason) into
// an ordered, human-readable list of the criteria that were actually evaluated.
// Owner: "Risk Decision is so superficial ... where are the information for each
// record ... you need more than one criteria." The gate already records many
// criteria into checks_json (daily P&L, streak, positions, R:R, SL%, exposure,
// correlation, sizing, margin); this surfaces ALL of them per record and flags
// which one failed. Pure + framework-free so it's unit-testable.

const money = (v) => (v == null ? null : `${v < 0 ? '−' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const num = (v, d = 2) => (v == null ? null : Number(v).toFixed(d))

// Map the veto_reason's leading token to the criterion key it failed on, so the
// matching row can be highlighted. Kept in sync with risk.js veto() strings.
function failedKey(vetoReason) {
  const r = String(vetoReason || '')
  if (/^daily_loss_limit_hit/.test(r)) return 'daily'
  if (/^loss_streak_cooldown/.test(r)) return 'streak'
  if (/^max_positions/.test(r)) return 'positions'
  if (/duplicate|already_in_symbol|already in this symbol/i.test(r)) return 'duplicate'
  if (/^symbol_cooldown/.test(r)) return 'cooldown'
  if (/^symbol_blocked/.test(r)) return 'blocked'
  if (/^bad_rr/.test(r)) return 'rr'
  if (/^sl_too_tight/.test(r)) return 'slPct'
  if (/^(sl_at_entry|missing_entry_or_sl)/.test(r)) return 'sl'
  if (/^overexposed/.test(r)) return 'exposure'
  if (/^correlated/.test(r)) return 'correlation'
  if (/^(insufficient_equity|min_lot)/.test(r)) return 'sizing'
  if (/^negative_expectancy/.test(r)) return 'kelly'
  if (/^insufficient_margin/.test(r)) return 'margin'
  return null
}

/**
 * @param {object} checks — parsed checks_json from a risk_events row
 * @param {string|null} vetoReason — the row's veto_reason (null when approved)
 * @returns {Array<{key:string,label:string,value:string,failed:boolean,group:string}>}
 */
export function describeRiskCriteria(checks = {}, vetoReason = null) {
  const c = checks || {}
  const fk = failedKey(vetoReason)
  const rows = []
  const add = (key, group, label, value) => {
    if (value == null || value === '') return
    rows.push({ key, group, label, value, failed: fk === key })
  }

  // Account context
  add('balance', 'Account', 'Balance', money(c.balance))
  add('leverage', 'Account', 'Leverage', c.leverage != null ? `1:${c.leverage}` : null)
  add('tier', 'Account', 'Tier', c.tier)

  // Loss limits
  if (c.daily_pnl != null || c.daily_cap_usd != null) {
    add('daily', 'Loss limits', "Today's P&L vs cap", `${money(c.daily_pnl) ?? '—'} / cap ${money(c.daily_cap_usd) ?? '—'}`)
  }
  if (c.loss_streak != null) add('streak', 'Loss limits', 'Loss streak', String(c.loss_streak))

  // Exposure & pacing
  if (c.open_positions != null) add('positions', 'Exposure', 'Open positions', String(c.open_positions))
  if (c.exposure && typeof c.exposure === 'object') {
    const parts = Object.entries(c.exposure).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
    if (parts.length) add('exposure', 'Exposure', 'Currency exposure', parts.join(', '))
  }
  if (c.correlation && typeof c.correlation === 'object') {
    const cor = c.correlation
    const withStr = Array.isArray(cor.stacked)
      ? cor.stacked.map(s => `${s.symbol}@${s.corr}`).join(', ')
      : Array.isArray(cor.others) ? cor.others.join(', ') : ''
    add('correlation', 'Exposure', 'Correlation', withStr ? `${withStr}` : 'flagged')
  }

  // Trade quality
  if (c.rr != null) add('rr', 'Trade quality', 'Reward : Risk', `${num(c.rr)}`)
  if (c.sl_pct != null) add('slPct', 'Trade quality', 'Stop distance', `${num(c.sl_pct, 3)}% of price`)
  else if (c.sl_distance != null) add('sl', 'Trade quality', 'Stop distance', num(c.sl_distance, 5))

  // Sizing
  if (c.risk_budget != null) {
    const pct = c.risk_pct_effective != null ? ` (${(c.risk_pct_effective * 100).toFixed(2)}%)` : ''
    add('sizing', 'Sizing', 'Risk budget', `${money(c.risk_budget)}${pct}${c.derisked ? ' · de-risked' : ''}`)
  }
  if (c.risk_based_volume != null) add('sizingVol', 'Sizing', 'Risk-based size', `${num(c.risk_based_volume)} lots`)
  if (c.kelly_volume != null) add('kelly', 'Sizing', 'Kelly / expectancy size', `${num(c.kelly_volume)} lots`)

  // Margin
  if (c.margin_total_usd != null || c.margin_required_usd != null) {
    const used = c.margin_used_usd != null ? `${money(c.margin_used_usd)} used + ` : ''
    const req = money(c.margin_required_usd) ?? '—'
    const cap = c.margin_cap_usd != null ? ` vs cap ${money(c.margin_cap_usd)}` : ''
    add('margin', 'Margin', 'Margin', `${used}${req} new${cap}`)
  }

  return rows
}

export const RISK_CRITERIA_GROUPS = ['Account', 'Loss limits', 'Exposure', 'Trade quality', 'Sizing', 'Margin']
