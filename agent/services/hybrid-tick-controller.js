// Codex · №12,321 · 2026-10-09; codex-footprint: native-hybrid-profit.
// Native account-owned ticks wake this path independently of the scan loop.
// Node retains the EXISTING SQLite close claim; all broker execution still
// uses the account-owned gateway and the unchanged partial manager. No second
// closer, SL writer, entry producer or independent trading authority is added.
import { createHash } from 'node:crypto'
import { setState } from '../db.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { marketIdentity } from '../lib/market-identity.js'
import { EXEC_HOST_LIVE, EXEC_HOST_DEMO, closePosition } from '../lib/exec-engine.js'
import { hybridTickTransport } from '../lib/hybrid-tick-transport.js'
import { CAPPED_HYBRID_POLICY, planCappedHybrid } from './capped-hybrid-policy.js'
import { readPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { recordPartialScaleOuts } from './momentum-partial-runtime.js'
import { MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'

export const HYBRID_TICK_STATUS = 'hybrid_tick_controller_json'
const hosts = [EXEC_HOST_LIVE, EXEC_HOST_DEMO]
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const id = v => typeof v === 'string' && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))
const parse = value => { try { return JSON.parse(value) } catch { return null } }
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hybrid_tick_receipts (
    host TEXT NOT NULL, event_id TEXT NOT NULL, account_id TEXT, trade_id INTEGER,
    plan_key TEXT, raw_json TEXT NOT NULL, received_at INTEGER NOT NULL,
    outcome_json TEXT, wire_response_json TEXT, wire_received_at INTEGER, completed_at INTEGER,
    PRIMARY KEY(host,event_id))`)
}
export function hybridSpec(row, now = Date.now()) {
  if (!row || row.plan?.policy !== CAPPED_HYBRID_POLICY || !marketIdentity(row.identity)
    || !id(row.account_id) || !id(row.position_id) || !Number.isSafeInteger(row.trade_id) || row.trade_id <= 0
    || row.identity.accountId !== row.account_id || !Number.isSafeInteger(now) || now < 0) return null
  const calculated = planCappedHybrid(row.plan)
  if (!calculated.ok || JSON.stringify(calculated) !== JSON.stringify(row.plan)) return null
  const ref = { identity: row.identity, positionId: row.position_id, tradeId: row.trade_id, plan: row.plan }
  return { key: createHash('sha256').update(JSON.stringify(ref)).digest('hex'), host: row.identity.host,
    accountId: row.account_id, symbolId: row.identity.symbolId, positionId: row.position_id,
    // Reserve the existing 2s clock budget inside the native 90s ceiling:
    // a gateway up to 2s behind Node must not see a >90s configuration.
    tradeId: row.trade_id, side: row.plan.side, trigger: row.plan.trigger, expiresAtMs: now + 90_000 - MAX_CLOCK_SKEW_MS }
}
function owned(db, row) {
  const o = readPartialOwnership(db, row.account_id, row.trade_id, row.position_id, row.plan.digits, row.plan)
  return ownershipMatchesPlan(o, { accountId: row.account_id, tradeId: row.trade_id, positionId: row.position_id, plan: row.plan })
    && o.host === row.identity.host && o.symbolId === row.identity.symbolId
}
export function hybridGroups(db, host, { now = Date.now, credsFor = account => credsForRegisteredAccount(db, account) } = {}) {
  if (!hosts.includes(host) || !hasTable(db, 'momentum_partial_plans')) return []
  const groups = new Map()
  const rows = db.prepare("SELECT account_id,trade_id FROM momentum_partial_plans WHERE state='ARMED' ORDER BY account_id,trade_id").all()
  let count = 0
  for (const ref of rows) {
    const row = readPartialPlan(db, ref.account_id, ref.trade_id), spec = hybridSpec(row, now())
    if (!spec || spec.host !== host || !owned(db, row)) continue
    if (++count > 64) throw Error('hybrid configured-plan capacity exceeded')
    const creds = credsFor(spec.accountId)
    if (!creds?.ready || creds.host !== host || String(creds.accountId) !== spec.accountId) continue
    if (!groups.has(spec.accountId)) groups.set(spec.accountId, { creds, plans: [] })
    groups.get(spec.accountId).plans.push(spec)
  }
  return [...groups.values()]
}
function eventShape(e) {
  return e?.kind === 'trigger' && e.version === 1 && typeof e.eventId === 'string' && /^[a-f0-9]{32}:[1-9]\d*$/.test(e.eventId)
    && typeof e.key === 'string' && /^[a-f0-9]{64}$/.test(e.key) && hosts.includes(e.host)
    && [e.accountId, e.symbolId, e.positionId].every(id) && Number.isSafeInteger(e.tradeId) && e.tradeId > 0
    && ['BUY', 'SELL'].includes(e.side) && positive(e.trigger) && positive(e.bid) && positive(e.ask) && e.ask >= e.bid
    && ['receivedAtMs', 'observedAtMs', 'brokerAtMs', 'bidAtMs', 'askAtMs', 'bidBrokerAtMs', 'askBrokerAtMs', 'persistedAtMs'].every(k => Number.isSafeInteger(e[k]) && e[k] > 0)
    && e.observedAtMs === Math.min(e.bidAtMs, e.askAtMs) && e.brokerAtMs === Math.min(e.bidBrokerAtMs, e.askBrokerAtMs)
    && e.source === 'owned_native_spot_tick'
}
function nativeQuote(e, spec, now) {
  if (!eventShape(e) || ['host', 'key', 'accountId', 'symbolId', 'positionId', 'side', 'tradeId', 'trigger'].some(k => e[k] !== spec[k])) return null
  // Codex · №12,363 · 2026-10-09; codex-footprint: preserve clock domains.
  // Source age retains the ordinary manager's strict broker-clock rule.
  // Receive/persist stamps belong to the gateway, not this Node process:
  // compare their order and queue age within that clock, never re-stamp a
  // quote or erase the original foreign-clock evidence to make it fresh.
  if ([e.bidBrokerAtMs, e.askBrokerAtMs].some(at => at > now || now - at > 5000)
    || e.receivedAtMs < Math.max(e.bidAtMs, e.askAtMs)
    || e.persistedAtMs < e.receivedAtMs || e.persistedAtMs - e.observedAtMs > 5000) return null
  // Mirror the native input bounds: each actual source/receive pair was at
  // most 5s old, or 2s ahead, at ingestion. Large unexplained clock gaps
  // remain a refusal; gateway skew does not widen broker-source freshness.
  if ([[e.bidAtMs, e.bidBrokerAtMs], [e.askAtMs, e.askBrokerAtMs]]
    .some(([received, broker]) => received - broker > 5000 || broker - received > MAX_CLOCK_SKEW_MS)) return null
  if (spec.side === 'BUY' ? e.bid < spec.trigger : e.ask > spec.trigger) return null
  return { host: e.host, accountId: e.accountId, symbolId: e.symbolId, positionId: e.positionId,
    bid: e.bid, ask: e.ask, observedAtMs: e.brokerAtMs, receivedAtMs: e.receivedAtMs,
    bidBrokerAtMs: e.bidBrokerAtMs, askBrokerAtMs: e.askBrokerAtMs, source: 'owned_native_spot_tick' }
}

/** Store before any broker call. Redelivery and scan-loop races still have to
 * win the manager's one ARMED→SENDING SQLite claim. An incomplete handler is
 * recoverable from its durable raw event and the existing plan state. */
export async function processHybridTick(db, host, event, { now = Date.now,
  credsFor = account => credsForRegisteredAccount(db, account), transports = {}, log = () => {} } = {}) {
  if (!eventShape(event) || event.host !== host) throw Error('hybrid tick identity or evidence malformed')
  schema(db)
  const encoded = JSON.stringify(event)
  const get = () => db.prepare('SELECT * FROM hybrid_tick_receipts WHERE host=? AND event_id=?').get(host, event.eventId)
  const held = get()
  if (held && held.raw_json !== encoded) throw Error('hybrid tick identity reused with different evidence')
  if (held?.completed_at != null) return parse(held.outcome_json)
  const nodeReceivedAt = held?.received_at ?? now()
  if (!held) {
    if (db.prepare('SELECT COUNT(*) AS n FROM hybrid_tick_receipts').get().n >= 100000) throw Error('hybrid tick receipt capacity exceeded')
    db.prepare(`INSERT INTO hybrid_tick_receipts(host,event_id,account_id,trade_id,plan_key,raw_json,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(host, event.eventId, event.accountId, event.tradeId, event.key, encoded, nodeReceivedAt)
  }
  let out
  const row = hasTable(db, 'momentum_partial_plans') && readPartialPlan(db, event.accountId, event.tradeId)
  const spec = hybridSpec(row, now())
  const quote = spec && nativeQuote(event, spec, now())
  if (!spec || spec.host !== host || !quote) out = { state: 'REFUSED', reason: 'stale_or_unowned_tick' }
  else if (row.state !== 'ARMED') out = { state: row.state, reason: 'plan_already_claimed' }
  else if (!owned(db, row)) out = { state: 'REFUSED', reason: 'lifecycle_ownership_unverified' }
  else {
    const creds = credsFor(event.accountId)
    if (!creds?.ready || creds.host !== host || String(creds.accountId) !== event.accountId) out = { state: 'REFUSED', reason: 'own_credentials_unavailable' }
    else {
      const close = transports.close || closePosition
      const adapter = makeMomentumPartialBroker(db, { identity: row.identity, tradeId: row.trade_id }, { ...transports, now,
        close: async (c, order) => {
          const raw = await close(c, order), json = JSON.stringify(raw)
          if (typeof json !== 'string' || json.length > 1024 * 1024) throw Error('hybrid broker response cannot be retained')
          db.prepare('UPDATE hybrid_tick_receipts SET wire_response_json=?,wire_received_at=? WHERE host=? AND event_id=?')
            .run(json, now(), host, event.eventId)
          return raw
        } })
      // The quote is the persisted native account-owned snapshot, with each
      // side's actual source clock. It is revalidated after the position read;
      // local receipt never turns a market-close quote into a fresh price.
      adapter.quote = async supplied => { adapter.preflight(supplied); return nativeQuote(event, spec, now()) }
      out = await runPartialPlan(db, creds, row.trade_id, adapter)
      recordPartialScaleOuts(db)
    }
  }
  const finished = now()
  db.prepare('UPDATE hybrid_tick_receipts SET outcome_json=?,completed_at=? WHERE host=? AND event_id=? AND completed_at IS NULL')
    .run(JSON.stringify(out), finished, host, event.eventId)
  log(`[hybrid-tick] ${host} account=${event.accountId} trade=${event.tradeId} event=${event.eventId} state=${out.state} reason=${out.reason || ''} nodeReceiptToResultMs=${finished - nodeReceivedAt}`)
  // Codex · №12,326 · 2026-10-09; codex-footprint: retained outcome readback.
  // Read the committed records. Log no credentials or guessed broker facts;
  // a confirmed state is paired with its actual stored receipt and residual.
  if (out.state === 'CONFIRMED') {
    const stored = get(), plan = readPartialPlan(db, event.accountId, event.tradeId)
    const journal = db.prepare("SELECT id,detail_json FROM position_events WHERE trade_id=? AND account_id=? AND kind='scale_out' ORDER BY id DESC LIMIT 1")
      .get(event.tradeId, event.accountId)
    log(`[hybrid-tick-proof] ${JSON.stringify({ host, accountId: event.accountId, tradeId: event.tradeId,
      positionId: event.positionId, eventId: stored.event_id, triggerStored: !!stored.raw_json,
      wireStored: !!stored.wire_response_json, state: plan.state, receipt: plan.receipt,
      residual: plan.evidence, journalId: journal?.id ?? null, journal: parse(journal?.detail_json) })}`)
  }
  return out
}

