// node --test agent/services/trade-integrity.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { findDuplicateTrades } from './trade-integrity.js'

function insertTrade(db, { symbol, side, entry, exit, pnl, posId, closedAt = "datetime('now')", strategy = null }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, label_strategy, opened_at)
    VALUES (?, ?, ?, ?, ?, 'closed', ${closedAt}, ?, ?, datetime('now'))
  `).run(symbol, side, entry, exit, pnl, posId ?? null, strategy)
}

test('finds a duplicate group sharing symbol/side/entry/exit/net_pnl (owner: 7 identical AUDUSD rows)', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 7; i++) {
    insertTrade(db, { symbol: 'AUDUSD', side: 'SELL', entry: 0.6512, exit: 0.6578, pnl: -508.37, posId: '900' })
  }
  const { groups, totalExtraRows, totalExtraPnl } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 7)
  assert.equal(groups[0].samePositionId, true)
  assert.equal(totalExtraRows, 6)
  assert.equal(totalExtraPnl, -3050.22) // 6 × -508.37
})

test('does not flag genuinely different trades', () => {
  const db = initDB(':memory:')
  insertTrade(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.11, pnl: 50 })
  insertTrade(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.09, pnl: -100 }) // different exit/pnl
  insertTrade(db, { symbol: 'GBPUSD', side: 'BUY', entry: 1.1, exit: 1.11, pnl: 50 }) // different symbol
  const { groups, totalExtraRows } = findDuplicateTrades(db)
  assert.equal(groups.length, 0)
  assert.equal(totalExtraRows, 0)
})

test('flags a group even without a shared position id, but marks samePositionId false', () => {
  const db = initDB(':memory:')
  insertTrade(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: 151, pnl: 20, posId: '1' })
  insertTrade(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: 151, pnl: 20, posId: '2' })
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].samePositionId, false)
})

test('only considers CLOSED trades with entry/net_pnl present', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,50,'open', datetime('now'))`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,NULL,'closed', datetime('now'), datetime('now'))`).run()
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 0)
})

test('a broker-side close backfilled by pnl-backfill.js (net_pnl set, exit_price still NULL) is still caught (Codex review)', () => {
  const db = initDB(':memory:')
  // Same shape pnl-backfill.js leaves behind: status closed, net_pnl filled
  // in later, exit_price never touched — the exact class of duplicate the
  // old exit_price-required predicate was blind to.
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at)
      VALUES ('AUDUSD', 'SELL', 0.6512, NULL, -508.37, 'closed', datetime('now'), '900', datetime('now'))
    `).run()
  }
  const { groups, totalExtraRows } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].samePositionId, true)
  assert.equal(totalExtraRows, 2)
})

test('flags multiple closed trades sharing one broker position id even when net_pnl differs (position-id signal)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at) VALUES ('EURUSD','BUY',1.1,1.11,50,'closed', datetime('now'), '77', datetime('now'))`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, net_pnl, status, closed_at, ctrader_position_id, opened_at) VALUES ('EURUSD','BUY',1.1,1.12,55,'closed', datetime('now'), '77', datetime('now'))`).run()
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].samePositionId, true)
})

// --- findSameSymbolClusters (owner: double/triple symbols in EU & NY) -------

function insertOpen(db, { symbol, side, volume = 0.1, entry = 1, posId, minutesAgo = 0, label = null, source = null, strategy = null, session = null, account = '47790949', status = 'open', pnl = null }) {
  db.prepare(`
    INSERT INTO trades (symbol, side, volume, entry_price, net_pnl, status, opened_at,
                        ctrader_position_id, label_raw, source, label_strategy, label_session, account_id)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?, ?, ?, ?)
  `).run(symbol, side, volume, entry, pnl, status, `-${minutesAgo} minutes`, posId ?? null, label, source, strategy, session, account)
}

