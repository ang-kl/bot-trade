import { describe, expect, it } from 'vitest'
import { serverReadingsNotice } from './server-readings.js'

const timeText = () => '16:00:00'
const base = { source: 'server', intervalMs: 60_000, at: '2026-09-25T16:00:00.000Z', failed: [], missing: [] }

describe('serverReadingsNotice (V3 WEB-4)', () => {
  it('says nothing when the server read every account and is current, or when an older agent sends no field', () => {
    expect(serverReadingsNotice({ ...base, status: 'success', fresh: true }, { timeText })).toBe(null)
    expect(serverReadingsNotice(undefined)).toBe(null)
  })
  it('names a stale reading with its last completed round and the latest reason', () => {
    const text = serverReadingsNotice({ ...base, status: 'failed', fresh: false, reason: 'no_access_token' }, { timeText })
    expect(text).toMatch(/out of date/)
    expect(text).toMatch(/last completed round 16:00:00/)
    expect(text).toMatch(/no access token/)
  })
  it('names every account a current round could not read, and why', () => {
    const text = serverReadingsNotice({ ...base, status: 'partial', fresh: true,
      failed: [{ accountId: '22', reason: 'broker_timeout' }], missing: ['33'] }, { timeText })
    expect(text).toBe('The latest server reading did not read 2 accounts: 22 (broker timeout), 33 (not on the broker token); last completed round 16:00:00.')
  })
  it('a failed attempt after a still-current round is reported, not hidden', () => {
    expect(serverReadingsNotice({ ...base, status: 'failed', fresh: true, reason: 'readings_timeout' }, { timeText }))
      .toBe('The latest server reading failed (readings timeout); last completed round 16:00:00.')
  })
  it('no record yet is said plainly', () => {
    expect(serverReadingsNotice({ ...base, status: 'no_record', at: null, fresh: false }, { timeText })).toMatch(/has not recorded/)
  })
})
