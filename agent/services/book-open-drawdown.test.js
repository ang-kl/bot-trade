// node --test agent/services/book-open-drawdown.test.js
//
// PR-P (16-09-2026): the momentum book's PER-ACCOUNT entry brake, measured on
// OPEN mark-to-market. Pinned here:
//   · the arithmetic — pnlR per row, the sum as a percentage of the risk the
//     rows put up, and the fact that it is a FRACTION so it fires at two rows
//     as readily as at eight (an absolute R threshold cannot fire at two);
//   · which denominator is used, in which order, that the TRAILED stop is
//     never one of them, and that the drifting ATR fallback is GONE;
//   · COVERAGE (checker MAJOR 1): a reading built on a minority of the
//     account's open rows BLOCKS rather than passes, because the unreadable
//     rows may be the bleeding ones;
//   · LOUDNESS (checker MAJOR 2): anything unread produces a `notice`
//     whether or not the brake blocks;
//   · staleness measured on the PRICE, not on the fetch (checker MINOR 3);
//   · that one account's drawdown never brakes another's;
//   · the validation, including that a cleared field cannot switch the brake
//     off and that an out-of-range number falls back to the default rather
//     than to an extreme.
// The wiring — that both entry paths actually consult it, and that exits do
// not — is pinned in momentum-book.test.js against the running cycle.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  bookOpenDrawdown, bookEntryBrake, bookDrawdownConfig, initialRiskOf, markKey, markAgeMs,
  DEFAULT_BOOK_DRAWDOWN, MIN_PLAUSIBLE_EPOCH_MS,
} from './book-open-drawdown.js'
import { momentumBookConfig } from './momentum-book.js'

const A = '111', B = '222'
const CFG = momentumBookConfig({ enabled: true })
const NOW = Date.UTC(2026, 8, 16, 12, 0)

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${A}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${B}','2',0,1,'active')`).run()
  return db
}

/** One open book row with an optional trade + plan, so the denominators can be steered per test. */
function row(db, { account = A, symbol, side = 'long', entry, stop = null, atr = null, planRisk = null, initialRisk = null }) {
  let tradeId = null
  if (planRisk != null || initialRisk != null) {
    tradeId = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, account_id, origin, opened_at) VALUES (?,?,'open',?,?, 'tsmom_long', ?, 'bot_market_dispatch', datetime('now'))`)
      .run(symbol, side === 'short' ? 'SELL' : 'BUY', entry, stop, account).lastInsertRowid
    if (planRisk != null) db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, risk_dist) VALUES (?,?,?,?,?)`).run(tradeId, account, symbol, side, planRisk)
    if (initialRisk != null) db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, initial_risk, account_id, status, source) VALUES (?,?,?,?,?,?,'active','autopilot')`).run(symbol, tradeId, side, entry, initialRisk, account)
  }
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, side, entry_price, stop, atr, entered_at, status) VALUES (?,?,?,?,?,?,?, datetime('now'), 'open')`)
    .run(tradeId, account, symbol, side, entry, stop, atr)
  return tradeId
}
const marks = (obj, at = NOW) => Object.fromEntries(Object.entries(obj).map(([k, c]) => [k, { c, at }]))

test('the denominator is the risk PUT UP, in order, and the drifting ATR fallback is gone', () => {
  // A ratcheted long: entry 100, trailed stop 108. |entry − stop| would be 8
  // and on the WRONG side of entry — the row that is winning hardest would
  // report the largest "risk". Both sources below are stamps from entry.
  assert.equal(initialRiskOf({ plan_risk: 6, mp_risk: 4 }), 6, 'trade_plans.risk_dist first')
  assert.equal(initialRiskOf({ plan_risk: null, mp_risk: 4 }), 4, 'then monitored_positions.initial_risk')
  assert.equal(initialRiskOf({ plan_risk: -5, mp_risk: 0 }), null, 'a non-positive number is not a risk')
  // CHECKER MINOR 4: `stopAtr × momentum_book.atr` used to be the third
  // fallback, and momentum-book.js overwrites that `atr` with the CURRENT one
  // on every improving trail — so the denominator grew with volatility and
  // the brake stopped firing during a vol expansion. A row with an ATR and no
  // entry stamp is now UNREAD, not measured on a moving denominator.
  assert.equal(initialRiskOf({ plan_risk: null, mp_risk: null, atr: 10 }), null, 'the ATR fallback is gone')
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, atr: 10 })          // trade_id NULL → no entry stamp
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({ [markKey(A, 'AAA')]: 85, [markKey(A, 'BBB')]: 85 }) })
  assert.equal(r.unpriced, 1)
  assert.equal(r.measured, 1, 'the ATR-only row is not measured at all')
})

