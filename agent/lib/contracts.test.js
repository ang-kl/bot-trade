// node --test agent/lib/contracts.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contractSize,
  usdLossPerLot,
  fxQuoteCurrency,
  usdRate,
  notionalUsd,
  tierForBalance,
  TIERS,
} from './contracts.js'

// contractSize -----------------------------------------------------------

test('contractSize — gold = 100 oz/lot', () => {
  assert.equal(contractSize('XAUUSD'), 100)
})

test('contractSize — silver = 5000 oz/lot', () => {
  assert.equal(contractSize('XAGUSD'), 5000)
})

test('contractSize — natgas + cocoa have commodity sizes', () => {
  assert.equal(contractSize('NATGAS'), 10000)
  assert.equal(contractSize('COCOA'), 10)
})

test('contractSize — FX major defaults to 100k', () => {
  assert.equal(contractSize('EURUSD'), 100_000)
  assert.equal(contractSize('GBPJPY'), 100_000)
})

test('contractSize — indices default to 1', () => {
  assert.equal(contractSize('US30'), 1)
  assert.equal(contractSize('NAS100'), 1)
})

test('contractSize — crypto = 1/lot', () => {
  assert.equal(contractSize('BTCUSD'), 1)
  assert.equal(contractSize('ETHUSD'), 1)
})

test('contractSize — unknown short symbol returns 1', () => {
  assert.equal(contractSize('BLOB'), 1)
  assert.equal(contractSize(''), 1)
  assert.equal(contractSize(null), 1)
})

test('contractSize — case-insensitive', () => {
  assert.equal(contractSize('xauusd'), 100)
  assert.equal(contractSize('EurUsd'), 100_000)
})

// usdLossPerLot ----------------------------------------------------------

test('usdLossPerLot — EURUSD 30 pip = $300/lot', () => {
  assert.equal(usdLossPerLot('EURUSD', 0.003), 300)
})

test('usdLossPerLot — XAUUSD $5 move = $500/lot', () => {
  assert.equal(usdLossPerLot('XAUUSD', 5), 500)
})

test('usdLossPerLot — negative distance treated as absolute', () => {
  assert.equal(usdLossPerLot('EURUSD', -0.003), 300)
})

test('usdLossPerLot — USDJPY converts quote-ccy loss to USD via price', () => {
  // 0.50 JPY distance × 100k = ¥50,000 → at 147.50, $338.98/lot — NOT $50,000
  const out = usdLossPerLot('USDJPY', 0.5, 147.5)
  assert.ok(Math.abs(out - 50000 / 147.5) < 0.01, `got ${out}`)
})

test('usdLossPerLot — USDCHF converts via price', () => {
  // 30 pip × 100k = 300 CHF → at 0.90, $333.33/lot
  const out = usdLossPerLot('USDCHF', 0.003, 0.9)
  assert.ok(Math.abs(out - 300 / 0.9) < 0.01, `got ${out}`)
})

test('usdLossPerLot — USD-base without a price is unknown (NaN), not mis-sized', () => {
  assert.ok(Number.isNaN(usdLossPerLot('USDJPY', 0.5)))
  assert.ok(Number.isNaN(usdLossPerLot('USDJPY', 0.5, 0)))
})

test('usdLossPerLot — cross with no USD leg is unknown (NaN)', () => {
  assert.ok(Number.isNaN(usdLossPerLot('EURJPY', 0.5, 160)))
  assert.ok(Number.isNaN(usdLossPerLot('EURGBP', 0.003, 0.85)))
})

test('usdLossPerLot — USD-quoted unaffected by price argument', () => {
  assert.equal(usdLossPerLot('EURUSD', 0.003, 1.1), 300)
  assert.equal(usdLossPerLot('NAS100', 50, 20000), 50)
})

