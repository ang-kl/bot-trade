// ---------------------------------------------------------------------------
// agent/lib/entry-contracts.js — the tick-momentum programme's contracts, as
// code (phase P0 of docs/tick-momentum/plan.md, 11-09-2026).
//
// Four records the plan names and every later phase must agree on:
//
//   QuoteEvent      — one normalized quote change from the feed (plan §4)
//   SignalIntent    — an immutable proposal a strategy emits (plan §5, §9)
//   ExecutionPermit — the one-use grant the risk authority issues (plan §9)
//   EngineStatus    — the per-account engine record the UI reads (plan §2)
//
// They are VALIDATORS, not classes: `validateQuoteEvent(obj)` returns
// `{ ok, errors }` with every violation named by field, so a producer that
// emits a malformed record is refused with a reason, never coerced. No
// dependency — the repo has no schema library and this must be importable by
// the recorder, the replayer and the routes alike.
//
// Frozen enums come from the plan's own table (§2). A value outside them is
// a contract violation, not a new mode: adding one is a plan change.
//
// Nothing here trades. The tick engine is OFF by default per account and this
// file has no effect on the time-based system; it is the vocabulary the next
// phases are written against, checked by entry-contracts.test.js.
// ---------------------------------------------------------------------------

export const ENVIRONMENTS = Object.freeze(['demo', 'live'])
export const ENTRY_MODES = Object.freeze(['TIME_BASED', 'TICK_MOMENTUM', 'STOPPED'])
export const TRANSITION_STATES = Object.freeze(['STABLE', 'QUIESCING', 'RECONCILING', 'WARMING', 'BLOCKED'])
export const OBSERVATION_MODES = Object.freeze(['OFF', 'RECORD', 'SHADOW'])
// PR-B (owner principle 1, 11-09-2026): ONE ladder for every account.
// TRADED_PASSED is judged on the account's own closed tick trades in R
// (tick-validation.js); the environment-tiered stages it replaced (a demo
// stage, then a typed live approval) are read back as TRADED_PASSED by
// engineStatusFor so stored records stay readable.
export const VALIDATION_STAGES = Object.freeze(['UNVALIDATED', 'REPLAY_PASSED', 'SHADOW_PASSED', 'TRADED_PASSED'])
/** Stages that admit an effective TICK_MOMENTUM — the same bar on every account. */
export const TICK_ENTRY_STAGES = Object.freeze(['SHADOW_PASSED', 'TRADED_PASSED'])
export const SIGNAL_BASES = Object.freeze(['bar', 'tick'])
export const SIDES = Object.freeze(['BUY', 'SELL'])
export const ENTRY_TYPES = Object.freeze(['MARKET', 'LIMIT', 'STOP'])
// Plan §9: proposed → reserved → queued/dispatching → sent → accepted →
// partially filled / filled / rejected / cancelled, with UNKNOWN for an
// ambiguous send. RELEASED is a reservation given back before any send;
// CONSUMED is a permit redeemed exactly once.
export const PERMIT_STATES = Object.freeze(['RESERVED', 'DISPATCHING', 'SENT', 'ACCEPTED', 'PARTIAL', 'FILLED', 'REJECTED', 'CANCELLED', 'UNKNOWN', 'RELEASED', 'CONSUMED'])
// Plan §12: why a readiness check fails, so the UI can say which kind of
// "no" it is looking at.
export const BLOCK_CLASSES = Object.freeze(['operator_policy', 'broker_constraint', 'missing_evidence', 'infrastructure', 'integration_defect'])

const HEX64 = /^[0-9a-f]{64}$/
const ACCOUNT_ID = /^[0-9]+$/

