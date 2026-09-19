// node --test agent/routes/risk-account-routes.test.js
//
// PER-ACCOUNT RISK CONFIG, end to end.
//
// The overlay machinery already existed — loadRiskConfig(db, accountId) merges
// `acct:<id>:risk_config_json` over the global config, and POST
// /actions/risk-config has taken an accountId since it was built. What did not
// exist was any way to SEE it: GET /state/risk-full ignored the account
// entirely, so the Risk page read and wrote the global config while sitting
// under a header naming one account. The limits on screen were not necessarily
// the limits that account traded under, and nothing said so.
//
// These pin the read side, and in particular the distinction the UI depends
// on: "differs from the default" and "this account overrides the global" are
// different facts, and collapsing them is how an operator edits the wrong one.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const riskFull = (s, acct) =>
  fetch(s.url(`/state/risk-full${acct ? `?account=${acct}` : ''}`)).then(r => r.json())

const setRisk = (s, body) => fetch(s.url('/actions/risk-config'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('with no overlay, an account reads exactly the global config', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })
    const g = await riskFull(s)
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 2)
    assert.deepEqual(a.risk.effective, g.risk.effective)
    assert.deepEqual(a.risk.overlayKeys, [], 'nothing is overridden for this account')
    assert.equal(a.risk.scopedTo, '5203012')
  } finally { s.close() }
})

test('an overlay changes ONLY that account, and names what it changed', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })                       // global
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 }) // elevated

    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 5)
    assert.deepEqual(a.risk.overlayKeys, ['perTradeRiskPct'])
    // The global value the overlay stands on, so the page can show what
    // clearing it would restore.
    assert.equal(a.risk.global.perTradeRiskPct, 2)

    // Every other account, and the global config, are untouched.
    assert.equal((await riskFull(s, '5306502')).risk.effective.perTradeRiskPct, 2)
    assert.equal((await riskFull(s)).risk.effective.perTradeRiskPct, 2)
  } finally { s.close() }
})

test('an untouched knob keeps FOLLOWING the global config, it is not frozen', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2, maxOpenPositions: 5 })
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    // Later the global cap moves. The account overrode risk %, not the cap,
    // so the cap must move with it — otherwise saving one field would
    // silently pin every other field at whatever it happened to read that day.
    await setRisk(s, { maxOpenPositions: 9 })
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.maxOpenPositions, 9, 'must follow the global change')
    assert.equal(a.risk.effective.perTradeRiskPct, 5, 'and keep its own override')
  } finally { s.close() }
})

test('reset clears the overlay and the account follows global again', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    assert.equal((await riskFull(s, '5203012')).risk.effective.perTradeRiskPct, 5)

    await setRisk(s, { accountId: '5203012', reset: true })
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 2)
    assert.deepEqual(a.risk.overlayKeys, [])
  } finally { s.close() }
})

test('the global read is unchanged — scopedTo null, no overlay fields', async () => {
  const s = await server()
  try {
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    const g = await riskFull(s)
    assert.equal(g.risk.scopedTo, null)
    assert.deepEqual(g.risk.overlayKeys, [])
    assert.equal(g.risk.global, null, 'nothing to compare against when this IS the global config')
    // An account overlay must never leak into the global answer.
    assert.notEqual(g.risk.effective.perTradeRiskPct, 5)
  } finally { s.close() }
})

test('balance and leverage follow the same scope as the limits', async () => {
  const s = await server()
  try {
    // Sizing is balance × risk%. Showing one account's limits beside another's
    // balance would make every derived lot figure on the page wrong.
    s.db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('acct:5203012:account_balance_usd', '51004')").run()
    s.db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('acct:5067353:account_balance_usd', '1431')").run()
    assert.equal((await riskFull(s, '5203012')).account.balance, 51004)
    assert.equal((await riskFull(s, '5067353')).account.balance, 1431)
    assert.equal((await riskFull(s, '5203012')).account.accountId, '5203012')
  } finally { s.close() }
})

