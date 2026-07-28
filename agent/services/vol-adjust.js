// Vol-gate Layer 2 + 3 — per-tool adjustments and confluence reconciliation.
// docs/volatility-gate-integration-spec.md §3 and §4.
//
// LOG-ONLY. Nothing here changes an order. It computes what it WOULD do and
// hands that back for recording, so the owner's 2-week observation window
// (spec §6.7) measures real decisions against real signals before any of it
// touches capital.
//
// ONE LEVER, NOT TWO — the deliberate deviation from the spec.
//
// §3.1 asks for HIGH vol to BOTH widen the stop by 0.5xATR AND cut size to
// 0.5-0.7. In this system those compound, because sizing is risk-based:
// risk.js derives lots so that (distance to stop x size) is a fixed % of
// equity. Widening a Cup & Handle stop from its existing 1.5xATR
// (cup-handle.js:213) to 2.0xATR therefore ALREADY drops the position to 75%
// on its own. Multiplying by a further 0.5-0.7 lands at 0.375-0.525 of
// intended size — not the 0.5-0.7 the spec asks for.
//
// That is exactly the mistake §4 correctly forbids ACROSS TOOLS ("do NOT
// multiply size ratios ... use min()"), committed instead ACROSS LAYERS. So
// this module moves ONE lever: the stop. Risk-based sizing does the shrinking,
// and the wider stop also does the thing the gate is actually for — surviving
// noise instead of being wicked out of a correct thesis.
//
// `sizeRatio` is therefore always 1 and is still reported, because the spec
// names the field and a reader deserves to see it pinned rather than absent.
// Owner was told (§1874·B) and can flip this to the ratio lever instead; what
// will not ship is both at once.
//
// STOP WIDENING IS EXPRESSED IN PRICE, NOT PIPS. The spec says pips. Pip size
// is per-symbol and getting it wrong is silent and asymmetric, so the widening
// travels as an absolute price distance derived from the symbol's own ATR. The
// DB column keeps its spec name (`stop_loss_expanded_pips`) and holds that
// price distance; renaming a shipped column to win an argument about units
// would be worse.

/** HIGH-vol stop widening, in ATR multiples. Spec §3.1's 0.5. */
export const HIGH_VOL_STOP_ATR = Number(process.env.VOL_GATE_STOP_ATR) || 0.5

/** Thin participation on a fast tape — spec §3.4's highest-risk combination. */
export const THIN_VOLUME_RATIO = Number(process.env.VOL_GATE_THIN_VOL) || 0.7

const base = (notes = '') => ({
  sizeRatio: 1,          // see header — the stop is the only lever moved
  stopWidenPrice: 0,     // absolute price distance to add to the stop
  confirmationCandles: 0,
  deferEntry: false,     // RECORDED, never acted on — see reconcileConfluence
  flags: {},
  notes,
})

const isHigh = (vol) => vol?.regime === 'HIGH'

/**
 * §3.1 Cup & Handle. HIGH vol widens the stop; size is left to risk sizing.
 */
export function adjustCupAndHandle(vol, signal = {}) {
  const atr = Number(signal.atr)
  if (!isHigh(vol)) return base('vol NORMAL/LOW — no adjustment')
  if (!Number.isFinite(atr) || atr <= 0) {
    // No ATR means no basis for a widening. Do nothing and SAY so, rather
    // than substitute a guess — a wrong stop is worse than an unadjusted one.
    return base('HIGH vol but no ATR on the signal — stop left unchanged')
  }
  const a = base(`HIGH vol (pctl ${vol.percentile ?? '?'}) — stop widened by ${HIGH_VOL_STOP_ATR}xATR`)
  a.stopWidenPrice = HIGH_VOL_STOP_ATR * atr
  return a
}

/**
 * §3.2 VWAP. HIGH vol demands a two-candle close beyond the band rather than
 * a single break, because a wide band in a fast tape breaks and re-crosses.
 * The spec also asks for size inverse to band width; that is the second lever
 * again, so it is recorded as a flag and not applied.
 */
export function adjustVWAP(vol, signal = {}) {
  if (!isHigh(vol)) return base('vol NORMAL/LOW — single-candle break sufficient')
  const a = base('HIGH vol — require 2 consecutive closes beyond the band')
  a.confirmationCandles = 2
  const width = Number(signal.bandUpper) - Number(signal.bandLower)
  if (Number.isFinite(width) && width > 0) a.flags.vwapBandWidth = Math.round(width * 1e6) / 1e6
  return a
}

/**
 * §3.3 Fibonacci. The tolerance zone around the level scales with ATR, and in
 * HIGH vol entry additionally waits on volume confirmation from §3.4.
 */
export function adjustFibonacci(vol, signal = {}) {
  const atr = Number(signal.atr)
  const a = base('vol NORMAL/LOW — standard fib tolerance')
  if (Number.isFinite(atr) && atr > 0) a.flags.fibTolerancePrice = 0.3 * atr
  if (!isHigh(vol)) return a
  a.notes = 'HIGH vol — widened fib tolerance, entry pending volume confirmation'
  a.confirmationCandles = 1
  a.flags.needsVolumeConfirmation = true
  return a
}

/**
 * §3.4 Volume profile. The one genuinely new risk idea in the spec: HIGH
 * volatility on THIN participation — price moving fast with nobody trading —
 * is the combination worth flinching at. HIGH vol on HIGH participation is
 * not; that is real repositioning.
 */
