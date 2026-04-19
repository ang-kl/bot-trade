import { useState, useEffect, useCallback } from 'react'
import { useStrategy } from '../lib/strategy-store.js'
import { agentGet, agentPost, agentConfigured, agentBase, ROLES } from '../lib/agent-api.js'
import { fmtAgo } from '../lib/time.js'
import Step1Matrix from '../components/pipeline/Step1Matrix.jsx'
import Step2Orders from '../components/pipeline/Step2Orders.jsx'
import Step3Monitor from '../components/pipeline/Step3Monitor.jsx'
import Step4Execute from '../components/pipeline/Step4Execute.jsx'
import Step5Close from '../components/pipeline/Step5Close.jsx'

const ROLE_STORAGE_KEY = 'bot-trade:agent-role'

const S = {
  page: { fontFamily: 'monospace' },
  header: { border: '1px solid var(--color-border)', padding: '12px', marginBottom: '8px', background: 'var(--color-surface)' },
  stepTitle: { fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.05em', color: 'var(--color-muted)', marginBottom: '4px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '4px', fontSize: '11px', marginTop: '8px' },
  stat: { color: 'var(--color-muted)', fontSize: '10px' },
  val: { fontWeight: 'bold', fontSize: '12px', color: 'var(--color-text)' },
  btn: { padding: '2px 8px', fontSize: '11px', fontFamily: 'monospace', cursor: 'pointer', border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' },
  btnActive: { background: 'var(--color-accent)', color: 'white', borderColor: 'var(--color-accent)' },
  btnKill: { background: 'var(--color-down)', color: 'white', borderColor: 'var(--color-down)' },
  error: { fontSize: '11px', color: 'var(--color-down)', padding: '6px 8px', border: '1px solid var(--color-down)', marginBottom: '8px' },
  breaker: { fontSize: '11px', color: 'var(--color-down)', padding: '6px 8px', border: '1px solid var(--color-down)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' },
  phase: { fontSize: '11px', color: 'var(--color-accent)', padding: '4px 8px', border: '1px solid var(--color-border)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' },
}

export default function Agent() {
  const { state } = useStrategy()

  const [role, setRoleState] = useState(() => {
    try {
      const saved = localStorage.getItem(ROLE_STORAGE_KEY)
      if (ROLES.includes(saved)) return saved
    } catch {}
    return ROLES.find(r => agentConfigured(r)) || 'autopilot'
  })
  const setRole = (r) => { setRoleState(r); try { localStorage.setItem(ROLE_STORAGE_KEY, r) } catch {} }

  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [activity, setActivity] = useState([])
  const [botPositions, setBotPositions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!agentConfigured(role)) return
    try {
      const [h, c, a, p] = await Promise.all([
        agentGet('/health', role).catch(e => { console.error('[health]', e.message); return null }),
        agentGet('/state/config', role).catch(e => { console.error('[config]', e.message); return null }),
        agentGet('/state/activity?limit=40', role).catch(e => { console.error('[activity]', e.message); return { activity: [] } }),
        agentGet('/state/positions', role).catch(e => { console.error('[positions]', e.message); return { positions: [] } }),
      ])
      setHealth(h); setConfig(c)
      setActivity(a?.activity || [])
      setBotPositions(p?.positions || [])
      setError(!h && !c ? `Cannot reach ${role} backend at ${agentBase(role)}` : null)
    } catch (e) { setError(e.message) }
  }, [role])

  useEffect(() => { setHealth(null); setConfig(null); setActivity([]); setBotPositions([]); setError(null) }, [role])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { const iv = setInterval(refresh, 10_000); return () => clearInterval(iv) }, [refresh])

  const scanOn = config?.scan_enabled !== false
  const analyzeOn = config?.analyze_enabled !== false
  const autotradeOn = config?.autotrade_enabled === true
  const circuitBreaker = health?.circuitBreaker

  const toggle = async (endpoint, on) => {
    setBusy(true)
    try { await agentPost(endpoint, { on }, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const killAll = async () => {
    if (!window.confirm(`Kill switch: disarm ${role} + pause all positions. Proceed?`)) return
    setBusy(true)
    try { await agentPost('/actions/kill-all', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const resetBreaker = async () => {
    setBusy(true)
    try { await agentPost('/actions/reset-breaker', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pausePos = async (id) => { try { await agentPost(`/actions/pause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }
  const unpausePos = async (id) => { try { await agentPost(`/actions/unpause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }

  const botById = {}
  for (const bp of botPositions) {
    if (bp.ctrader_position_id) botById[String(bp.ctrader_position_id)] = bp
  }

  if (!agentConfigured('autopilot') && !agentConfigured('copilot')) {
    return (
      <section style={S.page}>
        <div style={S.header}>
          <p style={{ fontSize: '13px', fontWeight: 'bold' }}>&gt;_ TRADE WINDOW</p>
          <p style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '4px' }}>
            Agent backend not configured. Set VITE_AGENT_URL_AUTOPILOT + VITE_AGENT_SECRET_AUTOPILOT in Vercel env.
          </p>
        </div>
      </section>
    )
  }

  const statusText = role === 'copilot' ? 'COPILOT'
    : circuitBreaker ? 'CIRCUIT BREAKER'
    : autotradeOn ? 'AUTO-TRADE ON'
    : analyzeOn ? 'ANALYZE ONLY'
    : scanOn ? 'SCAN ONLY' : 'ALL OFF'

  const statusColor = role === 'copilot' ? 'var(--color-accent)'
    : circuitBreaker ? 'var(--color-down)'
    : autotradeOn ? 'var(--color-up)'
    : 'var(--color-muted)'

  return (
    <section style={S.page}>
      {/* Role switcher */}
      {(agentConfigured('autopilot') || agentConfigured('copilot')) && (
        <div style={{ ...S.row, marginBottom: '4px' }}>
          {ROLES.map(r => {
            const wired = agentConfigured(r)
            const active = r === role
            return (
              <button key={r} type="button" onClick={() => wired && setRole(r)} disabled={!wired}
                style={{ ...S.btn, ...(active ? S.btnActive : {}), opacity: wired ? 1 : 0.3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                {r}
              </button>
            )
          })}
        </div>
      )}

      {/* Header */}
      <div style={S.header}>
        <div style={{ ...S.row, justifyContent: 'space-between' }}>
          <div style={{ ...S.row }}>
            <span style={{ fontSize: '14px', fontWeight: 'bold' }}>&gt;_ TRADE WINDOW</span>
            <span style={{ fontSize: '11px', fontWeight: 'bold', color: statusColor, border: `1px solid ${statusColor}`, padding: '1px 6px' }}>
              {statusText}
            </span>
          </div>
          <button type="button" onClick={killAll} disabled={busy} style={S.btnKill}>KILL SWITCH</button>
        </div>

        {/* Toggles */}
        {role === 'autopilot' && (
          <div style={{ ...S.row, marginTop: '8px' }}>
            <button type="button" onClick={() => toggle('/actions/scan-toggle', !scanOn)} disabled={busy}
              style={{ ...S.btn, ...(scanOn ? S.btnActive : {}) }}>{scanOn ? '[ON]' : '[--]'} SCAN</button>
            <button type="button" onClick={() => toggle('/actions/analyze-toggle', !analyzeOn)} disabled={busy}
              style={{ ...S.btn, ...(analyzeOn ? S.btnActive : {}) }}>{analyzeOn ? '[ON]' : '[--]'} ANALYZE</button>
            <button type="button" onClick={() => toggle('/actions/autotrade-toggle', !autotradeOn)} disabled={busy}
              style={{ ...S.btn, ...(autotradeOn ? { background: 'var(--color-up)', color: 'white', borderColor: 'var(--color-up)' } : {}) }}>
              {autotradeOn ? '[ON]' : '[--]'} TRADE
            </button>
          </div>
        )}

        {error && <div style={S.error}>[ERR] {error}</div>}

        {circuitBreaker && (
          <div style={S.breaker}>
            <span>[CIRCUIT BREAKER TRIPPED] {fmtAgo(circuitBreaker)}</span>
            <button type="button" onClick={resetBreaker} disabled={busy} style={S.btn}>RESET</button>
          </div>
        )}

        {health?.loopPhase && (
          <div style={S.phase}>
            <span style={{ color: health.loopPhase.startsWith('sleeping') ? 'var(--color-muted)' : 'var(--color-up)' }}>
              {health.loopPhase.startsWith('sleeping') ? '○' : '●'}
            </span>
            <span>{health.loopPhase.toUpperCase()}</span>
          </div>
        )}

        <div style={S.grid}>
          <div><span style={S.stat}>Loops</span><br /><span style={S.val}>{health?.loopCount ?? '--'}</span></div>
          <div><span style={S.stat}>Last Scan</span><br /><span style={S.val}>{fmtAgo(health?.lastScanAt) || '--'}</span></div>
          <div><span style={S.stat}>Symbols</span><br /><span style={S.val}>{(config?.symbols || config?.watchlist || []).filter(w => w.enabled !== false).length}</span></div>
          <div><span style={S.stat}>Positions</span><br /><span style={S.val}>{botPositions.length}</span></div>
          <div><span style={S.stat}>Uptime</span><br /><span style={S.val}>{health?.uptime ? `${(health.uptime / 3600).toFixed(1)}h` : '--'}</span></div>
          <div><span style={S.stat}>Memory</span><br /><span style={S.val}>{health?.memoryMB ? `${health.memoryMB}MB` : '--'}</span></div>
          <div><span style={S.stat}>Errors</span><br /><span style={{ ...S.val, color: health?.errorsToday > 0 ? 'var(--color-down)' : undefined }}>{health?.errorsToday ?? 0}</span></div>
          <div><span style={S.stat}>Tokens</span><br /><span style={S.val}>{health?.dailyTokensUsed ? `${(health.dailyTokensUsed / 1000).toFixed(0)}k` : '0'}</span></div>
        </div>
      </div>

      {/* Pipeline steps */}
      <Step1Matrix role={role} activity={activity} />
      <Step2Orders role={role} />
      <Step3Monitor
        role={role}
        health={health}
        botPositions={botPositions}
        ctrader={state.ctrader}
        botById={botById}
        onPause={pausePos}
        onUnpause={unpausePos}
      />
      <Step4Execute role={role} />
      <Step5Close role={role} />
    </section>
  )
}