test('the reading: pnlR per row, summed, as a percentage of the risk put up — long and short', () => {
  const db = fresh()
  // Two longs, each with a 10-point initial risk. One is 5 under (−0.5 R),
  // one is 5 over (+0.5 R): the basket is flat.
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  let r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({ [markKey(A, 'AAA')]: 95, [markKey(A, 'BBB')]: 105 }) })
  assert.deepEqual([r.rows, r.measured, r.openR, r.drawdownPct, r.coveragePct], [2, 2, 0, 0, 100])
  // Both 5 under: −1 R over 2 R put up = 50 % drawdown.
  r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({ [markKey(A, 'AAA')]: 95, [markKey(A, 'BBB')]: 95 }) })
  assert.deepEqual([r.openR, r.drawdownPct], [-1, 50])
  // A basket in PROFIT reads NEGATIVE — one-sided by construction, so no
  // threshold ≥ 1 can ever be met by a winning book.
  r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({ [markKey(A, 'AAA')]: 110, [markKey(A, 'BBB')]: 110 }) })
  assert.deepEqual([r.openR, r.drawdownPct], [2, -100])
  // A SHORT under water is a mark ABOVE entry.
  const db2 = fresh()
  row(db2, { symbol: 'CCC', side: 'short', entry: 100, planRisk: 10 })
  row(db2, { symbol: 'DDD', side: 'short', entry: 100, planRisk: 10 })
  r = bookOpenDrawdown(db2, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({ [markKey(A, 'CCC')]: 106, [markKey(A, 'DDD')]: 104 }) })
  assert.deepEqual([r.openR, r.drawdownPct], [-1, 50], 'a short loses when price rises')
})

test('IT FIRES AT TWO ROWS — the reason the threshold is a fraction and not an absolute R count', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const at50 = marks({ [markKey(A, 'AAA')]: 95, [markKey(A, 'BBB')]: 95 })
  // The absolute measure this replaces: the whole basket is −1 R. Any
  // "down 4 R" style threshold is UNREACHABLE here — both stops close at
  // −1 R each, so −4 R can never exist on a two-row book. The fraction fires.
  assert.equal(bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: at50 }).openR, -1)
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: at50 })
  assert.equal(b.block, true)
  assert.match(b.reason, /open book drawdown 50% of the risk put up \(>= 50%\) across 2 of 2 carried row\(s\), coverage 100%/)
  assert.match(b.reason, /no NEW momentum-book entries on this account/)
  assert.match(b.reason, /Exits, stops, the exit_pending retry and the owed-exit sweep are untouched\./)
  assert.equal(b.notice, null, 'nothing unread → nothing to warn about')
  // Just under the line does NOT fire: 49 % is not 50 %.
  const under = marks({ [markKey(A, 'AAA')]: 95.1, [markKey(A, 'BBB')]: 95.1 })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: under }).block, false)
})

