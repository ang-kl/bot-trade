import test from 'node:test'
import assert from 'node:assert/strict'
import { automaticProducerAvailability } from './automatic-producer-availability.js'

const producer = (id, retired) => ({ id, family: 'automatic', basis: 'bar', ...(retired ? { retired } : {}) })
const retired = '2026-09-20 owner order: intraday retired'
const inventory = [producer('scan_dispatch', retired), producer('daily_momentum_account'), producer('cross_sectional_book')]

test('ordinary families report the actual producer retirement, not a new switch', () => {
  for (const family of ['mean_reversion', 'trend', 'breakout']) {
    const r = automaticProducerAvailability(family, inventory)
    assert.equal(r.available, false)
    assert.equal(r.state, 'retired')
    assert.match(r.reason, /scan_dispatch: 2026-09-20/)
    assert.deepEqual(r.producers.map(p => p.id), ['scan_dispatch'])
  }
})

test('active momentum producers are separate from retired ordinary scanning', () => {
  const r = automaticProducerAvailability('momentum', inventory)
  assert.equal(r.available, true)
  assert.equal(r.state, 'available')
  assert.equal(r.reason, null)
  assert.deepEqual(r.producers.map(p => p.id), ['daily_momentum_account', 'cross_sectional_book'])
  assert.equal(r.scope, 'automatic_bar_producers')
})

test('a future authorised producer change is read from inventory, not a copied date flag', () => {
  const r = automaticProducerAvailability('trend', [producer('scan_dispatch')])
  assert.equal(r.available, true)
  assert.equal(r.state, 'available')
})

test('momentum remains available through a known surviving producer', () => {
  const source = [producer('daily_momentum_account', 'retired daily'), producer('cross_sectional_book')]
  assert.equal(automaticProducerAvailability('momentum', source).available, true)
  source[1].retired = 'retired book'
  const r = automaticProducerAvailability('momentum', source)
  assert.equal(r.state, 'retired')
  assert.match(r.reason, /retired daily/)
  assert.match(r.reason, /retired book/)
})

test('missing, malformed or duplicate inventory must not report readiness', () => {
  for (const source of [null, [], [producer('daily_momentum_account')],
    [producer('daily_momentum_account'), producer('cross_sectional_book'), producer('cross_sectional_book')]]) {
    const r = automaticProducerAvailability('momentum', source)
    assert.equal(r.state, 'unknown')
    assert.equal(r.available, false)
  }
})

test('unknown and inherited-property family names cannot acquire a producer', () => {
  for (const family of ['new_family', 'toString', '__proto__', null, undefined]) {
    const r = automaticProducerAvailability(family, inventory)
    assert.equal(r.available, false)
    assert.equal(r.state, 'unknown')
  }
})

test('manual or tick producers do not prove an automatic bar path exists', () => {
  const source = [{ id: 'scan_dispatch', family: 'manual', basis: 'bar' },
    { id: 'scan_dispatch', family: 'automatic', basis: 'tick' }]
  assert.equal(automaticProducerAvailability('trend', source).state, 'unknown')
})

test('reading availability does not mutate the producer inventory', () => {
  const copy = structuredClone(inventory)
  for (const family of ['mean_reversion', 'trend', 'breakout', 'momentum']) automaticProducerAvailability(family, inventory)
  assert.deepEqual(inventory, copy)
})
