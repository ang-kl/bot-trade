// Tests for llm_ai_doc/AI_Model_Router_Instruction.md's five principles.
// Each one that is machine-checkable has a test that fails if it is broken.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TIERS, TASK_TIERS, resolveTier, tierTable, chooseModel, requiresReasoning,
} from './model-router.js'

const ENV = {
  OPENAI_API_KEY: 'sk-x',
  OPENAI_MODEL_DEFAULT: 'gpt-5-nano',
  OPENAI_MODEL_PREMIUM: 'gpt-5-mini',
  OPENAI_MODEL_REASONING: 'gpt-5.6',
}

test('the three tiers resolve from the three env vars', () => {
  assert.equal(resolveTier('DEFAULT', ENV).model, 'gpt-5-nano')
  assert.equal(resolveTier('PREMIUM', ENV).model, 'gpt-5-mini')
  assert.equal(resolveTier('REASONING', ENV).model, 'gpt-5.6')
  for (const t of TIERS) assert.equal(resolveTier(t, ENV).source, `OPENAI_MODEL_${t}`)
})

test('OPENAI_MODEL_DEFAULT is the new name and it WINS over the old ones', () => {
  const env = {
    OPENAI_MODEL_DEFAULT: 'new-name-wins',
    OPENAI_DEFAULT_MODEL: 'old-name',
    OPENAI_MODEL: 'oldest-name',
  }
  const r = resolveTier('DEFAULT', env)
  assert.equal(r.model, 'new-name-wins')
  assert.equal(r.source, 'OPENAI_MODEL_DEFAULT')
})

test('the OLD names still work, so the rename cannot silently change the model', () => {
  // A live agent whose new var is not set yet must keep calling the model it was
  // already calling — not fall through to a hardcoded built-in.
  assert.deepEqual(resolveTier('DEFAULT', { OPENAI_DEFAULT_MODEL: 'gpt-5.6-luna' }),
    { tier: 'DEFAULT', model: 'gpt-5.6-luna', source: 'OPENAI_DEFAULT_MODEL' })
  assert.deepEqual(resolveTier('DEFAULT', { OPENAI_MODEL: 'gpt-4o' }),
    { tier: 'DEFAULT', model: 'gpt-4o', source: 'OPENAI_MODEL' })
})

test('blank and whitespace-only vars are ignored, not used as a model id', () => {
  const r = resolveTier('DEFAULT', { OPENAI_MODEL_DEFAULT: '   ', OPENAI_DEFAULT_MODEL: 'real-id' })
  assert.equal(r.model, 'real-id')
  // ...and a value with stray spaces is trimmed rather than sent as-is.
  assert.equal(resolveTier('DEFAULT', { OPENAI_MODEL_DEFAULT: ' gpt-5-nano ' }).model, 'gpt-5-nano')
})

test('PRINCIPLE 3: an unconfigured higher tier falls DOWN, never up', () => {
  const onlyDefault = { OPENAI_MODEL_DEFAULT: 'gpt-5-nano' }
  for (const t of ['PREMIUM', 'REASONING']) {
    const r = resolveTier(t, onlyDefault)
    assert.equal(r.model, 'gpt-5-nano', `${t} must not invent an expensive id`)
    assert.equal(r.source, 'default-tier')
  }
})

test('PRINCIPLE 1: an unknown task type gets the cheapest tier', () => {
  assert.equal(chooseModel({ type: 'something-nobody-mapped' }, ENV).model, 'gpt-5-nano')
  assert.equal(chooseModel({}, ENV).model, 'gpt-5-nano')
  assert.equal(chooseModel(undefined, ENV).model, 'gpt-5-nano')
})

test('the doc\'s routing table is honoured', () => {
  const expect = {
    // cheapest
    chat: 'gpt-5-nano', faq: 'gpt-5-nano', search: 'gpt-5-nano',
    extraction: 'gpt-5-nano', json: 'gpt-5-nano', classification: 'gpt-5-nano',
    telegram: 'gpt-5-nano',
    // premium
    email: 'gpt-5-mini', summarise: 'gpt-5-mini', rewrite: 'gpt-5-mini',
    translation: 'gpt-5-mini',
    // reasoning
    coding: 'gpt-5.6', architecture: 'gpt-5.6', deep_reasoning: 'gpt-5.6',
    financial_analysis: 'gpt-5.6',
  }
  for (const [type, model] of Object.entries(expect)) {
    assert.equal(chooseModel({ type }, ENV).model, model, type)
  }
})

test('this app\'s own tasks are mapped, and the volume ones are cheap', () => {
  // position_monitor runs on every open position every tick — it is the reason
  // "~98% of requests on the cheapest model" is achievable at all.
  assert.equal(chooseModel({ type: 'position_monitor' }, ENV).tier, 'DEFAULT')
  assert.equal(chooseModel({ type: 'weekend_watch' }, ENV).tier, 'DEFAULT')
  assert.equal(chooseModel({ type: 'screener_search' }, ENV).tier, 'DEFAULT')
  // Re-deriving the account's money limits is financial analysis.
  assert.equal(chooseModel({ type: 'risk_reassess' }, ENV).tier, 'REASONING')
})

test('escalation flags move a task UP to the reasoning tier', () => {
  for (const flag of ['requiresMultipleSteps', 'hasLargeCodebase', 'hasManyDocuments', 'userRequestedExpertMode']) {
    const r = chooseModel({ type: 'chat', [flag]: true }, ENV)
    assert.equal(r.model, 'gpt-5.6', flag)
    assert.equal(r.tier, 'REASONING', flag)
    assert.equal(r.escalated, true, flag)
  }
  assert.equal(requiresReasoning({}), false)
  assert.equal(requiresReasoning({ requiresMultipleSteps: false }), false)
})

test('escalation never DOWNGRADES an already-reasoning task', () => {
  const r = chooseModel({ type: 'risk_reassess' }, ENV)
  assert.equal(r.tier, 'REASONING')
  assert.equal(r.escalated, false, 'no flag was set, so it was not an escalation')
  assert.equal(r.model, 'gpt-5.6')
})

test('nothing infers escalation on its own — the flags are opt-in', () => {
  // A long prompt, many symbols, whatever: absent an explicit flag the task
  // keeps its mapped tier. A heuristic that quietly escalates spend is the
  // failure principle 3 warns about.
  assert.equal(chooseModel({ type: 'chat', promptLength: 999_999 }, ENV).tier, 'DEFAULT')
})

test('tierTable reports every tier and where it came from', () => {
  const t = tierTable(ENV)
  assert.deepEqual(Object.keys(t).sort(), [...TIERS].sort())
  assert.equal(t.REASONING.model, 'gpt-5.6')
  assert.equal(t.REASONING.source, 'OPENAI_MODEL_REASONING')
  // No key material can leak through this — model ids only.
  assert.ok(!JSON.stringify(t).includes('sk-x'))
})

test('with NOTHING configured, every tier is the cheap built-in', () => {
  const t = tierTable({})
  for (const tier of TIERS) {
    assert.equal(t[tier].model, 'gpt-5-nano', tier)
  }
  assert.equal(t.DEFAULT.source, 'builtin')
})

test('every task in TASK_TIERS names a real tier', () => {
  for (const [type, tier] of Object.entries(TASK_TIERS)) {
    assert.ok(TIERS.includes(tier), `${type} → ${tier}`)
  }
})
