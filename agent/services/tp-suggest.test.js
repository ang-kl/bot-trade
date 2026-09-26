// node --test agent/services/tp-suggest.test.js
//
// The suggester behind the targetless alert's Set-TP button. The rules that
// matter: HVN candidate when the profile supports one, R:R-floor price when
// it does not, and NULL (never a throw, never a block) when the position
// cannot be priced at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeTargetSuggester, makeTargetApplier, sideIsLong } from './tp-suggest.js'

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

// ---------------------------------------------------------------------------
// THE APPLIER: cTrader's amend REPLACES protection.
//
// Everything about this path is safe only if the stop survives the write. The
// applier is now reachable from the 60-second sweep as well as the loop, so
// the stop's survival stops being a property of a rarely-taken branch.
// ---------------------------------------------------------------------------

test('THE STOP IS CARRIED: the amend re-sends the broker stop unchanged alongside the target', async () => {
  const { makeTargetApplier } = await import('./tp-suggest.js')
  const seen = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async (_c, args) => { seen.push(args); return { executionType: 'ORDER_REPLACED', position: {} } },
    recordEvent: () => {},
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding({ brokerSl: 1723.26 }), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].stopLoss, 1723.26, 'the stop that was there is the stop that is sent')
  assert.equal(seen[0].takeProfit, 1900)
  assert.equal(seen[0].positionId, '555')
  // Nothing else may reach the broker from here — no size, no side, no close.
  assert.deepEqual(Object.keys(seen[0]).sort(), ['positionId', 'stopLoss', 'takeProfit'])
})

test('NO STOP KNOWN, NO AMEND: a TP-only write would clear the stop and make it naked', async () => {
  // `stopLoss: undefined` reaches wsAmendPosition as absent, and amend
  // replaces — this module's own defect, inverted. Targetless findings always
  // carry a stop today, which is exactly why this has to be a refusal rather
  // than an assumption about a caller.
  const { makeTargetApplier } = await import('./tp-suggest.js')
  const seen = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async (_c, args) => { seen.push(args); return { executionType: 'ORDER_REPLACED' } },
    recordEvent: () => {},
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  for (const sl of [null, undefined, 0, NaN, 'x']) {
    const r = await apply(finding({ brokerSl: sl }), { tp: 1900, basis: 'HVN' })
    assert.equal(r.ok, false, `brokerSl=${String(sl)} must refuse`)
    assert.match(r.error, /no stop known at the broker/)
  }
  assert.deepEqual(seen, [], 'nothing was sent to the broker')
})

test('a broker error is reported, not swallowed, and never reads as applied', async () => {
  const { makeTargetApplier } = await import('./tp-suggest.js')
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async () => ({ error: 'MARKET_CLOSED' }),
    recordEvent: () => {},
    readPosition: async () => ({ positionId: '555', stopLoss: 1700, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /MARKET_CLOSED/)
})

test('a journal that throws does not undo the amend', async () => {
  const { makeTargetApplier } = await import('./tp-suggest.js')
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async () => ({ executionType: 'ORDER_REPLACED' }),
    recordEvent: () => { throw new Error('db locked') },
    readPosition: async () => ({ positionId: '555', stopLoss: 1700, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  assert.equal((await apply(finding(), { tp: 1900, basis: 'HVN' })).ok, true)
})

// ---------------------------------------------------------------------------
// THE STOP RACE (16-09-2026, review).
//
// `finding.brokerSl` is captured by reconcile() at the top of the sweep. By the
// time the amend goes out, the pass has walked the account loop and up to N
// sequential bar fetches at a 15s timeout each. The profit keeper's ratchet
// runs on its own band. Amend REPLACES. The header used to claim this path
// "cannot move a stop"; under concurrency it could widen one.
// ---------------------------------------------------------------------------

const applierWith = (over = {}) => {
  const seen = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async (_c, args) => { seen.push(args); return { executionType: 'ORDER_REPLACED' } },
    recordEvent: () => {},
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: null, tradeData: { tradeSide: 1 } }),
    ...over,
  })
  return { apply, seen }
}

