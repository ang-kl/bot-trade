// AgentHealthPanel — the sidebar version tag, turned into an answer.
//
// The tag has always shown a version. A version on its own answers nothing:
// the question worth asking is whether the BROWSER and the AGENT are running
// the same build, and that needs both numbers side by side. A stale bundle in
// this tab and an agent that never finished redeploying look identical from
// here — each shows the number you expected on one side and is wrong on the
// other. That comparison is the first line of this panel.
//
// Behind it: the loop's own state (which phase, how long into the cycle,
// against the watchdog deadline), the controller heartbeats rolled up with the
// unhappy ones named, the ATR sweep's account of itself (#170), and today's
// error count. All of it already existed at /health and /state/heartbeats and
// had no reader outside a terminal.
//
// THE TAG BECOMES A STATUS SURFACE. It carries a dot whose colour is the worst
// of those readings, polled slowly while closed, so a stalled controller is
// visible without opening anything. That is the point of hanging this off the
// version tag rather than burying it on a page: the sidebar is on every screen.
//
// The popover is PORTALLED to document.body and positioned by
// useAnchoredPopover — `glass-panel` uses backdrop-filter, which makes a
// filtered ancestor the containing block for fixed descendants, and the panel
// also clips with overflow: hidden. Both are escaped by the portal.
import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { useAnchoredPopover } from '../lib/use-anchored-popover.js'
import {
  deployReading, controllerReading, loopReading, overdue, dur, toText,
  CONTROLLER_TONE, worst,
} from '../lib/agent-health-view.js'
import Badge from './common/Badge.jsx'

const POLL_CLOSED_MS = 60_000
const POLL_OPEN_MS = 10_000

// ---------------------------------------------------------------------------
// ONE POLLER, SHARED BY EVERY MOUNT.
//
// The sidebar tag and the mobile top-bar tag are both mounted at all times —
// the split is CSS (`hidden lg:flex` beside `lg:hidden`), not conditional
// rendering. Two independent pollers would mean two /health + two
// /state/heartbeats every tick, and worse, two answers that can differ: the
// phone's dot and the desktop's dot could disagree about the same agent.
//
// So the fetching lives here, once. Subscribers register a cadence; the store
// runs at the FASTEST one requested (an open panel needs live ages, and a
// closed one must not slow it down) and pushes the same snapshot to everyone.
// ---------------------------------------------------------------------------
const subs = new Set()
let snapshot = { health: null, beats: null, err: null }
let timer = null
let currentMs = null

function publish(next) {
  snapshot = next
  for (const fn of subs) { try { fn(snapshot) } catch { /* one bad subscriber must not stop the rest */ } }
}

function pollOnce() {
  return Promise.all([
    agentGet('/health').catch(e => ({ __err: e?.message || String(e) })),
    agentGet('/state/heartbeats').catch(() => null),
  ]).then(([h, b]) => {
    if (h?.__err) publish({ ...snapshot, err: h.__err })
    else publish({ health: h, beats: b, err: null })
  })
}

function retime() {
  const wanted = Math.min(...[...subs].map(f => f.cadenceMs ?? POLL_CLOSED_MS), POLL_CLOSED_MS)
  if (timer && currentMs === wanted) return
  if (timer) clearInterval(timer)
  currentMs = wanted
  timer = setInterval(() => {
    // The app's standard sleep gate. An OPEN panel is exactly when the ages
    // need to be live, so a fast cadence overrides it.
    if (currentMs >= POLL_CLOSED_MS && pageAsleep()) return
    pollOnce()
  }, wanted)
}

function subscribe(fn, cadenceMs) {
  fn.cadenceMs = cadenceMs
  subs.add(fn)
  retime()
  if (snapshot.health || snapshot.err) fn(snapshot)
  // Opening the panel asks for a fast cadence; it should also refresh NOW
  // rather than showing up-to-a-minute-old ages until the first fast tick.
  if (!(snapshot.health || snapshot.err) || cadenceMs < POLL_CLOSED_MS) pollOnce()
  return () => {
    subs.delete(fn)
    if (subs.size === 0) { clearInterval(timer); timer = null; currentMs = null }
    else retime()
  }
}

const TONE_COLOR = {
  ok: 'var(--color-state-on-text)',
  warn: 'var(--color-warning-text)',
  error: 'var(--color-down)',
  unknown: 'var(--color-muted)',
}

export function Line({ state, children }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span aria-hidden="true" style={{ color: TONE_COLOR[state], fontSize: 'var(--fs-d7)', lineHeight: 1 }}>●</span>
      <span>{children}</span>
    </div>
  )
}

