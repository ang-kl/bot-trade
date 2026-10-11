// node --test agent/lib/exit-replay-golden.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder). The legacy
// rules replay byte-for-byte as before the additive rules landed: the golden
// was generated from the UNMODIFIED module (main ca53199b) over a seeded
// synthetic population of 16 trades, 10 rules (DEFAULT_RULES + two trails).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { replayExit, summariseReplay, DEFAULT_RULES } from './exit-replay.js'

const GOLDEN = JSON.parse(readFileSync(new URL('./golden/exit-replay.golden.json', import.meta.url), 'utf8'))

test('every legacy rule reproduces the golden exactly (results and summary)', () => {
  const rules = [...DEFAULT_RULES, { name: 'trail_0.5R', trailR: 0.5 }, { name: 'trail_2R', trailR: 2 }]
  assert.deepEqual(rules.map(r => r.name), Object.keys(GOLDEN.rules), 'the rule set is the golden\'s')
  for (const rule of rules) {
    const res = GOLDEN.trades.map((t, i) => replayExit(GOLDEN.bars[i], t, rule))
    assert.deepEqual(res, GOLDEN.rules[rule.name].results, `results differ for ${rule.name}`)
    assert.deepEqual(summariseReplay(res), GOLDEN.rules[rule.name].summary, `summary differs for ${rule.name}`)
  }
})

test('the golden population exercises stops, targets, moved stops, time caps and truncation', () => {
  const reasons = new Set(); let trunc = 0
  for (const r of Object.values(GOLDEN.rules)) { for (const k of Object.keys(r.summary.byReason)) reasons.add(k); trunc += r.summary.truncated }
  for (const k of ['stop', 'target', 'stop_moved', 'time_cap']) assert.ok(reasons.has(k), k)
  assert.ok(trunc > 0)
})