// ---------------------------------------------------------------------------
// CHECKER MAJOR 1. Excluding a row it cannot read can make the reading LESS
// protective, not more: if the bleeding rows are the unreadable ones, the
// healthy remainder becomes the whole reading.
// ---------------------------------------------------------------------------
test('MAJOR 1: four bleeding rows that cannot be read must NOT let two healthy ones speak for the account', () => {
  const db = fresh()
  for (const s of ['B1', 'B2', 'B3', 'B4']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  for (const s of ['H1', 'H2']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  // The bleeding four are at their stops but unmarked; the healthy two are
  // marked at +0.1 R.
  const partial = marks({ [markKey(A, 'H1')]: 101, [markKey(A, 'H2')]: 101 })
  const r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: partial })
  assert.deepEqual([r.rows, r.measured, r.unmarked, r.drawdownPct], [6, 2, 4, -10],
    'the naive reading really is −10% — the healthy remainder')
  assert.equal(r.coveragePct, 33.3)
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: partial })
  assert.equal(b.block, true, 'blocked for BLINDNESS, not passed on a minority reading')
  // ONE LINE PER ACCOUNT: a blocking verdict carries the unread phrase in its
  // own reason, so there must be no second line saying the same thing — with
  // seven armed accounts that filled loop.js's four-line window twice over
  // and pushed every other reason out (checker MINOR 1, second round).
  assert.equal(b.notice, null)
  assert.match(b.reason, /carried row\(s\) unread/, 'the reason is the one line, and it is complete')
  assert.match(b.reason, /open book UNREADABLE/)
  assert.match(b.reason, /4 of 6 carried row\(s\) unread, coverage 33\.3%/)
  assert.match(b.reason, /4× never marked \(the trail pass has not priced it yet\)/, 'the CAUSE, not just the count')
  assert.match(b.reason, /< the 60% needed to judge/)
  assert.equal(b.notice, null, 'one line per account: the reason already carries the phrase')
  // Marked in full, the SAME book reads 63.3% and blocks on drawdown instead.
  const full = marks({
    [markKey(A, 'B1')]: 90, [markKey(A, 'B2')]: 90, [markKey(A, 'B3')]: 90, [markKey(A, 'B4')]: 90,
    [markKey(A, 'H1')]: 101, [markKey(A, 'H2')]: 101,
  })
  const rf = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: full })
  assert.equal(rf.drawdownPct, 63.3)
  const bf = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: full })
  assert.equal(bf.block, true)
  assert.match(bf.reason, /open book drawdown 63\.3%/)
  // The same hole via `unpriced` rather than `unmarked`: rows with no entry
  // risk stamp are unreadable in exactly the same way.
  const db2 = fresh()
  for (const s of ['B1', 'B2', 'B3', 'B4']) row(db2, { symbol: s, entry: 100 })   // no plan, no monitored row
  for (const s of ['H1', 'H2']) row(db2, { symbol: s, entry: 100, planRisk: 10 })
  const b2 = bookEntryBrake(db2, { accountId: A, bookCfg: CFG, now: NOW, marks: marks({
    [markKey(A, 'B1')]: 90, [markKey(A, 'B2')]: 90, [markKey(A, 'B3')]: 90, [markKey(A, 'B4')]: 90,
    [markKey(A, 'H1')]: 101, [markKey(A, 'H2')]: 101,
  }) })
  assert.equal(b2.block, true)
  assert.match(b2.reason, /4× no entry risk stamp \(trade_id NULL — this row can never be priced\)/,
    'a row that can NEVER be priced says so — the remedy is nothing like a feed outage')
})

