import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTROLLERS } from './heartbeat.js'
import { CONTROLLER_GROUPS, RETIRED_CONTROLLERS, groupControllers } from '../shared/controller-groups.js'

test('every registered heartbeat is mapped exactly once; retired history is separate', () => {
  const names = [...CONTROLLER_GROUPS.flatMap(g => g.names), ...RETIRED_CONTROLLERS]
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names].sort(), Object.keys(CONTROLLERS).sort())
  const view = groupControllers(Object.entries(CONTROLLERS).map(([name, d]) => ({ name, label: d.label, status: d.retired ? 'retired' : 'idle', retired: !!d.retired })))
  assert.equal(view.groups.length, 6)
  assert.equal(view.groups.flatMap(g => g.rows).length, 38) // V3 L1: order_lifecycle; V3 V1: position_capture; V3 WEB-4: broker_readings; V3 T3: momentum_partial
  assert.deepEqual(view.retired.map(r => r.name), ['pending_orders'])
})

test('a healthy parent cannot hide a failing child; unknown additions remain visible', () => {
  const view = groupControllers([{ name: 'main_loop', status: 'ok' }, { name: 'fast_monitor', status: 'stalled' }, { name: 'new_worker', status: 'error' }])
  assert.deepEqual(view.exceptions.map(r => r.name), ['fast_monitor', 'new_worker'])
  assert.deepEqual(view.unmapped.map(r => r.name), ['new_worker'])
  assert.equal(groupControllers(null), null)
})
