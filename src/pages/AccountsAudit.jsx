// Accounts › Workflow audit — the design_claude "Trade Workflow Audit"
// screen as a sub-page of Accounts (owner: "Trade audit will be a sub page
// in accounts"). All the audit logic lives in components/WorkflowAudit.jsx;
// this page just fetches the real closed-trade + postmortem data and hosts
// the sub-nav shared with the Accounts overview.
import { useCallback, useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import AccountsSubNav from '../components/AccountsSubNav.jsx'
import WorkflowAudit from '../components/WorkflowAudit.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'

const REFRESH_MS = 60_000

export default function AccountsAudit() {
  const [allTrades, setAllTrades] = useState([])
  const [postmortems, setPostmortems] = useState([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const [t, pms] = await Promise.all([
        agentGet('/state/trades'),
        agentGet('/state/postmortems?limit=100').catch(() => null),
      ])
      setAllTrades(t?.rows || t?.trades || [])
      setPostmortems(pms?.rows || pms?.postmortems || [])
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    const kick = setTimeout(load, 0)
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-bold t-heading">Accounts · Workflow audit</h1>
        <span className="text-[12px] text-[var(--color-text-sub)]">
          Lab → Bridge → Market · did each trade run the full pipeline, and were early stops justified?
        </span>
      </div>
      <AccountsSubNav />
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      <Card>
        <WorkflowAudit allTrades={allTrades} postmortems={postmortems} />
      </Card>
    </div>
  )
}
