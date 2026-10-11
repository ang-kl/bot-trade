// node --test agent/services/strategy-autopilot-research-options.test.js
// Claude · № 13,101 11-Oct (amendment area 6, remediation R5). backtest-fib.js
// is in the LIVE closure: the strategy autopilot runs runBacktest in
// production. The research options added for the bar-form study (rStats,
// tpR, computeWindow) and the vol gate must never reach that call: the
// autopilot's output stays the golden-pinned default path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { evaluateAll } from './strategy-autopilot.js'

const RESEARCH_OPTIONS = ['rStats', 'tpR', 'computeWindow', 'volGate', 'minRr', 'minConviction']

test('the autopilot hands runBacktest the default path only: no research option, no vol gate', async () => {
  const db = initDB(':memory:')
  const bars = Array.from({ length: 400 }, (_, i) => ({ ts: i * 60_000, o: 1, h: 1, l: 1, c: 1, v: 1 }))
  const seen = []
  const deps = {
    ws: { wsGetTrendbarsBatch: async (_h, _ci, _cs, _t, _a, _sid, tfs) => Object.fromEntries(tfs.map(tf => [tf, bars])) },
    bt: {
      runBacktest: (_bars, opts) => { seen.push(opts); return { stats: { trades: 0 }, trades: [] } },
      walkForward: (_bars, opts) => { seen.push(opts); return { active: 0, positive: 0, worstMddPct: 0 } },
    },
    credsLib: { getSymbolMap: () => ({ EURUSD: 1 }) },
    remote: async () => null,
  }
  await evaluateAll(db, { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '1' }, deps)
  assert.ok(seen.length > 0, 'no backtest ran: a pin over zero calls proves nothing')
  for (const opts of seen) {
    for (const k of RESEARCH_OPTIONS) assert.equal(k in opts, false, `autopilot passed ${k}`)
    assert.deepEqual(Object.keys(opts).sort(), ['entryMode', 'strategy', 'symbol', 'timeframe'])
  }
})
