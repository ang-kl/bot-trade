// node --test agent/services/tp-suggest.test.js
//
// The suggester behind the targetless alert's Set-TP button. The rules that
// matter: HVN candidate when the profile supports one, R:R-floor price when
// it does not, and NULL (never a throw, never a block) when the position
// cannot be priced at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeTargetSuggester } from './tp-suggest.js'

const CREDS = { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '1' }
const finding = (o = {}) => ({ positionId: '555', symbol: 'ETHUSD', brokerSl: 1700, ...o })
const brokerPos = (o = {}) => ({ positionId: '555', tradeData: { openPrice: 1800, tradeSide: 'BUY' }, ...o })

// A flat 15m series clustered near one price level yields an HVN node there.
// Volume mass sits at ~1960 — above the long entry at 1800 AND far enough
// (1.6R against the 100-point stop) to clear the 1.5R floor, since a node
// below the floor is correctly suppressed, not rounded up.
function clusteredBars() {
  const bars = []
  for (let i = 0; i < 240; i++) {
    const nearNode = i % 3 !== 0
    const c = nearNode ? 1960 + (i % 5) : 1820 + (i % 7)
    bars.push({ t: i, o: c - 1, h: c + 2, l: c - 2, c, v: nearNode ? 900 : 80 })
  }
  return bars
}

test('with volume structure: suggests the HVN price with an R-multiple basis', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [brokerPos()], {
    symbolMap: { ETHUSD: 41 },
    fetchBars: async () => ({ '15m': clusteredBars() }),
  })
  const s = await suggest(finding())
  assert.ok(s, 'a clustered profile above entry must produce a suggestion')
  assert.ok(s.tp > 1800, `long target must sit above entry, got ${s.tp}`)
  assert.match(s.basis, /HVN volume node, [\d.]+R/)
})

test('no bars: falls back to the R:R-floor price, correctly rounded', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [brokerPos()], {
    symbolMap: { ETHUSD: 41 },
    fetchBars: async () => ({ '15m': [] }),
  })
  const s = await suggest(finding())
  // entry 1800, sl 1700 → distance 100, default floor 1.5 → 1950 long
  assert.equal(s.tp, 1950)
  assert.match(s.basis, /1.5R floor from entry/)
})

test('short direction: floor target sits BELOW entry', async () => {
  const suggest = makeTargetSuggester(null, CREDS,
    [brokerPos({ tradeData: { openPrice: 1800, tradeSide: 'SELL' } })], {
      symbolMap: { ETHUSD: 41 },
      fetchBars: async () => ({ '15m': [] }),
    })
  const s = await suggest(finding({ brokerSl: 1900 }))
  assert.equal(s.tp, 1650) // 1800 − 1.5 × 100
})

test('a bars fetch that throws still yields the floor suggestion', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [brokerPos()], {
    symbolMap: { ETHUSD: 41 },
    fetchBars: async () => { throw new Error('broker down') },
  })
  const s = await suggest(finding())
  assert.equal(s.tp, 1950, 'structure unavailable must not cost the fallback')
})

test('null on the unpriceable: unknown position, missing entry, sl == entry', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [brokerPos()], {
    symbolMap: { ETHUSD: 41 }, fetchBars: async () => ({ '15m': [] }),
  })
  assert.equal(await suggest(finding({ positionId: '999' })), null)
  const noEntry = makeTargetSuggester(null, CREDS, [{ positionId: '555', tradeData: {} }], {
    symbolMap: { ETHUSD: 41 }, fetchBars: async () => ({ '15m': [] }),
  })
  assert.equal(await noEntry(finding()), null)
  assert.equal(await suggest(finding({ brokerSl: 1800 })), null, 'sl at entry has no distance to price against')
})

test('fractional prices round to the wider of entry/stop precision', async () => {
  const suggest = makeTargetSuggester(null, CREDS,
    [brokerPos({ tradeData: { openPrice: 1.2731, tradeSide: 'BUY' } })], {
      symbolMap: { ETHUSD: 41 }, fetchBars: async () => ({ '15m': [] }),
    })
  const s = await suggest(finding({ brokerSl: 1.2681 }))
  assert.equal(s.tp, 1.2806) // 1.2731 + 1.5 × 0.005, 4dp — no float noise
})
