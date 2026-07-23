// node --test agent/services/vpo-feeder.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { runVpoFeeder } from './vpo-feeder.js'

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
  const r = await runVpoFeeder(db, { ws: fakeWs(), sizing: fakeSizing() })
  assert.match(r.skipped, /credentials/)
})

test('pushes real bars + resolved volume for a configured entry', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vwap_trend', symbol: 'EURUSD', symbolId: 1, macroTf: '4h', microTf: '15m' },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  process.env.CTRADER_CLIENT_ID = 'cid'
  process.env.CTRADER_CLIENT_SECRET = 'csecret'
  setState(db, 'account_balance_usd', '10000')

  let pushed = null
  const ws = fakeWs()
  const r = await runVpoFeeder(db, {
    ws, sizing: fakeSizing(),
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

  delete process.env.CTRADER_CLIENT_ID
  delete process.env.CTRADER_CLIENT_SECRET
})

test('reports volume -1 (unavailable) when balance is unset, but still pushes bars', async () => {
  const db = freshDB()
  setState(db, 'vpo_enabled', 'true')
  setState(db, 'vpo_config_json', JSON.stringify([
    { key: 'vp_value', symbol: 'GBPUSD', symbolId: 2 },
  ]))
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '42')
  process.env.CTRADER_CLIENT_ID = 'cid'
  process.env.CTRADER_CLIENT_SECRET = 'csecret'
  // account_balance_usd deliberately left unset

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws: fakeWs(), sizing: fakeSizing(),
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(pushed.volumes[0].volume, -1)

  delete process.env.CTRADER_CLIENT_ID
  delete process.env.CTRADER_CLIENT_SECRET
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
  process.env.CTRADER_CLIENT_ID = 'cid'
  process.env.CTRADER_CLIENT_SECRET = 'csecret'
  setState(db, 'account_balance_usd', '10000')

  const ws = {
    wsGetTrendbarsBatch: async (host, clientId, clientSecret, accessToken, accountId, symbolId) => {
      if (symbolId === 999) throw new Error('broker rejected symbolId')
      return { '4h': [bar(0, 1, 1.1, 0.9, 1.05)], '15m': [bar(0, 1, 1.02, 0.98, 1.0)] }
    },
  }

  let pushed = null
  const r = await runVpoFeeder(db, {
    ws, sizing: fakeSizing(),
    push: async (payload) => { pushed = payload },
  })

  assert.equal(r.ok, true)
  assert.equal(pushed.volumes.length, 1)
  assert.equal(pushed.volumes[0].key, 'vwap_trend:EURUSD')

  delete process.env.CTRADER_CLIENT_ID
  delete process.env.CTRADER_CLIENT_SECRET
})
