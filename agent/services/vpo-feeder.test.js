// node --test agent/services/vpo-feeder.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { runVpoFeeder as runVpoFeederReal, vpoPreArmVeto } from './vpo-feeder.js'
import { loadRiskConfig } from './risk.js'
import { admitEntry } from './entry-mode.js'

// ---------------------------------------------------------------------------
// A RETIRED PRODUCER IS REFUSED AT THE FENCE (20-09-2026, owner: "retire the
// intraday paths, keep momentum only"), and `vpo_cpp_direct` is one of them.
// The tests below exercise the feeder's own bar / sizing / permit logic, so they inject the fence
// (`deps.admit`) the same way they inject exec, risk and sizing. NOTHING
// here mutates the shared inventory: a test file that deleted the retirement
// mark on the singleton made the retirement invariant vacuous for every other
// file in the same process (`--experimental-test-isolation=none`). The real
// fence is the DEFAULT, and the last test in this file asserts the refusal it
// produces.
// ---------------------------------------------------------------------------
// The stub delegates to the REAL fence under a KEPT producer's id, so every
// mode rule (STOPPED, WARMING, the epoch) still binds exactly as in
// production and only the RETIREMENT is out of the way.
const ADMIT_AS_KEPT_PRODUCER = (db, o) => admitEntry(db, { ...o, producerId: 'daily_momentum_account' })
/** Every test here runs the feeder with the fence injected; the last one calls runVpoFeederReal. */
const runVpoFeeder = (db, deps = {}) => runVpoFeederReal(db, { admit: ADMIT_AS_KEPT_PRODUCER, ...deps })


function freshDB() { return initDB(':memory:') }

function bar(t, o, h, l, c, v = 10) { return { t, o, h, l, c, v } }

function fakeWs(bars = { '4h': [bar(0, 1, 1.1, 0.9, 1.05)], '15m': [bar(0, 1, 1.02, 0.98, 1.0)] }) {
  const calls = []
  return {
    calls,
    wsGetTrendbarsBatch: async (host, clientId, clientSecret, accessToken, accountId, symbolId, periods) => {
      calls.push({ symbolId, periods })
      return bars
    },
  }
}

// Credentials are INJECTED, never inherited from the environment. These tests
// used to set/delete process.env.CTRADER_CLIENT_ID/SECRET and rely on the rest
// being absent — which made the "not ready" case pass only on a machine with no
// CTRADER_* vars set. In the deployment container all five are set, so
// getCtraderCreds answered `ready: true`, the feeder skipped nothing and tried a
// real network push. Injecting removes the ambient dependency in both
// directions: ready and not-ready are now stated, not inherited.
const READY_CREDS = {
  ready: true,
  host: 'demo.ctraderapi.com',
  clientId: 'cid',
  clientSecret: 'csecret',
  accessToken: 'tok',
  accountId: '42',
}
const UNREADY_CREDS = { ...READY_CREDS, ready: false, accessToken: null }

function fakeSizing({ lotSize = 100 } = {}) {
  return {
    getVolumeMeta: async () => ({ lotSize, minVolume: 1, digits: 5 }),
    lotsToVolume: (lots) => ({ volume: Math.round(lots * lotSize), lots }),
  }
}

test('skips entirely when vpo_enabled is not true', async () => {
  const db = freshDB()
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing() })
  assert.match(r.skipped, /vpo_enabled/)
})

test('skips when vpo_config_json is empty', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing() })
  assert.match(r.skipped, /vpo_config_json/)
})

test('skips when cTrader credentials are not ready', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([{ key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 }]))
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: UNREADY_CREDS })
  assert.match(r.skipped, /credentials/)
})

// REGRESSION. The point of the test above is that the feeder skips; the point
// of this one is that it skips FOR THE STATED REASON and not because the
// machine happened to be bare. With every CTRADER_* var set — the deployment
// container's actual state — the old test did not skip at all: it fell through
// to a real network push and failed with `fetch failed`. Green on a laptop,
// red in the container, and the difference was ambient environment rather than
// anything about the code.
test('the credential gate ignores ambient CTRADER_* env when creds are injected', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([{ key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 }]))
  const saved = {}
  const keys = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_ACCESS_TOKEN', 'CTRADER_ACCOUNT_ID']
  for (const k of keys) { saved[k] = process.env[k]; process.env[k] = 'ambient' }
  try {
    let pushed = false
    const r = await runVpoFeeder(db, {
      ws: fakeWs(), sizing: fakeSizing(), creds: UNREADY_CREDS,
      push: async () => { pushed = true },
    })
    assert.match(r.skipped, /credentials/)
    assert.equal(pushed, false, 'a skipped pass must not push')
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})