test('usdLossPerLot — 6-letter COMMODITIES are not FX pairs (NATGAS/COFFEE/COTTON)', () => {
  // Regression: these matched the 6-letter FX pattern and were vetoed as
  // usd_per_lot_unknown crosses. They are USD-denominated commodities.
  assert.equal(usdLossPerLot('NATGAS', 0.1), 1000)   // 0.1 × 10,000
  assert.equal(usdLossPerLot('COFFEE', 0.01), 375)   // 0.01 × 37,500
  assert.equal(usdLossPerLot('COTTON', 0.01), 500)   // 0.01 × 50,000
  assert.equal(usdLossPerLot('COPPER', 0.01), 250)   // 0.01 × 25,000
})

// notionalUsd -----------------------------------------------------------

test('notionalUsd — EURUSD 0.01 lot at 1.10 = $1100', () => {
  assert.equal(notionalUsd('EURUSD', 0.01, 1.10), 1100)
})

test('notionalUsd — XAUUSD 0.01 lot at $2400 = $2400', () => {
  assert.equal(notionalUsd('XAUUSD', 0.01, 2400), 2400)
})

test('notionalUsd — BTCUSD 0.01 lot at $50k = $500', () => {
  assert.equal(notionalUsd('BTCUSD', 0.01, 50000), 500)
})

test('notionalUsd — US30 0.5 lot at 40000 = $20000', () => {
  assert.equal(notionalUsd('US30', 0.5, 40000), 20000)
})

test('notionalUsd — NATGAS 0.01 lot at $2.50 = $250', () => {
  // 0.01 × 10000 × 2.50 = $250
  assert.equal(notionalUsd('NATGAS', 0.01, 2.50), 250)
})

test('notionalUsd — USDJPY 0.1 lot = $10,000 (base is USD, no price term)', () => {
  // Previously 0.1 × 100k × 147.5 = "¥1.475M read as USD" — 147× overstated.
  assert.equal(notionalUsd('USDJPY', 0.1, 147.5), 10_000)
})

test('notionalUsd — cross falls back to quote-ccy approximation', () => {
  assert.equal(notionalUsd('EURGBP', 0.1, 0.85), 8500)
})

// Tier resolution --------------------------------------------------------

test('tierForBalance — $200 → micro', () => {
  assert.equal(tierForBalance(200).name, 'micro')
})

test('tierForBalance — $500 → micro (inclusive upper bound)', () => {
  assert.equal(tierForBalance(500).name, 'micro')
})

test('tierForBalance — $501 → small', () => {
  assert.equal(tierForBalance(501).name, 'small')
})

test('tierForBalance — $2000 → small', () => {
  assert.equal(tierForBalance(2000).name, 'small')
})

test('tierForBalance — $5000 → standard', () => {
  assert.equal(tierForBalance(5000).name, 'standard')
})

test('tierForBalance — $100000 → full', () => {
  assert.equal(tierForBalance(100_000).name, 'full')
})

test('tierForBalance — malformed → 0 → micro', () => {
  assert.equal(tierForBalance('garbage').name, 'micro')
  assert.equal(tierForBalance(null).name, 'micro')
})

test('TIERS exported with expected shape', () => {
  assert.ok(Array.isArray(TIERS))
  assert.ok(TIERS.length >= 4)
  for (const t of TIERS) {
    assert.ok(typeof t.name === 'string')
    assert.ok(typeof t.maxBalance === 'number')
    assert.ok(typeof t.note === 'string')
  }
})

// ---------------------------------------------------------------------------
// usdRate transitive derivation (production 02-08-2026): 654 entries in two
// days were sized to zero — "insufficient_equity … usd_per_lot_unknown" — on
// EURJPY, AUDPLN and EURGBP, because the USD major each needs (USDJPY,
// USDPLN, GBPUSD) is not a scanned symbol so the rates map never held it.
// One hop through a scanned cross resolves all three.
// ---------------------------------------------------------------------------

