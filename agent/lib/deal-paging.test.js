// agent/lib/deal-paging.test.js — the deal-history walk.
//
// Every case here is a way the old loops went wrong or could have. The two
// that matter most are the ones nothing would have noticed in production: a
// page that says `hasMore` and is ignored, and a cursor that skips a deal
// sharing the last one's millisecond. Both return a SHORTER answer that looks
// exactly like a complete one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageDeals, DEAL_PULL_MAX_PAGES, WEEK_MS } from './deal-paging.js'

const deal = (id, ts, extra = {}) => ({ dealId: id, executionTimestamp: ts, ...extra })

/** A fake broker: `pages` is consulted per request, in order. */
const scripted = (pages) => {
  const calls = []
  const get = async (from, to) => {
    calls.push({ from, to })
    const p = pages[calls.length - 1]
    if (typeof p === 'function') return p(from, to)
    return p ?? { deal: [], hasMore: false }
  }
  get.calls = calls
  return get
}

test('a single complete page is returned whole, and marked complete', async () => {
  const get = scripted([{ deal: [deal(1, 1000), deal(2, 2000)], hasMore: false }])
  const r = await pageDeals(get, 500, 5000)
  assert.equal(r.complete, true)
  assert.equal(r.pages, 1)
  assert.equal(r.deals.length, 2)
  assert.equal(r.reason, null)
})

test('hasMore is followed to exhaustion — the defect both old loops had', async () => {
  // THE MEASURED BUG. broker-history-import and pnl-backfill walked WINDOWS
  // (a week each) but never looked at `hasMore`, which is the RESPONSE cap.
  // A week with more than maxRows deals therefore returned its first page and
  // the caller treated it as the whole week.
  const get = scripted([
    { deal: [deal(1, 1000), deal(2, 2000)], hasMore: true },
    { deal: [deal(3, 3000)], hasMore: false },
  ])
  const r = await pageDeals(get, 500, 5000)
  assert.equal(r.pages, 2, 'the second page was requested')
  assert.deepEqual(r.deals.map(d => d.dealId), [1, 2, 3])
  assert.equal(r.complete, true)
  // and the follow-up asked from the last deal's timestamp, not past it
  assert.equal(get.calls[1].from, 2000)
})

test('the cursor lands ON the last timestamp, so a deal sharing that millisecond is not skipped', async () => {
  // A partial fill is several deals at the same instant. Advancing to
  // `last + 1` — the obvious way to page — drops every one after the first,
  // and drops them invisibly.
  const get = scripted([
    { deal: [deal(1, 1000), deal(2, 2000)], hasMore: true },
    { deal: [deal(2, 2000), deal(3, 2000), deal(4, 3000)], hasMore: false },
  ])
  const r = await pageDeals(get, 500, 5000)
  assert.deepEqual(r.deals.map(d => d.dealId), [1, 2, 3, 4], 'deal 3 shares 2000 and must survive')
  assert.equal(r.deals.filter(d => d.dealId === 2).length, 1, 'and the overlap is deduped by dealId')
})

test('a page that says hasMore without advancing stops the walk and reports it', async () => {
  // Following it again asks the identical question forever. The two wrong
  // answers are spinning and returning a partial set as complete.
  const get = scripted(Array(5).fill({ deal: [deal(1, 1000)], hasMore: true }))
  const r = await pageDeals(get, 500, 5000)
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'stalled_with_has_more')
  assert.equal(r.pages, 2, 'one page to read, one to prove it did not move')
  assert.equal(r.deals.length, 1, 'what did arrive is kept, flagged incomplete')
})

test('the page cap stops the walk and says so rather than returning a partial set as whole', async () => {
  let ts = 1000
  const get = async () => ({ deal: [deal(ts, (ts += 1000))], hasMore: true })
  const r = await pageDeals(get, 500, 5000, { maxPages: 3 })
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'page_cap_3')
  assert.equal(r.pages, 3)
})

test('a span longer than a week is walked window by window', async () => {
  const get = scripted([
    { deal: [deal(1, 1000)], hasMore: false },
    { deal: [deal(2, 2000)], hasMore: false },
    { deal: [deal(3, 3000)], hasMore: false },
  ])
  const from = 0
  const r = await pageDeals(get, from, WEEK_MS * 2 + 5)
  assert.equal(r.windows, 3, 'two whole weeks and a remainder')
  assert.equal(r.complete, true)
  assert.equal(get.calls[0].to, WEEK_MS, 'the first window ends at the week boundary')
  assert.equal(get.calls[2].to, WEEK_MS * 2 + 5, 'the last is clipped to the requested end')
})

test('the page budget is per window, so a long backfill is not starved by an early busy week', async () => {
  // If the cap were per WALK, one busy week at the start of a 60-day
  // backfill would consume the budget and every later week would be missed —
  // and the result would still have looked like a backfill.
  let n = 0
  const get = async () => {
    n++
    // window 1: exactly maxPages pages, the last one complete
    if (n < 3) return { deal: [deal(n, n * 1000)], hasMore: true }
    return { deal: [deal(n, n * 1000)], hasMore: false }
  }
  const r = await pageDeals(get, 0, WEEK_MS + 5, { maxPages: 3 })
  assert.equal(r.complete, true)
  assert.equal(r.windows, 2)
})

test('an empty or inverted window costs the broker no request', async () => {
  const get = scripted([{ deal: [deal(1, 1)], hasMore: false }])
  for (const [from, to] of [[5000, 5000], [5000, 4000], [NaN, 1], [1, NaN]]) {
    const r = await pageDeals(get, from, to)
    assert.equal(r.complete, false)
    assert.equal(r.reason, 'empty_window')
  }
  assert.equal(get.calls.length, 0)
})

test('a deal with no id is kept rather than dropped by the dedupe', async () => {
  // Counting one twice shows up in a verdict. Dropping one does not.
  const get = scripted([{ deal: [{ executionTimestamp: 1000 }, { executionTimestamp: 1000 }], hasMore: false }])
  const r = await pageDeals(get, 500, 5000)
  assert.equal(r.deals.length, 2)
})

test('the timestamp is read from tradeData when the deal nests it', async () => {
  // Two shapes reach this code (the ws client flattens, the sidecar journal
  // does not), and reading only the flat one would make the cursor never
  // advance — which the stall guard would then report as a broker fault.
  const get = scripted([
    { deal: [{ dealId: 1, tradeData: { executionTimestamp: 2000 } }], hasMore: true },
    { deal: [{ dealId: 2, tradeData: { executionTimestamp: 3000 } }], hasMore: false },
  ])
  const r = await pageDeals(get, 500, 5000)
  assert.equal(r.complete, true)
  assert.equal(get.calls[1].from, 2000)
})

test('no getter is refused, not treated as no deals', async () => {
  const r = await pageDeals(null, 0, 1000)
  assert.equal(r.complete, false)
  assert.equal(r.reason, 'no_getter')
  assert.equal(r.deals.length, 0)
})

test('the default page cap is a stated number, not a magic literal at the call sites', () => {
  assert.equal(typeof DEAL_PULL_MAX_PAGES, 'number')
  assert.ok(DEAL_PULL_MAX_PAGES >= 10)
})