test('MAJOR 1: coverage at or above the floor still judges on what it can see, and still says what it could not', () => {
  const db = fresh()
  // 5 of 8 readable = 62.5% ≥ 60%. The five read −0.6 R each.
  for (const s of ['R1', 'R2', 'R3', 'R4', 'R5']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  for (const s of ['U1', 'U2', 'U3']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  const m = marks(Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5'].map(s => [markKey(A, s), 94])))
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.equal(b.read.coveragePct, 62.5)
  assert.equal(b.block, true, '60% drawdown on the readable five')
  assert.match(b.reason, /across 5 of 8 carried row\(s\), coverage 62\.5%/)
  assert.match(b.reason, /3 of 8 carried row\(s\) unread, coverage 62\.5%/, 'the block reason carries the unread phrase itself')
  assert.equal(b.notice, null)
  // And when it is NOT blocking, the notice is still there — this is the case
  // the first draft was silent about.
  const ok = marks(Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5'].map(s => [markKey(A, s), 101])))
  const b2 = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: ok })
  assert.equal(b2.block, false)
  assert.equal(b2.reason, null)
  assert.match(b2.notice, /3 of 8 carried row\(s\) unread/, 'loud even when it lets the entry through')
})

test('MAJOR 1: an account too small to judge is neither blocked nor silent', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  // One row, unreadable. Blocking for blindness on a single row would be a
  // stricter stance than the drawdown half takes at one row (minRows 2), so
  // it is not blocked — but it is still named.
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.equal(b.block, false)
  assert.match(b.notice, /1 of 1 carried row\(s\) unread, coverage 0%.*too few carried rows to judge/)
  // One row at its stop, readable: 100% drawdown but still under minRows.
  const m = marks({ [markKey(A, 'AAA')]: 90 })
  assert.equal(bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m }).drawdownPct, 100)
  const b2 = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.equal(b2.block, false, 'default minRows 2: one row is not a basket')
  // …and it SAYS the verdict was suppressed by the knob rather than by the
  // book being healthy — the same rule as the minRows off-switch case, which
  // is the DEFAULT knob doing it here, not a silly value.
  assert.match(b2.notice, /open drawdown 100% would have refused new entries, but bookDrawdownMinRows 2 > 1 carried row\(s\)/)
  const one = momentumBookConfig({ enabled: true, bookDrawdownMinRows: 1 })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: one, now: NOW, marks: m }).block, true)
  // No open rows at all: nothing to be blind about, nothing to say.
  const empty = fresh()
  const b3 = bookEntryBrake(empty, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.deepEqual([b3.block, b3.reason, b3.notice], [false, null, null])
})

// ---------------------------------------------------------------------------
// CHECKER MAJOR 2 + MINOR 3. Staleness must be loud, and must be measured on
// the PRICE rather than on the moment of the fetch.
// ---------------------------------------------------------------------------
test('MAJOR 2: marks that age past the TTL BLOCK and are named — the brake does not retire itself quietly', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const fresh1 = marks({ [markKey(A, 'AAA')]: 90, [markKey(A, 'BBB')]: 90 })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: fresh1 }).block, true)
  // 192 h later, with the same marks carried forward because every fetch failed.
  const later = NOW + 192 * 3_600_000
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: later, marks: fresh1 })
  assert.equal(b.read.staleMarks, 2)
  assert.equal(b.read.measured, 0)
  assert.equal(b.block, true, 'still blocking — it does not fall open when it goes blind')
  assert.match(b.reason, /open book UNREADABLE/)
  assert.match(b.reason, /2 of 2 carried row\(s\) unread/)
  assert.match(b.reason, /oldest stale price 192 h/)
  assert.match(b.reason, /2× stale \(the price is older than bookMarkMaxAgeHours\)/)
})

test('MINOR 3: staleness is the PRICE\'s age, so a feed frozen on one bar goes stale even though every fetch succeeds', () => {
  const frozenBar = Date.UTC(2026, 7, 1)          // a bar from six weeks before NOW
  assert.equal(markAgeMs({ bt: frozenBar, at: NOW }, NOW).basis, 'bar')
  assert.ok(markAgeMs({ bt: frozenBar, at: NOW }, NOW).ms > 40 * 86_400_000, 'aged from the bar, not from the fetch')
  // A bar stamp that is not a plausible epoch (the tests' index, a zeroed
  // field) falls back to the fetch clock rather than reading as 1970.
  assert.equal(markAgeMs({ bt: 29, at: NOW }, NOW).basis, 'fetch')
  assert.equal(markAgeMs({ bt: MIN_PLAUSIBLE_EPOCH_MS - 1, at: NOW }, NOW).basis, 'fetch')
  assert.equal(markAgeMs({ c: 1 }, NOW).basis, 'none', 'no stamp at all is never silently fresh')
  assert.equal(markAgeMs({ c: 1, at: 'soon' }, NOW).ms, Infinity)
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  // Every fetch succeeded a second ago — `at` is now — but the BAR is old.
  const stale = {
    [markKey(A, 'AAA')]: { c: 95, at: NOW, bt: frozenBar },
    [markKey(A, 'BBB')]: { c: 95, at: NOW, bt: frozenBar },
  }
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: stale })
  assert.equal(b.read.staleMarks, 2, 'the fetch clock would have called these fresh')
  assert.equal(b.block, true)
  assert.match(b.reason, /open book UNREADABLE/)
  // A bar inside the TTL is read, and the basis is reported.
  const good = {
    [markKey(A, 'AAA')]: { c: 95, at: NOW, bt: NOW - 2 * 3_600_000 },
    [markKey(A, 'BBB')]: { c: 95, at: NOW, bt: NOW - 2 * 3_600_000 },
  }
  const b2 = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: good })
  assert.equal(b2.read.ageBasis, 'bar')
  assert.equal(b2.block, true, '50% drawdown, read from the bar stamps')
})

