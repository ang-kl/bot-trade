// FAIR-SHARE ANALYZE SLOTS — why five armed strategies never got a turn.
//
// THE MEASUREMENT (production, 7 days, account 46130058):
//
//   32,290 signals →  741 decisions → 36 opened   fib_confluence
//   20,393 signals →  510 decisions → 16 opened   vwap_trend
//    6,100 signals →   16 decisions →  2 opened   rsi2_reversion
//    2,616 signals →    0 decisions →  0 opened   vp_value
//      874 signals →    0 decisions →  0 opened   donchian_breakout
//       82 / 80 / 16 signals → 0 decisions        ema_pullback, va_breakout, fvg_retrace
//
// Zero DECISIONS means those five never reached the risk gate at all. Nothing
// vetoed them; nobody asked. The analyze phase takes the top 3 symbols per
// cycle (loop.js) ranked by conviction, and conviction is SATURATED — one live
// batch of 50 scans:
//
//   vwap_trend      n=18  avg 9.4   (eight at 10)
//   fib_confluence  n=17  avg 9.2   (nine at 10)
//   rsi2_reversion  n=12  avg 9.0   (all 9)
//   vp_value        n= 3  avg 10.0  (all three at 10)
//
// Ranking by a score that reads 9-or-10 on everything is ranking by nothing:
// the top of the list is a wide tie and slice(0,3) takes whichever sorted
// first, which is scan order. So vp_value — the HIGHEST average conviction of
// any strategy — lost that coin-flip every cycle for a week, because it enters
// it three times less often. It is not being outperformed. It is being
// starved, and starvation is self-sealing: no turns means no record, and no
// record means it can never earn one.
//
// WHAT THIS DOES. Allocate the scarce slots ROUND-ROBIN across the armed
// strategies present in the batch, least-recently-analysed strategy first,
// then fill any remaining slots best-first the old way. Every armed strategy
// gets a turn on a bounded cadence; the loud ones still get most of the slots
// because they appear in most batches.
//
// WHAT THIS IS NOT. It is not a claim that the starved strategies are good —
// nothing here scores a strategy. It is the precondition for finding out.
// docs/go-live-plan.md needs n >= 30 per strategy and five of them are at n=0.
//
// Pure and side-effect free; the caller owns reading and writing the
// last-analysed clock.

/** agent_state key holding `{ [strategyKey]: isoTimestamp }`. */
export const LAST_ANALYZED_KEY = 'strategy_last_analyzed_json'

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0)

