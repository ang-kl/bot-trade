import { getState, setState } from '../db.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { emitBrokerRead } from '../lib/broker-read-observer.js'
import { beat } from './heartbeat.js'
import { getStopPolicy, triggerValue, brokerTrigger, brokerTrailing } from '../lib/stop-policy.js'
import { confirmedAt as stopPolicyConfirmedAt } from './stop-policy-controller.js'

const STATE_KEY = 'independent_protection_json'
const MAX_AGE_MS = 180_000

/**
 * THE VERIFIER POLICES ACCOUNT IDENTITY (02-10-2026, № 10,448; owner: "cpp-verify
 * has to do its job"). cpp-verify's protection reading lists every open
 * position per account, independently of Node's own rows. A Node row that is
 * OPEN on account A, absent from A's independent list and present in account
 * B's list is a misplaced row — the 30-09 07:45:55Z shape, when …0058's
 * reconcile adopted …9908's four positions and cpp-verify read …0058: 5,
 * …9908: 4 the same minute. Pure: reads the status it is handed.
 * A row absent from EVERY list is not named here (a just-closed position, or
 * a verifier that has not read that account); only a position another
 * account's reading holds is evidence.
 */
export function misplacedRows(db, status) {
  const held = new Map() // positionId → accountId per the verifier
  const listed = new Set()
  for (const row of status?.accounts || []) {
    if (!Array.isArray(row?.positions) || row.ok !== true) continue
    const acct = String(row.accountId)
    listed.add(acct)
    for (const p of row.positions) if (p?.positionId != null) held.set(String(p.positionId).replace(/\.0+$/, ''), acct)
  }
  if (listed.size === 0) return []
  let rows = []
  try {
    rows = db.prepare(`SELECT id, account_id, symbol, ctrader_position_id FROM trades WHERE status = 'open' AND ctrader_position_id IS NOT NULL AND account_id IS NOT NULL`).all()
  } catch { return [] }
  const out = []
  for (const t of rows) {
    const acct = String(t.account_id)
    if (!listed.has(acct)) continue
    const pid = String(t.ctrader_position_id).replace(/\.0+$/, '')
    const owner = held.get(pid)
    if (owner != null && owner !== acct) out.push({ accountId: acct, tradeId: t.id, symbol: t.symbol, positionId: pid, heldBy: owner })
  }
  return out
}

/**
 * The stop policy as the VERIFIER reads it (02-10-2026): per account, how many
 * stops carry the trigger method the policy asks for, how many differ, and how
 * many the broker does not report. DRIFT is narrow on purpose: a position this
 * controller got a confirmed answer for more than `graceMs` ago whose broker
 * trigger now reads a DIFFERENT method. A position not yet stamped, or one whose
 * trigger the broker does not report, is "unknown" — counted, never alarmed (a
 * guard that fires on every unstamped position at rollout, or on a field the
 * broker may not return, would be silenced by its own noise). The trailing flag
 * is reported but never judged: Spotware's read-back for it has been unreliable.
 * Pure: it reads the status and two lookups it is handed.
 */
