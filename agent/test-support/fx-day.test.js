// node --test agent/test-support/fx-day.test.js
// Claude · № 15,07x 16-Oct (follow-up #70; claude-builder). Expected outcomes:
// the FX day opens at 17:00 New York (risk.js fxDayOpenMs); the two gate
// failures of 16-10 05:0x SGT (account-currency, account-pregate) were
// fixtures stamping "5 minutes ago" across that open.
import test from 'node:test'
import assert from 'node:assert/strict'
import { clampToFxDay } from './fx-day.js'
import { fxDayOpenMs } from '../services/risk.js'

test('clampToFxDay: "5 minutes ago" at 21:02 UTC lands one second past the 21:00 open, not in yesterday', () => {
  const now = Date.UTC(2026, 9, 15, 21, 2) // 15-10 21:02 UTC = 17:02 New York, two minutes into the FX day
  const open = fxDayOpenMs(now)
  assert.equal(open, Date.UTC(2026, 9, 15, 21, 0))
  const at = clampToFxDay(5, now)
  assert.equal(at, '2026-10-15 21:00:01', 'RED before in the fixtures: datetime(now, -5 minutes) read 20:57, before the open')
  assert.equal(clampToFxDay(5, now + 3_600_000), '2026-10-15 21:57:00', 'an hour later the intent "5 minutes ago" stands')
})
