// node --test agent/services/trade-horizon.test.js
//
// §4-D and §5 (owner-approved 03-10-2026, № 10,777·B·4): every position
// carries a HORIZON set at entry from its strategy family and stored on the
// trade row; every exit rule selects its regime from that stored horizon. A
// weeks-horizon row is never capped by takeAtR or the time cap; an intraday
// row keeps today's behaviour exactly.
//
// What is behavioural here is tested behaviourally (the column, the rule,
// the backfill, the two exported entry writers, the managed ruleset, the time
// cap end to end). The three entry writers that need a broker or a live loop
// (loop.js's dispatch, the reconciler's adoption, the pending fill) are
// pinned on comment-stripped source, as the sibling tests pin their wiring.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import {
  HORIZONS, WEEKS_HORIZON_FAMILIES, horizonForStrategy, normaliseHorizon, storedHorizon,
  horizonOfPosition, backfillTradeHorizons,
} from './trade-horizon.js'
import { applyManagedRules, takeAtRFor, loadManagedExit } from './managed-exit.js'
import { evaluatePosition, DEFAULT_RULES } from './position-manager.js'
import { recordManualOrderTrade, writeAheadAnalysisTrade } from '../routes/actions.js'

const DEMO = '43097342'
function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '5203012', 0, 1, 'active')`).run(DEMO)
  return db
}
const stripComments = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const read = (rel) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))

const insertTrade = (db, { strategy = null, labelStrategy = null, status = 'open', horizon = null } = {}) =>
  Number(db.prepare(
    `INSERT INTO trades (symbol, side, status, account_id, strategy, label_strategy, horizon) VALUES ('EURUSD', 'BUY', ?, ?, ?, ?, ?)`,
  ).run(status, DEMO, strategy, labelStrategy, horizon).lastInsertRowid)
const horizonOf = (db, id) => db.prepare('SELECT horizon FROM trades WHERE id = ?').get(id).horizon

// ───────────────────────────────────────────────────────────────────────────
// §4-D — the rule and the column
// ───────────────────────────────────────────────────────────────────────────

test('§4-D rule: the momentum family is weeks; every other family, and no strategy, is intraday', () => {
  assert.deepEqual(HORIZONS, ['intraday', 'weeks'])
  assert.deepEqual([...WEEKS_HORIZON_FAMILIES], ['momentum'])
  for (const s of STRATEGY_REGISTRY) {
    assert.equal(horizonForStrategy(s.key), s.family === 'momentum' ? 'weeks' : 'intraday', `${s.key} (${s.family})`)
  }
  assert.equal(horizonForStrategy('tsmom_long'), 'weeks')
  assert.equal(horizonForStrategy('rsi2_reversion'), 'intraday')
  assert.equal(horizonForStrategy(null), 'intraday', 'no strategy on record: the intraday regime it lives under today')
  assert.equal(horizonForStrategy('manual'), 'intraday')
  assert.equal(horizonForStrategy('no_such_strategy'), 'intraday')
})

test('§4-D column: trades.horizon exists after initDB and admits only the two horizons', () => {
  const db = initDB(':memory:')
  const cols = db.prepare('PRAGMA table_info(trades)').all().map(c => c.name)
  assert.ok(cols.includes('horizon'), 'trades.horizon is missing')
  insertTrade(db, { horizon: 'weeks' })
  insertTrade(db, { horizon: 'intraday' })
  insertTrade(db, { horizon: null })
  assert.throws(() => insertTrade(db, { horizon: 'months' }), /CHECK/, 'a third horizon is refused by the column itself')
  assert.equal(normaliseHorizon('weeks'), 'weeks')
  assert.equal(normaliseHorizon('junk'), null)
  assert.equal(normaliseHorizon(undefined), null)
})

test('§4-D backfill: open rows get a horizon once from the same rule; closed rows and set rows are untouched', () => {
  const db = initDB(':memory:')
  const tsmomOpen = insertTrade(db, { strategy: 'tsmom_long' })
  const rsi2Open = insertTrade(db, { strategy: 'rsi2_reversion' })
  const adoptedByLabel = insertTrade(db, { strategy: null, labelStrategy: 'tsmom_long' })
  const noStrategy = insertTrade(db)
  const submitting = insertTrade(db, { strategy: 'ema_pullback', status: 'submitting' })
  const closed = insertTrade(db, { strategy: 'tsmom_long', status: 'closed' })
  const alreadySet = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'weeks' })

  const first = backfillTradeHorizons(db)
  assert.deepEqual(first, { weeks: 2, intraday: 3, total: 5 })
  assert.equal(horizonOf(db, tsmomOpen), 'weeks')
  assert.equal(horizonOf(db, rsi2Open), 'intraday')
  assert.equal(horizonOf(db, adoptedByLabel), 'weeks', 'an adopted row with no strategy of its own reads its label')
  assert.equal(horizonOf(db, noStrategy), 'intraday')
  assert.equal(horizonOf(db, submitting), 'intraday', 'an in-flight row is covered too')
  assert.equal(horizonOf(db, closed), null, 'closed rows are not given a horizon after the fact')
  assert.equal(horizonOf(db, alreadySet), 'weeks', 'a stored horizon is never rewritten by the backfill')

  assert.deepEqual(backfillTradeHorizons(db), { weeks: 0, intraday: 0, total: 0 }, 'idempotent: the second run touches nothing')
})

test('§4-D boot pin: index.js runs the backfill at boot (comment-stripped)', () => {
  assert.match(read('../index.js'), /backfillTradeHorizons\(db\)/, 'index.js must call backfillTradeHorizons(db) at boot')
})

// ───────────────────────────────────────────────────────────────────────────
// §4-D — every entry writer stamps the horizon at entry
// ───────────────────────────────────────────────────────────────────────────

test('§4-D entry: the manual-order writer and the execute-trade write-ahead row carry the horizon from the strategy', () => {
  const db = withAccounts(initDB(':memory:'))
  const manual = recordManualOrderTrade(db, {
    symbol: 'EURUSD', side: 'BUY', entryP: 1.1, sl: 1.09, tp: 1.12, volLots: 0.1, positionId: '9001',
    structuredLabel: null, accountId: DEMO, strategy: 'va_breakout',
  })
  assert.equal(horizonOf(db, manual), 'intraday')
  const manualDefault = recordManualOrderTrade(db, {
    symbol: 'EURUSD', side: 'BUY', entryP: 1.1, sl: 1.09, tp: null, volLots: 0.1, structuredLabel: null, accountId: DEMO,
  })
  assert.equal(horizonOf(db, manualDefault), 'intraday', "the default 'manual' strategy is intraday")
  const manualWeeks = recordManualOrderTrade(db, {
    symbol: 'GD.US', side: 'BUY', entryP: 363, sl: 345, tp: null, volLots: 0.1, structuredLabel: null, accountId: DEMO, strategy: 'tsmom_long',
  })
  assert.equal(horizonOf(db, manualWeeks), 'weeks', 'a manual order attributed to the momentum family is a weeks position')
  const weeks = writeAheadAnalysisTrade(db, { symbol: 'GD.US', side: 'BUY', entry: 363, sl: 345, accountId: DEMO, strategy: 'tsmom_long' })
  assert.equal(horizonOf(db, weeks), 'weeks')
  const intraday = writeAheadAnalysisTrade(db, { symbol: 'GD.US', side: 'BUY', entry: 363, sl: 345, accountId: DEMO, strategy: 'rsi2_reversion' })
  assert.equal(horizonOf(db, intraday), 'intraday')
  const none = writeAheadAnalysisTrade(db, { symbol: 'GD.US', side: 'BUY', entry: 363, sl: 345, accountId: DEMO })
  assert.equal(horizonOf(db, none), 'intraday')
})

test('§4-D entry pins: the dispatch, the adoption and the pending fill each write `horizon` from horizonForStrategy (comment-stripped)', () => {
  for (const [rel, label] of [
    ['../loop.js', 'loop.js autoTrade write-ahead row'],
    ['./reconciler.js', 'reconciler adoption'],
    ['./pending-orders.js', 'pending-order fill'],
  ]) {
    const src = read(rel)
    assert.match(src, /import \{ horizonForStrategy \} from '[./]+(services\/)?trade-horizon\.js'/, `${label}: imports horizonForStrategy`)
    const inserts = [...src.matchAll(/INSERT INTO trades \(([^)]*)\)/g)].map(m => m[1].replace(/\s+/g, ' '))
    assert.ok(inserts.length >= 1, `${label}: has a trades insert`)
    for (const cols of inserts) assert.match(cols, /\bhorizon\b/, `${label}: the trades insert column list names horizon — got (${cols})`)
    assert.match(src, /horizonForStrategy\(/, `${label}: the insert's value comes from horizonForStrategy`)
  }
})

