// Codex · №12,519 ·2026-10-09; codex-footprint:six-strategy-lifecycle.
// Prospective entry evidence only. Never repair prices, label attribution or
// the monitor's historical initial_risk from a later broker stop.
import { getState } from '../db.js'
import { credsForRegisteredAccount, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { EXEC_HOST_DEMO, EXEC_HOST_LIVE } from '../lib/exec-engine.js'

export const TICK_ENTRY_PROOF_VERSION = 1
const STRATEGY = 'tick_momentum_breakout'
const PRODUCER = 'tick_momentum'
// Match the native DecisionRing capacity in cpp-exec/src/main.cpp. A proof
// never searches the retained ninety-day history for a lost companion.
const FIRE_PROVENANCE_SEQ_WINDOW = 4096
const SIDES = new Map([[EXEC_HOST_DEMO, 'cpp_exec_demo'], [EXEC_HOST_LIVE, 'cpp_exec']])
const integer = n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const id = value => (typeof value === 'string' && /^[1-9]\d*$/.test(value))
  || integer(value) ? String(value) : null
const token = value => typeof value === 'string' && /^i[A-Za-z0-9]{1,100}$/.test(value)
const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const wire = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && integer(Number(value)) ? Number(value) : null

function detail(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 500) return null
  const out = Object.create(null)
  for (const part of raw.split(' ')) {
    const match = /^([A-Za-z_]\w*)=([^\s]+)$/.exec(part)
    if (!match || Object.hasOwn(out, match[1])) return null
    out[match[1]] = match[2]
  }
  return out
}

/** A foreign/malformed receipt cannot attribute even a legacy reason. */
export function tickFireMatchesIntent(receipt, intent) {
  const d = detail(receipt?.detail)
  return !!(intent && receipt && d && token(intent.id) && d.intent === intent.id
    && intent.producer_id === PRODUCER && intent.basis === 'tick' && intent.order_type === 'MARKET'
    && id(intent.account_id) && id(receipt.account_id) === id(intent.account_id)
    && id(intent.symbol_id) && id(receipt.symbol_id) === id(intent.symbol_id)
    && ['BUY', 'SELL'].includes(intent.side) && d.side === intent.side
    && receipt.component === 'tick' && receipt.kind === 'fire_result' && receipt.code === 'ok')
}

function facts(fire, result, intent) {
  if (!tickFireMatchesIntent(result, intent)) return null
  const f = detail(fire?.detail), r = detail(result.detail)
  if (!f || fire.component !== 'tick' || fire.kind !== 'fire' || fire.code !== intent.side
    || f.intent !== intent.id || !/^[a-f0-9]{16}$/.test(f.profile || '')
    || id(fire.account_id) !== id(intent.account_id) || id(fire.symbol_id) !== id(intent.symbol_id)
    || !['cpp_exec', 'cpp_exec_demo'].includes(result.side) || fire.side !== result.side
    || typeof result.boot_id !== 'string' || !result.boot_id || result.boot_id.length > 128
    || fire.boot_id !== result.boot_id
    || (intent.sidecar_boot_id != null && intent.sidecar_boot_id !== result.boot_id)
    || ![fire.seq, result.seq, fire.ts_ms, result.ts_ms].every(integer)
    || fire.seq >= result.seq || result.seq - fire.seq > FIRE_PROVENANCE_SEQ_WINDOW || fire.ts_ms > result.ts_ms
    || !wire(f.seq) || !wire(f.vol)) return null
  const entry = wire(r.entry), stop = wire(r.stop), target = wire(r.target), ref = wire(r.ref)
  const stopDistance = wire(f.stop), positionId = id(r.pos), entryOrderId = id(r.order)
  const direction = intent.side === 'BUY' ? 1 : -1
  if (![entry, stop, target, ref, stopDistance].every(integer) || wire(f.entry) !== entry
    || direction * (entry - stop) !== stopDistance || direction * (target - entry) <= 0
    || !positionId || !entryOrderId
    || (intent.broker_position_id != null && id(intent.broker_position_id) !== positionId)
    || (intent.broker_order_id != null && id(intent.broker_order_id) !== entryOrderId)) return null
  return { accountId: id(intent.account_id), symbolId: id(intent.symbol_id), symbol: intent.symbol,
    side: intent.side, intentId: intent.id, positionId, entryOrderId, profileHash: f.profile,
    requestedRelativeStopLoss: stopDistance, requestedRelativeTakeProfit: Math.abs(target - entry) }
}

function rawReceipt(row) {
  return Object.fromEntries(['side', 'boot_id', 'seq', 'ts_ms', 'component', 'kind', 'account_id', 'symbol_id', 'code', 'detail']
    .map(key => [key, row[key]]))
}

function ownsSymbol(db, accountId, symbol, symbolId) {
  const symbols = getAccountSymbolMap(db, accountId)?.map
  return !!symbols && id(symbols[symbol.toUpperCase()]) === symbolId
    && Object.values(symbols).filter(value => id(value) === symbolId).length === 1
}

function routeMatches(route, result, environment, host) {
  return object(route) && route.bootId === result.boot_id && route.host === host && id(route.feedAccountId)
    && (route.side === null ? result.side === 'cpp_exec'
      : route.side === environment && SIDES.get(host) === result.side)
}

