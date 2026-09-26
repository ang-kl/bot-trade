// node --test agent/routes/risk-reassess-apply.test.js
//
// SAFE-0b (owner OD-14, 26-09-2026): Re-Risk's Apply writes the GLOBAL
// risk_config_json. It refuses a proposal OLDER than 7 days, or one made for
// another account than the one the agent trades now, each with a named code —
// and writes nothing when it refuses. Measured 26-09: the stored proposal was
// made 30-07 for 43097342 while the agent trades 46979908.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'
import { reassessApplyRefusal, REASSESS_APPLY_MAX_AGE_MS, STATE_KEY } from '../services/risk-reassess.js'

const DAY_MS = 86400_000
const NOW = Date.parse('2026-09-26T10:00:00.000Z')
const iso = ms => new Date(ms).toISOString()
const proposal = (extra = {}) => ({
  at: iso(NOW - DAY_MS), provider: 'openai', model: 'm', includeWatchlist: false, watchlistCount: 0,
  accountId: '46979908', balanceUsd: 1000, leverage: 100, stats: {}, summary: '', warnings: [],
  proposals: [
    { key: 'maxOpenPositions', label: 'Max open positions', current: 5, proposed: 4, reason: 'r' },
    { key: 'dailyLossLimit', label: 'Daily loss limit', current: 300, proposed: 200, reason: 'r' },
  ],
  applied: false, appliedAt: null, ...extra,
})

// ---- the pure guard -------------------------------------------------------
test('SAFE-0b guard: exactly 7 days old is accepted; one millisecond older is refused as assessment_too_old', () => {
  assert.equal(REASSESS_APPLY_MAX_AGE_MS, 7 * DAY_MS)
  const ctx = { nowMs: NOW, accountId: '46979908' }
  assert.equal(reassessApplyRefusal(proposal({ at: iso(NOW - 7 * DAY_MS) }), ctx), null, 'exactly 7 days: not OLDER than 7 days')
  const r = reassessApplyRefusal(proposal({ at: iso(NOW - 7 * DAY_MS - 1) }), ctx)
  assert.equal(r?.code, 'assessment_too_old')
  assert.equal(r.ageMs, 7 * DAY_MS + 1)
  assert.match(r.error, /older than 7 days/)
  assert.equal(reassessApplyRefusal(proposal({ at: iso(NOW) }), ctx), null, 'made this instant')
})

test('SAFE-0b guard: another account is refused as assessment_other_account, naming both accounts', () => {
  const r = reassessApplyRefusal(proposal({ accountId: '43097342' }), { nowMs: NOW, accountId: '46979908' })
  assert.equal(r?.code, 'assessment_other_account')
  assert.equal(r.assessmentAccountId, '43097342'); assert.equal(r.tradingAccountId, '46979908')
  assert.match(r.error, /43097342/); assert.match(r.error, /46979908/)
  assert.equal(reassessApplyRefusal(proposal({ accountId: 46979908 }), { nowMs: NOW, accountId: '46979908' }), null, 'a numeric id of the same account matches')
})

test('SAFE-0b guard: an unageable time, an unnamed account or no traded account is refused, never waved through', () => {
  const ok = { nowMs: NOW, accountId: '46979908' }
  for (const at of [undefined, '', 'yesterday', iso(NOW + 1)]) {
    assert.equal(reassessApplyRefusal(proposal({ at }), ok)?.code, 'assessment_time_invalid', String(at))
  }
  assert.equal(reassessApplyRefusal(proposal(), { accountId: '46979908' })?.code, 'assessment_time_invalid', 'no clock')
  for (const accountId of [null, undefined, '']) {
    assert.equal(reassessApplyRefusal(proposal({ accountId }), ok)?.code, 'assessment_account_unknown', String(accountId))
    assert.equal(reassessApplyRefusal(proposal(), { nowMs: NOW, accountId })?.code, 'trading_account_unknown', String(accountId))
  }
  // Age is judged first: the production record (58 days, another account) names the age.
  assert.equal(reassessApplyRefusal(proposal({ at: '2026-07-30T01:11:36.423Z', accountId: '43097342' }), ok)?.code, 'assessment_too_old')
})

