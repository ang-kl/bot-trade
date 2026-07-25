// Accounts › Workflow audit — the design_claude "Trade Workflow Audit"
// screen as a sub-page of Accounts (owner: "Trade audit will be a sub page
// in accounts"). All the audit logic lives in components/WorkflowAudit.jsx;
// this page just fetches the real closed-trade + postmortem data and hosts
// the sub-nav shared with the Accounts overview.
//
// Owner (2026-07-25): "run a PR to read historical trades" — the same-symbol
// cluster report lives here too, because "did the algo open this symbol twice"
// is the same question as "did each trade run the full pipeline", read from
// the same history.
import { useCallback, useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import AccountsSubNav from '../components/AccountsSubNav.jsx'
import WorkflowAudit from '../components/WorkflowAudit.jsx'
import SymbolClusters from '../components/SymbolClusters.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'

const REFRESH_MS = 60_000

export default function AccountsAudit() {
  const [allTrades, setAllTrades] = useState([])
  const [postmortems, setPostmortems] = useState([])
  const [error, setError] = useState('')
  // Cluster report — its own range/window state, its own request and its own
  // error, so a failure on that route never blanks the workflow audit below.
  const [days, setDays] = useState(14)
  const [windowMinutes, setWindowMinutes] = useState(60)
  const [clusters, setClusters] = useState(null)
  const [clusterErr, setClusterErr] = useState('')
  const [clusterLoading, setClusterLoading] = useState(true)

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

  const loadClusters = useCallback(async () => {
    if (!agentConfigured()) { setClusterLoading(false); return }
    setClusterLoading(true)
    try {
      const r = await agentGet(`/state/symbol-clusters?days=${days}&windowMinutes=${windowMinutes}`)
      setClusters(r || { clusters: [], byPath: {} })
      setClusterErr('')
    } catch (e) {
      // An agent build predating the route 404s. Say that plainly — an empty
      // report would read as "no duplicates found", which is not the same.
      setClusterErr(/404|not found/i.test(e.message)
        ? 'This agent build does not have /state/symbol-clusters yet — redeploy the agent to read the cluster report.'
        : e.message)
    } finally {
      setClusterLoading(false)
    }
  }, [days, windowMinutes])

  useEffect(() => {
    const kick = setTimeout(load, 0)
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  useEffect(() => { loadClusters() }, [loadClusters])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-bold t-heading">Accounts · Workflow audit</h1>
        <span className="text-[9px] text-[var(--color-text-sub)]">
          Lab → Bridge → Market · did each trade run the full pipeline, and were early stops justified?
        </span>
      </div>
      <AccountsSubNav />
      {error && <Card className="border-[var(--color-down)] text-[9px]">{error}</Card>}
      <Card>
        <SymbolClusters
          data={clusters} loading={clusterLoading} error={clusterErr}
          days={days} windowMinutes={windowMinutes}
          onDays={setDays} onWindow={setWindowMinutes}
        />
      </Card>
      <Card>
        <WorkflowAudit allTrades={allTrades} postmortems={postmortems} />
      </Card>
    </div>
  )
}
