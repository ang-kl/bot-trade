// ---------------------------------------------------------------------------
// agent/scripts/audit-strategy-invariants.mjs — READ-ONLY audit tool.
//
// Written for the Algorithmic Decision Integrity audit (instr/
// Bot-Trade_Algorithmic_Decision_Integrity_Audit_Prompt_v1.0.md §7.1).
//
// Places no order, opens no socket, touches no DB. It imports the registry and
// drives every compute function over deterministic synthetic series.
//
// The load-bearing check is H02. strategies.js loads 8 of its 12 computes
// through `loadCompute`, which returns `() => null` when the module is missing
// or throws at import. A dead strategy is then INDISTINGUISHABLE at runtime
// from one that simply has no setup today — the process stays healthy, the
// registry stays complete, and the scan reports "no signal". This script
// separates the two by identity: `compute.name === ''` and the function body
// being the null literal is what a dead entry looks like.
//
//   node agent/scripts/audit-strategy-invariants.mjs
//
// Exit 0 always — this is an evidence generator, not a gate. JSON on stdout.
// ---------------------------------------------------------------------------

import { STRATEGY_REGISTRY } from '../services/strategies.js'

const out = { generatedFrom: 'audit-strategy-invariants.mjs', strategies: [], summary: {} }

// --- deterministic series builders -----------------------------------------
// Every series is a pure function of its length: no clock, no RNG, so a rerun
// on any machine produces byte-identical evidence.
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v })

const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => bar(i * 60000, p, p, p, p))
const rise = (n, p = 100, step = 0.1) =>
  Array.from({ length: n }, (_, i) => { const c = p + i * step; return bar(i * 60000, c - step / 2, c + step / 4, c - step, c) })
const fall = (n, p = 100, step = 0.1) =>
  Array.from({ length: n }, (_, i) => { const c = p - i * step; return bar(i * 60000, c + step / 2, c + step, c - step / 4, c) })
const zeroRange = (n, p = 100) => Array.from({ length: n }, (_, i) => bar(i * 60000, p, p, p, p, 0))
const sawtooth = (n, p = 100, amp = 2) =>
  Array.from({ length: n }, (_, i) => { const c = p + (i % 2 ? amp : -amp); return bar(i * 60000, c, c + amp / 2, c - amp / 2, c) })

// Adversarial mutations of a healthy series.
const withDuplicateBars = (b) => [...b.slice(0, -1), b[b.length - 1], b[b.length - 1]]
const withOutOfOrderTs = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 3) { const t = c[1].t; c[1].t = c[2].t; c[2].t = t } return c }
const withMissingInterval = (b) => b.filter((_, i) => i !== Math.floor(b.length / 2))
const withNaN = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 2) c[c.length - 2].c = NaN; return c }
const withNull = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 2) c[c.length - 2].l = null; return c }
const withInfinity = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 2) c[c.length - 2].h = Infinity; return c }
const withImpossibleOhlc = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 2) { const x = c[c.length - 2]; x.h = x.l - 10 } return c }
const withZeroVolume = (b) => b.map(x => ({ ...x, v: 0 }))
const withGiantWick = (b) => { const c = b.map(x => ({ ...x })); if (c.length > 2) { const x = c[c.length - 2]; x.l = x.l - 500; x.h = x.h + 500 } return c }
const withPriceScaleChange = (b) => b.map((x, i) => i > b.length / 2
  ? { ...x, o: x.o * 100, h: x.h * 100, l: x.l * 100, c: x.c * 100 } : x)