// ---- the route -------------------------------------------------------------
async function serve(t, { nowMs = NOW, trading = '46979908' } = {}) {
  const db = initDB(':memory:')
  if (trading != null) setState(db, 'ctrader_account_id', trading)
  const app = express(); app.use(express.json()); app.use('/actions', actionsRouter(db, { nowMs: () => nowMs }))
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)) })
  t.after(async () => { s.closeAllConnections(); await new Promise(r => s.close(r)); db.close() })
  const apply = body => fetch(`http://127.0.0.1:${s.address().port}/actions/risk-reassess-apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { db, apply }
}
const riskConfig = db => getState(db, 'risk_config_json')
const log = db => db.prepare("SELECT method, body FROM action_log WHERE path = '/risk-reassess-apply'").all()

test('SAFE-0b route: a 58-day-old proposal for another account is refused with a named reason and writes nothing', async t => {
  const { db, apply } = await serve(t)
  const last = proposal({ at: '2026-07-30T01:11:36.423Z', accountId: '43097342' })
  setState(db, STATE_KEY, JSON.stringify(last))
  setState(db, 'risk_config_json', JSON.stringify({ maxOpenPositions: 5 }))
  const res = await apply({ keys: ['maxOpenPositions', 'dailyLossLimit'], at: last.at })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'assessment_too_old')
  // Checker nit N5: the same [{ key, why }] shape as the 200 and 400 replies.
  assert.deepEqual(body.refused, [{ key: 'maxOpenPositions', why: 'assessment_too_old' }, { key: 'dailyLossLimit', why: 'assessment_too_old' }])
  assert.equal(riskConfig(db), JSON.stringify({ maxOpenPositions: 5 }), 'the global risk config is untouched')
  assert.equal(JSON.parse(getState(db, STATE_KEY)).applied, false, 'the proposal is not marked applied')
  assert.deepEqual(log(db).map(r => [r.method, JSON.parse(r.body).code]), [['RISK_REASSESS_APPLY_REFUSED', 'assessment_too_old']])
})

test('SAFE-0b route: a fresh proposal for another account is refused as assessment_other_account', async t => {
  const { db, apply } = await serve(t)
  const last = proposal({ accountId: '43097342' })
  setState(db, STATE_KEY, JSON.stringify(last))
  const res = await apply({ keys: ['maxOpenPositions'], at: last.at })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, 'assessment_other_account')
  assert.equal(body.assessmentAccountId, '43097342'); assert.equal(body.tradingAccountId, '46979908')
  assert.deepEqual(body.refused, [{ key: 'maxOpenPositions', why: 'assessment_other_account' }])
  assert.equal(riskConfig(db), null, 'nothing written')
})

// Checker nit N7 (26-09-2026): `k in PROPOSABLE` is true for every name on
// Object.prototype. Reproduced before the fix: a stored row keyed
// 'constructor' was applied, and risk_config_json read
// {"constructor":1,"maxOpenPositions":4}. Own keys only now.
test('N7 route: a stored proposal row keyed by an inherited name (constructor, toString, __proto__) is refused, never written', async t => {
  const { db, apply } = await serve(t)
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty']
  const last = proposal()
  // What parseAssessment stored before N7 (proposed NaN became null); 1 here so a write would show.
  last.proposals.push(...inherited.map(key => ({ key, proposed: 1, clamped: true, reason: 'x' })))
  setState(db, STATE_KEY, JSON.stringify(last))
  let res = await apply({ keys: [...inherited, 'maxOpenPositions'], at: last.at })
  assert.equal(res.status, 200)
  let body = await res.json()
  assert.deepEqual(body.applied, { maxOpenPositions: 4 })
  assert.deepEqual(body.refused, inherited.map(key => ({ key, why: 'not a proposable setting' })))
  assert.equal(riskConfig(db), JSON.stringify({ maxOpenPositions: 4 }), 'only the own proposable key reaches the global risk config')
  assert.deepEqual(JSON.parse(getState(db, STATE_KEY)).appliedKeys, ['maxOpenPositions'])

  const alone = await serve(t)
  setState(alone.db, STATE_KEY, JSON.stringify(last))
  res = await alone.apply({ keys: ['constructor'], at: last.at })
  assert.equal(res.status, 400)
  body = await res.json()
  assert.equal(body.error, 'nothing applicable')
  assert.deepEqual(body.refused, [{ key: 'constructor', why: 'not a proposable setting' }])
  assert.equal(riskConfig(alone.db), null, 'nothing written')
})

test('SAFE-0b route: at exactly 7 days on the traded account the selected keys apply; a millisecond later they do not', async t => {
  const made = NOW - 7 * DAY_MS
  const edge = await serve(t, { nowMs: NOW })
  const last = proposal({ at: iso(made) })
  setState(edge.db, STATE_KEY, JSON.stringify(last))
  let res = await edge.apply({ keys: ['maxOpenPositions'], at: last.at })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.applied, { maxOpenPositions: 4 })
  assert.deepEqual(JSON.parse(riskConfig(edge.db)), { maxOpenPositions: 4 })
  assert.deepEqual(JSON.parse(getState(edge.db, STATE_KEY)).appliedKeys, ['maxOpenPositions'])

  const late = await serve(t, { nowMs: NOW + 1 })
  setState(late.db, STATE_KEY, JSON.stringify(last))
  res = await late.apply({ keys: ['maxOpenPositions'], at: last.at })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'assessment_too_old')
  assert.equal(riskConfig(late.db), null)
})

test('SAFE-0b route: no traded account means the account cannot be checked — refused, nothing written', async t => {
  const { db, apply } = await serve(t, { trading: null })
  const last = proposal()
  setState(db, STATE_KEY, JSON.stringify(last))
  const res = await apply({ keys: ['maxOpenPositions'], at: last.at })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'trading_account_unknown')
  assert.equal(riskConfig(db), null)
})

test('SAFE-0b route: the superseded-run 409 still comes first (the `at` binding is unchanged)', async t => {
  const { db, apply } = await serve(t)
  setState(db, STATE_KEY, JSON.stringify(proposal()))
  const res = await apply({ keys: ['maxOpenPositions'], at: iso(NOW - 2 * DAY_MS) })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.code, undefined)
  assert.match(body.error, /superseded/)
})
