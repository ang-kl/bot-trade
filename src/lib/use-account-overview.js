import { useEffect, useState } from 'react'
import { refreshBrokerOverview } from './broker-overview.js'
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'

// Fast current readings are independent of historical-report workers. One
// lightweight cache read serves every account. The shared slower broker read
// refreshes the source independently and never holds up the first paint.
export function useAccountOverview() {
  const [report, setReport] = useState(null), [refreshError, setRefreshError] = useState(null)
  useEffect(() => {
    let stopped = false, running = false, refreshingBroker = false
    const refresh = async () => {
      if (stopped || running || pageAsleep() || !agentConfigured()) return
      running = true
      try {
        const r = await agentGet('/state/account-overview')
        if (!stopped) setReport(Array.isArray(r.accounts) ? r : null)
      } catch { if (!stopped) setReport(null) }
      finally { running = false }
    }
    const refreshSource = async () => {
      if (stopped || refreshingBroker || pageAsleep() || !agentConfigured()) return
      refreshingBroker = true
      try { await refreshBrokerOverview(); if (!stopped) { setRefreshError(null); await refresh() } }
      catch (e) { if (!stopped) setRefreshError(e.message) }
      finally { refreshingBroker = false }
    }
    const wake = () => { refresh(); refreshSource() }
    const kick = setTimeout(wake, 0), timer = setInterval(refresh, 10_000)
    const brokerTimer = setInterval(refreshSource, 60_000)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('agent-wake', wake)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer); clearInterval(brokerTimer)
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('agent-wake', wake) }
  }, [])
  return report ? { ...report, refreshError } : null
}
