// ---------------------------------------------------------------------------
// agent/lib/lot-size-registry.js — ONE definition of "a lot", from the broker.
//
// THE FINDING (Defensive-Drift audit, 2026-08-06, §5.2 item 6, and the earlier
// note at loop.js:1431). The system holds TWO independent answers to "how many
// units is one lot of this symbol", and they are not required to agree:
//
//   ORDER SIDE      lot-sizing.js reads the symbol's OWN record from the broker
//                   (SYMBOL_BY_ID.lotSize) and sends lots × lotSize.
//   RECONCILE SIDE  reconciler.js divides by contractSize(symbol) — a HARDCODED
//                   TABLE in lib/contracts.js that falls through to 1.
//
// AND THE AUDIT'S OWN DESCRIPTION OF THIS WAS WRONG, so it is corrected here.
// The audit said "two of our own tables disagree about position size", citing
// `trades.volume` 83.14 against a broker holding 5,000 units of 0003.HK. Those
// two numbers are CONSISTENT: `trades.volume` is lots, the broker reports
// units, and 5,000 units ÷ ~60 units-per-lot ≈ 83. Nothing was double-counted
// and no position was mis-sized at ENTRY.
//
// The real defect is narrower and it is on the READ side. `contractSize` has no
// entry for `0003.HK`, so it returns 1 — meaning reconciliation would record an
// ADOPTED 0003.HK position as 5,000 lots instead of ~83. That figure then feeds
// notionalUsd (margin gate) and the profit keeper's scale-out maths, which is
// the same class of failure already documented twice in this repo:
//
//   · FX adopted at raw broker units → ~$700M phantom used margin, every new
//     trade vetoed `insufficient_margin` (reconciler.js:6)
//   · XRPUSD close rejected TRADING_BAD_VOLUME, closeVolume 1,000,000 against a
//     position volume of 10,000 — 100× — because the two conventions disagree
//     for crypto (loop.js:1431)
//
// Both were patched at their own call site. Neither removed the second source
// of truth, so the next symbol whose real lot size is not in the table
// reproduces it. This module removes it: the broker's declaration is recorded
// when an order is placed, and every later interpretation of a broker volume
// reads THAT, falling back to the table only when the broker has never told us
// — and saying which was used.
//
// WHAT THIS DOES NOT DO. It changes no sizing, no threshold, and no order
// volume. The order path already used broker truth and is untouched. This only
// stops the READ path from guessing, and makes the two answers comparable so a
// disagreement is a number on a route rather than a phantom margin figure.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { contractSize } from './contracts.js'

/** symbol → the broker's declared lotSize, in cTrader protocol units. */
export const LOT_SIZE_KEY = 'broker_lot_size_json'

/**
 * cTrader expresses volume in CENTS of units, so protocol lotSize is
 * 100 × units-per-lot. An FX lot: 100,000 units → lotSize 10,000,000.
 */
export const CENTS_PER_UNIT = 100

const clean = (symbol) => String(symbol ?? '').trim().toUpperCase()

