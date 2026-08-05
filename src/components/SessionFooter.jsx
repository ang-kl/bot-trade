// ---------------------------------------------------------------------------
// SessionFooter.jsx — the compact browser-session control at the bottom of the
// left navigation, and the popover behind it.
//
// Owner brief (instr/footer_issue.md):
//   "Replace the present large page-wide footer with a compact, single-line
//    session-status control. Move this control into the bottom of the left
//    navigation panel. Keep the visible status text at a maximum font size of
//    10px. Clicking the current-client status opens an accessible information
//    popover."
//
// The line renders as:   ● Chrome · Active · 3s ago ›
//
// WHAT IT REPLACED, and why the old thing was wrong. The page-wide fixed
// footer carried the build stamp, the tab roster and the theme control across
// the full content width. On the owner's screenshot it had also lost its font
// size to a Tailwind v4 ambiguity bug (text-[var(--fs-caption)] compiles to
// `color`, not `font-size` — see src/lib/css-token-syntax.test.js), so the
// build stamp rendered at inherited body size and the panel floated over the
// strategy table. Both problems are gone: the size bug is fixed at the root,
// and the chrome no longer occupies the content width at all.
//
// TRANSPORT HONESTY. The brief is written for WebSocket/SSE. This app polls
// over HTTPS — there is no browser socket anywhere in src/. So the popover
// reports `polling`, and disconnecting a remote session is described as
// invalidating its credential rather than as closing a socket, because that is
// what actually happens. See agent/services/browser-sessions.js for the
// server-side reasoning.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopover } from '../lib/use-anchored-popover.js'
import { agentGet, agentPost, agentConfigured, pageAsleep, getIdleMinutes, setIdleMinutes } from '../lib/agent-api.js'
import {
  aliveText, seenText, statusLine, localTime, splitSessions, confirmCopy,
  STATE_LABEL, STATE_TONE, STATE_HELP,
} from '../lib/session-format.js'

const POLL_MS = 15_000

