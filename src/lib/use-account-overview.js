import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'

// Fast current readings are independent of historical-report workers. One
// lightweight cache read serves every account; browser polls never call brokers.
export function useAccountOverview() {
  const [report, setReport] = useState(null)
  useEffect(() => {
    let stopped = false, running = false
    const refresh = async () => {
      if (stopped || running || pageAsleep() || !agentConfigured()) return
      running = true
      try {
        const r = await agentGet('/state/account-overview')
        if (!stopped) setReport(Array.isArray(r.accounts) ? r : null)
      } catch { if (!stopped) setReport(null) }
      finally { running = false }
    }
    const kick = setTimeout(refresh, 0), timer = setInterval(refresh, 10_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('agent-wake', refresh)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh); window.removeEventListener('agent-wake', refresh) }
  }, [])
  return report
}
