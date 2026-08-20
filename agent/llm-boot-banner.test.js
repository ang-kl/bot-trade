// The boot line reporting the LLM kill switch.
//
// Why this exists: the pre-existing line reports the KEY, not the switch. On
// 20-08-2026 the owner set LLM_DISABLED=1 and the boot said "key set" and
// nothing more — a deliberately disabled agent looked, in the log, exactly
// like one about to spend on every monitor pass. Silence about a deliberate
// state is the defect this codebase keeps paying for.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { llmDisabledFrom, llmDisabledReason } from './lib/llm-switch.js'

const src = () => fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

test('boot reports the switch through the SAME functions the call sites use', () => {
  // Not a re-implementation: a banner computed a second way could disagree
  // with the guards, which is worse than no banner at all.
  const s = src()
  assert.match(s, /llmDisabled, llmDisabledReason \} = await import\('\.\/lib\/llm-switch\.js'\)/)
  assert.match(s, /llmDisabled\(db, getState\)/)
})

test('it names WHERE the switch was set, not just that it is on', () => {
  // The env var needs a redeploy to clear; the state key does not. Whoever
  // turns it back on has to know which one is holding it.
  assert.match(src(), /DISABLED by \$\{llmDisabledReason\(db, getState\)\}/)
  assert.equal(llmDisabledReason(null, () => null, { LLM_DISABLED: '1' }), 'LLM_DISABLED env var')
  assert.equal(llmDisabledReason(null, () => '1', {}), 'llm_disabled state key')
})

test('the banner cannot take down a boot', () => {
  const s = src()
  const i = s.indexOf("await import('./lib/llm-switch.js')")
  assert.ok(i > 0)
  assert.match(s.slice(i, i + 700), /catch \(err\)/,
    'a log line must never be the thing that stops the process from starting')
})

test('it says what stops and what does not, because that is the owner question', () => {
  const s = src()
  assert.match(s, /position monitor, weekend watch, cockpit explain, screener search/)
  assert.match(s, /Deterministic trading is unaffected/)
  assert.match(s, /API keys are untouched/)
})

test('and it stays silent when the switch is off', () => {
  // Asserted on the switch itself: an enabled agent must not print a
  // disabled-looking line, or the banner becomes noise and stops being read.
  assert.equal(llmDisabledFrom(null, { LLM_DISABLED: '0' }), false)
  assert.equal(llmDisabledFrom(null, {}), false)
  assert.equal(llmDisabledFrom(null, { LLM_DISABLED: '1' }), true)
})
