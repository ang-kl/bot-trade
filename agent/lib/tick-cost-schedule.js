// ---------------------------------------------------------------------------
// agent/lib/tick-cost-schedule.js — PR-L (docs/plan-execution-audit-2026-09-11.md
// §16): the tick shadow's cost model, per SYMBOL CLASS.
//
// WHY A CLASS AND NOT ONE NUMBER. The sidecar's quotes are cTrader wire units
// and cTrader's wire unit is 1e-5 of the symbol's own price for EVERY symbol
// (cpp-exec/src/tick_recorder.hpp: "Prices are cTrader wire units (1e-5)";
// spot_feed.cpp kPointsPerPrice = 100000). So one absolute wire-unit number
// cannot mean the same thing on EURUSD (price ~1.08 → 108,000 wire units) and
// on NAS100 (~29,142 → 2.9 billion).
//
// WHY EACH CLASS CARRIES BOTH A WIRE TERM AND A BPS TERM. Measuring the
// owner's statements says the broker charges two DIFFERENT shapes and a
// single unit misprices one of them (checker, 16-09-2026):
//
//   - HK stock and FX are proportional to price. In bps their spread is tight
//     (HK CV 0.022 over 20 deals); in absolute price units it is not (CV 0.741).
//   - US stock is a flat $0.02 PER SHARE per side — 56 of 60 deals land in
//     0.0199–0.0205 price units from DOW.US at $29.84 to LLY.US at $1,222,
//     CV 0.58; in bps the same deals run 0.16 → 6.80, CV 0.975. Quoting a
//     "median 0.65 bps" for that is quoting the midpoint of a bimodal sample.
//
// So a class row is  cost = commissionWirePerSide + commissionBpsPerSide × price / 10000,
// and the engines apply exactly that (cpp-exec/src/tick_shadow.cpp).
//
// QUANTISATION (checker finding 4). Rounding the cost to whole wire units
// re-created the zero-cost bug for cheap symbols: DOGEUSD at 0.06851 is 6,851
// wire units, and 0.5 bps of that is 0.34 — which rounded to 0, so netR ===
// grossR again. Two rules now:
//   - COMMISSION is never quantised. It is subtracted as a double before the
//     R division, so a sub-wire-unit commission still bites.
//   - SLIPPAGE must shift an integer price, so it rounds — but AWAY FROM ZERO:
//     a non-zero slippage never becomes a free fill. That overstates the cost
//     on very cheap symbols, which is the safe direction for an evidence bar,
//     and it is stated rather than hidden.
//
// WHERE THE NUMBERS COME FROM is stated per class in the config's `_source`
// fields. Commission is MEASURED from the owner's own broker statements
// (agent/seed-statements/*.csv); slippage is a PLACEHOLDER — the statements
// carry no intent-vs-fill pair, so there is nothing in this repo to measure it
// from, and inventing a measured figure is the failure mode CLAUDE.md §6 names.
//
// This module decides nothing and places nothing: it classifies, it loads, it
// hashes, and it re-prices a closed trade at a multiple of a schedule.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { assetClassOf } from '../services/strategy-asset-cross.js'

/** The classes the schedule is cut by. Order is the display order. */
export const COST_CLASSES = Object.freeze(['stock_us', 'stock_hk', 'index_cfd', 'fx', 'commodity', 'crypto'])

/** The repo's schedule file, and the agent_state key the resolved per-side map is stored under. */
export const TICK_SHADOW_SIM_FILE = new URL('../config/tick-shadow-sim.json', import.meta.url)
export const TICK_COST_MAP_KEY = 'tick_shadow_cost_map_json'

// Checker finding 9: real symbols from the owner's own statements fell through
// `assetClassOf` — BNBUSD was swallowed by the six-letter FX rule (and so was
// NOT even reported as unclassified), and VIX / USDX / JPYX / EURX / CN50
// classified as nothing at all. These two lists are checked BEFORE delegating.
// They are cost-model taxonomy, deliberately not pushed into
// services/strategy-asset-cross.js: that reader attributes CLOSED TRADES and a
// present-day cost table must not be able to rewrite what a past trade was.
const CRYPTO_BASES = /^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC|BCH|DOT|AVAX|LINK|MATIC|BNB|TRX|XLM|ATOM|UNI|FIL|ETC|NEAR|ALGO|AAVE|SHIB|TON|SUI)(USD|USDT|EUR|GBP)$/
const INDEX_NAMES = /^(VIX|USDX|EURX|JPYX|GBPX|CHFX|CN50|CHINA50|HSI|SPX|NDX)$/

