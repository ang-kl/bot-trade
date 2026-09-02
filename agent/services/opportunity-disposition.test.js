// node --test agent/services/opportunity-disposition.test.js
//
// §70.8. The load-bearing test here is the ORDER of the decision table: a
// receipt is itself an approved row, and counting it as an approval that
// landed double-counts every successful placement — the mistake
// decision-audit.js already had to unwind once. The rest is about not
// manufacturing the alarm this exists to detect.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { readFileSync } from 'node:fs'
import {
  DISPOSITIONS, DEFAULT_GRACE_MIN, dispositionFor,
  sweepDispositions, drainDispositions, recordSubmitted, dispositionReport, revisitDropped,
} from './opportunity-disposition.js'

const RECEIPT = JSON.stringify({ pending_order_placed: true, orderId: 352974283 })
const REFUSAL = JSON.stringify({ post_approval: true, reason: 'volume below broker minimum' })
const PLAIN = JSON.stringify({ balance: 50000, account_id: '46130058' })

function fresh() { return initDB(':memory:') }

function riskEvent(db, { approved = 1, checks = PLAIN, minsAgo = 60, symbol = 'EURUSD', account = '46130058' } = {}) {
  return db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
    VALUES (?, 'BUY', ?, NULL, ?, '{}', ?, datetime('now', ?))
  `).run(symbol, approved, checks, account, `-${minsAgo} minutes`).lastInsertRowid
}

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

test('a veto is terminal on arrival', () => {
  assert.equal(dispositionFor({ approved: 0, checksJson: PLAIN }), 'vetoed')
})

test('a RECEIPT is classified before "ordered" — this ordering is the whole test', () => {
  // A receipt is an approved row that also references nothing. Read as an
  // approval it would double-count every successful placement.
  assert.equal(dispositionFor({ approved: 1, checksJson: RECEIPT, landed: false, ageMin: 999 }), 'receipt')
  assert.equal(dispositionFor({ approved: 1, checksJson: RECEIPT, landed: true, ageMin: 999 }), 'receipt')
})

test('a post-approval refusal is its own end state, not a drop', () => {
  // It did not go nowhere. It went somewhere loud, with a named reason.
  assert.equal(dispositionFor({ approved: 1, checksJson: REFUSAL, landed: false, ageMin: 999 }), 'refused_post_approval')
})

test('an approval a row references is ordered', () => {
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: true, ageMin: 1 }), 'ordered')
})

test('an approval inside the grace window is NOT yet terminal', () => {
  // A controller that labelled a live order "dropped" would manufacture the
  // alarm it exists to detect.
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: 1 }), null)
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: DEFAULT_GRACE_MIN - 0.1 }), null)
})

test('an approval past grace with nothing referencing it is the §70.8 finding', () => {
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: DEFAULT_GRACE_MIN + 1 }), 'dropped')
})

test('every value the table can produce is in the declared set', () => {
  const produced = new Set()
  for (const approved of [0, 1]) {
    for (const checksJson of [PLAIN, RECEIPT, REFUSAL]) {
      for (const landed of [true, false]) {
        for (const ageMin of [0, 999]) {
          const d = dispositionFor({ approved, checksJson, landed, ageMin })
          if (d != null) produced.add(d)
        }
      }
    }
  }
  for (const d of produced) assert.ok(DISPOSITIONS.includes(d), `${d} is not a declared disposition`)
})

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test('the sweep settles what it can and leaves the in-flight alone', () => {
  const db = fresh()
  const dropped = riskEvent(db, { minsAgo: 60 })
  const inflight = riskEvent(db, { minsAgo: 1 })
  const vetoed = riskEvent(db, { approved: 0, minsAgo: 60 })

  const out = sweepDispositions(db)
  assert.equal(out.written, 2)
  assert.equal(out.pending, 1)
  assert.equal(out.counts.dropped, 1)
  assert.equal(out.counts.vetoed, 1)

  const get = (id) => db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition
  assert.equal(get(dropped), 'dropped')
  assert.equal(get(vetoed), 'vetoed')
  assert.equal(get(inflight), null, 'still resolving — not yet a finding')
})

test('an approval a trade references reads as ordered, not dropped', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id, account_id)
              VALUES ('EURUSD','BUY',1.1,'open',datetime('now'),?,'46130058')`).run(id)
  sweepDispositions(db)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