export function adjustVolumeProfile(vol, signal = {}) {
  const rel = Number(signal.relativeVolume)
  if (!isHigh(vol)) return base('vol NORMAL/LOW — no volume qualification')
  if (!Number.isFinite(rel)) {
    return base('HIGH vol but relative volume unknown — cannot qualify participation')
  }
  if (rel < THIN_VOLUME_RATIO) {
    const a = base(`HIGH vol on thin participation (relVol ${rel.toFixed(2)}) — the divergence case`)
    a.deferEntry = true
    a.flags.volVolumeDivergence = true
    return a
  }
  return base(`HIGH vol confirmed by participation (relVol ${rel.toFixed(2)}) — treated as real repositioning`)
}

/**
 * §3.5 FVG. Kept deliberately minimal: the geometry exists
 * (indicators.js findFvgZones, fib-strategy.js findFVGs) but no FVG STRATEGY
 * fires signals yet, so there is no gap-creation event to stamp
 * `origin_vol_regime` at. Until PR4 builds that strategy this returns the
 * unknown-origin path the spec itself specifies, rather than pretending to a
 * provenance we do not have.
 */
export function adjustFVG(vol, signal = {}) {
  const origin = signal.originVolRegime || null
  if (!origin) {
    const a = base('FVG origin regime unknown — treated as NORMAL per spec §3.5')
    a.flags.originRegimeUnknown = true
    a.flags.fillTargetPct = 100
    return a
  }
  const a = base(`FVG origin ${origin}`)
  a.flags.fillTargetPct = origin === 'HIGH' ? 50 : 100
  if (isHigh(vol) && origin !== 'HIGH') {
    const atr = Number(signal.atr)
    a.flags.originCurrentDivergence = true
    a.notes = `FVG formed in ${origin} vol but filling in HIGH vol — overshoot risk`
    if (Number.isFinite(atr) && atr > 0) a.stopWidenPrice = HIGH_VOL_STOP_ATR * atr
  }
  return a
}

export const ADJUSTERS = Object.freeze({
  cup_handle: adjustCupAndHandle,
  inv_cup_handle: adjustCupAndHandle,
  vwap_trend: adjustVWAP,
  fib_confluence: adjustFibonacci,
  fib_618_fade: adjustFibonacci,
  vp_value: adjustVolumeProfile,
  va_breakout: adjustVolumeProfile,
  fvg: adjustFVG,
})

/**
 * §4 Confluence reconciliation.
 *
 * The spec's own critical constraint: do NOT multiply size ratios across
 * tools (0.7 x 0.6 x 0.8 compounds to near-nothing). Take the most
 * conservative of each dimension instead — min() on size, max() on the
 * protective stop, any() on confirmation.
 */
export function reconcileConfluence(results = []) {
  const list = results.filter(Boolean)
  if (list.length === 0) return { ...base('no adjusters ran'), toolCount: 0, conflict: false }
  if (list.length === 1) return { ...list[0], toolCount: 1, conflict: false }

  const wantsDefer = list.filter(r => r.deferEntry)
  const wantsFullSpeed = list.filter(r => !r.deferEntry && r.stopWidenPrice === 0 && r.confirmationCandles === 0)
  // Material disagreement: one tool wants to stand down while another sees
  // nothing to adjust at all. Flagged rather than silently averaged, because
  // averaging two opposite readings produces a number neither tool would
  // endorse.
  const conflict = wantsDefer.length > 0 && wantsFullSpeed.length > 0

  const merged = {
    sizeRatio: Math.min(...list.map(r => r.sizeRatio)),
    stopWidenPrice: Math.max(...list.map(r => r.stopWidenPrice)),
    confirmationCandles: Math.max(...list.map(r => r.confirmationCandles)),
    deferEntry: wantsDefer.length > 0,
    flags: Object.assign({}, ...list.map(r => r.flags)),
    notes: list.map(r => r.notes).filter(Boolean).join(' | '),
    toolCount: list.length,
    conflict,
  }
  if (conflict) merged.notes = `CONFLICT: ${merged.notes}`
  return merged
}

/**
 * The whole Layer 1-3 pass for one signal, as a record.
 *
 * `deferEntry` is computed and RECORDED but the returned `mode` is always
 * 'log_only' in this slice: acting on a defer would need a deferred-entry
 * queue this system does not have (staleness, cancel-on-invalidation,
 * reconciliation against pending_orders) — and building one adjacent to the
 * order path is how the 4x duplicate USDIDR incident happened in a
 * neighbouring code path. Recording it tells us how often it would fire,
 * which is the evidence needed to decide whether the queue is worth building.
 */
export function evaluateVolGate(vol, signals = [], { mode = 'log_only' } = {}) {
  const results = []
  for (const s of signals) {
    const fn = ADJUSTERS[s?.strategy]
    if (typeof fn === 'function') results.push(fn(vol, s))
  }
  const merged = reconcileConfluence(results)
  return {
    mode,
    entryVolRegime: vol?.regime ?? null,
    entryVolPercentile: vol?.percentile ?? null,
    insufficientHistory: Boolean(vol?.insufficientHistory),
    characterRegime: vol?.characterRegime ?? null,
    sizeRatio: merged.sizeRatio,
    stopWidenPrice: merged.stopWidenPrice,
    confirmationCandles: merged.confirmationCandles,
    deferEntry: merged.deferEntry,
    volVolumeDivergence: Boolean(merged.flags.volVolumeDivergence),
    confluenceToolCount: merged.toolCount,
    confluenceConflict: merged.conflict,
    notes: merged.notes,
  }
}