test('A RATCHETED STOP IS NOT WIDENED BACK: the FRESH read wins over the snapshot', async () => {
  const { apply, seen } = applierWith({
    // The keeper tightened the stop from 1700 to 1780 while the bars loaded.
    readPosition: async () => ({ positionId: '555', stopLoss: 1780, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, true)
  assert.equal(seen[0].stopLoss, 1780, 'the stale, WIDER snapshot value must never be written back')
})

test('a fresh read that FAILS refuses the amend — an uncertain stop is not amended around', async () => {
  const { apply, seen } = applierWith({ readPosition: async () => { throw new Error('ws timeout') } })
  const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /could not re-read the position/)
  assert.deepEqual(seen, [])
})

test('a position gone from the fresh read is not amended', async () => {
  const { apply, seen } = applierWith({ readPosition: async () => null })
  const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not in the fresh broker read/)
  assert.deepEqual(seen, [])
})

test('a stop that has VANISHED between the snapshot and the amend refuses', async () => {
  // Sending a TP here would leave the position naked — this module's own
  // defect, inverted, arriving through the race instead of through bad data.
  for (const stopLoss of [null, 0, undefined]) {
    const { apply, seen } = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss, takeProfit: null, tradeData: { tradeSide: 1 } }) })
    const r = await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
    assert.equal(r.ok, false, `stopLoss=${String(stopLoss)}`)
    assert.match(r.error, /now holds no usable stop/)
    assert.deepEqual(seen, [])
  }
})

test('a target that appeared in the meantime is not overwritten', async () => {
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: 1888, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /already holds a take profit at 1888/)
  assert.deepEqual(seen, [], 'another controller got there first')
})

test('THE REAL FAILURE SHAPE: {alreadyClosed} carries no `error` key and must not read as applied', async () => {
  // `wsAmendPosition` returns exactly this literal for POSITION_NOT_FOUND. The
  // first draft tested `res.error` alone, so it returned ok:true, printed
  // `target SET` and journalled a tp_moved event against a CLOSED position.
  // The test that "covered" it used `{error: 'POSITION_NOT_FOUND'}` — a shape
  // the real amend never returns, green for the wrong reason.
  const journal = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async () => ({ alreadyClosed: true, reason: 'position closed before amend reached broker', rawError: 'POSITION_NOT_FOUND' }),
    recordEvent: (...a) => journal.push(a),
    readPosition: async () => ({ positionId: '555', stopLoss: 1700, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /closed before the amend reached the broker/)
  assert.deepEqual(journal, [], 'no tp_moved event for a position that no longer exists')
})

test('a bare rawError, or nothing at all, is a failure too', async () => {
  for (const res of [{ rawError: 'CH_ERROR' }, null, undefined]) {
    const apply = makeTargetApplier(null, CREDS, {
      amendPosition: async () => res,
      recordEvent: () => {},
      readPosition: async () => ({ positionId: '555', stopLoss: 1700, takeProfit: null, tradeData: { tradeSide: 1 } }),
    })
    assert.equal((await apply(finding(), { tp: 1900, basis: 'HVN' })).ok, false, JSON.stringify(res))
  }
})

// ---------------------------------------------------------------------------
// THE RE-READ MUST BE LIVE (17-09-2026, second review).
//
// The first fix injected `exec.reconcile` as the "fresh" read — the same
// function that produced the snapshot. In cpp mode (production) that POSTs
// `/positions` to the sidecar, which returns `lastReconcileJson`: a string
// refreshed only by the sidecar's own 30-second loop, never by an amend. So the
// read handed back the snapshot it was meant to doubt, and a stop the profit
// keeper had ratcheted earlier in the SAME 60s band was written back wider.
// `lib/fill-anchor.test.js` already pins this rule for fills.
// ---------------------------------------------------------------------------

test('THE CACHE SCENARIO: a stale read that agrees with the snapshot cannot widen the broker stop', async () => {
  // Reproduces the measured sequence. The cache says 1.05 and so does the
  // snapshot; the broker actually holds the ratcheted 1.09. Whatever this path
  // sends, it must not be 1.05.
  const CACHE = { positionId: '555', stopLoss: 1.05, takeProfit: null, tradeData: { tradeSide: 1 } }
  const seen = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async (_c, args) => { seen.push(args); return { executionType: 'ORDER_REPLACED' } },
    recordEvent: () => {},
    readPosition: async () => CACHE,          // the sidecar cache, 25s old
  })
  const r = await apply(finding({ brokerSl: 1.05 }), { tp: 1.2, basis: 'HVN' })
  // It cannot detect the staleness from here — that is the live read's job —
  // but it must never send a value it cannot distinguish from a widen.
  assert.equal(r.ok, true)
  assert.equal(seen[0].stopLoss, 1.05, 'the identity write of the cache is all this layer can see')
  // ...which is exactly why the DEFAULT read is the live one. Pinned below.
})

