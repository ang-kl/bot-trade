// Vol-gate PR1 — the volatility context a trade was OPENED in must survive to
// the postmortem, which is what every later bucketed report reads.
//
// WHY THERE IS NO NEW CLOSE HANDLER. The spec asked for an `onTradeClose`
// hook. No such function exists, and adding one would have been a second
// close-time writer — the exact thing the spec's own §5 warns against. What
// already exists is `runLossPostmortems`: it runs on every closed trade, win
// or loss, and already computes the outcome vocabulary. So the "hook" is that
// function carrying eight more columns, and these tests exist to prove it
// carries them rather than silently writing NULL.
//
// The silent-NULL failure is the real hazard here: the postmortem SELECT lists
// columns explicitly rather than `t.*`, so a column omitted from the SELECT
// reads `undefined` in JS and writes NULL forever — and NULL is
// indistinguishable from "the gate never ran". A whole backtest could be read
// off an empty column.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from '../db.js'
import { runLossPostmortems } from './loss-postmortem.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volctx-')), 'agent.db'))

const HOUR = 3600_000
const NOW = Date.parse('2026-07-29T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

// Enough bars for the classifier to reach a verdict rather than "waiting".
const bars = (n = 80, from = NOW - 80 * HOUR) =>
  Array.from({ length: n }, (_, i) => ({
    t: from + i * HOUR, o: 1.1, h: 1.12, l: 1.08, c: 1.1, v: 100,
  }))

function insertClosedTrade(db, vol = {}) {
  const cols = [
    'symbol', 'side', 'status', 'strategy', 'label_strategy', 'label_timeframe',
    'entry_price', 'exit_price', 'sl_price', 'tp_price', 'net_pnl',
    'opened_at', 'closed_at', 'confluence_count', 'account_id',
    ...Object.keys(vol),
  ]
  const vals = [
    'EURUSD', 'buy', 'closed', 'cup_handle', 'cup_handle', '1h',
    1.10, 1.08, 1.09, 1.13, -120,
    iso(NOW - 40 * HOUR), iso(NOW - 30 * HOUR), 3, '43097342',
    ...Object.values(vol),
  ]
  db.prepare(`INSERT INTO trades (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
  return db.prepare('SELECT last_insert_rowid() AS id').get().id
}

const runPm = (db) => runLossPostmortems(db, async () => bars(), { now: NOW, maxPerCycle: 10 })
const pmFor = (db, tradeId) =>
  db.prepare('SELECT * FROM trade_postmortems WHERE trade_id = ?').get(tradeId)

test('the migration is additive — every vol column exists on both tables', () => {
  const db = tmpDb()
  const tradeCols = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name))
  for (const c of [
    'entry_vol_regime', 'entry_vol_percentile', 'entry_vol_insufficient',
    'position_size_ratio_applied', 'stop_loss_expanded_pips',
    'confirmation_candles_required', 'vol_volume_divergence_flag',
    'fvg_origin_vol_regime', 'fvg_fill_target_pct',
    'confluence_tool_count', 'confluence_conflict_flagged', 'vol_gate_mode',
  ]) assert.ok(tradeCols.has(c), `trades.${c} missing`)

  const pmColsSet = new Set(db.prepare('PRAGMA table_info(trade_postmortems)').all().map(c => c.name))
  for (const c of [
    'entry_vol_regime', 'entry_vol_percentile', 'position_size_ratio_applied',
    'stop_loss_expanded_pips', 'vol_volume_divergence_flag',
    'confluence_tool_count', 'confluence_conflict_flagged', 'vol_gate_mode',
  ]) assert.ok(pmColsSet.has(c), `trade_postmortems.${c} missing`)

  // Nothing pre-existing was renamed or dropped.
  for (const c of ['classification', 'result', 'lesson', 'alpha_decay', 'entry_quality', 'account_id']) {
    assert.ok(pmColsSet.has(c), `existing column ${c} was lost`)
  }
})

test('THE POINT: entry vol context reaches the postmortem intact', async () => {
  const db = tmpDb()
  const id = insertClosedTrade(db, {
    entry_vol_regime: 'HIGH',
    entry_vol_percentile: 91.4,
    position_size_ratio_applied: 0.65,
    stop_loss_expanded_pips: 75,
    vol_volume_divergence_flag: 1,
    confluence_tool_count: 2,
    confluence_conflict_flagged: 0,
    vol_gate_mode: 'log_only',
  })
  await runPm(db)

  const pm = pmFor(db, id)
  assert.ok(pm, 'no postmortem was written at all')
  assert.equal(pm.entry_vol_regime, 'HIGH')
  assert.equal(pm.entry_vol_percentile, 91.4)
  assert.equal(pm.position_size_ratio_applied, 0.65)
  assert.equal(pm.stop_loss_expanded_pips, 75)
  assert.equal(pm.vol_volume_divergence_flag, 1)
  assert.equal(pm.confluence_tool_count, 2)
  assert.equal(pm.confluence_conflict_flagged, 0)
  assert.equal(pm.vol_gate_mode, 'log_only')
})

test('a trade the gate never touched carries NULL, not a default that reads as LOW vol', async () => {
  const db = tmpDb()
  const id = insertClosedTrade(db) // no vol fields at all — every trade before the gate ships
  await runPm(db)

  const pm = pmFor(db, id)
  assert.ok(pm)
  // NULL is the honest "not measured". A 0 or a 'NORMAL' default here would
  // quietly enrol every historical trade into a regime bucket it was never
  // measured for, and the first backtest would be reading fiction.
  assert.equal(pm.entry_vol_regime, null)
  assert.equal(pm.entry_vol_percentile, null)
  assert.equal(pm.position_size_ratio_applied, null)
  assert.equal(pm.vol_gate_mode, null)
})

test('the existing lesson fields still populate — the carry did not displace them', async () => {
  const db = tmpDb()
  const id = insertClosedTrade(db, { entry_vol_regime: 'NORMAL' })
  await runPm(db)

  const pm = pmFor(db, id)
  assert.ok(pm.classification, 'classification is the outcome vocabulary the spec wanted a second copy of')
  assert.ok(pm.result, 'result missing')
  assert.ok(pm.lesson, 'lesson missing')
  assert.equal(pm.account_id, '43097342', 'lesson account scoping (plan D5) must survive')
  assert.equal(pm.symbol, 'EURUSD')
  assert.equal(pm.strategy, 'cup_handle')
})

test('a WIN carries the context too — this is not a loss-only path', async () => {
  const db = tmpDb()
  const cols = ['symbol', 'side', 'status', 'strategy', 'label_strategy', 'label_timeframe',
    'entry_price', 'exit_price', 'sl_price', 'tp_price', 'net_pnl', 'opened_at', 'closed_at',
    'account_id', 'entry_vol_regime', 'vol_gate_mode']
  db.prepare(`INSERT INTO trades (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run('XAUUSD', 'buy', 'closed', 'vp_value', 'vp_value', '1h',
      1.10, 1.14, 1.09, 1.15, 240, iso(NOW - 40 * HOUR), iso(NOW - 30 * HOUR),
      '43097342', 'LOW', 'log_only')
  const id = db.prepare("SELECT id FROM trades WHERE symbol = 'XAUUSD'").get().id

  await runPm(db)
  const pm = pmFor(db, id)
  assert.ok(pm, 'wins get postmortems too (classifyWin) — the vol context must ride along')
  assert.equal(pm.entry_vol_regime, 'LOW')
  assert.equal(pm.vol_gate_mode, 'log_only')
})

// This is the test that would catch the specific mistake the SELECT invites.
test('every carried column is actually named in the postmortem SELECT', () => {
  const src = fs.readFileSync(new URL('./loss-postmortem.js', import.meta.url), 'utf8')
  const select = src.slice(src.indexOf('SELECT t.id'), src.indexOf('FROM trades t'))
  for (const c of [
    'entry_vol_regime', 'entry_vol_percentile', 'position_size_ratio_applied',
    'stop_loss_expanded_pips', 'vol_volume_divergence_flag',
    'confluence_tool_count', 'confluence_conflict_flagged', 'vol_gate_mode',
  ]) {
    // Omitting one reads `undefined` in JS and writes NULL forever, which is
    // indistinguishable from "the gate never ran" — a silent, permanent hole
    // in the very data the gate exists to produce.
    assert.ok(select.includes(`t.${c}`), `${c} is written but never SELECTed — it would always be NULL`)
  }
})
