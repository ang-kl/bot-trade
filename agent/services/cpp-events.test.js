// agent/services/cpp-events.test.js — P2b-1: the sidecar's execution-event
// journal is pulled into cpp_events with the same cursor contract as the
// decision ring, and an older sidecar (no /events) is simply not told.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, getState } from '../db.js'
import { pullEventsIntoDb } from './heartbeat.js'

test('pullEventsIntoDb inserts idempotently, advances the cursor per side, and restarts the cursor on a new boot', async () => {
  const db = initDB(':memory:')
  const entries = [
    { seq: 1, tsMs: 10, clientMsgId: 'cx1', payloadType: 2126, executionType: 'ORDER_ACCEPTED', orderId: 5, positionId: 0, accountId: 4002, symbolId: 41, errorCode: '', label: 'AU|v1|X|H|LN|4h|TR|iabc', solicited: true },
    { seq: 2, tsMs: 11, clientMsgId: '', payloadType: 2126, executionType: 'ORDER_FILLED', orderId: 5, positionId: 9, accountId: 4002, symbolId: 41, errorCode: '', label: 'AU|v1|X|H|LN|4h|TR|iabc', solicited: false },
  ]
  const calls = []
  const exec = { pullSidecarEvents: async (o) => { calls.push(o); return { bootId: 'b1', latestSeq: 2, entries } } }
  const side = { name: 'cpp_exec_demo', base: 'http://demo' }
  const r1 = await pullEventsIntoDb(db, exec, side, { bootId: 'b1' })
  assert.equal(r1.inserted, 2)
  assert.deepEqual(calls[0], { after: 0, bootId: '', base: 'http://demo' })
  const rows = db.prepare(`SELECT client_msg_id, execution_type, order_id, position_id, label, solicited FROM cpp_events ORDER BY seq`).all()
  assert.deepEqual(rows[0], { client_msg_id: 'cx1', execution_type: 'ORDER_ACCEPTED', order_id: '5', position_id: null, label: 'AU|v1|X|H|LN|4h|TR|iabc', solicited: 1 })
  assert.deepEqual(rows[1], { client_msg_id: null, execution_type: 'ORDER_FILLED', order_id: '5', position_id: '9', label: 'AU|v1|X|H|LN|4h|TR|iabc', solicited: 0 })
  assert.deepEqual(JSON.parse(getState(db, 'cpp_events_cursor_json')), { cpp_exec_demo: { bootId: 'b1', lastSeq: 2 } })
  const r2 = await pullEventsIntoDb(db, exec, side, { bootId: 'b1' })
  assert.equal(r2.inserted, 0, 'idempotent on the same entries')
  assert.deepEqual(calls[1], { after: 2, bootId: 'b1', base: 'http://demo' })
  await pullEventsIntoDb(db, exec, side, { bootId: 'b2' })
  assert.equal(calls[2].after, 0, 'a new boot restarts the cursor')
  assert.equal(await pullEventsIntoDb(db, { }, side, { bootId: 'b1' }), undefined, 'an exec without the pull is left alone')
  assert.equal(await pullEventsIntoDb(db, { pullSidecarEvents: async () => null }, side, { bootId: 'b1' }), undefined, 'an older sidecar is not told')
})
