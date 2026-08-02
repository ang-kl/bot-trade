// BotChanges — "done by the bot, not me" (owner 02-08-2026): the sidebar
// button above the browser-session line that expands to list every change
// the agent performed on the owner's behalf (what · when), plus the applier
// that paints a YELLOW border on the touched sections across the app.
//
// Data: GET /state/bot-changes, written by the agent itself via
// POST /actions/bot-note whenever it changes something. Each entry may name
// DOM targets (section ids like 'sec-pipeline'); the applier adds the
// .bot-changed class to those nodes so the owner can see at a glance which
// cards the bot touched. Highlights cover the last 48 hours — old entries
// stay in the list but stop shouting.
/* eslint-disable react-refresh/only-export-components -- hook + two chrome
   components share one data source; splitting them would triple the file
   for a fast-refresh nicety on rarely-edited chrome. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'

const POLL_MS = 60_000
const HIGHLIGHT_HOURS = 48

const fmtSgt = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Singapore', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }) + ' SGT'
  } catch { return iso }
}

export function useBotChanges() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    if (!agentConfigured()) return undefined
    let alive = true
    const poll = () => {
      if (pageAsleep()) return
      agentGet('/state/bot-changes')
        .then(r => { if (alive) setRows(Array.isArray(r?.rows) ? r.rows : []) })
        .catch(() => { /* keep last reading */ })
    }
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return rows
}

/** Applies the yellow .bot-changed border to every recent entry's targets.
 *  Re-applies on data change AND on route change (new DOM). */
export function BotChangeHighlighter({ rows, routeKey }) {
  useEffect(() => {
    const cutoff = Date.now() - HIGHLIGHT_HOURS * 3_600_000
    const targets = new Map() // id → newest entry text
    for (const r of rows) {
      if (new Date(r.at).getTime() < cutoff) continue
      for (const t of r.targets || []) {
        if (!targets.has(t)) targets.set(t, `Changed by the bot — ${r.what} (${fmtSgt(r.at)})`)
      }
    }
    // Clear stale highlights first (an id whose entry aged out).
    document.querySelectorAll('.bot-changed').forEach(n => {
      if (!targets.has(n.id)) n.classList.remove('bot-changed')
    })
    const timers = []
    // The section may render a tick after navigation — retry briefly.
    const apply = (attempt = 0) => {
      let missing = false
      for (const [id, title] of targets) {
        const node = document.getElementById(id)
        if (!node) { missing = true; continue }
        node.classList.add('bot-changed')
        if (!node.title) node.title = title
      }
      if (missing && attempt < 20) timers.push(setTimeout(() => apply(attempt + 1), 150))
    }
    apply()
    return () => timers.forEach(clearTimeout)
  }, [rows, routeKey])
  return null
}

/** The sidebar control: Bot Changes · N — opens a pop-up dialog (same
 *  pattern as the Browser Sessions popover below it, per the owner 02-08:
 *  '"Bot Changes" should be a pop-up window like "Browser Sessions table"').
 *  Portalled to document.body for the same measured reason SessionFooter's
 *  is: glass-panel's backdrop-filter makes the sidebar the containing block
 *  for fixed descendants, and its overflow would clip the box anyway. */
export function BotChangesFooterButton({ rows }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const buttonRef = useRef(null)
  const popoverRef = useRef(null)
  const [configured, setConfigured] = useState(false)
  // Clock read lives in an effect (render stays pure): refreshed each minute
  // so the "new" count ages out without a reload.
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    // Deferred first run — no synchronous setState inside the effect body
    // (same shape as this app's poll loops).
    const first = setTimeout(() => { setConfigured(agentConfigured()); tick() }, 0)
    const t = setInterval(tick, 60_000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [])

  // Dismissal: Escape, outside click, focus return — same contract as the
  // session popover.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      if (buttonRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  // Viewport placement, measured after paint — prefers opening upward from
  // the bottom-of-sidebar anchor and clamps both axes. Zoom conversion is
  // required: index.css zooms html 1.1 above 1153px and rect reads visual
  // pixels while style.top resolves layout pixels (see SessionFooter).
  useLayoutEffect(() => {
    if (!open) return
    const el = popoverRef.current
    const anchor = buttonRef.current
    if (!el || !anchor) return
    el.style.top = ''
    el.style.bottom = ''
    el.style.left = ''
    const a = anchor.getBoundingClientRect()
    const margin = 8
    const { width: w, height: h } = el.getBoundingClientRect()
    const maxTop = Math.max(margin, window.innerHeight - h - margin)
    const maxLeft = Math.max(margin, window.innerWidth - w - margin)
    let top = a.top - h - margin
    if (top < margin) top = a.bottom + margin
    top = Math.min(Math.max(margin, top), maxTop)
    const left = Math.min(Math.max(margin, a.left), maxLeft)
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1
    el.style.top = `${top / zoom}px`
    el.style.left = `${left / zoom}px`
  }, [open, rows])

  if (!configured) return null
  const recent = now ? rows.filter(r => now - new Date(r.at).getTime() < HIGHLIGHT_HOURS * 3_600_000) : []
  return (
    <div className="px-1">
      <button type="button" ref={buttonRef}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 rounded-[1px] px-2 py-1 text-[9px] cursor-pointer text-[var(--color-text-sub)] hover:text-[var(--color-text)]"
        style={recent.length ? { outline: '1.5px solid #eab308', outlineOffset: '-1.5px' } : undefined}
        title="Changes the bot made on your behalf — click for the full ledger">
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        <span className="font-semibold">Bot Changes</span>
        <span className="ml-auto tabular-nums">{rows.length ? `${recent.length} new · ${rows.length}` : '0'}</span>
      </button>
      {open && createPortal(
        <div id={panelId} ref={popoverRef} role="dialog" aria-labelledby={`${panelId}-title`}
          className="glass-panel pos-fixed fixed z-50 w-[min(22rem,calc(100vw-1rem))] max-h-[70vh] overflow-y-auto rounded-[12px] p-3 text-(length:--fs-caption)">
          <div className="flex items-baseline gap-2 mb-2">
            <h2 id={`${panelId}-title`} className="text-(length:--fs-secondary) font-semibold">Bot Changes table</h2>
            <button type="button" onClick={() => { setOpen(false); buttonRef.current?.focus() }}
              className="compact-control button-normal ml-auto" aria-label="Close bot changes panel">Close</button>
          </div>
          <p className="text-[9px] text-[var(--color-muted)] mb-2">
            Changes the bot (Claude) made on your behalf — yellow-bordered in the app for {HIGHLIGHT_HOURS}h. Everything else was you.
          </p>
          {rows.length === 0 && <p className="text-[9px] text-[var(--color-muted)]">No bot changes recorded.</p>}
          {rows.map((r, i) => (
            <div key={`${r.at}-${i}`} className="text-[9px] leading-tight border-b border-[var(--glass-edge)] pb-1 mb-1 last:border-0 last:mb-0">
              <div className="flex items-baseline gap-1">
                <span className="font-semibold">{r.what}</span>
                <span className="ml-auto shrink-0 text-[var(--color-muted)] tabular-nums">{fmtSgt(r.at)}</span>
              </div>
              {r.detail && <div className="text-[var(--color-text-sub)]">{r.detail}</div>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