test('pushes real bars + resolved volume for a configured entry', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1, macroTf: '4h', microTf: '15m' },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')

  let pushed = null
  const ws = fakeWs()
  const r = await runVpoFeeder(db, {
    ws, sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(ws.calls.length, 1)
  assert.deepEqual(ws.calls[0].periods, ['4h', '15m'])
  assert.ok(pushed)
  assert.equal(pushed.bars.length, 2) // one entry per timeframe
  assert.ok(pushed.bars.find(b => b.symbol === 'EURUSD' && b.timeframe === '4h'))
  assert.ok(pushed.bars.find(b => b.symbol === 'EURUSD' && b.timeframe === '15m'))
  assert.equal(pushed.volumes.length, 1)
  assert.equal(pushed.volumes[0].key, 'vwap_trend:EURUSD')
  assert.ok(pushed.volumes[0].volume > 0)

})

test('reports volume -1 (unavailable) when balance is unset, but still pushes bars', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vp_value', symbol: 'GBPUSD', symbolId: 2 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  // account_balance_usd deliberately left unset

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(pushed.volumes[0].volume, -1)

})

test('one bad entry does not stop the others from being pushed', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 },
    { key: 'broken', symbol: 'BADSYM', symbolId: 999 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')

  const ws = {
    wsGetTrendbarsBatch: async (host, clientId, clientSecret, accessToken, accountId, symbolId) => {
      if (symbolId === 999) throw new Error('broker rejected symbolId')
      return { '4h': [bar(0, 1, 1.1, 0.9, 1.05)], '15m': [bar(0, 1, 1.02, 0.98, 1.0)] }
    },
  }

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws, sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(pushed.volumes.length, 1)
  assert.equal(pushed.volumes[0].key, 'vwap_trend:EURUSD')

})

// ---------------------------------------------------------------------------
// Pre-arm risk gate (build 5 — closes audit F-L4-01/DR-1's VPO bypass)
// ---------------------------------------------------------------------------

test('vpoPreArmVeto: passes clean state (no guards, no positions, no news)', () => {
  const db = freshDB()
  assert.equal(vpoPreArmVeto(db, loadRiskConfig(db), 'EURUSD'), null)
})

test('vpoPreArmVeto: global halt vetoes', () => {
  const db = freshDB()
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))
  assert.match(vpoPreArmVeto(db, loadRiskConfig(db), 'EURUSD'), /global_halt/)
})

