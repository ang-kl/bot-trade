// agent/services/tick-research.test.js — P4: the trial ledger records
// every run once, keyed by its content, and the view groups by profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import { importTickTrial, tickTrialsView, trialIdFor } from './tick-research.js'
import { simulate } from '../lib/tick-replay-sim.js'
import { buildFixture } from '../lib/tick-strategy.test.js'

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
  assert.equal(v.trials.length, 1); assert.equal(v.trials[0].note, 'fixture'); assert.equal(v.trials[0].summary.trades, 2)
  assert.equal(v.profiles.length, 1); assert.equal(v.profiles[0].profileHash, r.profileHash)
  assert.match(v.note, /no profile here is approved/)
  // the route exists
  const state = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(state, /router\.get\('\/tick-research'/)
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(actions, /router\.post\('\/tick-trials'/)
})
