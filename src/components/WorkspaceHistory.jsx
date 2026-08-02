// A5's UI half — the workspace's own logs and backtest history.
//
// The two routes have existed since the A5 commit with nothing reading them,
// which was recorded as a gap rather than glossed over. This closes it.
//
// TWO TABLES, ONE SCOPE. Both follow the account selected in the sidebar and
// both say so in words above the rows, because the whole point of a workspace
// is that "which account is this about" is never left to be inferred.
//
// THE ROW-ORIGIN DISTINCTION IS THE CAREFUL PART. A scoped read includes rows
// with NO account stamp — that is the convention every scoped read here uses,
// and for the audit trail it is more than convention: an account's history
// without the master switch flips would omit the changes that actually
// affected it. But an unstamped row is NOT this account's action; it either
// predates stamping or is genuinely global. So each row says which, and a
// global flip can never read as something done to this account.
import { useCallback, useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import { selectedAccountId, accountLabel } from '../lib/selected-account.js'
import { actionLabel, rowOrigin, ago, backtestResult, toText } from '../lib/workspace-history-view.js'
import Badge from './common/Badge.jsx'
import SectionTools from './common/SectionTools.jsx'

const ORIGIN_TONE = { own: 'on', shared: 'neutral', other: 'warning' }

export function OriginTag({ row, accountId }) {
  const o = rowOrigin(row, accountId)
  return <Badge tone={ORIGIN_TONE[o.kind] || 'neutral'}>{o.label}</Badge>
}

export function LogTable({ rows, accountId }) {
  if (!rows.length) {
    return <p className="text-[9px] text-[var(--color-text-sub)]">No actions recorded for this workspace yet.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr className="text-left text-[var(--color-text-sub)]">
            <th className="py-1 pr-2 font-semibold">When</th>
            <th className="py-1 pr-2 font-semibold">Action</th>
            <th className="py-1 pr-2 font-semibold">Scope</th>
            <th className="py-1 font-semibold">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="py-1 pr-2 whitespace-nowrap text-[var(--color-text-sub)]">{ago(r.at)}</td>
              <td className="py-1 pr-2 font-semibold">{actionLabel(r.path)}</td>
              <td className="py-1 pr-2"><OriginTag row={r} accountId={accountId} /></td>
              <td className="py-1 text-[var(--color-text-sub)] break-all">{String(r.body || '').slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BacktestTable({ rows, accountId }) {
  if (!rows.length) {
    return <p className="text-[9px] text-[var(--color-text-sub)]">No backtest runs recorded for this workspace yet.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr className="text-left text-[var(--color-text-sub)]">
            <th className="py-1 pr-2 font-semibold">When</th>
            <th className="py-1 pr-2 font-semibold">Symbol</th>
            <th className="py-1 pr-2 font-semibold">TF</th>
            <th className="py-1 pr-2 font-semibold">Strategy</th>
            <th className="py-1 pr-2 font-semibold">Result</th>
            <th className="py-1 font-semibold">Ran under</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const res = backtestResult(r)
            return (
              <tr key={r.id}>
                <td className="py-1 pr-2 whitespace-nowrap text-[var(--color-text-sub)]">{ago(r.ran_at)}</td>
                <td className="py-1 pr-2 font-semibold">{r.symbol}</td>
                <td className="py-1 pr-2">{r.timeframe}</td>
                <td className="py-1 pr-2 text-[var(--color-text-sub)]">{r.strategy}</td>
                {/* A failed run is an ABSENCE of evidence, not a zero result —
                    it never shares a column treatment with a real flat run. */}
                <td className={`py-1 pr-2 ${res.ok ? '' : 'text-[var(--color-down)]'}`}>{res.text}</td>
                <td className="py-1"><OriginTag row={r} accountId={accountId} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function WorkspaceHistory() {
  const [acct, setAcct] = useState(() => selectedAccountId())
  const [log, setLog] = useState(null)
  const [backtests, setBacktests] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    const q = acct != null && acct !== '' ? `&account=${encodeURIComponent(acct)}` : ''
    Promise.all([
      agentGet(`/state/workspace-log?limit=100${q}`).catch(e => ({ __err: e?.message || String(e) })),
      agentGet(`/state/workspace-backtests?limit=200${q}`).catch(() => null),
    ]).then(([l, b]) => {
      if (!alive) return
      if (l?.__err) { setErr(l.__err); return }
      setErr(null)
      setLog(l)
      setBacktests(b)
    })
    return () => { alive = false }
  }, [acct])

  useAccountSwitch(useCallback((ev) => { setAcct(ev?.to ?? selectedAccountId()) }, []))

  if (err) return <p className="text-[9px] text-[var(--color-down)]">Workspace history unavailable: {err}</p>
  if (!log) return <p className="text-[9px] text-[var(--color-text-sub)]">Loading…</p>

  const logRows = log.rows || []
  const btRows = backtests?.rows || []
  const unstamped = logRows.filter(r => r.account_id == null).length

  return (
    <div id="sec-workspace" className="flex flex-col gap-2 text-[9px]">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="t-h3">Workspace History table</h3>
        <span className="text-[var(--color-text-sub)]">
          {acct ? (accountLabel(acct) || `account ${acct}`) : 'all accounts'} · {log.scope}
        </span>
        <SectionTools id="workspace" title="Workspace History table"
          data={{ scope: log.scope, log: logRows, backtests: btRows }}
          toText={() => toText({ scope: log.scope, log: logRows, backtests: btRows })}
          render={() => (
            <>
              <LogTable rows={logRows} accountId={acct} />
              <BacktestTable rows={btRows} accountId={acct} />
            </>
          )} />
      </div>
      <p className="text-[var(--color-text-sub)]">
        Actions and backtest runs recorded under this workspace. Rows with no account stamp are included —
        they are either master switches that applied to every account, or history from before per-account
        stamping — and each row says which, so a global change never reads as something done to this account.
        {unstamped > 0 && <> <strong>{unstamped}</strong> of the {logRows.length} actions shown are unstamped.</>}
      </p>

      <div>
        <div className="font-semibold text-[var(--color-accent)]">
          Actions {log.truncated && <span className="font-normal text-[var(--color-text-sub)]">(newest 100 — capped)</span>}
        </div>
        <LogTable rows={logRows} accountId={acct} />
      </div>

      <div>
        <div className="font-semibold text-[var(--color-accent)]">
          Backtest runs {backtests?.truncated && <span className="font-normal text-[var(--color-text-sub)]">(newest 200 — capped)</span>}
        </div>
        <BacktestTable rows={btRows} accountId={acct} />
      </div>
    </div>
  )
}
