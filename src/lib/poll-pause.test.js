// npx vitest run src/lib/poll-pause.test.js
//
// MANUAL POLL PAUSE (owner 2026-07-30): "Have a capable to pause
// webpage-client-sided-spool/update at the Account details as a button."
//
// The design value is that it folds into pageAsleep() — the one function EVERY
// poll loop in the app already calls before doing work. A separate flag would
// have to be threaded through a dozen components, and the one that got missed
// would keep polling while the UI claimed to be paused. These tests pin that.
//
// This project's vitest environment is `node` (vite.config.js), so there is no
// real localStorage. Rather than add jsdom for one test, a Map-backed shim is
// installed on globalThis before the module is imported — which exercises the
// REAL code path (agent-api reads localStorage lazily inside try/catch) instead
// of a parallel fake of it.
import { test, expect, beforeEach } from 'vitest'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const api = await import('./agent-api.js')

beforeEach(() => { store.clear() })

test('default is NOT paused — a fresh browser must poll', () => {
  expect(api.isPollPaused()).toBe(false)
})

test('pausing makes pageAsleep true, and resuming restores the prior state', () => {
  const before = api.pageAsleep()
  api.setPollPaused(true)
  expect(api.isPollPaused()).toBe(true)
  expect(api.pageAsleep()).toBe(true)
  api.setPollPaused(false)
  // Resuming must not force-wake a tab that is hidden or idle for other
  // reasons — pause is one term in the OR, not an override of the others.
  expect(api.pageAsleep()).toBe(before)
})

test('the pause persists so it survives navigation between pages', () => {
  api.setPollPaused(true)
  expect(store.get('poll_paused')).toBe('true')
  expect(api.isPollPaused()).toBe(true)
  api.setPollPaused(false)
  expect(api.isPollPaused()).toBe(false)
})

test('only the literal string "true" counts as paused', () => {
  // A stray value must not silently freeze the whole UI.
  for (const junk of ['yes', '1', 'TRUE', '', 'null']) {
    store.set('poll_paused', junk)
    expect(api.isPollPaused()).toBe(false)
  }
})

test('subscribers fire on change and unsubscribe cleanly', () => {
  let hits = 0
  const off = api.subscribePollPaused(() => { hits += 1 })
  api.setPollPaused(true)
  api.setPollPaused(false)
  expect(hits).toBe(2)
  off()
  api.setPollPaused(true)
  expect(hits).toBe(2)
})

test('one throwing subscriber does not starve the others', () => {
  let good = 0
  const offBad = api.subscribePollPaused(() => { throw new Error('boom') })
  const offGood = api.subscribePollPaused(() => { good += 1 })
  api.setPollPaused(true)
  expect(good).toBe(1)
  offBad(); offGood()
})
