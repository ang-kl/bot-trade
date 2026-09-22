import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeFibSignal } from './fib-strategy.js'
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
