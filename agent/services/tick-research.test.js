// agent/services/tick-research.test.js — P4: the trial ledger records
// every run once, keyed by its content, and the view groups by profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import { importTickTrial, tickTrialsView, trialIdFor } from './tick-research.js'
import { simulate } from '../lib/tick-replay-sim.js'
import { buildFixture } from '../lib/tick-strategy.test.js'
import { profileHash, profileHashFull, normalizeParams } from '../lib/tick-strategy.js'

test('a replay result imports once, the same run again is ignored, the view groups by profile', () => {
  const db = initDB(':memory:')
  const r = simulate(buildFixture(), { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, { latencyMs: 60, minTargetToCost: 1 })
  const trial = { ...r, manifest: { files: ['fixture'], events: r.events, decoderVersion: 1 } }
  const a = importTickTrial(db, trial, { note: 'fixture' })
  assert.equal(a.ok, true); assert.equal(a.inserted, true); assert.equal(a.trialId, trialIdFor(trial))
  const b = importTickTrial(db, trial)
  assert.equal(b.inserted, false, 'same content, same id, not duplicated')
  assert.equal(importTickTrial(db, { ...trial, summary: undefined }).ok, false)
  const v = tickTrialsView(db)
  // PR-Q1: withheld, the fixture's two trades both exit inside the test block,
  // so the stored summary is 0 (it read 2 — the test period by subtraction).
  assert.equal(v.trials.length, 1); assert.equal(v.trials[0].note, 'fixture'); assert.equal(v.trials[0].summary.trades, 0)
  assert.equal(v.trials[0].summaryScope, 'train_validation'); assert.equal(v.trials[0].testConsulted, false)
  assert.equal(v.profiles.length, 1); assert.equal(v.profiles[0].profileHash, r.profileHash)
  assert.match(v.note, /no profile here is approved/)
  // the route exists
  const state = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(state, /router\.get\('\/tick-research'/)
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(actions, /router\.post\('\/tick-trials'/)
})

// PR-Q1: the GET showed 200 of 636 rows and never the v1 grid point; the
// stored rows predate the leak fix and printed a summary over the test block.
test('PR-Q1: ?profile= returns that profile\'s rows (limit all), pre-v2 rows read as CONSULTED, and the ledger counts every row whatever the page', () => {
  const db = initDB(':memory:')
  const v1 = normalizeParams({}) // the running profile: N 256 / E 0.40
  const other = normalizeParams({ rangeEvents: 1024, minEfficiency: 0.55 })
  const legacy = (params, i) => importTickTrial(db, { strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: profileHash(params), params, sim: { latencyMs: 250, statisticsVersion: 'mtm-moving-block-v1' }, manifest: { files: ['seg-a', 'seg-b'], symbolId: i }, summary: { trades: 1 }, blocks: [{ name: 'train', trades: 1 }, { name: 'validation', trades: 0 }, { name: 'test', withheld: true, trades: null }] })
  for (let i = 0; i < 5; i++) legacy(v1, i)
  for (let i = 0; i < 7; i++) legacy(other, i)
  const r = simulate(buildFixture(), { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, { latencyMs: 60, minTargetToCost: 1 })
  importTickTrial(db, { ...r, manifest: { files: ['fixture'], events: r.events, decoderVersion: 1 } })
  const page = tickTrialsView(db, { limit: 2 })
  assert.equal(page.trials.length, 2); assert.equal(page.ledger.totalTrials, 13, 'the ledger is every row, not the page')
  const v1Hash = profileHash(v1)
  const led = page.ledger.profiles.find(p => p.profileHash === v1Hash)
  assert.equal(led.trials, 5); assert.equal(led.legacyConsultedTrials, 5); assert.equal(led.consulted, true); assert.equal(led.byOrigin.unrecorded, 5)
  assert.equal(page.ledger.profiles.find(p => p.profileHash === r.profileHash).consulted, false, 'a v2 withheld trial has not consulted its test block')
  const only = tickTrialsView(db, { profile: v1Hash, limit: 'all' })
  assert.equal(only.trials.length, 5); assert.ok(only.trials.every(t => t.profileHash === v1Hash))
  assert.ok(only.trials.every(t => t.summaryScope === 'all_blocks_legacy_leak' && t.testConsulted === true && t.origin.kind === 'unrecorded' && t.parityRecorded === false))
  assert.equal(only.ledger.totalTrials, 5)
  assert.equal(tickTrialsView(db, { profile: profileHashFull(v1) }).trials.length, 5, 'the 64-hex hash filters too')
  assert.equal(tickTrialsView(db, { profile: 'nothex' }).error, 'bad_profile')
})
