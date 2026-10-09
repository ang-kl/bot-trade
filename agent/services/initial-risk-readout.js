// Codex · №12,611 · 2026-10-09; codex-footprint: stored-initial-risk-evidence.
// Private, explicit-target evidence only. No inference, broker call or write:
// an adopted/current stop is never promoted to a trade's original risk.
const CAP = 4
const scalar = value => typeof value === 'number' ? Number.isFinite(value) ? value : null
  : typeof value === 'string' && /^[\w.:+ -]{1,64}$/.test(value) ? value : null
const project = (row, keys) => Object.fromEntries(keys.map(key => [key, scalar(row?.[key])]))
const side = value => ['BUY', 'long'].includes(value) ? 'BUY' : ['SELL', 'short'].includes(value) ? 'SELL' : null
const identity = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? value : null
const INTENT_FIELDS = ['id','account_id','environment','symbol','symbol_id','side','volume','sl','sl_units','producer_id',
  'state','broker_position_id','broker_order_id','resolution_source','created_at','updated_at','resolved_at']
const INTENT_COLUMNS = INTENT_FIELDS.join(',')
const PLAN_FIELDS = ['trade_id','account_id','symbol','side','planned_entry','planned_sl','planned_tp','risk_dist','source','created_at']

function ownership(row, trade) {
  if(identity(row?.account_id) !== identity(trade.account_id)) return 'account_conflict'
  if(identity(row?.broker_position_id) !== identity(trade.ctrader_position_id)) return 'position_missing_or_conflict'
  if(!side(row?.side) || side(row.side) !== side(trade.side)) return 'side_conflict'
  if(row.symbol != null && row.symbol !== trade.symbol) return 'symbol_conflict'
  return null
}

export function readStoredInitialRisk(db, tradeId) {
  if(!Number.isSafeInteger(tradeId) || tradeId <= 0) throw Error('invalid_target')
  const trade = db.prepare(`SELECT id,account_id,ctrader_position_id,symbol,side,origin,origin_source,source,
    intent_id,entry_price,sl_price,broker_sl_initial,opened_at FROM trades WHERE id=?`).get(tradeId)
  const out = {status:'unverified',source:'stored_rows_only',tradeId,limits:{intentRows:CAP,earliestEventRows:CAP}}
  if(!trade) return {...out,reason:'trade_missing'}
  out.trade = project(trade,['id','account_id','ctrader_position_id','symbol','side','origin','origin_source','source','intent_id','entry_price','opened_at'])
  out.observedStops = {...project(trade,['sl_price','broker_sl_initial']),classification:'observed_not_original_proof'}
  out.chronology = {openedAtMeaning:trade.origin === 'reconciler_adopted' ? 'local_adoption_time' : 'recorded_trade_open_time',brokerOpeningTime:'not_established'}
  const accountId=identity(trade.account_id),positionId=identity(trade.ctrader_position_id)
  if(!accountId || !positionId || !side(trade.side)) return {...out,reason:'trade_identity_unverified'}

  // Existing position/account index and primary key only. No symbol/time
  // search that can silently attach another trade's requested risk.
  let rows=db.prepare(`SELECT ${INTENT_COLUMNS} FROM entry_intents
    WHERE broker_position_id=? AND account_id=? ORDER BY rowid LIMIT ?`).all(positionId,accountId,CAP+1)
  const conflicts=[]
  const linked=trade.intent_id == null ? null : db.prepare(`SELECT ${INTENT_COLUMNS} FROM entry_intents WHERE id=?`).get(trade.intent_id)
  const linkedStatus=trade.intent_id == null ? 'not_recorded' : !linked ? 'linked_intent_missing' : ownership(linked,trade) || 'owned_position_join'
  if(linked && linkedStatus !== 'owned_position_join') conflicts.push({source:'linked_intent',reason:linkedStatus})
  // Codex · №12,692 · 2026-10-09; codex-footprint: bounded-linked-intent.
  // The CAP+1 sentinel can itself be the linked row. Keep that owned source
  // inside the output window without duplicating it or dropping truncation.
  if(linkedStatus === 'owned_position_join' && !rows.slice(0,CAP).some(row=>row.id===linked.id))
    rows=[linked,...rows.filter(row=>row.id!==linked.id)]
  const accepted=[]
  for(const row of rows.slice(0,CAP)) {
    const reason=ownership(row,trade)
    if(reason) conflicts.push({source:'position_intent',reason})
    else accepted.push(project(row,INTENT_FIELDS))
  }
  out.intents={status:rows.length>CAP?'truncated':conflicts.length?'identity_conflict':accepted.length>1?'ambiguous':accepted.length===1?'owned_record_candidate':'missing',
    linkedStatus,truncated:rows.length>CAP,conflicts,rows:accepted,
    riskMeaning:'requested_at_entry_not_independently_broker_verified'}

  const plan=db.prepare(`SELECT ${PLAN_FIELDS.join(',')} FROM trade_plans WHERE trade_id=?`).get(tradeId)
  const planConflict=plan && (identity(plan.account_id)!==accountId || plan.symbol!==trade.symbol || side(plan.side)!==side(trade.side))
  out.plan={status:!plan?'missing':planConflict?'identity_conflict':'owned_record_candidate',
    row:plan && !planConflict?project(plan,PLAN_FIELDS):null,recordNature:'replaceable_plan_not_immutable_opening_proof'}

  const events=db.prepare(`SELECT id,at,account_id,position_id,trade_id,symbol,kind,from_value,to_value,source
    FROM position_events WHERE trade_id=? ORDER BY id LIMIT ?`).all(tradeId,CAP+1)
  let eventConflicts=0
  out.earliestEvents={truncated:events.length>CAP,identityConflicts:0,rows:[]}
  for(const event of events.slice(0,CAP)) {
    if(identity(event.account_id)!==accountId || identity(event.position_id)!==positionId || event.symbol!==trade.symbol) {eventConflicts++;continue}
    out.earliestEvents.rows.push(project(event,['id','at','account_id','position_id','trade_id','symbol','kind','from_value','to_value','source']))
  }
  out.earliestEvents.identityConflicts=eventConflicts
  return out
}