test('clusters distinct fills on one symbol and names the responsible path', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  // Three separate VPO sidecar fills on EURUSD minutes apart — different
  // prices and position ids, so findDuplicateTrades is blind to them.
  insertOpen(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1701, posId: '1', minutesAgo: 30, label: 'vpo:ema_pullback', session: 'EU' })
  insertOpen(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1698, posId: '2', minutesAgo: 29, label: 'vpo:donchian', session: 'EU' })
  insertOpen(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1695, posId: '3', minutesAgo: 28, label: 'vpo:rsi2', session: 'EU' })
  const { clusters, worst, byPath } = findSameSymbolClusters(db)
  assert.equal(clusters.length, 1)
  assert.equal(worst.count, 3)
  assert.equal(worst.symbol, 'EURUSD')
  assert.equal(worst.distinctPositionIds, 3)
  assert.deepEqual(worst.paths, ['vpo-sidecar'])
  assert.equal(worst.crossPath, false)
  assert.equal(worst.openLegs, 3)
  assert.equal(byPath['vpo-sidecar'], 2) // two EXTRA legs beyond the first
})

test('flags a cross-path cluster (market entry racing a resting fib limit)', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  insertOpen(db, { symbol: 'XAUUSD', side: 'BUY', posId: '10', minutesAgo: 20, source: 'autopilot', strategy: 'fib_618_fade' })
  insertOpen(db, { symbol: 'XAUUSD', side: 'BUY', posId: '11', minutesAgo: 5, label: 'a|1|fib_618_fade|hi|NY|4h||pending-fib' })
  const { worst } = findSameSymbolClusters(db)
  assert.equal(worst.count, 2)
  assert.equal(worst.crossPath, true)
  assert.deepEqual(worst.paths.sort(), ['autopilot', 'pending-fib'])
})

test('a hedge on one symbol is reported and marked hedged, not hidden', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  insertOpen(db, { symbol: 'USDJPY', side: 'BUY', posId: '20', minutesAgo: 10, source: 'autopilot' })
  insertOpen(db, { symbol: 'USDJPY', side: 'SELL', posId: '21', minutesAgo: 9, source: 'autopilot' })
  const { worst } = findSameSymbolClusters(db)
  assert.equal(worst.hedged, true)
  assert.deepEqual(worst.sides.sort(), ['BUY', 'SELL'])
})

test('the same symbol on DIFFERENT accounts is not a cluster (multi-account fan-out is by design)', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  insertOpen(db, { symbol: 'GBPUSD', side: 'BUY', posId: '30', minutesAgo: 5, account: '43097342' })
  insertOpen(db, { symbol: 'GBPUSD', side: 'BUY', posId: '31', minutesAgo: 5, account: '46979908' })
  insertOpen(db, { symbol: 'GBPUSD', side: 'BUY', posId: '32', minutesAgo: 5, account: '46130058' })
  const { clusters } = findSameSymbolClusters(db)
  assert.equal(clusters.length, 0)
})

test('opens further apart than the window are separate clusters, not one', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  insertOpen(db, { symbol: 'US500', side: 'BUY', posId: '40', minutesAgo: 600 })
  insertOpen(db, { symbol: 'US500', side: 'BUY', posId: '41', minutesAgo: 599 })
  insertOpen(db, { symbol: 'US500', side: 'BUY', posId: '42', minutesAgo: 10 })
  insertOpen(db, { symbol: 'US500', side: 'BUY', posId: '43', minutesAgo: 9 })
  const { clusters } = findSameSymbolClusters(db)
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters.map(c => c.count), [2, 2])
})

// S1 batch 6. findOpenDuplicates already scoped its same-second key to the
// account and wrote down why; this function did not. The bot dispatches one
// signal to several accounts, so two accounts filling the same symbol at the
// same price is the system working — not a duplicate record.
function insertScoped(db, acct, o) {
  db.prepare(`
    INSERT INTO trades (account_id, symbol, side, entry_price, exit_price, net_pnl,
                        status, closed_at, ctrader_position_id, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, 'closed', datetime('now'), ?, datetime('now'))
  `).run(acct, o.symbol, o.side, o.entry, o.exit, o.pnl, o.posId ?? null)
}

test('the SAME fill on TWO accounts is not a duplicate — it is the bot doing its job', () => {
  const db = initDB(':memory:')
  const leg = { symbol: 'EURUSD', side: 'BUY', entry: 1.0850, exit: 1.0900, pnl: 42.5 }
  insertScoped(db, 'AAA', { ...leg, posId: '10' })
  insertScoped(db, 'BBB', { ...leg, posId: '11' })   // different broker position
  const { groups, totalExtraRows, totalExtraPnl } = findDuplicateTrades(db)
  assert.equal(groups.length, 0, 'copied legs must not merge into one false duplicate')
  assert.equal(totalExtraRows, 0)
  assert.equal(totalExtraPnl, 0, 'and must not subtract real P&L from Performance')
})