// POSITIVE CONTROLS. Without at least one series that DOES produce a signal,
// "returned null on every degenerate input" is indistinguishable from "this
// function cannot signal at all" — which is precisely the H02 failure the rest
// of this script exists to detect. A strategy with no positive control here is
// reported as UNPROVEN-BY-THIS-HARNESS, not as passing.
const volSpike = (b, x = 3) => b.map((y, i) => i === b.length - 1 ? { ...y, v: y.v * x } : y)
// Breakout: a quiet range, then one decisive bar out of it on heavy volume.
const breakoutUp = (n) => {
  const base = sawtooth(n + 20, 100, 1)
  const hi = Math.max(...base.slice(-21, -1).map(b => b.h))
  const c = hi + 0.4
  return volSpike([...base.slice(0, -1), bar(base.length * 60000, hi, c + 0.05, hi - 0.05, c)])
}
const breakoutDown = (n) => {
  const base = sawtooth(n + 20, 100, 1)
  const lo = Math.min(...base.slice(-21, -1).map(b => b.l))
  const c = lo - 0.4
  return volSpike([...base.slice(0, -1), bar(base.length * 60000, lo, lo + 0.05, c - 0.05, c)])
}
// Mean reversion: a sharp drop then a bounce bar — crosses RSI up through 30.
const dipThenBounce = (n, drop = 6, bounce = 8) => {
  const lead = flat(n, 100)
  const down = Array.from({ length: drop }, (_, i) => { const c = 100 - (i + 1) * 1.2; return bar((n + i) * 60000, c + 1.2, c + 1.3, c - 0.2, c) })
  const last = down[down.length - 1].c
  const up = Array.from({ length: bounce }, (_, i) => { const c = last + (i + 1) * 0.5; return bar((n + drop + i) * 60000, c - 0.5, c + 0.1, c - 0.6, c) })
  return [...lead, ...down, ...up]
}
const POSITIVE = (n) => [
  ['pos_breakout_up', breakoutUp(n)],
  ['pos_breakout_down', breakoutDown(n)],
  ['pos_dip_then_bounce', dipThenBounce(n)],
  ['pos_rise_volspike', volSpike(rise(n + 20), 4)],
  ['pos_fall_volspike', volSpike(fall(n + 20), 4)],
]

const CASES = (n) => [
  ['insufficient_history', []],
  ['one_bar', flat(1)],
  ['minus_one_bar', flat(Math.max(0, n - 1))],
  ['exactly_min_history', flat(n)],
  ['flat_prices', flat(n + 20)],
  ['monotonic_rise', rise(n + 20)],
  ['monotonic_fall', fall(n + 20)],
  ['zero_range_bars', zeroRange(n + 20)],
  ['sawtooth', sawtooth(n + 20)],
  ['duplicated_bars', withDuplicateBars(rise(n + 20))],
  ['out_of_order_timestamps', withOutOfOrderTs(rise(n + 20))],
  ['missing_interval', withMissingInterval(rise(n + 20))],
  ['nan_close', withNaN(rise(n + 20))],
  ['null_low', withNull(rise(n + 20))],
  ['infinite_high', withInfinity(rise(n + 20))],
  ['impossible_ohlc', withImpossibleOhlc(rise(n + 20))],
  ['zero_volume', withZeroVolume(rise(n + 20))],
  ['giant_wick', withGiantWick(rise(n + 20))],
  ['price_scale_change', withPriceScaleChange(rise(n + 20))],
]

/** A signal object with a finite entry/stop/target, or a description of why not. */
function classify(sig) {
  if (sig == null) return { kind: 'null' }
  if (typeof sig !== 'object') return { kind: 'non_object', value: String(sig) }
  const nums = ['entry', 'stop', 'target', 'sl', 'tp', 'stopLoss', 'takeProfit']
    .filter(k => sig[k] !== undefined)
    .map(k => [k, Number(sig[k])])
  const bad = nums.filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)
  return { kind: 'signal', dir: sig.dir ?? sig.side ?? sig.direction ?? null, nonFiniteFields: bad }
}

