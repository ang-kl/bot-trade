// Codex · №12,944 · 2026-10-10; codex-footprint: bounded-account-evidence.
// Private stored evidence only. No broker refresh, policy action or history write.
import { accountMoney } from './account-money.js'
import { readAccountSnapshot } from './account-snapshot.js'
import { accountCurrencyConversion, conversionView } from './account-currency.js'
import { loadRiskConfig, getAccountBalance } from './risk.js'
import { readDailyRiskVerdict, dailyPacingReading } from './daily-stop-reading.js'
import { masterPhases, accountOverrides, effectivePhases } from './account-phases.js'
import { accountCapabilities } from './account-capabilities.js'
import { engineStatusFor, basesFor } from './entry-mode.js'
import { tradeGateMatrix } from './trade-gate-resolver.js'

export const ACCOUNT_EVIDENCE_LIMITS = Object.freeze({ accounts: 8, registryRows: 64,
  closedRiskRows: 512, stateBytes: 131072, checksBytes: 16000, snapshotPositions: 32,
  snapshotOrders: 32, catalogueStocks: 24, brokerOrderWindow: 128, pendingWindow: 256,
  orderCandidates: 8, intentsPerOrder: 4 })
const L = ACCOUNT_EVIDENCE_LIMITS
const id = v => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) ? v
  : Number.isSafeInteger(v) && v > 0 ? String(v) : null
const scalar = v => typeof v === 'number' ? Number.isFinite(v) ? v : null
  : typeof v === 'boolean' ? v : typeof v === 'string' && /^[\w.:+ -]{1,100}$/.test(v) ? v : null
const project = (v, fields) => Object.fromEntries(fields.map(k => [k, scalar(v?.[k])]))
const parse = v => { try { return JSON.parse(v || 'null') } catch { return null } }
const age = (at, nowMs) => { const t = typeof at === 'number' ? at : Date.parse(at || ''); return Number.isFinite(t) && t <= nowMs ? nowMs - t : null }
const CHECKS = ['account_id','account_source','balance','balance_native','balance_currency','balance_source',
  'balance_is_account_scoped','fx_conversion','fx_rate','fx_rate_symbol','fx_rate_age_min','leverage',
  'daily_pnl','daily_pnl_native','daily_pnl_currency','daily_fx_rate','daily_fx_rate_age_min',
  'daily_cap_usd','daily_cap_uncapped','daily_cap_binding','daily_cap_pct_usd','daily_cap_flat_usd',
  'daily_cap_floor_usd','daily_cap_floor_binding','daily_cap_tier_pct','daily_budget_left_usd',
  'daily_pnl_estimated_stopout_usd','daily_pnl_estimated_stopouts','daily_pnl_unpriceable_stopouts',
  'unresolved_pnl_trades','unresolvable_pnl_trades']
const CONFIG = ['dailyLossPct','dailyLossLimit','dailyLossFloorUsd','dailyLossTierAtUsd',
  'dailyLossTierSmallPct','dailyLossTierLargePct','perTradeRiskPct','perTradeRiskUsd','minRR']
const sideOf = v => v==='BUY'||v==='SELL' ? v : null
const pendingSide = v => v===1||v==='1' ? 'BUY' : v===-1||v==='-1' ? 'SELL' : null
function orderIdentity(record,order,{pending=false}={}) {
  if(id(record?.account_id)!==id(order.account_id))return 'account_conflict'
  if(id(pending?record?.order_id:record?.broker_order_id)!==id(order.order_id))return 'order_conflict'
  if(record?.symbol!==order.symbol)return 'symbol_conflict'
  const side=pending?pendingSide(record?.dir):sideOf(record?.side)
  if(!side||!sideOf(order.side))return 'side_unverified'
  return side===order.side?null:'side_conflict'
}
function nestedIdentity(record,{accountId,symbol=null,side=null,orderId=null}={}) {
  if(!record||typeof record!=='object'||Array.isArray(record))return 'identity_shape_unverified'
  for(const key of ['account_id','accountId'])if(record[key]!=null&&id(record[key])!==accountId)return 'nested_account_conflict'
  if(symbol!=null&&record.symbol!=null&&record.symbol!==symbol)return 'nested_symbol_conflict'
  if(side!=null&&record.side!=null&&sideOf(record.side)!==side)return 'nested_side_conflict'
  for(const key of ['order_id','orderId','broker_order_id'])if(orderId!=null&&record[key]!=null&&id(record[key])!==orderId)return 'nested_order_conflict'
  return null
}