/**
 * The cost class of a symbol NAME, derived from the taxonomy the rest of the
 * repo already uses (services/strategy-asset-cross.js assetClassOf) plus the
 * two lists above. `null` means the name did not classify — the caller
 * REPORTS it and falls back; it is never silently absorbed.
 */
export function costClassOf(symbol) {
  const s = String(symbol || '').trim().toUpperCase()
  if (!s) return null
  if (CRYPTO_BASES.test(s)) return 'crypto'
  if (INDEX_NAMES.test(s)) return 'index_cfd'
  switch (assetClassOf(s)) {
    case 'crypto': return 'crypto'
    case 'metal': case 'energy': case 'soft': return 'commodity'
    case 'index': return 'index_cfd'
    case 'fx': return 'fx'
    case 'stock':
      if (/\.US$/.test(s)) return 'stock_us'
      if (/\.HK$/.test(s)) return 'stock_hk'
      return null            // .DE/.UK/.AU: no measured schedule — reported, not guessed
    default: return null
  }
}

const numOr0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** The four cost terms of one class row, all defaulted to 0. */
function costRow(c) {
  return {
    commissionWirePerSide: numOr0(c?.commissionWirePerSide),
    commissionBpsPerSide: numOr0(c?.commissionBpsPerSide),
    slippageWirePerSide: numOr0(c?.slippageWirePerSide),
    slippageBpsPerSide: numOr0(c?.slippageBpsPerSide),
  }
}

/**
 * Normalise a raw `costs` block into { classes, fallbackClass, unknownClasses }.
 *
 * A class name this repo does not price is DROPPED from `classes` but its name
 * is KEPT in `unknownClasses` and hashed (checker finding 11: filtering the
 * hash through COST_CLASSES made a sidecar carrying an extra 99-bps class hash
 * identical to the repo's, so `matchesRepo` read true on a schedule that was
 * not the repo's). A missing or unusable fallback becomes the most expensive
 * class present, because an unclassified symbol must not be charged the
 * cheapest schedule by accident.
 */
export function normalizeSchedule(raw) {
  const classes = {}
  const unknownClasses = []
  const src = raw && typeof raw === 'object' && raw.classes && typeof raw.classes === 'object' ? raw.classes : {}
  for (const [name, c] of Object.entries(src)) {
    if (!c || typeof c !== 'object') continue
    if (!COST_CLASSES.includes(name)) { unknownClasses.push(name); continue }
    classes[name] = costRow(c)
  }
  for (const n of Array.isArray(raw?.unknownClasses) ? raw.unknownClasses : []) if (!unknownClasses.includes(String(n))) unknownClasses.push(String(n))
  const names = Object.keys(classes)
  let fallbackClass = typeof raw?.fallbackClass === 'string' && classes[raw.fallbackClass] ? raw.fallbackClass : null
  if (!fallbackClass && names.length) {
    fallbackClass = names.reduce((a, b) => (dearness(classes[b]) > dearness(classes[a]) ? b : a))
  }
  return { classes, fallbackClass, unknownClasses: unknownClasses.sort() }
}

/**
 * How dear a class row is, for picking the fallback. Compared at a reference
 * price of 100,000 wire units (1.0 in real price) so the wire and bps terms
 * are on one scale — the comparison only has to ORDER the rows.
 */
export function dearness(c, referenceWirePrice = 100_000) {
  const r = costRow(c)
  return r.commissionWirePerSide + r.slippageWirePerSide + (r.commissionBpsPerSide + r.slippageBpsPerSide) * referenceWirePrice / 10000
}

