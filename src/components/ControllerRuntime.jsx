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
          <thead><tr>{['Account', 'Entry mode / effective switches', 'Tick shadow / tick entry readiness', 'Broker protection', 'Independent cpp-verify check'].map(h => <th key={h} className="pr-3 py-1">{h}</th>)}</tr></thead>
          <tbody>{runtime.accounts.map(a => <tr key={a.accountId}>
            <td className="pr-3 py-1">{a.accountId} ({a.environment}){a.enabled ? '' : ' - disabled'}{a.brokerAccess === 'TOKEN_REFUSED' && <div>Broker authorisation required</div>}</td>
            <td className="pr-3">{a.entryMode}
              {a.phases && ['scan', 'analyze', 'autotrade'].map(p => <div key={p}>{p}: {onOff(a.phases[p])} ({a.phases.source?.[p] || 'unknown source'})</div>)}
              {a.entryCounts && <div>Intents: {a.entryCounts.unsent} reserved; {a.entryCounts.inFlight} in flight; {a.entryCounts.unknown} unknown</div>}</td>
            <td className="pr-3">Tick shadow: {a.shadowReady ? 'READY' : 'BLOCKED'}; tick entries: {a.entryReady ? 'READY' : 'BLOCKED'}
              {!a.shadowReady && <div>Shadow: {a.shadowBlockers.join(', ')}</div>}
              {!a.entryReady && <div>Tick entry: {a.tradingBlockers.join(', ')}</div>}</td>
            <td className="pr-3">{a.protection.summary}</td>
            <td className="pr-3">{a.independentProtection?.summary || 'UNVERIFIED'}<br />{stamp(a.independentProtection?.checkedAt)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Independent protection checks read every registered account directly from the broker in cpp-verify, on a separate session from closed-trade verification. Checks repeat 60 seconds after each pass; readings older than three minutes are unverified.</p>
      <p>Effective switches show permission to run. Strategy, evidence and risk gates still decide whether a scheduled entry can proceed. A blocked tick entry does not mean scheduled entries or position management are switched off.</p>
      {runtime.process && <details>
        <summary>Process timing: {runtime.process.phase}</summary>
        <p>Latest stored scan: {stamp(runtime.process.lastScanAt)}. These timings describe the last completed measurements.</p>
        {Object.entries(runtime.process.phaseLag || {}).map(([phase, lag]) => <p key={phase}>{phase}: maximum event-loop delay {count(lag.maxMs)} ms; CPU/wall ratio during worst stall {count(lag.worstStallCpuRatio)}.</p>)}
        {Object.entries(runtime.process.profiles || {}).map(([phase, profile]) => <div key={phase}>
          <p>{phase}: sampled {count(profile.totalMs)} ms; idle {count(profile.idleMs)} ms.</p>
          <ul>{(profile.top || []).slice(0, 5).map(f => <li key={f.frame}>{f.frame}: {f.selfMs} ms ({f.pct}%)</li>)}</ul>
        </div>)}
      </details>}
      {runtime.monitor && <p>Monitor interval: {count(runtime.monitor.tick?.everyMs)} ms; protection interval: {count(runtime.monitor.band?.everyMs)} ms; last protection duration: {count(runtime.monitor.band?.lastMs)} ms{runtime.monitor.band?.overran ? ' - OVERRAN' : ''}. Recorded: {stamp(runtime.monitor.at)}.</p>}
      {runtime.managementWork && <details>
        <summary>Position evaluations · recorded {stamp(runtime.managementWork.at)}{runtime.managementWork.complete === false ? ' · COVERAGE TRUNCATED' : ''}</summary>
        <p>Evaluation completion and broker amendment outcomes are separate. This record does not establish exclusive writer ownership or broker confirmation.</p>
        <div className="overflow-x-auto"><table className="w-full text-left">
          <thead><tr>{['Account / position', 'Evaluation', 'Last completed', 'Next due', 'Action outcome'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
          <tbody>{(runtime.managementWork.positions || []).map(p => <tr key={`${p.accountId}:${p.positionId}`}>
            <td className="pr-3">{p.accountId} / {p.symbol} / {p.brokerPositionId || p.positionId}</td>
            <td className="pr-3">{p.state}{p.error ? ` — ${p.error}` : ''}</td>
            <td className="pr-3">{stamp(p.lastCompletedAt)}</td>
            <td className="pr-3">{stamp(p.nextDueAt)}</td>
            <td className="pr-3">{p.actionOutcome || (p.action === 'HOLD' ? 'No amendment needed' : 'No outcome recorded')}</td>
          </tr>)}</tbody>
        </table></div>
      </details>}
      {missing.length > 0 && <div role="status"><strong>Missing TP1 - last broker audit</strong>
        <ul>{missing.map(p => <li key={`${p.account}:${p.positionId}`}>{p.account} / {p.symbol} / {p.positionId}: {p.repairFailure?.retryable === false && ['TRADING_BAD_STOPS', 'TRADING_BAD_VOLUME'].includes(p.repairFailure.code) ? `Action required: ${p.repairFailure.code || 'broker refusal'} at TP ${p.repairFailure.attemptedTarget}. ${p.repairFailure.error}. Identical automatic repair paused.` : p.recordedTarget == null ? 'Target decision required - no recorded target' : `Recorded target ${p.recordedTarget} available; broker confirmation pending`}{p.stale ? ' (audit stale or latest check failed)' : ''}</li>)}</ul>
      </div>}
    </div>
  )
}