export function ControllerRows({ bad }) {
  if (!bad.length) return null
  return (
    <ul className="mt-1">
      {bad.map(c => (
        <li key={c.name} className="flex flex-wrap items-baseline gap-1.5">
          <Badge tone={CONTROLLER_TONE[c.status] || 'neutral'}>{c.status}</Badge>
          <span className="font-semibold">{c.label || c.name}</span>
          <span style={{ color: 'var(--color-text-sub)' }}>
            last ran {c.age_sec != null ? `${dur(c.age_sec)} ago` : 'never'} · expected every {dur(c.expected_sec)}
            {overdue(c) > 0 && <> · <strong>{dur(overdue(c))} overdue</strong></>}
          </span>
          {/* The error text is the actionable part and is never truncated
              away — a stalled controller with a hidden reason sends you to
              the logs, which is the trip this panel exists to save. */}
          {c.last_error && <span style={{ color: 'var(--color-down)' }}>{c.last_error}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * @param {{appVersion: string, buildSha: string, compact?: boolean}} props
 *   compact — the mobile top bar. Same dot, same popover, shorter label: the
 *   bar already drops the commit sha for width, and the sha is in the panel
 *   anyway (it is half of the comparison the panel exists for).
 */
export default function AgentHealthPanel({ appVersion, buildSha, compact = false }) {
  const [open, setOpen] = useState(false)
  const [{ health, beats, err }, setSnap] = useState(snapshot)
  const popoverId = useId()

  useEffect(() => subscribe(setSnap, open ? POLL_OPEN_MS : POLL_CLOSED_MS), [open])

  const { buttonRef, popoverRef } = useAnchoredPopover({
    open,
    onClose: () => setOpen(false),
    deps: [health, beats],
  })

  if (!agentConfigured()) {
    // Nothing to compare against — show the plain tag the sidebar always had.
    return (
      <span className="text-[11px] text-[var(--color-text-sub)]">
        v{appVersion}{compact ? '' : ` · ${buildSha}`}
      </span>
    )
  }

  const deploy = deployReading({
    uiVersion: appVersion, uiCommit: buildSha,
    agentVersion: health?.version, agentCommit: health?.commit,
  })
  const loop = loopReading(health)
  const ctl = controllerReading(beats?.controllers)
  const overall = err ? 'error' : worst(worst(deploy.state, loop.state), ctl.state)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen(o => !o)}
        className={`${compact ? 'text-[9px]' : 'text-[11px]'} text-[var(--color-text-sub)] hover:text-[var(--color-text)] cursor-pointer inline-flex items-baseline gap-1 shrink-0`}
        title="Build and agent health — tap for detail"
      >
        <span aria-hidden="true" style={{ color: TONE_COLOR[overall], fontSize: 'var(--fs-d7)', lineHeight: 1 }}>●</span>
        <span>v{appVersion}{compact ? '' : ` · ${buildSha}`}</span>
      </button>

      {/* The dot is decorative; the state is also stated in text for anyone
          who cannot use colour (WCAG 1.4.1). */}
      <p className="sr-only" role="status" aria-live="polite">Agent health: {overall}.</p>

      {open && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label="Agent health"
          // `pos-fixed` alongside `fixed` is NOT redundant, and the repo's
          // css-token-syntax test enforces it: `glass-panel` is an unlayered
          // rule carrying `position: relative`, which beats Tailwind's layered
          // `fixed`. Without it this popover would position against its
          // nearest positioned ancestor instead of the viewport. Caught here
          // by that test rather than on screen.
          className="glass-panel pos-fixed fixed z-50 rounded-[12px] p-3 text-[9px] w-[min(420px,calc(100vw-16px))] max-h-[70vh] overflow-y-auto"
        >
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="font-extrabold text-[var(--color-accent)] text-[11px]">Agent Health card</span>
            <button
              type="button"
              onClick={() => {
                // Straight to the clipboard rather than through CopyPopup:
                // this panel IS a popover, and opening a second one over it
                // would land outside the first and dismiss it on the way.
                navigator.clipboard?.writeText(
                  toText({ health, controllers: beats?.controllers, deploy, loop, atr: beats?.atrRefresh }),
                ).catch(() => { /* denied — the text is selectable by hand */ })
              }}
              className="ml-auto glass-inset rounded-[var(--radius-control)] px-2 py-0.5 cursor-pointer"
            >Copy</button>
          </div>

          {err && <Line state="error">Agent unreachable: {err}</Line>}

          <div className="flex flex-col gap-1">
            <Line state={deploy.state}>{deploy.text}</Line>
            <Line state={loop.state}>{loop.text}</Line>

            {health && (
              <div style={{ color: 'var(--color-text-sub)' }}>
                uptime {dur(health.uptime)}
                {health.lastLoopMs > 0 && <> · last cycle {Math.round(health.lastLoopMs / 1000)}s</>}
                {health.watchdogMinutes != null && <> · watchdog {health.watchdogMinutes}m</>}
                {health.llmProvider && <> · llm {health.llmProvider}</>}
              </div>
            )}

            <Line state={ctl.state}>
              {ctl.total === 0
                ? 'No controller heartbeats recorded yet.'
                : <>
                    {ctl.total} controllers ·{' '}
                    {Object.entries(ctl.counts).map(([k, v], i) => (
                      <span key={k}>{i > 0 && ' · '}{k} {v}</span>
                    ))}
                  </>}
            </Line>
            <ControllerRows bad={ctl.bad} />

            {/* #170: the ATR sweep's own account of itself. A heartbeat can
                only say ok/failed; this says how many symbols it had, how many
                fetches threw, and how many rows exist afterwards. */}
            {beats?.atrRefresh && (
              <div style={{ color: 'var(--color-text-sub)' }}>
                ATR sweep: {beats.atrRefresh.symbols ?? '—'} symbols ·{' '}
                {beats.atrRefresh.rows ?? '—'} rows stored
                {beats.atrRefresh.errors ? ` · ${beats.atrRefresh.errors} fetch errors` : ''}
                {beats.atrRefresh.lastError ? ` · ${beats.atrRefresh.lastError}` : ''}
              </div>
            )}

            {health?.errorsToday > 0 && (
              <Line state="warn">
                {health.errorsToday} error{health.errorsToday === 1 ? '' : 's'} today
                {health.lastError ? ` · latest: ${health.lastError}` : ''}
              </Line>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
