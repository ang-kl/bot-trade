import { getState, setState } from '../db.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { emitBrokerRead } from '../lib/broker-read-observer.js'
import { beat } from './heartbeat.js'

const STATE_KEY = 'independent_protection_json'
const MAX_AGE_MS = 180_000

export function independentProtectionView(db, accountId, nowMs = Date.now()) {
  let state
  try { state = JSON.parse(getState(db, STATE_KEY) || 'null') } catch { /* unknown */ }
  const row = state?.accounts?.find(a => String(a.accountId) === String(accountId))
  const checkedAt = Number(row?.checkedAtMs)
  const ageMs = checkedAt > 0 ? nowMs - checkedAt : null
  const stale = ageMs == null || ageMs < 0 || ageMs > MAX_AGE_MS
  const readError = state?.error || state?.accountErrors?.[String(accountId)] || state?.hostErrors?.[row?.host] || row?.error
  const valid = ['openCount', 'missingSl', 'missingTp'].every(k => Number.isInteger(row?.[k]) && row[k] >= 0)
    && row.missingSl <= row.openCount && row.missingTp <= row.openCount && row.source === 'broker_reconcile'
  const ok = !readError && row?.ok === true && valid && !stale
  return { ...row, ok, stale, ageMs, checkedAt: checkedAt > 0 ? new Date(checkedAt).toISOString() : null,
    error: readError || (!row ? 'No independent broker reading' : !valid ? 'Invalid independent reading' : null),
    summary: !ok ? `UNVERIFIED: ${readError || (stale ? 'reading absent or stale' : 'check failed')}`
      : `${row.openCount} open; ${row.missingSl} missing SL; ${row.missingTp} missing TP1`,
  }
}

/**
 * V3 CV-2 (OD-10): cpp-verify's delivery gate as the verify_watchdog beat
 * carries it. Delivery is muted through a 24 h soak and stays muted until an
 * explicit verifier-local unmute; `wouldSend` is what would have left in the
 * meantime. A status with no `delivery` block (a verifier built before CV-2,
 * or a busy reply) is reported as such, never as muted.
 */
export function watchdogDeliveryDetail(status) {
  const d = status?.delivery
  if (!d || typeof d !== 'object' || typeof d.muted !== 'boolean') return null
  const pick = k => d[k] ?? null
  return { muted: d.muted, open: d.open === true, reason: pick('reason'), soakActive: pick('soakActive'),
    soakStartedAtMs: pick('soakStartedAtMs'), soakEndsAtMs: pick('soakEndsAtMs'), soakRemainingMs: pick('soakRemainingMs'),
    wouldSend: d.wouldSend && typeof d.wouldSend === 'object' ? d.wouldSend : null,
    outboxPending: pick('outboxPending'), stateBytes: status.stateBytes ?? null }
}

