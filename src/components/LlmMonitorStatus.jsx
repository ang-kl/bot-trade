// LlmMonitorStatus — owner (2026-07-27): "I need to be alerted if any of
// the LLM failed and you still continue... messaged within the web-pages
// or telegram this tiny icon." Telegram side lives in agent/loop.js +
// services/llm-monitor-health.js; this is the web-page half — a small
// badge that only appears once the LLM monitor has actually gone
// degraded (a few consecutive failures, not one blip), so it stays out
// of the way the rest of the time.
import { useEffect, useState } from 'react'
import { agentGet, pageHidden } from '../lib/agent-api.js'

const POLL_MS = 60_000

export default function LlmMonitorStatus() {
  const [health, setHealth] = useState(null)

  useEffect(() => {
    let alive = true
    const poll = () => {
      agentGet('/state/llm-monitor-health')
        .then(h => { if (alive) setHealth(h) })
        .catch(() => { /* best effort — absence is not itself alarming */ })
    }
    poll()
    const t = setInterval(() => { if (!pageHidden()) poll() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!health?.degraded) return null

  const title = `LLM monitor unavailable — ${health.failStreak} consecutive failures. Trading continues (deterministic rules + broker SL/TP unaffected). Last error: ${health.lastFailReason || 'unknown'}`

  return (
    <img
      src="/llm-monitor-failed.png"
      alt="LLM monitor degraded"
      title={title}
      className="w-4 h-4 shrink-0"
    />
  )
}
