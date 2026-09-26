import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toMs, dayKeyInZone, dayLabelInZone, isValidTimeZone, groupRowsByDate, UNPARSEABLE_GROUP_KEY } from './data-table-groups.js'

test('the plan\'s own example: the same UTC instant falls on 26-09 in Asia/Singapore and 25-09 in America/New_York', () => {
  const ms = toMs('2026-09-25 22:45:24')
  expect(dayKeyInZone(ms, 'Asia/Singapore')).toBe('2026-09-26')
  expect(dayKeyInZone(ms, 'America/New_York')).toBe('2026-09-25')
})

test('unparseable times get their own group, never silently join "today"', () => {
  const groups = groupRowsByDate([
    { id: 1, at: '2026-09-25 22:45:24' },
    { id: 2, at: 'not a time' },
    { id: 3, at: null },
  ], { timeZone: 'Asia/Singapore' })
  expect(groups).toHaveLength(2)
  expect(groups[0].key).toBe('2026-09-26')
  expect(groups[0].rows.map(r => r.id)).toEqual([1])
  expect(groups[1].key).toBe(UNPARSEABLE_GROUP_KEY)
  expect(groups[1].rows.map(r => r.id).sort()).toEqual([2, 3])
})

test('a daylight-saving transition does not shift the calendar date', () => {
  // America/New_York springs forward on 08-03-2026 at 07:00 UTC. Both sides
  // of the transition must still read the 8th.
  expect(dayKeyInZone(toMs('2026-03-08 06:30:00'), 'America/New_York')).toBe('2026-03-08')
  expect(dayKeyInZone(toMs('2026-03-08 08:00:00'), 'America/New_York')).toBe('2026-03-08')
})

test('groups sort newest day first, and each carries a human label', () => {
  const groups = groupRowsByDate([
    { id: 'a', at: '2026-09-24 10:00:00' },
    { id: 'b', at: '2026-09-26 10:00:00' },
    { id: 'c', at: '2026-09-25 10:00:00' },
  ], { timeZone: 'Asia/Singapore' })
  expect(groups.map(g => g.key)).toEqual(['2026-09-26', '2026-09-25', '2026-09-24'])
  expect(groups[0].label).toBe('Sat 26 Sep 2026')
})

test('an invalid requested zone falls back to a valid default rather than throwing', () => {
  expect(() => groupRowsByDate([{ id: 1, at: '2026-09-25 22:45:24' }], { timeZone: 'Not/AZone' })).not.toThrow()
  expect(isValidTimeZone('Not/AZone')).toBe(false)
  expect(isValidTimeZone('Asia/Singapore')).toBe(true)
})

test('dayLabelInZone and dayKeyInZone both refuse an invalid zone instead of defaulting to UTC', () => {
  expect(dayKeyInZone(toMs('2026-09-25 22:45:24'), 'Not/AZone')).toBeNull()
  expect(dayLabelInZone(toMs('2026-09-25 22:45:24'), 'Not/AZone')).toBeNull()
})

// Mutation check (CLAUDE.md #1): confirm the UTC-marking literal in toMs is
// present, then confirm removing it changes the answer for a bare timestamp —
// proving the grouping tests above are actually pinned to this line.
test('mutation check: toMs\'s literal UTC marker is present and load-bearing', () => {
  const src = readFileSync(new URL('./data-table-groups.js', import.meta.url), 'utf8')
  const MARKER = /`\$\{s\.replace\(' ', 'T'\)\}Z`/
  expect((src.match(new RegExp(MARKER, 'g')) || []).length).toBe(1)
  const mutatedSrc = src.replace(MARKER, `s.replace(' ', 'T')`)
  expect((mutatedSrc.match(new RegExp(MARKER, 'g')) || []).length).toBe(0)
  const mutatedToMs = new Function(`${mutatedSrc.replace(/export function/g, 'function').replace(/export const[^\n]*\n/g, '')}\nreturn toMs;`)()
  const localMs = mutatedToMs('2026-09-25 22:45:24')
  const utcMs = Date.UTC(2026, 8, 25, 22, 45, 24)
  const localOffsetMs = new Date(2026, 8, 25, 22, 45, 24).getTimezoneOffset() * 60_000
  expect(localMs).toBe(utcMs + localOffsetMs)
})