export function policyView(status, { desiredTrigger, enabled = true, confirmedAt = () => null, nowMs = Date.now(), graceMs = 10 * 60 * 1000 } = {}) {
  const out = { enabled, desiredTrigger, accounts: {}, totals: { stops: 0, compliant: 0, differs: 0, unknown: 0, trailing: 0 }, drift: [] }
  if (!enabled) return out
  for (const row of status?.accounts || []) {
    if (!Array.isArray(row?.positions) || row.ok !== true) continue
    const acct = String(row.accountId)
    const a = out.accounts[acct] = { stops: 0, compliant: 0, differs: 0, unknown: 0, trailing: 0 }
    for (const p of row.positions) {
      if (!(Number(p?.stopLoss) > 0)) continue
      a.stops++
      if (brokerTrailing(p) === true) a.trailing++
      const t = brokerTrigger(p)
      if (t == null) { a.unknown++; continue }
      if (t === Number(desiredTrigger)) { a.compliant++; continue }
      a.differs++
      const at = confirmedAt(acct, String(p.positionId).replace(/\.0+$/, ''))
      if (at != null && nowMs - at > graceMs) out.drift.push({ accountId: acct, positionId: String(p.positionId), trigger: t, desired: desiredTrigger })
    }
    for (const k of Object.keys(out.totals)) out.totals[k] += a[k]
  }
  return out
}

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
  const misplaced = (state?.misplaced || []).filter(m => String(m.accountId) === String(accountId))
  const policyDrift = (state?.policy?.drift || []).filter(d => String(d.accountId) === String(accountId))
  const ok = !readError && row?.ok === true && valid && !stale && misplaced.length === 0 && policyDrift.length === 0
  return { ...row, ok, stale, ageMs, misplaced, policy: state?.policy?.accounts?.[String(accountId)] ?? null, policyDrift, checkedAt: checkedAt > 0 ? new Date(checkedAt).toISOString() : null,
    error: readError || (!row ? 'No independent broker reading' : !valid ? 'Invalid independent reading' : misplaced.length ? `${misplaced.length} row(s) held by another account per the verifier` : policyDrift.length ? `${policyDrift.length} stop(s) read back with a trigger method other than the policy's` : null),
    summary: !ok ? `UNVERIFIED: ${readError || (stale ? 'reading absent or stale' : misplaced.length ? `${misplaced.length} MISPLACED row(s): ${misplaced.map(m => `${m.symbol} ${m.positionId} held by …${String(m.heldBy).slice(-4)}`).join(', ')}` : policyDrift.length ? `${policyDrift.length} STOP POLICY DRIFT: ${policyDrift.map(d => `position ${d.positionId} trigger ${d.trigger}`).join(', ')}` : 'check failed')}`
      : `${row.openCount} open; ${row.missingSl} missing SL; ${row.missingTp} missing TP1`,
  }
}

/**
 * cpp-verify's `delivery` block as the verify_watchdog beat carries it. Since
 * 03-10-2026 (owner: "remove all three") the verifier has NO delivery
 * channel: the Telegram transport, its mute and soak and its outbox were
 * removed, having never delivered a message. The block now names the removed
 * channel — `{channel: 'none', removedOn, note}` — so a reader can tell this
 * build from a verifier before CV-2, which reported no `delivery` block at
 * all (and from the CV-2 builds, whose block carried `muted`). A status with
 * no block (an older verifier, or a busy reply) returns null, reported as
 * such, never as a channel of any kind.
 */
export function watchdogDeliveryDetail(status) {
  const d = status?.delivery
  if (!d || typeof d !== 'object' || d.channel !== 'none') return null
  const out = { channel: 'none', removedOn: typeof d.removedOn === 'string' ? d.removedOn : null, note: typeof d.note === 'string' ? d.note : null,
    stateBytes: status.stateBytes ?? null, enabled: status.enabled ?? null, durable: status.durable ?? null, error: status.error || null }
  // The record's occupancy, when the verifier reports it (a build before the
  // slim /watchdog-status does not): total kept, active, and the bound.
  if (Number.isFinite(status.incidentsTotal) && Number.isFinite(status.incidentsCap))
    out.incidents = { total: status.incidentsTotal, active: status.incidentsActive ?? null, cap: status.incidentsCap, dropped: status.dropped ?? 0 }
  return out
}

// At this share of the verifier's incident bound held by ACTIVE incidents the
// beat goes red, well before the bound refuses a new incident. (First version
// judged the TOTAL and read red on the live record: 1,682 kept, 9 active.)
export const INCIDENT_RECORD_WARN_SHARE = 0.8