test('usdRate — direct pair still wins over any derivation', () => {
  assert.equal(usdRate('GBP', { GBPUSD: 1.27, EURGBP: 0.85, EURUSD: 1.08 }), 1.27)
})

test('usdRate — inverse pair (USDJPY) still resolves JPY', () => {
  const r = usdRate('JPY', { USDJPY: 157 })
  assert.ok(Math.abs(r - 1 / 157) < 1e-9, `got ${r}`)
})

test('usdRate — JPY derived from EURJPY + EURUSD (the EURJPY veto)', () => {
  // EUR→USD 1.08, EURJPY 170 ⇒ JPY→USD = 1.08 / 170
  const r = usdRate('JPY', { EURUSD: 1.08, EURJPY: 170 })
  assert.ok(Math.abs(r - 1.08 / 170) < 1e-9, `got ${r}`)
})

test('usdRate — GBP derived from EURGBP + EURUSD (the EURGBP veto)', () => {
  const r = usdRate('GBP', { EURUSD: 1.08, EURGBP: 0.85 })
  assert.ok(Math.abs(r - 1.08 / 0.85) < 1e-9, `got ${r}`)
})

test('usdRate — PLN derived from AUDPLN + AUDUSD (the AUDPLN veto)', () => {
  const r = usdRate('PLN', { AUDUSD: 0.66, AUDPLN: 2.6 })
  assert.ok(Math.abs(r - 0.66 / 2.6) < 1e-9, `got ${r}`)
})

test('usdRate — base-side derivation (CADCHF gives CAD via CHF)', () => {
  // CAD is the BASE of CADCHF: price is CHF per CAD ⇒ CAD→USD = price × CHF→USD
  const r = usdRate('CAD', { USDCHF: 0.88, CADCHF: 0.65 })
  assert.ok(Math.abs(r - 0.65 * (1 / 0.88)) < 1e-9, `got ${r}`)
})

test('usdRate — never chains through a DERIVED leg (no compounding stale closes)', () => {
  // PLN would need AUD, AUD would itself need deriving — refuse, do not guess.
  assert.ok(Number.isNaN(usdRate('PLN', { AUDPLN: 2.6, EURAUD: 1.63 })));
})

test('usdRate — unknown currency with no path stays NaN (veto, never guess)', () => {
  assert.ok(Number.isNaN(usdRate('ZAR', { EURUSD: 1.08 })))
  assert.ok(Number.isNaN(usdRate('JPY', null)))
})

test('usdLossPerLot — EURJPY sizes instead of vetoing once JPY is derivable', () => {
  const rates = { EURUSD: 1.08, EURJPY: 170 }
  const v = usdLossPerLot('EURJPY', 0.5, 170, rates)
  assert.ok(Number.isFinite(v) && v > 0, `expected a finite loss/lot, got ${v}`)
  // 0.5 JPY × 100,000 = 50,000 JPY → × (1.08/170) USD
  assert.ok(Math.abs(v - 50_000 * (1.08 / 170)) < 1e-6, `got ${v}`)
})

