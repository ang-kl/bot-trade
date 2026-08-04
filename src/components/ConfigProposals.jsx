// ---------------------------------------------------------------------------
// ConfigProposals.jsx — C-1's output, on the Risk page beside the settings it
// is talking about.
//
// PROPOSALS, NOT ACTIONS. There is deliberately no Apply button. The owner's
// decision (§5496·C) was propose-only, and a one-tap apply would quietly turn
// it into an auto-adjusting controller with a human as a rubber stamp. Copy
// the command, read it, run it — the same friction that made today's config
// changes deliberate.
//
// EVERY ROW SHOWS ITS ARITHMETIC. `why` is the whole point: "raise minRR to
// 3.2" is an instruction to obey or ignore, while "34.4% win rate, needs 1.91
// to break even and 3.20 to hit the target, currently 1.5" is something the
// reader can check and disagree with.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import { pct, num, commandFor } from '../lib/config-proposal-format.js'

const TONE = { danger: 'down', warn: 'warn', info: 'info' }

export function Proposal({ accountId, p }) {
  return (
    <div className="border-t border-[var(--color-border)] py-1">
      <div className="flex items-center gap-1.5 text-[9px]">
        <Badge tone={TONE[p.severity] || 'info'}>{String(p.severity).toUpperCase()}</Badge>
        <span className="font-semibold">{p.setting}</span>
        <span className="text-[var(--color-text-sub)]">{String(p.current)} → </span>
        <span className="font-semibold">{String(p.proposed)}</span>
      </div>
      <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">{p.why}</div>
      <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">
        <span className="font-semibold">Expect:</span> {p.expect}
      </div>
      <code className="block text-[9px] mt-0.5 overflow-x-auto whitespace-pre">
        {commandFor(accountId, p.setting, p.proposed)}
      </code>
    </div>
  )
}

export function AccountBlock({ a }) {
  const e = a.econ || {}
  return (
    <div className="mb-2">
      <div className="text-[9px] font-semibold">{a.accountId}</div>
      <div className="text-[9px] text-[var(--color-text-sub)]">
        {e.trades ?? 0} closed trades · win rate {pct(e.winRate)} · payoff {num(e.payoff)}× · profit factor {num(e.profitFactor)}
      </div>
      {/* Silence is stated. An account with no proposals and an account with
          too little data to have any are different facts, and folding them
          together would let a thin sample read as approval. */}
      {a.skipped && <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">No advice — {a.skipped}</div>}
      {!a.skipped && a.proposals.length === 0 && (
        <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">Nothing to propose against this record.</div>
      )}
      {a.proposals.map(p => <Proposal key={p.rule} accountId={a.accountId} p={p} />)}
    </div>
  )
}

export default function ConfigProposals() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!agentConfigured()) return
    agentGet('/state/config-proposals').then(setData).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  if (!agentConfigured()) return null

  return (
    <Card id="sec-config-proposals" data-risk-card className="w3-hover-shadow">
      <h2 className="t-h3">Settings vs the Record card</h2>
      <p className="text-[9px] text-[var(--color-text-sub)] mb-1">
        What this desk&apos;s own closed trades say the settings should be. Read-only:
        nothing here changes a value, and the controller has no write path.
        {data?.scope?.note ? ` ${data.scope.note}.` : ''}
      </p>
      {error && <div className="text-[9px] text-[var(--color-warning-text)]">Could not load: {error}</div>}
      {!data && !error && <div className="text-[9px] text-[var(--color-text-sub)]">…</div>}
      {data?.accounts?.length === 0 && (
        <div className="text-[9px] text-[var(--color-text-sub)]">No enabled demo accounts to assess.</div>
      )}
      {(data?.accounts || []).map(a => <AccountBlock key={a.accountId} a={a} />)}
    </Card>
  )
}
