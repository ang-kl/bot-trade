// agent/lib/request-actor.test.js — PR-Q1 (V3 P6/P7, review 25-09-2026): the
// actor on an import or a policy switch comes from the CALLER — the
// credential the server's own middleware authenticated, plus an optional
// declared name — never the hard-coded 'owner'. Exercised through the real
// routes: POST /actions/tick-validation, /entry-mode-policy and /tick-trials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'

import { actorFromRequest, RESERVED_ACTOR_PREFIXES } from './request-actor.js'
import { initDB } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { importTickValidation } from '../services/tick-validation.js'
import { importTickTrial } from '../services/tick-research.js'
import { upsertAccount } from '../services/account-registry.js'
import { profileHash, normalizeParams, DEFAULT_PARAMS } from './tick-strategy.js'

test('actorFromRequest: the credential the server stamped, a declared name beside it, reserved actors refused, and never "owner" by default', () => {
  assert.deepEqual(actorFromRequest({ authCredential: 'device_session', headers: {} }), { ok: true, actor: 'owner (device session)', credential: 'device_session', declared: null })
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', headers: {} }).actor, 'agent-secret holder (undeclared)')
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', body: { actor: 'claude on the owner\'s word' }, headers: {} }).actor, 'claude on the owner\'s word via agent_secret')
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', headers: { 'x-actor': 'claude' } }).actor, 'claude via agent_secret', 'the header works as well as the body')
  assert.equal(actorFromRequest({ headers: {} }).actor, 'unattributed (no credential stamped)', 'no middleware: unattributed, not the owner')
  // the body cannot claim a credential: authCredential is read off the request object the server built
  assert.equal(actorFromRequest({ body: { authCredential: 'device_session' }, headers: {} }).actor, 'unattributed (no credential stamped)')
  for (const p of RESERVED_ACTOR_PREFIXES) {
    const r = actorFromRequest({ authCredential: 'agent_secret', body: { actor: `${p}readiness` }, headers: {} })
    assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(r.body.error, 'reserved_actor', p)
  }
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', body: { actor: 'AUTO:readiness' }, headers: {} }).body.error, 'reserved_actor', 'case does not get round it')
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', body: { actor: 'x'.repeat(81) }, headers: {} }).body.error, 'bad_actor')
  assert.equal(actorFromRequest({ authCredential: 'agent_secret', body: { actor: 'a\nb' }, headers: {} }).body.error, 'bad_actor')
})

test('the auth middleware stamps which credential authenticated the request (comments stripped)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const start = src.indexOf('function authMiddleware(')
  const mw = src.slice(start, src.indexOf('\n}\n', start))
  assert.ok(start > 0 && mw.length > 200, 'the middleware body was found')
  assert.match(mw, /req\.authCredential = tier === 'full' \? \(isDeviceSession \? 'device_session' : 'agent_secret'\)/)
  // stamped after the refusal and before next(): a refused request never reaches a route
  assert.ok(mw.indexOf('req.authCredential =') > mw.indexOf("return res.status(401)"), 'stamped only on an authorized request')
})

const DEMO = '46130058'
async function server(credential) {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  const app = express()
  app.use(express.json())
  // what index.js's authMiddleware does, for one credential
  app.use((req, _res, next) => { req.authCredential = credential; next() })
  app.use('/actions', actionsRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  const post = (p, body, headers = {}) => fetch(`http://127.0.0.1:${s.address().port}/actions${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { db, post, close: () => s.close() }
}
const TH = { replay: { minTrades: 30, minProfitFactor: 1.3, maxDrawdownR: 10, minExpectancyLowerR: 0, minTestTrades: 10 }, shadow: { minSignals: 20, minHours: 24, minTrades: 5, minLosses: 2, minProfitFactor: 1.2, minExpectancyLowerR: -1, maxDrawdownR: 6, maxResetSharePct: 20 }, traded: { minTrades: 3, minProfitFactor: 1.2, maxDrawdownR: 10 } }
function passingTrial(db) {
  const t = {
    trialId: 'q1-actor', strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: profileHash(DEFAULT_PARAMS), params: normalizeParams(DEFAULT_PARAMS),
    sim: { latencyMs: 250, costSource: 'class', costClass: 'fx', commissionWirePerSide: 0, commissionBpsPerSide: 0.35, slippageWirePerSide: 0, slippageBpsPerSide: 0.5, includeTest: true },
    manifest: { segments: 1 }, summary: { trades: 40, profitFactor: 1.6, maxDrawdownR: 4, netR: 5 },
    blocks: [{ name: 'train', trades: 20, netR: 1 }, { name: 'validation', trades: 10, netR: 1 }, { name: 'test', trades: 10, netR: 3, expectancyLowerR: 0.2 }],
  }
  assert.equal(importTickTrial(db, t).ok, true)
  return t.trialId
}

test('POST /actions/tick-validation records the CALLER: a declared agent on the master secret is not the owner; the owner\'s device session is', async () => {
  const s = await server('agent_secret')
  try {
    // put the account on REPLAY_PASSED so a reset through the route succeeds
    assert.equal(importTickValidation(s.db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: passingTrial(s.db) }, thresholds: TH }).ok, true)
    const r = await s.post('/tick-validation', { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'q1 actor test' }, actor: 'claude on the owner\'s word' })
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.record.actor, 'claude on the owner\'s word via agent_secret', 'RED on the hard-coded actor: the record said "owner"')
    const reserved = await s.post('/tick-validation', { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: {}, actor: 'auto:readiness' })
    assert.equal(reserved.status, 400); assert.equal((await reserved.json()).error, 'reserved_actor')
  } finally { s.close() }
  const o = await server('device_session')
  try {
    assert.equal(importTickValidation(o.db, { accountId: DEMO, stage: 'REPLAY_PASSED', evidence: { trialId: passingTrial(o.db) }, thresholds: TH }).ok, true)
    const r = await o.post('/tick-validation', { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'owner reset' } })
    assert.equal((await r.json()).record.actor, 'owner (device session)')
  } finally { o.close() }
})

test('POST /actions/entry-mode-policy (the policy switch) and POST /actions/tick-trials (client imports) are attributed to the caller too', async () => {
  const s = await server('agent_secret')
  try {
    const r = await s.post('/entry-mode-policy', { accountId: DEMO, policy: 'auto' }, { 'x-actor': 'claude' })
    assert.equal(r.status, 200, await r.clone().text())
    const log = s.db.prepare(`SELECT body FROM action_log WHERE path = '/actions/entry-mode-policy'`).all().map(x => JSON.parse(x.body))
    assert.equal(log.at(-1).actor, 'claude via agent_secret', 'RED on the hard-coded actor')
    const t = await s.post('/tick-trials', { trials: [{ strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: 'aaaaaaaaaaaaaaaa', params: {}, sim: {}, manifest: { files: ['x'] }, summary: { trades: 0 }, blocks: [] }] })
    const tb = await t.json()
    assert.equal(tb.origin, 'client_import'); assert.equal(tb.verified, false); assert.equal(tb.actor, 'agent-secret holder (undeclared)')
    const origin = JSON.parse(s.db.prepare('SELECT origin_json FROM tick_trials').get().origin_json)
    assert.equal(origin.kind, 'client_import'); assert.equal(origin.verified, false); assert.equal(origin.actor, 'agent-secret holder (undeclared)')
  } finally { s.close() }
})