test('THE DEFAULT READ RESOLVES TO ctrader-ws, NOT to any other module', async () => {
  // THIS PIN USED TO CHECK THE IDENTIFIER, NOT THE MODULE (17-09-2026, third
  // review). It asserted `/wsReconcile/` against the source; a checker replaced
  // the reader with `const { sidecarCachedPositions: wsReconcile } = await
  // import('../lib/cache-read.js')` and all 27 tests stayed green. Its own
  // comment claimed "a behavioural pin, not a source scan" while the body read
  // `import.meta.url`.
  //
  // So: assert the SPECIFIER. Whatever the binding is called, the default
  // reader may only import from `../lib/ctrader-ws.js` — an alias, a re-export
  // or a helper wrapping the sidecar all change that string.
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(new URL('./tp-suggest.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// wsReconcile'), false, 'comment stripper works')
  const readerBlock = src.slice(src.indexOf('const read = readPosition'), src.indexOf('const amend = amendPosition'))
  assert.ok(readerBlock.length > 0, "the reader block anchor is gone — this test proves nothing")

  const specifiers = [...readerBlock.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  assert.deepEqual(specifiers, ['../lib/ctrader-ws.js'],
    'the default re-read may only come from the live WS module — an alias or a wrapper is how the cache got back in')

  // And the live module really does export that name, so the specifier is not
  // pointing somewhere that would fail at runtime.
  const ws = await import('../lib/ctrader-ws.js')
  assert.equal(typeof ws.wsReconcile, 'function')
})

test('the module pin can fail: an aliased cache import is caught', () => {
  // The exact mutation that survived the previous version of this test.
  const aliased = "const read = readPosition ?? (async () => {\n" +
    "  const { sidecarCachedPositions: wsReconcile } = await import('../lib/cache-read.js')\n" +
    "  const rec = await wsReconcile(creds)\n" +
    "})\nconst amend = amendPosition"
  const block = aliased.slice(aliased.indexOf('const read = readPosition'), aliased.indexOf('const amend = amendPosition'))
  const specifiers = [...block.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  assert.notDeepEqual(specifiers, ['../lib/ctrader-ws.js'],
    'the identifier is unchanged; only the specifier tells you where it came from')
})

test('NEVER WIDEN: a fresh read wider than the snapshot is refused, not written', async () => {
  // The backstop under the live read. `makeTargetApplier` is an exported seam;
  // "the read is live" is a property of whoever injects it.
  const wide = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1000, takeProfit: null, tradeData: { tradeSide: 1 } }) })
  const rLong = await wide.apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
  assert.equal(rLong.ok, false)
  assert.match(rLong.error, /WIDER than the snapshot \(1700\) on a long/)
  assert.deepEqual(wide.seen, [], 'nothing was sent')

  // Short: the target sits BELOW the stop, so wider means higher.
  const wideShort = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1800, takeProfit: null, tradeData: { tradeSide: 2 } }) })
  const rShort = await wideShort.apply(finding({ brokerSl: 1700 }), { tp: 1500, basis: 'HVN' })
  assert.equal(rShort.ok, false)
  assert.match(rShort.error, /on a short/)
  assert.deepEqual(wideShort.seen, [])
})