/** The repo's schedule as { classes, fallbackClass, unknownClasses }; empty when unreadable. */
export function loadRepoSchedule(file = TICK_SHADOW_SIM_FILE) {
  try { return normalizeSchedule(JSON.parse(readFileSync(file, 'utf8'))?.costs) } catch { return { classes: {}, fallbackClass: null, unknownClasses: [] } }
}

/** The costs for a class name, or the fallback's, or zero — always saying which. */
export function costsForClass(schedule, className) {
  const sch = schedule && schedule.classes ? schedule : normalizeSchedule(schedule)
  if (className && sch.classes[className]) return { ...sch.classes[className], class: className, source: 'class' }
  if (sch.fallbackClass && sch.classes[sch.fallbackClass]) {
    return { ...sch.classes[sch.fallbackClass], class: sch.fallbackClass, source: className ? 'fallback' : 'fallback_unclassified' }
  }
  return { ...costRow(null), class: null, source: 'none' }
}

/**
 * The EXACT per-side cost at a price, in wire units, as a double — the wire
 * term plus the bps term. Commission uses this and is never rounded.
 */
export function costExact(wirePerSide, bps, price) {
  const w = Number(wirePerSide), b = Number(bps), p = Number(price)
  const flat = Number.isFinite(w) ? w : 0
  const prop = Number.isFinite(b) && Number.isFinite(p) && b > 0 && p > 0 ? b * p / 10000 : 0
  return flat + prop
}

/**
 * The per-side cost in WHOLE wire units, for a term that has to shift an
 * integer price (slippage). Rounds AWAY FROM ZERO: a non-zero cost never
 * becomes a free fill on a cheap symbol (checker finding 4 — DOGEUSD at
 * 0.06851 rounded 0.5 bps to 0). C++ mirrors this exactly
 * (cpp-exec/src/tick_shadow.cpp wireCostInt).
 */
export function wireCostInt(wirePerSide, bps, price) {
  const exact = costExact(wirePerSide, bps, price)
  if (!(exact > 0)) return 0
  const r = Math.round(exact)
  return r < 1 ? 1 : r
}

/** Back-compat helper for a bps-only term. */
export function wireCost(bps, price) { return wireCostInt(0, bps, price) }

/**
 * Classify a universe of symbol names. Returns the map AND the names that did
 * not classify — the caller must report them (the test for this PR is that no
 * symbol of the tick-observation universe, and none of the symbols in the
 * owner's own statements, falls through unreported).
 */
export function classifyUniverse(names, schedule = null) {
  const map = {}
  const unclassified = []
  for (const raw of names || []) {
    const name = String(raw || '').trim().toUpperCase()
    if (!name) continue
    const cls = costClassOf(name)
    if (cls) map[name] = cls
    else if (!unclassified.includes(name)) unclassified.push(name)
  }
  const fallbackClass = schedule ? normalizeSchedule(schedule).fallbackClass : null
  return { map, unclassified, fallbackClass }
}

/**
 * A stable 16-hex digest of a schedule — the thing an evidence record carries
 * so a verdict earned under one cost model can never be read as if it were
 * earned under another. Canonical: every priced class in COST_CLASSES order
 * with all four terms, the fallback, AND any class name this repo does not
 * price (finding 11). The symbol map is excluded: the SCHEDULE is the cost
 * model; which symbol ids were carried is checked separately.
 */
export function scheduleHash(schedule) {
  const sch = normalizeSchedule(schedule)
  const canon = JSON.stringify({
    fallbackClass: sch.fallbackClass,
    unknown: sch.unknownClasses,
    classes: COST_CLASSES.filter(c => sch.classes[c]).map(c => [c,
      sch.classes[c].commissionWirePerSide, sch.classes[c].commissionBpsPerSide,
      sch.classes[c].slippageWirePerSide, sch.classes[c].slippageBpsPerSide]),
  })
  return createHash('sha256').update(canon).digest('hex').slice(0, 16)
}

/** The cost model a stored shadow row was CHARGED, read off the row itself. */
export function rowCostModel(trade) {
  return {
    class: trade?.cost_class ?? trade?.costClass ?? null,
    commissionWirePerSide: numOr0(trade?.commission_wire ?? trade?.commissionWirePerSide),
    commissionBpsPerSide: numOr0(trade?.commission_bps ?? trade?.commissionBpsPerSide),
    slippageWirePerSide: numOr0(trade?.slippage_wire ?? trade?.slippageWirePerSide),
    slippageBpsPerSide: numOr0(trade?.slippage_bps ?? trade?.slippageBpsPerSide),
  }
}

