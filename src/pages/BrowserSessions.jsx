import { useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import { SleepAfter, ConfirmDisconnect } from '../components/SessionFooter.jsx'
import { agentConfigured, agentGet, agentPost, pageAsleep } from '../lib/agent-api.js'

const when = t => t ? new Date(t).toLocaleString() : 'Not recorded'
export default function BrowserSessions() {
  const [view, setView] = useState(null), [error, setError] = useState('')
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    const refresh = async () => {
      if (pageAsleep() || !agentConfigured()) return
      try { const v = await agentGet('/state/sessions'); if (!stopped) { setView(v); setError('') } }
      catch (e) { if (!stopped) setError(e.message) }
    }
    const kick = setTimeout(refresh, 0), timer = setInterval(refresh, 15000)
    window.addEventListener('agent-wake', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer)
      window.removeEventListener('agent-wake', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [revision])
  const disconnect = async () => {
    setBusy(true)
    try {
      const result = await agentPost(`/actions/sessions/${encodeURIComponent(pending.id)}/revoke`, { reason: 'user_requested' })
      if (result?.ok === false) throw new Error(result.reason || 'Session was not disconnected')
      setView(await agentGet('/state/sessions'))
      setPending(null); setRevision(n => n + 1)
    }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  return <div className="space-y-3 text-(length:--fs-body)">
    <h1 className="t-h1">Browser sessions</h1>
    <p>Each row identifies a browser login and its open pages. Disconnecting revokes that login; it does not stop the trading bot or physically close a browser tab.</p>
    {view?.currentIsMaster && <p>This device uses the primary operator login. It has no separate session credential to disconnect. {view.masterNote}</p>}
    {view?.masterCaller && <p>{view.masterCaller.label} · {view.masterCaller.openTabs} tabs · {view.masterCaller.ip || 'IP not recorded'} · {view.masterCaller.timezone || 'Timezone not recorded'}</p>}
    {error && <p role="alert">{error}</p>}
    <Card><h2 className="t-h3">This tab’s updates</h2><SleepAfter /></Card>
    <Card><h2 className="t-h3">Sessions and activity</h2>
      {!view ? <p>Reading sessions…</p> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-(length:--fs-body)">
        <thead><tr>{['Browser / device', 'State', 'Last seen', 'Created', 'Expires', 'Pages / details', 'Action'].map(s => <th key={s} className="pr-3">{s}</th>)}</tr></thead>
        <tbody>{(view.sessions || []).map(s => <tr key={s.id} className="border-t border-[var(--color-border)]">
          <td className="pr-3 py-2">{s.label || s.browserFamily || 'Browser'}{s.isCurrent ? ' · this login' : ''}</td>
          <td className="pr-3">{s.state}</td><td className="pr-3">{when(s.lastSeenAt)}</td><td className="pr-3">{when(s.createdAt)}{s.createdAtEstimated ? ' · estimated' : ''}</td><td className="pr-3">{when(s.expiresAt)}</td>
          <td className="pr-3"><details><summary>{s.openTabs ?? 0} tabs · details</summary>
            <p>Browser: {[s.browserFamily, s.browserVersion].filter(Boolean).join(' ') || 'Not recorded'} · OS: {s.operatingSystem || 'Not recorded'}</p>
            <p>Timezone: {s.timezone || 'Not recorded'} · Country: {s.country || 'Not recorded'} · IP: {s.ip || 'Not recorded'}</p>
            <p>Pages: {(s.pages || []).map(p => typeof p === 'string' ? p : p.page || p.path || 'Page').join(', ') || 'None currently reported'}</p>
            {s.revokedAt && <p>Disconnected: {when(s.revokedAt)}</p>}
          </details></td>
          <td>{s.canDisconnect ? <button onClick={() => setPending(s)}>Disconnect</button> : '—'}</td>
        </tr>)}</tbody>
      </table></div>}
    </Card>
    {pending && <ConfirmDisconnect session={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={disconnect} />}
  </div>
}