test('TIGHTER is still adopted — the backstop blocks widening only', async () => {
  const tightLong = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1750, takeProfit: null, tradeData: { tradeSide: 1 } }) })
  assert.equal((await tightLong.apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })).ok, true)
  assert.equal(tightLong.seen[0].stopLoss, 1750)

  const tightShort = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1650, takeProfit: null, tradeData: { tradeSide: 2 } }) })
  assert.equal((await tightShort.apply(finding({ brokerSl: 1700 }), { tp: 1500, basis: 'HVN' })).ok, true)
  assert.equal(tightShort.seen[0].stopLoss, 1650)
})

test('MAJOR: a read describing a DIFFERENT position is refused', async () => {
  // Verified before the fix: a neighbour's stop was adopted and written onto
  // this position. Both production injections filter by id, so it was latent —
  // but this is an exported seam whose contract names the position.
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '556', stopLoss: 0.5, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /returned position 556, not 555/)
  assert.deepEqual(seen, [])
})

test('a float-formatted position id still matches — normPosId on both sides', async () => {
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '555.0', stopLoss: 1750, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  assert.equal((await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })).ok, true)
  assert.equal(seen[0].stopLoss, 1750)
})

test('a non-number stop is not a stop: true, [1750] and "1750" all refuse', async () => {
  // `Number(true)` is 1 and `Number([1750])` is 1750. "Refuses on any
  // uncertainty" has to be literal on a value that becomes a broker stop.
  for (const stopLoss of [true, [1750], '1750', {}]) {
    const { apply, seen } = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss, takeProfit: null, tradeData: { tradeSide: 1 } }) })
    const r = await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
    assert.equal(r.ok, false, JSON.stringify(stopLoss))
    assert.match(r.error, /no usable stop/)
    assert.deepEqual(seen, [])
  }
})

test('a CORRUPT existing target is not overwritten either', async () => {
  // A negative or NaN take profit used to read as "no take profit" and get
  // silently replaced. A value nobody can explain is a reason to stop.
  for (const takeProfit of [-1900, NaN, 'abc']) {
    const { apply, seen } = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit, tradeData: { tradeSide: 1 } }) })
    const r = await apply(finding(), { tp: 1900, basis: 'HVN' })
    assert.equal(r.ok, false, String(takeProfit))
    assert.match(r.error, /already holds a take profit/)
    assert.deepEqual(seen, [])
  }
})

test('THE STOP THIS AMEND WROTE IS JOURNALLED when it differs from the snapshot', async () => {
  // The amend carries both legs, so this path writes a stop on every
  // application and journalled none of them — a stop moved by this module was
  // unattributable from the timeline.
  const journal = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async () => ({ executionType: 'ORDER_REPLACED' }),
    recordEvent: (_db, e) => journal.push(e),
    readPosition: async () => ({ positionId: '555', stopLoss: 1750, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  assert.equal((await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })).ok, true)
  const sl = journal.find(e => e.kind === 'sl_moved')
  assert.ok(sl, JSON.stringify(journal))
  assert.equal(sl.fromValue, 1700)
  assert.equal(sl.toValue, 1750)
  assert.equal(sl.source, 'naked_position_guard')
  const tp = journal.find(e => e.kind === 'tp_moved')
  assert.match(tp.detail, /stop re-sent at 1750/)
})