// ---------------------------------------------------------------------------
// THE LIVE STAIRCASE FOLLOWS THE ACCOUNT TOO (owner 04-08-2026, three
// screenshots: "I don't see the change in Live staircase when i change the
// account in this Risk page").
//
// The ratchet block on this route loaded `ctrader_account_id` and ignored
// `?account=` entirely, so all three screenshots showed one account's baseline
// and high-water mark under three different account names — the same defect as
// a balance with no owner, one layer down. Money figures, so it is not a
// cosmetic mismatch: the staircase is what the operator reads to decide
// whether a floor is about to trigger.
// ---------------------------------------------------------------------------
test('the profit-ratchet staircase is the QUERIED account\'s, not the selected one', async () => {
  const s = await server()
  try {
    s.db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('ctrader_account_id', '5306502')").run()
    const ladder = (id, o) => s.db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)')
      .run(`acct:${id}:profit_ratchet_state_json`, JSON.stringify(o))
    ladder('5306502', { baseline: 50548.76, hwm: 50653.92, floor: null, halt: false })
    ladder('5203012', { baseline: 36000.00, hwm: 36500.00, floor: 36100, halt: true })

    const a = await riskFull(s, '5203012')
    assert.equal(a.profitRatchet.state.baseline, 36000.00)
    assert.equal(a.profitRatchet.state.hwm, 36500.00)
    assert.equal(a.profitRatchet.accountId, '5203012', 'and it says whose ladder this is')

    const b = await riskFull(s, '5306502')
    assert.equal(b.profitRatchet.state.baseline, 50548.76)
    assert.equal(b.profitRatchet.state.hwm, 50653.92)

    // No account named = the selected one, exactly as before.
    const g = await riskFull(s)
    assert.equal(g.profitRatchet.state.baseline, 50548.76)
  } finally { s.close() }
})

// ---------------------------------------------------------------------------
// Phase 4 — an unsupported parameter must FAIL, not answer about something else
// ---------------------------------------------------------------------------

test('a misspelled account parameter is a 400, not a silent global answer', async () => {
  // THE AUDIT'S CENTRAL CONFUSION. The route read ?account= and ignored every
  // other parameter, so ?accountId=47790949 returned the GLOBAL config in the
  // shape of an answer about that account — which is how the Risk page could
  // show minRR 1.5 while the accounts were gated at 4.5-6.16.
  const s = await server()
  try {
    const r = await fetch(s.url('/state/risk-full?accountId=47790949'))
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.deepEqual(body.unsupported, ['accountId'])
    assert.deepEqual(body.supported, ['account'])
  } finally { s.close() }
})

test('the supported parameter still works, and nothing else is required', async () => {
  const s = await server()
  try {
    assert.equal((await fetch(s.url('/state/risk-full'))).status, 200)
    assert.equal((await fetch(s.url('/state/risk-full?account=47790949'))).status, 200)
  } finally { s.close() }
})

test('an UNKNOWN account id is labelled as such rather than reading as global truth', async () => {
  const s = await server()
  try {
    s.db.prepare("INSERT OR REPLACE INTO accounts (account_id, is_live, enabled) VALUES ('47790949', 0, 1)").run()
    const known = await riskFull(s, '47790949')
    const bogus = await riskFull(s, '99999999')
    assert.equal(known.risk.accountScope, 'account')
    assert.equal(bogus.risk.accountScope, 'unknown_account')
    assert.equal((await riskFull(s)).risk.accountScope, 'global')
  } finally { s.close() }
})

test('provenance separates the global value from the account value, per key', async () => {
  const s = await server()
  try {
    await setRisk(s, { minRR: 1.5 })
    await setRisk(s, { accountId: '47790949', minRR: 4.68 })
    const a = await riskFull(s, '47790949')
    const row = a.risk.provenance.find(p => p.key === 'minRR')
    assert.equal(row.globalValue, 1.5)
    assert.equal(row.overlayValue, 4.68)
    assert.equal(row.effectiveValue, 4.68)
    assert.equal(row.scope, 'account')
    assert.equal(row.source, 'manual', 'the write site records who wrote it')
    assert.ok(row.writtenAt, 'and when')
    assert.equal(row.reason, null, 'nothing records a reason today, and it says so')
  } finally { s.close() }
})

