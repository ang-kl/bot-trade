// Conservative P2c identity: an account's feed is isolated until equivalence
// with another account has actually been established. Ticker names alone are
// never instrument identity, and credentials are never part of this record.
export function marketIdentity({ provider, host, accountId, symbolId } = {}) {
  const id = value => {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
    return /^(?:[1-9]\d{0,18})$/.test(String(value)) ? String(value) : null
  }
  const account = id(accountId), symbol = id(symbolId)
  if ((provider != null && provider !== 'ctrader') || !account || !symbol
    || !['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(host)) return null
  return { provider: 'ctrader', host, accountId: account, symbolId: symbol }
}

export function marketIdentityKey(input) {
  const identity = marketIdentity(input)
  return identity ? JSON.stringify([identity.provider, identity.host, identity.accountId, identity.symbolId]) : null
}