/**
 * The verify_watchdog beat for one /watchdog-status reply. ok when the
 * record is reported (this build's `delivery.channel === 'none'`) AND
 * supervision is enabled with no error: a record on a verifier whose
 * supervision is failing (lock held elsewhere, state unreadable) is not a
 * working record. Supervision switched OFF (WATCHDOG_ENABLED unset on
 * cpp-verify: enabled false, no error) is a switch, not a fault (CV-2 fix
 * round nit 7): the relay read succeeded, so the beat is ok and the
 * registry's dormantWhen labels it dormant, with the reason, instead of error.
 */
export function verifyWatchdogBeat(status) {
  if (status?.enabled === false && !status.error) {
    return { ok: true, detail: { ...(watchdogDeliveryDetail(status) || { enabled: false, durable: status.durable ?? null, error: null }), supervision: 'off' } }
  }
  const detail = watchdogDeliveryDetail(status)
  if (!detail) return { ok: false, error: 'watchdog incident record unreported (a cpp-verify build before the delivery channel was removed on 03-10-2026, or busy)' }
  if (status.enabled !== true) return { ok: false, error: 'watchdog supervision disabled on cpp-verify', detail }
  if (status.error) return { ok: false, error: `watchdog error: ${String(status.error).slice(0, 200)}`, detail }
  const inc = detail.incidents
  if (inc && inc.dropped > 0) return { ok: false, error: `watchdog incident record is full: ${inc.dropped} new incident(s) were not recorded (${inc.total} of ${inc.cap} kept)`, detail }
  // ACTIVE incidents, not the total: at the bound resolved history is evicted
  // for a new incident, so a record full of history is healthy and a record
  // full of ACTIVE incidents is the one that would refuse a new one.
  if (inc && inc.cap > 0 && Number.isFinite(inc.active) && inc.active >= inc.cap * INCIDENT_RECORD_WARN_SHARE) return { ok: false, error: `watchdog incident record has ${inc.active} active incidents of ${inc.cap} (${Math.round(100 * inc.active / inc.cap)}%): at the bound a new incident would be refused (${inc.total} kept in all)`, detail }
  return { ok: true, detail }
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
      // № 10,448: Node's open rows against the verifier's independent lists.
      const misplaced = misplacedRows(db, { accounts: rows })
      if (misplaced.length) log(`[independent-protection] MISPLACED ROWS: ${misplaced.map(m => `…${m.accountId.slice(-4)} trade ${m.tradeId} ${m.symbol} position ${m.positionId} is held by …${m.heldBy.slice(-4)}`).join('; ')}`)
      const sp = getStopPolicy()
      const policy = policyView({ accounts: rows }, { desiredTrigger: triggerValue(sp), enabled: sp.enabled, confirmedAt: stopPolicyConfirmedAt, nowMs: now() })
      if (policy.drift.length) log(`[independent-protection] STOP POLICY DRIFT: ${policy.drift.map(d => `…${d.accountId.slice(-4)} position ${d.positionId} trigger ${d.trigger}, policy ${d.desired}`).join('; ')}`)
      setState(db, STATE_KEY, JSON.stringify({ ...status, accounts: rows, hostErrors, accountErrors, misplaced, policy, readAt: new Date().toISOString(), error: null }))
      for (const row of rows) if (!accountErrors[String(row.accountId)] && !hostErrors[row.host])
        emitBrokerRead({ kind: 'protection', accountId: String(row.accountId), host: row.host, receivedAt: row.checkedAtMs, payload: row })
      // Optional read-only watchdog status. Its failure must not invalidate
      // the independent broker protection reading just completed above.
      try {
        const watchdog = await request('/watchdog-status')
        if (watchdog?.schemaVersion !== 1) throw new Error('Invalid watchdog status')
        setState(db, 'independent_watchdog_json', JSON.stringify({ status: watchdog, readAt: new Date().toISOString(), error: null }))
        try { beat(db, 'verify_watchdog', verifyWatchdogBeat(watchdog)) } catch { /* a beat must not fail the relay */ }
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
