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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ControllerGroups from '../components/ControllerGroups.jsx'

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

describe('the Desk controller component reads the same flag', () => {
  test('resolved errors remain history and current or unlabelled errors remain current', () => {
    const desk = readFileSync(new URL('../pages/Desk.jsx', import.meta.url), 'utf8')
    expect(desk).toContain('<ControllerGroups controllers={heartbeats}')
    for (const flag of [false, true, undefined]) {
      const html = renderToStaticMarkup(createElement(ControllerGroups, { controllers: [{
        name: 'fast_monitor', label: 'Monitor', status: 'stalled',
        last_error: 'broker timeout', error_is_current: flag,
      }] }))
      expect(html).toContain('broker timeout')
      expect(html).toContain(flag === false ? 'Previous error (resolved)' : 'Current error')
      expect(html).toContain('STALLED')
    }
  })
})
