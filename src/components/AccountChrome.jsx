// ---------------------------------------------------------------------------
// AccountChrome.jsx — one line of account truth in the page frame.
//
// Owner (§5502·C, 2026-08-04):
//   "account (Login # · ID #) · Currency flag · balance · armed state ·
//    today's drawdown against the #% stop · trade count (past 24 hours)
//    Loss #,###.## Profit #,###.##"
//
// WHY IT IS CHROME AND NOT A CARD. Everything on this line was already
// available somewhere — Accounts, Risk, the Go-Live gate. The problem was that
// each lived on a page you had to be on. The equity stop moved from 15% to 8%
// on 2026-08-04, halving the headroom, and no screen you happened to be
// looking at would tell you how close today was to it.
//
// ONE SOURCE. Every figure comes from GET /state/account-chrome in a single
// read, and the drawdown is computed by equity-stop.js's own functions — the
// same ones the circuit calls. See agent/services/account-chrome.js for why
// that matters more than it looks.
//
// DEGRADES TO NOTHING. No agent configured, a failed fetch, or an empty
// registry all render null rather than a skeleton or an error strip: this
// element sits in the frame of every page, so a noisy failure mode would be
// noisy everywhere at once.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { accountLabel, money, armState, drawdownText, dayText } from '../lib/account-chrome-format.js'

const POLL_MS = 30_000

const TONE = {
  up: 'text-[var(--color-accent)]',
  down: 'text-[var(--color-down)]',
  warn: 'text-[var(--color-warning-text)]',
  muted: 'text-[var(--color-text-sub)]',
}

/** A single `·`-separated cell. Exported for the render test. */
export function Cell({ children, title, tone = 'muted', className = '' }) {
  return (
    <span className={`whitespace-nowrap ${TONE[tone] || TONE.muted} ${className}`} title={title}>
      {children}
    </span>
  )
}

/**
 * The line for ONE account. Pure — takes a row, renders it — so the whole of
 * the formatting can be tested with a literal object and no fetch.
 */
export function ChromeRow({ row, compact = false }) {
  if (!row) return null
  const arm = armState(row)
  const dd = drawdownText(row.drawdown, row.currency)
  const day = dayText(row.day)

  return (
    <span className="inline-flex items-center gap-1.5 text-(length:--fs-body) tabular-nums">
      <Cell tone={row.isLive ? 'down' : 'muted'} title={row.isLive ? 'LIVE account' : 'demo account'}>
        {row.flag || (row.currency ?? '')} {accountLabel(row)}
      </Cell>
      <span className="text-[var(--color-border)]">·</span>
      <Cell tone="muted" title={`Balance${row.currency ? ` in ${row.currency}` : ''}`}>
        {money(row.balance, row.currency)}
      </Cell>
      <span className="text-[var(--color-border)]">·</span>
      <Cell tone={arm.tone} title={arm.help} className="font-semibold">{arm.label}</Cell>
      <span className="text-[var(--color-border)]">·</span>
      <Cell tone={dd.tone} title={dd.title}>{dd.text}</Cell>
      {!compact && (
        <>
          <span className="text-[var(--color-border)]">·</span>
          <Cell tone="muted" title={day.title}>
            {day.trades} trades
            {' · '}
            {/* Loss carries its own minus so the two figures cannot be mixed
                up at a glance — the service returns loss as a positive. */}
            <span className={TONE.down}>Loss −{day.loss}</span>
            {' · '}
            <span className={TONE.up}>Profit {day.profit}</span>
          </Cell>
        </>
      )}
    </span>
  )
}

export default function AccountChrome({ compact = false, accountId = null }) {
  const [data, setData] = useState(null)

  const load = useCallback(() => {
    if (!agentConfigured() || pageAsleep?.()) return
    agentGet('/state/account-chrome').then(setData).catch(() => { /* chrome never shouts */ })
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  if (!data?.accounts?.length) return null
  const want = accountId || data.defaultAccountId
  const row = data.accounts.find(a => a.accountId === String(want)) || data.accounts[0]
  return <ChromeRow row={row} compact={compact} />
}
