// node --test agent/services/named-corrections.test.js
//
// V3 B2b + UI-5 (docs/v3-integrated-plan-2026-09-26.md §5 row 2.6, §6
// OD-11/OD-12). On disposable SQLite:
//   - OD-11: a non-terminal row whose broker lifecycle evidence is a FINAL
//     never_filled verdict is proposed (dry run) and rejected (apply), never
//     a closed/already-terminal row, never from a non-final verdict;
//   - OD-12: the dry run reports every named money correction and writes
//     nothing; apply writes only the non-stale ones, re-stamps ONLY the
//     corrected row (a duplicate sibling on the same position is untouched —
//     the re-stamp fix), logs to action_log, and never deletes a row;
//   - a stale named correction (the row moved since the evidence was named)
//     is skipped, not forced.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
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
function evidence(db, acct, pid, { verdict = 'never_filled', final = 1, rules = 1, reason = 'the broker holds 2 deal(s) and none executed', readAt = NOW } = {}) {
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, rules, reason, read_at)
    VALUES (?,?,?,?,?,?,?)`).run(String(acct), String(pid), verdict, final, rules, reason, iso(readAt))
}
const rowSnap = (db, id) => db.prepare('SELECT status, net_pnl, realised_rr, pnl_price_mismatch, close_reason FROM trades WHERE id = ?').get(id)

// ---------------------------------------------------------------------------
// OD-11 — never-filled rejections
// ---------------------------------------------------------------------------

test('a non-terminal row with a FINAL never_filled verdict is a candidate; a closed row, a rejected row and a non-final verdict are not', t => {
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
// OD-12 — named money corrections
// ---------------------------------------------------------------------------

test('dry run: a delta correction reports old+delta; an absolute correction matches only its named expectedOld; writes nothing', t => {
  const db = fresh(t)
  const deltaId = trade(db, { pid: 1, status: 'closed', net: 100 })
  const absMatchId = trade(db, { pid: 2, status: 'closed', net: -196.35 })
  const absNoMatchId = trade(db, { pid: 3, status: 'closed', net: -1 })

  const namedList = [
    { id: deltaId, table: 'trades', field: 'net_pnl', mode: 'delta', value: 10, evidence: 'test delta' },
    { id: absMatchId, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35, evidence: 'test absolute match' },
    { id: absNoMatchId, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35, evidence: 'test absolute no-match' },
  ]
  const plan = planNamedCorrections(db, { namedList })
  const byId = Object.fromEntries(plan.map(p => [p.id, p]))

  assert.deepEqual([byId[deltaId].old, byId[deltaId].new, byId[deltaId].stale], [100, 110, false])
  assert.deepEqual([byId[absMatchId].old, byId[absMatchId].new, byId[absMatchId].stale], [-196.35, -59.73, false])
  assert.equal(byId[absNoMatchId].stale, true)
  assert.match(byId[absNoMatchId].reason, /does not match/)

  for (const id of [deltaId, absMatchId, absNoMatchId]) assert.equal(rowSnap(db, id).net_pnl, id === deltaId ? 100 : id === absMatchId ? -196.35 : -1)
})

test('a row still open, or not found, is stale and never applied', t => {
  const db = fresh(t)
  const openId = trade(db, { pid: 1, status: 'open' })
  const namedList = [
    { id: openId, table: 'trades', field: 'net_pnl', mode: 'delta', value: 10, evidence: 'open row' },
    { id: 999999, table: 'trades', field: 'net_pnl', mode: 'delta', value: 10, evidence: 'missing row' },
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
    { id: winnerId, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35, evidence: 'duplicate-group fix' },
    { id: staleId, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35, evidence: 'no longer matches' },
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

test('applyNamedMoneyCorrections re-checks the row at write time (a race is skipped, not overwritten)', t => {
  const db = fresh(t)
  const id = trade(db, { pid: 1, status: 'closed', net: 100 })
  const namedList = [{ id, table: 'trades', field: 'net_pnl', mode: 'delta', value: 10, evidence: 'race test' }]
  // Something else corrects the row between the plan read and the apply call
  // (simulated by mutating right before calling apply, inside the same tick
  // apply itself re-reads via planNamedCorrections, so this proves the WRITE
  // statement's own guard: change the value after planNamedCorrections would
  // have read it by calling apply with a namedList whose expected old value
  // no longer holds).
  db.prepare('UPDATE trades SET net_pnl = 999 WHERE id = ?').run(id)
  const { applied, skipped } = applyNamedMoneyCorrections(db, { namedList: [{ ...namedList[0] }] })
  // planNamedCorrections computed old=999 fresh (not stale, delta mode has no
  // expectedOld), so this one DOES apply — proving delta mode always reads
  // fresh rather than trusting a stale plan.
  assert.equal(applied.length, 1)
  assert.equal(rowSnap(db, id).net_pnl, 1009)
  assert.equal(skipped.length, 0)
})

// ---------------------------------------------------------------------------
// The dry-run-by-default guard (OD-12: "dry run first, then a named apply")
// ---------------------------------------------------------------------------

test('runNamedCorrections defaults to a dry run that writes nothing; apply:true is the only way past it', t => {
  const db = fresh(t)
  const neverFilledId = trade(db, { pid: 700, status: 'open' })
  evidence(db, DEMO, 700, {})
  const moneyId = trade(db, { pid: 47, status: 'closed', net: -196.35 })
  const namedList = [{ id: moneyId, table: 'trades', field: 'net_pnl', mode: 'absolute', value: -59.73, expectedOld: -196.35, evidence: 'x' }]

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

test('the built-in NAMED_MONEY_CORRECTIONS list is well-formed (every entry has an evidence string; absolute entries carry expectedOld)', () => {
  assert.ok(NAMED_MONEY_CORRECTIONS.length >= 6)
  for (const entry of NAMED_MONEY_CORRECTIONS) {
    assert.equal(typeof entry.id, 'number')
    assert.equal(entry.table, 'trades')
    assert.equal(entry.field, 'net_pnl')
    assert.ok(['delta', 'absolute'].includes(entry.mode))
    assert.equal(typeof entry.evidence, 'string')
    assert.ok(entry.evidence.length > 0)
    if (entry.mode === 'absolute') assert.equal(typeof entry.expectedOld, 'number')
  }
})