// ---------------------------------------------------------------------------
// Owner, 2026-08-03: "The TP and SL is in hundreds of thousands when I dont
// have such balance." The quote currency of a non-FX instrument was never
// asked for — fxQuoteCurrency returned null for anything without six letters
// and usdLossPerLot read null as USD, so the conversion was skipped.
// These pin the fix against the ACTUAL live book of account 46130058 at
// 08:40 UTC, where every position had been sized to ≈3,900 in its own quote
// currency. The uniform 3,900 across currencies was the bug.
// ---------------------------------------------------------------------------
test('the quote currency of a non-FX instrument is declared, not assumed', () => {
  // CHANGED BACK 13-08-2026, and this time with the whole sample.
  //
  // The 07-08 note reasoned correctly that `contractSize 1 + JPY` was
  // impossible — trade 641's 9,171.76 loss would need a 20,000-point move on a
  // 62,487 index — and then concluded USD. That varied the CURRENCY while
  // holding the CONTRACT SIZE fixed, and the contract size was the wrong term.
  // The third option was never tested: `contractSize 100 + JPY`.
  //
  // 23 closed deals (9 JPN225, 14 JPYX) on the 28 Jul–13 Aug statement imply
  // $0.6275–$0.6394 of realised P&L per point per lot. Not one row is near
  // 1.0000. And the value DRIFTS across the period exactly as 100 ÷ USDJPY
  // does while the yen moves ~159 → ~156.6. A USD-settled contract cannot
  // drift with the yen; a yen-quoted one cannot do anything else. That drift,
  // not any single trade, is the proof.
  //
  // Under the corrected pair the 9,171.76 loss is a 197.9-point move on 72.5
  // lots — an ordinary move on an extraordinary position.
  assert.equal(fxQuoteCurrency('JPN225'), 'JPY')
  // These are the same hand-entered assumption, still unverified. Kept as-is
  // deliberately (no evidence either way) — sizing-parity.js is what will
  // settle them, and it will do it from realised broker P&L, not from here.
  assert.equal(fxQuoteCurrency('GER40'), 'EUR')
  assert.equal(fxQuoteCurrency('UK100'), 'GBP')
  assert.equal(fxQuoteCurrency('AUS200'), 'AUD')
  assert.equal(fxQuoteCurrency('0003.HK'), 'HKD', 'Hong Kong share CFDs trade in HKD')
  assert.equal(fxQuoteCurrency('TSLA.US'), 'USD')
  assert.equal(fxQuoteCurrency('US30'), 'USD')
  // Unlisted stays as it was — an unknown currency is not a guess.
  assert.equal(fxQuoteCurrency('NATGAS'), null)
  assert.equal(fxQuoteCurrency('XAUUSD'), null)
  assert.equal(fxQuoteCurrency('EURGBP'), 'GBP', 'the six-letter rule still applies')
})

test('0003.HK stop risk is HKD converted to USD, not HKD relabelled USD', () => {
  // The live row: short, vol 23,658.48, entry 6.98, SL 7.133.
  const rates = { USDHKD: 7.8 }
  const perLot = usdLossPerLot('0003.HK', 7.133 - 6.98, 6.98, rates)
  const risk = perLot * 23658.48
  // Was reporting 3,620 "USD". The truth is about $464.
  assert.ok(risk > 440 && risk < 480, `expected ≈464 USD, got ${risk}`)
})

test('without a USDHKD rate the answer is NaN — refuse, never guess a peg', () => {
  // A pegged currency is still a currency. Inventing 7.8 here would be the
  // same class of error as assuming USD: a number nobody measured.
  assert.ok(Number.isNaN(usdLossPerLot('0003.HK', 0.153, 6.98, { EURUSD: 1.15 })))
})

test('GER40 stop risk converts through EUR', () => {
  // Live row: long, vol 6.48, entry 25,905.1, SL 25,333.1 → 3,706.56 EUR.
  const risk = usdLossPerLot('GER40', 25333.1 - 25905.1, 25905.1, { EURUSD: 1.15394 }) * 6.48
  assert.ok(risk > 4250 && risk < 4300, `expected ≈4,278 USD, got ${risk}`)
})

test('USD-quoted instruments are untouched — US30 and NAS100 were always right', () => {
  const us30 = usdLossPerLot('US30', 52813 - 51567.5, 52813, {}) * 3.12
  assert.ok(Math.abs(us30 - 3885.96) < 0.01, `expected ≈3,885.96 USD, got ${us30}`)
  assert.ok(Number.isFinite(usdLossPerLot('NAS100', 682.7376, 28447.4, {})))
})

