const onOff = value => value === true ? 'ON' : value === false ? 'OFF' : 'UNVERIFIED'
const count = value => value == null ? 'Unverified' : String(value)
const stamp = value => value ? new Date(value).toLocaleString() : 'No reading'

export default function ControllerRuntime({ runtime }) {
  if (!runtime) return <p role="status">Tick and protection status unavailable.</p>
  const missing = runtime.accounts.flatMap(a => (a.missingTargets || []).map(p => ({ ...p, account: a.accountId, stale: a.protection.stale || a.protection.lastAttemptOk === false })))
  return (
    <div className="text-(length:--fs-body) mb-3 space-y-2">
      <p>The clock updates every second. Strategy checks follow quote events or scheduled scans. A heartbeat does not confirm an entry or a protected position.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="text-left font-semibold">Tick processing by service</caption>
          <thead><tr>{['Service', 'Feed', 'Recording', 'Shadow', 'Entry accounts', 'Tick trailing'].map(h => <th key={h} className="pr-3 py-1">{h}</th>)}</tr></thead>
          <tbody>{runtime.sides.map(s => <tr key={s.key}>
            <td className="pr-3 py-1">{s.service} ({s.label})</td>
            <td className="pr-3">{onOff(s.feedConnected)}<br />Last tick: {stamp(s.lastTickAt)}</td>
            <td className="pr-3">{s.recorder}</td>
            <td className="pr-3">{onOff(s.shadow)}</td>
            <td className="pr-3">{count(s.entryAccounts)}</td>
            <td className="pr-3">{s.trail ? `${s.trail.tracked} tracked; ${s.trail.amendsFailed} failed amendments` : s.healthFresh ? 'Not reported / disabled' : 'UNVERIFIED'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {runtime.sides.map(s => <p key={s.key}>{s.service}: status read {stamp(s.tickAt)}{s.reason ? ` - ${s.reason}` : ''}.</p>)}
      <p>Entry accounts means the sidecar permits those accounts to submit tick entries; it does not mean a trade occurred. Tick momentum checks price, spread and volatility, without traded-volume confirmation.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="text-left font-semibold">Account entry and protection status</caption>
          <thead><tr>{['Account', 'Entry mode', 'Shadow / entry readiness', 'Broker protection'].map(h => <th key={h} className="pr-3 py-1">{h}</th>)}</tr></thead>
          <tbody>{runtime.accounts.map(a => <tr key={a.accountId}>
            <td className="pr-3 py-1">{a.accountId} ({a.environment}){a.enabled ? '' : ' - disabled'}</td>
            <td className="pr-3">{a.entryMode}</td>
            <td className="pr-3">Shadow: {a.shadowReady ? 'READY' : 'BLOCKED'}; entries: {a.entryReady ? 'READY' : 'BLOCKED'}
              {!a.shadowReady && <div>Shadow: {a.shadowBlockers.join(', ')}</div>}
              {!a.entryReady && <div>Entry: {a.tradingBlockers.join(', ')}</div>}</td>
            <td className="pr-3">{a.protection.summary}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {runtime.monitor && <p>Monitor interval: {count(runtime.monitor.tick?.everyMs)} ms; protection interval: {count(runtime.monitor.band?.everyMs)} ms; last protection duration: {count(runtime.monitor.band?.lastMs)} ms{runtime.monitor.band?.overran ? ' - OVERRAN' : ''}. Recorded: {stamp(runtime.monitor.at)}.</p>}
      {missing.length > 0 && <div role="status"><strong>Missing TP1 - last broker audit</strong>
        <ul>{missing.map(p => <li key={`${p.account}:${p.positionId}`}>{p.account} / {p.symbol} / {p.positionId}: {p.recordedTarget == null ? 'Target decision required - no recorded target' : `Recorded target ${p.recordedTarget} available; broker confirmation pending`}{p.stale ? ' (audit stale or latest check failed)' : ''}</li>)}</ul>
      </div>}
    </div>
  )
}
