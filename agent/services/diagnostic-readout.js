// Codex · №12,410 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
// Operator-authorised private-log readout. Closed fields, finite populations,
// no arbitrary SQL/state-key/credential accessor and no broker request.
import { performanceTargets } from './performance-targets.js'
// Codex · №12,418 · 2026-10-09; codex-footprint: reuse-stop-policy-observation.
import { brokerPolicyObservation } from '../lib/stop-policy.js'
const CAP = 64
const token = x => typeof x === 'string' && (/^[a-zA-Z0-9_.:-]{1,100}$/.test(x)
  || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(x)) ? x : null
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null
const REASONS = new Set(['enrolment_budget', 'own_credentials_unavailable', 'symbol_account_unverified',
  'symbol_metadata_unverified', 'broker_precision_required', 'ownership_changed', 'broker_position_unverified',
  'recorded_risk_required', 'broker_volume_invalid', 'half_and_runner_not_representable', 'opening_receipts_required',
  'existing_tp_caps_before_runner', 'broker_protection_unverified'])
function errorCode(x) {
  if (x == null || x === '') return x ?? null
  const text = String(x)
  for (const code of ['INCORRECT_BOUNDARIES', 'CH_ACCESS_TOKEN_INVALID', 'NOT_CONNECTED', 'SQLITE_BUSY', 'SQLITE_IOERR']) {
    if (text.includes(code)) return code
  }
  if (/timeout|timed out|deadline/i.test(text)) return 'timeout_or_deadline'
  return 'unclassified_error_redacted'
}
function project(row, fields) {
  return Object.fromEntries(fields.map(k => [k, typeof row?.[k] === 'number' ? number(row[k])
    : typeof row?.[k] === 'boolean' ? row[k] : token(row?.[k])]))
}
function stored(db, key) {
  const row = db.prepare('SELECT value FROM agent_state WHERE key=?').get(key)
  if (!row) return { available: false, reason: 'missing' }
  if (typeof row.value !== 'string' || Buffer.byteLength(row.value) > 131072) return { available: false, reason: 'invalid_or_oversized' }
  try { return { available: true, value: JSON.parse(row.value) } } catch { return { available: false, reason: 'invalid_json' } }
}
export function readHybridVerdicts(db) {
  const pass = stored(db, 'momentum_partial_pass_json'), controller = stored(db, 'hybrid_tick_controller_json')
  const p = pass.value, c = controller.value
  const list = (value, fields, reason = false) => ({ total: Array.isArray(value) ? value.length : null,
    truncated: Array.isArray(value) && value.length > CAP,
    rows: Array.isArray(value) ? value.slice(0, CAP).map(r => ({ ...project(r, fields),
      ...(reason ? { reason: REASONS.has(r.reason) ? r.reason : errorCode(r.reason) } : {}) })) : null })
  return {
    momentum_partial_pass_json: !pass.available ? pass : {
      available: true, at: token(p?.at), ok: p?.ok === true, activePlans: number(p?.activePlans),
      cappedHybrid: p?.cappedHybrid == null ? null : { examined: number(p.cappedHybrid.examined),
        enrolled: list(p.cappedHybrid.enrolled, ['accountId', 'tradeId', 'positionId', 'trigger', 'closeVolume', 'runnerVolume', 'brokerTarget']),
        deferred: list(p.cappedHybrid.deferred, ['accountId', 'tradeId'], true),
        errors: list(p.cappedHybrid.errors, ['accountId', 'tradeId'], true) },
    },
    hybrid_tick_controller_json: !controller.available ? controller : {
      available: true, at: number(c?.at), startedAt: number(c?.startedAt),
      hosts: Object.entries(c?.hosts || {}).slice(0, 4).map(([host, h]) => ({ host: token(host),
        ...project(h, ['configuredAt', 'processed', 'errors', 'plans', 'lastReadAt']), error: errorCode(h.error) })),
      truncatedHosts: Object.keys(c?.hosts || {}).length > 4,
    },
  }
}

