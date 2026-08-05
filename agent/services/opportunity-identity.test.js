// node --test agent/services/opportunity-identity.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  opportunityTuple, opportunityKey, tupleOf, startedAtOf,
  resolveOpportunity, nextOpportunityKey, DEFAULT_GAP_MS,
} from './opportunity-identity.js'
import { initDB } from '../db.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const T0 = Date.parse('2026-08-05T04:00:00.000Z')
const P = { symbol: 'TXT.US', side: 'SELL', strategy: 'vwap_trend', accountId: '46130058' }
const fresh = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opp-')), 'a.db'))

test('the tuple is case- and whitespace-stable, so a quote casing change is not a new opportunity', () => {
  assert.equal(
    opportunityTuple({ symbol: ' txt.us ', side: 'sell', strategy: 'VWAP_Trend' }, '46130058'),
    opportunityTuple(P, '46130058'),
  )
})

test('strategy is part of identity — two strategies on one symbol are two opportunities', () => {
  const a = opportunityTuple({ ...P, strategy: 'vwap_trend' }, '1')
  const b = opportunityTuple({ ...P, strategy: 'rsi2_reversion' }, '1')
  assert.notEqual(a, b)
})

test('account is part of identity — two accounts on one symbol are two opportunities', () => {
  assert.notEqual(opportunityTuple(P, '46130058'), opportunityTuple(P, '47790949'))
})

test('THE POINT: re-evaluation inside the gap keeps ONE key', () => {
  // The production shape: 8 evaluations of one setup, minutes apart.
  let previous = null
  const keys = new Set()
  let news = 0
  for (let i = 0; i < 8; i++) {
    const now = T0 + i * 5 * 60_000
    const r = resolveOpportunity(P, { accountId: P.accountId, now, previous })
    keys.add(r.key)
    if (r.isNew) news += 1
    previous = { opportunity_key: r.key, created_at: new Date(now).toISOString() }
  }
  assert.equal(keys.size, 1, '8 evaluations of one setup must be one opportunity')
  assert.equal(news, 1, 'only the first evaluation opens the opportunity')
})

test('a gap longer than the window opens a NEW opportunity', () => {
  const first = resolveOpportunity(P, { accountId: P.accountId, now: T0, previous: null })
  const later = resolveOpportunity(P, {
    accountId: P.accountId,
    now: T0 + DEFAULT_GAP_MS + 1,
    previous: { opportunity_key: first.key, created_at: new Date(T0).toISOString() },
  })
  assert.equal(later.isNew, true)
  assert.notEqual(later.key, first.key)
})

test('exactly at the gap boundary is still the SAME opportunity (> not >=)', () => {
  const first = resolveOpportunity(P, { accountId: P.accountId, now: T0, previous: null })
  const edge = resolveOpportunity(P, {
    accountId: P.accountId,
    now: T0 + DEFAULT_GAP_MS,
    previous: { opportunity_key: first.key, created_at: new Date(T0).toISOString() },
  })
  assert.equal(edge.isNew, false)
})

test('a previous row from a DIFFERENT tuple is never adopted', () => {
  const other = opportunityKey({ ...P, symbol: 'GER40' }, P.accountId, T0)
  const r = resolveOpportunity(P, {
    accountId: P.accountId,
    now: T0 + 60_000,
    previous: { opportunity_key: other, created_at: new Date(T0).toISOString() },
  })
  assert.equal(r.isNew, true, 'a loose query must not be able to graft this onto a foreign setup')
})

test('a missing or empty previous timestamp opens a new opportunity, it does not read as the epoch', () => {
  // Date.parse(null) is NaN and Number(null) is 0 — the second would make the
  // gap ~56 years and look like a decision rather than a bug.
  for (const created_at of [null, undefined, '']) {
    const r = resolveOpportunity(P, {
      accountId: P.accountId, now: T0,
      previous: { opportunity_key: opportunityKey(P, P.accountId, T0), created_at },
    })
    assert.equal(r.isNew, true)
    assert.equal(r.gapMs, null)
  }
})

test('a clock that went backwards does NOT open a new opportunity', () => {
  const first = resolveOpportunity(P, { accountId: P.accountId, now: T0, previous: null })
  const back = resolveOpportunity(P, {
    accountId: P.accountId,
    now: T0 - 5 * 60_000,
    previous: { opportunity_key: first.key, created_at: new Date(T0).toISOString() },
  })
  assert.equal(back.isNew, false, 'negative elapsed means "at the same time", not "long ago"')
})

test('the key round-trips: tuple and start time are both recoverable', () => {
  const k = opportunityKey(P, P.accountId, T0)
  assert.equal(tupleOf(k), opportunityTuple(P, P.accountId))
  assert.equal(startedAtOf(k), T0)
  assert.equal(tupleOf('nonsense'), null)
  assert.equal(startedAtOf('nonsense'), null)
})

test('the key is DERIVED — same inputs, same key, so a backfill matches the live path', () => {
  assert.equal(opportunityKey(P, '1', T0), opportunityKey({ ...P }, '1', T0))
})

