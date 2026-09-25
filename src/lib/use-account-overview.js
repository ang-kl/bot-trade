import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'

// Fast current readings are independent of historical-report workers. One
// lightweight cache read serves every account.
//
// V3 WEB-4: the page is no longer the poller. The server reads every account
// from the broker once a minute on its own ticker (agent/services/
// broker-readings.js), whether or not a page is open, and this page only reads
// the cached overview. It asks the broker for nothing; the overview's
// `serverReadings` says how the server's own reading is doing.
export const OVERVIEW_POLL_MS = 10_000

/** The page's only timer: GET /state/account-overview. Returns a stop function. */
export function startOverviewPolling(onReport, {
  get = agentGet, asleep = pageAsleep, configured = agentConfigured,
  timers = globalThis, target = typeof document === 'undefined' ? null : document,
  win = typeof window === 'undefined' ? null : window, everyMs = OVERVIEW_POLL_MS,
} = {}) {
  let stopped = false, running = false
  const refresh = async () => {
    if (stopped || running || asleep() || !configured()) return
    running = true
    try {
      const r = await get('/state/account-overview')
      if (!stopped) onReport(Array.isArray(r?.accounts) ? r : null)
    } catch { if (!stopped) onReport(null) }
    finally { running = false }
  }
  const kick = timers.setTimeout(refresh, 0), timer = timers.setInterval(refresh, everyMs)
  target?.addEventListener('visibilitychange', refresh)
  win?.addEventListener('agent-wake', refresh)
  return () => {
    stopped = true; timers.clearTimeout(kick); timers.clearInterval(timer)
    target?.removeEventListener('visibilitychange', refresh); win?.removeEventListener('agent-wake', refresh)
  }
}

export function useAccountOverview() {
  const [report, setReport] = useState(null)
  useEffect(() => startOverviewPolling(setReport), [])
  return report
}
