import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { recordDepositCurrency } from './account-money.js'
import { strategyRollingEdge, runEdgeWatchdog } from './edge-watchdog.js'
import { setStage, armedTradeKeys } from './stage-matrix.js'

const strategy = 'rsi_meanrev'
const io = { getState, setState }
function account(db, id, currency, live = false) {
  upsertAccount(db, { accountId: id, isLive: live })
  db.prepare('UPDATE accounts SET enabled=1 WHERE account_id=?').run(id)
  if (currency) recordDepositCurrency(db, { accountId: id,
    host: live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
    depositAssetId: '1', currency, receivedAt: Date.parse('2026-10-06T00:00:00Z') })
}
function close(db, id, net, at = '2026-10-06T01:00:00Z') {
  return db.prepare(`INSERT INTO trades
    (symbol,side,status,label_strategy,net_pnl,account_id,closed_at,entry_price,sl_price,tp_price)
    VALUES ('EURUSD','BUY','closed',?,?,?,?,100,99,102)`)
    .run(strategy, net, id, at).lastInsertRowid
}
function arm(db, id = null) {
  if (id) setStage(db, { kind: 'strategy', key: strategy, stage: 'trade', on: true, accountId: id }, io)
  else setState(db, 'enabled_strategies_json', JSON.stringify([strategy]))
}
function armed(db, id = null) { return armedTradeKeys(db, getState, id).has(strategy) }

for (const [firstCurrency, firstPnl, secondCurrency, secondPnl] of [
  ['USD', 100, 'SGD', -110], ['SGD', 110, 'USD', -100],
]) test(`mixed ${firstCurrency}/${secondCurrency} amounts cannot disarm globally; counts and banded win rates remain usable`, () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', firstCurrency); account(db, '1002', secondCurrency)
    arm(db); setState(db, 'autotrade_enabled', '1')
    for (let i = 0; i < 10; i++) { close(db, '1001', firstPnl); close(db, '1002', secondPnl) }
    const before = db.prepare('SELECT * FROM trades ORDER BY id').all()
    const edge = strategyRollingEdge(db, strategy, 20)
    assert.equal(edge.trades, 20); assert.equal(edge.winRate, 50)
    assert.equal(edge.moneyReason, 'mixed_currencies')
    assert.equal(edge.net, null); assert.equal(edge.expectancy, null); assert.equal(edge.profitFactor, null)
    const band = strategyRollingEdge(db, strategy, 20, { rrBand: { below: 3 } })
    assert.equal(band.trades, 20); assert.equal(band.winRate, 50)
    const out = runEdgeWatchdog(db)
    assert.equal(out.actions.length, 0); assert.equal(armed(db), true)
    assert.equal(getState(db, `edge_watchdog_acted_${strategy}`), null)
    assert.equal(getState(db, 'autotrade_enabled'), '1')
    assert.deepEqual(db.prepare('SELECT * FROM trades ORDER BY id').all(), before)
  } finally { db.close() }
})

for (const currency of ['USD', 'SGD']) test(`known homogeneous ${currency} retains thresholds, global scope, dedupe and labelled evidence`, () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', currency); account(db, '1002', currency); account(db, '1003', currency === 'USD' ? 'SGD' : 'USD')
    close(db, '1003', -10000, '2026-10-01T00:00:00Z')
    arm(db)
    for (let i = 0; i < 20; i++) close(db, i < 10 ? '1001' : '1002', i < 10 ? 10 : -12)
    setState(db, 'edge_watchdog_json', JSON.stringify({ window: 20, minTrades: 20, pfFloor: 0.8 }))
    assert.equal(runEdgeWatchdog(db).actions.length, 0, 'PF .83 remains above unchanged floor .8')
    setState(db, 'edge_watchdog_json', JSON.stringify({ window: 20, minTrades: 20, pfFloor: 0.95 }))
    const notes = []; const out = runEdgeWatchdog(db, { notify: message => notes.push(message) })
    assert.equal(out.actions.length, 1); assert.equal(armed(db), false)
    assert.equal(out.actions[0].currency, currency); assert.equal(out.actions[0].net, -20)
    assert.equal(out.actions[0].profitFactor, 0.83); assert.match(notes[0], new RegExp(currency))
    const audit = db.prepare("SELECT evidence_json FROM arming_log WHERE actor='edge_watchdog' AND decision='set' LIMIT 1").get()
    assert.equal(JSON.parse(audit.evidence_json).currency, currency)
    arm(db); assert.equal(runEdgeWatchdog(db).actions.length, 0, 'same newest close does not consume another disarm')
    assert.equal(armed(db), true)
  } finally { db.close() }
})

for (const [name, id, corrupt] of [
  ['legacy unstamped', null, null], ['missing currency', '1001', null],
  ['wrong host', '1001', ev => { ev.host = 'live.ctraderapi.com' }],
  ['wrong account', '1001', ev => { ev.accountId = '1002' }],
]) test(`${name} cannot make a monetary disarm or consume dedupe`, () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', corrupt ? 'USD' : null); arm(db)
    if (corrupt) {
      const key = 'acct:1001:deposit_currency_evidence_json'; const ev = JSON.parse(getState(db, key))
      corrupt(ev); setState(db, key, JSON.stringify(ev))
    }
    for (let i = 0; i < 20; i++) close(db, id, -10)
    const out = runEdgeWatchdog(db)
    assert.equal(out.actions.length, 0); assert.equal(armed(db), true)
    assert.equal(out.evaluated[0].moneyReason, 'unverified_currency')
    assert.equal(out.evaluated[0].trades, 20); assert.equal(out.evaluated[0].winRate, 0)
    assert.equal(getState(db, `edge_watchdog_acted_${strategy}`), null)
  } finally { db.close() }
})

