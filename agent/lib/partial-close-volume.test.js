// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// Source: cTrader takes a close volume in protocol units that must be a
// multiple of the symbol's stepVolume and at least its minVolume (the symbol
// record the route already reads with getVolumeMeta). The route used to send
// round(lots × lotSize), which the broker refuses off-step.
import test from 'node:test'
import assert from 'node:assert/strict'
import { partialCloseVolume } from './partial-close-volume.js'

const meta = { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000 } // 0.01-lot step and minimum

test('no lots: the whole position', () => {
  assert.deepEqual(partialCloseVolume({ positionVolume: 47_000_000, lots: null, meta }), { volume: 47_000_000, lots: 4.7, partial: false, error: null })
})

test('lots below the position: stepped DOWN to the symbol step', () => {
  assert.deepEqual(partialCloseVolume({ positionVolume: 47_000_000, lots: 2.345, meta }), { volume: 23_400_000, lots: 2.34, partial: true, error: null }, 'lots is what the volume closes, not what was typed')
})

test('lots at or above the position: the whole position', () => {
  assert.deepEqual(partialCloseVolume({ positionVolume: 47_000_000, lots: 4.7, meta }), { volume: 47_000_000, lots: 4.7, partial: false, error: null })
  assert.equal(partialCloseVolume({ positionVolume: 47_000_000, lots: 99, meta }).partial, false)
})

test('below the symbol minimum after stepping: refused with the minimum named', () => {
  const r = partialCloseVolume({ positionVolume: 47_000_000, lots: 0.004, meta })
  assert.equal(r.volume, null)
  assert.match(r.error, /minimum/)
})

test('no step on record: the rounded volume is sent, as before', () => {
  assert.deepEqual(partialCloseVolume({ positionVolume: 47_000_000, lots: 2.345, meta: { lotSize: 10_000_000 } }), { volume: 23_450_000, lots: 2.345, partial: true, error: null })
})

test('on-step but below a larger symbol minimum: refused, the minimum in lots named', () => {
  const r = partialCloseVolume({ positionVolume: 47_000_000, lots: 0.05, meta: { lotSize: 10_000_000, minVolume: 1_000_000, stepVolume: 100_000 } })
  assert.equal(r.volume, null)
  assert.match(r.error, /minimum \(0\.1 lots\)/)
})

// Codex P1 on #1354 (owner: "Both"): the real close refuses an off-step figure
// instead of rounding it; the preview (strict off) answers the stepped figure.
test('strict (the real close): off-step lots refused, the two valid figures named; on-step sent as typed', () => {
  const r = partialCloseVolume({ positionVolume: 47_000_000, lots: 2.345, meta, strict: true })
  assert.equal(r.volume, null)
  assert.match(r.error, /step of 0\.01 lots: 2\.34 or 2\.35/)
  assert.deepEqual(partialCloseVolume({ positionVolume: 47_000_000, lots: 2.34, meta, strict: true }), { volume: 23_400_000, lots: 2.34, partial: true, error: null })
  // a larger step (0.1 lot): 1.25 lies between 1.2 and 1.3
  assert.match(partialCloseVolume({ positionVolume: 47_000_000, lots: 1.25, meta: { lotSize: 10_000_000, minVolume: 1_000_000, stepVolume: 1_000_000 }, strict: true }).error, /0\.1 lots: 1\.2 or 1\.3/)
  // at or above the position stays the whole position, step or not
  assert.equal(partialCloseVolume({ positionVolume: 47_000_000, lots: 9.999, meta, strict: true }).partial, false)
})