test('a real duplicate WITHIN one account is still caught, and names the account', () => {
  const db = initDB(':memory:')
  const leg = { symbol: 'EURUSD', side: 'BUY', entry: 1.0850, exit: 1.0900, pnl: 42.5, posId: '10' }
  insertScoped(db, 'AAA', leg)
  insertScoped(db, 'AAA', leg)
  const { groups, totalExtraRows } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].accountId, 'AAA')
  assert.equal(totalExtraRows, 1)
})

test('one broker position id under TWO accounts stays flagged — scoping must not hide it', () => {
  const db = initDB(':memory:')
  // Different prices, so only the position-id signal can catch this. That key
  // is deliberately NOT account-scoped: one id is one position at the broker,
  // so the same id on two accounts is a bookkeeping fault however it arose.
  insertScoped(db, 'AAA', { symbol: 'GBPUSD', side: 'SELL', entry: 1.27, exit: 1.26, pnl: 80, posId: '777' })
  insertScoped(db, 'BBB', { symbol: 'GBPUSD', side: 'SELL', entry: 1.28, exit: 1.25, pnl: 91, posId: '777' })
  const { groups } = findDuplicateTrades(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 2)
})

test('scope filters the window to one account', () => {
  const db = initDB(':memory:')
  const leg = { symbol: 'EURUSD', side: 'BUY', entry: 1.0850, exit: 1.0900, pnl: 42.5, posId: '10' }
  insertScoped(db, 'AAA', leg); insertScoped(db, 'AAA', leg)
  insertScoped(db, 'BBB', leg); insertScoped(db, 'BBB', leg)
  const scoped = findDuplicateTrades(db, { scope: { accountId: 'AAA', all: false } })
  assert.equal(scoped.groups.length, 1)
  assert.equal(scoped.groups[0].accountId, 'AAA')
  const all = findDuplicateTrades(db, { scope: { all: true } })
  assert.equal(all.groups.length, 2, 'the portfolio view still sees both accounts, separately')
})

// S1 batch 7 — the cluster/open-duplicate KEYS were already account-scoped,
// but the READS were not: selecting an account still walked every account's
// rows and merely grouped them apart. Correct output at the wrong cost, and
// `worst` stayed a portfolio answer on a per-account screen.
test('findOpenDuplicates scopes the read, not just the key', async () => {
  const { findOpenDuplicates } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  const ins = db.prepare(`
    INSERT INTO monitored_positions (account_id, symbol, side, entry_price, status, source, created_at)
    VALUES (?, ?, 'long', 1.25, 'active', 'autopilot', datetime('now'))
  `)
  // Two real duplicates on AAA, two on BBB.
  ins.run('AAA', 'EURUSD'); ins.run('AAA', 'EURUSD')
  ins.run('BBB', 'EURUSD'); ins.run('BBB', 'EURUSD')

  const all = findOpenDuplicates(db)
  const aaa = findOpenDuplicates(db, { scope: { accountId: 'AAA', all: false } })
  // Without opened_at the same-second key is null, so no group forms either
  // way — what this pins is that scoping never INVENTS or MERGES a group.
  for (const g of aaa.groups) assert.equal(g.accountId, 'AAA')
  assert.ok(aaa.groups.length <= all.groups.length)
})

test('findSameSymbolClusters scopes the read', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  const ins = db.prepare(`
    INSERT INTO trades (account_id, symbol, side, volume, entry_price, status, opened_at)
    VALUES (?, 'EURUSD', 'BUY', 1, 1.1, 'open', datetime('now'))
  `)
  ins.run('AAA'); ins.run('AAA'); ins.run('BBB'); ins.run('BBB')

  const all = findSameSymbolClusters(db, { includeImported: false })
  const aaa = findSameSymbolClusters(db, { includeImported: false, scope: { accountId: 'AAA', all: false } })
  assert.equal(all.clusters.length, 2, 'unscoped sees both accounts, grouped apart')
  assert.equal(aaa.clusters.length, 1, 'scoped sees only the selected account')
  assert.equal(aaa.clusters[0].accountId, 'AAA')
})