for (const s of STRATEGY_REGISTRY) {
  const fn = s.compute
  // H02 — is this a real compute or the registry's null placeholder?
  const src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''
  const isNullPlaceholder = /^\(\)\s*=>\s*null$/.test(src.trim())

  const rec = {
    key: s.key,
    name: s.name,
    defaultOn: s.defaultOn,
    pendingCapable: s.pendingCapable,
    registryMinBars: s.minBars,
    computeName: typeof fn === 'function' ? fn.name : null,
    liveOrDead: isNullPlaceholder ? 'DEAD — registry null placeholder' : 'live module',
    minBarsStampedOnFn: fn?.minBars ?? null,
    cases: [],
  }

  for (const [label, bars] of [...CASES(s.minBars), ...POSITIVE(s.minBars)]) {
    let r
    try {
      const sig = fn(bars)
      r = { case: label, bars: bars.length, threw: false, ...classify(sig) }
    } catch (e) {
      // A THROW is a distinct and important disposition: the scan loop's
      // try/catch would turn it into "no signal" for that symbol, which is the
      // §17 "silent unknown" failure state.
      r = { case: label, bars: bars.length, threw: true, error: String(e?.message || e).slice(0, 160) }
    }
    rec.cases.push(r)
  }

  // Future-bar invariance: a decision made at time t must not change when
  // later bars are appended. This is the look-ahead test that matters most,
  // because a violation invalidates every backtest number the strategy has.
  try {
    const base = rise(s.minBars + 20)
    const a = fn(base)
    const b = fn([...base, ...rise(10, base[base.length - 1].c + 0.1)])
    // Compare only the decision made at the END of `base`, which is what a
    // live scan would have seen. If appending future bars changes the SHAPE of
    // the answer for the same prefix, the function is reading ahead.
    const aPrefix = fn(base.slice())
    rec.futureBarInvariance = {
      sameForIdenticalInput: JSON.stringify(a) === JSON.stringify(aPrefix),
      note: 'appending later bars legitimately changes the CURRENT decision; this only asserts determinism on identical input',
      appendedDiffered: JSON.stringify(a) !== JSON.stringify(b),
    }
  } catch (e) {
    rec.futureBarInvariance = { error: String(e?.message || e).slice(0, 160) }
  }

  // Long/short symmetry: mirror the series about its mean and see whether a
  // strategy whose thesis is symmetric answers symmetrically.
  try {
    const up = rise(s.minBars + 20)
    const mid = up[0].c
    const mirrored = up.map(x => bar(x.t, 2 * mid - x.o, 2 * mid - x.l, 2 * mid - x.h, 2 * mid - x.c, x.v))
    const a = classify(fn(up))
    const b = classify(fn(mirrored))
    rec.symmetry = { onRise: a.kind === 'signal' ? (a.dir ?? 'signal') : a.kind, onMirroredFall: b.kind === 'signal' ? (b.dir ?? 'signal') : b.kind }
  } catch (e) {
    rec.symmetry = { error: String(e?.message || e).slice(0, 160) }
  }

  out.strategies.push(rec)
}

out.summary = {
  total: out.strategies.length,
  dead: out.strategies.filter(s => s.liveOrDead.startsWith('DEAD')).map(s => s.key),
  threwOnAnyCase: out.strategies.filter(s => s.cases.some(c => c.threw)).map(s => s.key),
  signalledOnFlatPrices: out.strategies.filter(s => s.cases.find(c => c.case === 'flat_prices')?.kind === 'signal').map(s => s.key),
  signalledOnZeroRange: out.strategies.filter(s => s.cases.find(c => c.case === 'zero_range_bars')?.kind === 'signal').map(s => s.key),
  signalledBelowMinBars: out.strategies.filter(s => s.cases.find(c => c.case === 'minus_one_bar')?.kind === 'signal').map(s => s.key),
  // The harness's own validity check.
  noPositiveControl: out.strategies
    .filter(s => !s.cases.some(c => c.case.startsWith('pos_') && c.kind === 'signal'))
    .map(s => s.key),
  producedNonFiniteLevels: out.strategies.filter(s => s.cases.some(c => c.nonFiniteFields?.length)).map(s => s.key),
  minBarsStampMissing: out.strategies.filter(s => s.minBarsStampedOnFn !== s.registryMinBars).map(s => s.key),
}

console.log(JSON.stringify(out, null, 2))
