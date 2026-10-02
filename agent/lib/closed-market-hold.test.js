// node --test agent/lib/closed-market-hold.test.js
//
// A close the broker refused with MARKET_CLOSED is not resent every cycle
// (02-10-2026: the two PG.US time-cap exits retried about once a minute for
// hours). The hold starts only on the broker's own refusal, ends when the
// session opens or after HOLD_MAX_MS, and never suppresses a different action.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runWithClosedMarketHold, isMarketClosedRefusal, resetClosedMarketHolds, closedMarketHoldView, HOLD_MAX_MS } from './closed-market-hold.js'

const REFUSAL = '{"description":"Trading is not available: Market is closed.","errorCode":"MARKET_CLOSED"}'
const pos = { id: 1705, account_id: '47342' }
const T0 = 1_800_000_000_000

beforeEach(() => resetClosedMarketHolds())

function rig() {
  const sent = []
  let reply = { error: REFUSAL }
  let open = false
  return {
    sent,
    setReply: (r) => { reply = r },
    setOpen: (o) => { open = o },
    call: (action, now) => runWithClosedMarketHold({ pos, action, now, isOpen: () => open, run: async () => { sent.push(action); return reply } }),
  }
}

test('isMarketClosedRefusal reads the broker error code and its text, and nothing else', () => {
  assert.equal(isMarketClosedRefusal(REFUSAL), true)
  assert.equal(isMarketClosedRefusal('Trading is not available: Market is closed.'), true)
  assert.equal(isMarketClosedRefusal('TRADING_BAD_VOLUME'), false)
  assert.equal(isMarketClosedRefusal(null), false)
})

test('the first refusal is sent and starts a hold; the next cycles are withheld, not sent', async () => {
  const r = rig()
  const first = await r.call('FULL_EXIT', T0)
  assert.equal(first.closedMarketHeld, true)
  assert.equal(r.sent.length, 1)
  for (let i = 1; i <= 5; i++) {
    const held = await r.call('FULL_EXIT', T0 + i * 60_000)
    assert.equal(held.heldClosedMarket, true)
  }
  assert.equal(r.sent.length, 1, 'five more cycles, no broker request')
  assert.equal(closedMarketHoldView().length, 1)
})

test('the hold ends when the session opens, and the exit is sent that cycle', async () => {
  const r = rig()
  await r.call('FULL_EXIT', T0)
  r.setOpen(true)
  r.setReply({ summary: 'closed' })
  const out = await r.call('FULL_EXIT', T0 + 60_000)
  assert.equal(out.summary, 'closed')
  assert.equal(r.sent.length, 2)
  assert.equal(closedMarketHoldView().length, 0, 'a successful send leaves no hold')
})

test('the hold is bounded: a schedule that wrongly says closed costs one retry interval, not the exit', async () => {
  const r = rig()
  await r.call('FULL_EXIT', T0)
  assert.equal((await r.call('FULL_EXIT', T0 + HOLD_MAX_MS - 1)).heldClosedMarket, true)
  r.setReply({ summary: 'closed' })
  const out = await r.call('FULL_EXIT', T0 + HOLD_MAX_MS)
  assert.equal(out.summary, 'closed', 'after the bound it is sent again whatever the schedule says')
  assert.equal(r.sent.length, 2)
})

test('a refusal after the bound starts a new hold; the interval does not stack', async () => {
  const r = rig()
  await r.call('FULL_EXIT', T0)
  const again = await r.call('FULL_EXIT', T0 + HOLD_MAX_MS)
  assert.equal(again.closedMarketHeld, true)
  assert.equal(r.sent.length, 2)
  assert.equal((await r.call('FULL_EXIT', T0 + HOLD_MAX_MS + 60_000)).heldClosedMarket, true)
})

test('only the refused action is held: a different action on the same row, and another row, still go out', async () => {
  const r = rig()
  await r.call('FULL_EXIT', T0)
  r.setReply({ summary: 'sl moved' })
  assert.equal((await r.call('MOVE_SL', T0 + 1000)).summary, 'sl moved')
  const other = await runWithClosedMarketHold({ pos: { id: 1706, account_id: '49908' }, action: 'FULL_EXIT', now: T0 + 1000, isOpen: () => false, run: async () => ({ summary: 'other row' }) })
  assert.equal(other.summary, 'other row')
})

test('an error that is not a closed-market refusal starts no hold (it is retried as before)', async () => {
  const r = rig()
  r.setReply({ error: 'TRADING_BAD_VOLUME' })
  await r.call('FULL_EXIT', T0)
  await r.call('FULL_EXIT', T0 + 60_000)
  assert.equal(r.sent.length, 2)
  assert.equal(closedMarketHoldView().length, 0)
})

test('a probe that throws counts as closed (the bound still frees it)', async () => {
  const sent = []
  const run = async () => { sent.push(1); return { error: REFUSAL } }
  const bad = () => { throw new Error('schedule unreadable') }
  await runWithClosedMarketHold({ pos, action: 'FULL_EXIT', now: T0, isOpen: bad, run })
  const held = await runWithClosedMarketHold({ pos, action: 'FULL_EXIT', now: T0 + 1000, isOpen: bad, run })
  assert.equal(held.heldClosedMarket, true)
  assert.equal(sent.length, 1)
})

test('wiring pin: the position manager sends its exit through the hold and returns without stamping when held', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'loop.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const start = src.indexOf('export async function monitorOnePosition(')
  assert.ok(start > 0, 'monitorOnePosition not found — re-anchor')
  const body = src.slice(start, start + 12000)
  const call = body.indexOf('runWithClosedMarketHold({')
  assert.ok(call > 0, 'monitorOnePosition no longer sends its exit through the closed-market hold')
  assert.match(body.slice(call, call + 400), /run: \(\) => executeBrokerAction\(db, s, pos, eval_\)/)
  assert.match(body.slice(call, call + 700), /if \(outcome\.heldClosedMarket\) return/)
  assert.ok(!/const outcome = await executeBrokerAction\(db, s, pos, eval_\)/.test(body), 'a bare executeBrokerAction send bypasses the hold')
})
