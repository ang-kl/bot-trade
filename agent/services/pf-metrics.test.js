// agent/services/pf-metrics.test.js — V3 Q4b (PR-B1): the two profit-factor
// metrics every bar-side figure is labelled with. r-net-v1 is ONE function
// (the one /state/basis-performance defines), its summary is portfolioStats'
// arithmetic, and usd-net-v0 is frozen and pinned like r-net-v1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { netRof, summarizeR, summarizeUsd, R_NET_METRIC_ID, USD_NET_METRIC, PF_METRICS } from './pf-metrics.js'
import { METRIC_DEFINITION } from './basis-performance.js'
import { portfolioStats } from './tick-shadow.js'

test('the R metric id is basis-performance\'s METRIC_DEFINITION id; the money metric is frozen and pinned', () => {
  assert.equal(R_NET_METRIC_ID, METRIC_DEFINITION.id)
  assert.equal(Object.isFrozen(USD_NET_METRIC), true)
  assert.deepEqual(Object.entries(USD_NET_METRIC), Object.entries({
    id: 'usd-net-v0',
    unit: "net_pnl as stored, in the account's own currency (summed as stored, never converted)",
    win: 'net_pnl > 0',
    loss: 'net_pnl < 0 (0 is neither)',
    profitFactor: 'Σ winning net_pnl / |Σ losing net_pnl|, 2 dp; null with no losing close; 0 with no close',
  }))
  assert.deepEqual({ ...PF_METRICS }, { profitFactor: 'usd-net-v0', profitFactorR: 'r-net-v1' })
})

test('summarizeR is portfolioStats\' arithmetic (PF, wins, losses, sums) on the same closes, and counts the unscored', () => {
  const rs = [2, -1, -1, 1.5, -1, 3, -1, 0.5, -1, -1, 0, -0.25]
  const s = summarizeR([...rs.map(netR => ({ netR, unscorableAs: null })), { netR: null, unscorableAs: 'scratchCost' }, { netR: null, unscorableAs: 'suspectExit' }, { netR: null }])
  const p = portfolioStats(rs.map(net_r => ({ net_r, reason: 'closed' })))
  assert.equal(s.scored, p.trades)
  assert.equal(s.wins, p.wins)
  assert.equal(s.losses, p.losses)
  assert.equal(s.grossWinR, p.grossWinR)
  assert.equal(s.grossLossR, p.grossLossR)
  assert.equal(s.netR, p.netR)
  assert.equal(s.profitFactor, p.profitFactor)
  assert.deepEqual(s.unscorableBy, { noR: 1, scratchCost: 1, suspectExit: 1 })
  assert.equal(s.unscorable, 3)
  assert.equal(summarizeR([{ netR: 1 }]).lossless, true)
  assert.equal(summarizeR([{ netR: 1 }]).profitFactor, null)
})

test('netRof: net R when money and prices agree; gross R kept on a sign disagreement; the unscored reasons', () => {
  const base = { side: 'BUY', entry_price: 1.1, exit_price: 1.12, sl_price: 1.09 }
  assert.equal(netRof({ ...base, realised_rr: 2, net_pnl: 90, gross_pnl: 100 }).netR, 1.8)
  assert.equal(netRof({ ...base, realised_rr: 2, net_pnl: -10, gross_pnl: -100 }).rBasis, 'gross')
  assert.equal(netRof({ ...base, realised_rr: 0, net_pnl: -3, gross_pnl: 0 }).unscorableAs, 'scratchCost')
  assert.equal(netRof({ ...base, realised_rr: 2, exit_price_suspect: 1 }).unscorableAs, 'suspectExit')
  assert.equal(netRof({ side: 'BUY', entry_price: 1.1, exit_price: 1.12, sl_price: null, net_pnl: 5 }).unscorableAs, 'noR')
})

test('summarizeUsd is the evidence gate\'s money arithmetic: 2 dp, null with no loss, 0 with no close', () => {
  assert.deepEqual(summarizeUsd([30, 30, -10, -10, -10]), { closes: 5, wins: 2, losses: 3, grossWinUsd: 60, grossLossUsd: 30, winRate: 40, profitFactor: 2, net: 30 })
  assert.equal(summarizeUsd([10]).profitFactor, null)
  assert.equal(summarizeUsd([]).profitFactor, 0)
})
