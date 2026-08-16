// node --test agent/services/vpo-feeder.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { runVpoFeeder, vpoPreArmVeto } from './vpo-feeder.js'
import { loadRiskConfig } from './risk.js'

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
  setState(db, 'account_balance_usd', '10000')

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
  setState(db, 'account_balance_usd', '10000')

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
  assert.match(vpoPreArmVeto(db, { ...cfg, newsGateEnabled: true }, 'EURUSD'), /news_window/)
  assert.equal(vpoPreArmVeto(db, { ...cfg, newsGateEnabled: false }, 'EURUSD'), null)
})

test('vpoPreArmVeto: margin-level floor vetoes on a fresh low snapshot, fails open on stale', () => {
  const db = freshDB()
  const cfg = { ...loadRiskConfig(db), marginLevelFloorPct: 150 }
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date().toISOString(),
    account: { health: { marginLevelPct: 120 } },
  }))
  assert.match(vpoPreArmVeto(db, cfg, 'EURUSD'), /margin_level_floor/)

  // Healthy level → pass
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date().toISOString(),
    account: { health: { marginLevelPct: 400 } },
  }))
  assert.equal(vpoPreArmVeto(db, cfg, 'EURUSD'), null)

  // Stale low snapshot → fail open (same convention as the main gate)
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    account: { health: { marginLevelPct: 120 } },
  }))
  assert.equal(vpoPreArmVeto(db, cfg, 'EURUSD'), null)
})

test('feeder: a vetoed symbol pushes volume -1 (bars still pushed) and records a risk event', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'account_balance_usd', '10000')
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
  setState(db, 'account_balance_usd', '10000')

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws: fakeWs(), sizing: fakeSizing(), creds: READY_CREDS,
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.ok(pushed.volumes[0].volume > 0)

})