test('a pending order counts as landing too', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  db.prepare(`INSERT INTO pending_orders (symbol, dir, level, status, risk_event_id)
              VALUES ('EURUSD',1,1.1,'working',?)`).run(id)
  sweepDispositions(db)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

test('the sweep is idempotent — a settled row is not rewritten', () => {
  const db = fresh()
  riskEvent(db, { minsAgo: 60 })
  assert.equal(sweepDispositions(db).written, 1)
  assert.equal(sweepDispositions(db).written, 0, 'second pass costs one scan and no writes')
  assert.equal(sweepDispositions(db).scanned, 0, 'and stops scanning settled rows entirely')
})

test('redo re-derives, for when the derivation itself changed', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  sweepDispositions(db)
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id)
              VALUES ('EURUSD','BUY',1.1,'open',datetime('now'),?)`).run(id)
  assert.equal(sweepDispositions(db).written, 0, 'without redo the settled row stays')
  assert.equal(sweepDispositions(db, { redo: true }).written, 1)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

// ---------------------------------------------------------------------------
// Latency and the report
// ---------------------------------------------------------------------------

test('submitted_at is written once and never overwritten', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  assert.equal(recordSubmitted(db, id, '2026-08-04T10:00:00.000Z'), true)
  recordSubmitted(db, id, '2026-08-04T11:00:00.000Z')
  assert.equal(
    db.prepare('SELECT submitted_at FROM risk_events WHERE id = ?').get(id).submitted_at,
    '2026-08-04T10:00:00.000Z',
    'a retry must not restate when the order first left',
  )
  assert.equal(recordSubmitted(db, null), false)
  assert.equal(recordSubmitted(db, 999999), false)
})

test('the report names the dropped rows rather than only counting them', () => {
  // "the counts disagree by 17" was never actionable. Seventeen ids are.
  const db = fresh()
  riskEvent(db, { minsAgo: 60, symbol: 'NAS100' })
  riskEvent(db, { minsAgo: 60, symbol: 'USDZAR' })
  riskEvent(db, { approved: 0, minsAgo: 60 })
  sweepDispositions(db)

  const rep = dispositionReport(db)
  assert.equal(rep.counts.dropped, 2)
  assert.equal(rep.counts.vetoed, 1)
  assert.equal(rep.droppedTotal, 2)
  assert.deepEqual(rep.dropped.map(d => d.symbol).sort(), ['NAS100', 'USDZAR'])
  assert.ok(rep.dropped.every(d => d.id > 0 && d.at))
})

test('approval-to-submit latency is the interval nothing timed before', () => {
  const db = fresh()
  const id = db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, checks_json, proposal_json, created_at)
    VALUES ('EURUSD','BUY',1,'{}','{}','2026-08-04 10:00:00')
  `).run().lastInsertRowid
  recordSubmitted(db, id, '2026-08-04T10:00:02.500Z')
  const rep = dispositionReport(db, { days: 90 })
  assert.equal(rep.latency.n, 1)
  assert.equal(rep.latency.p50, 2500)
})

test('rows still in flight are reported as pending, not as a failure', () => {
  const db = fresh()
  riskEvent(db, { minsAgo: 1 })
  sweepDispositions(db)
  const rep = dispositionReport(db)
  assert.equal(rep.pendingNow, 1)
  assert.equal(rep.counts.dropped, undefined)
})

test('an empty database is a calm empty report', () => {
  const db = fresh()
  const rep = dispositionReport(db)
  assert.deepEqual(rep.counts, {})
  assert.deepEqual(rep.dropped, [])
  assert.equal(rep.latency, null)
})

