// Trade Cockpit — data layer.
// This is a deterministic port of the reference Component.renderVals() from
// design_handoff_trading_dashboard/Canvas.dc.html (the canonical file): same
// constants, same math, same strings. It stands behind the §8 data-contract
// shape so the mock can later be swapped for GET /api/positions/:id/cockpit +
// WebSocket without touching the components (open question in the PR: the
// agent has no cockpit endpoints yet — front-end + mock adapter was built,
// per the recorded question to the owner).
//
// `store` replaces the reference's `this` — a plain object owned by the modal
// instance so histories/extrema survive re-renders but die with the cockpit.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
// The reference instrument is a 2-decimal HK equity, so it hard-coded 2dp.
// A real position may be FX (1.24505) or an index, where 2dp would silently
// round the price, the rails and the tape into nonsense. Same buckets as
// lib/std-trade-rows.js priceDp so the cockpit agrees with the tables.
const dpFor = v => { const a = Math.abs(Number(v)); return !Number.isFinite(a) ? 2 : a >= 10000 ? 0 : a >= 100 ? 2 : 4 }

// PRICE·R tape de-overlap.
//
// Two defects, one visible symptom (measured: 3-6 pairs of adjacent labels
// overlapping by 2-3px).
//
//  1. The neighbour filter never fired. It was written as
//       .filter((tk, i, arr) => i === 0 || tk.top - arr[i - 1].top >= 11)
//     but Array.prototype.filter hands the callback the ORIGINAL array, not
//     the accumulating result — so `arr[i - 1]` was always the pre-filter
//     neighbour, which is 11.5 apart by construction and therefore always
//     passed. Dropping a tick next to a rail could never make its neighbours
//     re-check their spacing. A running last-KEPT value is the fix.
//
//  2. The thresholds were below the label's own height. `top` is a percentage
//     of the tape, but overlap is a pixel fact: at the shortest tape the
//     variants render, 11.5% is about 12px while a 10.5px numeric row occupies
//     roughly 13px. Two labels 11.5% apart therefore touch. MIN_GAP is set
//     above the label's share of the shortest tape, so the guarantee holds on
//     the small variants too — at the cost of showing fewer ticks there, which
//     is the right trade: an unreadable label is worse than an absent one.
const TAPE_MIN_GAP = 13

/**
 * Keep ticks that clear both the rails and each other by TAPE_MIN_GAP.
 * Pure and exported so the spacing guarantee is a test, not an eyeball.
 *
 * @param {Array<{top:number}>} ticks   candidate ticks, ascending by `top`
 * @param {number[]} rails              rail label positions to clear
 */
export function thinTicks(ticks, rails = [], minGap = TAPE_MIN_GAP) {
  const kept = []
  for (const tk of ticks || []) {
    if (rails.some(b => Math.abs(tk.top - b) < minGap)) continue
    const prev = kept[kept.length - 1]
    if (prev && tk.top - prev.top < minGap) continue
    kept.push(tk)
  }
  return kept
}

