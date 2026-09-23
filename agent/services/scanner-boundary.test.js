import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeFibSignal, findSwings } from './fib-strategy.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { NATIVE_DEFAULT_STRATEGIES, nativeOptionsFor, nativeProfileHash } from './scanner-profiles.js'
import { fxDayOpenMs, volumeStructure } from '../lib/volume-structure.js'
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('extracted scanners keep the reference algorithms and transport byte-identical', () => {
  for (const service of ['cpp-scan-tick', 'cpp-scan-timeframe']) {
    for (const file of ['json.hpp', 'http_server.hpp', 'http_server.cpp', 'log.hpp'])
      assert.equal(read(`${service}/src/${file}`), read(`cpp-exec/src/${file}`), `${service}/${file}`)
  }
  for (const file of ['tick_strategy.hpp', 'tick_strategy.cpp', 'tick_workers.hpp', 'tick_workers.cpp', 'spsc_ring.hpp'])
    assert.equal(read(`cpp-scan-tick/src/${file}`), read(`cpp-exec/src/${file}`), file)
  for (const file of ['backtest.hpp', 'backtest.cpp', 'vpo_indicators.hpp', 'vpo_indicators.cpp'])
    assert.equal(read(`cpp-scan-timeframe/src/${file}`), read(`cpp-exec/src/${file}`), file)
  assert.equal(read('cpp-scan-tick/src/scanner_contract.hpp'), read('cpp-scan-timeframe/src/scanner_contract.hpp'))
  for (const file of ['tick_momentum_fixture.json', 'tick_momentum_expected.json'])
    assert.equal(read(`cpp-scan-tick/src/tests/fixtures/${file}`), read(`cpp-exec/src/tests/fixtures/${file}`))
})

test('the frozen native timeframe fixture still agrees with the actual JavaScript strategy', () => {
  const fixtures = JSON.parse(read('cpp-scan-timeframe/src/tests/fixtures/fib-parity.json'))
  let long = 0, short = 0, noSignal = 0
  for (const { request, expected } of fixtures) {
    const actual = computeFibSignal(request.bars, request.timeframe, request.options)
    assert.deepEqual(actual, expected)
    if (actual?.bias === 'long') long++
    else if (actual?.bias === 'short') short++
    else noSignal++
  }
  assert.ok(long && short && noSignal, 'frozen coverage must include both directions and no-signal/warm-up outcomes')
})

test('all native default reference fixtures retain full current JavaScript outcomes and strict pivot boundaries', () => {
  const owners = Object.fromEntries(NATIVE_DEFAULT_STRATEGIES.map(key => [key, STRATEGY_REGISTRY.find(s => s.key === key).compute]))
  const coverage = {}
  for (const { request, expected, name } of JSON.parse(read('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json'))) {
    const actual = owners[request.strategy](request.bars, request.timeframe)
    assert.deepEqual(actual, expected, `${request.strategy}/${name}`)
    ;(coverage[request.strategy] ||= new Set()).add(actual?.bias || 'none')
  }
  for (const strategy of Object.keys(owners)) assert.deepEqual([...coverage[strategy]].sort(),
    strategy === 'cup_handle' ? ['long', 'none'] : strategy === 'inv_cup_handle' ? ['none', 'short'] : ['long', 'none', 'short'])
  for (const { bars, expected, name } of JSON.parse(read('cpp-scan-timeframe/src/tests/fixtures/pivots-parity.json')))
    assert.deepEqual(findSwings(bars), expected, name)
})

test('native calendar and volume structure fixtures retain the current JavaScript session contract', () => {
  const { calendar, structures } = JSON.parse(read('cpp-scan-timeframe/src/tests/fixtures/volume-parity.json'))
  for (const row of calendar) assert.equal(fxDayOpenMs(row.t), row.open)
  for (const row of structures) assert.deepEqual(volumeStructure(row.bars), row.expected, row.name)
})

test('frozen EMA option results retain the actual reference decisions and profile identity', () => {
  const compute = STRATEGY_REGISTRY.find(s => s.key === 'ema_pullback').compute
  for (const { request, referenceOptions, expected, name } of JSON.parse(read('cpp-scan-timeframe/src/tests/fixtures/ema-options-parity.json'))) {
    assert.deepEqual(compute(request.bars, request.timeframe, referenceOptions), expected, name)
    assert.deepEqual(nativeOptionsFor(request.strategy, referenceOptions), request.options, name)
    assert.equal(nativeProfileHash(request.strategy, request.options), request.profileHash, name)
  }
})