/** Called only while inserting a NEW risk event, never to upgrade old events. */
export function buildTickEntryProof(db, intent, result) {
  if (!tickFireMatchesIntent(result, intent) || !integer(result.seq)) return null
  // The native fire_result has no profile field. Its own preceding fire is
  // the source; an unrelated signal or today's profile pin is not evidence.
  // Range the existing (side,boot_id,seq) index before inspecting detail.
  // Missing/older evidence stays unverified; multiple matches in this native
  // ring window are ambiguous and also refuse. No timestamp guess is used.
  const fireRows = db.prepare(`SELECT side,boot_id,seq,ts_ms,component,kind,account_id,symbol_id,code,detail
    FROM cpp_decisions WHERE side=? AND boot_id=? AND seq>=? AND seq<? AND component='tick' AND kind='fire'
      AND account_id=? AND symbol_id=? AND instr(' ' || detail || ' ', ?) > 0
    ORDER BY seq DESC LIMIT 2`).all(result.side, result.boot_id, Math.max(1, result.seq - FIRE_PROVENANCE_SEQ_WINDOW), result.seq,
    String(intent.account_id), intent.symbol_id, ' intent=' + intent.id + ' ')
  if (fireRows.length !== 1) return null
  const owned = facts(fireRows[0], result, intent)
  if (!owned || typeof owned.symbol !== 'string' || !owned.symbol) return null
  const account = credsForRegisteredAccount(db, owned.accountId)
  if (!account || account.host !== intent.environment + '.ctraderapi.com' || !SIDES.has(account.host)) return null
  if (!ownsSymbol(db, owned.accountId, owned.symbol, owned.symbolId)) return null
  let health
  try { health = JSON.parse(getState(db, result.side + '_health_json') || 'null') } catch { return null }
  if (!health || health.bootId !== result.boot_id || !Array.isArray(health.accounts)
    || !health.accounts.some(value => id(value) === owned.accountId)) return null
  // Keep the collector's retained side/boot and the feed's actual account.
  // A side name alone cannot bind a collapsed route's host, and a symbol
  // number alone cannot prove that two accounts use it for the same asset.
  const feedId = id(health.tick?.feedAccountId)
  const feed = feedId && credsForRegisteredAccount(db, feedId)
  if (!feed || feed.host !== account.host || !ownsSymbol(db, feedId, owned.symbol, owned.symbolId)) return null
  const route = { side: health.side, bootId: health.bootId, host: feed.host, feedAccountId: feedId }
  if (!routeMatches(route, result, intent.environment, account.host)) return null
  return { version: TICK_ENTRY_PROOF_VERSION, source: 'native_tick_entry_fire', strategy: STRATEGY,
    producerId: PRODUCER, basis: 'tick', host: account.host, environment: intent.environment, ...owned,
    route, ring: { fire: rawReceipt(fireRows[0]), result: rawReceipt(result) } }
}

/** Immutable owned initial distance, not the shadow fill price or a later SL.
 * Null also covers snapshot-first FILLED rows whose missing order identity
 * cannot be supplied by this exact receipt. No database state is changed. */
export function readTickEntryProof(db, trade, intent) {
  try {
    if (!object(trade) || !object(intent) || !integer(trade.id) || !token(intent.id)
      || trade.strategy !== STRATEGY || trade.source !== 'autopilot' || trade.status !== 'open'
      || trade.origin !== 'bot_market_dispatch' || trade.intent_id !== intent.id
      || intent.state !== 'FILLED' || !integer(trade.risk_event_id) || trade.risk_event_id !== intent.risk_event_id
      || (trade.label_strategy != null && trade.label_strategy !== STRATEGY)) return null
    const event = db.prepare('SELECT account_id,symbol,side,approved,proposal_json FROM risk_events WHERE id=?')
      .get(trade.risk_event_id)
    if (!event || event.approved !== 1) return null
    const proposal = JSON.parse(event.proposal_json), proof = proposal?.tickEntryProof
    if (!object(proof) || proof.version !== TICK_ENTRY_PROOF_VERSION || proof.source !== 'native_tick_entry_fire'
      || proof.strategy !== STRATEGY || proof.producerId !== PRODUCER || proof.basis !== 'tick'
      || !object(proof.ring)) return null
    const owned = facts(proof.ring.fire, proof.ring.result, intent)
    if (!owned || Object.entries(owned).some(([key, value]) => proof[key] !== value)
      || proof.environment !== intent.environment || !SIDES.has(proof.host)
      || !routeMatches(proof.route, proof.ring.result, proof.environment, proof.host)
      || proof.host !== intent.environment + '.ctraderapi.com') return null
    const account = credsForRegisteredAccount(db, owned.accountId)
    if (!account || account.host !== proof.host
      || id(trade.account_id) !== owned.accountId || id(event.account_id) !== owned.accountId
      || trade.symbol !== owned.symbol || event.symbol !== owned.symbol
      || trade.side !== owned.side || event.side !== owned.side
      || id(trade.ctrader_position_id) !== owned.positionId || id(intent.broker_position_id) !== owned.positionId
      || proposal.intent_id !== owned.intentId || proposal.producer_id !== PRODUCER || proposal.strategy !== STRATEGY
      || proposal.source !== 'tick_fire_ledger' || id(proposal.symbol_id) !== owned.symbolId
      || proposal.symbol !== owned.symbol || proposal.side !== owned.side) return null
    const label = 'tick:' + owned.profileHash + '|||||||' + owned.intentId
    if (trade.label_raw !== label) return null
    const monitors = db.prepare("SELECT label_raw FROM monitored_positions WHERE trade_id=? AND status='active'").all(trade.id)
    if (monitors.some(row => row.label_raw != null && row.label_raw !== label)) return null
    return { ...owned, host: proof.host, initialRisk: owned.requestedRelativeStopLoss / 100_000 }
  } catch { return null }
}
