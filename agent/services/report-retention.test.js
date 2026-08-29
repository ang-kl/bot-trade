// node --test agent/services/report-retention.test.js
//
// The backtest-results folder held 4.7GB nobody ever pruned (measured
// 2026-08-29: 2,551 HTML reports, ~1.8MB each, autopilot writing ~40/day).
// The properties that matter: newest are KEPT, the autopilot firehose and
// the rarer manual reports have separate allowances, explicit null disables
// (same convention as retention.js horizons), and a missing folder is a
// no-op rather than a throw.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pruneReports, REPORT_RETENTION_DEFAULTS } from './report-retention.js'

function seed(dir, names) {
  fs.mkdirSync(dir, { recursive: true })
  for (const n of names) fs.writeFileSync(path.join(dir, n), `<html>${n}</html>`)
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'))

test('keeps the NEWEST N of each class and deletes the rest', () => {
  const dir = tmp()
  const auto = Array.from({ length: 6 }, (_, i) => `autopilot-2026-08${20 + i}_01.html`)
  const manual = ['2026-0810_01.html', '2026-0811_01.html', '2026-0812_01.html']
  seed(dir, [...auto, ...manual])
  const out = pruneReports({ reportsKeepAutopilot: 2, reportsKeepManual: 2 }, dir)
  assert.equal(out.scanned, 9)
  assert.equal(out.deleted, 5) // 4 autopilot + 1 manual
  assert.ok(out.freedBytes > 0)
  const left = fs.readdirSync(dir).sort()
  assert.deepEqual(left, ['2026-0811_01.html', '2026-0812_01.html',
    'autopilot-2026-0824_01.html', 'autopilot-2026-0825_01.html'],
  'the newest of each class survive — deleting newest-first would destroy the reports people still open')
})

test('explicit null disables a class; defaults apply when unset', () => {
  const dir = tmp()
  seed(dir, Array.from({ length: 4 }, (_, i) => `autopilot-2026-082${i}_01.html`))
  const out = pruneReports({ reportsKeepAutopilot: null, reportsKeepManual: null }, dir)
  assert.equal(out.deleted, 0, 'null means the sweep is off, like every retention horizon')
  assert.equal(REPORT_RETENTION_DEFAULTS.reportsKeepAutopilot, 100)
  const out2 = pruneReports({}, dir)
  assert.equal(out2.deleted, 0, '4 files under the default 100 allowance — nothing to do')
})

test('a folder that does not exist is a quiet no-op', () => {
  const out = pruneReports({}, path.join(os.tmpdir(), 'nope-' + Date.now()))
  assert.deepEqual(out, { scanned: 0, deleted: 0, freedBytes: 0, kept: 0, errors: 0 })
})

test('non-html files are never touched', () => {
  const dir = tmp()
  seed(dir, ['autopilot-2026-0820_01.html', 'autopilot-2026-0821_01.html'])
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
  const out = pruneReports({ reportsKeepAutopilot: 1, reportsKeepManual: 1 }, dir)
  assert.equal(out.deleted, 1)
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')))
})
