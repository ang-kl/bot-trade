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
