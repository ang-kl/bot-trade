// Statement seeding: real schema, real files, no source-matching.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from '../db.js'
import {
  parseStatement, statementTimeToIso, num, lots, loginFromFilename,
  resolveAccountId, importSeedStatements,
} from './statement-import.js'

const FIXTURE = `Deals
Deal ID,Order ID,Symbol,Opening Direction,Closing Direction,Opening time (UTC+8),Closing Time (UTC+8),Entry price,Closing price,Closing Quantity,Commissions,Pips,Net USD,Channel,Balance USD
DID315186380,356247791,JPM.US,Buy,Sell,20 Aug 2026 21:56:13.342,20 Aug 2026 21:57:53.488,356.21,354.88,13.8 Lots,-0.70,-13.3,-24.05,openapi_cbot-t,1 719.75
DID312541979,352891863,NatGas,Sell,Buy,04 Aug 2026 06:38:02.183,04 Aug 2026 06:38:46.405,2.788,2.799,9.54 Lots,0.00,-1.1,-1 049.40,openapi_cbot-t,48 921.88
DID314860345,355856014,0003.HK,Buy,Sell,19 Aug 2026 10:29:21.444,19 Aug 2026 13:14:51.334,7.305,7.205,1 428 Lots,-5.06,-10.0,-28.31,openapi_cbot-t,1 752.04
,,,,,,,,,,-66.56,,275.87,,

Positions
Created (UTC+8),Symbol,Quantity,Direction,Entry,TP,SL,Net USD
20 Aug 2026 09:34:21,2020.HK,152 Lots,Buy,74.410,76.493,73.957,—

Orders
Symbol,Direction,Submission Time (UTC+8),Order type,Current quantity,Submitted price,Distance,TP,SL
NatGas,Buy,27 Apr 2026 09:20:31.808,Limit,0.1 Lots,2.312,46.4,,2.147

Summary
Deposit,Withdrawal,Total net,Equity,Unr. P&L,Realised P&L,Margin,Free margin,Margin level
10 000.00,0.00,10 000.00,1 711.06,-8.69,275.87,366.62,1 344.44,467.46%
`

function realDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-'))
  const db = initDB(path.join(dir, 'agent.db'))
  return { db, dir, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('the export number format parses: space thousands, negatives, em-dash', () => {
  assert.equal(num('1 049.40'), 1049.4)
  assert.equal(num('-1 049.40'), -1049.4)
  assert.equal(num('48 921.88'), 48921.88)
  assert.equal(num('—'), null)
  assert.equal(num(''), null)
  assert.equal(lots('13.8 Lots'), 13.8)
  assert.equal(lots('1 428 Lots'), 1428)
})

test('UTC+8 statement times land on the correct UTC instant', () => {
  assert.equal(statementTimeToIso('20 Aug 2026 21:56:13.342'), '2026-08-20T13:56:13.342Z')
  // Before 08:00 SGT the UTC day is the PREVIOUS day — the off-by-one a naive
  // parse would ship.
  assert.equal(statementTimeToIso('04 Aug 2026 06:38:02.183'), '2026-08-03T22:38:02.183Z')
  assert.equal(statementTimeToIso('garbage'), null)
})

test('parsing takes only the Deals section and strips the DID prefix', () => {
  const rows = parseStatement(FIXTURE)
  assert.equal(rows.length, 3, 'three deals — footer, Positions, Orders and Summary are not deals')
  assert.deepEqual(rows.map((r) => r.deal_id), ['315186380', '312541979', '314860345'],
    'DID is stripped so the API import of the same fill collides instead of duplicating')
  const jpm = rows[0]
  assert.equal(jpm.symbol, 'JPM.US')
  assert.equal(jpm.side, 'BUY', 'Opening Direction is the POSITION side, matching broker_deals convention')
  assert.equal(jpm.net_pnl, -24.05)
  assert.equal(jpm.commission, -0.7)
  assert.equal(rows[1].net_pnl, -1049.4)
  assert.equal(rows[2].lots, 1428)
  for (const r of rows) {
    assert.equal(r.gross_pnl, null, 'the export does not break gross out — never derive it')
    assert.equal(r.position_id, null, 'exports carry order ids, which are not position ids')
  }
})

test('the login resolves through the accounts table, and unknown means refuse', () => {
  const { db, cleanup } = realDb()
  db.prepare(`INSERT INTO accounts (account_id, trader_login) VALUES ('46130058', '5306502')`).run()
  assert.equal(resolveAccountId(db, '5306502'), '46130058')
  assert.equal(resolveAccountId(db, '9999999'), null)
  cleanup()
})

test('loginFromFilename reads exactly the owner\'s naming scheme', () => {
  assert.equal(loginFromFilename('Acct_5306502__statement10_28_21.08.2026.csv'), '5306502')
  assert.equal(loginFromFilename('statement10_05_21.08.2026.csv'), null)
})

test('end to end: a seed directory imports, re-imports as a no-op, refuses unknowns', async () => {
  const { db, dir, cleanup } = realDb()
  db.prepare(`INSERT INTO accounts (account_id, trader_login) VALUES ('46130058', '5306502')`).run()
  const seed = path.join(dir, 'seed')
  fs.mkdirSync(seed)
  fs.writeFileSync(path.join(seed, 'Acct_5306502__statement10_28_21.08.2026.csv'), FIXTURE)
  fs.writeFileSync(path.join(seed, 'Acct_1111111__statement10_29_21.08.2026.csv'), FIXTURE)
  const quiet = { log() {}, warn() {} }

  const r1 = await importSeedStatements(db, seed, quiet)
  assert.equal(r1.imported, 3)
  assert.equal(r1.skipped, 1, 'the unmapped login refuses the whole file')
  const all = db.prepare('SELECT * FROM broker_deals ORDER BY deal_id').all()
  assert.equal(all.length, 3, 'the refused file contributed NOTHING — no NULL-account rows')
  assert.ok(all.every((d) => d.account_id === '46130058'))

  // Idempotent: same files again, same three rows.
  const r2 = await importSeedStatements(db, seed, quiet)
  assert.equal(r2.imported, 3)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM broker_deals').get().c, 3)
  cleanup()
})

test('a statement row and the API import of the same deal share one row', async () => {
  const { db, dir, cleanup } = realDb()
  db.prepare(`INSERT INTO accounts (account_id, trader_login) VALUES ('46130058', '5306502')`).run()
  const seed = path.join(dir, 'seed')
  fs.mkdirSync(seed)
  fs.writeFileSync(path.join(seed, 'Acct_5306502__s.csv'), FIXTURE)
  await importSeedStatements(db, seed, { log() {}, warn() {} })

  // The API path persists the same fill under its numeric id.
  const { persistDeals } = await import('./broker-history-import.js')
  persistDeals(db, [{
    deal_id: '315186380', position_id: '234', account_id: '46130058',
    symbol: 'JPM.US', side: 'BUY', lots: 13.8, entry_price: 356.21, close_price: 354.88,
    opened_at: '2026-08-20T13:56:13.342Z', closed_at: '2026-08-20T13:57:53.488Z',
    gross_pnl: -23.35, swap: 0, commission: -0.7, net_pnl: -24.05,
  }])
  assert.equal(db.prepare('SELECT COUNT(*) c FROM broker_deals').get().c, 3,
    'no fourth row: DID315186380 and 315186380 are the same deal')
  cleanup()
})

test('the committed seed files parse whole and carry the expected totals', () => {
  // The actual files that ship in the image — parsed, not assumed.
  const dir = new URL('../seed-statements/', import.meta.url)
  const cases = [
    { name: 'Acct_5203012__statement10_27_21.08.2026.csv', currency: 'USD' },
    { name: 'Acct_5268549__statement10_26_21.08.2026.csv', currency: 'USD' },
    { name: 'Acct_5306502__statement10_28_21.08.2026.csv', currency: 'USD' },
  ]
  for (const c of cases) {
    const text = fs.readFileSync(new URL(c.name, dir), 'utf8')
    const rows = parseStatement(text)
    assert.ok(rows.length > 0, `${c.name} parses at least one deal`)
    for (const r of rows) {
      assert.match(r.deal_id, /^\d+$/, 'every deal id is numeric after DID stripping')
      assert.ok(r.closed_at, 'every deal carries a close time')
      assert.notEqual(r.net_pnl, null, 'every deal carries its net money')
    }
    // The statement's own footer total must equal the sum of what we parsed —
    // the export checks our parser for us.
    const footer = text.split(/\r?\n/).find((l) => l.startsWith(',,,,'))
    const expected = num(footer.split(',')[12])
    const sum = Math.round(rows.reduce((a, r) => a + r.net_pnl, 0) * 100) / 100
    assert.equal(sum, expected, `${c.name}: parsed nets sum to the statement's own total`)
  }
})
