// PHASE 9 GATE (cockpit live-wiring prompt): "model failure cannot block the
// cockpit or trading loop." These tests pin that gate plus the four rules the
// optional explanation must obey — off by default, validated JSON, evidence
// ids checked against the bundle, cached by evidence revision — and the extra
// guard this build adds: a number the bundle does not contain is a rejection.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import {
  EXPLAIN_FLAG_KEY, explanationEnabled, buildEvidenceBundle, deterministicExplanation,
  cachedExplanation, putCachedExplanation, parseModelJson, validateExplanation,
  numbersAreGrounded, generateExplanation,
} from './cockpit-explain.js'

const NOW = Date.parse('2026-07-31T13:00:00Z')

const body = () => ({
  meta: { revision: 'pos7:1.0900:1.1200:open:12:2026-07-31T12:40:00Z:2026-07-31T12:59:00Z' },
  position: { symbol: 'EURUSD', side: 'LONG', marketOpen: true },
  intention: {
    currentDecision: { state: 'holding', action: 'HOLD', evidence: ['mp:7:sl'] },
    nextAction: { kind: 'scale_out', trigger: 'close 50% at +1R', triggerPrice: 1.11 },
    armedActions: [{ kind: 'scale_out', trigger: 'close 50% at +1R', armed: true }],
    invalidation: [{ kind: 'stop_loss', condition: 'broker SL at 1.09', state: 'armed' }],
    currentR: 0.5,
    evidenceIndex: {
      'mp:7:sl': { source: 'monitored_positions.current_sl', asOf: null, value: 1.09 },
      'snapshot:price': { source: 'broker snapshot cache', asOf: '2026-07-31T12:59:00Z', value: 1.105 },
    },
    explanation: {
      text: 'Holding LONG EURUSD: the latest review recorded HOLD. [mp:7:sl]',
      mode: 'deterministic', model: null,
      generatedAt: '2026-07-31T13:00:00.000Z',
      evidenceRevision: 'pos7:1.0900:1.1200:open:12:2026-07-31T12:40:00Z:2026-07-31T12:59:00Z',
    },
  },
  correlation: { status: 'live', summary: { held: 1 }, related: [] },
  environment: { session: { state: 'open' }, regime: { label: 'trending' }, macroNews: { status: 'live', gate: { enabled: true } } },
  advisories: [],
})

const goodAnswer = {
  text: 'The bot is holding its long EURUSD position because the most recent review said hold. Its next configured step is to close 50% at +1R, which has not triggered.',
  evidenceIds: ['mp:7:sl'],
  uncertainty: 'none stated',
  generatedAt: '2026-07-31T13:00:01.000Z',
}

/** A stub client in the llm-provider response shape. */
const client = (text, usage = { input_tokens: 500, output_tokens: 90 }) => ({
  model: 'gpt-5-nano',
  messages: { create: async () => ({ content: [{ type: 'text', text }], usage, model: 'gpt-5-nano' }) },
})

let db
beforeEach(() => { db = initDB(':memory:') })

test('GATE off by default: no flag means the deterministic text, and no model is called', async () => {
  assert.equal(explanationEnabled(db), false)
  let called = false
  const out = await generateExplanation(db, body(), {
    nowMs: NOW,
    client: { model: 'x', messages: { create: async () => { called = true; return {} } } },
  })
  assert.equal(called, false, 'the flag is the gate — it must be checked before the client')
  assert.equal(out.mode, 'deterministic')
  assert.match(out.reason, /flag is off/)
  assert.equal(out.text, body().intention.explanation.text)
})

test('GATE model failure cannot block: a throwing client still returns the deterministic text', async () => {
  setState(db, EXPLAIN_FLAG_KEY, 'true')
  const out = await generateExplanation(db, body(), {
    nowMs: NOW,
    client: { model: 'x', messages: { create: async () => { throw new Error('OpenAI request timed out after 30000ms') } } },
  })
  assert.equal(out.mode, 'deterministic')
  assert.match(out.reason, /timed out/)
  assert.ok(out.text.length > 0)
})

test('a valid answer is served as mode:model, labelled with model + evidence revision, and cached', async () => {
  setState(db, EXPLAIN_FLAG_KEY, 'true')
  const b = body()
  const out = await generateExplanation(db, b, { nowMs: NOW, client: client(JSON.stringify(goodAnswer)) })
  assert.equal(out.mode, 'model')
  assert.equal(out.model, 'gpt-5-nano')
  assert.equal(out.evidenceRevision, b.meta.revision)
  assert.deepEqual(out.evidenceIds, ['mp:7:sl'])
  assert.equal(out.uncertainty, 'none stated')
  // Cached by evidence revision — the second call never reaches the client.
  const cached = cachedExplanation(db, b.meta.revision)
  assert.equal(cached.text, out.text)
  const again = await generateExplanation(db, b, {
    nowMs: NOW,
    client: { model: 'x', messages: { create: async () => { throw new Error('must not be called') } } },
  })
  assert.equal(again.cached, true)
  assert.equal(again.mode, 'model')
  // Spend is accounted under its own purpose.
  const row = db.prepare("SELECT calls, input_tokens, output_tokens FROM token_usage WHERE purpose = 'cockpit_explanation'").get()
  assert.equal(row.calls, 1)
  assert.equal(row.input_tokens, 500)
  assert.equal(row.output_tokens, 90)
})

