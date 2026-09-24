// Identity metadata only. No broker operation, money calculation or DB write.
const text = value => value == null || String(value) === '' ? null : String(value)

// The importer keeps stored account_id/position_id on an upsert. A statement
// may omit position_id, so resolve that omission from the retained SAME-account
// identity, never from an arbitrary matched_trade_id or another account.
export function brokerDealLinkIdentities(db, rows) {
  const retained = new Map()
  const ids = [...new Set(rows.map(row => text(row.deal_id)).filter(Boolean))]
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500)
    for (const row of db.prepare(`SELECT deal_id,account_id,position_id FROM broker_deals
      WHERE deal_id IN (${batch.map(() => '?').join(',')})`).all(...batch)) {
      retained.set(String(row.deal_id), { accountId: text(row.account_id), positionId: text(row.position_id) })
    }
  }
  const identities = new Map()
  for (const row of rows) {
    const dealId = text(row.deal_id), accountId = text(row.account_id), positionId = text(row.position_id)
    const stored = retained.get(dealId)
    if (!stored) {
      // Model the identity of the first INSERT as well as existing DB rows.
      // Later copies of a deal within this batch see the same retained identity.
      retained.set(dealId, { accountId, positionId })
      if (accountId && positionId) identities.set(row, { accountId, positionId })
      continue
    }
    if (!accountId || accountId !== stored.accountId || !stored.positionId) continue
    if (positionId && positionId !== stored.positionId) continue
    identities.set(row, { accountId, positionId: stored.positionId })
  }
  return identities
}