test('an identity re-send is NOT journalled as a move', async () => {
  const journal = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async () => ({ executionType: 'ORDER_REPLACED' }),
    recordEvent: (_db, e) => journal.push(e),
    readPosition: async () => ({ positionId: '555', stopLoss: 1700, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
  assert.deepEqual(journal.filter(e => e.kind === 'sl_moved'), [], 'a re-send is not a move; journalling it buries the timeline')
  assert.equal(journal.filter(e => e.kind === 'tp_moved').length, 1)
})

// ---------------------------------------------------------------------------
// THE BREAK-EVEN-LOCKED WINNER (17-09-2026, third review).
//
// Both halves of this module derived direction from geometry — the suggester
// from `sl < entry`, the applier from `tp > sl`. That holds at ORDER time, and
// inverts the moment a stop is ratcheted past entry. Which is the NORMAL state
// of a managed winner, and a winner that lost its target to a stop-only amend
// is exactly what the `targetless` population is made of.
//
// Measured before the fix: long, entry 100, market 112, broker stop 110, no
// target -> `TP 85 (1.5R floor from entry)`, a take profit 27 points BELOW the
// market on a long. And the same inversion turned the never-widen backstop
// inside out on precisely those positions.
// ---------------------------------------------------------------------------

const lockedLong = (o = {}) => ({ positionId: '555', tradeData: { openPrice: 100, tradeSide: 1 }, ...o })
const lockedShort = (o = {}) => ({ positionId: '555', tradeData: { openPrice: 100, tradeSide: 2 }, ...o })

test('THE INVERSION: a break-even-locked LONG gets no target below its stop', async () => {
  // entry 100, stop ratcheted to 110. The old code read this as a SHORT and
  // offered 85.
  const suggest = makeTargetSuggester(null, CREDS, [lockedLong()], { fetchBars: async () => ({}), symbolMap: {} })
  const s = await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 110 })
  assert.equal(s, null, 'no R basis survives a locked stop, and no level may be invented')
})

test('a break-even-locked SHORT is refused the same way', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [lockedShort()], { fetchBars: async () => ({}), symbolMap: {} })
  assert.equal(await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 90 }), null)
})

test('an UNLOCKED long still gets its floor — the fix narrows nothing it should not', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [lockedLong()], { fetchBars: async () => ({}), symbolMap: {} })
  const s = await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 90 })
  assert.equal(s.tp, 115, 'entry 100, 10 of risk, 1.5R floor')
  assert.match(s.basis, /1\.5R floor from entry/)
})

test('an unlocked SHORT floor sits below entry, as it always did', async () => {
  const suggest = makeTargetSuggester(null, CREDS, [lockedShort()], { fetchBars: async () => ({}), symbolMap: {} })
  const s = await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 110 })
  assert.equal(s.tp, 85)
})

test('NO SIDE FROM THE BROKER, NO SUGGESTION — the geometry is not a fallback', async () => {
  const noSide = { positionId: '555', tradeData: { openPrice: 100 } }
  const suggest = makeTargetSuggester(null, CREDS, [noSide], { fetchBars: async () => ({}), symbolMap: {} })
  assert.equal(await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 90 }), null)
})

test('every side spelling the broker uses is decoded, and nothing else is', () => {
  for (const v of [1, '1', 'BUY', 'buy']) assert.equal(sideIsLong({ tradeSide: v }), true, String(v))
  for (const v of [2, '2', 'SELL', 'sell']) assert.equal(sideIsLong({ tradeSide: v }), false, String(v))
  // The other decoders in this repo collapse the unknown to BUY. Here that
  // would write a target on the wrong side of the market.
  for (const v of [0, 3, null, undefined, '', 'long', true, {}]) {
    assert.equal(sideIsLong({ tradeSide: v }), null, JSON.stringify(v))
  }
  assert.equal(sideIsLong(null), null)
  assert.equal(sideIsLong(undefined), null)
})

test('THE BACKSTOP NO LONGER INVERTS: a locked long refuses a WIDENING read', async () => {
  // The measured failure: tp 85 / sl 110 made `long` false, so widening passed
  // and tightening was refused. Now the side comes from the broker.
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 101, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding({ brokerSl: 110 }), { tp: 130, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /WIDER than the snapshot \(110\) on a long/)
  assert.deepEqual(seen, [], 'a stop on a live position was one line from being widened')
})

test('a locked long still ACCEPTS a further tightening read', async () => {
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 115, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  assert.equal((await apply(finding({ brokerSl: 110 }), { tp: 130, basis: 'HVN' })).ok, true)
  assert.equal(seen[0].stopLoss, 115)
})

test('a read with NO trade side refuses — direction is never inferred at the amend either', async () => {
  const { apply, seen } = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: null }),
  })
  const r = await apply(finding({ brokerSl: 1700 }), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, false)
  assert.match(r.error, /no trade side/)
  assert.deepEqual(seen, [])
})