function readMap(db) {
  try {
    const raw = getState(db, LOT_SIZE_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch { return {} }
}

/**
 * Record what the broker says one lot of `symbol` is.
 *
 * Called from the order path, which is the only place that already holds the
 * symbol's own record. Idempotent, and a no-op on a value that cannot be a lot
 * size — a bad write here would be worse than no knowledge, because a recorded
 * value OUTRANKS the fallback table.
 *
 * @param {number} lotSize  cTrader protocol lotSize (cents of units per lot)
 * @returns {boolean} whether anything was stored
 */
export function rememberLotSize(db, symbol, lotSize) {
  const s = clean(symbol)
  const n = Number(lotSize)
  if (!s || !Number.isFinite(n) || n <= 0) return false
  try {
    const map = readMap(db)
    if (map[s] === n) return false          // unchanged; skip the write
    map[s] = n
    setState(db, LOT_SIZE_KEY, JSON.stringify(map))
    return true
  } catch { return false }
}

/**
 * How many units make one lot of `symbol`, and where that answer came from.
 *
 * @returns {{unitsPerLot: number, source: 'broker'|'table', lotSize: number|null}}
 *
 *   source 'broker' — the broker's own declaration, recorded at order time
 *   source 'table'  — contractSize(), which is a guess for anything unlisted
 *                     and returns 1 by default
 */
export function unitsPerLot(db, symbol) {
  const s = clean(symbol)
  const map = readMap(db)
  const lotSize = Number(map[s])
  if (Number.isFinite(lotSize) && lotSize > 0) {
    return { unitsPerLot: lotSize / CENTS_PER_UNIT, source: 'broker', lotSize }
  }
  return { unitsPerLot: contractSize(s) || 1, source: 'table', lotSize: null }
}

/**
 * Broker units → lots, using whichever definition of a lot we actually have.
 *
 * @param {number|null} units
 * @returns {{lots: number|null, unitsPerLot: number, source: 'broker'|'table'}}
 */
export function lotsFromUnits(db, symbol, units) {
  const { unitsPerLot: per, source } = unitsPerLot(db, symbol)
  // `Number(null)` is 0 and 0 is finite, so a missing volume would otherwise
  // convert to a confident ZERO LOTS — a position the risk stack would read as
  // costing nothing. Absent is not the same as none. Third occurrence of this
  // trap in one day (#674 sizing-balance, #676 cooldown), hence the note.
  if (units == null || units === '') return { lots: null, unitsPerLot: per, source }
  const u = Number(units)
  if (!Number.isFinite(u)) return { lots: null, unitsPerLot: per, source }
  return { lots: per > 0 ? u / per : u, unitsPerLot: per, source }
}

/**
 * Where do the broker's declaration and the hardcoded table disagree?
 *
 * This is the observability half, and it is the part that answers the question
 * the audit could not: WHICH SIDE IS WRONG. A row here with ratio 60 means the
 * table would read an adopted position as 60× its real size — not a rounding
 * difference, a wrong number in a margin calculation.
 *
 * `disagrees` is deliberately tolerant of nothing: lot sizes are exact integers
 * declared by the broker, so any difference at all is a real difference.
 *
 * @param {string[]|null} symbols  limit to these; null = every recorded symbol
 * @returns {{n: number, disagreeing: number, rows: Array, note: string}}
 */
export function lotSizeParity(db, symbols = null) {
  const map = readMap(db)
  const names = symbols != null
    ? [...new Set(symbols.map(clean).filter(Boolean))]
    : Object.keys(map)

  const rows = names.map((symbol) => {
    const lotSize = Number(map[symbol])
    const known = Number.isFinite(lotSize) && lotSize > 0
    const broker = known ? lotSize / CENTS_PER_UNIT : null
    const table = contractSize(symbol) || 1
    const disagrees = known && broker !== table
    return {
      symbol,
      brokerUnitsPerLot: broker,
      tableUnitsPerLot: table,
      // How wrong the table is, as a multiple. This is the figure that lands in
      // notionalUsd when an adopted position is converted with the table.
      ratio: disagrees && table > 0 ? Math.round((broker / table) * 1000) / 1000 : null,
      disagrees,
      // Nothing recorded means nothing to compare — NOT agreement. The
      // difference matters: "verified identical" and "never checked" print the
      // same `disagrees: false` unless the reason is stated.
      status: known ? (disagrees ? 'disagrees' : 'agrees') : 'broker_unknown',
    }
  })

  const disagreeing = rows.filter(r => r.disagrees).length
  const unknown = rows.filter(r => r.status === 'broker_unknown').length
  return {
    n: rows.length,
    disagreeing,
    unknown,
    rows: rows.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)),
    note: rows.length === 0
      ? 'no broker lot size has been recorded yet — every volume conversion is using the hardcoded contractSize() table'
      : `${disagreeing} of ${rows.length} symbol(s) have a broker lot size that differs from contractSize(); `
        + `${unknown} have never been recorded and still fall back to the table.`,
  }
}