test('account=all is the portfolio read, NOT an account named "all"', () => {
  // PRODUCTION, 2026-08-06. GET /state/dispositions?days=7&account=all returned
  // `counts {}` and `pendingNow 0` for a window that held 54,815 rows. The
  // filter had become `account_id = 'all'`, which matches nothing, so the route
  // answered a confident, empty, WRONG report — the worst of the three, and for
  // the query an operator reaches for first when asking where an approval went.
  //
  // opportunity-funnel.js:44 already spelled this correctly. The two functions
  // are read side by side on the same screen, and only one of them was right.
  const db = fresh()
  riskEvent(db, { minsAgo: 60, symbol: 'NAS100', account: '46130058' })
  riskEvent(db, { minsAgo: 60, symbol: 'USDZAR', account: '47790949' })
  riskEvent(db, { approved: 0, minsAgo: 60, account: '42993489' })
  sweepDispositions(db)

  const all = dispositionReport(db, { account: 'all' })
  assert.equal(all.counts.dropped, 2, 'both accounts\' drops are counted')
  assert.equal(all.counts.vetoed, 1)

  // And scoping to ONE account still narrows, so the fix did not turn the
  // filter off altogether — which would be the same bug facing the other way.
  const one = dispositionReport(db, { account: '46130058' })
  assert.equal(one.counts.dropped, 1)
  assert.equal(one.counts.vetoed ?? 0, 0)

  // An account that exists but owns nothing reports nothing — distinguishable
  // from `all` only because `all` above is non-empty.
  const none = dispositionReport(db, { account: '99999999' })
  assert.deepEqual(none.counts, {})
})

// ---------------------------------------------------------------------------
// The drain — one batch was not enough
// ---------------------------------------------------------------------------

test('drainDispositions settles a backlog larger than one batch', () => {
  // THE PRODUCTION CASE, in miniature. On 2026-08-06 `/state/dispositions`
  // reported 55,443 unsettled approvals. The sweep caps at `limit` rows per
  // call and housekeeping runs every eight hours, so at 5,000 a pass the
  // backlog needed four days to become readable — and until then the §70.8
  // finding was invisible for exactly the rows it is about.
  const db = fresh()
  for (let i = 0; i < 25; i++) riskEvent(db, { minsAgo: 60, symbol: `SYM${i}` })

  const one = sweepDispositions(db, { limit: 10 })
  assert.equal(one.written, 10, 'a single sweep is capped')

  const out = drainDispositions(db, { limit: 10 })
  assert.equal(out.written, 15, 'the drain finishes the remaining rows')
  assert.ok(out.batches >= 2)
  assert.equal(out.drained, true)
  assert.equal(out.counts.dropped, 15)

  const left = db.prepare('SELECT COUNT(*) AS n FROM risk_events WHERE disposition IS NULL').get().n
  assert.equal(left, 0)
})

test('the drain stops at its cap and SAYS so rather than reading as complete', () => {
  const db = fresh()
  for (let i = 0; i < 20; i++) riskEvent(db, { minsAgo: 60, symbol: `S${i}` })
  const out = drainDispositions(db, { limit: 5, maxBatches: 2 })
  assert.equal(out.written, 10)
  assert.equal(out.drained, false, 'a truncated drain must not claim it drained')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events WHERE disposition IS NULL').get().n, 10)
})

test('the drain terminates when everything left is still in flight', () => {
  const db = fresh()
  riskEvent(db, { minsAgo: 1 })
  const out = drainDispositions(db)
  assert.equal(out.written, 0)
  assert.equal(out.pending, 1)
  assert.equal(out.batches, 1, 'no repeated queries for the same answer')
  assert.equal(out.drained, true)
})

// ---------------------------------------------------------------------------
// SIBLING EVIDENCE (02-09-2026). JPM.US at 19:53Z: approval 394092 was
// attempted, refused post-approval as its OWN row (394093, SYMBOL_NOT_FOUND),
// re-keyed and re-approved as 394094 which landed. The sweep read 394092 as
// "dropped" and the inspector counted it as a silent gap.
// ---------------------------------------------------------------------------
const REFUSAL_ROW = JSON.stringify({ post_approval: true, adjusted_volume: 0 })
function riskEventAt(db, { approved = 1, checks = PLAIN, secsAgo = 600, symbol = 'JPM.US', side = 'SELL', account = '46130058' } = {}) {
  return db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
    VALUES (?, ?, ?, NULL, ?, '{}', ?, datetime('now', ?))
  `).run(symbol, side, approved, checks, account, `-${secsAgo} seconds`).lastInsertRowid
}

test('an attempted-and-refused approval reads refused_post_approval from its sibling refusal row, and its landed successor is not a drop', () => {
  const db = fresh()
  const first = riskEventAt(db, { secsAgo: 1200 })                                  // 394092
  riskEventAt(db, { approved: 0, checks: REFUSAL_ROW, secsAgo: 1192 })              // 394093
  const second = riskEventAt(db, { secsAgo: 1192 })                                 // 394094
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id, account_id)
              VALUES ('JPM.US','SELL',354.27,'open',datetime('now'),?,'46130058')`).run(second)
  const out = sweepDispositions(db)
  const get = (id) => db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition
  assert.equal(get(first), 'refused_post_approval', 'the refusal row is this approval\'s refusal')
  assert.equal(get(second), 'ordered')
  assert.equal(out.counts.dropped, undefined, 'nothing dropped: every approval has an end state')
})

