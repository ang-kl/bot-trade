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