// Canonical helpers retain their full populations. Their state reader gets a
// byte ceiling, and its prepared write statement cannot be executed here.
function boundedDb(db, refusals) {
  const states=new Map()
  let registry=null
  return { prepare(sql) {
    if (sql === 'SELECT value FROM agent_state WHERE key = ?') {
      const statement = db.prepare('SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END value, length(CAST(value AS BLOB)) bytes FROM agent_state WHERE key = ?')
      return { get(key) { if(!states.has(key))states.set(key,statement.get(L.stateBytes,key)); const row=states.get(key); if (row?.bytes > L.stateBytes) { refusals.add('state_value_exceeds_byte_bound'); throw Error('state_value_exceeds_byte_bound') } return row } }
    }
    if(sql==='SELECT * FROM accounts ORDER BY is_live DESC, account_id') return {all(){if(registry===null)registry=db.prepare(sql).all();return registry}}
    if (!/^\s*SELECT\b/i.test(sql)) return { run() { throw Error('read_only_evidence') } }
    return db.prepare(sql)
  } }
}
function readState(db, key) { return db.prepare('SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END value FROM agent_state WHERE key = ?').get(L.stateBytes, key)?.value ?? null }
function savedRisk(db, accountId, nowMs) {
  const row = db.prepare(`SELECT id,account_id,approved,created_at,
    CASE WHEN length(CAST(checks_json AS BLOB)) <= ? THEN checks_json END checks_json,
    length(CAST(checks_json AS BLOB)) checks_bytes
    FROM risk_events WHERE account_id=? ORDER BY created_at DESC LIMIT 1`).get(L.checksBytes, accountId)
  if (!row) return { status: 'unavailable', reason: 'saved_engine_reading_missing' }
  const checks = parse(row.checks_json)
  const identityReason=checks?nestedIdentity(checks,{accountId}):null
  return { status: identityReason ? 'identity_conflict' : !checks ? 'unavailable' : 'stored_observation',
    reason: identityReason || (row.checks_bytes > L.checksBytes ? 'checks_exceed_byte_bound' : !checks ? 'checks_missing_or_malformed' : null),
    ...project(row, ['id','account_id','approved','created_at']), ageMs: age(row.created_at, nowMs),
    checks: checks&&!identityReason ? project(checks, CHECKS) : null,
    currentParity: 'unverified_saved_verdict_has_its_own_time_and_inputs' }
}
function readPending(db, target, nowMs) {
  if (!target) return null
  const rows = db.prepare(`SELECT rowid,order_id,account_id,symbol,side,order_type,volume,limit_price,stop_price,
    sl,tp,substr(label,1,100) label,is_bot,status,first_seen,last_seen,gone_at
    FROM broker_orders ORDER BY rowid DESC LIMIT ?`).all(L.brokerOrderWindow + 1)
  const pending = db.prepare(`SELECT id,account_id,order_id,symbol,dir,level,sl,tp,volume,status,placed_at,
    expires_at,risk_event_id,intent_id,strategy FROM pending_orders ORDER BY id DESC LIMIT ?`).all(L.pendingWindow + 1)
  const matches = rows.slice(0,L.brokerOrderWindow).filter(r => r.account_id === target.accountId && r.symbol === target.symbol
    && (target.orderId == null || r.order_id === target.orderId))
  const out = { target, readAt: nowMs, status: matches.length ? 'stored_candidates' : 'unavailable',
    reason: matches.length ? null : 'target_not_in_bounded_stored_window',
    brokerWindowTruncated: rows.length > L.brokerOrderWindow, pendingWindowTruncated: pending.length > L.pendingWindow,
    candidatesTruncated: matches.length > L.orderCandidates, rows: [] }
  for (const row of matches.slice(0,L.orderCandidates)) {
    const related = pending.slice(0,L.pendingWindow).filter(p => p.account_id === target.accountId && p.order_id === row.order_id)
    const intents = db.prepare(`SELECT id,account_id,broker_order_id,broker_position_id,symbol,symbol_id,side,
      sl,tp,sl_units,tp_units,state,producer_id,resolution_source,created_at,updated_at,resolved_at,risk_event_id
      FROM entry_intents WHERE account_id=? AND broker_order_id=? LIMIT ?`).all(target.accountId,row.order_id,L.intentsPerOrder+1)
    const ownedPending=related.slice(0,L.intentsPerOrder).filter(p=>orderIdentity(p,row,{pending:true})===null)
    const ownedIntents=intents.slice(0,L.intentsPerOrder).filter(i=>orderIdentity(i,row)===null)
    const riskIds = [...new Set([...ownedPending,...ownedIntents].map(p => p.risk_event_id).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0,L.intentsPerOrder)
    const policy = riskIds.map(riskId => {
      const r = db.prepare(`SELECT id,account_id,symbol,side,approved,created_at,
        CASE WHEN length(CAST(checks_json AS BLOB)) <= ? THEN checks_json END checks_json,
        CASE WHEN length(CAST(proposal_json AS BLOB)) <= ? THEN proposal_json END proposal_json
        FROM risk_events WHERE id=?`).get(L.checksBytes,L.checksBytes,riskId)
      if (!r || r.account_id !== target.accountId || r.symbol !== row.symbol || r.side !== row.side)
        return { id: riskId, status: 'identity_unverified' }
      const checks = parse(r.checks_json)
      const proposal=parse(r.proposal_json)
      const identity={accountId:target.accountId,symbol:row.symbol,side:row.side,orderId:row.order_id}
      const identityReason=(checks?nestedIdentity(checks,identity):null)||(proposal?nestedIdentity(proposal,identity):null)
      return { ...project(r,['id','account_id','symbol','side','approved','created_at']),
        status: identityReason ? 'identity_conflict' : checks ? 'owned_recorded_checks' : 'unavailable',reason:identityReason,
        proposal:proposal&&!identityReason ? project(proposal,['symbol','side','entry','sl','tp','volume','order_type']) : null,
        checks: checks&&!identityReason ? project(checks,['entry','sl','tp','risk_usd','sl_distance','rr','sl_valid','min_rr','adjusted_volume']) : null }
    })
    out.rows.push({ ...project(row,['order_id','account_id','symbol','side','order_type','volume','limit_price','stop_price','sl','tp','label','is_bot','status','first_seen','last_seen','gone_at']),
      lastSeenAgeMs: age(row.last_seen,nowMs), statusMeaning: row.status === 'gone' ? 'no_longer_resting_filled_or_cancelled_unresolved' : 'last_owned_reconcile_observation',
      volumeUnits: 'legacy_broker_orders_units_not_certified_protocol_volume',
      pending: related.slice(0,L.intentsPerOrder).map(p => ({...project(p,['id','account_id','order_id','symbol','dir','level','sl','tp','volume','status','placed_at','expires_at','risk_event_id','intent_id','strategy']),
        identityStatus:orderIdentity(p,row,{pending:true})?'identity_conflict':'owned_order_candidate',identityReason:orderIdentity(p,row,{pending:true})})),
      pendingTruncated: related.length > L.intentsPerOrder,
      intents: intents.slice(0,L.intentsPerOrder).map(i => ({...project(i,['id','account_id','broker_order_id','broker_position_id','symbol','symbol_id','side','sl','tp','sl_units','tp_units','state','producer_id','resolution_source','created_at','updated_at','resolved_at','risk_event_id']),
        identityStatus:orderIdentity(i,row)?'identity_conflict':'owned_order_candidate',identityReason:orderIdentity(i,row)})),
      intentsTruncated: intents.length > L.intentsPerOrder, recordedPolicy: policy,
      policyStatus: policy.length ? 'recorded_candidates_not_current_protection_approval' : 'recorded_policy_unavailable' })
  }
  return out
}

function readSnapshotEvidence(db, { accountIds = [], pendingTarget = null, nowMs = Date.now() } = {}) {
  if (!Array.isArray(accountIds) || accountIds.length > L.accounts || accountIds.some(v => !id(v)) || !Number.isFinite(nowMs)) throw Error('invalid_account_targets')
  const ids = [...new Set(accountIds.map(id))]
  let target = null
  if (pendingTarget != null) {
    if (!id(pendingTarget.accountId) || typeof pendingTarget.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,24}$/.test(pendingTarget.symbol)
      || (pendingTarget.orderId != null && !id(pendingTarget.orderId))) throw Error('invalid_pending_target')
    target = { accountId: id(pendingTarget.accountId), symbol: pendingTarget.symbol, orderId: pendingTarget.orderId == null ? null : id(pendingTarget.orderId) }
  }
  const records = [], refusals = new Set(), reader = boundedDb(db,refusals)
  // Index sentinels bound the full canonical readers; never truncate a SUM or
  // call a truncated population the enforced verdict. Large DBs stay unknown.
  const registryRows = db.prepare('SELECT account_id,length(CAST(params AS BLOB)) paramsBytes FROM accounts LIMIT ?').all(L.registryRows+1)
  const registryBound = registryRows.length <= L.registryRows && registryRows.every(r => !(r.paramsBytes > L.stateBytes))
  const riskBound = ids.length === 0 ? false : db.prepare("SELECT id FROM trades INDEXED BY idx_trades_status_closed WHERE status='closed' LIMIT ?").all(L.closedRiskRows+1).length <= L.closedRiskRows
  for (const accountId of ids) {
    const registry = db.prepare('SELECT account_id,is_live,enabled,mode,base_currency,leverage,updated_at FROM accounts WHERE account_id=?').get(accountId)
    if (!registry) { records.push({ kind:'account-evidence', value:{accountId,readAt:nowMs,status:'unavailable',reason:'account_not_in_registry'} }); continue }
    const money = accountMoney(reader,accountId,{now:nowMs}), snapshot = readAccountSnapshot(reader,accountId,{nowMs})
    const storedSnapshot = parse(readState(db,`acct:${accountId}:broker_snapshot_cache_json`))
    const ownedSnapshot = String(storedSnapshot?.account?.accountId) === accountId ? storedSnapshot.account : null
    const conversion = accountCurrencyConversion(reader,accountId,{now:nowMs})
    const conflict = !!(money.observation?.currency && snapshot.currency && money.observation.currency !== snapshot.currency)
    let currentRisk = { status:'unavailable',reason:!riskBound ? 'canonical_risk_population_exceeds_read_bound' : 'canonical_risk_read_failed' }
    if (riskBound && refusals.size===0) {
      try {
        const daily = readDailyRiskVerdict(reader,accountId,{nowMs})
        currentRisk = { status:'canonical_read',readAt:nowMs,balanceNative:daily.balanceNative,balanceUsd:daily.balance,
          dailyPacing:dailyPacingReading(daily),checks:project(daily.verdict.checks,CHECKS),
          sources:['risk-full.dailyPacing','config-proposals.dailyPacing','dailyLossVerdict'],
          routeParity:'shared_canonical_boundary_actual_http_routes_not_read',
          configProposalEconomics:'unread_no_all_account_history_report' }
      } catch { /* preserve explicit unavailability, not a guessed cap */ }
    }
    if(refusals.size)currentRisk={status:'unavailable',reason:'canonical_input_exceeds_byte_bound'}
    const map = parse(readState(db,`symbol_id_map:${accountId}`)), catalogue = parse(readState(db,`owner_universe_catalogue:${accountId}`))
    const ownedCatalogue = catalogue?.accountId === accountId ? catalogue : null
    const positions = Array.isArray(ownedSnapshot?.positions) ? ownedSnapshot.positions : []
    records.push({kind:'account-evidence',value:{accountId,readAt:nowMs,status:'stored_evidence',
      registry:project(registry,['account_id','is_live','enabled','mode','base_currency','leverage','updated_at']),
      phases:registryBound ? {master:masterPhases(reader),overrides:accountOverrides(reader,accountId),effective:effectivePhases(reader,accountId),capabilities:accountCapabilities(reader,accountId)} : {status:'unavailable',reason:'registry_population_exceeds_read_bound'},
      entry:project(engineStatusFor(reader,accountId),['effectiveEntryMode','tickObservation','transitionState','validationStage','updatedAt','stored','entryModePolicy']),
      admittedBases:basesFor(engineStatusFor(reader,accountId)),
      strategyGates:registryBound ? tradeGateMatrix(reader,{accountId}).rows?.slice(0,64).map(r => project(r,['strategy','scope','blockedBy','configurationOpen','ok'])) ?? [] : [],
      money:{...project(money,['status','reason','ageMs','maxAgeMs','balanceUsd']),observation:money.observation ? project(money.observation,['accountId','host','source','sourceTimestamp','receivedAt','depositAssetId','moneyDigits','balance','currency','currencyObservedAt','currencySource','reason']) : null},
      snapshot:{...project(snapshot,['status','reason','fetchedAt','ageMs','maxAgeMs','currency']),health:snapshot.snapshot ? project(snapshot.snapshot.account.health,['balance','equity','usedMargin','freeMargin','marginLevelPct']) : null,
        positionsObserved:positions.length,positionsTruncated:positions.length>L.snapshotPositions,
        positionObservation:'stored_snapshot_age_applies_not_freshened_here'},
      currencyConflict:conflict,engineBalanceNative:getAccountBalance(reader,accountId),fx:conversionView(conversion),
      riskConfig:project(loadRiskConfig(reader,accountId),CONFIG),currentRisk,savedEngine:savedRisk(db,accountId,nowMs),
      catalogue:{status:map?.accountId===accountId?'owned_name_map':'unavailable',builtAt:scalar(map?.builtAt),
        detailsAt:scalar(ownedCatalogue?.at),stocksObserved:Array.isArray(ownedCatalogue?.stocks)?ownedCatalogue.stocks.length:null,
        stocksTruncated:Array.isArray(ownedCatalogue?.stocks)&&ownedCatalogue.stocks.length>L.catalogueStocks,
        missing:['account_owned_lotSize_minVolume_stepVolume','current_leverage_receipt','prospective_margin_for_specific_entry'],
        globalLotRegistry:'not_used_no_account_host_or_observation_time'},
      feasibility:{status:'unverified',reason:'owned_protocol_metadata_and_specific_entry_inputs_required',exactHalfRule:'positive_safe_integer_volume_and_half_on_step_half_at_least_minimum',profitAfterCosts:'unverified'}}})
    for(const position of positions.slice(0,L.snapshotPositions))records.push({kind:'account-volume-evidence',value:{accountId,readAt:nowMs,fetchedAt:scalar(storedSnapshot?.fetchedAt),snapshotStatus:snapshot.status,
      position:project(position,['positionId','symbol','side','rawVolume','lots','minLot','entry','sl','tp','usedMargin','commission','openedAt','lastModifiedAt']),
      units:'rawVolume_is_protocol_lots_and_minLot_are_snapshot_decodes',exactHalf:'unverified_step_and_lotSize_not_stored'}})
    for(const stock of (Array.isArray(ownedCatalogue?.stocks)?ownedCatalogue.stocks:[]).slice(0,L.catalogueStocks))records.push({kind:'account-fee-evidence',value:{accountId,observedAt:scalar(ownedCatalogue.at),
      source:'owned_catalogue_stored_stock_details',stock:project(stock,['symbol','symbolId','commission','commissionType','minCommission','minCommissionType','minCommissionAsset']),currentFeeSchedule:'unverified_stored_observation_only'}})
  }
  const pendingOrders=readPending(db,target,nowMs)
  if(pendingOrders){const{rows,...summary}=pendingOrders;records.push({kind:'pending-order-summary',value:summary});for(const row of rows)records.push({kind:'pending-order-evidence',value:{target,readAt:nowMs,row}})}
  return {readAt:nowMs,limits:L,accountIds:ids,registryBound,riskBound,refusals:[...refusals],records,
    brokerRequests:0,writes:0,claimsCurrentParity:false}
}

export function readAccountEvidence(db,options={}) {
  return db.transaction(()=>readSnapshotEvidence(db,options)).deferred()
}
