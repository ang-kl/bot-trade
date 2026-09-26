// node --test agent/services/client-presence.test.js
//
// NEW-1 (integrated plan 26-09-2026): a harness load (the DevTools trace in
// scripts/perf-trace/, any headless run) pings /state/client-ping like the
// owner's tab did, and the M3 record counted 9 and 8 "visible tabs" that were
// trace loads. A ping tagged `synthetic` must leave the owner's counts
// unchanged, be counted as its own number, and keep its row (principle 6:
// counted apart, never deleted).
//
// The roster is module-global and in-memory, so every assertion here is a
// DELTA against a summary taken just before — other tabs in the map (from
// tests earlier in this file) cannot make a check pass or fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerClientPing, clientSummary, syntheticTag } from './client-presence.js'
import { compactHealth } from './p1p4-grade.js'
import { initDB } from '../db.js'
import stateRouter from '../routes/state.js'

let seq = 0
const uid = (p) => `${p}-${process.pid}-${++seq}`

test('a synthetic-tagged ping leaves openTabs and visibleTabs unchanged and is counted as synthetic', () => {
  const now = Date.now()
  const before = clientSummary(now)
  const id = uid('trace')
  registerClientPing({ tab: id, tz: 'Asia/Singapore', page: '/performance', hidden: 'false', idle: 'false', synthetic: 'trace' }, now)
  const after = clientSummary(now)
  assert.equal(after.visibleTabs, before.visibleTabs, 'a trace tab is not one of the owner\'s visible tabs')
  assert.equal(after.openTabs, before.openTabs, 'a trace tab is not one of the owner\'s open tabs')
  assert.equal(after.synthetic.visibleTabs, before.synthetic.visibleTabs + 1)
  assert.equal(after.synthetic.openTabs, before.synthetic.openTabs + 1)
  assert.ok(after.synthetic.tags.includes('trace'))
  // Counted apart, not hidden: the row is still in the roster, labelled.
  const row = after.tabs.find(t => t.id === id)
  assert.ok(row, 'the synthetic tab keeps its row')
  assert.equal(row.synthetic, 'trace')
  assert.equal(row.status, 'active')
})

test('an untagged ping counts as a visible owner tab and not as synthetic', () => {
  const now = Date.now()
  const before = clientSummary(now)
  const id = uid('owner')
  registerClientPing({ tab: id, tz: 'Asia/Singapore', page: '/desk', hidden: 'false', idle: 'false' }, now)
  const after = clientSummary(now)
  assert.equal(after.visibleTabs, before.visibleTabs + 1)
  assert.equal(after.openTabs, before.openTabs + 1)
  assert.equal(after.synthetic.openTabs, before.synthetic.openTabs)
  assert.equal(after.tabs.find(t => t.id === id).synthetic, null)
})

test('the tag is sticky per tab: a later untagged ping (close beacon, reload) does not make it an owner tab', () => {
  const now = Date.now()
  const before = clientSummary(now)
  const id = uid('sticky')
  registerClientPing({ tab: id, page: '/risk', hidden: 'false', idle: 'false', synthetic: 'trace' }, now)
  registerClientPing({ tab: id, page: '/risk', hidden: 'false', idle: 'false' }, now + 1)
  const after = clientSummary(now + 1)
  assert.equal(after.visibleTabs, before.visibleTabs)
  assert.equal(after.synthetic.openTabs, before.synthetic.openTabs + 1)
})

test('a malformed or negative flag never hides an owner tab', () => {
  for (const v of ['', 'false', '0', 'null', 'undefined', 'has space', 'x'.repeat(33), '<script>']) {
    assert.equal(syntheticTag(v), null, JSON.stringify(v))
  }
  assert.equal(syntheticTag('Trace'), 'trace')
  assert.equal(syntheticTag('headless-ci_1'), 'headless-ci_1')
  const now = Date.now()
  const before = clientSummary(now)
  registerClientPing({ tab: uid('neg'), page: '/desk', hidden: 'false', idle: 'false', synthetic: 'false' }, now)
  assert.equal(clientSummary(now).visibleTabs, before.visibleTabs + 1)
})

test('the P1/P4 grader: a window seen only by trace tabs is not representative, and trace pages are not listed', () => {
  const now = Date.now()
  const id = uid('grader')
  registerClientPing({ tab: id, page: '/synthetic-only-page', hidden: 'false', idle: 'false', synthetic: 'trace' }, now)
  const summary = clientSummary(now)
  const h = compactHealth({ clients: summary })
  assert.ok(!h.tabs.pages.includes('/synthetic-only-page'), 'a trace tab\'s page is not an owner-visible page')
  assert.equal(h.tabs.visible, summary.visibleTabs)
  assert.equal(h.tabs.synthetic.visible, summary.synthetic.visibleTabs)
  // Only harness tabs visible: the owner saw nothing.
  const onlyTrace = compactHealth({ clients: { openTabs: 0, visibleTabs: 0, synthetic: { openTabs: 1, visibleTabs: 1 }, tabs: [{ id, page: '/performance', status: 'active', synthetic: 'trace' }] } })
  assert.equal(onlyTrace.tabs.visible, 0)
  assert.deepEqual(onlyTrace.tabs.pages, [])
  // An older build's body (no `synthetic` field) keeps the old shape.
  assert.deepEqual(compactHealth({ clients: { openTabs: 1, visibleTabs: 1, tabs: [{ page: '/desk', status: 'active' }] } }).tabs, { open: 1, visible: 1, pages: ['/desk'] })
})

test('GET /state/client-ping carries ?synthetic= through to the roster', async () => {
  const db = initDB(':memory:')
  const app = express()
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const trace = uid('route-trace')
    const owner = uid('route-owner')
    const b0 = clientSummary()
    const r1 = await (await fetch(`${base}/state/client-ping?tab=${trace}&tz=Asia/Singapore&page=/trade&hidden=false&idle=false&synthetic=trace`)).json()
    const r2 = await (await fetch(`${base}/state/client-ping?tab=${owner}&tz=Asia/Singapore&page=/desk&hidden=false&idle=false`)).json()
    assert.equal(r1.visibleTabs, b0.visibleTabs, 'the tagged ping added no owner-visible tab')
    assert.equal(r1.synthetic.openTabs, b0.synthetic.openTabs + 1, 'the tagged ping is counted as synthetic')
    assert.equal(r2.visibleTabs, r1.visibleTabs + 1, 'the untagged ping added an owner-visible tab')
    assert.equal(r2.synthetic.openTabs, r1.synthetic.openTabs)
    assert.equal(r2.tabs.find(t => t.id === trace).synthetic, 'trace')
    assert.equal(r2.tabs.find(t => t.id === owner).synthetic, null)
  } finally { server.close() }
})
