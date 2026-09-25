// V3 T3: the momentum partial-TP1 plans and whether anything is acting on
// them. Reads GET /state/momentum-targets. The position's broker TP is the
// RUNNER's target; the partial trigger below it is the first exit, and it is
// closed by the agent's partial manager, not by the broker. So the panel
// shows the trigger, and when the manager's pass is not running, or its last
// run could not act on the row's account (no credentials, the account's pass
// failed), it says the trigger is unavailable rather than armed (owner
// principle 6: no result the code does not honour).
import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from '../lib/agent-api.js'
import Card from './common/Card.jsx'

const fmtAt = ms => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'time not recorded' }

const ACTIVE = ['ARMED', 'SENDING', 'AMBIGUOUS', 'RECEIVED']

/** Whether the pass can act on this reading's account. An agent that does
 * not report `available` is judged on freshness alone. */
const passAvailable = pass => (pass?.available ?? pass?.fresh) === true

/** The manager's pass, in one sentence: running, stale, never run, or
 * running but unable to act on this account. */
function passSentence(pass) {
  if (!pass?.at) return 'Partial manager: unavailable — its pass has never run on this agent.'
  if (!passAvailable(pass)) return `Partial manager: unavailable — ${pass.unavailable || `last pass ${pass.at}`}.`
  return `Partial manager: running — last pass ${pass.at}${pass.ok === false ? ' (the last pass reported a failure)' : ''}.`
}

/** Why the pass cannot act on this row, or null. The row's own account
 * state when the agent reports it, else the pass-level state. */
function rowUnavailable(row, pass) {
  if (row.passUnavailable !== undefined) return row.passUnavailable
  return passAvailable(pass) ? null : (pass?.unavailable || 'the partial manager is not running')
}

function targetCell(row, pass) {
  const t = row.target
  if (!t || t.trigger == null) return 'Plan not readable'
  const side = t.side === 'SELL' ? 'ask' : 'bid'
  const text = `Close ${t.closeVolume ?? '?'} of ${t.volume ?? '?'} units (${t.closePercentage != null ? Math.round(t.closePercentage) : '?'}%) when the ${side} reaches ${t.trigger}`
  const why = ACTIVE.includes(row.partial?.state) ? rowUnavailable(row, pass) : null
  return why ? `${text} — unavailable: ${why}` : text
}

function stateCell(row) {
  if (row.partial) return `${row.partial.state}${row.partial.reason ? ` — ${row.partial.reason}` : ''}`
  return `${row.state}${row.reason ? ` — ${row.reason}` : ''} (no partial plan registered)`
}

export function MomentumTargetsReading({ status, error }) {
  if (!status) return <p role="status">Momentum partial targets unavailable{error ? `: ${error}` : '.'}</p>
  const wiring = Object.entries(status.wiring || {})
  return <>
    <p>{passSentence(status.pass)}</p>
    <p>Entry producers: {wiring.length ? wiring.map(([k, w]) => `${k === 'market' ? 'market entries' : k === 'limit' ? 'resting limits' : k} ${w.status}`).join(' · ') : 'not reported'}.
      {' '}Runtime integration: {status.runtimeIntegration}. Execution authorised: {status.executionAuthorized ? 'yes' : 'no'}.</p>
    {status.rows.length === 0
      ? <p>No momentum partial plan is recorded ({status.recordedPlans} recorded). Until an entry producer records one, the partial manager has nothing to act on; the broker TP on a position is its only target.</p>
      : <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
        <thead><tr>{['Account / trade', 'Instrument', 'Partial target (TP1)', 'Runner TP (broker)', 'State', 'Last check'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
        <tbody>{status.rows.map(row => <tr key={`${row.accountId}:${row.tradeId}`} className="border-t border-[var(--color-border)]">
          <td className="pr-3 py-2">{row.accountId} / {row.tradeId}</td>
          <td className="pr-3">{row.symbol || 'not recorded'} {row.target?.side || ''}</td>
          <td className="pr-3 max-w-md whitespace-normal">{targetCell(row, status.pass)}</td>
          <td className="pr-3">{row.target?.runnerTarget ?? 'not recorded'}</td>
          <td className="pr-3 max-w-md whitespace-normal">{stateCell(row)}</td>
          <td>{row.partial?.lastCheckAtMs ? fmtAt(row.partial.lastCheckAtMs) : 'no check recorded'}</td>
        </tr>)}</tbody>
      </table></div>}
    {status.truncated && <p>Showing the newest {status.rows.length} of {status.recordedPlans} recorded plans.</p>}
  </>
}

export default function MomentumTargets({ accountId }) {
  const [reading, setReading] = useState(null)
  useEffect(() => {
    let stopped = false, generation = 0
    const refresh = async () => {
      const mine = ++generation
      let status = null, error = null
      try {
        if (!agentConfigured()) throw new Error('Agent not connected')
        const r = await agentGet(`/state/momentum-targets?account=${encodeURIComponent(accountId)}`)
        if (r?.accountId !== accountId || !Array.isArray(r.rows)) throw new Error('Status account mismatch')
        status = r
      } catch (e) { error = e.message }
      if (!stopped && mine === generation) setReading({ accountId, status, error })
    }
    const kick = setTimeout(refresh, 0)
    const timer = setInterval(() => { if (!pageAsleep()) refresh() }, 60_000)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer) }
  }, [accountId])
  const valid = reading?.accountId === accountId
  return <Card className="my-3 text-(length:--fs-body)" aria-label="Momentum partial targets" scope={accountId}>
    <h2 className="font-semibold">Momentum partial targets (TP1)</h2>
    <MomentumTargetsReading status={valid ? reading.status : null} error={valid ? reading.error : null} />
  </Card>
}