export function startHybridTickController(db, { transport = hybridTickTransport(), now = Date.now,
  credsFor = account => credsForRegisteredAccount(db, account), log = console.log, transports = {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopped = false
  const timers = new Set(), status = { startedAt: now(), hosts: {} }
  const save = () => setState(db, HYBRID_TICK_STATUS, JSON.stringify({ ...status, at: now() }))
  const later = (host, ms) => {
    if (stopped) return
    const timer = setTimer(() => { timers.delete(timer); void pass(host) }, ms)
    timer?.unref?.(); timers.add(timer)
  }
  const pass = async host => {
    if (stopped) return
    const h = status.hosts[host] ||= { configuredAt: 0, processed: 0, errors: 0 }
    let failed = false
    try {
      if (now() - h.configuredAt >= 30_000) {
        const groups = hybridGroups(db, host, { now, credsFor })
        await transport.configure(host, groups)
        const signature = JSON.stringify(groups.flatMap(g => g.plans.map(p => [p.accountId, p.positionId, p.key])))
        if (signature !== h.signature) log(`[hybrid-tick-config] ${JSON.stringify({ host,
          plans: groups.flatMap(g => g.plans.map(({ accountId, positionId, tradeId, symbolId, side, trigger }) =>
            ({ accountId, positionId, tradeId, symbolId, side, trigger }))) })}`)
        h.signature = signature
        h.configuredAt = now(); h.plans = groups.reduce((n, g) => n + g.plans.length, 0)
      }
      const batch = await transport.events(host)
      if (batch?.ready !== true || !Array.isArray(batch.events) || batch.events.length > 64) throw Error('hybrid native journal unavailable')
      for (const event of batch.events) {
        if (stopped) break
        await processHybridTick(db, host, event, { now, credsFor, transports, log })
        if (stopped) break
        await transport.acknowledge(host, event.eventId)
        h.processed++; h.configuredAt = 0
      }
      h.error = null; h.lastReadAt = now(); save()
    } catch (error) {
      failed = true; h.errors++; h.error = String(error?.message || error).slice(0, 180)
      try { save() } catch { /* no execution if the earlier journal write failed */ }
      if (h.errors === 1 || h.errors % 30 === 0) log(`[hybrid-tick] ${host}: ${h.error}`)
    }
    later(host, failed ? 5000 : 25)
  }
  for (const host of hosts) void pass(host)
  return () => { stopped = true; for (const timer of timers) clearTimer(timer); timers.clear() }
}