test('nextOpportunityKey reads the previous evaluation out of the DB', () => {
  const db = fresh()
  const ins = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, account_id, created_at, opportunity_key)
     VALUES (?, ?, 0, ?, ?, ?)`
  )
  const first = nextOpportunityKey(db, P, { accountId: P.accountId, now: T0 })
  assert.equal(first.isNew, true)
  ins.run(P.symbol, P.side, P.accountId, new Date(T0).toISOString(), first.key)

  const second = nextOpportunityKey(db, P, { accountId: P.accountId, now: T0 + 60_000 })
  assert.equal(second.isNew, false)
  assert.equal(second.key, first.key)
})

test('nextOpportunityKey does not read ANOTHER account\'s evaluation', () => {
  const db = fresh()
  const other = nextOpportunityKey(db, P, { accountId: '47790949', now: T0 })
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, account_id, created_at, opportunity_key)
     VALUES (?, ?, 0, ?, ?, ?)`
  ).run(P.symbol, P.side, '47790949', new Date(T0).toISOString(), other.key)

  const mine = nextOpportunityKey(db, P, { accountId: '46130058', now: T0 + 60_000 })
  assert.equal(mine.isNew, true, 'sharing a key across accounts would let one account close out the other\'s row')
  assert.notEqual(mine.key, other.key)
})

test('a DB without the column degrades to "every evaluation is new" rather than throwing', () => {
  // The risk gate decides money; this decides a label. It must never be the
  // reason an evaluation fails.
  const broken = { prepare() { throw new Error('no such column: opportunity_key') } }
  const r = nextOpportunityKey(broken, P, { accountId: P.accountId, now: T0 })
  assert.equal(r.isNew, true)
  assert.ok(r.key.startsWith(opportunityTuple(P, P.accountId)))
})

test('BACKFILL replays the rule over history and produces the SAME keys the live path would', async () => {
  const { backfillOpportunityKeys } = await import('./opportunity-identity.js')
  const db = fresh()
  const ins = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, account_id, created_at, proposal_json)
     VALUES (?, ?, 0, ?, ?, ?)`
  )
  // One setup seen 6 times over 25 minutes, then again 2 hours later.
  for (let i = 0; i < 6; i++) {
    ins.run(P.symbol, P.side, P.accountId, new Date(T0 + i * 5 * 60_000).toISOString(), JSON.stringify(P))
  }
  ins.run(P.symbol, P.side, P.accountId, new Date(T0 + 2 * 3600_000).toISOString(), JSON.stringify(P))
  // A different account, interleaved in time — must not join either run.
  ins.run(P.symbol, P.side, '47790949', new Date(T0 + 60_000).toISOString(), JSON.stringify(P))

  const r = backfillOpportunityKeys(db)
  assert.equal(r.keyed, 8)
  assert.equal(r.remaining, 0)
  assert.equal(r.opportunities, 3, '6-in-a-row + the later visit + the other account')

  const keys = db.prepare(
    `SELECT opportunity_key AS k, COUNT(*) AS n FROM risk_events GROUP BY opportunity_key ORDER BY n DESC`
  ).all()
  assert.equal(keys.length, 3)
  assert.equal(keys[0].n, 6)
})

test('BACKFILL is idempotent and bounded — a second call is a no-op', async () => {
  const { backfillOpportunityKeys } = await import('./opportunity-identity.js')
  const db = fresh()
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO risk_events (symbol, side, approved, account_id, created_at, proposal_json) VALUES (?,?,0,?,?,?)`)
      .run(P.symbol, P.side, P.accountId, new Date(T0 + i * 60_000).toISOString(), JSON.stringify(P))
  }
  assert.equal(backfillOpportunityKeys(db, { limit: 2 }).keyed, 2)
  assert.equal(backfillOpportunityKeys(db, { limit: 2 }).remaining, 1)
  assert.equal(backfillOpportunityKeys(db).remaining, 0)
  assert.deepEqual(backfillOpportunityKeys(db), { scanned: 0, keyed: 0, opportunities: 0, remaining: 0 })
})

test('BACKFILL leaves a row with an UNPARSEABLE timestamp unkeyed rather than guessing it into a neighbour', async () => {
  const { backfillOpportunityKeys } = await import('./opportunity-identity.js')
  const db = fresh()
  // created_at is NOT NULL, so the reachable bad case is a malformed string,
  // not a null — SQLite's loose typing lets one in. Date.parse returns NaN for
  // both, and without the isFinite guard NaN would sort into a neighbouring
  // run and silently join an opportunity it has no timestamp to belong to.
  for (const bad of ['', 'not-a-date']) {
    db.prepare(`INSERT INTO risk_events (symbol, side, approved, account_id, created_at, proposal_json) VALUES (?,?,0,?,?,?)`)
      .run(P.symbol, P.side, P.accountId, bad, JSON.stringify(P))
  }
  const r = backfillOpportunityKeys(db)
  assert.equal(r.keyed, 0)
  assert.equal(r.remaining, 2, 'reported as unkeyed, not folded into an opportunity it may not belong to')
})
