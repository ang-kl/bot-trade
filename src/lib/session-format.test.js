// npx vitest run src/lib/session-format.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  durationText, seenText, aliveText, statusLine, localTime, splitSessions,
  confirmCopy, STATE_LABEL, STATE_TONE, STATE_HELP,
} from './session-format.js'

describe('durations read the way the brief writes them', () => {
  it('matches the brief’s own examples', () => {
    // "Active for 2h 14m" and "seen 3s ago" are literal examples in the brief.
    expect(durationText(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(durationText(3_000)).toBe('3s')
    expect(durationText(18 * 60_000)).toBe('18m')
    expect(durationText(3 * 3600_000)).toBe('3h')
    expect(durationText(3 * 86_400_000 + 4 * 3600_000)).toBe('3d 4h')
  })

  it('an unknown duration is null, never "0s"', () => {
    for (const junk of [null, undefined, NaN, -1, 'nope']) expect(durationText(junk)).toBe(null)
    // A real zero IS a measurement and reads as 0s.
    expect(durationText(0)).toBe('0s')
  })
})

describe('last-seen wording', () => {
  it('prefixes with "seen" and collapses the sub-second case', () => {
    expect(seenText(3_000)).toBe('seen 3s ago')
    expect(seenText(0)).toBe('seen just now')
    expect(seenText(1_400)).toBe('seen just now')
    expect(seenText(null)).toBe(null)
  })
})

describe('alive duration is about the session, not the connection', () => {
  it('reads as still-running for a live session', () => {
    expect(aliveText(2 * 3600_000 + 14 * 60_000, 'active')).toBe('Active for 2h 14m')
    expect(aliveText(18 * 60_000, 'idle')).toBe('Active for 18m')
  })

  it('switches to past tense once revoked — it is not still "active"', () => {
    expect(aliveText(18 * 60_000, 'revoked')).toBe('Existed 18m')
  })

  it('is null when the creation time is unknown, rather than claiming 0', () => {
    expect(aliveText(null, 'active')).toBe(null)
  })
})

describe('the one visible line', () => {
  it('is the brief’s shape: browser · state · age', () => {
    const line = statusLine({ browserFamily: 'Chrome', state: 'active', lastSeenAgeMs: 3_000 })
    expect(line.browser).toBe('Chrome')
    expect(line.stateLabel).toBe('Active')
    expect(line.age).toBe('3s ago')
  })

  it('never renders a blank browser or an unlabelled state', () => {
    const line = statusLine({ state: 'stale' })
    expect(line.browser).toBe('Unknown browser')
    expect(line.stateLabel).toBe('Stale')
    expect(line.age).toBe(null)
  })

  it('survives a missing session entirely', () => {
    const line = statusLine(null)
    expect(line.browser).toBe('No session')
    expect(line.state).toBe('disconnected')
  })
})

describe('status is never carried by colour alone', () => {
  it('every state has a word AND a help sentence, not just a tone', () => {
    for (const key of Object.keys(STATE_TONE)) {
      expect(STATE_LABEL[key], `${key} needs a visible label`).toBeTruthy()
      expect(STATE_HELP[key], `${key} needs an explanation`).toBeTruthy()
    }
  })

  it('uses semantic tokens so themes and high-contrast follow', () => {
    for (const v of Object.values(STATE_TONE)) expect(v).toMatch(/^var\(--/)
  })
})

describe('splitSessions trusts only the server’s isCurrent', () => {
  const view = {
    sessions: [
      { id: 'a', isCurrent: false }, { id: 'b', isCurrent: true }, { id: 'c', isCurrent: false },
    ],
  }
  it('picks the flagged one and leaves the rest', () => {
    const { current, others } = splitSessions(view)
    expect(current.id).toBe('b')
    expect(others.map(s => s.id)).toEqual(['a', 'c'])
  })

  it('handles a payload with no current session (master-secret case)', () => {
    const { current, others } = splitSessions({ sessions: [{ id: 'a', isCurrent: false }] })
    expect(current).toBe(null)
    expect(others).toHaveLength(1)
  })

  it('junk in, empty out — never a throw', () => {
    for (const junk of [null, undefined, {}, { sessions: 'nope' }]) {
      expect(() => splitSessions(junk)).not.toThrow()
      expect(splitSessions(junk).others).toEqual([])
    }
  })
})

describe('the confirmation names the device and does not overpromise', () => {
  const copy = confirmCopy({ label: 'Safari 17 on iOS' })

  it('identifies the remote browser in the title', () => {
    expect(copy.title).toBe('Disconnect Safari 17 on iOS?')
  })

  it('is labelled "Disconnect session", never "Close browser"', () => {
    // The brief: 'Do not label it "Close browser" unless physical closing is
    // technically confirmed for that environment.' It never is here.
    expect(copy.confirm).toBe('Disconnect session')
    expect(JSON.stringify(copy).toLowerCase()).not.toContain('close browser')
  })

  it('states that accepted orders are NOT cancelled', () => {
    expect(copy.body).toMatch(/already accepted/i)
    expect(copy.body).toMatch(/unaffected/i)
  })

  it('degrades to a safe phrase with no session', () => {
    expect(confirmCopy(null).title).toBe('Disconnect this browser?')
  })
})

describe('localTime', () => {
  it('formats an ISO stamp and never throws on junk', () => {
    expect(localTime('2026-07-30T06:57:00Z')).toMatch(/\d/)
    expect(localTime(null)).toBe('—')
    expect(localTime('not a date')).toBe('—')
  })
})

// ---------------------------------------------------------------------------
// The owner's explicit cap. Asserted against the CSS token and the component,
// because "maximum visible font size: 10px" is the kind of requirement that
// silently rots the next time someone restyles the line.
// ---------------------------------------------------------------------------
describe('the session line obeys the 10px cap', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8')
  const jsx = readFileSync(new URL('../components/SessionFooter.jsx', import.meta.url).pathname, 'utf8')

  it('stays at or under the 10px cap, in rem so font scaling works', () => {
    // rem rather than px is deliberate: see the comment on the token in
    // index.css. A px literal would satisfy the 10px cap and silently defeat
    // the brief's own "user font scaling remain effective" requirement.
    //
    // 05-08-2026: the value moved 0.625rem → 0.5625rem (10px → 9px) with the
    // type canon — "all body font size to be the same as … '7d'". So this
    // asserts the CAP, which is what the owner actually stated, rather than
    // one particular value under it. Pinning the literal is what would have
    // made the two instructions look like a conflict when they are not.
    const rem = Number(css.match(/--fs-session:\s*([\d.]+)rem/)?.[1])
    expect(Number.isFinite(rem)).toBe(true)
    expect(rem * 16).toBeLessThanOrEqual(10)
    expect(css).toMatch(/--lh-session:\s*0\.75rem/)
    expect(0.75 * 16).toBe(12)
  })

  it('the status line uses the token, not a literal', () => {
    expect(css).toMatch(/\.session-status-line\s*\{[^}]*font-size:\s*var\(--fs-session\)/)
  })

  it('one line only: nowrap plus ellipsis, never wrapping', () => {
    expect(css).toMatch(/\.session-status-line\s*\{[^}]*white-space:\s*nowrap/)
    expect(css).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('the component sets no font size larger than the token on that line', () => {
    // Any text-[Npx] on the status line would defeat the cap.
    const lineMarkup = jsx.slice(jsx.indexOf('session-status-line'), jsx.indexOf('session-status-line') + 400)
    const sizes = [...lineMarkup.matchAll(/text-\[(\d+)px\]/g)].map(m => Number(m[1]))
    for (const s of sizes) expect(s).toBeLessThanOrEqual(10)
  })
})

describe('compact controls are rounded rectangles, never capsules', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8')

  it('uses a 7px radius token and no 9999px anywhere in the control styles', () => {
    expect(css).toMatch(/--control-radius:\s*7px/)
    const block = css.slice(css.indexOf('.compact-control'))
    expect(block).not.toMatch(/border-radius:\s*9999px/)
    expect(block).not.toMatch(/rounded-full/)
  })

  it('normal is blue-on-blue and danger is red-on-red', () => {
    expect(css).toMatch(/\.button-normal[^{]*\{[^}]*color:\s*var\(--normal-text\)/)
    expect(css).toMatch(/\.button-danger[^{]*\{[^}]*color:\s*var\(--danger-text\)/)
  })

  it('keeps a real hit target despite 2px visual padding', () => {
    const block = css.slice(css.indexOf('.compact-control::before'))
    expect(block).toMatch(/min-height:\s*32px/)
    // 36px on coarse pointers — the owner's explicit choice (M3 audit item 3,
    // 2026-07-31), below both HIG 44 and M3 48, picked for this desk's
    // density. The guard still exists so a future edit cannot silently drop
    // the coarse-pointer bump altogether.
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]{0,400}min-height:\s*36px/)
  })

  it('honours prefers-reduced-motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]{0,160}\.compact-control\s*\{\s*transition:\s*none/)
  })
})
