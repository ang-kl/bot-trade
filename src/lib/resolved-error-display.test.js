// npx vitest run src/lib/resolved-error-display.test.js
//
// Owner, 22-08-2026, reading the Desk panel:
//
//   Pending-order manager
//   STALLED · cTrader error: CH_CLIENT_AUTH_FAILURE — clientId or clientSecret is inc
//
// The stall was real. The error was not — CH_CLIENT_AUTH_FAILURE belongs to
// the 03:02–03:22 UTC window documented in agent/lib/ctrader-env.js, hours
// resolved by then, and the live fault that morning was a token that covered
// two accounts instead of seven. beat() keeps last_error across a later
// success ON PURPOSE (heartbeat.js:376) because it is useful forensics, and
// the API already ships `error_is_current` to say which kind it is.
//
// AgentHealthPanel.jsx has honoured that flag since 04-08. Desk.jsx and
// agent-health-view.js never got the fix, so the same payload printed a
// resolved error as a live one in two of the three places it is read — and
// the panel's own comment predicted the cost exactly: "an error that cannot
// go away teaches the operator to stop reading errors."

import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toText } from './agent-health-view.js'

const stalled = (extra) => ({
  health: { uptime: 60, lastLoopMs: 1000, errorsToday: 0 },
  controllers: [{
    name: 'pending_orders', label: 'Pending-order manager', status: 'stalled',
    age_sec: 900, expected_sec: 180,
    last_error: 'cTrader error: CH_CLIENT_AUTH_FAILURE — clientId or clientSecret is incorrect',
    consecutive_failures: 0, ...extra,
  }],
  deploy: { state: 'ok', text: 'live' },
  loop: { state: 'ok', text: 'running' },
  atr: null,
})

describe('a resolved error is labelled as history', () => {
  test('THE PRODUCTION LINE: error_is_current false is marked resolved', () => {
    const out = toText(stalled({ error_is_current: false }))
    expect(out).toContain('CH_CLIENT_AUTH_FAILURE')
    expect(out).toContain('last error (resolved)')
  })

  test('a CURRENT error is still shown bare — the alarm must keep working', () => {
    // The fix must not soften a live failure into history; that would be the
    // same defect pointed the other way.
    const out = toText(stalled({ error_is_current: true, consecutive_failures: 3 }))
    expect(out).toContain('CH_CLIENT_AUTH_FAILURE')
    expect(out).not.toContain('resolved')
  })

  test('an OLDER payload with no flag at all is shown bare, not mislabelled', () => {
    // `=== false` and not falsy: an absent field must not silently downgrade a
    // real error to history.
    const out = toText(stalled({}))
    expect(out).not.toContain('resolved')
  })

  test('the stall itself is still reported either way', () => {
    for (const flag of [{ error_is_current: false }, { error_is_current: true }]) {
      expect(toText(stalled(flag))).toContain('Pending-order manager')
    }
  })
})

describe('the Desk page reads the same flag', () => {
  // Desk.jsx is a full page component that mounts the entire desk; there is no
  // seam to render this one row through. Source is a last resort and treated
  // as one — comments are stripped first, because this file's own prose and
  // Desk's explanatory comment both contain the string being asserted on
  // (failure mode #2).
  const src = readFileSync(new URL('../pages/Desk.jsx', import.meta.url), 'utf8')
  const start = src.indexOf('{heartbeats.map(c => {')
  const code = src.slice(start, start + 3000)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('the controller row consults error_is_current before printing last_error', () => {
    expect(start).toBeGreaterThan(0)
    expect(code).toContain('c.last_error')          // the slice really holds the row
    expect(code).toContain('error_is_current')
    expect(code).toContain('last error (resolved)')
  })
})
