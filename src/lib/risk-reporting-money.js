// Codex · №12,877 · 2026-10-10; codex-footprint: risk-reporting-parity.
// Display conversion only. Editable/saved balance remains native money.
function rate(account) {
  if (account?.currency === 'USD') return 1
  const fx = account?.fx
  return account?.currency && fx?.currency === account.currency
    && fx.currencySource === 'broker_verified' && fx.conversion === 'fx_table'
    && Number.isFinite(fx.rate) && fx.rate > 0 ? fx.rate : null
}

export function riskSizingBalance(draft, account) {
  const r = rate(account), value = draft?.balance
  if (r == null || String(draft?.accountId) !== String(account?.accountId)
    || value == null || value === '' || !Number.isFinite(Number(value))) return null
  return Number(value) * r
}

export function riskMarginUsd(margin, account) {
  const r = rate(account)
  if (r == null || !margin || margin.accountId !== account?.accountId || margin.currency !== account.currency) return null
  const out = { ...margin, currency: 'USD', nativeCurrency: margin.currency }
  for (const key of ['usedMargin', 'freeMargin', 'equity']) out[key] = typeof margin[key] === 'number' && Number.isFinite(margin[key]) ? margin[key] * r : null
  return out
}
