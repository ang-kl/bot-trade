// ---------------------------------------------------------------------------
// agent/lib/bar-crosscheck.js — compare bars WE built from recorded ticks
// with the bars the BROKER serves for the same minutes. Claude · № 13,096
// 11-Oct (ordered № 13,093; claude-builder), plan step 9.
//
// Pure. Both inputs are ascending { t, o, h, l, c, v } lists with `t` the
// minute start (epoch ms). The report says, per aligned minute, how far our
// OHLC sits from the broker's (in price units and in the broker's own
// range), how our changed-quote count compares with the broker's "volume
// in ticks", and which minutes exist on one side only. It does not say
// which side is right: the broker's tick definition is undocumented, our
// receive-time bucketing is not the broker's clock, so parity is MEASURED,
// never assumed. Research only.
// ---------------------------------------------------------------------------
import { DONCHIAN_VOL_X, DONCHIAN_CHANNEL } from '../services/donchian-breakout.js'

const fin = v => typeof v === 'number' && Number.isFinite(v)
const round = (n, d = 6) => (fin(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** Compare one symbol's minute bars. `tolerance` is the price distance that counts as a match (e.g. one spread). */
export function crossCheckBars(ours, brokers, { tolerance = null } = {}) {
  const mine = new Map((ours || []).filter(b => fin(b?.t)).map(b => [b.t, b]))
  const theirs = new Map((brokers || []).filter(b => fin(b?.t)).map(b => [b.t, b]))
  const aligned = [], onlyOurs = [], onlyBroker = []
  for (const t of mine.keys()) if (!theirs.has(t)) onlyOurs.push(t)
  for (const t of theirs.keys()) if (!mine.has(t)) onlyBroker.push(t)
  const diffs = { o: [], h: [], l: [], c: [] }, rangeRel = [], volRatio = [], closeMatch = []
  for (const [t, b] of theirs) {
    const m = mine.get(t); if (!m) continue
    const range = b.h - b.l
    const d = { t, o: m.o - b.o, h: m.h - b.h, l: m.l - b.l, c: m.c - b.c, ourV: m.v ?? null, brokerV: b.v ?? null }
    for (const k of ['o', 'h', 'l', 'c']) diffs[k].push(Math.abs(d[k]))
    const worst = Math.max(Math.abs(d.o), Math.abs(d.h), Math.abs(d.l), Math.abs(d.c))
    if (range > 0) rangeRel.push(worst / range)
    if (fin(m.v) && fin(b.v) && b.v > 0) volRatio.push(m.v / b.v)
    if (tolerance != null) closeMatch.push(Math.abs(d.c) <= tolerance)
    aligned.push(d)
  }
  const stat = xs => ({ n: xs.length, median: round(median(xs)), max: xs.length ? round(Math.max(...xs)) : null, mean: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null })
  const span = () => { const ts = [...mine.keys(), ...theirs.keys()]; return ts.length ? { fromMs: Math.min(...ts), toMs: Math.max(...ts) } : { fromMs: null, toMs: null } }
  return {
    ours: mine.size, broker: theirs.size, aligned: aligned.length,
    onlyOurs: onlyOurs.length, onlyBroker: onlyBroker.length,
    onlyOursSample: onlyOurs.sort((a, b) => a - b).slice(0, 10), onlyBrokerSample: onlyBroker.sort((a, b) => a - b).slice(0, 10),
    absDiff: { o: stat(diffs.o), h: stat(diffs.h), l: stat(diffs.l), c: stat(diffs.c) },
    worstDiffOverBrokerRange: stat(rangeRel),
    volumeRatioOursOverBroker: stat(volRatio),
    closeWithinTolerance: tolerance != null && closeMatch.length ? { tolerance, n: closeMatch.length, sharePct: round(closeMatch.filter(Boolean).length / closeMatch.length * 100, 1) } : null,
    ...span(),
    note: 'Our bars: bid, receive-time buckets, v = changed quotes. Broker bars: cTrader M1 trendbars, v = "volume in ticks" (its tick definition undocumented). A difference is measured, not attributed; neither side is the reference.',
  }
}

/**
 * Amendment area 2: the Donchian volume rule on BOTH series over the aligned
 * minutes — our changed-quote count against the broker's tick volume, each
 * as the bar's v over the prior `channel` bars' average, and the gate's
 * decision (ratio ≥ volX) on each side. Agreement is measured per minute;
 * the ratio tolerance is predeclared (research.json), the decision compared
 * exactly. A minute is comparable only when both series have the full
 * prior window aligned.
 */
export function donchianVolumeAgreement(ours, brokers, { channel = DONCHIAN_CHANNEL, volX = DONCHIAN_VOL_X, ratioTolerance = null } = {}) {
  const mine = new Map((ours || []).filter(b => fin(b?.t)).map(b => [b.t, b]))
  const theirs = new Map((brokers || []).filter(b => fin(b?.t)).map(b => [b.t, b]))
  const ts = [...theirs.keys()].filter(t => mine.has(t)).sort((a, b) => a - b)
  const rows = []
  for (let i = channel; i < ts.length; i++) {
    const win = ts.slice(i - channel, i)
    if (win.some((t, k) => k > 0 && t - win[k - 1] !== 60_000) || ts[i] - win[channel - 1] !== 60_000) continue // the window must be contiguous minutes
    const myAvg = win.reduce((a, t) => a + (mine.get(t).v ?? 0), 0) / channel
    const brAvg = win.reduce((a, t) => a + (theirs.get(t).v ?? 0), 0) / channel
    const myRatio = myAvg > 0 ? (mine.get(ts[i]).v ?? 0) / myAvg : null
    const brRatio = brAvg > 0 ? (theirs.get(ts[i]).v ?? 0) / brAvg : null
    if (myRatio == null || brRatio == null) continue
    rows.push({ t: ts[i], ours: round(myRatio, 4), broker: round(brRatio, 4), diff: round(myRatio - brRatio, 4), oursPass: myRatio >= volX, brokerPass: brRatio >= volX })
  }
  const agree = rows.filter(r => r.oursPass === r.brokerPass).length
  const within = ratioTolerance == null ? null : rows.filter(r => Math.abs(r.diff) <= ratioTolerance).length
  const diffs = rows.map(r => Math.abs(r.diff))
  return {
    rule: { channel, volX, source: 'agent/services/donchian-breakout.js' },
    comparable: rows.length,
    decisionAgree: agree, decisionAgreePct: rows.length ? round(agree / rows.length * 100, 1) : null,
    oursPass: rows.filter(r => r.oursPass).length, brokerPass: rows.filter(r => r.brokerPass).length,
    ratioAbsDiff: { median: round(median(diffs), 4), max: diffs.length ? round(Math.max(...diffs), 4) : null },
    ratioWithinTolerance: ratioTolerance == null ? null : { tolerance: ratioTolerance, n: rows.length, sharePct: rows.length ? round(within / rows.length * 100, 1) : null },
    disagreements: rows.filter(r => r.oursPass !== r.brokerPass).slice(0, 20),
    note: 'parity is measured, not assumed: a constant multiplier cancels in the ratio, filtering or dropped events need not. Until decisionAgreePct is high over a declared window, the tick-built Donchian is a research variant, not the broker-bar strategy.',
  }
}