test('Wave 4: a global save merges into the RAW overrides — one patched key stores one key, not every default', async () => {
  const s = await server()
  try {
    await setRisk(s, { maxOpenPositions: 7 })
    const stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(Object.keys(stored), ['maxOpenPositions'], 'the store holds only what was set')
    await setRisk(s, { cooldownMinutes: 9 })
    const stored2 = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(Object.keys(stored2).sort(), ['cooldownMinutes', 'maxOpenPositions'])
    const g = await riskFull(s)
    assert.equal(g.risk.effective.maxOpenPositions, 7)
    assert.equal(g.risk.effective.cooldownMinutes, 9)
  } finally { s.close() }
})

test('Wave 4b: an object-valued key in the body PATCHES the stored object one level deep — global and overlay alike', async () => {
  const s = await server()
  try {
    // The Risk page sends the WHOLE effective object; only the field that
    // differs from the default may land in the store (checker item 4).
    await setRisk(s, { derisk: { on: true, windowHours: 24, triggerPct: 0.05, mult: 0.4 } })
    let stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(stored, { derisk: { mult: 0.4 } }, 'default sub-fields are pruned, not pinned')
    await setRisk(s, { derisk: { windowHours: 48 } })
    stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(stored, { derisk: { mult: 0.4, windowHours: 48 } }, 'the second save did not wipe the first field')
    const g = await riskFull(s)
    assert.deepEqual(g.risk.effective.derisk, { on: true, windowHours: 48, triggerPct: 0.05, mult: 0.4 })
    // per-account overlay: the same rule
    await setRisk(s, { accountId: '47790949', newsGate: { on: true } })
    await setRisk(s, { accountId: '47790949', newsGate: { minBefore: 30 } })
    const ov = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'acct:47790949:risk_config_json'").get().value)
    assert.deepEqual(ov, { newsGate: { on: true, minBefore: 30 } })
    const a = await riskFull(s, '47790949')
    assert.deepEqual(a.risk.effective.newsGate, { on: true, minBefore: 30, minAfter: 15, impacts: ['High'] })
    assert.equal(g.risk.effective.newsGate.on, false, 'the global config is untouched by the overlay')
    // a retired scalar name in the body is not a risk key and is dropped
    await setRisk(s, { deriskMult: 0.1 })
    stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.equal('deriskMult' in stored, false)
    assert.equal((await riskFull(s)).risk.effective.derisk.mult, 0.4)
  } finally { s.close() }
})

test('Wave 4b: a store that still carries legacy scalars is folded on the write path, so the object patch lands on the folded value', async () => {
  const s = await server()
  try {
    s.db.prepare("INSERT INTO agent_state (key, value) VALUES ('risk_config_json', ?)").run(JSON.stringify({ deriskMult: 0.25, symbolCooldownMinutes: 5 }))
    await setRisk(s, { derisk: { windowHours: 48 } })
    const stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    // symbolCooldownMinutes has no successor: dropped, never written into
    // cooldownMinutes (it would have rewritten the streak window).
    assert.deepEqual(stored, { derisk: { mult: 0.25, windowHours: 48 } })
  } finally { s.close() }
})

test('Wave 4b: a global save whose object equals the default leaves NO entry; `campaign` is replaced wholesale, not merged', async () => {
  const s = await server()
  try {
    await setRisk(s, { derisk: { mult: 0.4 } })
    await setRisk(s, { derisk: { on: true, windowHours: 24, triggerPct: 0.05, mult: 0.5 } })
    let stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(stored, {}, 'an object put back to its default leaves the store')
    await setRisk(s, { campaign: { maxDrawdownPct: 0.08, startEquity: 1983, startAt: '2026-08-07T00:00:00Z', label: 'old' } })
    await setRisk(s, { campaign: { maxDrawdownPct: 0.05 } })
    stored = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'risk_config_json'").get().value)
    assert.deepEqual(stored.campaign, { maxDrawdownPct: 0.05 }, 'no stale startEquity/startAt from the previous campaign')
    assert.deepEqual((await riskFull(s)).risk.effective.campaign, { maxDrawdownPct: 0.05 })
  } finally { s.close() }
})