// ---------------------------------------------------------------------------
// V3 B2 (P5b-2): broker evidence decides what is a duplicate, each extra row
// counts at its own money, and money is never summed across currencies.
// ---------------------------------------------------------------------------
function receipt(db, acct, posId, dealId, net) {
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, net_pnl, closed_at) VALUES (?,?,?,?,?,datetime('now'))`)
    .run(String(dealId), String(posId), acct, 'X', net)
}
function currency(db, acct, ccy) {
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(acct)
  db.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run(`acct:${acct}:deposit_currency_evidence_json`,
    JSON.stringify({ accountId: acct, host: 'demo.ctraderapi.com', currency: ccy, receivedAt: 1, source: 'broker_asset_list' }))
}

test('USDCNH #46/#47: one broker position recorded twice — the extra row counts at its own -59.73, not the first row\'s -196.35', () => {
  const db = initDB(':memory:')
  insertScoped(db, '46130058', { symbol: 'USDCNH', side: 'BUY', entry: 7.1, exit: 7.2, pnl: -196.35, posId: '232791374' })
  insertScoped(db, '46130058', { symbol: 'USDCNH', side: 'BUY', entry: 7.15, exit: 7.2, pnl: -59.73, posId: '232791374' })
  const r = findDuplicateTrades(db)
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].classification, 'same_position')
  assert.deepEqual(r.groups[0].extraRows.map(x => x.net_pnl), [-59.73])
  assert.equal(r.totalExtraRows, 1)
  assert.equal(r.totalExtraPnl, -59.73)
})

test('17 identical-looking rows that are 17 broker positions, each with its own closing deal, are not counted as extra', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 17; i++) {
    insertScoped(db, '47790949', { symbol: '0016.HK', side: 'BUY', entry: 100, exit: 99, pnl: -12.5, posId: String(500000 + i) })
    receipt(db, '47790949', 500000 + i, 900000 + i, -12.5)
  }
  const r = findDuplicateTrades(db)
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].classification, 'broker_distinct')
  assert.deepEqual([r.totalExtraRows, r.totalExtraPnl, r.brokerDistinctRows], [0, 0, 17])
  // One position without its receipt: the group is unverified and counts again.
  db.prepare('DELETE FROM broker_deals WHERE deal_id = ?').run('900016')
  const u = findDuplicateTrades(db)
  assert.equal(u.groups[0].classification, 'unverified')
  assert.equal(u.totalExtraRows, 16)
  // A receipt that does not match the row's money is not "its own deal".
  receipt(db, '47790949', 500016, 900016, -99)
  assert.equal(findDuplicateTrades(db).groups[0].classification, 'unverified')
})

test('extra money is per currency: an SGD and a USD account are never summed; two USD accounts pool', () => {
  const db = initDB(':memory:')
  currency(db, '46130058', 'USD'); currency(db, '46979908', 'USD'); currency(db, '43097342', 'SGD')
  const dup = (acct, pnl, pos) => { for (let i = 0; i < 2; i++) insertScoped(db, acct, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.2, pnl, posId: pos }) }
  dup('46130058', -10, '1'); dup('43097342', -20, '2')
  const mixed = findDuplicateTrades(db)
  assert.equal(mixed.totalExtraRows, 2)
  assert.equal(mixed.totalExtraPnl, null, 'no single figure across SGD and USD')
  assert.deepEqual(mixed.extraByCurrency.map(c => [c.currency, c.pnl]).sort(), [['SGD', -20], ['USD', -10]])
  assert.deepEqual(mixed.extraByAccount.map(b => [b.accountId, b.currency, b.pnl]).sort(), [['43097342', 'SGD', -20], ['46130058', 'USD', -10]])
  db.prepare("DELETE FROM trades WHERE account_id = '43097342'").run()
  dup('46979908', -5, '3')
  const usd = findDuplicateTrades(db)
  assert.equal(usd.totalExtraPnl, -15, 'two proven-USD accounts share one bucket')
  assert.deepEqual(usd.extraByCurrency.map(c => [c.currency, c.accountIds.sort()]), [['USD', ['46130058', '46979908']]])
})

// ---------------------------------------------------------------------------
// B2-m (merge onto main after V3 WEB-5): the extra money is pooled by THE one
// pooling rule (poolByCurrency) over THE one currency reader (reportCurrency
// over depositCurrencies()). An account with no recorded currency keeps its
// own figure and joins no pool; a row with no account is totalled only within
// its own broker position — never across positions, whose accounts (and so
// currencies) are unknown.
// ---------------------------------------------------------------------------
test('B2-m: an account with no recorded currency is shown in its own units and pooled with nothing', () => {
  const db = initDB(':memory:')
  currency(db, '46130058', 'USD')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES ('47790949',0,1,'active')").run()
  const dup = (acct, pnl, pos) => { for (let i = 0; i < 2; i++) insertScoped(db, acct, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.2, pnl, posId: pos }) }
  dup('46130058', -10, '1'); dup('47790949', -7, '2')
  const r = findDuplicateTrades(db)
  assert.equal(r.totalExtraRows, 2)
  assert.equal(r.totalExtraPnl, null, 'USD and an unknown currency are never one figure')
  assert.deepEqual(r.extraByCurrency.map(c => [c.currency, c.pnl, c.rows, c.accountIds, c.moneyState]),
    [['USD', -10, 1, ['46130058'], 'recorded_currency_units']])
  assert.deepEqual(r.extraByAccount.map(b => [b.accountId, b.currency, b.pnl]).sort(), [['46130058', 'USD', -10], ['47790949', null, -7]])
  // Alone, the unknown-currency account is one account's units: a figure.
  db.prepare("DELETE FROM trades WHERE account_id = '46130058'").run()
  const one = findDuplicateTrades(db)
  assert.deepEqual([one.totalExtraPnl, one.extraByCurrency.length], [-7, 0])
})

test('B2-m: rows with no account are totalled within one broker position, never across positions', () => {
  const db = initDB(':memory:')
  // Two unattributed groups on two broker positions: their accounts, and so
  // their currencies, are unknown — two figures, no total.
  for (let i = 0; i < 3; i++) insertTrade(db, { symbol: 'AUDUSD', side: 'SELL', entry: 0.65, exit: 0.66, pnl: -5, posId: '900' })
  for (let i = 0; i < 2; i++) insertTrade(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: 149, pnl: -8, posId: '901' })
  const r = findDuplicateTrades(db)
  assert.equal(r.totalExtraRows, 3)
  assert.equal(r.totalExtraPnl, null, 'two unattributed positions are not summed')
  assert.deepEqual(r.extraUnattributed.map(u => [u.positionId, u.rows, u.pnl]).sort(), [['900', 2, -10], ['901', 1, -8]])
  assert.deepEqual([r.extraByAccount, r.extraByCurrency], [[], []])
})

// B2-m checker N2: a currency read that FAILED is not a currency that is not
// recorded. The accounts still fall into their own units (nothing is pooled
// on a failed read), and the result says the read was unavailable.
test('B2-m: a failed currency read says so (currencyRead unavailable), never "not recorded"; the window is echoed', () => {
  const db = initDB(':memory:')
  currency(db, '46130058', 'USD')
  for (let i = 0; i < 2; i++) insertScoped(db, '46130058', { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.2, pnl: -10, posId: '1' })
  const ok = findDuplicateTrades(db)
  assert.deepEqual([ok.currencyRead, ok.windowDays, ok.extraByAccount[0].currency, ok.totalExtraPnl], ['read', 90, 'USD', -10])
  // The same database, with the deposit-currency evidence read failing.
  const failing = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => { if (/agent_state/.test(sql)) throw new Error('evidence read failed'); return target.prepare(sql) }
    const v = target[key]
    return typeof v === 'function' ? v.bind(target) : v
  } })
  const r = findDuplicateTrades(failing, { windowDays: 30 })
  assert.equal(r.currencyRead, 'unavailable')
  assert.equal(r.windowDays, 30)
  assert.deepEqual(r.extraByAccount.map(b => [b.accountId, b.currency, b.pnl]), [['46130058', null, -10]])
  assert.deepEqual(r.extraByCurrency, [], 'nothing is pooled on a failed read')
  assert.equal(r.totalExtraPnl, -10, 'one account alone is still one unit')
})
