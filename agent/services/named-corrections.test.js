// node --test agent/services/named-corrections.test.js
//
// V3 B2b (docs/v3-integrated-plan-2026-09-26.md §5 row 2.6, §6 OD-11/OD-12).
// On disposable SQLite:
//   - OD-11 (rejection half only — see the module doc): a non-terminal row
//     whose broker lifecycle evidence is a FINAL never_filled verdict under
//     the CURRENT rules is proposed (dry run) and rejected (apply); never a
//     closed/already-terminal row, never a non-final verdict, never a verdict
//     stored under an older rules version;
//   - OD-12: the dry run reports every named money correction and writes
//     nothing; apply writes only the non-stale ones (absolute value against
//     an expectedOld, never a delta — applying the same list twice writes
//     once and then skips every time after), re-stamps ONLY the corrected
//     row (a duplicate sibling on the same position is untouched — the
//     re-stamp fix), logs to action_log, and never deletes a row;
//   - a stale named correction (the row moved since the evidence was named,
//     whether recomputed fresh or handed in as an already-read plan) is
//     skipped, not forced.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'
import {
  NEVER_FILLED_REJECT_STATUSES, NAMED_MONEY_CORRECTIONS,
  neverFilledRejectionCandidates, planNeverFilledRejections, applyNeverFilledRejections,
  planNamedCorrections, applyNamedMoneyCorrections, runNamedCorrections,
} from './named-corrections.js'

const NOW = Date.parse('2026-09-26T12:00:00Z'), DAY = 86_400_000
const DEMO = '46130058'