/**
 * Was THIS ROW actually charged the given schedule?
 *
 * ROUND-TWO CHECKER, BLOCKER 1/2. The first version of this was
 * `rowIsCosted` — a string-emptiness test on `cost_class`. Six rows carrying
 * `cost_class: 'fx'` and all four cost terms ZERO passed every gate while the
 * sidecar declared the real schedule, and the account reached SHADOW_PASSED;
 * `'not_a_class'` passed, and so did a single space. The four checks on the
 * sidecar's /health proved what the sidecar SAID; nothing reached back to what
 * any book had subtracted.
 *
 * It is not an adversarial case. `main.cpp` applies a pushed sim to NEW BOOKS
 * only, so for the whole window after a schedule push /health declares the new
 * schedule while books opened earlier keep closing under the old one.
 *
 * So a row counts as evidence only when all three hold:
 *   1. its class is one this repo prices, and the schedule has that class;
 *   2. its four recorded cost terms EQUAL that class row — the book wrote what
 *      it resolved at construction, so this is the book's own arithmetic, not
 *      a declaration about it. A row closed under the previous schedule falls
 *      out of the evidence rather than being counted under the wrong model;
 *   3. its own netR is arithmetically consistent with its own grossR and those
 *      terms. A row whose cost fields were filled in without being applied
 *      fails here even if 1 and 2 pass.
 *
 * @returns {{ok: boolean, class: string|null, reason: string|null, detail?: object}}
 */
export function rowChargedUnder(trade, schedule) {
  const cls = trade?.cost_class ?? trade?.costClass
  if (typeof cls !== 'string' || cls.trim() === '') return { ok: false, class: null, reason: 'no_cost_class' }
  if (!COST_CLASSES.includes(cls)) return { ok: false, class: cls, reason: 'unknown_cost_class' }
  const sch = schedule && schedule.classes ? schedule : normalizeSchedule(schedule)
  const want = sch.classes[cls]
  if (!want) return { ok: false, class: cls, reason: 'class_not_in_schedule' }
  const got = rowCostModel(trade)
  const TERMS = ['commissionWirePerSide', 'commissionBpsPerSide', 'slippageWirePerSide', 'slippageBpsPerSide']
  for (const k of TERMS) {
    if (Number(got[k]) !== Number(want[k])) {
      return { ok: false, class: cls, reason: 'cost_terms_differ', detail: { term: k, row: Number(got[k]), schedule: Number(want[k]) } }
    }
  }
  // 3. the row's own arithmetic. Slippage is already inside the recorded
  // entry/exit, so net = gross − commission at each end. grossR and netR are
  // both rounded to 4 dp by the book, hence the tolerance.
  const entry = Number(trade.entry), exit = Number(trade.exit)
  const stopDistance = Number(trade.stop_distance ?? trade.stopDistance)
  const grossR = Number(trade.gross_r ?? trade.grossR), netR = Number(trade.net_r ?? trade.netR)
  if ([entry, exit, stopDistance, grossR, netR].every(Number.isFinite) && stopDistance > 0) {
    const comm = costExact(want.commissionWirePerSide, want.commissionBpsPerSide, entry)
               + costExact(want.commissionWirePerSide, want.commissionBpsPerSide, exit)
    const expected = grossR - comm / stopDistance
    if (Math.abs(expected - netR) > 1e-3) {
      return { ok: false, class: cls, reason: 'net_r_not_charged', detail: { netR, expected: +expected.toFixed(4), grossR } }
    }
  }
  return { ok: true, class: cls, reason: null }
}

/**
 * Does the row carry a cost class at all? Used ONLY to separate pre-PR-L rows
 * from the rest for reporting — never as the evidence test, which is
 * `rowChargedUnder`.
 */
export function rowIsCosted(trade) {
  const c = trade?.cost_class ?? trade?.costClass
  return typeof c === 'string' && c.trim().length > 0
}

