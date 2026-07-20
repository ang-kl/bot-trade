import { describe, it, expect } from 'vitest'
import { humanVeto } from './veto-words.js'

describe('humanVeto', () => {
  it('translates the common machine codes into trader words', () => {
    expect(humanVeto('sl_too_tight 0.038%<0.15%')).toBe('Stop too tight — 0.038% vs 0.15% min')
    expect(humanVeto('duplicate_symbol existing_side=long')).toBe('Already long — one position per symbol')
    expect(humanVeto('max_positions=6/6')).toBe('Position cap reached (6/6)')
    expect(humanVeto('loss_streak_cooldown streak=3 wait=42m')).toBe('Cooling off after 3 straight losses — 42m left')
    expect(humanVeto('bad_rr 1.20<1.5')).toBe('Reward:risk 1.20 below the 1.5 floor')
    expect(humanVeto('market_closed: forex session closed')).toBe('Market closed')
  })
  it('duplicate_symbol shows the actual blocking position when the risk gate provides it', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(humanVeto(`duplicate_symbol existing_side=BUY entry=1.1429 opened=${twoHoursAgo}`))
      .toBe('Already BUY @ 1.1429 (opened 2h ago) — one position per symbol')
    expect(humanVeto('duplicate_symbol existing_side=SELL entry=na opened=na'))
      .toBe('Already SELL — one position per symbol')
  })
  it('unknown codes degrade to spaced words, empty stays empty', () => {
    expect(humanVeto('some_new_rule detail=1')).toBe('some new rule detail=1')
    expect(humanVeto(null)).toBe('')
  })
})
