// Tests for the post-decision auditor.
//
// The interesting cases are not "does it count rows". They are:
//   - does it tell a BLOCKED gate apart from a quiet market (collapsing those
//     two is how a monitor becomes noise you learn to ignore)
//   - does it catch an approval that produced nothing (the silent drop)
//   - does it survive the schema traps that broke the first draft of this
//     file: fxDayStartSql returns a VALUE not SQL, trades uses `opened_at`,
//     pending_orders uses `placed_at`, and datetime('now') is space-separated
//   - does the public projection actually leak nothing
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB } from '../db.js'
import { fxDayStartSql } from './risk.js'
import {
  auditDecisions, shouldAlert, publicPipelineView, toText, VERDICTS,
} from './decision-audit.js'

/** A timestamp inside the current FX day, in SQLite's own space-separated form. */
function insideDay(offsetMin = 1) {
  const ms = Date.parse(fxDayStartSql().replace(' ', 'T') + 'Z') + offsetMin * 60_000
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function skip(db, { stage, reason = null, accountId = null, at = insideDay() }) {
  db.prepare(`INSERT INTO decision_log (account_id, symbol, stage, decision, reason, created_at)
              VALUES (?,?,?,?,?,?)`).run(accountId, 'EURUSD', stage, 'skip', reason, at)
}

function gate(db, { approved, reason = null, at = insideDay() }) {
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at)
              VALUES (?,?,?,?,?)`).run('EURUSD', 'buy', approved ? 1 : 0, reason, at)
}

test('scans ran and nothing set up reads as no_signal, not as a blocked gate', () => {
  const db = initDB(':memory:')
  // 'proceed' rows are activity without rejection — the pipeline worked and
  // simply had nothing to do.
  db.prepare(`INSERT INTO decision_log (stage, decision, reason, created_at)
              VALUES ('dispatch','proceed','scanned',?)`).run(insideDay())
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.NO_SIGNAL)
  assert.match(a.because, /no setup qualified/)
  // And it must NOT alert. A quiet market waking the owner is the failure
  // mode that makes people stop reading alerts.
  assert.equal(shouldAlert(a, { marketOpen: true }), null)
})

test('a gate that vetoed everything reads as blocked and names the top reason', () => {
  const db = initDB(':memory:')
  gate(db, { approved: false, reason: 'insufficient_margin' })
  gate(db, { approved: false, reason: 'insufficient_margin' })
  gate(db, { approved: false, reason: 'duplicate_symbol' })
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.BLOCKED)
  assert.equal(a.vetoed, 3)
  assert.equal(a.approved, 0)
  assert.equal(a.topVetoes[0].key, 'insufficient_margin')
  assert.equal(a.topVetoes[0].n, 2)
  assert.match(shouldAlert(a, { marketOpen: true })?.text || '', /insufficient_margin/)
})

test('nothing reaching the gate names the UPSTREAM stage that ate it', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 5; i++) skip(db, { stage: 'style_filter', reason: 'all_styles_disabled' })
  skip(db, { stage: 'lesson_decay', reason: 'alpha_decay_cooloff' })
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.BLOCKED)
  assert.equal(a.reachedGate, 0)
  // The whole value of this module in one string: "why didn't it trade".
  assert.match(a.because, /nothing reached the risk gate/)
  assert.match(a.because, /style_filter:all_styles_disabled/)
})

test('THE SILENT DROP — approved at the gate, nothing landed', () => {
  const db = initDB(':memory:')
  gate(db, { approved: true })
  gate(db, { approved: true })
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.SILENT_DROP)
  assert.equal(a.silentDrops, 2)
  // This one wakes the owner even with the market shut — an approval that
  // vanished is not a market condition.
  assert.equal(shouldAlert(a, { marketOpen: false })?.level, 'error')
})

test('a pending order counts as landed — an approval need not become a fill', () => {
  const db = initDB(':memory:')
  gate(db, { approved: true })
  db.prepare(`INSERT INTO pending_orders (symbol, placed_at) VALUES ('EURUSD', ?)`).run(insideDay())
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.TRADED)
  assert.equal(a.silentDrops, 0, 'a resting order is not a dropped approval')
})

// ---------------------------------------------------------------------------
// The schema traps. Each of these caught a real bug in this file's first
// draft, so each is pinned rather than trusted.
// ---------------------------------------------------------------------------

test('trades are read from opened_at — a wrong column name would report every day idle', () => {
  const db = initDB(':memory:')
  gate(db, { approved: true })
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at) VALUES ('EURUSD','buy','open',?)`)
    .run(insideDay())
  const a = auditDecisions(db)
  assert.equal(a.tradesOpened, 1)
  assert.equal(a.verdict, VERDICTS.TRADED)
  // A throwing query would land in the catch and silently return the blank
  // reading, so an idle verdict here would mean the SQL is broken, not the day.
  assert.notEqual(a.verdict, VERDICTS.IDLE)
})