/**
 * Re-price ONE closed shadow trade at `multiple` × a schedule.
 *
 * The recorded entry/exit are the prices the book filled at, WITH whatever
 * slippage that book charged — read off the ROW (checker finding 3: this used
 * to strip by the row's bps but re-price by the CURRENT map's class, so a
 * symbol id that had been re-mapped was re-priced as a different instrument
 * with nothing reported). So: strip the row's own slippage to recover the raw
 * executable price, then re-apply the schedule at the multiple asked for, and
 * charge commission per side at each end's own price, unrounded.
 *
 * At multiple 1 with the row's own schedule this returns the recorded netR —
 * `tick-cost-schedule.test.js` pins that.
 *
 * @returns {number|null} netR, or null when the row cannot be re-priced.
 */
export function repriceNetR(trade, costs, multiple = 1) {
  const dir = String(trade.trade_side ?? trade.side ?? '').toUpperCase() === 'BUY' ? 1 : -1
  const entry = Number(trade.entry), exit = Number(trade.exit)
  const stopDistance = Number(trade.stop_distance ?? trade.stopDistance)
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !(stopDistance > 0)) return null
  const own = rowCostModel(trade)
  // The bps are applied on the RECORDED price, not on the stripped one: the
  // two differ by at most the slippage itself, and using one base makes
  // multiple 1 with the row's own schedule return the recorded fill EXACTLY.
  const rawEntry = entry - dir * wireCostInt(own.slippageWirePerSide, own.slippageBpsPerSide, entry)
  const rawExit = exit + dir * wireCostInt(own.slippageWirePerSide, own.slippageBpsPerSide, exit)
  const k = Number(multiple)
  const c = costRow(costs)
  const newEntry = rawEntry + dir * wireCostInt(k * c.slippageWirePerSide, k * c.slippageBpsPerSide, entry)
  const newExit = rawExit - dir * wireCostInt(k * c.slippageWirePerSide, k * c.slippageBpsPerSide, exit)
  const gross = dir * (newExit - newEntry)
  const net = gross - (costExact(k * c.commissionWirePerSide, k * c.commissionBpsPerSide, newEntry)
                     + costExact(k * c.commissionWirePerSide, k * c.commissionBpsPerSide, newExit))
  return +(net / stopDistance).toFixed(4)
}

/** Profit factor over R values — null with no losing trade (never Infinity). */
export function profitFactorOf(rs) {
  let win = 0, loss = 0
  for (const r of rs) { if (r > 0) win += r; else loss += -r }
  return loss > 0 ? +(win / loss).toFixed(3) : null
}

/**
 * The cost-sensitivity line (plan §16 item 4): what this portfolio's profit
 * factor would be if every trade had paid 0 ×, 1 × and 2 × the schedule.
 *
 * The class each row is re-priced at comes from the ROW's own `cost_class`
 * when it has one — a fact about that trade — and only otherwise from the
 * keeper's current symbol map. When the two disagree the count is REPORTED
 * (`classDisagreements`), because a symbol id that has been re-mapped between
 * the trade and the read is exactly the case where a silent re-price lies.
 *
 * The 236 closed shadow trades already on record were closed under commission
 * 0 and slippage 0, so their 1 × row is NOT their recorded profit factor — it
 * is what they would have earned had they paid the schedule. That gap is the
 * whole reason this line exists.
 */