test('§4-D view: /positions exposes the stored horizon from the trade row (comment-stripped)', () => {
  assert.match(read('../routes/state.js'), /t\.horizon AS horizon/, 'the positions SELECT must join trades.horizon')
})

// ───────────────────────────────────────────────────────────────────────────
// §5 — the stored horizon selects the exit regime
// ───────────────────────────────────────────────────────────────────────────

test('§5 resolution: explicit valid horizon, else the stored row, else the strategy rule', () => {
  const db = initDB(':memory:')
  const weeksRow = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'weeks' })
  const nullRow = insertTrade(db, { strategy: 'tsmom_long' })
  assert.equal(storedHorizon(db, weeksRow), 'weeks')
  assert.equal(storedHorizon(db, nullRow), null)
  assert.equal(storedHorizon(db, 999_999), null, 'no such row reads as not recorded')
  assert.equal(storedHorizon(db, null), null)
  assert.equal(horizonOfPosition(db, { tradeId: weeksRow, strategy: 'rsi2_reversion' }), 'weeks', 'the STORED horizon wins over the strategy')
  assert.equal(horizonOfPosition(db, { tradeId: nullRow, strategy: 'tsmom_long' }), 'weeks', 'no stored value: the strategy rule')
  assert.equal(horizonOfPosition(db, { tradeId: nullRow, strategy: 'rsi2_reversion' }), 'intraday')
  assert.equal(horizonOfPosition(db, { tradeId: weeksRow, strategy: 'rsi2_reversion', horizon: 'intraday' }), 'intraday', 'an explicit valid value is honoured first')
  assert.equal(horizonOfPosition(db, { tradeId: weeksRow, strategy: 'rsi2_reversion', horizon: 'junk' }), 'weeks', 'junk is not a horizon')
  assert.equal(horizonOfPosition(db, {}), 'intraday')
})

