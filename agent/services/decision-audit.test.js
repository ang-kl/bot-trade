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
  auditDecisions, shouldAlert, publicPipelineView, toText, VERDICTS, guardName,
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

function gate(db, { approved, reason = null, at = insideDay(), accountId = null, symbol = 'EURUSD', checks = null }) {
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, account_id, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(symbol, 'buy', approved ? 1 : 0, reason, checks ? JSON.stringify(checks) : null, accountId, at)
}

const approve = (db, o) => gate(db, { ...o, approved: true })

/** A refusal that happens AFTER the gate approved — loud, not silent. */
const resolve = (db, o) => gate(db, { ...o, approved: false, checks: { post_approval: true } })

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
})

test('§70.8 THE GATE IS SCOPED TOO — it was comparing every account\'s approvals', () => {
  // This module used to assert, here and in `gateScope`, that risk_events
  // carries no account column. It does: the M1a migration adds one to thirteen
  // tables (db.js:954-964) and persistRiskEvent has written it ever since. So
  // an audit asked about ONE account measured that account's trades against
  // EVERY account's approvals — which manufactures silent drops out of a
  // perfectly healthy portfolio, the exact false alarm this module exists not
  // to raise. The old test encoded the wrong claim and passed for years.
  const db = initDB(':memory:')
  approve(db, { symbol: 'EURUSD', accountId: '46130058' })
  approve(db, { symbol: 'XAUUSD', accountId: '99999999' })
  approve(db, { symbol: 'GBPUSD', accountId: '99999999' })
  const a = auditDecisions(db, { accountId: '46130058' })
  assert.equal(a.approved, 1, 'only this account\'s approvals')
  assert.equal(a.gateScope, 'account 46130058')
  assert.equal(auditDecisions(db).approved, 3, 'and unscoped still sees them all')
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

// ---------------------------------------------------------------------------
// The public projection is a SECURITY BOUNDARY, and reasons are free text.
//
// Veto reasons are built with template literals and routinely carry live
// detail — `below_min_volume: ${volLots} lots`, `pending_invalidated: close
// ${close} beyond SL ${row.sl} — order ${id} cancelled`, `sizing_failed:
// ${err.message}`. The `topBlock` field shipped in #571 passed a raw reason
// straight through. These pin the sanitiser so that cannot recur.
// ---------------------------------------------------------------------------

test('guardName keeps the identifier and discards everything after it', () => {
  assert.equal(guardName('below_min_volume: 0.42 lots'), 'below_min_volume')
  assert.equal(guardName('pending_invalidated: close 1.0842 beyond SL 1.0870 — order 55123 cancelled'), 'pending_invalidated')
  assert.equal(guardName('sizing_failed: ECONNRESET at 10.0.0.4:443'), 'sizing_failed')
  assert.equal(guardName('vpo_pre_arm margin 12.5% below floor'), 'vpo_pre_arm')
  assert.equal(guardName('insufficient_margin'), 'insufficient_margin')
  // A reason that leads with detail rather than a name yields nothing, and the
  // caller omits it — half-publishing is worse than omitting.
  assert.equal(guardName('1.0842 beyond SL'), '')
  assert.equal(guardName(null), '')
})

test('no price, size, order id or error text reaches the public projection', () => {
  const db = initDB(':memory:')
  gate(db, { approved: false, reason: 'pending_invalidated: close 1.0842 beyond SL 1.0870 — order 55123 cancelled' })
  gate(db, { approved: false, reason: 'below_min_volume: 0.42 lots' })
  gate(db, { approved: false, reason: 'sizing_failed: ECONNRESET at 10.0.0.4:443' })
  skip(db, { stage: 'stage_matrix', reason: "strategy 'vwap_trend' is OFF at 1.0842" })

  const pub = JSON.stringify(publicPipelineView(auditDecisions(db)))
  for (const leak of ['1.0842', '1.0870', '55123', '0.42', 'ECONNRESET', '10.0.0.4', 'lots']) {
    assert.ok(!pub.includes(leak), `public view leaked "${leak}" — ${pub}`)
  }
  // Still useful: the guard NAMES survive, which is the whole point.
  const v = publicPipelineView(auditDecisions(db))
  const guards = v.topVetoes.map(x => x.guard)
  assert.ok(guards.includes('pending_invalidated'), `expected guard names, got ${JSON.stringify(v.topVetoes)}`)
  assert.equal(v.topBlock, 'stage_matrix:strategy')
})

test('sanitising merges reasons that share a guard, instead of listing it twice', () => {
  const db = initDB(':memory:')
  // Two raw reasons, one guard. The first live reading listed overexposed_USD
  // at 138 and again at 18 — understating it, and spending a top-five slot
  // that a distinct guard should have had.
  for (let i = 0; i < 3; i++) gate(db, { approved: false, reason: 'overexposed_USD: 3 of 3' })
  for (let i = 0; i < 2; i++) gate(db, { approved: false, reason: 'overexposed_USD: 2 of 2' })
  gate(db, { approved: false, reason: 'bad_rr: 0.8 below 1.5' })

  const v = publicPipelineView(auditDecisions(db))
  const over = v.topVetoes.filter(x => x.guard === 'overexposed_USD')
  assert.equal(over.length, 1, `overexposed_USD must appear once, saw ${JSON.stringify(v.topVetoes)}`)
  assert.equal(over[0].n, 5, 'and carry the merged count')
  // And the merged entry must re-sort above the smaller one.
  assert.equal(v.topVetoes[0].guard, 'overexposed_USD')
})

// ---------------------------------------------------------------------------
// §70.8 — a refusal with a reason is not a silent drop
// ---------------------------------------------------------------------------

test('a post-approval refusal is ACCOUNTED FOR, not counted as a silent drop', () => {
  // The production reading that started §70.8: "96 approved at the gate but
  // only 79 order(s)/trade(s) exist — 17 approval(s) went nowhere". A proposal
  // that clears the gate can still be refused downstream — under the broker
  // minimum, spread blown out, idempotency window, broker rejection — and each
  // of those writes a SECOND risk_events row while the approved row stays.
  // Subtracting landed from approved counted every one as unexplained.
  const db = initDB(':memory:')
  approve(db, {})
  resolve(db, { reason: 'spread_too_wide: 0.00042 > 30% of SL distance 0.00110' })
  const a = auditDecisions(db)
  assert.equal(a.approved, 1)
  assert.equal(a.resolutions, 1)
  assert.equal(a.silentDrops, 0, 'it went somewhere loud, one row below')
  assert.notEqual(a.verdict, VERDICTS.SILENT_DROP)
})

test('an ORDINARY veto is still not a resolution — only post-approval ones are', () => {
  // A gate veto never had an approval to resolve. Counting it would let a day
  // of pure rejections mask a real drop.
  const db = initDB(':memory:')
  approve(db, {})
  gate(db, { approved: false, reason: 'daily_loss_limit_hit' })
  const a = auditDecisions(db)
  assert.equal(a.resolutions, 0)
  assert.equal(a.silentDrops, 1, 'the approval is still unaccounted for')
  assert.equal(a.verdict, VERDICTS.SILENT_DROP)
})

test('a REAL silent drop still fires — the alarm was made accurate, not quieter', () => {
  const db = initDB(':memory:')
  approve(db, {})
  approve(db, {})
  resolve(db, { reason: 'below_min_volume: 0.01 lots' })
  const a = auditDecisions(db)
  assert.equal(a.silentDrops, 1)
  assert.equal(a.verdict, VERDICTS.SILENT_DROP)
  assert.match(a.because, /nothing recorded/)
  assert.equal(shouldAlert(a)?.level, 'error')
})

test('the reason for each downstream refusal is reported, not just the count', () => {
  // "17 went nowhere" was unactionable. Naming what refused them is the point.
  const db = initDB(':memory:')
  approve(db, {}); approve(db, {})
  resolve(db, { reason: 'below_min_volume: 0.01 lots' })
  resolve(db, { reason: 'symbol_id_unknown: 0700.HK is not in symbol_id_map' })
  const a = auditDecisions(db)
  assert.equal(a.resolutions, 2)
  assert.deepEqual(a.topResolutions.map(r => r.n), [1, 1])
  assert.match(toText(a), /refused after approval/)
})

test('the public projection publishes the COUNT and never the reasons', () => {
  // Same boundary as topVetoes: reasons carry prices, sizes and order ids.
  const db = initDB(':memory:')
  approve(db, {})
  resolve(db, { reason: 'below_min_volume: 0.42 lots (4200) < broker minimum 10000' })
  const pub = publicPipelineView(auditDecisions(db))
  assert.equal(pub.resolutions, 1)
  assert.equal(JSON.stringify(pub).includes('0.42'), false)
  assert.equal(JSON.stringify(pub).includes('topResolutions'), false)
})

test('a healthy day reads as traded and SAYS how many were refused downstream', () => {
  const db = initDB(':memory:')
  approve(db, {}); approve(db, {})
  resolve(db, { reason: 'duplicate_submission: trade #12 already recorded' })
  db.prepare(`INSERT INTO trades (symbol, side, opened_at) VALUES (?,?,?)`)
    .run('EURUSD', 'buy', insideDay(2))
  const a = auditDecisions(db)
  assert.equal(a.verdict, VERDICTS.TRADED)
  assert.match(a.because, /1 refused downstream/)
})
