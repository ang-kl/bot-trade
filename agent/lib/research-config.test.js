// node --test agent/lib/research-config.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder)
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { loadResearchConfig, withOverrides, numberList, RESEARCH_CONFIG_FILE } from './research-config.js'

test('the values are READ FROM THE FILE: a different file gives different values; a missing file gives empty sections, never defaults', () => {
  const dir = tempDir('research-config-')
  const file = join(dir, 'research.json')
  writeFileSync(file, JSON.stringify({ exitReplay: { trailR: [0.25, 7], tpR: [4], followThroughR: [1.5], exitAtMeanPeriod: 50, maxDays: 30 },
    barForm: { timeBarsMs: [5000], tickBarsNominalMs: [120000], maxSilenceMs: 1000, pauseBetweenSegmentsMs: 0, maxSegmentsPerRun: 3, smallRun: { symbols: 1, days: 2 }, calibrationSegments: 2, computeWindowBars: 50, maxSymbolsPerRun: 3, designFloorMs: { rsi2_reversion: 3600000, 'bad key!': 1, ema_pullback: -5 } } }))
  const c = loadResearchConfig({ file })
  assert.equal(c.source, 'file')
  assert.deepEqual(c.exitReplay, { trailR: [0.25, 7], tpR: [4], followThroughR: [1.5], exitAtMeanPeriod: 50, maxDays: 30 })
  assert.deepEqual(c.barForm, { timeBarsMs: [5000], tickBarsNominalMs: [120000], maxSilenceMs: 1000, pauseBetweenSegmentsMs: 0, maxSegmentsPerRun: 3, smallRun: { symbols: 1, days: 2 }, calibrationSegments: 2, computeWindowBars: 50, maxSymbolsPerRun: 3, designFloorMs: { rsi2_reversion: 3600000 }, crossCheck: { closeTolerancePoints: null, ratioTolerance: null }, limits: { workerMemoryMb: null, maxRuntimeMs: null, maxTempBytes: null, maxCells: null, maxTransactionRows: null, maxPullsPerMinute: null, maxSkippedTicksDelta: null, maxBusyShare10m: null, pollMs: null } }, 'garbage floor entries dropped, never guessed; absent limits are null, never defaults')
  const none = loadResearchConfig({ file: join(dir, 'absent.json') })
  assert.equal(none.source, 'unavailable')
  assert.deepEqual(none.exitReplay, {}); assert.deepEqual(none.barForm, {})
})

test('the checked-in file loads with every section present and every list non-empty', () => {
  const c = loadResearchConfig()
  assert.equal(c.file, RESEARCH_CONFIG_FILE); assert.equal(c.source, 'file')
  for (const k of ['trailR', 'tpR', 'followThroughR']) assert.ok(c.exitReplay[k].length > 0, k)
  assert.ok(c.exitReplay.exitAtMeanPeriod > 0); assert.ok(c.exitReplay.maxDays > 0)
  for (const k of ['timeBarsMs', 'tickBarsNominalMs']) assert.ok(c.barForm[k].length > 0, k)
  assert.ok(c.barForm.timeBarsMs.includes(60000), 'the 1m baseline that mirrors the broker trendbar is present')
  assert.ok(c.barForm.maxSilenceMs > 0); assert.ok(c.barForm.pauseBetweenSegmentsMs >= 0); assert.ok(c.barForm.maxSegmentsPerRun > 0)
  assert.ok(c.barForm.smallRun.symbols > 0 && c.barForm.smallRun.days > 0)
})

test('garbage is dropped, never guessed: non-numbers, out-of-range, duplicates; lists are bounded', () => {
  assert.deepEqual(numberList(['x', -1, 0, 0.5, 0.5, 11, 2], { max: 10 }), [0.5, 2])
  assert.deepEqual(numberList(Array.from({ length: 20 }, (_, i) => i + 1), { max: 100, limit: 3 }), [1, 2, 3])
  assert.deepEqual(numberList('1,2'), [])
})

test('withOverrides applies validated request values over the file and names what changed', () => {
  const base = { trailR: [0.5], tpR: [1], exitAtMeanPeriod: 20 }
  const spec = { trailR: { list: true, max: 10 }, tpR: { list: true, max: 10 }, exitAtMeanPeriod: { int: true } }
  const r = withOverrides(base, { trailR: [2, 'bad'], exitAtMeanPeriod: '50', tpR: ['nope'] }, spec)
  assert.deepEqual(r.value, { trailR: [2], tpR: [1], exitAtMeanPeriod: 50 })
  assert.deepEqual(r.overridden, ['trailR', 'exitAtMeanPeriod'])
  const none = withOverrides(base, {}, spec)
  assert.deepEqual(none.value, base); assert.deepEqual(none.overridden, [])
})
