// node --test agent/services/loss-cap-tick.test.js
//
// §70.6 §2.2 — the loss cap on a price trigger.
//
// The rule is `tick` in RULE_TRIGGER and was the last tick-shaped rule that
// ACTS ON MONEY still waiting on a timer. What matters in these tests is not
// that it got faster but that it got faster WITHOUT loosening anything: the
// tick runs a screen, the close still happens against a fresh reconcile, and
// the 60-second pass is still there when the stream is not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  screenLossCapTick, runLossCapOnTick, __resetLossCapTickState,
  SNAPSHOT_MAX_AGE_MS, TICK_COOLDOWN_MS, runLossCap,
} from './loss-cap.js'
import { RULE_TRIGGER } from './management-state.js'
import { __resetInFlight } from './acting-layer.js'

test.beforeEach(() => { __resetLossCapTickState(); __resetInFlight() })

// A EURUSD long: 1 lot (100_000 units → broker volume 10_000_000), entry
// 1.1000. Each 0.0001 of adverse move is $10.
const POS = {
  positionId: '901',
  price: 1.1000,
  tradeData: { symbolId: 1, volume: 10_000_000, tradeSide: 'BUY', openPrice: 1.1000 },
}

// A real database, because the cap is derived from state (balance, config)
// and a stub that answers null quietly turns the cap OFF — which would make
// every test below pass for the wrong reason.
function db() {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE accounts (account_id TEXT PRIMARY KEY, is_live INTEGER, enabled INTEGER);
          CREATE TABLE trades (id INTEGER PRIMARY KEY, ctrader_position_id TEXT, account_id TEXT);
          CREATE TABLE monitored_positions (id INTEGER PRIMARY KEY, trade_id INTEGER, status TEXT);
          INSERT INTO agent_state VALUES
            ('ctrader_account_id','5203012'),
            ('acct:5203012:account_balance_usd','10000'),
            ('symbol_id_map','{"EURUSD":1}');
          INSERT INTO accounts VALUES ('5203012',0,1);`)
  return d
}

const CREDS = { ready: true, accountId: '5203012', isLive: false }

// 1% of $10,000 = a $100 cap → 100 pips of adverse move on a 1-lot EURUSD long.
const CAP_USD = 100

async function seedSnapshot(d, { at = 1_000_000 } = {}) {
  // Seeded through a REAL pass rather than by reaching into module state, so
  // the test stays honest about the snapshot's shape.
  await runLossCap(d, CREDS, {
    now: at,
    exec: { reconcile: async () => ({ position: [POS] }) },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    spotFor: () => 1.1000,                 // flat — no breach on the seeding pass
    notify: async () => {},
  })
}

test('the screen is silent when the position is not past its cap', async () => {
  await seedSnapshot(db())
  // 1.0990 → −$100... just short. 1.0999 is −$10, nowhere near.
  assert.deepEqual(screenLossCapTick(1, () => 1.0999, { now: 1_000_100 }), [])
})

test('the screen fires when the price crosses the cap', async () => {
  await seedSnapshot(db())
  // $100 cap = 100 pips on a 1-lot EURUSD long; 1.0880 is 120 pips adverse.
  const hits = screenLossCapTick(1, () => 1.0880, { now: 1_000_100 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].positionId, '901')
  assert.ok(hits[0].net <= -hits[0].cap, 'the reported net actually breaches the reported cap')
  assert.equal(hits[0].cap, CAP_USD)
})

test('a tick on a DIFFERENT symbol never wakes an unrelated position', async () => {
  await seedSnapshot(db())
  assert.deepEqual(screenLossCapTick(999, () => 1.0000, { now: 1_000_100 }), [])
})

test('a STALE snapshot is refused rather than trusted', async () => {
  // It describes a book that may no longer exist. Refusing costs one tick of
  // latency; trusting could escalate on a position closed minutes ago.
  await seedSnapshot(db(), { at: 1_000_000 })
  const justInside = 1_000_000 + SNAPSHOT_MAX_AGE_MS - 1
  const justPast = 1_000_000 + SNAPSHOT_MAX_AGE_MS + 1
  assert.equal(screenLossCapTick(1, () => 1.0880, { now: justInside }).length, 1)
  assert.equal(screenLossCapTick(1, () => 1.0880, { now: justPast }).length, 0)
})

test('a position with no fresh price is not treated as flat', async () => {
  // deriveUnrealizedMap OMITS it rather than defaulting to zero, and zero
  // would read as "nothing to see" — the exact failure that module exists to
  // end. The screen must inherit that, not paper over it.
  await seedSnapshot(db())
  assert.deepEqual(screenLossCapTick(1, () => null, { now: 1_000_100 }), [])
})

test('with no snapshot at all the screen is silent, not noisy', () => {
  assert.deepEqual(screenLossCapTick(1, () => 1.0000, { now: 1 }), [])
})

// ---------------------------------------------------------------------------
// escalation
// ---------------------------------------------------------------------------

test('a quiet tick does NOT reach the broker', async () => {
  const d = db()
  await seedSnapshot(d)
  let reconciles = 0
  const r = await runLossCapOnTick(d, CREDS, 1, {
    now: 1_000_100,
    spotFor: () => 1.0999,
    exec: { reconcile: async () => { reconciles++; return { position: [] } } },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    notify: async () => {},
  })
  assert.equal(r.hits, 0)
  assert.equal(reconciles, 0, 'the screen answered without a round-trip — that is the point')
})

test('a breaching tick escalates to a FULL pass, which reconciles first', async () => {
  // The property that matters: the close is attempted against the volume the
  // BROKER reports now, not the one the snapshot remembers. The keeper may
  // have scaled the position out since.
  const d = db()
  await seedSnapshot(d)
  let reconciles = 0
  const closed = []
  await runLossCapOnTick(d, CREDS, 1, {
    now: 1_000_100,
    spotFor: () => 1.0880,
    exec: {
      reconcile: async () => { reconciles++; return { position: [{ ...POS, tradeData: { ...POS.tradeData, volume: 5_000_000 } }] } },
      closePosition: async (_c, a) => { closed.push(a); return { ok: true } },
    },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    notify: async () => {},
  })
  assert.ok(reconciles >= 1, 'the full pass reconciled')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].volume, 5_000_000, 'closed the CURRENT volume, not the snapshot volume')
})

test('a tick storm produces one pass, not a pass per tick', async () => {
  const d = db()
  await seedSnapshot(d)
  let reconciles = 0
  const deps = {
    spotFor: () => 1.0880,
    exec: { reconcile: async () => { reconciles++; return { position: [] } }, closePosition: async () => ({}) },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    notify: async () => {},
  }
  await runLossCapOnTick(d, CREDS, 1, { ...deps, now: 1_000_100 })
  const after = reconciles
  await runLossCapOnTick(d, CREDS, 1, { ...deps, now: 1_000_100 + 1 })
  await runLossCapOnTick(d, CREDS, 1, { ...deps, now: 1_000_100 + TICK_COOLDOWN_MS - 1 })
  assert.equal(reconciles, after, 'the cooldown held')
  await runLossCapOnTick(d, CREDS, 1, { ...deps, now: 1_000_100 + TICK_COOLDOWN_MS + 1 })
  assert.ok(reconciles > after, 'and released')
})

test('the tick path never throws — it is called from a websocket handler', async () => {
  // A loss cap that can kill the guardian's stream is a loss cap that REMOVES
  // protection. Every failure returns instead.
  const d = db()
  await seedSnapshot(d)
  const r = await runLossCapOnTick(d, CREDS, 1, {
    now: 1_000_100, spotFor: () => { throw new Error('cache exploded') },
  })
  assert.equal(r.screened, false)
  assert.match(r.error, /cache exploded/)
})

// ---------------------------------------------------------------------------
// the wiring, and the promises made about it
// ---------------------------------------------------------------------------

test('the guardian calls it on every HELD tick, before the move gate', () => {
  // The significant-move gate asks "is this worth a broker round-trip?" —
  // right for the guard sweep, wrong for a hard cap. The tick that carries a
  // position past its cap need not be a big tick, only the one that crosses.
  const src = readFileSync(new URL('./guardian.js', import.meta.url), 'utf8')
  const held = src.indexOf('heldIds.has(tick.symbolId)')
  const cap = src.indexOf('runLossCapOnTick')
  const gate = src.indexOf('significantMove(prev, price, minPct)')
  assert.ok(held > -1 && cap > held, 'the cap check lives inside the held-symbol branch')
  assert.ok(cap < gate, 'and runs BEFORE the significant-move gate')
})

test('the 60-second pass is still wired — a tick trigger is an ADDITION', () => {
  // A price trigger that stops firing must degrade to slow, not to nothing.
  const src = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8')
  assert.match(src, /runLossCapAllAccounts/)
  assert.match(src, /due\('pnl_watch', 60/)
})

test('the classification and the wiring agree', () => {
  assert.equal(RULE_TRIGGER['loss-cap:position_dollar_cap'], 'tick')
})
