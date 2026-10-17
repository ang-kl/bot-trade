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

// Claude · № 15,375 17-Oct (owner: "Build #84, merge when green"; claude-builder).
// #84 moved the time cap to its real expiry, so the three cap rules' golden
// entries were regenerated. Every other rule must stay exactly as it was
// before #84: this hash is of their pre-#84 entries (main c0c77adc).
test('#84: every rule without a time cap keeps its pre-#84 golden entry byte-for-byte', async () => {
  const { createHash } = await import('node:crypto')
  const keep = Object.keys(GOLDEN.rules).filter(k => !['cap_30m', 'cap_120m', 'tp_1R_cap_30m'].includes(k))
  assert.equal(keep.length, 7)
  const h = createHash('sha256').update(JSON.stringify(keep.map(k => [k, GOLDEN.rules[k]]))).digest('hex')
  assert.equal(h, 'a059dc7ed20503cf73c9ceca0ed5a9a811b62ef17891f966d1b823383f0a365f')
})
