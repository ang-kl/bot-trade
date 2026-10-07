// Codex · №11,784 · 2026-10-07; codex-footprint: performance-essentials.
// Formats server whole-period statistics; never pools or converts money.
const finite = v => typeof v === 'number' && Number.isFinite(v)
const number = v => finite(v) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v === 0 ? 0 : v) : '—'
const signed = v => finite(v) ? `${v > 0 ? '+' : ''}${number(v)}` : '—'

export function historicalMetricGroups(a) {
  if (!a) return []
  const money = a.moneyState === 'recorded_account_units'
  const m = key => money && finite(a[key]) ? a[key] : null
  const span = finite(a.firstMs) && finite(a.lastMs)
    ? `${new Date(a.firstMs).toISOString().slice(0, 10)} → ${new Date(a.lastMs).toISOString().slice(0, 10)}` : 'dates unavailable'
  const pf = m('profitFactor'), grossLoss = m('grossLoss')
  const pfNote = money && grossLoss === 0 ? 'Undefined: no negative net closes in this population.'
    : 'positive net ÷ absolute negative net, after recorded commission and swap'
  return [
    ['Outcome', [
      ['Net P&L', signed(m('net')), '', 'priced closes in recorded account units; unavailable across account identities'],
      ['Priced closes', String(a.trades), '', `${a.tradingDays} UTC days with a priced close · ${span} UTC`],
      ['Win rate', finite(a.winRate) ? `${number(a.winRate)}%` : '—', '', `${a.wins} positive · ${a.losses} non-wins (scratches included)`],
      ['Expectancy', `${number(m('expectancy'))} / trade`, '', 'average net of priced closes; historical, not a forecast'],
    ]],
    ['Edge', [
      ['Profit factor', number(pf), pf == null ? '' : pf >= 1 ? 'up' : 'down', pfNote],
      ['Payoff ratio', m('payoff') == null ? '—' : `${number(m('payoff'))} : 1`, '', 'average positive net ÷ average non-win loss; scratches remain in the non-win count'],
      ['Avg win', signed(m('avgWin')), 'up', `across ${a.wins} positive closes`],
      ['Avg non-win loss', m('avgLoss') == null ? '—' : signed(-m('avgLoss')), 'down', `across ${a.losses} non-wins, including scratches`],
    ]],
    ['Risk & shape', [
      ['Max drawdown', m('maxDrawdown') == null ? '—' : signed(-m('maxDrawdown')), 'down', 'deepest decline in the closed-trade net path; excludes open-position equity'],
      ['Best / worst trade', `${number(m('bestTrade'))} / ${number(m('worstTrade'))}`, '', 'highest / lowest recorded net'],
      ['Best / worst day', `${number(m('bestDay'))} / ${number(m('worstDay'))}`, '', m('greenDays') == null ? 'Profitable-day count unavailable in this money scope; historical days use UTC.' : `${a.greenDays} of ${a.tradingDays} UTC days had positive recorded net`],
      ['Longest streak', `${a.winStreak}W / ${a.lossStreak} non-wins`, '', 'consecutive positive / non-positive priced closes in close order'],
      ['Median hold', finite(a.medianHoldMin) ? `${number(a.medianHoldMin)} min` : '—', '', finite(a.medianHoldMin) ? 'median of recorded holding durations' : 'holding durations unavailable'],
    ]],
  ]
}

export function historicalMetricNotes(a) {
  if (!a) return ['Historical metrics unavailable.']
  const priced = a.pricedTrades ?? a.trades
  const closed = a.closedTrades ?? priced
  const missing = a.unpricedTrades ?? Math.max(0, closed - priced)
  return [
    `Historical priced-close sample: ${priced} priced of ${closed} dated recorded closes; ${missing} close${missing === 1 ? '' : 's'} without P&L; ${a.unknownCloseTimeN ?? 'unknown'} rows without a usable close time.`,
    a.moneyState === 'recorded_account_units'
      ? 'Money uses recorded account units. Historical currency conversion and completeness of broker history are unverified.'
      : 'Money unavailable: these closes span account identities or lack an account stamp. Select an attributable account to inspect its money metrics. No FX conversion is assumed.',
    'Use the forward, per-account results above for the current goals. This historical sample and its UTC days do not certify whole-position forward performance.',
  ]
}