test('PER ACCOUNT: one account bleeding never brakes another', () => {
  const db = fresh()
  row(db, { account: A, symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { account: A, symbol: 'BBB', entry: 100, planRisk: 10 })
  row(db, { account: B, symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { account: B, symbol: 'BBB', entry: 100, planRisk: 10 })
  const m = marks({
    [markKey(A, 'AAA')]: 90, [markKey(A, 'BBB')]: 90,     // A is at its stops
    [markKey(B, 'AAA')]: 105, [markKey(B, 'BBB')]: 105,   // B is winning
  })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m }).block, true)
  assert.equal(bookEntryBrake(db, { accountId: B, bookCfg: CFG, now: NOW, marks: m }).block, false)
  // And the marks are keyed per account: B's row for the same SYMBOL is read
  // from B's key, not A's.
  assert.equal(bookOpenDrawdown(db, { accountId: B, bookCfg: CFG, now: NOW, marks: m }).drawdownPct, -50)
  // The key's halves are encoded, so a separator inside an id or a symbol
  // cannot forge another account's key (checker NIT 8).
  assert.notEqual(markKey('1', '1|AAA'), markKey('1|1', 'AAA'))
  assert.equal(markKey('111', 'BTCUSD'), '111|BTCUSD', 'ordinary ids and symbols are unchanged')
})

