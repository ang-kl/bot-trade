import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Claude · № 13,980 13-Oct (owner: Codex P2 on #1348; claude-builder).
// Wiring pin: openPositionRows is not exported, so the call site is checked in
// source with comments stripped (a comment cannot satisfy it).
describe('Trade open-position TP money', () => {
  it('bracketMoney gets the held-lots money ladder, not the opened ladder', () => {
    const src = readFileSync(new URL('./Trade.jsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const body = src.slice(src.indexOf('function openPositionRows'), src.indexOf('function externalPositionRows'))
    expect(body).toMatch(/tps: heldMoneyLadder\(tps, p\.current_lots, p\.volume\)/)
    expect(body).not.toMatch(/bracketMoney\(\{[^}]*\btps, ref/)
  })
})