// --- a tiny spec language -----------------------------------------------
// { type, required, nullable, enum, min, max, integer, pattern, items, shape }
function checkField(errors, path, spec, v) {
  if (v === undefined) {
    if (spec.required) errors.push(`${path}: required`)
    return
  }
  if (v === null) {
    if (!spec.nullable) errors.push(`${path}: null not allowed`)
    return
  }
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string' || (!spec.allowEmpty && v.length === 0)) { errors.push(`${path}: non-empty string expected`); return }
      if (spec.pattern && !spec.pattern.test(v)) errors.push(`${path}: does not match ${spec.pattern}`)
      if (spec.enum && !spec.enum.includes(v)) errors.push(`${path}: '${v}' not in [${spec.enum.join(', ')}]`)
      return
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${path}: finite number expected`); return }
      if (spec.integer && !Number.isInteger(v)) errors.push(`${path}: integer expected`)
      if (spec.min !== undefined && v < spec.min) errors.push(`${path}: below ${spec.min}`)
      if (spec.max !== undefined && v > spec.max) errors.push(`${path}: above ${spec.max}`)
      return
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${path}: boolean expected`)
      return
    case 'array':
      if (!Array.isArray(v)) { errors.push(`${path}: array expected`); return }
      if (spec.items) v.forEach((it, i) => checkField(errors, `${path}[${i}]`, spec.items, it))
      return
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${path}: object expected`); return }
      if (spec.shape) checkShape(errors, path, spec.shape, v)
      return
    default:
      errors.push(`${path}: unknown spec type ${spec.type}`)
  }
}

function checkShape(errors, prefix, shape, obj) {
  for (const [key, spec] of Object.entries(shape)) {
    checkField(errors, prefix ? `${prefix}.${key}` : key, spec, obj[key])
  }
  // Unknown keys are refused: a producer cannot smuggle a field the contract
  // does not name (the plan's "no fake M1 / unrecognized tick string" rule
  // applied to every record).
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) errors.push(`${prefix ? prefix + '.' : ''}${key}: not in contract`)
  }
}

function validate(shape, obj, extra = null) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['record: object expected'] }
  checkShape(errors, '', shape, obj)
  if (extra && errors.length === 0) extra(errors, obj)
  return { ok: errors.length === 0, errors }
}

// --- QuoteEvent (plan §4) --------------------------------------------------
// Integer wire units for prices (cTrader's own), a monotonic receipt clock,
// the broker timestamp when supplied, a subscription generation that a gap
// or reconnect bumps, and per-side freshness so a one-sided update is never
// read as a two-sided quote.
export const QUOTE_EVENT_SHAPE = Object.freeze({
  environment: { type: 'string', required: true, enum: ENVIRONMENTS },
  feedId: { type: 'string', required: true },               // broker/entitlement/feed identity
  symbolId: { type: 'number', required: true, integer: true, min: 1 },
  symbol: { type: 'string', required: true },
  generation: { type: 'number', required: true, integer: true, min: 0 },
  seq: { type: 'number', required: true, integer: true, min: 0 }, // local receive sequence within the generation
  brokerTsMs: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  recvMonoNs: { type: 'number', required: true, integer: true, min: 0 },
  bid: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  ask: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  changedMask: { type: 'number', required: true, integer: true, min: 0, max: 3 }, // 1 = bid, 2 = ask, 3 = both
  bidUpdatedSeq: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  askUpdatedSeq: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  quality: { type: 'object', required: true, shape: {
    snapshot: { type: 'boolean', required: true },  // first message after (re)subscribe — warms, never counts
    stale: { type: 'boolean', required: true },
    crossed: { type: 'boolean', required: true },
    missingSide: { type: 'boolean', required: true },
  } },
})

export function validateQuoteEvent(obj) {
  return validate(QUOTE_EVENT_SHAPE, obj, (errors, q) => {
    if (q.bid == null || q.ask == null) {
      if (!q.quality.missingSide) errors.push('quality.missingSide: must be true when a side is null')
    } else if (q.bid > q.ask && !q.quality.crossed) {
      errors.push('quality.crossed: must be true when bid > ask')
    }
    if (q.changedMask & 1 && q.bidUpdatedSeq !== q.seq) errors.push('bidUpdatedSeq: must equal seq when the bid changed')
    if (q.changedMask & 2 && q.askUpdatedSeq !== q.seq) errors.push('askUpdatedSeq: must equal seq when the ask changed')
    if (q.changedMask === 0 && !q.quality.snapshot) errors.push('changedMask: a non-snapshot event must change a side')
  })
}

// --- SignalIntent (plan §5, §9, investigation "OrderIntent") --------------
// Immutable once emitted. Carries the environment, account, symbol, side,
// exact bracket, setup generation, config epoch and expiry, so a permit can
// bind to it and a stale-epoch proposal is refused at the final boundary.
export const SIGNAL_INTENT_SHAPE = Object.freeze({
  intentId: { type: 'string', required: true },
  signalId: { type: 'string', required: true },              // shared by every account's proposal of one setup
  basis: { type: 'string', required: true, enum: SIGNAL_BASES },
  strategy: { type: 'string', required: true },
  strategyVersion: { type: 'string', required: true },
  profileHash: { type: 'string', required: true, pattern: HEX64 },
  environment: { type: 'string', required: true, enum: ENVIRONMENTS },
  accountId: { type: 'string', required: true, pattern: ACCOUNT_ID },
  symbolId: { type: 'number', required: true, integer: true, min: 1 },
  symbol: { type: 'string', required: true },
  side: { type: 'string', required: true, enum: SIDES },
  entry: { type: 'object', required: true, shape: {
    type: { type: 'string', required: true, enum: ENTRY_TYPES },
    price: { type: 'number', required: true, nullable: true, min: 0 }, // null for MARKET
  } },
  stopPrice: { type: 'number', required: true, min: 0 },
  targetPrice: { type: 'number', required: true, nullable: true, min: 0 },
  volumeUnits: { type: 'number', required: true, integer: true, min: 1 }, // broker units, never lots
  setupGeneration: { type: 'number', required: true, integer: true, min: 0 },
  feedGeneration: { type: 'number', required: true, integer: true, min: 0 },
  configEpoch: { type: 'number', required: true, integer: true, min: 0 },
  emittedAtMs: { type: 'number', required: true, integer: true, min: 0 },
  expiresAtMs: { type: 'number', required: true, integer: true, min: 0 },
  // Which candle/tick window the signal was computed on, in its own units —
  // NOT a timeframe label (plan §13: "Tick · N=256/M=64").
  window: { type: 'object', required: true, shape: {
    rangeEvents: { type: 'number', required: false, nullable: true, integer: true, min: 1 },
    momentumEvents: { type: 'number', required: false, nullable: true, integer: true, min: 1 },
    timeframe: { type: 'string', required: false, nullable: true },
  } },
})

export function validateSignalIntent(obj) {
  return validate(SIGNAL_INTENT_SHAPE, obj, (errors, s) => {
    if (s.expiresAtMs <= s.emittedAtMs) errors.push('expiresAtMs: must be after emittedAtMs')
    if (s.entry.type !== 'MARKET' && s.entry.price == null) errors.push('entry.price: required for a non-market entry')
    if (s.basis === 'tick') {
      if (s.window.timeframe != null) errors.push('window.timeframe: a tick signal carries no timeframe')
      if (s.window.rangeEvents == null || s.window.momentumEvents == null) errors.push('window: a tick signal names rangeEvents and momentumEvents')
    } else if (s.window.timeframe == null) {
      errors.push('window.timeframe: a bar signal names its timeframe')
    }
    if (s.targetPrice != null) {
      const long = s.side === 'BUY'
      if (long && !(s.targetPrice > s.stopPrice)) errors.push('targetPrice: a BUY target sits above its stop')
      if (!long && !(s.targetPrice < s.stopPrice)) errors.push('targetPrice: a SELL target sits below its stop')
    }
  })
}

// --- ExecutionPermit (plan §9) --------------------------------------------
// One-use. Bound to the intent, account, environment, symbol, side, exact
// volume/bracket, signal generation, mode epoch and an expiry. Redemption
// moves RESERVED → DISPATCHING exactly once in the durable ledger; an
// uncertain send stays UNKNOWN and is never replayed as a fresh send.
export const EXECUTION_PERMIT_SHAPE = Object.freeze({
  permitId: { type: 'string', required: true },
  intentId: { type: 'string', required: true },
  accountId: { type: 'string', required: true, pattern: ACCOUNT_ID },
  environment: { type: 'string', required: true, enum: ENVIRONMENTS },
  symbolId: { type: 'number', required: true, integer: true, min: 1 },
  side: { type: 'string', required: true, enum: SIDES },
  volumeUnits: { type: 'number', required: true, integer: true, min: 1 },
  stopPrice: { type: 'number', required: true, min: 0 },
  targetPrice: { type: 'number', required: true, nullable: true, min: 0 },
  setupGeneration: { type: 'number', required: true, integer: true, min: 0 },
  modeEpoch: { type: 'number', required: true, integer: true, min: 0 },
  issuedAtMs: { type: 'number', required: true, integer: true, min: 0 },
  expiresAtMs: { type: 'number', required: true, integer: true, min: 0 },
  state: { type: 'string', required: true, enum: PERMIT_STATES },
  gatewayInstance: { type: 'string', required: true, nullable: true },   // set at redemption
  brokerCorrelationId: { type: 'string', required: true, nullable: true }, // clientOrderId, set at redemption
  brokerOrderId: { type: 'string', required: true, nullable: true },     // set on acceptance
})

export function validateExecutionPermit(obj) {
  return validate(EXECUTION_PERMIT_SHAPE, obj, (errors, p) => {
    if (p.expiresAtMs <= p.issuedAtMs) errors.push('expiresAtMs: must be after issuedAtMs')
    const redeemed = !['RESERVED', 'RELEASED'].includes(p.state)
    if (redeemed && (p.gatewayInstance == null || p.brokerCorrelationId == null)) {
      errors.push('gatewayInstance/brokerCorrelationId: a redeemed permit names who redeemed it and its correlation id')
    }
    if (!redeemed && (p.gatewayInstance != null || p.brokerCorrelationId != null || p.brokerOrderId != null)) {
      errors.push('gatewayInstance/brokerCorrelationId/brokerOrderId: null until redemption')
    }
  })
}

// --- EngineStatus (plan §2) -----------------------------------------------
// The one authoritative per-account record. `effectiveEntryMode` is what the
// gateway ACKNOWLEDGED; `requestedEntryMode` is what was asked. They differ
// during a transition and the UI shows both.
export const READINESS_CHECK_SHAPE = Object.freeze({
  check: { type: 'string', required: true },
  ok: { type: 'boolean', required: true },
  source: { type: 'string', required: true },
  observed: { type: 'string', required: true, nullable: true, allowEmpty: true },
  at: { type: 'string', required: true, nullable: true },
  blockClass: { type: 'string', required: true, nullable: true, enum: BLOCK_CLASSES },
  remedy: { type: 'string', required: true, nullable: true, allowEmpty: true },
})

export const ENGINE_STATUS_SHAPE = Object.freeze({
  accountId: { type: 'string', required: true, pattern: ACCOUNT_ID },
  environment: { type: 'string', required: true, enum: ENVIRONMENTS },
  riskGroupId: { type: 'string', required: true },
  requestedEntryMode: { type: 'string', required: true, enum: ENTRY_MODES },
  effectiveEntryMode: { type: 'string', required: true, enum: ENTRY_MODES },
  transitionState: { type: 'string', required: true, enum: TRANSITION_STATES },
  tickObservation: { type: 'string', required: true, enum: OBSERVATION_MODES },
  validationStage: { type: 'string', required: true, enum: VALIDATION_STAGES },
  configRevision: { type: 'number', required: true, integer: true, min: 0 },
  modeEpoch: { type: 'number', required: true, integer: true, min: 0 },
  fenceAckEpoch: { type: 'number', required: true, nullable: true, integer: true, min: 0 },
  profileId: { type: 'string', required: true, nullable: true },
  profileHash: { type: 'string', required: true, nullable: true, pattern: HEX64 },
  implementationCommit: { type: 'string', required: true, nullable: true, pattern: /^[0-9a-f]{40}$/ },
  entryCounts: { type: 'object', required: true, shape: {
    unsent: { type: 'number', required: true, integer: true, min: 0 },
    inFlight: { type: 'number', required: true, integer: true, min: 0 },
    resting: { type: 'number', required: true, integer: true, min: 0 },
    unknown: { type: 'number', required: true, integer: true, min: 0 },
  } },
  readiness: { type: 'array', required: true, items: { type: 'object', shape: READINESS_CHECK_SHAPE } },
  blockedReasons: { type: 'array', required: true, items: { type: 'string' } },
  updatedAt: { type: 'string', required: true },
})

export function validateEngineStatus(obj) {
  return validate(ENGINE_STATUS_SHAPE, obj, (errors, e) => {
    if (e.transitionState === 'STABLE' && e.requestedEntryMode !== e.effectiveEntryMode) {
      errors.push('transitionState: STABLE requires requested and effective modes to agree')
    }
    if (e.effectiveEntryMode === 'TICK_MOMENTUM') {
      if (e.profileHash == null) errors.push('profileHash: required while TICK_MOMENTUM is effective')
      // PR-B: one evidence bar for every account — no environment clause.
      if (!TICK_ENTRY_STAGES.includes(e.validationStage)) {
        errors.push('validationStage: TICK_MOMENTUM needs at least SHADOW_PASSED — plan runbook "Stages"')
      }
    }
    if (e.entryCounts.unknown > 0 && e.transitionState === 'STABLE' && e.effectiveEntryMode !== 'STOPPED') {
      errors.push('entryCounts.unknown: an unresolved entry cannot coexist with a STABLE active engine')
    }
    for (const r of e.readiness) {
      if (!r.ok && r.blockClass == null) errors.push(`readiness[${r.check}].blockClass: a failed check says which kind of "no" it is`)
    }
    const failing = e.readiness.filter(r => !r.ok).map(r => r.check)
    for (const reason of e.blockedReasons) {
      if (!failing.includes(reason)) errors.push(`blockedReasons: '${reason}' is not a failing readiness check`)
    }
  })
}

/** A fresh, valid, fully-OFF status for a newly discovered account — what
 *  the registry seeds so a new account is never armed by omission. */
export function defaultEngineStatus({ accountId, environment, riskGroupId = null, now = new Date() }) {
  return {
    accountId: String(accountId), environment, riskGroupId: riskGroupId || `${environment}:${accountId}`,
    requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE',
    tickObservation: 'OFF', validationStage: 'UNVALIDATED',
    configRevision: 0, modeEpoch: 0, fenceAckEpoch: null,
    profileId: null, profileHash: null, implementationCommit: null,
    entryCounts: { unsent: 0, inFlight: 0, resting: 0, unknown: 0 },
    readiness: [], blockedReasons: [], updatedAt: now.toISOString(),
  }
}