// ---------------------------------------------------------------------------
// CONTRACT SPECS MEASURED FROM CLOSED FILLS — statement 28 Jul → 13 Aug 2026.
//
// Every number below is `|Net USD| ÷ (|price move| × lots)` taken from the
// broker's own closed deals: the realised dollars a one-point move pays on one
// lot. It is the one figure the sizer must agree with, because sizing is
// `lots = riskBudget ÷ usdLossPerLot` — get the denominator wrong by 100× and
// the position is 100× too big, which is precisely what happened.
//
// These assertions exist so a future "correction" on a plausible-sounding
// assumption has to argue with the broker rather than with a comment. That is
// how `JPN225: 'USD'` survived: it read as reasonable and nothing measured it.
// ---------------------------------------------------------------------------

const RATES = { EURUSD: 1.1525, USDJPY: 157.0, USDZAR: 16.46 }

test('the instruments that blew up now price the way the fills did', () => {
  // symbol, measured $/point/lot, tolerance, n deals behind the measurement
  const cases = [
    ['USDX', 100.0, 0.01, 2],     // was contractSize 1 → valued a point at $1
    ['EURX', 115.25, 0.05, 1],    // 100 EUR × 1.1525 — was $1
    ['XPTUSD', 100.0, 0.01, 2],   // was 50 → every platinum trade double-risk
    ['JPN225', 0.6369, 0.005, 9], // 100 JPY ÷ 157 — was $1.000 as "USD-settled"
    ['JPYX', 0.6369, 0.005, 14],
  ]
  for (const [sym, expected, tol, n] of cases) {
    const got = usdLossPerLot(sym, 1, 100, RATES)
    assert.ok(
      Number.isFinite(got) && Math.abs(got - expected) <= tol,
      `${sym}: sizer values one point at $${got} but ${n} closed deal(s) paid $${expected}`,
    )
  }
})

test('the symbols the fills already agreed with are left alone', () => {
  // A correction that moves something already correct is the mirror of the
  // bug. These were measured on the same statement and matched exactly.
  for (const [sym, expected] of [['NAS100', 1], ['US30', 1], ['VIX', 1],
    ['LTCUSD', 1], ['BTCUSD', 1], ['XAUUSD', 100], ['NATGAS', 10000]]) {
    assert.equal(usdLossPerLot(sym, 1, 100, RATES), expected, `${sym} moved when it should not have`)
  }
})

test('a 100x valuation error is a 100x position — the arithmetic that cost the money', () => {
  // EURX, 2 Aug: 22 lots, dead in two minutes, −$2,535.41. With a $500 risk
  // budget and a 1.0-point stop, the old table sized 500 lots; the corrected
  // one sizes 4.34. The bug was never subtle — it was invisible.
  const budget = 500, stop = 1.0
  const correct = budget / usdLossPerLot('EURX', stop, 100, RATES)
  const asIfUnpriced = budget / (stop * 1) // contractSize 1, quote treated USD
  assert.ok(correct < 5, `corrected sizing should be a few lots, got ${correct}`)
  assert.ok(asIfUnpriced / correct > 100, 'the old table sized >100x larger')
})

test('notional is what exposes the blow-ups — risk alone does not', () => {
  // The 12 deals a 10x ceiling would have refused all sat at 20x-79x balance,
  // while normal trading ran a 0.8x median. These are the two extremes, priced
  // with the corrected table against the balance each actually ran on.
  const bal = 36630 // account balance at the JPN225 deal
  const jpn = notionalUsd('JPN225', 72.5, 62286.5, RATES)
  assert.ok(jpn / bal > 70, `JPN225 was ${(jpn / bal).toFixed(0)}x balance, expected >70x`)
  const eurx = notionalUsd('EURX', 22, 107.8, RATES)
  assert.ok(eurx / 35600 > 5, 'EURX ran far above normal exposure too')
  // A normal trade for contrast: 0.8 lots of NAS100 is well under the ceiling.
  assert.ok(notionalUsd('NAS100', 0.8, 29720, RATES) / bal < 1)
})