// Node only provisions read sessions and relays cpp-verify's results. The
// independent process performs its own reconcile every 60s after each pass.
export function makeIndependentProtectionPoll(db, { env = process.env, fetchImpl = globalThis.fetch, log = console.log, now = Date.now } = {}) {
  const base = String(env.VERIFY_URL || '').trim().replace(/\/+$/, '')
  const secret = String(env.EXEC_SECRET || '')
  if (!base || !secret) return null
  let running = false
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
  const request = async (path, body) => {
    const res = await fetchImpl(`${base}${path}`, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 90_000 : 10_000) })
    if (!res.ok) throw new Error(`cpp-verify ${path}: HTTP ${res.status}`)
    return res.json()
  }
  const fingerprints = new Map()
  let lastReport = null
  const report = () => {
    const accounts = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all()
    const checks = accounts.map(a => {
      const v = independentProtectionView(db, a.account_id)
      return { accountId: a.account_id, checkedAt: v.checkedAt, ok: v.ok, summary: v.summary }
    })
    const message = JSON.stringify(checks)
    if (message !== lastReport) { log(`[independent-protection] ${message}`); lastReport = message }
  }
  return async () => {
    if (running) return
    running = true
    try {
      let status = await request('/protection-status')
      if (status?.source !== 'cpp-verify' || !Array.isArray(status.accounts) || !Array.isArray(status.sessions)) throw new Error('Invalid independent protection reply')
      // Include every registered account. Entry enablement never gates reads
      // of existing protection, including manage-only or zero-balance accounts.
      const accounts = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all()
      const groups = new Map()
      const accountErrors = {}
      for (const a of accounts) {
        const creds = credsForRegisteredAccount(db, a.account_id)
        if (!creds?.ready) { accountErrors[String(a.account_id)] = 'Broker credentials unavailable for independent check'; continue }
        if (!groups.has(creds.host)) groups.set(creds.host, { creds, ids: [] })
        groups.get(creds.host).ids.push(String(a.account_id))
      }
      // Separate hosts can connect independently; each host has one roster.
      const hostErrors = {}
      const groupList = [...groups]
      const connections = await Promise.allSettled(groupList.map(async ([host, { creds, ids }]) => {
        const session = status.sessions.find(s => s.host === host)
        const signature = JSON.stringify([creds.clientId, creds.clientSecret, creds.accessToken, ids])
        const authorised = new Set((session?.accounts || []).map(String))
        const exactRoster = authorised.size === ids.length && ids.every(id => authorised.has(id))
        // Node's fingerprint map disappears on restart; cpp-verify's healthy
        // broker session does not. Reconnecting would replace it and clear its
        // observations. Adopt only an exact roster with fresh broker evidence.
        const freshCoverage = () => !status.error && !status.hostErrors?.[host] && ids.every(id => {
          const rows = status.accounts.filter(row => String(row.accountId) === id && row.host === host)
          if (rows.length !== 1 || status.accountErrors?.[id]) return false
          const row = rows[0], at = Number(row.checkedAtMs), current = now()
          return row.ok === true && !row.error && row.source === 'broker_reconcile'
            && Number.isFinite(current) && at > 0 && at <= current && current - at <= MAX_AGE_MS
            && ['openCount', 'missingSl', 'missingTp'].every(k => Number.isInteger(row[k]) && row[k] >= 0)
            && row.missingSl <= row.openCount && row.missingTp <= row.openCount
        })
        if (session?.open === true && exactRoster && (fingerprints.get(host) === signature
          || (!fingerprints.has(host) && freshCoverage()))) {
          fingerprints.set(host, signature)
          return
        }
        const result = await request('/connect', { purpose: 'protection', host,
          clientId: creds.clientId, clientSecret: creds.clientSecret, accessToken: creds.accessToken, accountIds: ids })
        const accepted = new Set((result.accounts || []).filter(a => a.authorized).map(a => String(a.accountId)))
        if (!ids.every(id => accepted.has(id))) throw new Error(`Independent verifier could not authorise every account on ${host}`)
        fingerprints.set(host, signature)
      }))
      connections.forEach((result, i) => {
        if (result.status === 'rejected') {
          const [host, group] = groupList[i]
          hostErrors[host] = result.reason.message
          for (const id of group.ids) accountErrors[id] = result.reason.message
        }
      })
      status = await request('/protection-status')
      if (status?.source !== 'cpp-verify' || !Array.isArray(status.accounts)) throw new Error('Invalid independent protection reply')
      const rows = status.accounts.filter(row => groups.get(row.host)?.ids.includes(String(row.accountId)))
      setState(db, STATE_KEY, JSON.stringify({ ...status, accounts: rows, hostErrors, accountErrors, readAt: new Date().toISOString(), error: null }))
      for (const row of rows) if (!accountErrors[String(row.accountId)] && !hostErrors[row.host])
        emitBrokerRead({ kind: 'protection', accountId: String(row.accountId), host: row.host, receivedAt: row.checkedAtMs, payload: row })
      // Optional read-only watchdog status. Its failure must not invalidate
      // the independent broker protection reading just completed above.
      try {
        const watchdog = await request('/watchdog-status')
        if (watchdog?.schemaVersion !== 1) throw new Error('Invalid watchdog status')
        setState(db, 'independent_watchdog_json', JSON.stringify({ status: watchdog, readAt: new Date().toISOString(), error: null }))
        const detail = watchdogDeliveryDetail(watchdog)
        try { beat(db, 'verify_watchdog', detail ? { ok: true, detail } : { ok: false, error: 'watchdog delivery gate unreported (verifier before CV-2, or busy)' }) } catch { /* a beat must not fail the relay */ }
      } catch {
        setState(db, 'independent_watchdog_json', JSON.stringify({ status: null, readAt: new Date().toISOString(), error: 'Independent watchdog status unavailable' }))
        try { beat(db, 'verify_watchdog', { ok: false, error: 'Independent watchdog status unavailable' }) } catch { /* as above */ }
      }
    } catch (error) {
      let previous = {}
      try { previous = JSON.parse(getState(db, STATE_KEY) || '{}') } catch { /* preserve unknown */ }
      setState(db, STATE_KEY, JSON.stringify({ ...previous, readAt: new Date().toISOString(), error: error.message }))
    } finally {
      running = false
      try { report() } catch { /* diagnostics must not interrupt protection polling */ }
    }
  }
}

export function startIndependentProtection(db) {
  const poll = makeIndependentProtectionPoll(db)
  if (!poll) {
    const missing = ['VERIFY_URL', 'EXEC_SECRET'].filter(k => !String(process.env[k] || '').trim())
    const error = `Independent checker not configured: ${missing.join(', ')} missing`
    setState(db, STATE_KEY, JSON.stringify({ accounts: [], error, readAt: new Date().toISOString() }))
    console.log(`[independent-protection] ${error}`)
    return () => {}
  }
  void poll()
  const timer = setInterval(() => { void poll() }, 30_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
