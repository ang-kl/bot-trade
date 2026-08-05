// A4 — the four lights, on the account rows.
//
// docs/per-account-control-plan.md §3. With several accounts the most
// expensive mistake is believing an account is quiet when it isn't, and its
// inverse — thinking one is working when its broker session is down. Neither
// was visible anywhere.
//
// Four lights per account, each with its reason on hover:
//
//   Link    at the broker, and something is reconciling
//   Scan    scanning, and the loop is actually sweeping
//   Enter   armed, and not blocked by a portfolio guard
//   Manage  watching what is open, with stops on it
//
// THREE DELIBERATE CHOICES IN THE RENDERING.
//
//   · UNKNOWN is its own state, drawn hollow, never folded into green. A green
//     light built on absent evidence is exactly the failure the lights exist
//     to prevent.
//   · The reason is always present as a title, and the state word is always
//     rendered next to the dot in the expanded row — the colour is never the
//     only carrier of the state (WCAG 1.4.1).
//   · A RED Manage light is escalated above the row as a banner, because it
//     is not a status: it means open exposure with nothing watching it, which
//     the API refuses to create. If it appears, something wrote the mode
//     column directly, and it deserves more than a small dot.
import { useEffect, useState } from 'react'
import { agentGet, pageAsleep } from '../lib/agent-api.js'
import { LIGHT_LABEL, LIGHT_ORDER, LIGHT_COLOR as COLOR } from '../lib/traffic-light-view.js'

const POLL_MS = 30_000


/** One dot. Hollow for unknown, so "no evidence" never looks like "fine". */
export function LightDot({ name, light }) {
  const state = light?.state || 'unknown'
  return (
    <span
      className="inline-flex items-center gap-0.5 text-(length:--fs-body)"
      title={`${LIGHT_LABEL[name] || name}: ${state} — ${light?.reason || 'no reading'}`}
    >
      <span aria-hidden="true" style={{ color: COLOR[state], lineHeight: 1 }}>
        {state === 'unknown' ? '○' : '●'}
      </span>
      <span className="text-[var(--color-text-sub)]">{LIGHT_LABEL[name] || name}</span>
    </span>
  )
}

export function LightRow({ row }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {LIGHT_ORDER.map(k => <LightDot key={k} name={k} light={row.lights?.[k]} />)}
      {/* The state words, for anyone who cannot use the colours and for
          anyone reading this in a screenshot. */}
      <span className="sr-only">
        {LIGHT_ORDER.map(k => `${LIGHT_LABEL[k]} ${row.lights?.[k]?.state || 'unknown'}`).join(', ')}
      </span>
    </span>
  )
}

/**
 * Fetches once and polls slowly; the caller renders rows via `children`.
 * Exposed as a render-prop rather than a table so it can be dropped into the
 * existing account rows without restructuring them.
 */
export default function AccountTrafficLights({ children }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    const poll = () => {
      agentGet('/state/account-traffic-lights')
        .then(d => { if (alive) setData(d) })
        .catch(() => { /* the row simply renders without lights */ })
    }
    poll()
    const id = setInterval(() => { if (!pageAsleep()) poll() }, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const byId = new Map((data?.accounts || []).map(r => [String(r.accountId), r]))
  const alarms = (data?.accounts || []).filter(r => r.lights?.manage?.state === 'red')

  return children({ byId, alarms, globalHalt: data?.globalHalt, globalHaltReason: data?.globalHaltReason })
}
