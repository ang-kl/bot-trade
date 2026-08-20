// The LLM kill switch: the boot line, and the last consumer that ignored it.
//
// BEHAVIOURAL, NOT SOURCE-MATCHING. The first version of these tests asserted
// on index.js as text with an unanchored `/llmDisabled\(db, getState\)/`, which
// survives `if (llmDisabled(db, getState) && false)` — a banner that could
// never print, with a green suite. CLAUDE.md #1 and #2 together. The line is
// now a pure function and these call it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { llmBootBannerLine, llmDisabledFrom } from './lib/llm-switch.js'

const noState = () => null

test('an enabled agent prints nothing at all', () => {
  assert.equal(llmBootBannerLine(null, noState, {}), null)
  assert.equal(llmBootBannerLine(null, noState, { LLM_DISABLED: '0' }), null)
  assert.equal(llmBootBannerLine(null, () => 'false', {}), null,
    'a banner on an enabled agent is noise, and noise stops being read')
})

test('the env var produces a line naming the env var', () => {
  const line = llmBootBannerLine(null, noState, { LLM_DISABLED: '1' })
  assert.match(line, /^\[agent\] LLM: DISABLED by LLM_DISABLED env var/)
})

test('the state key produces a line naming the state key', () => {
  // The two sources are not interchangeable: the env var needs a redeploy to
  // clear, the state key does not. Whoever turns it back on must know which.
  const line = llmBootBannerLine(null, () => '1', {})
  assert.match(line, /DISABLED by llm_disabled state key/)
})

test('the env var wins when both are set, matching llmDisabledReason', () => {
  const line = llmBootBannerLine(null, () => '1', { LLM_DISABLED: '1' })
  assert.match(line, /LLM_DISABLED env var/, 'the durable brake is the one to report')
})

test('the line enumerates every gated consumer, including Re-Risk', () => {
  const line = llmBootBannerLine(null, noState, { LLM_DISABLED: '1' })
  for (const c of ['position monitor', 'weekend watch', 'cockpit explain', 'screener search', 'Re-Risk']) {
    assert.ok(line.includes(c), `${c} must appear — the list reads as the enumeration of what stops`)
  }
})

test('and it says what does NOT stop, because that is the owner question', () => {
  const line = llmBootBannerLine(null, noState, { LLM_DISABLED: '1' })
  assert.match(line, /Deterministic trading is unaffected/)
  assert.match(line, /API keys are untouched/)
})

test('a state read that throws does not take the banner down', () => {
  const boom = () => { throw new Error('SQLITE_BUSY') }
  assert.doesNotThrow(() => llmBootBannerLine(null, boom, { LLM_DISABLED: '1' }))
  assert.match(llmBootBannerLine(null, boom, { LLM_DISABLED: '1' }), /LLM_DISABLED env var/,
    'the env brake still holds when the database will not answer')
})

test('Re-Risk is actually gated, so the absolute claim is now true', () => {
  // The banner said "no LLM calls will be attempted" while POST
  // /actions/risk-reassess still called out — PR #735's defect with the sign
  // flipped. Pinned inside the route body, not the whole file, so the check
  // cannot pass on some other route's gate.
  const src = fs.readFileSync(new URL('./routes/actions.js', import.meta.url), 'utf8')
  const start = src.indexOf("router.post('/risk-reassess'")
  assert.ok(start > 0, 'the route exists')
  const body = src.slice(start, start + 2500)
  assert.match(body, /llmBlocked/, 'the reassess route must consult the switch')
  assert.match(body, /gate\.blocked/)
  assert.match(body, /503/, '503 not 502: nothing failed, the capability is off')
  // The gate has to come BEFORE the call, which is the whole point.
  assert.ok(body.indexOf('gate.blocked') < body.indexOf('runReassessment(db'),
    'a gate after the call is not a gate')
})

test('truthy spellings agree with the shared parser', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'disabled']) {
    assert.ok(llmBootBannerLine(null, noState, { LLM_DISABLED: v }), `${v} should disable`)
  }
  for (const v of ['0', 'false', 'no', '', 'off']) {
    assert.equal(llmBootBannerLine(null, noState, { LLM_DISABLED: v }), null, `${v} must not`)
    assert.equal(llmDisabledFrom(null, { LLM_DISABLED: v }), false)
  }
})

test('no LLM consumer exists that the banner does not know about', () => {
  // THE ONE REPORT HERE THAT HAD NO WAY TO FAIL. The consumer-list test above
  // asserts the banner against a copy of its own string: it goes red only when
  // someone edits that string, which is the case where the edit was deliberate.
  // So a SIXTH consumer could land ungated while the line kept promising "no
  // LLM calls will be attempted" and the suite stayed green — CLAUDE.md #3,
  // aimed at this PR's own artefact.
  //
  // This discovers the call sites instead of trusting the sentence. It matches
  // BOTH call forms: weekend-watch uses `.messages.stream(`, not `.create(`,
  // so a create-only pattern would have silently dropped it and encoded a set
  // of four as though it were the whole truth.
  const root = new URL('./', import.meta.url)
  const found = new Set()
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue
      const rel = decodeURIComponent(p.pathname).slice(decodeURIComponent(root.pathname).length)
      if (rel === 'lib/llm-provider.js') continue      // the factory, not a caller
      if (/\.messages\.(create|stream)\(/.test(fs.readFileSync(p, 'utf8'))) found.add(rel)
    }
  }
  walk(root)

  const KNOWN = [
    'services/cockpit-explain.js',
    'services/monitor-svc.js',
    'services/risk-reassess.js',
    'services/screener-search.js',
    'services/weekend-watch.js',
  ]
  assert.deepEqual([...found].sort(), KNOWN,
    'A module calls a model that this list does not name. Gate it with llmBlocked '
    + 'BEFORE the call, add it to llmBootBannerLine, and add it here — otherwise the '
    + 'boot banner promises something the code no longer delivers.')
})