test('the switch is explicit, and an out-of-range knob falls back to the DEFAULT rather than to an extreme', () => {
  assert.equal(DEFAULT_BOOK_DRAWDOWN.bookDrawdownOn, true, 'ON by default — this is a risk control on a strategy armed on every account')
  assert.deepEqual(bookDrawdownConfig(null), { ...DEFAULT_BOOK_DRAWDOWN })
  // `false` is the ONLY way off. null / '' / 0 / 'no' are what a cleared UI
  // field and a sloppy client send, and none of them may disarm the brake.
  for (const v of [null, '', 0, 'no', undefined, []]) {
    assert.equal(bookDrawdownConfig({ bookDrawdownOn: v }).bookDrawdownOn, true, `bookDrawdownOn: ${JSON.stringify(v)} must not turn it off`)
  }
  assert.equal(bookDrawdownConfig({ bookDrawdownOn: false }).bookDrawdownOn, false)
  // OUT OF RANGE IN EITHER DIRECTION → THE DEFAULT (checker NITs 7 and 9).
  // Clamping sent a typo to an extreme: -500 became the floor 1, freezing
  // entries on every account from one un-confirmed field, and 5000 became the
  // ceiling 500, which is as good as off.
  for (const v of [-500, 0, 5000, Infinity, -Infinity, NaN, null, '', 'wide', []]) {
    assert.equal(bookDrawdownConfig({ bookDrawdownPct: v }).bookDrawdownPct, 50, `bookDrawdownPct: ${JSON.stringify(v)} → default`)
  }
  // In range is honoured, including as a numeric string.
  assert.equal(bookDrawdownConfig({ bookDrawdownPct: 30 }).bookDrawdownPct, 30)
  assert.equal(bookDrawdownConfig({ bookDrawdownPct: '300' }).bookDrawdownPct, 300)
  assert.equal(bookDrawdownConfig({ bookDrawdownMinRows: 0 }).bookDrawdownMinRows, 2)
  assert.equal(bookDrawdownConfig({ bookDrawdownMinRows: 1000 }).bookDrawdownMinRows, 2)
  // Ceiling 20, not 50: above the book's 8 slots minRows is a second, quieter
  // off-switch than bookDrawdownOn (checker MINOR 5).
  assert.equal(bookDrawdownConfig({ bookDrawdownMinRows: 50 }).bookDrawdownMinRows, 2)
  assert.equal(bookDrawdownConfig({ bookDrawdownMinRows: 20 }).bookDrawdownMinRows, 20)
  assert.equal(bookDrawdownConfig({ bookDrawdownMinRows: 3 }).bookDrawdownMinRows, 3)
  assert.equal(bookDrawdownConfig({ bookMarkMaxAgeHours: 0 }).bookMarkMaxAgeHours, 168)
  assert.equal(bookDrawdownConfig({ bookMarkMaxAgeHours: 99_999 }).bookMarkMaxAgeHours, 168)
  assert.equal(bookDrawdownConfig({ bookMarkMaxAgeHours: 48 }).bookMarkMaxAgeHours, 48)
  // Coverage 0 IS in range and is the deliberate way to turn the fail-closed
  // half off without turning the drawdown half off with it.
  assert.equal(bookDrawdownConfig({ bookDrawdownMinCoveragePct: 0 }).bookDrawdownMinCoveragePct, 0)
  assert.equal(bookDrawdownConfig({ bookDrawdownMinCoveragePct: 101 }).bookDrawdownMinCoveragePct, 60)
  // And the book's own config carries them, so there is one config object.
  const c = momentumBookConfig({ enabled: true, bookDrawdownPct: 30 })
  assert.equal(c.bookDrawdownPct, 30)
  assert.equal(c.bookDrawdownOn, true)
  assert.equal(c.bookMinHoldHours, 24, 'the other knobs are untouched')
})

test('the brake RE-VALIDATES the config it is handed — the clamps are this module\'s defence, not the caller\'s', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const m = marks({ [markKey(A, 'AAA')]: 90, [markKey(A, 'BBB')]: 90 })
  // A raw object a future caller could hand in without going through
  // momentumBookConfig (checker NIT 6): 1e9 is out of range and must not
  // become a threshold nothing can meet.
  const b = bookEntryBrake(db, { accountId: A, bookCfg: { bookDrawdownPct: 1e9 }, now: NOW, marks: m })
  assert.equal(b.read.limitPct, 50, 'the nonsense threshold was replaced by the default')
  assert.equal(b.block, true)
  // Same for the coverage floor and the TTL.
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: { bookDrawdownMinCoveragePct: -5 }, now: NOW, marks: {} }).read.minCoveragePct, 60)
  // OFF is honoured by the brake itself, not only by the config reader.
  const off = bookEntryBrake(db, { accountId: A, bookCfg: momentumBookConfig({ enabled: true, bookDrawdownOn: false }), now: NOW, marks: m })
  assert.deepEqual([off.block, off.notice], [false, null], 'a switch someone deliberately set is not warned about every pass')
})

test('coverage 0 turns the fail-closed half off and leaves the drawdown half armed', () => {
  const db = fresh()
  for (const s of ['B1', 'B2', 'B3', 'B4']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  for (const s of ['H1', 'H2']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  const cfg = momentumBookConfig({ enabled: true, bookDrawdownMinCoveragePct: 0 })
  const partial = marks({ [markKey(A, 'H1')]: 101, [markKey(A, 'H2')]: 101 })
  const b = bookEntryBrake(db, { accountId: A, bookCfg: cfg, now: NOW, marks: partial })
  assert.equal(b.block, false, 'the operator asked for the old, more permissive behaviour')
  assert.match(b.notice, /4 of 6 carried row\(s\) unread/, 'and it is STILL loud about it')
  // The drawdown half still fires on what it can see.
  const bleeding = marks({ [markKey(A, 'H1')]: 90, [markKey(A, 'H2')]: 90 })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: cfg, now: NOW, marks: bleeding }).block, true)
})