test('vpoPreArmVeto: open trade on the symbol vetoes (no stacking)', () => {
  const db = freshDB()
  db.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'open')`).run()
  assert.match(vpoPreArmVeto(db, loadRiskConfig(db), 'EURUSD'), /duplicate_symbol/)
  // Other symbols are unaffected
  assert.equal(vpoPreArmVeto(db, loadRiskConfig(db), 'GBPUSD'), null)
})

test('vpoPreArmVeto: active monitored position on the symbol vetoes', () => {
  const db = freshDB()
  db.prepare(`INSERT INTO monitored_positions (symbol, status) VALUES ('USDJPY', 'active')`).run()
  assert.match(vpoPreArmVeto(db, loadRiskConfig(db), 'USDJPY'), /duplicate_symbol/)
})

test('vpoPreArmVeto: news window vetoes when the gate is enabled, not when disabled', () => {
  const db = freshDB()
  setState(db, 'news_calendar_json', JSON.stringify([
    { title: 'NFP', country: 'USD', impact: 'High', date: new Date().toISOString() },
  ]))
  setState(db, 'news_calendar_fetched_ms', String(Date.now()))
  const cfg = loadRiskConfig(db)
  assert.match(vpoPreArmVeto(db, { ...cfg, newsGate: { ...cfg.newsGate, on: true } }, 'EURUSD'), /news_window/)
  assert.equal(vpoPreArmVeto(db, { ...cfg, newsGate: { ...cfg.newsGate, on: false } }, 'EURUSD'), null)
})

test('vpoPreArmVeto: margin-level floor vetoes on a fresh low snapshot, fails open on stale', () => {
  const db = freshDB()
  setState(db, 'ctrader_account_id', '42')
  const cfg = { ...loadRiskConfig(db), marginLevelFloorPct: 150 }
  setState(db, 'acct:42:broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date().toISOString(),
    account: { accountId: '42', health: { marginLevelPct: 120 } },
  }))
  assert.match(vpoPreArmVeto(db, cfg, 'EURUSD'), /margin_level_floor/)

  // Healthy level → pass
  setState(db, 'acct:42:broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date().toISOString(),
    account: { accountId: '42', health: { marginLevelPct: 400 } },
  }))
  assert.equal(vpoPreArmVeto(db, cfg, 'EURUSD'), null)

  // Stale low snapshot → fail open (same convention as the main gate)
  setState(db, 'acct:42:broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    account: { accountId: '42', health: { marginLevelPct: 120 } },
  }))
  assert.equal(vpoPreArmVeto(db, cfg, 'EURUSD'), null)
})

test('VPO margin and duplicate checks use the execution account, not the selected account', t => {
  const db = freshDB(); t.after(() => db.close())
  setState(db, 'ctrader_account_id', '11')
  const cfg = { ...loadRiskConfig(db), marginLevelFloorPct: 150 }
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: '11', health: { marginLevelPct: 1 } } }))
  db.prepare("INSERT INTO trades (symbol, status, account_id) VALUES ('EURUSD', 'open', '11')").run()
  assert.equal(vpoPreArmVeto(db, cfg, 'EURUSD', '42'), null)
  setState(db, 'acct:42:broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: '42', health: { marginLevelPct: 0 } } }))
  assert.match(vpoPreArmVeto(db, cfg, 'EURUSD', '42'), /margin_level_floor/)
  db.prepare("INSERT INTO monitored_positions (symbol, status, account_id) VALUES ('EURUSD', 'active', '42')").run()
  assert.match(vpoPreArmVeto(db, cfg, 'EURUSD', '42'), /duplicate_symbol/)
})

test('VPO cannot size the execution account from a selected or global balance', async t => {
  const db = freshDB(); t.after(() => db.close())
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([{ key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 }]))
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '900000')
  setState(db, 'acct:11:account_balance_usd', '900000')
  const pushes = []
  const deps = { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async p => pushes.push(p) }
  await runVpoFeeder(db, deps)
  assert.equal(pushes.at(-1).volumes[0].volume, -1, 'no account-owned balance means no VPO size')
  setState(db, 'acct:42:account_balance_usd', '10000')
  await runVpoFeeder(db, deps)
  assert.ok(pushes.at(-1).volumes[0].volume > 0)
  assert.equal(pushes.at(-1).ctidTraderAccountId, 42)
  setState(db, 'acct:42:risk_config_json', JSON.stringify({ marginLevelFloorPct: 500 }))
  setState(db, 'acct:42:broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: '42', health: { marginLevelPct: 400 } } }))
  await runVpoFeeder(db, deps)
  assert.equal(pushes.at(-1).volumes[0].volume, -1, 'the execution account overlay supplies its own floor')
})

test('feeder: a vetoed symbol pushes volume -1 (bars still pushed) and records a risk event', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')
  setState(db, 'global_guards_json', JSON.stringify({ halt: true }))

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(pushed.bars.length, 2) // strategies stay fresh — bars still flow
  assert.equal(pushed.volumes.length, 1)
  assert.equal(pushed.volumes[0].key, 'vwap_trend:EURUSD')
  assert.equal(pushed.volumes[0].volume, -1) // the C++ fire site hard-refuses this

  const ev = db.prepare(
    `SELECT * FROM risk_events WHERE veto_reason LIKE 'vpo_pre_arm%' ORDER BY id DESC LIMIT 1`
  ).get()
  assert.ok(ev, 'risk event recorded')
  assert.equal(ev.approved, 0)
  assert.match(ev.veto_reason, /global_halt/)

})

test('feeder: an unvetoed symbol still sizes normally with the gate present', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.ok(pushed.volumes[0].volume > 0)

})

// P1b (11-09-2026): the ARMING fence — a STOPPED account is never pushed to
// the C++ VPO tier, so the tier cannot fire what it was never told to hold.
test('AUDIT 11-09-2026: pushVpoDisarm pushes once per (account, epoch), releases the standing permits, and forgets a FAILED push so the next caller retries', async () => {
  const db = freshDB()
  const { pushVpoDisarm, _resetDisarmPushedForTests } = await import('./vpo-feeder.js')
  _resetDisarmPushedForTests()
  const pushes = []
  let fail = true
  const push = async (payload, base) => { if (fail) throw new Error('sidecar 502'); pushes.push({ payload, base }) }
  const bad = await pushVpoDisarm(db, '42', 'http://demo:8081', { reason: 'entry_mode STOPPED', epoch: 5, push })
  assert.equal(bad.ok, false); assert.match(bad.error, /502/); assert.equal(pushes.length, 0)
  fail = false
  const good = await pushVpoDisarm(db, '42', 'http://demo:8081', { reason: 'entry_mode STOPPED', epoch: 5, push })
  assert.equal(good.ok, true); assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].payload, { disarm: true, ctidTraderAccountId: 42, reason: 'entry_mode STOPPED' }); assert.equal(pushes[0].base, 'http://demo:8081')
  const again = await pushVpoDisarm(db, '42', 'http://demo:8081', { reason: 'entry_mode STOPPED', epoch: 5, push })
  assert.equal(again.skipped, 'already pushed for this epoch'); assert.equal(pushes.length, 1)
  const next = await pushVpoDisarm(db, '42', 'http://demo:8081', { reason: 'entry_mode TICK_MOMENTUM', epoch: 6, push })
  assert.equal(next.ok, true); assert.equal(pushes.length, 2, 'a new epoch is a new disarm')
})

test('feeder: a STOPPED account is not armed — no /vpo-config push, the reason names the fence', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1, macroTf: '4h', microTf: '15m' },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')
  const { upsertAccount } = await import('./account-registry.js')
  const { requestEntryMode } = await import('./entry-mode.js')
  upsertAccount(db, { accountId: '42', isLive: false })
  assert.equal(requestEntryMode(db, '42', 'STOPPED').ok, true)

  let pushed = null
  const { _resetDisarmPushedForTests } = await import('./vpo-feeder.js')
  _resetDisarmPushedForTests()
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(r.skipped, 'entry_mode: entry_mode_stopped'); assert.equal(r.disarmed, true)
  // P2a: not "nothing pushed" — the DISARM is pushed, so the sidecar drops
  // the arming it already held instead of keeping it until the store ages
  // it out (the measured 5-minute residue of the P1b fence).
  assert.deepEqual(pushed, { disarm: true, ctidTraderAccountId: 42, reason: 'entry_mode_stopped' })
  pushed = null
  const rAgain = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(rAgain.disarmed, true); assert.equal(pushed, null, 'one disarm per (account, epoch)')

  // Back to TIME_BASED, acknowledged by the gateway (11-09-2026): the push resumes.
  assert.equal(requestEntryMode(db, '42', 'TIME_BASED', { expectedRevision: 1 }).ok, true)
  const { acknowledgeEntryEpochs } = await import('./entry-mode.js')
  assert.equal(acknowledgeEntryEpochs(db, { 42: 2 }).length, 1)
  const r2 = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(r2.ok, true)
  assert.ok(pushed && pushed.ctidTraderAccountId === 42)
})

// P2a-2: the push carries the keeper's pre-issued permits, one per armed
// strategy and side; the disarm releases them.
test('feeder: the push carries two permits per sized strategy, reused on the next push, and the disarm releases them', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1, macroTf: '4h', microTf: '15m' },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')
  const { upsertAccount } = await import('./account-registry.js')
  const { requestEntryMode } = await import('./entry-mode.js')
  const { _resetDisarmPushedForTests } = await import('./vpo-feeder.js')
  upsertAccount(db, { accountId: '42', isLive: false })
  _resetDisarmPushedForTests()
  let pushed = null
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(r.ok, true); assert.equal(r.permits, 2)
  assert.deepEqual(pushed.permits.map(p => [p.key, p.symbol, p.side]), [['vwap_trend', 'EURUSD', 'BUY'], ['vwap_trend', 'EURUSD', 'SELL']])
  const permit = pushed.permits[0].permit
  assert.equal(permit.accountId, 42, 'numeric on the wire: the sidecar reads it with asNumber (RACE CHECKER 11-09-2026)'); assert.equal(permit.symbolId, 1); assert.equal(permit.epoch, 0); assert.ok(permit.volume > 0); assert.match(permit.id, /^p/)
  assert.equal(permit.volume, pushed.volumes[0].volume, 'bound to the sized volume the sidecar was given')
  const open = db.prepare(`SELECT id, state, producer_id FROM entry_intents WHERE account_id = '42'`).all()
  assert.equal(open.length, 2); assert.ok(open.every(o => o.state === 'RESERVED' && o.producer_id === 'vpo_cpp_direct'))
  const r2 = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(r2.permits, 2)
  assert.deepEqual(pushed.permits.map(p => p.permit.intentId).sort(), open.map(o => o.id).sort(), 'the same standing permits, refreshed')
  // STOPPED: the disarm releases what it authorised
  requestEntryMode(db, '42', 'STOPPED')
  await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS, push: async (payload) => { pushed = payload } })
  assert.equal(pushed.disarm, true)
  // the switch itself released the unsent old-epoch reservations (plan §3
  // step 1, epoch_stale); the disarm's own release finds nothing left — either
  // way no standing permit survives a STOPPED account
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE account_id = '42' AND state = 'RELEASED'`).get().n, 2)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE account_id = '42' AND state = 'RESERVED'`).get().n, 0)
})

test('the injected fence is a test fixture, not a hole: through the REAL fence the feeder arms nothing — the producer is retired', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([{ key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 }]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'acct:42:account_balance_usd', '10000')
  let pushed = null
  // The REAL fence (no deps.admit): the inventory's retirement stands.
  const r = await runVpoFeederReal(db, {
    ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })
  assert.match(String(r.skipped), /^entry_mode: producer_retired: vpo_cpp_direct/)
  assert.equal(r.disarmed, true, 'the previous arming is cleared, not left to age out')
  assert.ok(!pushed?.bars, 'no config push carries bars for a retired producer')
})
