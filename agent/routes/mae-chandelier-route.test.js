// node --test agent/routes/mae-chandelier-route.test.js — GET /state/mae-chandelier
// reads the observer's own record (02-10-2026, № 10,474): the readings every
// monitor tick writes and the amend receipts, with counts a reader can act
// on. An empty key answers an empty record, never a 500.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { OBSERVE_STATE_KEY } from '../services/mae-chandelier-observe.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('GET /state/mae-chandelier: empty key → empty record', async () => {
  const s = await server()
  try {
    const r = await fetch(s.url('/state/mae-chandelier'))
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.deepEqual(body.positions, {})
    assert.deepEqual(body.receipts, [])
    assert.equal(body.summary.positions, 0)
    assert.equal(body.summary.receiptsSent, 0)
  } finally { s.close() }
})

test('GET /state/mae-chandelier: counts readings with and without bars, adjustable rows and sent receipts', async () => {
  const s = await server()
  try {
    setState(s.db, OBSERVE_STATE_KEY, JSON.stringify({
      mode: 'observe_and_tighten', at: '2026-10-02T01:00:00.000Z', mayAmend: false,
      positions: {
        1: { id: '1', symbol: 'EURUSD', atr: 0.001, chandelierSinceEntry: 1.1175, mayAmend: true, mae: 0.2, mfe: 1.1 },
        2: { id: '2', symbol: 'XAUUSD', atr: null, chandelierSinceEntry: null, mayAmend: false, mae: 0, mfe: 0 },
        3: { id: '3', symbol: 'BTCUSD', atr: 120, chandelierSinceEntry: 61000, mayAmend: false, mae: 0.1, mfe: 0.4 },
      },
      receipts: [
        { id: '1', sl: 1.1175, sent: true, confirmed: true, broker: 'SL → 1.11750', at: '2026-10-02T01:00:03.000Z' },
        { id: '3', sl: 61000, sent: false, broker: 'INVALID_REQUEST', at: '2026-10-02T01:00:05.000Z' },
        { id: '1', sl: 1.1176, sent: false, unchanged: true, broker: 'SL kept 1.11800 (broker already tighter than 1.11760)', at: '2026-10-02T01:00:07.000Z' },
      ],
    }))
    const body = await fetch(s.url('/state/mae-chandelier')).then(r => r.json())
    assert.equal(body.mode, 'observe_and_tighten')
    assert.deepEqual(body.summary, {
      positions: 3, withBars: 2, withoutBars: 1, adjustable: 1, quoteMissingMarketOpen: 0, entryTimeUnknown: 0,
      receipts: 3, receiptsSent: 1, receiptsConfirmed: 1, receiptsUnchanged: 1, lastReceiptAt: '2026-10-02T01:00:07.000Z',
    })
    assert.equal(body.positions['2'].atr, null, 'a reading with no bars is shown as such, not hidden')
  } finally { s.close() }
})