test('MAJOR 3: a db read that FAILS blocks and names itself — it is not an empty book', () => {
  // The first version pinned the opposite ("never a block") and was wrong in
  // the way this whole PR is about: the query subselects trade_plans and
  // monitored_positions, so schema drift on either returned `rows: 0`, took
  // the "nothing to be blind about" carve-out and turned the control off with
  // no line anywhere.
  const broken = { prepare: () => { throw new Error('no such column: risk_dist') } }
  const r = bookOpenDrawdown(broken, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.match(r.readError, /no such column: risk_dist/)
  assert.deepEqual([r.rows, r.measured, r.coveragePct], [0, 0, null])
  const b = bookEntryBrake(broken, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.equal(b.block, true, 'fail closed — a control that cannot read must not read as "all clear"')
  assert.match(b.reason, /open book UNREADABLE — the book query failed \(no such column: risk_dist\)/)
  assert.match(b.reason, /Exits, stops, the exit_pending retry and the owed-exit sweep are untouched/)
  // An account with genuinely no carried rows is still silent and open.
  const empty = initDB(':memory:')
  const e = bookOpenDrawdown(empty, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.deepEqual([e.rows, e.readError, e.coveragePct], [0, null, null])
  const be = bookEntryBrake(empty, { accountId: A, bookCfg: CFG, now: NOW, marks: {} })
  assert.deepEqual([be.block, be.notice], [false, null])
})

test('MAJOR 1: an exit_sent row is still carried exposure and still counts', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const m = marks({ [markKey(A, 'AAA')]: 90, [markKey(A, 'BBB')]: 90 })
  assert.equal(bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m }).block, true)
  // The book decides both are bad and SENDS the exits. The closes are not
  // confirmed — the rows become `closed` only when a later pass sees the
  // trades gone — so the account still carries them. Reading `open` alone
  // made the brake go silent AND open on exactly this pass.
  db.prepare(`UPDATE momentum_book SET status = 'exit_sent' WHERE account_id = ?`).run(A)
  const r = bookOpenDrawdown(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.deepEqual([r.rows, r.measured, r.exitSent, r.drawdownPct], [2, 2, 2, 100])
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.equal(b.block, true, 'still braked while the exits are in flight')
  // Only a CONFIRMED close drops out of the reading.
  db.prepare(`UPDATE momentum_book SET status = 'closed' WHERE account_id = ?`).run(A)
  const b2 = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.deepEqual([b2.block, b2.read.rows], [false, 0])
  // AND THE TRADE IS THE AUTHORITY, not the row's status. Nothing in this
  // repo ever moves a row out of 'exit_sent' — the only writer of 'closed' is
  // the trail pass, which selects `status = 'open'` and never revisits an
  // exited row. Without this clause the fix for the SILENT brake would have
  // created a permanent one: an account whose whole book was rank-exited
  // would carry those rows for ever and never take another entry.
  const db2 = fresh()
  const t1 = row(db2, { symbol: 'AAA', entry: 100, planRisk: 10 })
  const t2 = row(db2, { symbol: 'BBB', entry: 100, planRisk: 10 })
  db2.prepare(`UPDATE momentum_book SET status = 'exit_sent'`).run()
  assert.equal(bookEntryBrake(db2, { accountId: A, bookCfg: CFG, now: NOW, marks: m }).block, true, 'in flight: still carried')
  db2.prepare(`UPDATE trades SET status = 'closed' WHERE id IN (?, ?)`).run(t1, t2)
  const b3 = bookEntryBrake(db2, { accountId: A, bookCfg: CFG, now: NOW, marks: m })
  assert.deepEqual([b3.block, b3.read.rows], [false, 0], 'the trade is closed — the row is not exposure whatever its status says')
  // A row with NO trade id is still counted: absent is not closed.
  const db3 = fresh()
  row(db3, { symbol: 'AAA', entry: 100 })
  db3.prepare(`UPDATE momentum_book SET status = 'exit_sent'`).run()
  assert.equal(bookOpenDrawdown(db3, { accountId: A, bookCfg: CFG, now: NOW, marks: {} }).rows, 1)
})

test('MAJOR 2: the cause of every unread row is named, and the permanent ones are distinguishable from the transient', () => {
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  row(db, { symbol: 'CCC', entry: 100, planRisk: 10 })
  row(db, { symbol: 'DDD', entry: 100 })                       // trade_id NULL — permanent
  const b = bookEntryBrake(db, {
    accountId: A, bookCfg: CFG, now: NOW,
    marks: marks({ [markKey(A, 'AAA')]: 100 }),
    markFail: {
      [markKey(A, 'BBB')]: 'symbol does not resolve on this account',
      [markKey(A, 'CCC')]: 'bars unavailable: broker unreachable',
    },
  })
  assert.equal(b.block, true)
  assert.match(b.reason, /1× symbol does not resolve on this account/, 'permanent, needs an operator')
  assert.match(b.reason, /1× bars unavailable: broker unreachable/, 'transient, clears itself')
  assert.match(b.reason, /1× no entry risk stamp \(trade_id NULL — this row can never be priced\)/)
  assert.deepEqual([b.read.unmarked, b.read.unpriced], [2, 1])
  // A stale mark carries the same cause, marked as stale.
  const b2 = bookEntryBrake(db, {
    accountId: A, bookCfg: CFG, now: NOW,
    marks: { [markKey(A, 'AAA')]: { c: 100, at: NOW - 200 * 3_600_000 } },
    markFail: { [markKey(A, 'AAA')]: 'symbol does not resolve on this account' },
  })
  assert.match(b2.reason, /1× stale — symbol does not resolve on this account/)
})

test('MINOR 4: a mark stamped in the FUTURE is not permanently fresh', () => {
  // `age <= maxAge` passes for any negative age, so a stamp ahead of the
  // clock used to be fresh for ever — the mirror image of the frozen feed.
  const ahead = NOW + 10 * 365 * 86_400_000
  assert.equal(markAgeMs({ bt: ahead, at: ahead }, NOW).basis, 'none', 'neither stamp is usable')
  assert.equal(markAgeMs({ bt: ahead, at: NOW - 3_600_000 }, NOW).basis, 'fetch', 'falls through to the usable one')
  // Ordinary skew is tolerated rather than treated as a fault.
  assert.equal(markAgeMs({ bt: NOW + 60_000 }, NOW).basis, 'bar')
  assert.equal(markAgeMs({ bt: NOW + 60_000 }, NOW).ms, 0, 'clamped at zero, never negative')
  const db = fresh()
  row(db, { symbol: 'AAA', entry: 100, planRisk: 10 })
  row(db, { symbol: 'BBB', entry: 100, planRisk: 10 })
  const b = bookEntryBrake(db, { accountId: A, bookCfg: CFG, now: NOW, marks: {
    [markKey(A, 'AAA')]: { c: 95, at: ahead, bt: ahead },
    [markKey(A, 'BBB')]: { c: 95, at: ahead, bt: ahead },
  } })
  assert.equal(b.read.staleMarks, 2)
  assert.equal(b.block, true, 'blocked for blindness, not passed as fresh')
})

test('MINOR 5: minRows above the book\'s slot count is named when it suppresses a verdict', () => {
  const db = fresh()
  for (const s of ['R1', 'R2', 'R3']) row(db, { symbol: s, entry: 100, planRisk: 10 })
  const m = marks(Object.fromEntries(['R1', 'R2', 'R3'].map(s => [markKey(A, s), 40])))   // −6 R each
  const cfg = momentumBookConfig({ enabled: true, bookDrawdownMinRows: 20 })
  const b = bookEntryBrake(db, { accountId: A, bookCfg: cfg, now: NOW, marks: m })
  assert.equal(b.block, false, 'the knob suppresses the verdict')
  assert.match(b.notice, /open drawdown 600% would have refused new entries, but bookDrawdownMinRows 20 > 3 carried row\(s\)/)
  assert.match(b.notice, /suppressed by that knob, not by the book being healthy/)
})
