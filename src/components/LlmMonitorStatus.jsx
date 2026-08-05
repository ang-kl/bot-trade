// LlmMonitorStatus — owner (2026-07-27): "I need to be alerted if any of
// the LLM failed and you still continue... messaged within the web-pages
// or telegram this tiny icon." Telegram side lives in agent/loop.js +
// services/llm-monitor-health.js; this is the web-page half — a small
// badge that only appears once the LLM monitor has actually gone
// degraded (a few consecutive failures, not one blip), so it stays out
// of the way the rest of the time.
//
// Owner (2026-07-30): "what does the symbol no-AI mean in the navigation bar
// … This AI symbol still there, can you troubleshoot."
//
// Troubleshoot result: not a stale badge. `degraded` is derived live from
// failStreak >= 3 and recordLlmMonitorResult resets failStreak to 0 on the
// first success (services/llm-monitor-health.js:41), so the badge clears
// itself the moment one LLM call succeeds. It has stayed up because the
// failures are real and ongoing — an OpenAI 429 "you exceeded your current
// quota" on every monitor tick. Nothing in the UI can clear that; topping up
// the OpenAI billing will.
//
// What WAS a real defect: the meaning lived only in a `title` tooltip, which
// does not exist on touch. So an unexplained symbol sat in the nav with no way
// to find out what it was — exactly the owner's question. It now carries a
// visible label next to the icon, and clicking it reveals the failure reason
// and the fact that trading is unaffected.
import { useEffect, useState } from 'react'
import { agentGet, pageAsleep } from '../lib/agent-api.js'

const POLL_MS = 60_000

/** "16:02 UTC" from an ISO stamp — short enough for a nav caption. */
function hhmmUtc(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

export default function LlmMonitorStatus() {
  const [health, setHealth] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = () => {
      agentGet('/state/llm-monitor-health')
        .then(h => { if (alive) setHealth(h) })
        .catch(() => { /* best effort — absence is not itself alarming */ })
    }
    poll()
    const t = setInterval(() => { if (!pageAsleep()) poll() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!health?.degraded) return null

  const since = hhmmUtc(health.lastOkAt)
  const title = `LLM monitor unavailable — ${health.failStreak} consecutive failures. Trading continues (deterministic rules + broker SL/TP unaffected). Last error: ${health.lastFailReason || 'unknown'}`

  // The explanation is absolutely positioned. Both mount sites are flex bars
  // (the sidebar title row and the phone header) — an in-flow panel would
  // stretch the bar it lives in, so the panel floats over the page instead and
  // the badge itself stays exactly one line tall.
  return (
    <div className="relative min-w-0 shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={title}
        className="flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-left
                   text-[9px] font-semibold uppercase tracking-wide
                   text-[var(--color-warning-text)] hover:bg-[var(--color-warning-bg)]"
      >
        <img src="/llm-monitor-failed.png" alt="LLM monitor degraded" className="h-4 w-4 shrink-0" />
        {/* Label only where there is room; on a phone the icon is tappable and
            the panel below carries the same words, which is what a tooltip
            could never do on touch. */}
        <span className="hidden truncate lg:inline">No AI monitor</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-[6px] border
                        border-[var(--color-warning-border)] bg-[var(--color-surface)]
                        px-2 py-1.5 text-[9px] leading-snug shadow-lg
                        text-[var(--color-warning-text)]">
          <div className="font-semibold">
            The LLM position-monitor is down — {health.failStreak} failures in a row
            {since ? `, last good check ${since}` : ''}.
          </div>
          <div className="mt-1 text-[var(--color-text-sub)]">
            Trading is <strong>not</strong> stopped: entries and the risk gate are
            deterministic, and every stop and target sits at the broker. Only the
            optional LLM second-opinion on open positions is missing.
          </div>
          {health.lastFailReason && (
            <div className="mt-1 break-words font-mono text-[9px] text-[var(--color-text-sub)]">
              {String(health.lastFailReason).slice(0, 160)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