export function costSensitivity(rows, schedule, classOfSymbol = () => null, multiples = [0, 1, 2]) {
  const sch = normalizeSchedule(schedule)
  const priced = []
  let unpriceable = 0, viaFallback = 0, viaRow = 0, viaSymbolMap = 0, classDisagreements = 0, costedRows = 0
  for (const t of rows || []) {
    if ((t.reason || '') === 'lost_restart') continue
    const rowClass = rowCostModel(t).class || null
    const mapClass = classOfSymbol(t.symbol_id ?? t.symbolId) || null
    if (rowClass) { viaRow++; if (mapClass && mapClass !== rowClass) classDisagreements++ }
    else if (mapClass) viaSymbolMap++
    if (rowIsCosted(t)) costedRows++
    const costs = costsForClass(sch, rowClass || mapClass)
    if (costs.source !== 'class') viaFallback++
    const at = {}
    let ok = true
    for (const k of multiples) {
      const r = repriceNetR(t, costs, k)
      if (r == null) { ok = false; break }
      at[k] = r
    }
    if (!ok) { unpriceable++; continue }
    priced.push(at)
  }
  const rowsOut = multiples.map(k => {
    const rs = priced.map(p => p[k])
    const netR = rs.reduce((a, b) => a + b, 0)
    return { multiple: k, trades: rs.length, profitFactor: profitFactorOf(rs), netR: +netR.toFixed(4), avgR: rs.length ? +(netR / rs.length).toFixed(4) : null }
  })
  return {
    scheduleHash: scheduleHash(sch),
    fallbackClass: sch.fallbackClass,
    priced: priced.length, unpriceable, viaFallback, viaRow, viaSymbolMap, classDisagreements, costedRows,
    rows: rowsOut,
    note: 'each closed shadow trade re-priced from its recorded fill prices: its own slippage removed, then the schedule applied at the multiple. The class comes from the row\'s own cost_class where it has one, else the keeper\'s current symbol map. 1x is NOT the recorded profit factor for trades closed under a different cost model — it is what they would have earned under this one.',
  }
}

// ---------------------------------------------------------------------------
// §2 PR-2b: the SIZE-AWARE commission path.
//
// Everything above this line is the SIZE-FREE model the shared shadow book is
// charged, and it is unchanged: the book records price units and R, it never
// sees a lot size, and `tick-cost-schedule.test.js` pins every one of its
// numbers by value. Nothing below is reachable from it.
//
// What is below is used ONLY by the account execution simulation
// (services/tick-shadow-accounts.js), which DOES know a lot size — and a lot
// size is exactly what the size-free model's two documented gaps need:
//
//   1. US STOCK has a $0.02 PER SIDE MINIMUM. The config's own
//      `_commissionSource` measures it: flat per-share with no minimum fits
//      57/60 of the owner's charged US-stock deals, WITH the minimum 60/60.
//      The four misses are the four smallest quantities in the sample. The
//      size-free model cannot express it ("it depends on the number of
//      shares, and the shadow book is deliberately size-free"). Here it can.
//   2. FX is really $3.50 PER LOT per side, approximated in the size-free
//      model as 0.35 bps — which is that fee divided by a 100,000-unit lot,
//      exact only for a USD-BASE pair. Measured per pair the same file
//      records GBP-base over-charged ~35% and NZD-base under-charged ~41%.
//      With a lot size in hand the fee is charged as what it is.
//
// The per-share figure is NOT restated here: it is read off the schedule's own
// `stock_us.commissionWirePerSide` (2000 wire units = $0.02 of price), so the
// two paths cannot drift. The two numbers the size-free model has no room for
// — the US minimum and the FX per-lot fee — live in the config's
// `sizedCommission` block, beside the measurements they come from.
//
// EVERY OTHER CLASS keeps the bps-of-notional shape, because for those classes
// that IS the measured shape (HK stock is a genuine rate at 15 bps; index and
// crypto measured a genuine zero; commodity is a narrow-sample placeholder and
// stays one).
// ---------------------------------------------------------------------------

/** cTrader wire units per 1.0 of a symbol's own price (tick_recorder.hpp). */
export const WIRE_PER_PRICE = 100_000

/**
 * The `sizedCommission` block of the repo's schedule file, normalised.
 * A missing or unusable figure comes back `null`, and the caller then falls
 * back to the size-free bps shape and SAYS which it used — an absent
 * measurement is never replaced by a guess.
 */
export function loadSizedCommission(file = TICK_SHADOW_SIM_FILE) {
  let raw = null
  try { raw = JSON.parse(readFileSync(file, 'utf8'))?.sizedCommission ?? null } catch { return { stockUsMinUsdPerSide: null, fxUsdPerLotPerSide: null, source: 'unreadable' } }
  const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  return {
    stockUsMinUsdPerSide: pos(raw?.stock_us?.minUsdPerSide),
    fxUsdPerLotPerSide: pos(raw?.fx?.usdPerLotPerSide),
    source: raw ? 'config' : 'absent',
  }
}

