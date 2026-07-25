// BUILD-ORDER §3 — one scale, three devices. Desktop values are the base
// (already ×0.95). The named roles take the table values verbatim; every
// other size is the mechanical pass: base/0.95 × factor, rounded to 0.5px,
// floored at 8px. Sizes below 8px in the reference (6px currency, 7px POC,
// 5px tweak keys) are taken verbatim from the reference on every device —
// scaling would RAISE them to the 8px floor, which contradicts §5.3's "6px
// label"; reported as an open question, resolved reference-verbatim.
const PIN = {
  19: { ipad: 18.5, iphone: 17 },    // header symbol (700)
  15: { ipad: 14.5, iphone: 14 },    // P&L · R
  12.5: { ipad: 12, iphone: 11 },    // card heading
  11.5: { ipad: 11, iphone: 10.5 },  // chip / pill / button
  10.5: { ipad: 10, iphone: 9.5 },   // instrument annotation
  7.5: { ipad: 7.5, iphone: 7.5 },   // chart caption (TERRAIN/ENTRY/TP/WPT/WX)
  8.5: { ipad: 8, iphone: 8 },       // tape caption
  8: { ipad: 8, iphone: 8 },         // micro (POC, axis) + ruler labels
}
const FACTOR = { desktop: 0.95, ipad: 0.92, iphone: 0.86 }

export function makeFs(variant) {
  if (variant === 'desktop') return px => px
  return px => {
    if (px < 8) return px
    if (PIN[px]) return PIN[px][variant]
    const v = (px / 0.95) * FACTOR[variant]
    return Math.max(8, Math.round(v * 2) / 2)
  }
}
