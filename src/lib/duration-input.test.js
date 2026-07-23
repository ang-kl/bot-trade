import { describe, it, expect } from 'vitest'
import { parseDurationToMinutes, formatMinutesShort } from './duration-input.js'

describe('parseDurationToMinutes', () => {
  it('parses a bare number as minutes (back-compat with the old field unit)', () => {
    expect(parseDurationToMinutes('5')).toBe(5)
    expect(parseDurationToMinutes('0')).toBe(0)
    expect(parseDurationToMinutes('1.5')).toBe(1.5)
  })
  it('parses m/s/h suffixes', () => {
    expect(parseDurationToMinutes('5m')).toBe(5)
    expect(parseDurationToMinutes('30s')).toBe(0.5)
    expect(parseDurationToMinutes('2h')).toBe(120)
    expect(parseDurationToMinutes('1.5h')).toBe(90)
  })
  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseDurationToMinutes(' 5M ')).toBe(5)
    expect(parseDurationToMinutes('2 H')).toBe(120)
  })
  it('treats "off" as 0', () => {
    expect(parseDurationToMinutes('off')).toBe(0)
    expect(parseDurationToMinutes('OFF')).toBe(0)
  })
  it('rejects garbage, negatives, and empty input', () => {
    expect(parseDurationToMinutes('abc')).toBe(null)
    expect(parseDurationToMinutes('5mm')).toBe(null)
    expect(parseDurationToMinutes('-5m')).toBe(null)
    expect(parseDurationToMinutes('')).toBe(null)
    expect(parseDurationToMinutes(null)).toBe(null)
    expect(parseDurationToMinutes(undefined)).toBe(null)
  })
})

describe('formatMinutesShort', () => {
  it('round-trips the exact values parseDurationToMinutes produces', () => {
    expect(formatMinutesShort(0)).toBe('off')
    expect(formatMinutesShort(0.5)).toBe('30s')
    expect(formatMinutesShort(5)).toBe('5m')
    expect(formatMinutesShort(120)).toBe('2h')
  })
  it('falls back to minutes when the value is not a clean hour/second boundary', () => {
    expect(formatMinutesShort(90)).toBe('90m')
    expect(formatMinutesShort(1.5)).toBe('1.5m')
  })
  it('returns an empty string for invalid input', () => {
    expect(formatMinutesShort(null)).toBe('')
    expect(formatMinutesShort(undefined)).toBe('')
    expect(formatMinutesShort(NaN)).toBe('')
  })
})