/** Epoch ms of a strategy's last analyze slot; 0 (never) sorts first. */
function lastAt(map, key) {
  const raw = map?.[key]
  if (raw == null || raw === '') return 0
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

/**
 * @param {Array<{symbol:string, confidence?:number, strategy?:string}>} scans
 * @param {string[]} hotSymbols          already filtered as hot
 * @param {{
 *   slots?: number,
 *   lastAnalyzed?: Record<string,string>,
 *   provenEdgeSymbols?: Set<string>,
 * }} [opts]
 * @returns {{ picked: string[], byStrategy: Array<{strategy:string, symbol:string, conviction:number, waitedMs:number|null}> }}
 */
export function fairShareSlots(scans, hotSymbols, {
  slots = 3, lastAnalyzed = {}, provenEdgeSymbols = new Set(), now = Date.now(),
} = {}) {
  const cap = Math.max(0, Math.trunc(Number(slots)) || 0)
  const byName = new Map((scans || []).map(s => [s.symbol, s]))
  const hot = [...new Set(hotSymbols || [])].filter(sym => byName.has(sym))
  if (cap === 0 || hot.length === 0) return { picked: [], byStrategy: [] }

  const conv = (sym) => num(byName.get(sym)?.confidence)
  const proven = (sym) => (provenEdgeSymbols.has(sym) ? 1 : 0)
  // A scan with no strategy label is not nobody's — it is its own bucket, so
  // it competes for a turn rather than silently joining another strategy's.
  const stratOf = (sym) => byName.get(sym)?.strategy || '(unlabelled)'

  // Best candidate per strategy, by the existing rule.
  const best = new Map()
  for (const sym of hot) {
    const key = stratOf(sym)
    const cur = best.get(key)
    if (!cur) { best.set(key, sym); continue }
    if (conv(sym) > conv(cur)) { best.set(key, sym); continue }
    if (conv(sym) === conv(cur) && proven(sym) > proven(cur)) { best.set(key, sym); continue }
    if (conv(sym) === conv(cur) && proven(sym) === proven(cur)
      && String(sym).localeCompare(String(cur)) < 0) best.set(key, sym)
  }

  // Round one: one slot per strategy, hungriest first. A strategy that has
  // NEVER been analysed sorts to the very front (lastAt 0), which is the whole
  // point — it is the only way n=0 ever becomes n=1.
  const strategies = [...best.keys()].sort((a, b) => {
    const la = lastAt(lastAnalyzed, a)
    const lb = lastAt(lastAnalyzed, b)
    if (la !== lb) return la - lb
    // Same wait (usually both never): the stronger candidate goes first, so a
    // cold start is still best-first rather than alphabetical.
    const ca = conv(best.get(a)); const cb = conv(best.get(b))
    if (cb !== ca) return cb - ca
    return String(a).localeCompare(String(b))
  })

  const picked = []
  const byStrategy = []
  for (const key of strategies) {
    if (picked.length >= cap) break
    const sym = best.get(key)
    picked.push(sym)
    const la = lastAt(lastAnalyzed, key)
    byStrategy.push({
      strategy: key,
      symbol: sym,
      conviction: conv(sym),
      // null, not 0, when the strategy has never had a turn — "never" is not
      // "waited zero milliseconds", and a chart that averaged those together
      // would hide exactly the case this exists for.
      waitedMs: la === 0 ? null : Math.max(0, now - la),
    })
  }

  // Remaining slots: best-first over whatever is left, unchanged behaviour.
  if (picked.length < cap) {
    const taken = new Set(picked)
    const rest = hot.filter(s => !taken.has(s)).sort((a, b) => {
      if (conv(b) !== conv(a)) return conv(b) - conv(a)
      if (proven(b) !== proven(a)) return proven(b) - proven(a)
      return String(a).localeCompare(String(b))
    })
    for (const sym of rest) {
      if (picked.length >= cap) break
      picked.push(sym)
    }
  }

  return { picked, byStrategy }
}

/**
 * Stamp the strategies that just received a slot. Returns the NEW map rather
 * than mutating, so the caller decides when it is durable.
 */
export function markAnalyzed(lastAnalyzed, strategies, nowIso = new Date().toISOString()) {
  const out = { ...(lastAnalyzed || {}) }
  for (const k of strategies || []) if (k) out[k] = nowIso
  return out
}

/**
 * Armed strategies that have not had an analyze slot in `staleMin` minutes —
 * the starvation alarm. A strategy that has NEVER had one is included with
 * `waitedMin: null`, because that is the loudest case and an alarm that could
 * only fire on a stale timestamp would never fire for it at all.
 */
export function starvedStrategies(lastAnalyzed, armedKeys, { staleMin = 240, now = Date.now() } = {}) {
  const out = []
  for (const key of armedKeys || []) {
    const la = lastAt(lastAnalyzed, key)
    if (la === 0) { out.push({ strategy: key, waitedMin: null, never: true }); continue }
    const mins = Math.round((now - la) / 60_000)
    if (mins >= staleMin) out.push({ strategy: key, waitedMin: mins, never: false })
  }
  return out.sort((a, b) => {
    if (a.never !== b.never) return a.never ? -1 : 1
    // Two never-cases have no wait to compare, and leaving them in armedKeys
    // order would make the alarm's output depend on registry order — the same
    // arbitrary tie-break this module exists to remove. Name-ordered instead.
    if (a.never) return String(a.strategy).localeCompare(String(b.strategy))
    return (b.waitedMin || 0) - (a.waitedMin || 0)
  })
}

/** One line for the loop log. */
export function fairShareLine(res) {
  if (!res?.byStrategy?.length) return null
  return res.byStrategy
    .map(b => `${b.strategy}:${b.symbol}(${b.conviction}${b.waitedMs == null ? ', first turn' : `, waited ${Math.round(b.waitedMs / 60_000)}m`})`)
    .join(' · ')
}