export default function SessionFooter({ appVersion, buildSha }) {
  const [view, setView] = useState(null)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const popoverId = useId()

  // Promise-chain shape, matching the other poll loops in this app: setState
  // never runs synchronously inside the effect body, only in a callback once
  // the network answers.
  useEffect(() => {
    if (!agentConfigured()) return undefined
    let alive = true
    const poll = () => {
      agentGet('/state/sessions')
        .then(v => { if (alive) { setView(v); setErr(null) } })
        // A failed read must not blank the line — a stale reading with an
        // error note beats an empty control that reads as "no sessions".
        .catch(e => { if (alive) setErr(e?.message || 'unavailable') })
    }
    poll()
    const id = setInterval(() => {
      // The single sleep gate every poll loop in this app uses: hidden tab,
      // idle past the sleep-after setting, or the user paused polling.
      // Applying it while the popover is OPEN would be wrong — that is
      // precisely when the ages need to be live — so it only gates the
      // closed state.
      if (!open && pageAsleep()) return
      poll()
    }, open ? 5_000 : POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [open, reloadKey])

  // Bump to force an immediate re-read after a revocation, without handing a
  // setState-calling function down through props.
  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  const { current, others } = splitSessions(view)
  const line = statusLine(current)

  // Dismissal, viewport clamping and the zoom conversion live in
  // useAnchoredPopover — every clause in it was learned here, and a second
  // popover (the agent health panel) needed the same contract rather than a
  // second copy of it. `view` is a dep because the popover's CONTENT resizes
  // when the session list arrives, and the position depends on the box size.
  const { buttonRef, popoverRef } = useAnchoredPopover({
    open,
    onClose: () => setOpen(false),
    deps: [view],
  })

  if (!agentConfigured()) return null

  const toggle = () => setOpen(o => !o)

  return (
    <section className="sidebar-session-footer pt-1.5 mt-1.5" aria-label="Browser session status">
      <div className="flex items-center gap-1">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={toggle}
          className="session-status-line compact-control text-[var(--color-text-sub)] hover:text-[var(--color-text)] min-w-0"
          title="This browser's session — click for full detail and to disconnect other browsers"
        >
          <span aria-hidden="true" style={{ color: STATE_TONE[line.state], fontSize: 'var(--fs-body)', lineHeight: 1 }}>●</span>
          {/* The state WORD is in the line, so status never depends on the dot
              colour alone (WCAG 1.4.1, and the brief says so twice). */}
          <span className="session-text">
            {line.browser} · {line.stateLabel}{line.age ? ` · ${line.age}` : ''}
          </span>
          <span aria-hidden="true" className="shrink-0">{open ? '⌄' : '›'}</span>
        </button>
      </div>

      {/* Screen-reader announcement for ordinary status changes — polite, so
          it never interrupts. Revocation uses assertive, further down. */}
      <p className="sr-only" role="status" aria-live="polite">
        This browser: {line.browser}, {line.stateLabel}
        {seenText(current?.lastSeenAgeMs) ? `, ${seenText(current.lastSeenAgeMs)}` : ''}.
      </p>

      {/* PORTALLED TO document.body, and this is a correctness fix, not tidiness.
          `glass-panel` uses backdrop-filter, and a filtered ancestor becomes the
          containing block for `position: fixed` descendants — so a popover
          rendered inside the sidebar was positioned against the PANEL, not the
          viewport (measured at 1440x900: left resolved to -159px, off-screen,
          while every viewport clamp said it was inside). The panel also has
          `overflow: hidden`, which would clip it regardless. A portal escapes
          both at once. */}
      {open && createPortal(
        <SessionPopover
          id={popoverId}
          ref={popoverRef}
          view={view}
          current={current}
          others={others}
          err={err}
          appVersion={appVersion}
          buildSha={buildSha}
          onClose={() => { setOpen(false); buttonRef.current?.focus() }}
          onChanged={reload}
        />,
        document.body,
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The popover. role="dialog", NOT modal: the brief says "Trap focus only when
// operating as a modal dialog", and trapping focus here would lock the user
// out of the trading controls behind it for no reason. The CONFIRMATION for a
// destructive disconnect is modal — that one deserves the interruption.
// ---------------------------------------------------------------------------
function SessionPopover({ id, ref, view, current, others, err, appVersion, buildSha, onClose, onChanged }) {
  const titleId = `${id}-title`
  const [pending, setPending] = useState(null)   // session awaiting confirmation
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)

  // Open with the dialog focused so a keyboard user lands inside it.
  const firstRef = useRef(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  const revoke = async (session) => {
    setBusyId(session.id)
    setNotice(null)
    try {
      // Success is only claimed after the SERVER answers — "Do not allow the
      // client to declare success before the server confirms revocation."
      const res = await agentPost(`/actions/sessions/${encodeURIComponent(session.id)}/revoke`, { reason: 'user_requested' })
      setNotice({
        tone: 'ok',
        text: `${session.label} disconnected. ${res?.queuedItemsCancelled ? `${res.queuedItemsCancelled} open tab(s) dropped. ` : ''}Its credential no longer authenticates, so it cannot reconnect.`,
      })
      setPending(null)
      await onChanged()
    } catch (e) {
      setNotice({ tone: 'err', text: `Could not disconnect: ${e?.message || 'unknown error'}` })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      // `pos-fixed` alongside `fixed` is not redundant: `glass-panel` is an
      // unlayered rule setting `position: relative`, and unlayered styles
      // outrank ALL of Tailwind's layered utilities, so the `fixed` class alone
      // silently lost (measured: position computed to `relative`, and the
      // dialog was laid out in flow inside the sidebar). See the note on
      // .glass-panel.pos-fixed in index.css — the same trap bit Tune's
      // timeframe dropdown, so it now has one documented fix rather than an
      // inline style here and something else there.
      className="glass-panel pos-fixed fixed z-50 w-[min(22rem,calc(100vw-1rem))] max-h-[70vh] overflow-y-auto rounded-[12px] p-3 text-(length:--fs-caption)"
    >
      <div className="flex items-baseline gap-2 mb-2">
        <h2 id={titleId} className="text-(length:--fs-secondary) font-semibold">Browser Sessions table</h2>
        <button
          ref={firstRef}
          type="button"
          onClick={onClose}
          className="compact-control button-normal ml-auto"
          aria-label="Close browser session panel"
        >Close</button>
      </div>

      {/* Security-critical outcomes interrupt; ordinary status does not. */}
      <p role="alert" aria-live="assertive" className="sr-only">{notice?.text || ''}</p>
      {notice && (
        <p className={`mb-2 rounded-[7px] px-2 py-1 ${notice.tone === 'ok'
          ? 'text-[var(--color-info-text)] bg-[var(--color-info-bg)]'
          : 'text-[var(--color-error-text)] bg-[var(--color-error-bg)]'}`}>{notice.text}</p>
      )}
      {err && <p className="mb-2 text-[var(--color-warning-text)]">Session list unavailable ({err}) — the figures below may be stale.</p>}
      {view?.masterNote && <p className="mb-2 text-[var(--color-warning-text)]">{view.masterNote}</p>}

      {/* ---- THIS DEVICE ---------------------------------------------------
          "Show a neutral label: 'This device'" and no enabled Disconnect. */}
      <h3 className="font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">This device</h3>
      {current ? (
        <>
          <p className="mt-0.5">
            {current.label}
            {current.deviceType ? <span className="text-[var(--color-text-sub)]"> · {current.deviceType}</span> : null}
          </p>
          <p>
            <span style={{ color: STATE_TONE[current.state] }}>{STATE_LABEL[current.state] || current.state}</span>
            <span className="text-[var(--color-text-sub)]"> — {STATE_HELP[current.state]}</span>
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <Row k="Alive" v={aliveText(current.aliveMs, current.state) || '—'}
              note={current.createdAtEstimated ? 'estimated from the token’s expiry — this session predates session tracking' : null} />
            <Row k="Last seen" v={seenText(current.lastSeenAgeMs) || '—'} />
            <Row k="Created" v={localTime(current.createdAt)} />
            <Row k="Last heartbeat" v={localTime(current.lastHeartbeatAt)} />
            <Row k="Last server ack" v={localTime(current.lastAcknowledgementAt)} />
            <Row k="Transport" v={`${current.transport} (HTTPS — this app has no browser socket)`} />
            <Row k="Open tabs" v={String(current.openTabs ?? 0)} />
            {current.pages?.length ? <Row k="Pages" v={current.pages.join(', ')} /> : null}
            <Row k="Authentication" v={current.authenticated ? 'Signed in' : 'Not authenticated'} />
            <Row k="Token expires" v={localTime(current.expiresAt)} />
            <Row k="Session" v={current.maskedId} />
            <Row k="IP" v={current.ip || 'not recorded'} />
            <Row k="Location" v={locationText(current) || 'unknown — allow the browser location prompt to record it'} />
            <Row k="Build" v={`v${appVersion} · ${buildSha}`} />
          </dl>
          {/* The brief: no enabled Disconnect for the current session, and a
              separate ordinary sign-out belongs elsewhere. Saying WHY beats a
              greyed-out button with no explanation. */}
          <p className="mt-1 text-[var(--color-text-sub)]">
            This session cannot disconnect itself. The server refuses a self-revoke even if a stale page asks for one.
          </p>
        </>
      ) : view?.masterCaller ? (
        // Owner ("missing information"): a master-credential caller has no
        // session ROW, but the server still sees this request — browser, IP,
        // location, tabs. Show what is actually known instead of an empty
        // section with an apology.
        <>
          <p className="mt-0.5">
            {view.masterCaller.label}
            {view.masterCaller.deviceType ? <span className="text-[var(--color-text-sub)]"> · {view.masterCaller.deviceType}</span> : null}
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <Row k="Transport" v={`${view.masterCaller.transport} (HTTPS — this app has no browser socket)`} />
            <Row k="Open tabs" v={String(view.masterCaller.openTabs ?? 0)} />
            <Row k="IP" v={view.masterCaller.ip || 'not recorded'} />
            <Row k="Location" v={locationText(view.masterCaller) || 'unknown — allow the browser location prompt to record it'} />
            <Row k="Build" v={`v${appVersion} · ${buildSha}`} />
          </dl>
          <p className="mt-1 text-[var(--color-text-sub)]">
            No per-device session record, so there is nothing to disconnect from this panel.
          </p>
        </>
      ) : (
        <p className="text-[var(--color-text-sub)]">
          {view ? 'This browser is not using a per-device session, so it has no revocable session record.' : 'Loading…'}
        </p>
      )}

      {/* ---- OTHER SESSIONS ------------------------------------------------ */}
      <h3 className="mt-3 font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">
        Other browsers {others?.length ? `(${others.length})` : ''}
      </h3>
      {!others?.length && <p className="text-[var(--color-text-sub)]">None recorded.</p>}
      <ul className="mt-0.5 flex flex-col">
        {(others || []).map(s => (
          <li key={s.id} className="border-t border-[var(--glass-edge)] py-1 flex items-start gap-2">
            <span aria-hidden="true" style={{ color: STATE_TONE[s.state], fontSize: 'var(--fs-body)', lineHeight: 2 }}>●</span>
            <div className="min-w-0 flex-1">
              <p className="truncate">{s.label}{s.deviceType ? ` · ${s.deviceType}` : ''}</p>
              <p className="text-[var(--color-text-sub)]">
                {STATE_LABEL[s.state] || s.state}
                {aliveText(s.aliveMs, s.state) ? ` · ${aliveText(s.aliveMs, s.state).toLowerCase()}` : ''}
                {seenText(s.lastSeenAgeMs) ? ` · ${seenText(s.lastSeenAgeMs)}` : ''}
              </p>
              <p className="text-[var(--color-text-sub)]">
                {s.transport} · {s.appBuild ? `build ${s.appBuild}` : 'build unknown'} · {s.maskedId}
                {s.revokedAt ? ` · revoked ${localTime(s.revokedAt)}` : ''}
              </p>
              {/* Owner: "I need IP Address and location for past window" — the
                  row keeps its last stamped IP and location after the browser
                  is gone, which is exactly when this line earns its place. */}
              <p className="text-[var(--color-text-sub)]">
                {s.ip || 'IP not recorded'}{locationText(s) ? ` · ${locationText(s)}` : ' · location not recorded'}
              </p>
            </div>
            {s.canDisconnect ? (
              <button
                type="button"
                className="compact-control button-danger shrink-0"
                disabled={busyId === s.id}
                onClick={() => setPending(s)}
              >{busyId === s.id ? 'Working…' : 'Disconnect'}</button>
            ) : (
              <span className="shrink-0 text-[var(--color-text-sub)]">
                {s.revokedAt ? 'Revoked' : 'Gone'}
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* ---- SLEEP-AFTER --------------------------------------------------
          This setting used to live in the tab-roster panel that the brief
          removes. It is a session-lifecycle control, so it belongs here rather
          than being dropped with the panel: a tab left untouched past this
          window stops polling entirely (which is the only "close the tab"
          effect a web page can actually have — browsers do not let a site
          close a tab the user opened, exactly as the brief's own browser-
          limitation note says). Any click or keypress wakes it. */}
      <SleepAfter />

      {pending && (
        <ConfirmDisconnect
          session={pending}
          busy={busyId === pending.id}
          onCancel={() => setPending(null)}
          onConfirm={() => revoke(pending)}
        />
      )}
    </div>
  )
}

const IDLE_CHOICES = [
  { min: 5, label: '5m' },
  { min: 15, label: '15m' },
  { min: 60, label: '1h' },
  { min: 240, label: '4h' },
]

function SleepAfter() {
  const [idleMin, setIdleMin] = useState(getIdleMinutes)
  return (
    <fieldset className="mt-3 border-t border-[var(--glass-edge)] pt-1.5">
      <legend className="font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">Sleep this tab after</legend>
      {/* flex-wrap, not a single row: six children in a ~192px sidebar column
          is what produced the horizontal scrollbar the owner reported. In the
          popover there is more room, but wrapping keeps it safe at 320px. */}
      <div className="mt-1 flex items-center flex-wrap gap-1">
        {IDLE_CHOICES.map(c => (
          <button
            key={c.min}
            type="button"
            aria-pressed={idleMin === c.min}
            onClick={() => { setIdleMinutes(c.min); setIdleMin(c.min) }}
            className={`compact-control ${idleMin === c.min ? 'button-normal' : 'text-[var(--color-text-sub)] border-[var(--glass-edge)]'}`}
          >{c.label}</button>
        ))}
      </div>
      <p className="mt-1 text-[var(--color-text-sub)]">
        An idle countdown, wired into every poll loop: each click, keypress or
        scroll resets it, and after the chosen time with no activity the tab
        sleeps — all polling stops, so it costs the agent nothing. The next
        interaction starts it fresh.
      </p>
    </fieldset>
  )
}

/** "Singapore · 1.35,103.82" from whatever location facts a row carries. */
function locationText(s) {
  const parts = [s?.country, s?.loc].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function Row({ k, v, note }) {
  return (
    <>
      <dt className="text-[var(--color-text-sub)]">{k}</dt>
      <dd className="break-words">
        {v}
        {note ? <span className="text-[var(--color-text-sub)]"> ({note})</span> : null}
      </dd>
    </>
  )
}

// ---------------------------------------------------------------------------
// The destructive confirmation. THIS one is modal (aria-modal) and traps
// focus, because it is a deliberate two-step for an action that signs another
// device out — the one place the brief asks for "a deliberate confirmation".
// ---------------------------------------------------------------------------
function ConfirmDisconnect({ session, busy, onCancel, onConfirm }) {
  const copy = confirmCopy(session)
  const boxRef = useRef(null)
  const cancelRef = useRef(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return }
      if (e.key !== 'Tab') return
      // Minimal, correct focus trap: cycle within the dialog's own tabbables.
      const nodes = boxRef.current?.querySelectorAll('button:not([disabled])')
      if (!nodes?.length) return
      const list = [...nodes]
      const i = list.indexOf(document.activeElement)
      e.preventDefault()
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === list.length - 1 ? 0 : i + 1)
      list[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disconnect-title"
        aria-describedby="disconnect-body"
        className="glass-panel rounded-[12px] p-3 w-[min(24rem,100%)] text-(length:--fs-caption)"
      >
        <h2 id="disconnect-title" className="text-(length:--fs-secondary) font-semibold">{copy.title}</h2>
        <p id="disconnect-body" className="mt-1 text-[var(--color-text-sub)]">{copy.body}</p>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button ref={cancelRef} type="button" className="compact-control button-normal" onClick={onCancel} disabled={busy}>
            {copy.cancel}
          </button>
          {/* Disabled while pending — "Disable repeated clicks while the
              operation is pending." */}
          <button type="button" className="compact-control button-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Disconnecting…' : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