test('THE SECOND OPINION: a target on the wrong side of the live stop is refused', async () => {
  // `suggestion` is an argument and this is an exported seam, so the applier
  // does not take the suggester's word for it.
  const longCase = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 110, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r1 = await longCase.apply(finding({ brokerSl: 110 }), { tp: 85, basis: 'HVN' })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /target 85 is on the wrong side of the stop 110 for a long/)
  assert.deepEqual(longCase.seen, [])

  const shortCase = applierWith({
    readPosition: async () => ({ positionId: '555', stopLoss: 90, takeProfit: null, tradeData: { tradeSide: 2 } }),
  })
  const r2 = await shortCase.apply(finding({ brokerSl: 90 }), { tp: 115, basis: 'HVN' })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /wrong side of the stop 90 for a short/)
  assert.deepEqual(shortCase.seen, [])
})

test('hvnTargetPrice is given the direction EXPLICITLY, not left to infer it', async () => {
  // Its own default is `sl < entry` — correct for a bracket about to be sent,
  // and the same inversion for a position already running.
  const { hvnTargetPrice } = await import('../lib/bracket-advice.js')
  const bars = clusteredBars()
  // Locked long: entry 1800, stop ratcheted to 1850. Inferred, this is a short.
  const inferred = hvnTargetPrice({ entry: 1800, sl: 1850, bars, rrFloor: 1.5 })
  const told = hvnTargetPrice({ entry: 1800, sl: 1850, bars, rrFloor: 1.5, long: true })
  assert.notDeepEqual(inferred, told, 'the override must actually change the answer')
  assert.ok(told == null || told > 1800, 'a long target is above entry')
})

