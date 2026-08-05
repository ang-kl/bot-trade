// The funnel exists to answer one question — "why has this strategy not
// fired?" — and the ways it can answer WRONGLY are all of the form "a number
// that looks like a diagnosis but is really an artefact of how it was
// counted". Each test below is one of those.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from '../db.js'
import { GATE_ORDER } from './cup-handle.js'
import { cupHandleFunnel, funnelLine } from './cup-handle-funnel.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chf-')), 'agent.db'))

const nowMs = Date.parse('2026-08-05T07:00:00.000Z')
const isoAgo = (h) => new Date(nowMs - h * 3600_000).toISOString()
const sqlAgo = (h) => isoAgo(h).replace('T', ' ').slice(0, 19)

function seed(db, rows) {
  const ins = db.prepare(`INSERT INTO cup_handle_diagnostics
    (symbol, timeframe, scanned_at, bias, uptrend_ok, cup_found, blocked_at, candidate_json)
    VALUES (?,?,?,?,?,?,?,?)`)
  db.transaction(() => {
    for (const r of rows) {
      for (let i = 0; i < (r.n || 1); i++) {
        ins.run(r.symbol || `SYM${i % 5}`, '1h', (r.at || isoAgo)(1 + (i % 40)), r.bias || 'long',
          r.uptrend_ok ? 1 : 0, r.cup_found ? 1 : 0, r.blocked_at ?? null,
          r.candidate ? JSON.stringify({ blocked_at: r.blocked_at ?? null }) : null)
      }
    }
  })()
}

test('GATE_ORDER is the search order, and carries no "null" pseudo-gate', () => {
  // The funnel subtracts along this list. If it were unordered — or if `null`
  // ("cleared everything") appeared in it — every "reached" number below the
  // first mis-ordered entry would be wrong while still looking plausible.
  assert.equal(GATE_ORDER[0], 'no_cup_structure')
  assert.equal(GATE_ORDER.at(-1), 'rr_floor')
  assert.ok(!GATE_ORDER.includes('null'))
  assert.ok(GATE_ORDER.indexOf('handle_length_ratio') < GATE_ORDER.indexOf('breakout_not_triggered'))
})

test('the trend context blocking everything is reported as UNTESTED, not permissive', () => {
  // THE MISREADING THIS PREVENTS. Every downstream gate shows zero blocks.
  // Read as a flat list that says "no gate is stopping anything" — the
  // opposite of the truth, which is that nothing ever reached them.
  const db = tmpDb()
  seed(db, [{ n: 200, uptrend_ok: false }])

  const f = cupHandleFunnel(db, { nowMs, now: nowMs })
  assert.equal(f.traces, 200)
  assert.equal(f.stages.find(s => s.key === 'trend_context').reached, 0)
  assert.equal(f.deepestReached, null, 'nothing reached any gate')
  assert.match(f.verdict, /never ran once|never held/)
  assert.match(f.verdict, /Nothing downstream was tested/)
})

test('context holds but no cup is ever found — the gates below are untested', () => {
  const db = tmpDb()
  seed(db, [{ n: 150, uptrend_ok: true, cup_found: false }])
  const f = cupHandleFunnel(db, { now: nowMs })
  assert.equal(f.stages.find(s => s.key === 'trend_context').reached, 150)
  assert.equal(f.stages.find(s => s.key === 'cup_candidate').reached, 0)
  assert.match(f.verdict, /no cup-shaped candidate/)
  assert.match(f.verdict, /untested, not permissive/)
})

test('reached is what SURVIVED the gate above, not what was counted at it', () => {
  const db = tmpDb()
  seed(db, [
    { n: 40, uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'no_cup_structure' },
    { n: 30, uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'handle_range' },
    { n: 10, uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'rr_floor' },
  ])
  const f = cupHandleFunnel(db, { now: nowMs })
  const at = (k) => f.stages.find(s => s.key === k)

  assert.equal(at('cup_candidate').reached, 80)
  assert.equal(at('no_cup_structure').reached, 80)
  assert.equal(at('no_cup_structure').stopped, 40)
  // 40 died at the first gate, so only 40 can reach the next one.
  assert.equal(at('handle_length_ratio').reached, 40)
  assert.equal(at('handle_range').stopped, 30)
  assert.equal(at('rr_floor').reached, 10)
  assert.equal(f.deepestReached, 'rr_floor')
  assert.match(f.verdict, /no_cup_structure|Cup shape valid/)
})

test('NULL blocked_at means two different things, and they are not merged', () => {
  // insertCupHandleDiagnostic writes NULL both for "no candidate at all" and
  // for "candidate cleared every gate". Counting them together would report a
  // strategy as one gate from firing when in fact it found nothing.
  const db = tmpDb()
  seed(db, [
    { n: 90, uptrend_ok: true, cup_found: false },                       // no candidate
    { n: 4, uptrend_ok: true, cup_found: true, candidate: true },        // cleared everything
  ])
  const f = cupHandleFunnel(db, { now: nowMs })
  assert.equal(f.stages.find(s => s.key === 'cup_candidate').reached, 4)
  assert.equal(f.wouldHaveFired, 4)
  assert.equal(f.deepestReached, 'cleared_every_gate')
  // And it calls that out as a WIRING BUG rather than a market condition —
  // a trace that would have fired while the search emitted nothing means the
  // diagnostic twin has drifted from the code it mirrors.
  assert.match(f.verdict, /drifted from the search/)
})

test('space-form timestamps count — a mismatch would report a busy scanner as idle', () => {
  const db = tmpDb()
  seed(db, [{ n: 60, uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'round_bottom', at: sqlAgo }])
  const f = cupHandleFunnel(db, { now: nowMs })
  assert.equal(f.traces, 60, 'space-form scanned_at was dropped')
})

test('the window excludes older traces', () => {
  const db = tmpDb()
  seed(db, [{ n: 50, uptrend_ok: true, at: (h) => new Date(nowMs - (30 * 24 + h) * 3600_000).toISOString() }])
  assert.equal(cupHandleFunnel(db, { days: 7, now: nowMs }).traces, 0)
  assert.ok(cupHandleFunnel(db, { days: 60, now: nowMs }).traces > 0)
})

test('bias splits the two directions — they are separate strategies', () => {
  const db = tmpDb()
  seed(db, [
    { n: 20, bias: 'long', uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'rr_floor' },
    { n: 70, bias: 'short', uptrend_ok: false },
  ])
  assert.equal(cupHandleFunnel(db, { bias: 'long', now: nowMs }).traces, 20)
  assert.equal(cupHandleFunnel(db, { bias: 'short', now: nowMs }).traces, 70)
  assert.equal(cupHandleFunnel(db, { now: nowMs }).traces, 90)
  // An unrecognised bias must not silently filter to nothing.
  assert.equal(cupHandleFunnel(db, { bias: 'sideways', now: nowMs }).traces, 90)
})

test('an empty window is honest rather than a zeroed-out funnel', () => {
  const f = cupHandleFunnel(tmpDb(), { now: nowMs })
  assert.equal(f.traces, 0)
  assert.match(f.verdict, /has not run/)
  assert.equal(funnelLine(f), '', 'nothing to say is said by saying nothing')
})

test('funnelLine names the numbers a reader acts on', () => {
  const db = tmpDb()
  seed(db, [{ n: 25, uptrend_ok: true, cup_found: true, candidate: true, blocked_at: 'handle_volume' }])
  const line = funnelLine(cupHandleFunnel(db, { now: nowMs }))
  assert.match(line, /25 traces/)
  assert.match(line, /would have fired 0/)
  assert.match(line, /deepest handle_volume/)
})
