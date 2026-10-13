import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { bracketMoney } from '../lib/std-trade-rows.js'

// Claude · № 13,987 13-Oct (owner: Codex P2 #3 on #1348 "Held lots at broker TP"; claude-builder).
// Source of the expected outcome: the broker holds ONE take-profit per position
// (current_tp); nothing sends tp2_price and a scale-out does not move the broker
// TP, so the lots held now close at current_tp. The broker's own TP impact (shown
// first when present) is that figure; the fallback estimate takes the same basis.
describe('Trade open-position TP money', () => {
  it('bracketMoney gets the held lots at the broker TP, not the display ladder', () => {
    const src = readFileSync(new URL('./Trade.jsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const body = src.slice(src.indexOf('function openPositionRows'), src.indexOf('function externalPositionRows'))
    const call = body.slice(body.indexOf('bracketMoney({'), body.indexOf('})', body.indexOf('bracketMoney({')))
    expect(call).toMatch(/qty: heldLots\(p\)/)
    expect(call).toMatch(/tp: p\.current_tp/)
    expect(call).not.toMatch(/\btps\b/)
  })

  it('TP money scales with the held lots (SHOP.US 9.5 opened, 4.7 held)', () => {
    const base = { symbol: 'SHOP.US', side: 'long', entry: 100, sl: 95, tp: 110, ref: 105, rates: {} }
    const opened = bracketMoney({ ...base, qty: 9.5 }).tpMoney
    const held = bracketMoney({ ...base, qty: 4.7 }).tpMoney
    expect(opened).not.toBeNull()
    expect(held / opened).toBeCloseTo(4.7 / 9.5, 10)
  })
})