test('the applier LABELS which refusals are transient', async () => {
  // The caller cannot tell a "the broker is unreachable" refusal from a "the
  // broker gave a settled answer" one by parsing an error string, and the
  // difference is six hours of silence versus five minutes.
  const readFails = applierWith({ readPosition: async () => { throw new Error('ws timeout') } })
  assert.equal((await readFails.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable, true)

  const gone = applierWith({ readPosition: async () => null })
  assert.equal((await gone.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable, true)

  const nothing = applierWith({ amendPosition: async () => null })
  assert.equal((await nothing.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable, true)

  const threw = applierWith({ amendPosition: async () => { throw new Error('socket hang up') } })
  assert.equal((await threw.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable, true)
})

test('a SETTLED refusal is not marked transient', async () => {
  // The broker will give the same answer tomorrow, so retrying in five minutes
  // is a retry storm with extra steps.
  const hasTp = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: 1888, tradeData: { tradeSide: 1 } }) })
  assert.ok(!(await hasTp.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable)

  const wrongPos = applierWith({ readPosition: async () => ({ positionId: '556', stopLoss: 1750, takeProfit: null, tradeData: { tradeSide: 1 } }) })
  assert.ok(!(await wrongPos.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable)

  const noSide = applierWith({ readPosition: async () => ({ positionId: '555', stopLoss: 1750, takeProfit: null }) })
  assert.ok(!(await noSide.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable)

  const brokerNo = applierWith({ amendPosition: async () => ({ error: 'MARKET_CLOSED' }) })
  assert.ok(!(await brokerNo.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable)

  const closed = applierWith({ amendPosition: async () => ({ alreadyClosed: true, reason: 'gone' }) })
  assert.ok(!(await closed.apply(finding(), { tp: 1900, basis: 'HVN' })).retryable)

  const noTarget = makeTargetApplier(null, CREDS, { amendPosition: async () => ({}), recordEvent: () => {} })
  const r = await noTarget(finding(), { tp: 0 })
  assert.equal(r.ok, false)
  assert.ok(!r.retryable, 'an unusable suggestion is the caller\'s problem, not the broker\'s')
})

test('the pre-amend read is given an explicit, SHORT timeout', async () => {
  // `wsReconcile`'s 25s default inside `withRetry(..., 2)` is 81s worst case
  // for ONE read, and this runs serially per position inside a 60s band. The
  // timeout argument is the difference between a slow pass and a parked band.
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(new URL('./tp-suggest.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// READ_TIMEOUT_MS'), false, 'comment stripper works')
  const readerBlock = src.slice(src.indexOf('const read = readPosition'), src.indexOf('const amend = amendPosition'))
  assert.match(readerBlock, /READ_TIMEOUT_MS/, 'the read must not inherit the 25s default')
})

/** 240 15m bars whose volume mass sits at `node`, with thin trade elsewhere. */
function barsWithNodeAt(node, elsewhere) {
  const bars = []
  for (let i = 0; i < 240; i++) {
    const heavy = i % 3 !== 0
    const c = heavy ? node + (i % 5) * 0.01 : elsewhere + (i % 7) * 0.01
    bars.push({ t: i, o: c - 0.01, h: c + 0.02, l: c - 0.02, c, v: heavy ? 900 : 80 })
  }
  return bars
}

test('a locked LONG takes an HVN node ABOVE its ratcheted stop', async () => {
  // entry 100, stop ratcheted to 110, volume shelf at 130. There is no R basis
  // left, so structure is the only basis — and it has to be real structure on
  // the right side, found with the direction the BROKER reports.
  const suggest = makeTargetSuggester(null, CREDS, [lockedLong()], {
    symbolMap: { XAUUSD: 1 },
    fetchBars: async () => ({ '15m': barsWithNodeAt(130, 101) }),
  })
  const s = await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 110 })
  assert.ok(s && s.tp > 110, `expected a target above the stop, got ${JSON.stringify(s)}`)
  assert.match(s.basis, /HVN/)
})

test('a locked LONG refuses an HVN node BETWEEN entry and the stop', async () => {
  // 105 is beyond entry — hvnTargetPrice is happy with it — and BEHIND the
  // ratcheted stop at 110, so the stop would take that exit first. A target the
  // position has already passed is not a target.
  const suggest = makeTargetSuggester(null, CREDS, [lockedLong()], {
    symbolMap: { XAUUSD: 1 },
    fetchBars: async () => ({ '15m': barsWithNodeAt(105, 101) }),
  })
  assert.equal(await suggest({ positionId: '555', symbol: 'XAUUSD', brokerSl: 110 }), null)
})

test('THE DIRECTION REACHES THE HVN SEARCH: inferred, a locked long finds nothing', async () => {
  // hvnTargetPrice's own default is `sl < entry`. On a locked long that reads
  // as a short and it searches BELOW entry, where the shelf at 130 is not. The
  // explicit `long` is what makes the search look the right way.
  const { hvnTargetPrice } = await import('../lib/bracket-advice.js')
  const bars = barsWithNodeAt(130, 101)
  assert.equal(hvnTargetPrice({ entry: 100, sl: 110, bars, rrFloor: 1.5 }), null,
    'inferred direction finds no node — this is the search the suggester must not do')
  const told = hvnTargetPrice({ entry: 100, sl: 110, bars, rrFloor: 1.5, long: true })
  assert.ok(told > 110, `explicit direction finds the shelf, got ${told}`)
})

test('V3 M5: the applier\'s amend is timed in the amend-latency ring, payload unchanged', async () => {
  const { _resetAmendLatencyForTests, _amendLatencyStateForTests } = await import('./protection-latency.js')
  _resetAmendLatencyForTests()
  const seen = []
  const apply = makeTargetApplier(null, CREDS, {
    amendPosition: async (_c, args) => { seen.push(args); return { executionType: 'ORDER_REPLACED', position: {} } },
    recordEvent: () => {},
    readPosition: async () => ({ positionId: '555', stopLoss: 1723.26, takeProfit: null, tradeData: { tradeSide: 1 } }),
  })
  const r = await apply(finding({ brokerSl: 1723.26, accountId: '42993489' }), { tp: 1900, basis: 'HVN' })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(seen[0]).sort(), ['positionId', 'stopLoss', 'takeProfit'], 'nothing added to what reaches the broker')
  const { amends } = _amendLatencyStateForTests()
  assert.equal(amends.length, 1, 'one amend sent, one amend timed')
  assert.deepEqual([amends[0].path, amends[0].source, amends[0].positionId, amends[0].account, amends[0].outcome],
    ['tp_suggest', 'naked_position_guard', '555', '…3489', 'ok'])
})
