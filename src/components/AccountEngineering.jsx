// AccountEngineering — what the machine is actually DOING for each account.
//
// Owner (2026-07-30): "The desk page should display the underlying engineering
// status for each account you are trading or not trading. If I deselect certain
// trading accounts in the connect interface, what will happen? Will the system
// still attempt to scan, analyze, or auto-trade those accounts? I am serious
// about avoiding unnecessary effort and expenses in trading."
//
// The answer to their question, on screen instead of in a paragraph, one row per
// account. Everything comes from GET /state/account-engineering — a single call,
// and one the browser can trust: the sidecar roster is what the heartbeat probe
// last persisted, not a live HTTP hop hidden inside a page load.
//
// THREE-STATE HONESTY runs through the whole card. "Not authorised at the
// sidecar" and "the sidecar has not told us" are different facts, and one of
// them would send the owner hunting for a fault that is not there, so an unknown
// roster renders '?' and says so on hover. Same for a missing timestamp: '—'
// means nothing has been recorded, never "just now".
import { useCallback, useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import { agentGet } from '../lib/agent-api.js'
import { PHASES } from '../lib/account-phases.js'
import Collapse from './common/Collapse.jsx'
import { accountNumbers } from "../lib/scope-label.js"

/** "4m", "3h", "2d" since an ISO stamp — or null when there is nothing to age. */
function ago(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return null
  const secs = Math.max(0, (Date.now() - t) / 1000)
  if (secs < 90) return `${Math.round(secs)}s`
  const mins = secs / 60
  if (mins < 90) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h`
  return `${Math.round(hrs / 24)}d`
}

const Cell = ({ children, title, className = '' }) => (
  <td className={`py-1 pr-3 whitespace-nowrap ${className}`} title={title}>{children}</td>
)

/**
 * One phase's effective state, with WHY when it is off.
 *
 * The `source` field is the point: "off because the master switch is off" and
 * "off for this account" look identical as a red dot, and the owner needs to
 * know which before going to look for a switch.
 */
function PhaseCell({ phases, phase }) {
  const on = phases?.[phase.key] === true
  const src = phases?.source?.[phase.key]
  const why = on
    ? `${phase.label} runs for this account`
    : src === 'master'
      ? `${phase.label} is off GLOBALLY (master switch on Tune › Pipeline) — a per-account switch would not change it`
      : `${phase.label} is off FOR THIS ACCOUNT (per-account switch on Tune › Pipeline)`
  return (
    <span
      title={why}
      className="inline-flex items-center gap-[2px] text-(length:--fs-body) font-bold"
      style={{ color: on ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)' }}
    >
      <span aria-hidden="true" className="inline-block h-[6px] w-[6px] rounded-full"
        style={{ background: 'currentColor', boxShadow: '0 0 0 1px currentColor' }} />
      {phase.initial}
      {/* A dot marks an account carrying its own setting rather than the master's. */}
      {!on && src === 'account' && <span aria-hidden="true" className="text-(length:--fs-body)">•</span>}
    </span>
  )
}

export default function AccountEngineering() {
  const [view, setView] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => agentGet('/state/account-engineering')
    .then(v => { setView(v); setErr('') })
    .catch(e => setErr(e.message)), [])
  useEffect(() => { load() }, [load])

  const accounts = view?.accounts || []
  const sc = view?.sidecar
  const scAge = ago(sc?.at)

  return (
    <Card id="sec-acct-engineering" className="w3-hover-shadow">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="t-h3">Per-account engineering status</h3>
      </div>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-1.5">
        What the bot is actually doing for each account on your cTrader ID — not what it is configured to do.
        <strong> Off in Connect</strong> (enabled = no) means the account is not reconciled and never dispatched,
        whatever its switches say. <strong>Mode</strong> <code>active</code> may open new trades;
        <code> manage_only</code> manages what is already open and starts nothing.
        S/A/T are the effective Scan / Analyze / Autotrade switches — hover any of them for why it is off.
      </p>
      {err && <div className="text-(length:--fs-body) text-[var(--color-down)]" role="alert">{err}</div>}
      {!view && !err && <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading engineering status…</div>}

      {view && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-(length:--fs-body) text-[var(--color-text-sub)]">
          <span>
            C++ exec engine:{' '}
            {sc?.rosterKnown
              ? <Badge tone={sc.connected ? 'on' : 'off'}>{sc.connected ? 'connected' : 'disconnected'}</Badge>
              : <Badge tone="neutral">roster unknown</Badge>}
          </span>
          {sc?.rosterKnown && (
            <span title="The accounts the sidecar is currently authorised to trade. It is re-pushed from the registry when it drifts.">
              authorised: {sc.accounts.length ? sc.accounts.join(', ') : 'none'}
            </span>
          )}
          {scAge && <span title={sc.at}>as of {scAge} ago</span>}
          {sc?.error && <span className="text-[var(--color-warning-text)]" title={sc.error}>{String(sc.error).slice(0, 70)}</span>}
          {!sc?.rosterKnown && (
            <span title="Either EXEC_ENGINE is not 'cpp' (execution runs in-process) or the sidecar has not been probed yet. Not the same as 'no accounts authorised'.">
              — js exec mode, or not probed yet
            </span>
          )}
        </div>
      )}

      {view && accounts.length === 0 && (
        <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">No accounts in the registry yet — pick them on Connect.</div>
      )}

      {accounts.length > 0 && (
        <div className="overflow-x-auto">
          <Collapse id="AccountEngineering_129" label="Switch Rows">
          <table className="w-full text-(length:--fs-body) tabular-nums">
            <thead>
              <tr className="text-left text-[var(--color-text-sub)]">
                <th className="py-1 pr-3 font-semibold">Account</th>
                <th className="py-1 pr-3 font-semibold">In Connect</th>
                <th className="py-1 pr-3 font-semibold">Mode</th>
                <th className="py-1 pr-3 font-semibold" title="Effective Scan / Analyze / Autotrade for this account">S A T</th>
                <th className="py-1 pr-3 font-semibold" title="Is this account authorised at the C++ exec engine right now">Sidecar</th>
                <th className="py-1 pr-3 font-semibold text-right">Open</th>
                <th className="py-1 pr-3 font-semibold">Reconciled</th>
                <th className="py-1 pr-3 font-semibold" title="The most recent pipeline decision recorded for this account. Note: nothing is written when a dispatch SUCCEEDS, so a busy account can show '—'.">Last decision</th>
                <th className="py-1 pr-3 font-semibold text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const recAge = ago(a.lastReconcileAt)
                const decAge = ago(a.lastDecisionAt)
                return (
                  <tr key={a.accountId} className="border-t border-[var(--color-border)]">
                    <Cell title={`cTrader account ${a.accountId}`}>
                      <span className={`font-bold ${a.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
                        {a.isLive ? 'LIVE' : 'DEMO'} {accountNumbers(a)}
                      </span>
                      {a.selected && (
                        <span className="ml-1 text-(length:--fs-body) text-[var(--color-accent)]"
                          title="The account the pages are currently scoped to">viewing</span>
                      )}
                    </Cell>
                    <Cell title={a.enabled
                      ? 'Selected on Connect: reconciled every cycle and authorised at the sidecar'
                      : 'Deselected on Connect: NOT reconciled, NOT dispatched, and not authorised at the sidecar — it costs nothing'}>
                      <Badge tone={a.enabled ? 'on' : 'off'}>{a.enabled ? 'yes' : 'no'}</Badge>
                    </Cell>
                    <Cell title={a.mode === 'active'
                      ? 'active — may open new trades'
                      : a.mode === 'manage_only'
                        ? 'manage_only — manages open positions, opens nothing new'
                        : `${a.mode ?? 'unknown'}`}>
                      {a.mode ?? '—'}
                    </Cell>
                    <Cell>
                      <span className="inline-flex items-center gap-[4px]">
                        {PHASES.map(p => <PhaseCell key={p.key} phases={a.phases} phase={p} />)}
                      </span>
                    </Cell>
                    <Cell title={a.sidecarAuthorised === null
                      ? 'Unknown — the sidecar has not reported a roster (js exec mode, or not probed yet). NOT the same as "not authorised".'
                      : a.sidecarAuthorised
                        ? 'Authorised at the C++ exec engine — orders for this account can be sent'
                        : 'Not authorised at the C++ exec engine — no order for this account could be sent'}>
                      {a.sidecarAuthorised === null
                        ? <span className="text-[var(--color-text-sub)]">?</span>
                        : <Badge tone={a.sidecarAuthorised ? 'on' : 'off'}>{a.sidecarAuthorised ? 'yes' : 'no'}</Badge>}
                    </Cell>
                    <Cell className="text-right">{a.openPositions}</Cell>
                    <Cell title={a.lastReconcileAt
                      ? `${a.lastReconcileAt}${a.lastReconcileSource === 'global' ? ' (this is the selected account, whose sweep writes the global stamp)' : ''}`
                      : 'No reconcile recorded for this account — expected while it is deselected on Connect'}>
                      {recAge ? `${recAge} ago` : '—'}
                    </Cell>
                    <Cell title={a.lastDecisionAt
                      ? `${a.lastDecisionAt} — ${a.lastDecisionStage}: ${a.lastDecision}`
                      : 'No decision recorded. Nothing is written when a dispatch succeeds, so this is not evidence of inactivity.'}>
                      {decAge
                        ? <>{decAge} ago <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">{a.lastDecisionStage}</span></>
                        : '—'}
                    </Cell>
                    <Cell className="text-right" title={a.leverage ? `leverage 1:${a.leverage}` : ''}>
                      {a.balance == null ? '—' : a.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </Cell>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </Collapse>
        </div>
      )}

      {view?.legacyOpenPositions > 0 && (
        <p className="mt-1 text-(length:--fs-body) text-[var(--color-text-sub)]">
          {view.legacyOpenPositions} open position{view.legacyOpenPositions === 1 ? '' : 's'} predate per-account
          tagging and carry no account. Counted here once rather than against every row, so these totals stay
          comparable with the Positions page.
        </p>
      )}
    </Card>
  )
}