test('§5 takeAtRFor: a weeks horizon is never taken, whatever the family list says; no horizon keeps the family rule', () => {
  const db = initDB(':memory:')
  const p = loadManagedExit(db)
  assert.equal(takeAtRFor(p, 'rsi2_reversion'), 1.0, 'unchanged: the family rule with no horizon')
  assert.equal(takeAtRFor(p, 'rsi2_reversion', 'intraday'), 1.0)
  assert.equal(takeAtRFor(p, 'rsi2_reversion', 'weeks'), 0, 'a weeks row is never capped at the take')
  setState(db, 'managed_exit_json', JSON.stringify({ takeAtRFamilies: ['momentum'] }))
  const widened = loadManagedExit(db)
  assert.equal(takeAtRFor(widened, 'tsmom_long'), 1.0, 'the family list alone WOULD reach momentum')
  assert.equal(takeAtRFor(widened, 'tsmom_long', 'weeks'), 0, 'the stored horizon fences it regardless')
})

test('§5 managed ruleset: a stored WEEKS row gets no take and no time cap; a stored INTRADAY row is byte-for-byte today\'s ruleset', () => {
  const db = withAccounts(initDB(':memory:'))
  const base = { ...DEFAULT_RULES }
  const weeksRow = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'weeks' })
  const intradayRow = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'intraday' })
  const unsetRow = insertTrade(db, { strategy: 'rsi2_reversion' })

  const today = applyManagedRules(db, DEMO, base, { strategy: 'rsi2_reversion' })
  assert.equal(today.bankTriggerR, 1.0, 'control: the reversion take rides with no horizon')
  assert.equal('timeCapApplies' in today, false, 'control: no fence key on today\'s ruleset')

  const intraday = applyManagedRules(db, DEMO, base, { strategy: 'rsi2_reversion', tradeId: intradayRow })
  assert.deepEqual(intraday, today, 'an intraday row keeps today\'s behaviour EXACTLY')
  const unset = applyManagedRules(db, DEMO, base, { strategy: 'rsi2_reversion', tradeId: unsetRow })
  assert.deepEqual(unset, today, 'a row with no stored horizon falls back to the family rule — today\'s behaviour')

  const weeks = applyManagedRules(db, DEMO, base, { strategy: 'rsi2_reversion', tradeId: weeksRow })
  assert.equal(weeks.bankTriggerR, 0, 'a weeks row is never capped by takeAtR, even on a family the list names')
  assert.equal(weeks.bankFraction, 1, 'and nothing is banked')
  assert.equal(weeks.timeCapApplies, false, 'and the time cap is fenced off')
  assert.equal(weeks.alwaysTrailR, today.alwaysTrailR, 'the managed trail itself is unchanged')

  // No trade row at all, but the strategy is momentum: the family rule fences it too (the pre-column regime).
  const tsmom = applyManagedRules(db, DEMO, base, { strategy: 'tsmom_long' })
  assert.equal(tsmom.bankTriggerR, 0)
  assert.equal(tsmom.timeCapApplies, false)

  // The fence rides OUTSIDE the governed check, as the time-cap fields do: an
  // ungoverned account's weeks row is still never cut at the clock.
  const ungoverned = applyManagedRules(db, '99999999', base, { strategy: 'rsi2_reversion', tradeId: weeksRow })
  assert.equal(ungoverned.timeCapApplies, false, 'ungoverned account, weeks row: the cap is still fenced')
  assert.deepEqual(applyManagedRules(db, '99999999', base, { strategy: 'rsi2_reversion', tradeId: intradayRow }), base, 'ungoverned account, intraday row: passed through untouched')
})