test('late valid currency makes the same sample judgeable without consuming its earlier unavailable verdict', () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', null); arm(db)
    for (let i = 0; i < 20; i++) close(db, '1001', -10)
    const initial = runEdgeWatchdog(db)
    assert.equal(initial.actions.length, 0)
    account(db, '1001', 'SGD')
    const valid = runEdgeWatchdog(db)
    assert.equal(valid.actions.length, 1)
    assert.equal(valid.evaluated[0].newestId, initial.evaluated[0].newestId)
    assert.equal(valid.actions[0].currency, 'SGD')
  } finally { db.close() }
})

for (const live of [false, true]) test(`mixed pool retains exact own-account loss protection and profitable pins (${live ? 'live' : 'demo'})`, () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', 'USD', live); account(db, '1002', 'SGD', !live); account(db, '1003', null)
    arm(db); arm(db, '1001'); arm(db, '1002'); arm(db, '1003')
    for (let i = 0; i < 20; i++) close(db, '1001', -10)
    for (let i = 0; i < 20; i++) close(db, '1002', 20)
    for (let i = 0; i < 20; i++) close(db, '1003', -1000)
    // The last global 20 include each owner; ownOnly uses its own unchanged last 20.
    for (let i = 0; i < 7; i++) { close(db, '1001', -10); close(db, '1002', 20); close(db, '1003', -1000) }
    const out = runEdgeWatchdog(db)
    assert.equal(out.actions.length, 1); assert.deepEqual(out.actions[0].scopes, ['1001'])
    assert.equal(out.actions[0].currency, 'USD'); assert.equal(out.actions[0].accountId, '1001')
    assert.equal(out.actions[0].trades, 20); assert.equal(out.actions[0].net, -200)
    assert.equal(armed(db, '1001'), false); assert.equal(armed(db, '1002'), true); assert.equal(armed(db, '1003'), true)
    assert.equal(armed(db), true, 'unjudgeable pooled units never retire the global or inheriting cell')
    assert.equal(getState(db, `edge_watchdog_acted_${strategy}`), null)
    arm(db, '1001'); assert.equal(runEdgeWatchdog(db).actions.length, 0, 'own newest close is deduped')
    close(db, '1001', -10, '2026-10-06T02:00:00Z')
    assert.equal(runEdgeWatchdog(db).actions.length, 1, 'new own close is evaluated even with unavailable pooled money')
  } finally { db.close() }
})

test('ownOnly excludes legacy currency gaps; all-positive PF stays undefined and scratches remain non-wins', () => {
  const db = initDB(':memory:')
  try {
    account(db, '1001', 'USD')
    close(db, '1001', 10); close(db, '1001', 0); close(db, null, -100)
    const own = strategyRollingEdge(db, strategy, 20, { accountId: '1001', ownOnly: true })
    assert.equal(own.currency, 'USD'); assert.equal(own.net, 10); assert.equal(own.winRate, 50)
    assert.equal(own.profitFactor, null)
    const legacy = strategyRollingEdge(db, strategy, 20, { accountId: '1001' })
    assert.equal(legacy.trades, 3); assert.equal(legacy.winRate, 33)
    assert.equal(legacy.moneyReason, 'unverified_currency'); assert.equal(legacy.net, null)
  } finally { db.close() }
})

test('a verified mixed pool disarms only each eligible losing owner, never global, profitable or disabled owners', () => {
  const db = initDB(':memory:')
  try {
    for (const [id, unit] of [['1001', 'USD'], ['1002', 'SGD'], ['1003', 'SGD'], ['1004', 'USD']]) {
      account(db, id, unit); arm(db, id)
    }
    arm(db); db.prepare('UPDATE accounts SET enabled=0 WHERE account_id=?').run('1004')
    for (let i = 0; i < 20; i++) {
      close(db, '1001', -10); close(db, '1002', -20); close(db, '1003', 100); close(db, '1004', -1000)
    }
    const out = runEdgeWatchdog(db)
    assert.equal(out.evaluated[0].moneyReason, 'mixed_currencies')
    assert.equal(out.actions.length, 2)
    assert.deepEqual(out.actions.map(a => [a.accountId, a.currency, a.scopes]), [
      ['1001', 'USD', ['1001']], ['1002', 'SGD', ['1002']],
    ])
    assert.equal(armed(db), true); assert.equal(armed(db, '1003'), true); assert.equal(armed(db, '1004'), true)
    arm(db, '1001'); arm(db, '1002')
    assert.equal(runEdgeWatchdog(db).actions.length, 0, 'each owner has its own newest-close dedupe')
    close(db, '1002', -20, '2026-10-06T03:00:00Z')
    assert.deepEqual(runEdgeWatchdog(db).actions.map(a => a.scopes), [['1002']])
  } finally { db.close() }
})
