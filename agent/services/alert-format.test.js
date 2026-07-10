// node --test agent/services/alert-format.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtPrice, tradePrice, formatAnalysisAlert } from './alert-format.js'

test('fmtPrice: max 4 decimals, coarser as price grows, no float noise', () => {
  assert.equal(fmtPrice(0.5757097999999999), '0.5757')
  assert.equal(fmtPrice(1.1424998000000002), '1.1425')
  assert.equal(fmtPrice(29693.44), '29693.4')
  assert.equal(fmtPrice(153.2489999), '153.25')
  assert.equal(fmtPrice(null), '—')
})

test('tradePrice: owner rounding — indices to tens, fx to 4dp, broker digits cap', () => {
  assert.equal(tradePrice(68826.76667), 68830)   // JPN225 → tens
  assert.equal(tradePrice(29693.44), 29690)      // NAS100 → tens
  assert.equal(tradePrice(4093.92), 4094)        // gold → whole
  assert.equal(tradePrice(153.24899), 153.25)    // JPY pairs → 2dp
  assert.equal(tradePrice(1.33383162), 1.3338)   // FX majors → 4dp
  assert.equal(tradePrice(1.33383162, 3), 1.334) // broker cap wins when tighter
})

const synth = { consensus_bias: 'long', overall_conviction: 7, synthesis: '61.8% fade', entry: 0.57707, sl: 0.5757097999999999, tp1: 0.57929, timeframe: '30m' }

test('alert explains why the bot will NOT act and what the human can do', () => {
  const msg = formatAnalysisAlert({}, { sym: 'NZDUSD', synth, signal: { timeframe: '30m' }, armed: { autotrade: true, tfs: ['1d'], matrix: null } })
  assert.match(msg, /Bot will NOT act: 30m is not armed/)
  assert.match(msg, /\/arm fib_618_fade NZDUSD 30m/)
  assert.match(msg, /R:R/)
  assert.ok(!msg.includes('0.5757097999999999'), 'no float noise')
  assert.match(msg, /market/i)
})

test('armed + conviction >= 8 says the bot WILL act', () => {
  const s2 = { ...synth, overall_conviction: 9 }
  const msg = formatAnalysisAlert({}, { sym: 'NZDUSD', synth: s2, signal: { timeframe: '30m' }, armed: { autotrade: true, matrix: { NZDUSD: ['30m'] } } })
  assert.match(msg, /BOT WILL ACT/)
})