/**
 * The commission ONE SIDE of a position of `lots` costs, in USD.
 *
 * @param {object} classRow  the schedule's row for this class (four terms)
 * @param {string|null} className
 * @param {{priceUsd:number, lots:number, unitsPerLot:number, sized?:object}} ctx
 * @returns {{usd:number, basis:string, note:string|null}}
 *
 * `basis` says which shape was charged, always — a figure whose shape is not
 * on the record is the kind of number this repo has had to withdraw before.
 */
export function sizedCommissionUsdPerSide(classRow, className, { priceUsd, lots, unitsPerLot, sized = null } = {}) {
  const row = costRow(classRow)
  const L = Number(lots), P = Number(priceUsd), U = Number(unitsPerLot)
  if (!(L > 0) || !(P > 0) || !(U > 0)) return { usd: 0, basis: 'unpriceable', note: 'lots, price or units-per-lot missing' }
  const s = sized || { stockUsMinUsdPerSide: null, fxUsdPerLotPerSide: null }

  if (className === 'stock_us') {
    // Per-share fee straight off the schedule's own wire term, so the two
    // paths cannot disagree about what $0.02 is.
    const perShareUsd = row.commissionWirePerSide / WIRE_PER_PRICE
    const shares = L * U
    const raw = perShareUsd * shares
    const min = s.stockUsMinUsdPerSide
    if (min == null) return { usd: raw, basis: 'per_share_no_minimum', note: 'the measured $0.02/side MINIMUM is not configured — this UNDERCHARGES a small position, the direction the size-free model already has' }
    return { usd: Math.max(raw, min), basis: 'per_share_with_minimum', note: raw < min ? 'the per-side minimum bound this side' : null }
  }

  if (className === 'fx' && s.fxUsdPerLotPerSide != null) {
    return { usd: s.fxUsdPerLotPerSide * L, basis: 'per_lot', note: null }
  }

  const notional = P * L * U
  const usd = row.commissionBpsPerSide > 0 ? row.commissionBpsPerSide * notional / 10000 : 0
  return {
    usd,
    basis: row.commissionBpsPerSide > 0 ? 'bps_of_notional' : 'zero',
    note: className === 'fx' ? 'no per-lot figure configured — charged the size-free bps approximation, which over-charges GBP-base and under-charges NZD-base (see the config)' : null,
  }
}

/**
 * Both sides of one round trip, in USD, at `multiple` × the schedule.
 * @returns {{usd:number, entryUsd:number, exitUsd:number, basis:string, note:string|null}}
 */
export function sizedCommissionUsdRoundTrip(classRow, className, { entryUsd, exitUsd, lots, unitsPerLot, sized = null, multiple = 1 } = {}) {
  const k = Number.isFinite(Number(multiple)) ? Number(multiple) : 1
  const a = sizedCommissionUsdPerSide(classRow, className, { priceUsd: entryUsd, lots, unitsPerLot, sized })
  const b = sizedCommissionUsdPerSide(classRow, className, { priceUsd: exitUsd, lots, unitsPerLot, sized })
  return { usd: k * (a.usd + b.usd), entryUsd: k * a.usd, exitUsd: k * b.usd, basis: a.basis, note: a.note || b.note }
}

/**
 * THE HARD RULE, stated once and asserted by test.
 *
 * `rowChargedUnder` answers ONE question: did the book subtract what THIS
 * REPO'S FILE says. It is arithmetic against `agent/config/tick-shadow-sim.json`
 * and it reaches nothing outside this repo. It is NOT, and must never be
 * presented as, evidence that the file matches what the broker actually
 * charges — the commission rows are measured from the owner's statements with
 * two gaps stated in the file itself, and the slippage row is a PLACEHOLDER
 * that nothing in this repo measures.
 */
export const SCHEDULE_MATCH_MEANS = Object.freeze(
  'a charged row proves the book subtracted what agent/config/tick-shadow-sim.json says, and nothing more. It is not evidence that the file matches the broker: the commission rows are measured from the owner\'s statements with the two gaps that file states, and the slippage row is a placeholder no record in this repo measures.'
)