test('a T-separated timestamp is matched too — both writer forms exist in this DB', () => {
  const db = initDB(':memory:')
  const tForm = insideDay(5).replace(' ', 'T')
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
              VALUES ('EURUSD',0,'news_window',?)`).run(tForm)
  const a = auditDecisions(db)
  assert.equal(a.vetoed, 1, 'an ISO T-form row must not be invisible to the day filter')
})

test('rows before the FX day open are excluded', () => {
  const db = initDB(':memory:')
  const before = new Date(Date.parse(fxDayStartSql().replace(' ', 'T') + 'Z') - 60_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  gate(db, { approved: false, reason: 'stale', at: before })
  const a = auditDecisions(db)
  assert.equal(a.vetoed, 0)
  assert.equal(a.verdict, VERDICTS.IDLE)
})

test('account scoping includes NULL-stamped rows, per the scoped-read convention', () => {
  const db = initDB(':memory:')
  skip(db, { stage: 'style_filter', accountId: '46130058' })
  skip(db, { stage: 'style_filter', accountId: null })      // predates stamping
  skip(db, { stage: 'style_filter', accountId: '99999999' }) // another account
  const a = auditDecisions(db, { accountId: '46130058' })
  assert.equal(a.considered, 2, 'own rows plus unstamped rows, never another account\'s')
  assert.equal(a.scope, 'account 46130058')
  // And the gate numbers must SAY they are not scoped rather than imply they are.
  assert.match(a.gateScope, /no account column/)
})

// ---------------------------------------------------------------------------
// The public projection. /health's unauthenticated subset is deliberately
// minimal; this is the one exception and it must stay narrow.
// ---------------------------------------------------------------------------

test('the public view carries counts and stage names, never instruments or money', () => {
  const db = initDB(':memory:')
  gate(db, { approved: false, reason: 'insufficient_margin' })
  skip(db, { stage: 'style_filter', accountId: '46130058' })
  db.prepare(`INSERT INTO trades (symbol, side, volume, entry_price, status, opened_at)
              VALUES ('XAUUSD','buy',2.5,3310.55,'open',?)`).run(insideDay())

  const pub = JSON.stringify(publicPipelineView(auditDecisions(db)))
  for (const leak of ['XAUUSD', 'EURUSD', '3310', '2.5', '46130058']) {
    assert.ok(!pub.includes(leak), `public view must not carry "${leak}" — it is ${pub}`)
  }
  const v = publicPipelineView(auditDecisions(db))
  assert.ok(typeof v.verdict === 'string' && v.considered >= 1, 'but it must still be useful')
})

test('a broken DB reports its own failure rather than throwing into the loop', () => {
  const db = initDB(':memory:')
  db.exec('DROP TABLE decision_log')
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.IDLE)
  assert.match(a.because, /audit failed/)
  assert.equal(typeof toText(a), 'string')
})