test('§5 end to end: at an expired time cap a WEEKS row is not cut; the same INTRADAY row closes with today\'s reason', () => {
  const db = withAccounts(initDB(':memory:'))
  const weeksRow = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'weeks' })
  const intradayRow = insertTrade(db, { strategy: 'rsi2_reversion', horizon: 'intraday' })
  const capAt = new Date(Date.now() - 60_000).toISOString()
  const pos = (trade_id) => ({
    id: 1, trade_id, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99,
    current_tp: null, initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0,
    scaled_out: 0, invalidation_trigger: null, time_cap_at: capAt,
    created_at: new Date().toISOString(),
  })
  const intraday = evaluatePosition(pos(intradayRow), {
    currentPrice: 99.5, rules: applyManagedRules(db, DEMO, { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion', tradeId: intradayRow }),
  })
  assert.equal(intraday.action, 'FULL_EXIT')
  assert.match(intraday.reason, /^time_cap_expired \(/, 'intraday: the loser at the clock closes, exactly as before')

  const weeks = evaluatePosition(pos(weeksRow), {
    currentPrice: 99.5, rules: applyManagedRules(db, DEMO, { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion', tradeId: weeksRow }),
  })
  assert.notEqual(weeks.action, 'FULL_EXIT', 'weeks: the clock does not cut the position')
  assert.doesNotMatch(String(weeks.reason || ''), /time_cap/, 'weeks: no time-cap reason of any kind')

  // And the take: a weeks row at +1R is trailed, not banked.
  const atTake = evaluatePosition({ ...pos(weeksRow), time_cap_at: null }, {
    currentPrice: 101, rules: applyManagedRules(db, DEMO, { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion', tradeId: weeksRow }),
  })
  assert.notEqual(atTake.action, 'PARTIAL_EXIT', 'weeks at +1R: never the take')
  assert.doesNotMatch(String(atTake.reason || ''), /bank_partial/)
  const intradayAtTake = evaluatePosition({ ...pos(intradayRow), time_cap_at: null }, {
    currentPrice: 101, rules: applyManagedRules(db, DEMO, { ...DEFAULT_RULES }, { strategy: 'rsi2_reversion', tradeId: intradayRow }),
  })
  assert.equal(intradayAtTake.action, 'PARTIAL_EXIT', 'intraday at +1R: PR-J banks half, as today')
})

test('§5 position-manager: the cap fires unless timeCapApplies is exactly false — a missing key is today\'s behaviour', () => {
  const capAt = new Date(Date.now() - 60_000).toISOString()
  const pos = {
    id: 1, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99,
    current_tp: null, initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0,
    scaled_out: 0, invalidation_trigger: null, time_cap_at: capAt,
    created_at: new Date().toISOString(),
  }
  assert.equal(evaluatePosition(pos, { currentPrice: 99.5, rules: { ...DEFAULT_RULES } }).action, 'FULL_EXIT')
  assert.equal(evaluatePosition(pos, { currentPrice: 99.5, rules: { ...DEFAULT_RULES, timeCapApplies: true } }).action, 'FULL_EXIT')
  assert.equal(evaluatePosition(pos, { currentPrice: 99.5, rules: { ...DEFAULT_RULES, timeCapApplies: 0 } }).action, 'FULL_EXIT', 'only the literal false fences')
  assert.notEqual(evaluatePosition(pos, { currentPrice: 99.5, rules: { ...DEFAULT_RULES, timeCapApplies: false } }).action, 'FULL_EXIT')
})
