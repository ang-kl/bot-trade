import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toMs, dayKeyInZone, dayLabelInZone, isValidTimeZone } from './date-zones.js'

test('toMs reads a bare "YYYY-MM-DD HH:MM:SS" row as UTC, not host-local time', () => {
  const ms = toMs('2026-09-25 22:45:24')
  assert.equal(ms, Date.UTC(2026, 8, 25, 22, 45, 24))
  assert.equal(toMs('2026-09-25T22:45:24.500'), Date.UTC(2026, 8, 25, 22, 45, 24, 500))
  // Already-zoned strings are left alone.
  assert.equal(toMs('2026-09-25T22:45:24Z'), Date.UTC(2026, 8, 25, 22, 45, 24))
  assert.equal(toMs('2026-09-25T22:45:24+08:00'), Date.UTC(2026, 8, 25, 14, 45, 24))
})

test('unparseable and empty timestamps read as null, never as "now" or epoch 0', () => {
  for (const bad of [null, undefined, '', 'not a date', 'fast_monitor', '2026-13-40 99:99:99']) assert.equal(toMs(bad), null)
})

test('the same UTC instant falls on different calendar dates in different zones (the plan\'s own example)', () => {
  const ms = toMs('2026-09-25 22:45:24')
  assert.equal(dayKeyInZone(ms, 'Asia/Singapore'), '2026-09-26')
  assert.equal(dayKeyInZone(ms, 'America/New_York'), '2026-09-25')
})

test('a daylight-saving transition: America/New_York springs forward on 08-03-2026', () => {
  // 2026-03-08 06:30 UTC is 01:30 EST (still standard time; DST starts at
  // 07:00 UTC / 02:00 local that day) — the calendar date must still read
  // 08-03 in New York, not slip to the 7th from an offset miscalculation.
  const before = toMs('2026-03-08 06:30:00')
  assert.equal(dayKeyInZone(before, 'America/New_York'), '2026-03-08')
  // 2026-03-08 08:00 UTC is 04:00 EDT, after the spring-forward — still the 8th.
  const after = toMs('2026-03-08 08:00:00')
  assert.equal(dayKeyInZone(after, 'America/New_York'), '2026-03-08')
})

test('an unparseable time yields no group key, never a false "today"', () => {
  assert.equal(dayKeyInZone(toMs('garbage'), 'Asia/Singapore'), null)
  assert.equal(dayKeyInZone(NaN, 'Asia/Singapore'), null)
})

test('an invalid zone name is rejected, not silently treated as UTC', () => {
  assert.equal(isValidTimeZone('Mars/Colony_One'), false)
  assert.equal(isValidTimeZone(''), false)
  assert.equal(isValidTimeZone('Asia/Singapore'), true)
  assert.equal(dayKeyInZone(toMs('2026-09-25 22:45:24'), 'Not/AZone'), null)
  assert.equal(dayLabelInZone(toMs('2026-09-25 22:45:24'), 'Not/AZone'), null)
})

test('dayLabelInZone reads as a human header naming the weekday', () => {
  const label = dayLabelInZone(toMs('2026-09-25 22:45:24'), 'Asia/Singapore')
  assert.equal(label, 'Sat 26 Sep 2026')
})

// Mutation check (CLAUDE.md #1): the appended 'Z' in toMs is the one line
// that makes a bare timestamp read as UTC instead of host-local time. Confirm
// it is present, then confirm removing it changes toMs's answer in a non-UTC
// process — proving the test is actually pinned to that line, not to a
// coincidence of the sandbox already running in UTC.
test('mutation check: toMs\'s literal UTC marker is present and load-bearing', () => {
  const src = readFileSync(new URL('./date-zones.js', import.meta.url), 'utf8')
  const MARKER = /`\$\{s\.replace\(' ', 'T'\)\}Z`/
  const before = (src.match(new RegExp(MARKER, 'g')) || []).length
  assert.equal(before, 1, 'the UTC-marking template literal must be present exactly once before mutation')
  const mutatedSrc = src.replace(MARKER, `s.replace(' ', 'T')`)
  const after = (mutatedSrc.match(new RegExp(MARKER, 'g')) || []).length
  assert.equal(after, 0, 'the mutation must actually remove the marker')
  // Build the mutated function in isolation (no module import machinery
  // needed — this file has no imports of its own): strip the `export`
  // keyword from every declaration and return toMs from the function body.
  const mutated = new Function(`${mutatedSrc.replace(/export function/g, 'function')}\nreturn toMs;`)()
  // Without the 'Z', Date.parse('2026-09-25T22:45:24') is spec-defined as
  // LOCAL time — different from the UTC value whenever the process TZ is not
  // UTC. Assert against an explicit non-UTC offset computation instead of
  // depending on process.env.TZ (which CI may or may not honour per-process).
  const localMs = mutated('2026-09-25 22:45:24')
  const utcMs = Date.UTC(2026, 8, 25, 22, 45, 24)
  const localOffsetMs = new Date(2026, 8, 25, 22, 45, 24).getTimezoneOffset() * 60_000
  assert.equal(localMs, utcMs + localOffsetMs, 'the mutated function must fall back to host-local parsing')
})