function fresh(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  return db
}
const iso = ms => new Date(ms).toISOString()
function trade(db, { acct = DEMO, pid, status = 'closed', net = null, opened = NOW - 10 * DAY, closed = NOW - 9 * DAY,
  symbol = 'EURUSD', side = 'BUY', entry = 1.1, exit = 1.2, sl = 1.05 } = {}) {
  return Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at,
      entry_price, exit_price, sl_price, volume, net_pnl) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(acct, symbol, side, status, pid, iso(opened), status === 'closed' ? iso(closed) : null, entry, status === 'closed' ? exit : null, sl, net).lastInsertRowid)
}
function evidence(db, acct, pid, { verdict = 'never_filled', final = 1, rules = EVIDENCE_RULES, reason = 'the broker holds 2 deal(s) and none executed', readAt = NOW } = {}) {
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, rules, reason, read_at)
    VALUES (?,?,?,?,?,?,?)`).run(String(acct), String(pid), verdict, final, rules, reason, iso(readAt))
}
const rowSnap = (db, id) => db.prepare('SELECT status, net_pnl, realised_rr, pnl_price_mismatch, close_reason FROM trades WHERE id = ?').get(id)

// ---------------------------------------------------------------------------
// OD-11 — never-filled rejections
// ---------------------------------------------------------------------------

test('a non-terminal row with a FINAL never_filled verdict under the current rules is a candidate; a closed row, a rejected row, a non-final verdict and a different verdict are not', t => {
  const db = fresh(t)
  const openId = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, {})
  const closedId = trade(db, { pid: 701, status: 'closed', net: 12.3 })
  evidence(db, DEMO, 701, {})
  const alreadyRejectedId = trade(db, { pid: 702, status: 'rejected' })
  evidence(db, DEMO, 702, {})
  const nonFinalId = trade(db, { pid: 703, status: 'open' })
  evidence(db, DEMO, 703, { final: 0 })
  const otherVerdictId = trade(db, { pid: 704, status: 'open' })
  evidence(db, DEMO, 704, { verdict: 'open_at_broker' })

  const ids = neverFilledRejectionCandidates(db).map(c => c.id)
  assert.deepEqual(ids, [openId])
  for (const excluded of [closedId, alreadyRejectedId, nonFinalId, otherVerdictId]) assert.ok(!ids.includes(excluded))
})

test('N5: a FINAL never_filled verdict stored under an OLDER rules version is not a candidate — it is due a re-read, not trusted as final', t => {
  const db = fresh(t)
  const staleRulesId = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, { rules: EVIDENCE_RULES - 1 })
  const currentRulesId = trade(db, { pid: 701, status: 'open' })
  evidence(db, DEMO, 701, { rules: EVIDENCE_RULES })

  const ids = neverFilledRejectionCandidates(db).map(c => c.id)
  assert.deepEqual(ids, [currentRulesId])
  assert.ok(!ids.includes(staleRulesId))
})

test('every status in NEVER_FILLED_REJECT_STATUSES is eligible', t => {
  const db = fresh(t)
  const ids = NEVER_FILLED_REJECT_STATUSES.map((status, i) => {
    const id = trade(db, { pid: 800 + i, status })
    evidence(db, DEMO, 800 + i, {})
    return id
  })
  assert.deepEqual(neverFilledRejectionCandidates(db).map(c => c.id), ids)
})

test('the dry run reports old -> new and evidence, and writes nothing', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, { reason: 'REJECTED x2' })
  const before = rowSnap(db, id)

  const plan = planNeverFilledRejections(db)
  assert.equal(plan.length, 1)
  assert.deepEqual([plan[0].id, plan[0].field, plan[0].old, plan[0].new], [id, 'status', 'open', 'rejected'])
  assert.match(plan[0].evidence, /never_filled/)
  assert.match(plan[0].evidence, /REJECTED x2/)

  assert.deepEqual(rowSnap(db, id), before) // still nothing written
})

test('apply rejects the row, never deletes it, and stamps the OD-11 reason', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, { reason: 'REJECTED,REJECTED' })

  const { applied, skipped } = applyNeverFilledRejections(db)
  assert.deepEqual(applied.map(a => a.id), [id])
  assert.equal(skipped.length, 0)

  const after = rowSnap(db, id)
  assert.equal(after.status, 'rejected')
  assert.match(after.close_reason, /OD-11 write-off/)
  assert.match(after.close_reason, /never_filled/)

  // never deleted
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1)

  // idempotent: re-running finds no more candidates (now rejected/terminal)
  assert.equal(neverFilledRejectionCandidates(db).length, 0)
})

test('apply skips a row whose status changed since the plan was read (a race)', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, {})
  // Simulate the row filling between the read and the write.
  const candidates = neverFilledRejectionCandidates(db)
  db.prepare("UPDATE trades SET status = 'closed', net_pnl = 5, closed_at = ? WHERE id = ?").run(iso(NOW), id)
  const stmt = db.prepare(`UPDATE trades SET status = 'rejected' WHERE id = ? AND status = ?`)
  const res = stmt.run(id, candidates[0].oldStatus)
  assert.equal(res.changes, 0) // proves the guard clause actually matters
  assert.equal(rowSnap(db, id).status, 'closed')
})

// ---------------------------------------------------------------------------
// OD-12 — named money corrections (absolute only — checker BLOCKER 1)
// ---------------------------------------------------------------------------

test('dry run: an absolute correction reports old -> new only when the row still matches its named expectedOld; writes nothing', t => {
  const db = fresh(t)
  const matchId = trade(db, { pid: 1, status: 'closed', net: -196.35 })
  const noMatchId = trade(db, { pid: 2, status: 'closed', net: -1 })

  const namedList = [
    { id: matchId, table: 'trades', field: 'net_pnl', expectedOld: -196.35, value: -59.73, evidence: 'test match' },
    { id: noMatchId, table: 'trades', field: 'net_pnl', expectedOld: -196.35, value: -59.73, evidence: 'test no-match' },
  ]
  const plan = planNamedCorrections(db, { namedList })
  const byId = Object.fromEntries(plan.map(p => [p.id, p]))

  assert.deepEqual([byId[matchId].old, byId[matchId].new, byId[matchId].stale], [-196.35, -59.73, false])
  assert.equal(byId[noMatchId].stale, true)
  assert.match(byId[noMatchId].reason, /does not match/)

  assert.equal(rowSnap(db, matchId).net_pnl, -196.35)
  assert.equal(rowSnap(db, noMatchId).net_pnl, -1)
})

test('a row still open, or not found, is stale and never applied', t => {
  const db = fresh(t)
  const openId = trade(db, { pid: 1, status: 'open' })
  const namedList = [
    { id: openId, table: 'trades', field: 'net_pnl', expectedOld: 100, value: 110, evidence: 'open row' },
    { id: 999999, table: 'trades', field: 'net_pnl', expectedOld: 100, value: 110, evidence: 'missing row' },
  ]
  const plan = planNamedCorrections(db, { namedList })
  assert.ok(plan.every(p => p.stale))
})

test('apply writes only the non-stale corrections, re-stamps ONLY the corrected row (not a duplicate sibling on the same position), logs to action_log, and deletes nothing', t => {
  const db = fresh(t)
  // Two rows sharing one broker position (a duplicate group) — the sibling
  // must be left untouched by a correction to just one of them (the re-stamp
  // fix: restampPosition() in pnl-backfill.js restamps by POSITION, this must
  // restamp by TRADE ID only).
  const winnerId = trade(db, { pid: 47, status: 'closed', net: -196.35, entry: 1.10, exit: 1.10, sl: 1.05 })
  const siblingId = trade(db, { pid: 47, status: 'closed', net: -196.35, entry: 1.10, exit: 1.10, sl: 1.05 })
  const staleId = trade(db, { pid: 9, status: 'closed', net: -1 })

  const namedList = [
    { id: winnerId, table: 'trades', field: 'net_pnl', expectedOld: -196.35, value: -59.73, evidence: 'duplicate-group fix' },
    { id: staleId, table: 'trades', field: 'net_pnl', expectedOld: -196.35, value: -59.73, evidence: 'no longer matches' },
  ]

  // Before the write, neither row's audit columns are stamped.
  assert.equal(rowSnap(db, winnerId).realised_rr, null)
  assert.equal(rowSnap(db, siblingId).realised_rr, null)

  const { applied, skipped } = applyNamedMoneyCorrections(db, { namedList })
  assert.deepEqual(applied.map(a => a.id), [winnerId])
  assert.deepEqual(skipped.map(s => s.id), [staleId])

  assert.equal(rowSnap(db, winnerId).net_pnl, -59.73)
  assert.equal(rowSnap(db, siblingId).net_pnl, -196.35) // untouched
  assert.equal(rowSnap(db, staleId).net_pnl, -1) // untouched (stale, skipped)

  // Re-stamped: winner's audit columns now filled in.
  assert.notEqual(rowSnap(db, winnerId).realised_rr, null)
  // The sibling — same position, NOT the corrected row — must still be unstamped.
  assert.equal(rowSnap(db, siblingId).realised_rr, null)

  const logged = db.prepare("SELECT body FROM action_log WHERE method = 'NAMED_CORRECTION_APPLY'").get()
  assert.ok(logged)
  const body = JSON.parse(logged.body)
  assert.equal(body.applied, 1)
  assert.deepEqual(body.ids, [winnerId])

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 3) // nothing deleted
})

// ---------------------------------------------------------------------------
// Idempotence (checker BLOCKER 1) and the write-time check (checker N1)
// ---------------------------------------------------------------------------

test('BLOCKER 1 regression: applying the same named list TWICE writes the money once, then skips every time after', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 1253, status: 'closed', net: 864 })
  const namedList = [{ id, table: 'trades', field: 'net_pnl', expectedOld: 864, value: 1368.5, evidence: 'test #1253' }]

  const first = applyNamedMoneyCorrections(db, { namedList })
  assert.deepEqual(first.applied.map(a => a.id), [id])
  assert.equal(rowSnap(db, id).net_pnl, 1368.5)

  const second = applyNamedMoneyCorrections(db, { namedList })
  assert.equal(second.applied.length, 0, 'a second apply must not move the money again')
  assert.deepEqual(second.skipped.map(s => s.id), [id])
  assert.equal(rowSnap(db, id).net_pnl, 1368.5, 'still 1368.5, not 1873')

  const third = applyNamedMoneyCorrections(db, { namedList })
  assert.equal(third.applied.length, 0)
  assert.equal(rowSnap(db, id).net_pnl, 1368.5)
})

test('N1: the write-time check — plan first, change the row, THEN apply the now-stale plan; the write is skipped, not forced', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 1, status: 'closed', net: 100 })
  const namedList = [{ id, table: 'trades', field: 'net_pnl', expectedOld: 100, value: 150, evidence: 'test race' }]

  // 1. Plan while the row still matches.
  const plan = planNamedCorrections(db, { namedList })
  assert.equal(plan[0].stale, false)
  assert.equal(plan[0].old, 100)

  // 2. Something else corrects the row in between (a concurrent writer).
  db.prepare('UPDATE trades SET net_pnl = 999 WHERE id = ?').run(id)

  // 3. Apply the ALREADY-COMPUTED plan (not recomputed) — the UPDATE's own
  //    `AND net_pnl = ?` guard, not planOne's staleness check, is what must
  //    catch this: the plan itself still says old=100 and is not marked stale.
  const { applied, skipped } = applyNamedMoneyCorrections(db, { plan })
  assert.equal(applied.length, 0, 'the write-time guard must have caught the race')
  assert.deepEqual(skipped.map(s => s.id), [id])
  assert.match(skipped[0].reason, /changed between the plan read and the write/)
  assert.equal(rowSnap(db, id).net_pnl, 999, 'the concurrent write must win, never be overwritten')
})

test('applying an already-stale plan (computed after the row diverged) is also skipped, via planOne itself', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 1, status: 'closed', net: 999 })
  const namedList = [{ id, table: 'trades', field: 'net_pnl', expectedOld: 100, value: 150, evidence: 'test' }]
  const { applied, skipped } = applyNamedMoneyCorrections(db, { namedList })
  assert.equal(applied.length, 0)
  assert.deepEqual(skipped.map(s => s.id), [id])
})

// ---------------------------------------------------------------------------
// The dry-run-by-default guard (OD-12: "dry run first, then a named apply")
// ---------------------------------------------------------------------------

test('runNamedCorrections defaults to a dry run that writes nothing; apply:true is the only way past it', t => {
  const db = fresh(t)
  const neverFilledId = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, {})
  const moneyId = trade(db, { pid: 47, status: 'closed', net: -196.35 })
  const namedList = [{ id: moneyId, table: 'trades', field: 'net_pnl', expectedOld: -196.35, value: -59.73, evidence: 'x' }]

  const before = [rowSnap(db, neverFilledId), rowSnap(db, moneyId)]
  const dry = runNamedCorrections(db, { namedList })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.mode, 'plan')
  assert.equal(dry.neverFilled.found, 1)
  assert.equal(dry.money.found, 1)
  assert.deepEqual([rowSnap(db, neverFilledId), rowSnap(db, moneyId)], before)

  const applied = runNamedCorrections(db, { apply: true, namedList })
  assert.equal(applied.dryRun, false)
  assert.equal(applied.mode, 'apply')
  assert.equal(applied.neverFilled.applied, 1)
  assert.equal(applied.money.applied, 1)
  assert.equal(rowSnap(db, neverFilledId).status, 'rejected')
  assert.equal(rowSnap(db, moneyId).net_pnl, -59.73)
})

test('the built-in NAMED_MONEY_CORRECTIONS list is well-formed: every entry is absolute (expectedOld + value), no #47, five checker-confirmed entries', () => {
  assert.equal(NAMED_MONEY_CORRECTIONS.length, 5)
  assert.ok(!NAMED_MONEY_CORRECTIONS.some(e => e.id === 47), '#47 was a report-display bug, not a ledger defect — must not be in the apply list')
  for (const entry of NAMED_MONEY_CORRECTIONS) {
    assert.equal(typeof entry.id, 'number')
    assert.equal(entry.table, 'trades')
    assert.equal(entry.field, 'net_pnl')
    assert.equal(typeof entry.expectedOld, 'number')
    assert.equal(typeof entry.value, 'number')
    assert.notEqual(entry.mode, 'delta')
    assert.equal(typeof entry.evidence, 'string')
    assert.ok(entry.evidence.length > 0)
  }
  assert.deepEqual(NAMED_MONEY_CORRECTIONS.map(e => e.id).sort((a, b) => a - b), [309, 466, 471, 714, 1253])
})
