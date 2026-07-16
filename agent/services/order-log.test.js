// node --test agent/services/order-log.test.js
//
// The Order log (Trade page) is backed by risk_events; every attempt row
// must carry its provenance in proposal_json.source so the UI can label
// TEST FILL / MANUAL / AUTO / PENDING. These tests pin the round-trip.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { persistRiskEvent } from './risk.js'

test('persistRiskEvent round-trips the source tag through proposal_json', () => {
  const db = initDB(':memory:')
  persistRiskEvent(
    db,
    { symbol: 'EURUSD', side: 'BUY', requestedVolume: 0.01, source: 'validation_fill' },
    { approved: false, veto_reason: 'no_live_quote: market closed or price feed unavailable' }
  )
  const row = db.prepare(
    `SELECT symbol, side, approved, veto_reason,
            json_extract(proposal_json, '$.source') AS source
       FROM risk_events ORDER BY id DESC LIMIT 1`
  ).get()
  assert.equal(row.symbol, 'EURUSD')
  assert.equal(row.approved, 0)
  assert.equal(row.source, 'validation_fill')
  assert.match(row.veto_reason, /no_live_quote/)
})

test('rows without a source stay readable (legacy) — source is simply null', () => {
  const db = initDB(':memory:')
  persistRiskEvent(db, { symbol: 'US30', side: 'SELL', requestedVolume: 0.01 }, { approved: true })
  const row = db.prepare(
    `SELECT approved, json_extract(proposal_json, '$.source') AS source
       FROM risk_events ORDER BY id DESC LIMIT 1`
  ).get()
  assert.equal(row.approved, 1)
  assert.equal(row.source, null)
})
