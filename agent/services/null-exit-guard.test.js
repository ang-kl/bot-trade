// node --test agent/services/null-exit-guard.test.js
//
// The two rules from §5490, pinned. See null-exit-guard.js for the fourteen
// days of production that produced them; this file is about the edges, which
// is where a guard on the close path either saves money or causes an incident.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mayClose, nullExitVerdict, CLOSE_AUTHORITY, FLOOR_EXEMPT_WRITERS,
  DEFAULT_NULL_EXIT_MIN_R,
} from './null-exit-guard.js'

test('llm_monitor holds no close authority', () => {
  assert.equal(mayClose('llm_monitor'), false)
  const v = nullExitVerdict({ writer: 'llm_monitor', currentR: -2.06, reason: 'thesis broken' })
  assert.equal(v.block, true)
  assert.match(v.why, /no_close_authority/)
})

test('an unknown writer cannot close either — the list is an allow-list', () => {
  assert.equal(mayClose('some_new_module'), false)
  assert.equal(mayClose(''), false)
  assert.equal(mayClose(undefined), false)
})

test('a discretionary close at breakeven is refused', () => {
  for (const r of [0, 0.02, -0.05, 0.099, -0.0999]) {
    const v = nullExitVerdict({ writer: 'position_manager', currentR: r, reason: 'momentum faded' })
    assert.equal(v.block, true, `r=${r} should be refused`)
    assert.match(v.why, /null_exit/)
  }
})

test('a close with real R behind it goes through', () => {
  for (const r of [0.1, 0.5, 2.3, -0.11, -1.4]) {
    const v = nullExitVerdict({ writer: 'position_manager', currentR: r, reason: 'momentum faded' })
    assert.equal(v.block, false, `r=${r} should pass`)
  }
})

// ---------------------------------------------------------------------------
// The three ways this guard could cause an incident instead of preventing one.
// ---------------------------------------------------------------------------

test('a protection writer is NEVER blocked, at any R', () => {
  // This is the case that matters most. A floor standing between the equity
  // stop and an exit would be far worse than the churn it was built to stop.
  for (const w of FLOOR_EXEMPT_WRITERS) {
    for (const r of [0, 0.001, -0.02]) {
      const v = nullExitVerdict({ writer: w, currentR: r, reason: 'whatever' })
      assert.equal(v.block, false, `${w} must be able to close at r=${r}`)
    }
  }
  // and every exempt writer must actually HOLD close authority, or the
  // exemption is describing something that cannot happen
  for (const w of FLOOR_EXEMPT_WRITERS) {
    assert.ok(CLOSE_AUTHORITY.includes(w), `${w} is floor-exempt but cannot close`)
  }
})

test('an unknown R is unknown, not zero — the close proceeds', () => {
  for (const r of [null, undefined, NaN, 'abc', Infinity]) {
    const v = nullExitVerdict({ writer: 'position_manager', currentR: r, reason: 'momentum faded' })
    assert.equal(v.block, false, `r=${String(r)} must not be read as breakeven`)
    assert.equal(v.why, 'r_unknown')
  }
})

test('a reason that names a purpose overrides the floor', () => {
  const reasons = [
    'thesis invalidated by the 15m close',
    'time_cap expired',
    'equity_stop daily drawdown',
    'margin headroom exhausted',
    'weekend flatten',
    'owner asked via telegram',
  ]
  for (const reason of reasons) {
    const v = nullExitVerdict({ writer: 'position_manager', currentR: 0.001, reason })
    assert.equal(v.block, false, `"${reason}" should override the floor`)
    assert.equal(v.why, 'reason_names_a_purpose')
  }
})

test('the floor is configurable, and zero turns it off entirely', () => {
  const at = (minR) => nullExitVerdict({ writer: 'fast_monitor', currentR: 0.3, reason: 'x', minR })
  assert.equal(at(0.1).block, false, '0.3R is outside a 0.1 floor')
  assert.equal(at(0.5).block, true, '0.3R is inside a 0.5 floor')
  // An operator who sets it to 0 asked for it off and gets exactly that.
  assert.equal(nullExitVerdict({ writer: 'fast_monitor', currentR: 0, reason: 'x', minR: 0 }).block, false)
  assert.equal(nullExitVerdict({ writer: 'fast_monitor', currentR: 0, reason: 'x', minR: -1 }).block, false)
  // Junk falls back to the default rather than disabling the guard silently.
  assert.equal(nullExitVerdict({ writer: 'fast_monitor', currentR: 0, reason: 'x', minR: 'abc' }).block, true)
  assert.equal(DEFAULT_NULL_EXIT_MIN_R, 0.1)
})

test('the default lands where the measurement said it should', () => {
  // 26 of 31 explicit closes on 47790949 sat inside 0.1R. A floor that does
  // not catch a 0.074R exit — position_manager's BEST in fourteen days —
  // would not have changed anything about the fortnight that prompted it.
  assert.equal(nullExitVerdict({ writer: 'position_manager', currentR: 0.074, reason: 'trim' }).block, true)
})