test('a re-keyed retry that landed makes the earlier approval superseded, not dropped; beyond grace it is still dropped', () => {
  const db = fresh()
  const early = riskEventAt(db, { secsAgo: 1200 })
  const later = riskEventAt(db, { secsAgo: 1195 })
  db.prepare(`INSERT INTO pending_orders (symbol, dir, level, status, risk_event_id)
              VALUES ('JPM.US',-1,354.27,'working',?)`).run(later)
  // Same tuple but 40 minutes earlier: outside the 10-minute grace, its own drop.
  const stale = riskEventAt(db, { secsAgo: 2400 + 1195 })
  // A different account's approval is not this account's sibling.
  const other = riskEventAt(db, { secsAgo: 1200, account: '111' })
  sweepDispositions(db)
  const get = (id) => db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition
  assert.equal(get(early), 'superseded')
  assert.equal(get(later), 'ordered')
  assert.equal(get(stale), 'dropped')
  assert.equal(get(other), 'dropped')
  assert.ok(DISPOSITIONS.includes('superseded'))
})

test('revisitDropped re-judges rows already marked dropped inside its window, and only those', () => {
  const db = fresh()
  const first = riskEventAt(db, { secsAgo: 1200 })
  db.prepare(`UPDATE risk_events SET disposition = 'dropped', disposition_at = datetime('now') WHERE id = ?`).run(first)
  const old = riskEventAt(db, { secsAgo: 30 * 86_400 })
  db.prepare(`UPDATE risk_events SET disposition = 'dropped', disposition_at = datetime('now') WHERE id = ?`).run(old)
  const oldLater = riskEventAt(db, { secsAgo: 30 * 86_400 - 5 })
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id, account_id)
              VALUES ('JPM.US','SELL',354.27,'closed',datetime('now'),?,'46130058')`).run(oldLater)
  const second = riskEventAt(db, { secsAgo: 1195 })
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id, account_id)
              VALUES ('JPM.US','SELL',354.27,'open',datetime('now'),?,'46130058')`).run(second)
  assert.equal(sweepDispositions(db).counts.superseded, undefined, 'the plain sweep leaves settled rows alone — the drain depends on that')
  const out = revisitDropped(db, { days: 7 })
  const get = (id) => db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition
  assert.equal(get(first), 'superseded', 'healed: the sibling landed')
  assert.equal(get(old), 'dropped', 'outside the revisit window the old verdict stands, right or wrong')
  assert.equal(out.counts.superseded, 1)
  // Idempotent on the second pass.
  assert.equal(revisitDropped(db, { days: 7 }).written, 0)
})

test('the closed set covers the sibling-evidence outcomes too', () => {
  const produced = new Set()
  for (const refusedAfter of [false, true]) {
    for (const supersededBy of [false, true]) {
      for (const ageMin of [0, 999]) {
        const d = dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin, refusedAfter, supersededBy })
        if (d != null) produced.add(d)
      }
    }
  }
  assert.deepEqual([...produced].sort(), ['dropped', 'refused_post_approval', 'superseded'])
  for (const d of produced) assert.ok(DISPOSITIONS.includes(d))
})

test('wiring: housekeeping runs the bounded revisit after the drain', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const i = src.indexOf('drainDispositions(db)')
  assert.ok(i > 0)
  assert.match(src.slice(i, i + 1500), /revisitDropped\(db, \{ days: 7 \}\)/)
})
