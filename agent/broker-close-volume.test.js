// node --test agent/broker-close-volume.test.js
//
// Production 2026-08-01 (Railway log): `Position close (LLM) FAILED: XRPUSD —
// closeVolume 1000000.00 is bigger than position volume 10000.00
// (TRADING_BAD_VOLUME)`, retried every loop, the position never closing. The
// close path recomputed volume from stored lots (reconciler contractSize
// convention) times the broker lotSize (a different convention) — 100× apart
// on adopted crypto rows. The rule under test: a close sends the volume the
// BROKER says it holds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { brokerPositionVolume } from './loop.js'

const POSITIONS = [
  { positionId: 111, tradeData: { volume: 10000 } },   // the XRPUSD shape
  { positionId: 222, tradeData: { volume: 2500 } },    // the ADAUSD shape
  { positionId: 333, tradeData: {} },                  // snapshot without volume
]

test('THE INCIDENT: broker volume wins — 10,000, not the 1,000,000 reconversion', () => {
  assert.equal(brokerPositionVolume(POSITIONS, 111), 10000)
  assert.equal(brokerPositionVolume(POSITIONS, 222), 2500)
})

test('string/number positionId mismatches still match', () => {
  assert.equal(brokerPositionVolume(POSITIONS, '111'), 10000)
  assert.equal(brokerPositionVolume([{ positionId: '444', tradeData: { volume: 7 } }], 444), 7)
})

test('null when the position is absent or carries no usable volume — caller falls back', () => {
  assert.equal(brokerPositionVolume(POSITIONS, 999), null)
  assert.equal(brokerPositionVolume(POSITIONS, 333), null)
  assert.equal(brokerPositionVolume([], 111), null)
  assert.equal(brokerPositionVolume(null, 111), null)
  assert.equal(brokerPositionVolume([{ positionId: 1, tradeData: { volume: 0 } }], 1), null)
  assert.equal(brokerPositionVolume([{ positionId: 1, tradeData: { volume: -5 } }], 1), null)
})