test('a NEW evidence revision is a cache miss — a stale explanation never rides a changed position', async () => {
  setState(db, EXPLAIN_FLAG_KEY, 'true')
  const b1 = body()
  await generateExplanation(db, b1, { nowMs: NOW, client: client(JSON.stringify(goodAnswer)) })
  const b2 = body()
  b2.meta.revision = b2.meta.revision.replace('1.0900', '1.1000') // SL moved
  assert.equal(cachedExplanation(db, b2.meta.revision), null)
  const out = await generateExplanation(db, b2, {
    nowMs: NOW,
    client: { model: 'x', messages: { create: async () => { throw new Error('network') } } },
  })
  assert.equal(out.mode, 'deterministic', 'a miss falls back — it does not serve the old revision')
})

test('validation: missing keys, unknown evidence ids and ungrounded numbers are all rejected', () => {
  const bundle = buildEvidenceBundle(body())
  assert.throws(() => validateExplanation({ evidenceIds: ['mp:7:sl'], uncertainty: 'x', generatedAt: 'y' }, bundle), /text is missing/)
  assert.throws(() => validateExplanation({ ...goodAnswer, evidenceIds: [] }, bundle), /evidenceIds is missing/)
  assert.throws(() => validateExplanation({ ...goodAnswer, uncertainty: '' }, bundle), /uncertainty is missing/)
  assert.throws(() => validateExplanation({ ...goodAnswer, generatedAt: '' }, bundle), /generatedAt is missing/)
  assert.throws(() => validateExplanation({ ...goodAnswer, evidenceIds: ['made:up'] }, bundle), /unknown evidence: made:up/)
  assert.throws(
    () => validateExplanation({ ...goodAnswer, text: 'Holding EURUSD; the stop is at 1.0725.' }, bundle),
    /number that is not in the evidence bundle/)
  // A claim the deterministic layer never made cannot be introduced.
  assert.throws(
    () => validateExplanation({ ...goodAnswer, text: 'Holding EURUSD — the thesis intact and the trade is on the path to TP.' }, bundle),
    /unsupported claim/)
  // Numbers that ARE in the bundle pass, including trailing-zero formatting.
  assert.ok(numbersAreGrounded('stop at 1.0900, price 1.105, +0.5R', bundle))
  assert.ok(!numbersAreGrounded('stop at 1.0901', bundle))
})

test('a fenced or non-JSON answer degrades instead of throwing at the caller', async () => {
  setState(db, EXPLAIN_FLAG_KEY, 'true')
  // A ```json fence is tolerated — models add it constantly and it changes nothing.
  const fenced = '```json\n' + JSON.stringify(goodAnswer) + '\n```'
  assert.equal(parseModelJson(fenced).text, goodAnswer.text)
  const ok = await generateExplanation(db, body(), { nowMs: NOW, client: client(fenced) })
  assert.equal(ok.mode, 'model')
  // Prose instead of JSON is a rejection, not a crash. force:true bypasses the
  // cache the call above just filled — the owner's refresh path.
  const bad = await generateExplanation(db, body(), { nowMs: NOW, force: true, client: client('Sure! The bot is holding.') })
  assert.equal(bad.mode, 'deterministic')
  assert.match(bad.reason, /rejected/)
})

test('the bundle carries evidence and no credentials — it is built by allow-list', () => {
  const b = body()
  // Even if the body were to carry a secret-looking field, the bundle is
  // constructed from named fields only, so it cannot travel.
  b.position.accessToken = 'super-secret-token'
  b.meta.clientSecret = 'nope'
  const bundle = buildEvidenceBundle(b)
  const json = JSON.stringify(bundle)
  assert.ok(!json.includes('super-secret-token'))
  assert.ok(!json.includes('nope'))
  assert.deepEqual(bundle.evidence.map(e => e.id).sort(), ['mp:7:sl', 'snapshot:price'])
  assert.equal(bundle.deterministic, b.intention.explanation.text)
})

test('deterministicExplanation is always a valid contract object, even for an empty body', () => {
  const out = deterministicExplanation({}, NOW)
  assert.equal(out.mode, 'deterministic')
  assert.equal(out.model, null)
  assert.equal(out.evidenceRevision, null)
  assert.ok(out.text.length > 0)
  assert.equal(out.generatedAt, new Date(NOW).toISOString())
})

test('the cache is bounded — an agent that runs for weeks cannot grow the key without limit', () => {
  for (let i = 0; i < 40; i++) {
    putCachedExplanation(db, `rev-${i}`, { text: `t${i}`, mode: 'model', generatedAt: new Date(NOW + i * 1000).toISOString() })
  }
  const kept = Object.keys(JSON.parse(db.prepare("SELECT value FROM agent_state WHERE key = 'cockpit_explain_cache_json'").get().value))
  assert.ok(kept.length <= 20, `cache kept ${kept.length} entries`)
  assert.ok(kept.includes('rev-39'), 'the newest revision survives')
  assert.ok(!kept.includes('rev-0'), 'the oldest is evicted')
})