// These projections expose recorded identity/status only. No value here is a
// fresh broker read or a reconstructed outcome. Missing columns stay explicit.
const READS = [
  ['accounts', 'account_id,mode,enabled', '1', 'account_id'],
  ['trades', 'id,account_id,ctrader_position_id,symbol,side,strategy,label_strategy,origin,status,intent_id,risk_event_id,entry_price,opened_at', "status='open'", 'id'],
  ['monitored_positions', 'id,trade_id,account_id,symbol,side,strategy,source,status,paused,scaled_out,bank_partial_at,initial_risk,current_sl,current_tp,last_check_at', "status='active'", 'id'],
  ['momentum_partial_plans', 'account_id,trade_id,position_id,state,attempted_at,resolved_at,scale_out_event_id', '1', 'rowid DESC'],
  ['hybrid_tick_receipts', 'host,event_id,account_id,trade_id,plan_key,received_at,wire_received_at,completed_at', '1', 'rowid DESC'],
  ['entry_intents', 'id,account_id,producer_id,symbol,symbol_id,side,state,broker_position_id,broker_order_id,risk_event_id,created_at,updated_at', '1', 'rowid DESC'],
  ['position_events', 'id,account_id,position_id,trade_id,symbol,kind,from_value,to_value,r_at,price_at,source,at', "kind IN ('trail_tightened','scale_out','sl_moved','close')", 'id DESC'],
]
export function readDiagnosticPopulation(db) {
  const result = {}
  for (const [table, columns, where, order] of READS) {
    try {
      const schema = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name))
      if (!schema.size) { result[table] = { available: false, reason: 'missing_table' }; continue }
      if (where !== '1' && db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM ${table} LIMIT 5001)`).get().n > 5000) {
        result[table] = { available: false, reason: 'population_cap' }; continue
      }
      const requested = columns.split(','), available = requested.filter(k => schema.has(k))
      const rows = db.prepare(`SELECT ${available.join(',')} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`).all(CAP + 1)
      result[table] = { available: true, order, truncated: rows.length > CAP, missingColumns: requested.filter(k => !schema.has(k)),
        rows: rows.slice(0, CAP).map(r => project(r, available)) }
    } catch (e) { result[table] = { available: false, reason: errorCode(e?.code || e?.message) } }
  }
  return result
}

export function readTradingAssessment(db, now = Date.now()) {
  const independent = stored(db, 'independent_protection_json'), state = independent.value
  const protection = !independent.available ? independent : { available: true, readAt: token(state?.readAt),
    error: errorCode(state?.error), truncated: (state?.accounts?.length || 0) > CAP,
    accounts: (Array.isArray(state?.accounts) ? state.accounts : []).slice(0, CAP).map(a => ({
      ...project(a, ['accountId', 'host', 'checkedAtMs', 'ok', 'openCount', 'missingSl', 'missingTp']),
      error: errorCode(state?.accountErrors?.[a.accountId] || state?.hostErrors?.[a.host] || a.error),
      truncatedPositions: (a.positions?.length || 0) > CAP,
      positions: (Array.isArray(a.positions) ? a.positions : []).slice(0, CAP).map(p => ({ ...project(p,
        ['positionId', 'symbolId', 'tradeSide', 'volume', 'price', 'entryPrice', 'stopLoss', 'takeProfit']),
      ...brokerPolicyObservation(p) })) })) }
  let targets
  try {
    // Refuse a large population rather than launch an unbounded report in a
    // diagnostic callback. One existing pure reader, once after the capture.
    for (const table of ['accounts', 'trades', 'position_lifecycle_evidence', 'broker_deals']) {
      const n = db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM ${table} LIMIT 5001)`).get().n
      if (n > (table === 'accounts' ? CAP : 5000)) throw Error('population_cap')
    }
    const ids = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all().map(r => r.account_id)
    targets = performanceTargets(db, { accountIds: ids, now })
    // Reader errors can contain SQL details; disclose failure without payload.
    if (targets.unavailable) targets = { available: false, reason: 'target_reader_unavailable' }
  } catch (e) { targets = { available: false, reason: e.message === 'population_cap' ? 'population_cap' : 'schema_or_read_failure' } }
  return { protection, targets }
}