export function cockpitFrame(store, tick, opts = {}) {
  // session axis (task-prompt §8 — see PR open questions): 'open'|'pre'|'post'|'closed'|'halted'
  const session = opts.session || { state: 'open', exchange: 'HKEX', opensInMins: null }
  const marketClosed = session.state !== 'open'
  // position axis (symbol-click-spec §5): 'open'|'closed' → review mode
  const review = (opts.positionState || 'open') === 'closed'
  const w = t => Math.sin(tick * .5 + t) * .5 + Math.sin(tick * .17 + t * 2) * .5
  // `real` carries broker facts from the clicked position (symbol, side, lots,
  // entry/SL/TP, live price, live P&L, strategy). Everything derived from those
  // — R scale, the TP/ENT/SL rails, the outcome strip, position economics — is
  // then real too. Fields the agent does not serve yet (bar history, RVOL,
  // spread, latency, correlated traffic, tweak journal, MFE/MAE) stay on the
  // reference generator and are flagged `demoPanels` so the UI can say so.
  const real = opts.real || null
  // PHASE 8 (cockpit live-wiring prompt): the FULL contract snapshot rides on
  // real.snapshot when the opener fetched GET /state/position/:id/cockpit.
  // Sections it covers (correlation traffic, MARKET SAYS, armed actions,
  // invalidation, advisories, RVOL/spread/latency, WX) replace their demo
  // generators below; a bound snapshot with a missing/unknown section shows
  // '—'/unknown honestly, never the demo number.
  const snap = real && real.snapshot && real.snapshot.meta ? real.snapshot : null
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const rEntry = real ? num(real.entry) : null
  const rSl = real ? num(real.sl) : null
  const rTp = real ? num(real.tp) : null
  const rPrice = real ? num(real.price) : null
  const haveRails = rEntry != null && rSl != null && rTp != null && rEntry !== rSl
  const entry = haveRails ? rEntry : 76.85
  const tp = haveRails ? rTp : 79.4
  const sl = haveRails ? rSl : 75.2
  const dp = real ? dpFor(rPrice != null ? rPrice : entry) : 2
  const f2 = n => Number(n).toFixed(dp)
  const short = real ? String(real.side || '').toUpperCase() === 'SHORT' : false
  // R is signed by direction: for a short, price falling below entry is profit.
  const rUnit = haveRails ? Math.abs(entry - sl) : entry - sl
  const dir = short ? -1 : 1
  // Every absolute price offset below was authored against the reference
  // instrument's 1.65 risk unit (76.85 entry / 75.20 stop). K restates those
  // offsets in the bound instrument's own risk unit, so an FX pair with a
  // 0.0100 stop distance gets the same LAYOUT rather than rails pushed
  // hundreds of R off-canvas.
  const K = haveRails ? rUnit / 1.65 : 1
  // closed market: every value is the last trade — freeze the wave at the last live tick
  const frozenTick = store.frozenTick ?? tick
  if (marketClosed && store.frozenTick == null) store.frozenTick = tick
  if (!marketClosed) store.frozenTick = null
  const wv = marketClosed ? (t => Math.sin(frozenTick * .5 + t) * .5 + Math.sin(frozenTick * .17 + t * 2) * .5) : w
  // A real live price does not wobble on a mock wave — it is the broker's last
  // computed value, so it stays put until the next fetch replaces it.
  const price = rPrice != null ? rPrice : 77.29 + wv(0) * .12
  const rNow = (price - entry) * dir / rUnit
  const rPnl = real ? num(real.pnl) : null
  const pnlUsd = rPnl != null ? rPnl : (price - entry) * 1092 * 10 / 7.8
  const spd = wv(1) * 1.6 + .5
  const vsi = rNow * .7 + wv(2) * .35
  const hdgV = clamp(wv(3) * 55 + 18, -100, 100)
  const spdTicks = [2, 1, 0, -1, -2].map((v, i) => ({ v: (v >= 0 ? '+' : '') + (v + Math.round(spd)), top: 24 + i * 16 }))
  // Tick spacing follows the instrument's own risk unit, not a fixed 0.10 —
  // on FX a 0.10 step would put every tick far outside the visible band.
  const tickStep = rUnit / 3
  const tickOffs = [3, 2, 1, 0, -1, -2, -3].map(k => k * tickStep)
  const altTicksAll = tickOffs.map((d, i) => ({ v: f2(price + d), r: (((price + d - entry) * dir / rUnit >= 0 ? '+' : '') + ((price + d - entry) * dir / rUnit).toFixed(1)), top: 22 + i * 11.5 }))
  const span = .42 * K
  const pos = p => 50 - (p - price) / span * 50
  // R is signed by trade direction, so on a SHORT the TP (below entry) reads
  // +R and the SL (above entry) reads −R.
  const rAt = p => (p - entry) * dir / rUnit
  const rOf = p => (rAt(p) >= 0 ? '+' : '') + rAt(p).toFixed(2) + 'R'
  const mk = (p, name) => { const raw = pos(p); const tag = name + ' ' + rOf(p); if (raw < 22) return { t: 22, lb: tag + ' ▲', off: true }; if (raw > 82) return { t: name === 'SL' ? 95 : 84, lb: tag + ' ▼', off: true }; return { t: raw, lb: tag, off: false } }
  const mTP = mk(tp, 'TP'), mEN = mk(entry, 'ENT'), mSL = mk(sl, 'SL')
  const bands = [mTP, mEN, mSL].map(m => m.t)
  const altTicks = thinTicks(altTicksAll, bands)
  const hdgTicks = [[-100, 'BEAR'], [-75, ''], [-50, 'weak'], [-25, ''], [0, 'CHOP'], [25, ''], [50, 'weak'], [75, ''], [100, 'BULL']].map(([v, lb], i) => ({ v: lb || '·', left: 10 + i * 10, col: v < 0 ? 'var(--dn)' : v > 0 ? 'var(--up)' : 'var(--sb)' }))
  if (!store.hist2) {
    let s2 = 991
    const rnd2 = () => { s2 = s2 + 0x6D2B79F5 | 0; let t = Math.imul(s2 ^ s2 >>> 15, 1 | s2); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
    const N = 44, pts = []
    let p = entry
    for (let i = 0; i < N; i++) { p += (tp - entry) / N * .5 + (rnd2() - .5) * .13 * K; pts.push(p) }
    store.hist2 = pts
    store.tweaks = [
      { i: 10, k: 'SL → breakeven', when: '23/07 14:20', d: 'trailing rule after +0.8R', col: 'var(--wrn)' },
      { i: 24, k: 'Scale-out 50%', when: '24/07 03:05', d: 'coded rule §2.4 at +1R', col: 'var(--acc)' },
      { i: 35, k: 'Trail tightened', when: '24/07 19:40', d: '0.5R gap armed after RVOL spike', col: 'var(--vio)' },
      { i: 42, k: 'TP reaffirmed', when: '25/07 06:10', d: 'quadrant Q1 holding · no change to plan', col: 'var(--sb)' },
      { i: 15, k: 'Lot trimmed 20%', when: '23/07 21:45', d: 'correlation cap — HSI exposure at 78%', col: 'var(--wrn)' },
      { i: 30, k: 'TP extended', when: '24/07 11:20', d: 'RVOL 1.9× · target 79.10 → 79.40', col: 'var(--acc)' }]
    store.tweaks.sort((a, b) => a.i - b.i)
  }
  if (!store.hist) store.hist = []
  if (!marketClosed && (store.hist.length === 0 || store.hist[store.hist.length - 1].tick !== tick)) {
    store.hist.push({ tick, p: price }); if (store.hist.length > 8) store.hist.shift()
  }
  // Reference band: entry−0.75 … entry+2.75 (i.e. −0.45R … +1.67R), oriented
  // by trade direction so a SHORT's target sits in view.
  const bLo = Math.min(entry - .75 * K * dir, entry + 2.75 * K * dir)
  const bHi = Math.max(entry - .75 * K * dir, entry + 2.75 * K * dir)
  const mapY = p => 160 - (p - bLo) / (bHi - bLo) * 128
  const combined = store.hist2.concat(store.hist.map(h => h.p))
  const SEG = [[-48, -24, 30, 74], [-24, -4, 74, 150], [-4, 0, 150, 190], [0, 4, 190, 330], [4, 8, 330, 448]]
  const xOf = t => {
    const s = SEG.find(([a, b]) => t >= a && t <= b) || (t < -48 ? SEG[0] : SEG[SEG.length - 1])
    return s[2] + (t - s[0]) / (s[1] - s[0]) * (s[3] - s[2])
  }
  const xAt = i => xOf(-48 + 48 * i / (combined.length - 1))
  const flownPath = combined.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + mapY(p).toFixed(1)).join(' ')
  const KEYS = 'abcdefgh'
  const tweaks = store.tweaks.map((tw, i2) => ({ key: KEYS[i2], x: +xAt(tw.i).toFixed(1), y: +mapY(store.hist2[tw.i]).toFixed(1),
    lpc: (xAt(tw.i) / 460 * 100).toFixed(2), tpc: (mapY(store.hist2[tw.i]) / 208 * 100).toFixed(2),
    col: tw.col, tip: KEYS[i2] + ' · ' + tw.when + ' — ' + tw.k + ' · ' + tw.d }))
  const barOHLC = i3 => {
    const seg = store.hist2.slice(Math.max(0, i3 - 1), i3 + 2)
    const o = store.hist2[Math.max(0, i3 - 1)], c = store.hist2[i3]
    const h = Math.max(...seg), l = Math.min(...seg)
    return { o: o.toFixed(2), h: h.toFixed(2), l: l.toFixed(2), c: c.toFixed(2),
      col: c >= o ? 'var(--up)' : 'var(--dn)',
      rng: ((h - l) / rUnit).toFixed(2) + 'R range',
      rAt: (((c - entry) / rUnit >= 0 ? '+' : '') + ((c - entry) / rUnit).toFixed(2)) + 'R at tweak' }
  }
  const journal = store.tweaks.map((tw, i2) => {
    const key = KEYS[i2], b = barOHLC(tw.i)
    const parts = tw.when.split(' ')
    return { key, when: tw.when, day: parts[0], hm: parts[1], k: tw.k, d: tw.d, col: tw.col,
      o: b.o, h: b.h, l: b.l, c: b.c, ohlcCol: b.col, rng: b.rng, rAt: b.rAt }
  })
  const volRaw = combined.map((p, i) => {
    const dir = i ? p - combined[i - 1] : .01
    return { dir, v: .5 + Math.abs(dir) * 30 + Math.abs(Math.sin(i * 1.7)) * 1.3 + Math.abs(Math.sin(i * .41)) * .8 }
  })
  const volMax = Math.max(...volRaw.map(o => o.v))
  const volBars = volRaw.map((o, i) => {
    const h = Math.max(2, Math.pow(o.v / volMax, .75) * 26)
    const xs = xAt(i), xn = i < volRaw.length - 1 ? xAt(i + 1) : xs + (xs - xAt(i - 1))
    const wFull = Math.max(1.2, xn - xs)
    return { x: (xs - wFull / 2).toFixed(1), w: (wFull * .9).toFixed(2), y: (210 - h).toFixed(1), h: h.toFixed(1),
      col: o.dir >= 0 ? 'var(--up)' : 'var(--dn)',
      tip: (o.dir >= 0 ? 'long pressure' : 'short pressure') + ' · vol ' + (o.v / volMax * 100).toFixed(0) + '% of peak' }
  })
  const acYm = mapY(price)
  const planPath = 'M190,' + acYm.toFixed(1) + ' C250,' + (acYm - 20).toFixed(1) + ' 330,' + (mapY(tp) + 16).toFixed(1) + ' 420,' + mapY(tp).toFixed(1)
  const yAxis = [0, 1, 2, 3, 4].map(i => bHi - (bHi - bLo) * i / 4).map(v => ({ v: f2(v), y: mapY(v).toFixed(1), pc: (mapY(v) / 208 * 100).toFixed(2) }))
  const yMinor = []
  for (let i = 0; i <= 16; i++) yMinor.push({ y: mapY(bLo + (bHi - bLo) * i / 16).toFixed(1) })
  const SCHED = [
    { from: -48, to: -24, step: 1, lb: '1h', c: 'var(--mu)' },
    { from: -24, to: 0, step: 1 / 6, lb: '10m · today', c: 'var(--sb)' },
    { from: 0, to: 4, step: .25, lb: '15m · next 4h', c: 'var(--acc)' },
    { from: 4, to: 8, step: .5, lb: '30m · to TP', c: 'var(--vio)' }]
  const xMinor = []
  SCHED.forEach(s => { for (let t = s.from; t < s.to; t += s.step) { const x2 = xOf(t); if (x2 > 30 && x2 < 452 && (!xMinor.length || x2 - xMinor[xMinor.length - 1].x >= 3.2)) xMinor.push({ x: +x2.toFixed(1) }) } })
  const resBands = SCHED.map(s => ({ lb: s.lb, c: s.c, lpc: (xOf(s.from) / 460 * 100).toFixed(2), wpc: ((xOf(s.to) - xOf(s.from)) / 460 * 100).toFixed(2) }))
  const hLb = t => { const d = new Date(Date.now() + t * 36e5); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') }
  const xLabels = [-48, -24, -8, -4, -2, 0, 1, 2, 3, 4, 6, 8].map(t => ({ v: t === 0 ? 'NOW ' + hLb(0) : hLb(t), pc: (xOf(t) / 460 * 100).toFixed(2), x: +xOf(t).toFixed(1) }))
    .filter((o, i, arr) => i === 0 || o.x - arr[i - 1].x > 24)
  const nowD = new Date(), dLb = d => d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const xAxis = [
    { x: 30, v: dLb(new Date(nowD - 2 * 864e5)) },
    { x: 110, v: dLb(new Date(nowD - 864e5)) },
    { x: 190, v: nowD.toUTCString().slice(17, 22) + ' UTC' }].map(o => ({ ...o, pc: (o.x / 460 * 100).toFixed(2) }))
  const emaArr = k => { const a = 2 / (k + 1); let e = combined[0]; return combined.map(p => (e = p * a + e * (1 - a))) }
  const emaPath = arr => arr.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + mapY(p).toFixed(1)).join(' ')
  const ema9Path = emaPath(emaArr(9)), ema20Path = emaPath(emaArr(20)), ema50Path = emaPath(emaArr(50))
  const vwapArr = []
  { let acc = entry; const out = []
    for (let i = 0; i < combined.length; i++) { acc = acc * .965 + combined[i] * .035; out.push(acc) }
    vwapArr.push(...out) }
  const vwapPath = vwapArr.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + mapY(p).toFixed(1)).join(' ')
  const vwapNow = vwapArr[vwapArr.length - 1]
  const vpBuckets = Array.from({ length: 16 }, (_, i) => price + .38 * K - i * .05 * K)
  const vpVol = vpBuckets.map(pc => combined.filter(p => Math.abs(p - pc) < .035 * K).length + .6 + Math.abs(Math.sin(pc * 37)) * 1.4)
  const vpMax = Math.max(...vpVol)
  const pocIdx = vpVol.indexOf(vpMax)
  const vaCut = vpMax * .45
  const vpRowH = 100 / 16
  const vpBars = vpBuckets.map((pc, i) => ({ top: (i * vpRowH).toFixed(2), h: (vpRowH - .8).toFixed(2), w: Math.round(vpVol[i] / vpMax * 88) + 10,
    col: i === pocIdx ? 'var(--wrn)' : vpVol[i] >= vaCut ? 'var(--vio)' : 'rgba(154,168,204,.45)',
    gl: i === pocIdx ? '0 0 8px rgba(255,196,102,.6)' : 'none',
    tip: (i === pocIdx ? 'POC (most volume) · ' : vpVol[i] >= vaCut ? 'Value Area · ' : 'Low volume node · ') + f2(pc) }))
  const pocTop = (pocIdx * vpRowH + vpRowH / 2).toFixed(2)
  const vaTop = (Math.max(0, pocIdx - 2) * vpRowH).toFixed(2), vaH = (5 * vpRowH).toFixed(2)
  const TFC = [
    ['HSI', .82, 40, -22, 'idx corr .82', '4px,-120%'],
    ['0003.HK', .74, 96, -30, 'peer corr .74', '-108%,-160%'],
    ['0006.HK', .68, 26, -18, 'peer corr .68', '-104%,10%'],
    ['HKD 1M', -.31, -34, 156, 'rates corr −.31', '4px,40%'],
    ['CN50', .44, -52, -40, 'idx corr .44', '-104%,-110%'],
    ['XAU', .12, -80, 96, 'hedge corr .12', '4px,30%']]
  // One aircraft builder for both feeds, so the label/de-collision fields can
  // never drift between the demo roster and the snapshot's related[] rows.
  const mkTfc = (sym, meta, tx, ty, rot, vlen, col) => {
    const rad = (rot - 90) * Math.PI / 180
    return { sym, meta, x: tx, y: ty, lpc: ((tx + 6) / 460 * 100).toFixed(2), tpcRaw: ty / 208 * 100, dx: tx > 190 ? '4px' : '-104%', dy: '-50%', rot: rot.toFixed(0),
      vx: (Math.cos(rad) * vlen).toFixed(1), vy: (Math.sin(rad) * vlen).toFixed(1), col }
  }
  // The snapshot's correlation block (PHASE 6 server-side): related[] is the
  // account's other held positions with relation stacked/hedged/independent/
  // unknown. A missing/unknown block means NO traffic and '—' counts — the
  // prompt: missing correlation is UNKNOWN, never same-heading agreement.
  const corr = snap && Array.isArray(snap.correlation?.related) ? snap.correlation : null
  const REL_COL = { stacked: 'var(--up)', hedged: 'var(--dn)', independent: 'var(--wrn)', unknown: 'var(--mu)' }
  // Heading encodes the relation: stacked flies with you (up-ish), hedged
  // against you, independent/unmeasured crosses the flight path.
  const REL_ROT = { stacked: -20, hedged: 160, independent: 90, unknown: 90 }
  const traffic = corr
    ? corr.related.map((t0, i, arr) => {
        const rel = REL_COL[t0.relation] ? t0.relation : 'unknown'
        const eff = num(t0.effective) ?? 0
        // Deterministic placement: evenly spread across the band, altitude by
        // effective correlation — no random jitter dressed up as data.
        const tx = arr.length === 1 ? 250 : 60 + i * 320 / (arr.length - 1)
        const ty = clamp(112 - eff * 46, 26, 196)
        const meta = (t0.coefficient != null ? `corr ${t0.coefficient >= 0 ? '' : '−'}${Math.abs(t0.coefficient).toFixed(2)}` : 'corr unmeasured') + ' · ' + rel
        return mkTfc(t0.symbol, meta, tx, ty, REL_ROT[rel], 10 + Math.abs(num(t0.coefficient) ?? 0) * 8, REL_COL[rel])
      })
    : snap ? [] : TFC.map(([s, c, dx, rotBase, meta], i) => {
        const same = c >= .4 && Math.abs(rotBase) < 60
        return mkTfc(s, meta, 190 + dx, 112 - c * 46 + wv(10 + i) * 5, rotBase + wv(8 + i) * 10,
          10 + Math.abs(c) * 8, same ? 'var(--up)' : c < 0 ? 'var(--dn)' : 'var(--wrn)')
      })
  // De-collision — the reference's exact algorithm (BUILD-ORDER §5.3): split
  // left/right columns, sort by y, min-gap push, obstacle bands, pane clamp.
  const OBST = [[13, 23], [52, 62], [67.5, 76.5], [69, 78]]
  const PANE_MAX = 64
  const declutter = arr => {
    const MIN = 7.5
    const H = 5.5
    const clearObst = v => {
      for (let pass = 0; pass < 6; pass++) {
        const hit = OBST.find(([a, b]) => v + H > a && v < b)
        if (!hit) break
        v = hit[1] + .8
      }
      return v
    }
    arr.sort((a, b) => a.tpcRaw - b.tpcRaw)
    arr.forEach((o, i) => {
      let v = o.tpcRaw
      if (i && v - arr[i - 1].tpcRaw < MIN) v = arr[i - 1].tpcRaw + MIN
      v = clearObst(v)
      if (i && v - arr[i - 1].tpcRaw < MIN) v = clearObst(arr[i - 1].tpcRaw + MIN)
      o.tpcRaw = v
    })
    const over = arr.length ? arr[arr.length - 1].tpcRaw - PANE_MAX : 0
    if (over > 0) arr.forEach(o => { o.tpcRaw = clearObst(Math.max(6, o.tpcRaw - over)) })
    arr.forEach(o => { o.tpc = clamp(o.tpcRaw, 6, PANE_MAX).toFixed(2) })
  }
  declutter(traffic.filter(t2 => t2.dx === '4px'))
  declutter(traffic.filter(t2 => t2.dx !== '4px'))
  // nSame/nDiv: the server's own stacked/hedged counts when a snapshot is
  // bound; the demo roster's same-heading heuristic otherwise. `nSame` stays
  // numeric for the demo go-around row; display strings are separate.
  const nSame = corr
    ? (corr.summary?.stacked ?? corr.related.filter(r0 => r0.relation === 'stacked').length)
    : TFC.filter(([, c, , r0]) => c >= .4 && Math.abs(r0) < 60).length
  const nDiv = corr
    ? (corr.summary?.hedged ?? corr.related.filter(r0 => r0.relation === 'hedged').length)
    : TFC.length - nSame
  // MARKET SAYS: with a snapshot it is a deterministic sentence from the
  // correlation summary + regime — never the reference's HK-utilities story.
  const regime = snap?.environment?.regime ?? null
  const regimeTxt = regime?.label
    ? `Regime: ${regime.label}${regime.direction ? ' · ' + regime.direction : ''}${regime.status === 'stale' ? ' (stale)' : ''}.`
    : 'Regime unknown.'
  const mktRead = corr
    ? (() => {
        const held = corr.summary?.held ?? corr.related.length
        const unmeasured = corr.related.filter(r0 => r0.relation === 'unknown').length
        const parts = held === 0
          ? ['No other open positions in this account — no correlated traffic.']
          : [`${nSame} of ${held} held position(s) stacked with this trade, ${nDiv} hedged` +
             (unmeasured ? `, ${unmeasured} unmeasured` : '') + '.']
        if (corr.status === 'stale') parts.push('Correlation matrix is stale — coefficients are real but old.')
        parts.push(regimeTxt)
        return parts.join(' ')
      })()
    : snap
      ? `Correlation unknown — ${snap.correlation?.detail || 'no matrix measurements for this symbol'}. Traffic is not shown rather than invented. ${regimeTxt}`
      : nSame >= 3
        ? 'HK utilities & index flying the same heading as you — sector-wide climb, tailwind confirmed. Rates ticking inverse (normal). Path to TP is with the traffic flow.'
        : 'Correlated traffic scattering — sector consensus weakening; treat the climb as single-engine, tighten the trail.'
  const etaTxt = (base) => marketClosed ? 'on next open' : base
  const legs = [
    { k: 'LEG 1 — flown', v: 'Entry filled ✓', s: '23/07 10:07 · 0.4bp slip', col: 'var(--wrn)', bd: 'var(--edg)' },
    { k: 'LEG 2 — active', v: 'Scale-out waypoint', s: etaTxt('arms at +1R · coded rule §2.4'), col: 'var(--acc)', bd: 'var(--acc)' },
    { k: 'LEG 3 — planned', v: 'Target', s: etaTxt('ETA ~4h at current velocity'), col: 'var(--up)', bd: 'var(--edg)' }]
  const riskUsed = clamp(rNow < 0 ? -rNow * 100 : 8, 0, 100)
  const fuelW = 100 - riskUsed
  const balance = 184920, dailyCap = 3698
  const usedAbs = dailyCap * riskUsed / 100
  const usd = n => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const mult = 10, shares = 1092 * mult, fx = 7.8, mgnRate = .2
  const notionalL = price * shares, notionalUsd = notionalL / fx
  const marginUsd = notionalUsd * mgnRate
  const rr = haveRails ? Math.abs(tp - entry) / Math.abs(entry - sl) : (tp - entry) / (entry - sl)
  // Dollars-per-R from two broker facts (live P&L and the R it sits at) — no
  // contract-size guess. Below 0.05R the division is not trustworthy.
  const dollarPerR = rPnl != null && Math.abs(rNow) >= .05 ? Math.abs(rPnl / rNow) : null
  const slUsdV = real ? (dollarPerR != null ? -dollarPerR : null) : -(entry - sl) * shares / fx
  const tpUsdV = real ? (dollarPerR != null ? dollarPerR * rr : null) : (tp - entry) * shares / fx
  const hk = n => 'HK$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const pct = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%'
  // Margin stays live on a closed market (broker fact); rates freeze with wv.
  const rvol = 1.4 + wv(4) * .6, sprX = 1.1 + Math.abs(wv(5)) * 1.4, lat = 42 + Math.abs(wv(7)) * 16
  const marg = 18 + Math.abs(w(6)) * 6
  // Bullet values: with a snapshot the wave generators above are replaced by
  // the served fields — and a null field renders '—'/unknown, not the demo
  // number (execution.latencyMs is UNKNOWN by design: no authoritative source).
  const rvolV = snap ? num(snap.indicators?.rvol) : rvol
  const sprV = snap ? num(snap.execution?.spreadRatio) : sprX
  const latV = snap ? num(snap.execution?.latencyMs) : lat
  const margV = snap
    ? (num(snap.account?.usedMargin) != null && num(snap.account?.equity) > 0
        ? snap.account.usedMargin / snap.account.equity * 100 : null)
    : marg
  const E2 = [
    ['RVOL', rvolV, 0, 3, [0.8, 1.6], 0.6, -1, '×', v => v.toFixed(1), 'volume vs 20-bar average — below 0.6× the move has no participation'],
    ['Spread', sprV, 0, 3, [0.9, 1.4], 2.5, 1, '×', v => v.toFixed(1), 'live spread vs backtest assumption — above 2.5× the edge is eaten by cost'],
    ['Margin', margV, 0, 60, [10, 25], 40, 1, '%', v => Math.round(v) + '', 'account margin in use — above 40% no new positions are opened'],
    ['Latency', latV, 0, 120, [20, 60], 90, 1, 'ms', v => Math.round(v) + '', 'broker round-trip — above 90ms fills drift from signal price']]
  const engines = E2.map(([k, val, lo, hi, norm, th, dir, unit, fmt, why]) => {
    const p = x => clamp((x - lo) / (hi - lo), 0, 1) * 100
    if (val == null) {
      // Honest no-data row: same geometry (bands, threshold) so the layout
      // holds, but no bar, muted, and the tooltip says WHY there is no value.
      return { k, v: '—', unit: '', pct: '0', normL: p(norm[0]).toFixed(1), normW: (p(norm[1]) - p(norm[0])).toFixed(1),
        thPct: p(th).toFixed(1), thCol: 'var(--mu)', thLb: (dir > 0 ? 'max ' : 'min ') + fmt(th) + unit,
        col: 'var(--mu)', tip: k + ' unknown — the snapshot has no value for it (null + status unknown, never a guess)' }
    }
    const breach = dir > 0 ? val >= th : val <= th
    const near = dir > 0 ? val >= th * .8 : val <= th * 1.25
    const dead = marketClosed && k !== 'Margin' // closed market: only Margin is live
    return { k, v: fmt(val), unit, pct: p(val).toFixed(1), normL: p(norm[0]).toFixed(1), normW: (p(norm[1]) - p(norm[0])).toFixed(1),
      thPct: p(th).toFixed(1), thCol: breach ? 'var(--dn)' : 'var(--wrn)',
      thLb: (dir > 0 ? 'max ' : 'min ') + fmt(th) + unit,
      col: dead ? 'var(--mu)' : breach ? 'var(--dn)' : near ? 'var(--wrn)' : 'var(--acc)',
      tip: k + ' ' + fmt(val) + unit + ' · ' + why + ' · typical ' + fmt(norm[0]) + '–' + fmt(norm[1]) + unit + ' · ' + (breach ? 'BREACHED' : near ? 'approaching limit' : 'within tolerance') }
  })
  const ft = m => { const d = new Date(Date.now() - m * 60000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') }
  const eta = d => { const mins = spd > .05 ? Math.abs(d) / (spd * .01) : 0; return mins > 0 && mins < 900 ? '~' + (mins > 60 ? (mins / 60).toFixed(1) + 'h' : Math.round(mins) + 'm') : '—' }
  // Reference waypoints 78.50 / 79.00 are +1R / +1.30R on the reference
  // instrument — expressed in R so they land correctly on any instrument.
  const wp1 = entry + rUnit * 1 * dir, wp2 = entry + rUnit * 1.3 * dir
  const prox = t2 => Math.round(clamp((price - entry) / (t2 - entry), 0, 1) * 100)
  // ARMED ACTIONS: the snapshot's intention.armedActions[] (PHASE 5 — the
  // rules the managers are actually configured with), else the reference demo
  // waypoints. An empty served list is an honest row, not the demo rows.
  const intent = snap && Array.isArray(snap.intention?.armedActions) ? snap.intention : null
  const autopilot = intent
    ? (intent.armedActions.length ? intent.armedActions.map(a => ({
        k: String(a.kind ?? '—').replace(/_/g, ' ').toUpperCase(),
        v: a.trigger ?? '—',
        d: a.distance != null ? Number(a.distance).toPrecision(3) + ' away'
          : a.eta != null ? 'due ' + a.eta
          : a.armed ? 'armed' : 'configured',
        col: a.armed ? 'var(--acc)' : 'var(--mu)',
        // Progress only when the trigger is a measurable price on real rails.
        prog: a.triggerPrice != null && haveRails ? prox(num(a.triggerPrice) ?? entry) : 0,
        progCol: a.armed ? 'var(--acc)' : 'var(--mu)',
      })) : [{ k: 'NONE', v: 'no armed actions recorded for this position', d: '', col: 'var(--mu)', prog: 0, progCol: 'var(--mu)' }])
    : marketClosed ? [
    { k: 'SCALE-OUT 50%', v: '+1R waypoint', d: 'arms at next open', col: 'var(--mu)', prog: prox(wp1), progCol: 'var(--mu)' },
    { k: 'TRAIL TIGHTEN', v: '0.5R gap at +1.2R', d: 'arms at next open', col: 'var(--mu)', prog: prox(wp2), progCol: 'var(--mu)' },
    { k: 'NEWS BLACKOUT', v: 'HK CPI 14:15–14:45', d: 'arms at next open', col: 'var(--mu)', prog: 62, progCol: 'var(--mu)' }] : [
    { k: 'SCALE-OUT 50%', v: '+1R waypoint', d: f2(Math.abs(wp1 - price)) + ' away · ETA ' + eta(wp1 - price), col: 'var(--acc)', prog: prox(wp1), progCol: 'var(--acc)' },
    { k: 'TRAIL TIGHTEN', v: '0.5R gap at +1.2R', d: f2(Math.abs(wp2 - price)) + ' away', col: 'var(--acc)', prog: prox(wp2), progCol: 'var(--acc)' },
    { k: 'NEWS BLACKOUT', v: 'HK CPI 14:15–14:45', d: 'entries blocked', col: 'var(--wrn)', prog: 62, progCol: 'var(--wrn)' }]
  const vwapDev = wv(4) * .8 + .3
  // INVALIDATION WATCH: the snapshot's evaluated invalidation[] states —
  // met = fired (✗), watching = evaluated and clear (✓), armed/stored/
  // warning/unknown = present but not evaluable right now (△), never
  // dressed up as a fresh ✓.
  const INV_MARK = { met: ['✗', 'var(--dn)'], watching: ['✓', 'var(--acc)'], armed: ['△', 'var(--wrn)'], stored: ['△', 'var(--wrn)'], warning: ['△', 'var(--wrn)'], unknown: ['△', 'var(--mu)'] }
  const invReal = snap && Array.isArray(snap.intention?.invalidation) ? snap.intention.invalidation : null
  const goaround = invReal
    ? invReal.map(g => {
        const st = INV_MARK[g.state] ? g.state : 'unknown'
        return { k: String(g.kind ?? '—').replace(/_/g, ' '), f: g.condition ?? '—', now: st,
          ok: st !== 'met', mark: INV_MARK[st][0], okCol: INV_MARK[st][1] }
      })
    : [
    { k: 'Quadrant flip', f: 'Quadrant flips Q1 → Q2/Q3', now: 'Q1 holding', ok: true },
    { k: 'RVOL < 0.6×', f: 'RVOL dies below 0.6×', now: rvol.toFixed(1) + '×', ok: rvol >= .6 },
    { k: 'Close < VWAP', f: '15m close below VWAP', now: (vwapDev >= 0 ? '+' : '') + vwapDev.toFixed(2) + 'σ', ok: vwapDev >= 0 },
    { k: 'Traffic diverges', f: 'Sector traffic diverges (<2 same-heading)', now: nSame + ' same', ok: nSame >= 2 },
    { k: 'Spread > 2.5×', f: 'Spread guard exceeds 2.5× backtest', now: sprX.toFixed(1) + '×', ok: sprX <= 2.5 }].map(g =>
      ({ ...g, mark: g.ok ? '✓' : '✕', okCol: g.ok ? 'var(--acc)' : 'var(--dn)' }))
  const gaBreach = goaround.filter(g => !g.ok).length
  // gaNote: with a snapshot the header note is the bot's OWN recorded state
  // (currentDecision), not a recount of the demo conditions.
  const decisionState = snap?.intention?.currentDecision?.state ?? null
  // FLEET (owner 2026-07-26: "not static/demo data"). When the clicking
  // surface supplies the account's real open positions (see cockpit-fleet.js)
  // this is computed from them: each row's own R, ordered by distance from
  // entry, with a truthful "top N of M". The literal array below is the
  // reference demo roster and is used ONLY when no real roster was handed in.
  const DEMO_FLEET = [['0002.HK', .23, true], ['BTCUSD', .61, false], ['XAUUSD', .42, false], ['EURUSD', -.18, false], ['GER40', .12, false], ['US500', .35, false], ['USDJPY', -.44, false], ['AUS200', .08, false]]
  const realFleet = Array.isArray(real?.fleet?.list) ? real.fleet : null
  const fleetBar = (r) => {
    const halfW = clamp(Math.abs(r) / 2 * 50, 2, 50)
    return { barL: r >= 0 ? 50 : 50 - halfW, barW: halfW }
  }
  const fleet = realFleet
    ? realFleet.list.map(f => ({
        sym: f.sym,
        r: f.r == null ? '—' : (f.r >= 0 ? '+' : '') + f.r.toFixed(2),
        col: f.r == null ? 'var(--mu)' : f.r >= 0 ? 'var(--up)' : 'var(--dn)',
        ...(f.r == null ? { barL: 50, barW: 0 } : fleetBar(f.r)),
        bd: 'var(--edg)', bg: 'transparent',
      }))
    : DEMO_FLEET.slice(0, 5).map(([sym, r0, active], i) => {
        const r = r0 + wv(12 + i) * .08
        return { sym, r: (r >= 0 ? '+' : '') + r.toFixed(2), col: r >= 0 ? 'var(--up)' : 'var(--dn)',
          ...fleetBar(r), bd: active ? 'var(--acc)' : 'var(--edg)', bg: active ? 'var(--acs)' : 'transparent' }
      })
  const fleetLabel = realFleet
    ? (realFleet.total > fleet.length ? `top ${fleet.length} of ${realFleet.total}` : `${realFleet.total} other open`)
    : 'top 5 of 8 · demo'
  const fleetIsReal = !!realFleet
  // MFE/MAE: monitored_positions records these per trade (mfe_r / mae_r), so
  // when the surface hands them over they are real rather than "the extremes
  // seen since this modal happened to open".
  const realMfe = real ? num(real.mfeR) : null
  const realMae = real ? num(real.maeR) : null
  if (!store.ex) store.ex = { mfe: rNow, mae: rNow }
  store.ex.mfe = Math.max(store.ex.mfe, rNow); store.ex.mae = Math.min(store.ex.mae, rNow)
  const exMfe = realMfe != null ? Math.max(realMfe, rNow) : store.ex.mfe
  const exMae = realMae != null ? Math.min(realMae, rNow) : store.ex.mae
  const exIsReal = realMfe != null || realMae != null
  const altMfe = clamp(pos(entry + exMfe * rUnit * dir), 6, 94).toFixed(1)
  const altMae = clamp(pos(entry + exMae * rUnit * dir), 6, 94).toFixed(1)
  const mcSrc = combined.slice(-30)
  // Both rails go into both bounds: on a SHORT the stop is the HIGH and the
  // target the LOW, so the reference's long-shaped min(sl)/max(tp) would push
  // them off-canvas. Identical result on the reference instrument.
  const mcLo = Math.min(...mcSrc, sl, tp) - .05 * K, mcHi = Math.max(...mcSrc, sl, tp) + .05 * K
  const mcY = p => (150 - (p - mcLo) / (mcHi - mcLo) * 150).toFixed(1)
  const candles = mcSrc.map((p, i) => {
    const o = i ? mcSrc[i - 1] : p - .02 * K, up = p >= o
    const hi = Math.max(o, p) + (.02 + Math.abs(Math.sin(i * 2.3)) * .03) * K
    const lo = Math.min(o, p) - (.02 + Math.abs(Math.cos(i * 1.9)) * .03) * K
    const x = 5 + i * 6.4
    const by = +mcY(Math.max(o, p)), bh = Math.max(1.2, +mcY(Math.min(o, p)) - by)
    return { x: x.toFixed(1), bx: (x - 1.7).toFixed(1), hi: mcY(hi), lo: mcY(lo), by: by.toFixed(1), bh: bh.toFixed(1),
      col: up ? 'var(--up)' : 'var(--dn)', tip: (up ? 'up' : 'down') + ' bar · O ' + f2(o) + ' C ' + f2(p) }
  })
  const mcVwap = vwapArr.slice(-30).map((p, i) => (i ? 'L' : 'M') + (5 + i * 6.4).toFixed(1) + ',' + mcY(p)).join(' ')
  // WX (weather cell on the MFD map): ONLY for an actual relevant event — the
  // news gate's active event, or a calendar entry inside the gate window. A
  // bound snapshot with no such event shows NO WX ellipse; the demo route
  // keeps the reference's HK CPI cell.
  const hmOf = iso => (iso ? String(iso).slice(11, 16) : '')
  const gateEv = snap
    ? (snap.environment?.macroNews?.gate?.activeEvent ||
       (snap.environment?.macroNews?.events || []).find(e => e.inGateWindow) || null)
    : null
  const wx = snap
    ? (gateEv ? { label: `WX · ${gateEv.title}${gateEv.scheduledAt ? ' ' + hmOf(gateEv.scheduledAt) : ''}` } : null)
    : { label: 'WX · HK CPI 14:30' }
  const alerts = []
  if (real) {
    const live = ['price', 'P&L', 'entry/SL/TP', 'R', 'market state']
    const demo = ['chart', 'volume profile', 'journal']
    // With a full snapshot bound, traffic / armed actions / invalidation /
    // engine rates come from (or honestly say unknown per) the served body —
    // they are no longer flagged demo. Without one they still are.
    if (snap) live.push('traffic', 'armed actions', 'invalidation', 'engine rates', 'advisories')
    else demo.push('traffic', 'engine rates')
    if (fleetIsReal) live.push('fleet'); else demo.push('fleet')
    if (exIsReal) live.push('MFE/MAE'); else demo.push('MFE/MAE')
    alerts.push({ t: ft(0), k: 'DEMO DATA', d: 'live: ' + live.join(', ') + ' · demo: ' + demo.join(', '), col: 'var(--wrn)' })
  }
  if (snap) {
    // The server's own advisories (freshness, account-scope, phase status) —
    // appended verbatim; they carry no timestamp of their own.
    for (const a of (Array.isArray(snap.advisories) ? snap.advisories : [])) {
      alerts.push({ t: 'now', k: String(a.kind || 'advisory').toUpperCase(), d: a.detail || '', col: 'var(--sb)' })
    }
    if (gateEv) alerts.push({ t: hmOf(gateEv.scheduledAt), k: 'NEWS GATE',
      d: `${gateEv.title} (${[gateEv.currency, gateEv.impact].filter(Boolean).join(' ')}) — new entries blocked; this position is not auto-closed by the gate`, col: 'var(--wrn)' })
  }
  if (!real && sprX > 2) alerts.push({ t: ft(0), k: 'CAUTION', d: 'spread ' + sprX.toFixed(1) + '× backtest — pending entries suspended', col: 'var(--wrn)' })
  if (!snap && rvol > 1.8) alerts.push({ t: ft(2), k: 'CAUTION', d: 'RVOL ' + rvol.toFixed(1) + '× — volatility expansion, trail tightened', col: 'var(--wrn)' })
  if (rNow < -.4) alerts.push({ t: ft(1), k: 'WARNING', d: 'price within 0.6R of stop — no averaging down permitted', col: 'var(--dn)' })
  if (!snap) {
    // Reference demo advisories — a bound snapshot never shows these.
    alerts.push({ t: ft(14), k: 'ADVISORY', d: 'WX cell ahead: HK CPI 14:30 UTC — TP orders persist, new entries blocked ±15m', col: 'var(--sb)' })
    alerts.push({ t: ft(48), k: 'ADVISORY', d: 'SL moved to breakeven per trailing rule after +0.8R', col: 'var(--sb)' })
    alerts.push({ t: ft(192), k: 'ADVISORY', d: 'entry filled 76.85 · slippage 0.4bp · quadrant Q1 agrees with LONG', col: 'var(--sb)' })
  }
  const sessOpensIn = session.opensInMins != null ? Math.floor(session.opensInMins / 60) + 'h ' + (session.opensInMins % 60) + 'm' : null
  const anim = { vsiA: clamp(-vsi / 2 * 80, -84, 84), hdgX: -hdgV / 10, fuelW,
    tpT: mTP.t, enT: mEN.t, slT: mSL.t, acX: 0, acY: acYm - 112, pnlNum: pnlUsd }
  return { sym: real?.sym || '0002.HK', ccy: real ? (real.ccy || '') : 'HKD',
    strategy: real ? (real.strategy || '—') : 'fib 61.8% fade v2.3',
    lots: real ? String(real.lots ?? '—') : '1092.00', timeIn: real ? (real.timeIn || '') : '2.3d',
    side: short ? 'SHORT' : 'LONG', isReal: !!real,
    // Panels with no agent source yet — the UI names them so nothing mock
    // reads as broker truth (PR open question Q3).
    demoPanels: real
      ? (snap
          ? ['MFD chart & EMAs', 'volume profile', 'tweak journal']
          : ['MFD chart & EMAs', 'volume profile', 'tweak journal', 'correlated traffic', 'RVOL / spread / latency', 'MFE / MAE', 'armed actions'])
      : null,
    review, session, sessOpensIn, marketClosed,
    pnl: (pnlUsd >= 0 ? '+' : '−') + '$' + Math.abs(pnlUsd).toFixed(0), pnlNum: pnlUsd, rNow: (rNow >= 0 ? '+' : '') + rNow.toFixed(2) + 'R', rCol: rNow >= 0 ? 'var(--up)' : 'var(--dn)',
    spd: marketClosed ? '—' : (spd >= 0 ? '+' : '') + spd.toFixed(2), spdCol: marketClosed ? 'var(--mu)' : spd >= 0 ? 'var(--up)' : 'var(--dn)', spdTicks,
    price: f2(price), altTicks, tpLb: mTP.lb, enLb: mEN.lb, slLb: mSL.lb,
    tpBrd: mTP.off ? 'none' : '2px solid var(--up)', enBrd: mEN.off ? 'none' : '2px dashed var(--wrn)', slBrd: mSL.off ? 'none' : '2px solid var(--dn)',
    vsi: marketClosed ? '—' : (vsi >= 0 ? '+' : '') + vsi.toFixed(2), vsiCol: marketClosed ? 'var(--mu)' : vsi >= 0 ? 'var(--up)' : 'var(--dn)',
    hdg: hdgV >= 25 ? 'BULL ' + Math.round(hdgV) : hdgV <= -25 ? 'BEAR ' + Math.round(-hdgV) : 'CHOP', hdgCol: hdgV >= 25 ? 'var(--up)' : hdgV <= -25 ? 'var(--dn)' : 'var(--sb)', hdgTicks,
    mfeR: (exMfe >= 0 ? '+' : '') + exMfe.toFixed(2) + 'R', maeR: (exMae >= 0 ? '+' : '') + exMae.toFixed(2) + 'R',
    giveback: (exMfe - rNow).toFixed(2) + 'R', exIsReal,
    altMfe, altMae, candles, mcVwap, mcTp: mcY(tp), mcEn: mcY(entry), mcSl: mcY(sl), tpPx: f2(tp), enPx: f2(entry), slPx: f2(sl), vwapPrice: f2(vwapNow),
    // Notional / margin / leverage need the symbol's contract size, which no
    // agent route serves per position — shown as unavailable rather than
    // invented once a real position is bound.
    shares: real ? '—' : shares.toLocaleString('en-US'),
    notionalL: real ? '—' : hk(notionalL), notionalU: real ? '' : usd(notionalUsd),
    marginU: real ? '—' : usd(marginUsd), lev: real ? 'contract size n/a' : (notionalUsd / marginUsd).toFixed(1) + '× lev',
    margPct: real ? '—' : (marginUsd / (balance + pnlUsd) * 100).toFixed(1) + '% of equity',
    margCol: !real && marginUsd / (balance + pnlUsd) > .35 ? 'var(--dn)' : 'var(--sb)',
    slUsd: slUsdV == null ? '—' : '−' + usd(Math.abs(slUsdV)),
    tpUsd: tpUsdV == null ? '—' : '+' + usd(tpUsdV), tpR: '+' + rr.toFixed(2) + 'R',
    slPctBal: slUsdV == null ? '—' : pct(slUsdV / balance * 100),
    tpPctBal: tpUsdV == null ? '—' : pct(tpUsdV / balance * 100),
    rrNote: (slUsdV == null || tpUsdV == null
      ? 'reward:risk ' + rr.toFixed(2) + ':1'
      : 'risk ' + usd(Math.abs(slUsdV)) + ' to make ' + usd(tpUsdV) + ' — ' + rr.toFixed(2) + ':1')
      + ' · SL ' + f2(sl) + ' / TP ' + f2(tp),
    // '—' when a snapshot is bound but correlation is unknown: an unmeasured
    // count is not zero (the prompt's missing-is-UNKNOWN rule).
    legs, traffic, nSame: snap && !corr ? '—' : String(nSame), nDiv: snap && !corr ? '—' : String(nDiv), mktRead, flownPath, planPath, tweaks, journal, wx,
    yAxis, xAxis, vwapPath, vpBars, vaTop, vaH, pocTop, yMinor, xMinor, resBands, xLabels, volBars, ema9Path, ema20Path, ema50Path,
    fuel: Math.round(fuelW) + '%',
    acctBal: usd(balance), acctEq: usd(balance + pnlUsd), capAbs: usd(dailyCap), capUsed: '−' + usd(usedAbs), capLeft: usd(dailyCap - usedAbs),
    engines, alerts, autopilot, goaround,
    gaNote: decisionState != null
      ? 'bot state: ' + decisionState + (gaBreach ? ' · ' + gaBreach + ' condition(s) met' : '')
      : invReal
        ? (gaBreach === 0 ? 'no invalidation condition met' : gaBreach + ' condition(s) met')
        : gaBreach === 0 ? 'thesis intact — all go-around conditions clear' : gaBreach + ' condition(s) breached — bot exits on ' + (gaBreach >= 2 ? 'NEXT BAR' : 'confirmation'),
    gaCol: decisionState != null
      ? (['exiting', 'blocked'].includes(decisionState) ? 'var(--dn)' : decisionState === 'managing' ? 'var(--wrn)' : ['holding', 'monitoring'].includes(decisionState) ? 'var(--acc)' : 'var(--mu)')
      : gaBreach === 0 ? 'var(--acc)' : gaBreach >= 2 ? 'var(--dn)' : 'var(--wrn)', fleet, fleetLabel, fleetIsReal,
    clock: new Date().toUTCString().slice(17, 25) + ' UTC', anim }
}
