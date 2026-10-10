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
import { dailyStopView } from '../lib/daily-stop-display.js'

const TONE = { danger: 'down', warn: 'warn', info: 'info' }
const worst = (a) => Math.min(3, ...(a.proposals || []).map(p => ({ danger: 0, warn: 1, info: 2 })[p.severity] ?? 3))

export function Proposal({ accountId, p }) {
  // Claude · № 12,812 10-Oct (ordered № 12,810; claude-builder): a proposal
  // with no value (proposed null — "investigate first") used to print a
  // command that would SET the setting to null. Display only: no command is
  // shown for it. The command for a real value sits in a closed panel.
  const hasValue = p.proposed != null
  return (
    <div className="border-t border-[var(--color-border)] py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-(length:--fs-body)">
        <Badge tone={TONE[p.severity] || 'info'}>{String(p.severity).toUpperCase()}</Badge>
        <span className="font-semibold">{p.setting}</span>
        <span className="text-[var(--color-text-sub)]">{String(p.current)} → </span>
        <span className="font-semibold">{hasValue ? String(p.proposed) : 'no value proposed'}</span>
      </div>
      <div className="text-(length:--fs-body) mt-1 leading-relaxed">{p.why}</div>
      <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mt-1">
        <span className="font-semibold text-[var(--color-text)]">Expect:</span> {p.expect}
      </div>
      {hasValue ? (
        <details className="mt-1">
          <summary className="min-h-[44px] flex items-center text-(length:--fs-body) font-semibold text-[var(--color-text-sub)] cursor-pointer">Show the command (read-only)</summary>
          <code className="block text-(length:--fs-body) mt-0.5 whitespace-pre-wrap break-all rounded-[8px] px-2 py-1.5 bg-[color-mix(in_srgb,var(--color-border)_45%,transparent)]">
            {commandFor(accountId, p.setting, p.proposed)}
          </code>
        </details>
      ) : (
        <div className="text-(length:--fs-body) font-semibold mt-1" style={{ color: 'var(--color-down)' }}>
          No value proposed, so no command: investigate first.
        </div>
      )}
    </div>
  )
}

const SEVERITY_ORDER = { danger: 0, warn: 1, info: 2 }

export function AccountBlock({ a, stop = null }) {
  const e = a.econ || {}
  // The engine's own daily stop for this account (account-overview), shown
  // beside advice whose arithmetic may use a different cap. Display only.
  const v = stop ? dailyStopView(stop) : null
  return (
    <div className="mb-2 rounded-[12px] border border-[var(--glass-edge)] px-3 py-2">
      <div className="text-(length:--fs-body) font-semibold">{a.accountId}</div>
      <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">
        {e.trades ?? 0} closed trades · win rate {pct(e.winRate)} · payoff {num(e.payoff)}× · profit factor {num(e.profitFactor)}
      </div>
      {/* Silence is stated. An account with no proposals and an account with
          too little data to have any are different facts, and folding them
          together would let a thin sample read as approval. */}
      {a.skipped && <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mt-0.5">No advice — {a.skipped}</div>}
      {!a.skipped && a.proposals.length === 0 && (
        <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mt-0.5">Nothing to propose against this record.</div>
      )}
      {v?.capState === 'in_force' && v.cap != null && a.proposals.length > 0 && (
        <div className="text-(length:--fs-body) mt-1 rounded-[8px] px-2 py-1.5 text-[var(--color-warning-text)] bg-[var(--color-warning-bg)]">
          Daily stop the engine enforces now: {v.capCcy} {v.cap.toFixed(2)}{v.explain ? ` — ${v.explain}` : ''}. Advice arithmetic below may use a different cap.
        </div>
      )}
      {[...a.proposals].sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 3) - (SEVERITY_ORDER[y.severity] ?? 3))
        .map(p => <Proposal key={p.rule} accountId={a.accountId} p={p} />)}
    </div>
  )
}

export default function ConfigProposals({ overview = null }) {
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
      <h2 className="t-h3 text-[var(--color-accent)]">Advice from the record</h2>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-1">
        What this desk&apos;s own closed trades say the settings should be. Read-only:
        nothing here changes a value, and the controller has no write path.
        {data?.scope?.note ? ` ${data.scope.note}.` : ''}
      </p>
      {error && <div className="text-(length:--fs-body) text-[var(--color-warning-text)]">Could not load: {error}</div>}
      {!data && !error && <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">…</div>}
      {data?.accounts?.length === 0 && (
        <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">No enabled demo accounts to assess.</div>
      )}
      {/* Accounts with DANGER advice first, then WARN — the order a reader acts in. */}
      {[...(data?.accounts || [])]
        .sort((x, y) => worst(x) - worst(y))
        .map(a => <AccountBlock key={a.accountId} a={a}
          stop={overview?.accounts?.find(r => String(r.accountId) === String(a.accountId))?.dailyStop || null} />)}
    </Card>
  )
}
