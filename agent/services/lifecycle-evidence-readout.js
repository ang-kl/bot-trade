// Codex · №12,944 · 2026-10-10; codex-footprint: stored-lifecycle-projection.
// Explicit private targets only. No broker request, arbitrary state/SQL, schema
// mutation, historical repair or financial verdict. Unknown facts remain null.
export const LIFECYCLE_READ_LIMITS = Object.freeze({ tradeIds: 8, dealIds: 64, positions: 64,
  dealsPerPosition: 8, attributionPerPosition: 8, partialsPerPosition: 4,
  eventsPerKind: 8, intentsPerPosition: 4, jsonBytes: 16000, outputBytes: 192 * 1024 })
const LIMIT = LIFECYCLE_READ_LIMITS
const side = x => ['BUY','long',1].includes(x)?'BUY':['SELL','short',2].includes(x)?'SELL':null
const identity = x => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x) ? x
  : Number.isSafeInteger(x) && x > 0 ? String(x) : null
const scalar = x => typeof x === 'number' ? Number.isFinite(x) ? x : null
  : typeof x === 'boolean' ? x
    : typeof x === 'string' && /^[\w.:+ -]{1,100}$/.test(x) ? x : null
const project = (row, fields) => Object.fromEntries(fields.map(field => [field, scalar(row?.[field])]))
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const parse = raw => { try { return typeof raw === 'string' && Buffer.byteLength(raw) <= LIMIT.jsonBytes
  ? JSON.parse(raw) : null } catch { return null } }
const ids = values => Array.isArray(values) ? values.slice(0, 12).map(identity).filter(Boolean) : null
const ownerMatches = (row, target, account='account_id', position='position_id') =>
  identity(row?.[account]) === target.accountId && identity(row?.[position]) === target.positionId
const brokerMatches = (value, target) => object(value)
  && identity(value.accountId) === target.accountId && identity(value.positionId) === target.positionId
const RECEIPT = ['provider','host','accountId','symbolId','positionId','dealId','orderId','closedVolume','price','executedAtMs','source']
const RESIDUAL = ['provider','host','accountId','symbolId','positionId','observedAtMs','source','absent','side','entry','volume','stopLoss','takeProfit']
const TRADE = ['id','account_id','ctrader_position_id','symbol','side','status','origin','origin_source','source','strategy',
  'label_strategy','intent_id','risk_event_id','entry_price','exit_price','volume','requested_volume','opened_at','closed_at',
  'closed_at_ms','gross_pnl','commission','swap','net_pnl']
const DEAL = ['deal_id','account_id','position_id','symbol','side','lots','requested_lots','volume_contract','entry_price','close_price',
  'opened_at','closed_at','gross_pnl','swap','commission','net_pnl','matched_trade_id','imported_at','balance_currency','balance_source']
const VERDICT = ['account_id','position_id','host','verdict','final','rules','source','deals','executed','symbol_id','opening_side',
  'opened_ms','final_close_ms','broker_net','broker_gross','broker_swap','broker_commission','conversion_fee','ledger_net','read_at','reads','last_error_at']
const EXPECTED = ['accountId','dealId','positionId','orderId','symbolId','tradeSide','filledVolume','executionPrice','executionTimestamp','entryPrice']
const ORDER_EVIDENCE = ['accountId','dealId','positionId','orderId','orderType','orderStatus','stopPrice','limitPrice','ok','cause','confidence']
const INTENT = ['id','account_id','environment','symbol','symbol_id','side','volume','sl','sl_units','tp','tp_units','producer_id','basis',
  'state','broker_position_id','broker_order_id','risk_event_id','resolution_source','created_at','updated_at','resolved_at']
const PLAN = ['accountId','positionId','tradeId','monitorId','symbol','side','host','source','requested','lotSize','digits','bankPartialAt']
const EVENT = ['id','at','account_id','position_id','trade_id','symbol','kind','from_value','to_value','price_at','source']

function projectedPartial(row, target, trade) {
  const plan=parse(row.plan_json),receipt=parse(row.receipt_json),residual=parse(row.residual_json),raw=parse(row.raw_json)
  const ownedPlan=brokerMatches(plan,target) && plan.tradeId===row.trade_id && plan.monitorId===row.monitor_id
    && plan.symbol===trade.symbol && side(plan.side)===side(trade.side)
    && ['demo.ctraderapi.com','live.ctraderapi.com'].includes(plan.host)
    && identity(plan.identity?.accountId)===target.accountId && identity(plan.identity?.symbolId)!=null && plan.identity.host===plan.host
  const ownedNested=value=>ownedPlan&&brokerMatches(value,target)&&value.host===plan.host
    && identity(value.symbolId)===identity(plan.identity.symbolId)
    && (value.side==null||side(value.side)===side(plan.side))
  const nested = value => value == null ? 'not_recorded_or_oversized' : ownedNested(value) ? 'stored_owned_record' : 'identity_conflict'
  const out={...project(row,['id','account_id','position_id','trade_id','monitor_id','state','attempted_at','confirmed_at','checked_at']),
    units:'ctrader_protocol_volume',reasonRecorded:row.reason!=null,
    planStatus:plan==null?'not_recorded_or_oversized':ownedPlan?'stored_owned_record':'identity_conflict',
    plan:ownedPlan?{...project(plan,PLAN),identity:project(plan.identity,['provider','host','accountId','symbolId']),
      before:ownedNested(plan.before)?project(plan.before,RESIDUAL):null}:null,
    receiptStatus:nested(receipt),receipt:ownedNested(receipt)?project(receipt,RECEIPT):null,
    residualStatus:nested(residual),residual:ownedNested(residual)?project(residual,RESIDUAL):null}
  const d=raw?.deal,c=d?.closePositionDetail
  const ownRaw=ownedPlan && object(raw) && identity(raw.ctidTraderAccountId)===target.accountId && identity(d?.positionId)===target.positionId
    && identity(d?.symbolId)===identity(plan.identity.symbolId)
    && side(d.tradeSide)===(side(plan.side)==='BUY'?'SELL':'BUY')
    && (raw.position?.positionId==null || identity(raw.position.positionId)===target.positionId)
    && (raw.order?.positionId==null || identity(raw.order.positionId)===target.positionId)
    && (raw.order?.orderId==null || identity(raw.order.orderId)===identity(d.orderId))
  out.rawStatus=raw==null?'not_recorded_or_oversized':ownRaw?'stored_owned_record':object(d)?'identity_conflict':'identity_unverified'
  out.raw=ownRaw?{ctidTraderAccountId:target.accountId,executionType:scalar(raw.executionType),
    deal:{...project(d,['dealId','orderId','positionId','symbolId','tradeSide','dealStatus','volume','filledVolume','executionPrice','executionTimestamp']),
      closePositionDetail:object(c)?project(c,['entryPrice','closedVolume','moneyDigits','grossProfit','swap','commission','pnlConversionFee']):null}}:null
  return out
}

/** Small record stream for the existing once-only private-log emitter. */
export function readLifecycleEvidence(db,{tradeIds=[],dealIds=[],now=Date.now()}={}) {
  if(!Array.isArray(tradeIds)||tradeIds.length>LIMIT.tradeIds||tradeIds.some(x=>!Number.isSafeInteger(x)||x<=0)
    ||!Array.isArray(dealIds)||dealIds.length>LIMIT.dealIds||dealIds.some(x=>identity(x)===null)
    ||!Number.isFinite(now)) throw Error('invalid_lifecycle_targets')
  return db.transaction(()=>{
    const records=[],targets=new Map(),requestedDeals=[...new Set(dealIds.map(identity))]
    let bytes=0,omittedRecords=0,truncatedRanges=0,identityConflicts=0,unavailableSections=0
    const add=(kind,value)=>{
      const record={kind,value},n=Buffer.byteLength(JSON.stringify(record))
      // The bounded summary (at most 8 trade and 64 decimal deal IDs) and
      // enclosing JSON need space too; count each record's array separator.
      if(n>LIMIT.jsonBytes||bytes+n+1>LIMIT.outputBytes-4096){omittedRecords++;return}
      bytes+=n+1;records.push(record)
    }
    const schema=new Map()
    const columns=table=>{if(!schema.has(table))schema.set(table,new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name)));return schema.get(table)}
    const read=(table,fields,where,args=[],order='',limit=1)=>{
      const have=columns(table)
      if(!have.size)return {status:'missing_table',rows:[],missingColumns:fields}
      const available=fields.filter(f=>have.has(f))
      if(!available.length)return {status:'missing_columns',rows:[],missingColumns:fields}
      const selected=available.map(f=>f.endsWith('_json')||['ledger_rows','trade_ids'].includes(f)?`CASE WHEN length(${f})<=${LIMIT.jsonBytes} THEN ${f} END ${f}`:f).join(',')
      try{return {status:'observed',rows:db.prepare(`SELECT ${selected} FROM ${table} WHERE ${where}${order?` ORDER BY ${order}`:''} LIMIT ?`).all(...args,limit+1),missingColumns:fields.filter(f=>!have.has(f))}}
      catch{return {status:'stored_read_failed',rows:[],missingColumns:[]}}
    }
    const range=(kind,target,result,cap,accept,shape)=>{
      let conflicts=0
      for(const row of result.rows.slice(0,cap)){
        if(!accept(row)){conflicts++;continue}
        const value=shape(row)
        conflicts+=Object.entries(value).filter(([key,v])=>key.endsWith('Status')&&v==='identity_conflict').length
        conflicts+=Object.entries(value.detail??{}).filter(([key,v])=>key.endsWith('Status')&&v==='identity_conflict').length
        add(kind,{target,...value})
      }
      const truncated=result.rows.length>cap
      if(truncated)truncatedRanges++
      identityConflicts+=conflicts;if(result.status!=='observed')unavailableSections++
      add('lifecycle-range',{target,kind,status:result.status,limit:cap,truncated,identityConflicts:conflicts,
        missingColumns:result.missingColumns,returnedRows:Math.min(result.rows.length,cap)})
    }
    const selectTarget=(accountId,positionId)=>{
      const account=identity(accountId),position=identity(positionId)
      if(!account||!position)return null
      const key=account+':'+position
      if(!targets.has(key)){
        if(targets.size>=LIMIT.positions){omittedRecords++;return null}
        targets.set(key,{accountId:account,positionId:position})
      }
      return targets.get(key)
    }
    for(const tradeId of new Set(tradeIds)){
      const r=read('trades',TRADE,'id=?',[tradeId])
      const row=r.rows[0],target=row&&selectTarget(row.account_id,row.ctrader_position_id)
      add('lifecycle-target',{tradeId,status:r.status!=='observed'?r.status:!row?'trade_missing':target?'stored_owned_identity':'trade_identity_unverified',target})
    }
    for(const dealId of requestedDeals){
      const r=read('broker_deals',DEAL,'deal_id=?',[dealId]),row=r.rows[0]
      const target=row&&selectTarget(row.account_id,row.position_id)
      add('lifecycle-deal-target',{dealId,status:r.status!=='observed'?r.status:!row?'deal_missing':target?'stored_owned_identity':'deal_identity_unverified',target,
        row:row?project(row,DEAL):null})
    }
    for(const target of targets.values()){
      const {accountId,positionId}=target
      const tradeRows=read('trades',TRADE,'account_id=? AND ctrader_position_id IN (?,?)',[accountId,positionId,positionId+'.0'],'id DESC',4)
      const ownedTrades=new Map(tradeRows.rows.slice(0,4).filter(r=>identity(r.account_id)===accountId
        && [positionId,positionId+'.0'].includes(String(r.ctrader_position_id))).map(r=>[r.id,r]))
      range('lifecycle-owner',target,tradeRows,4,row=>ownedTrades.has(row.id),row=>({row:project(row,TRADE),
        volumeMeaning:'stored_trade_lots_not_opening_execution_proof',entryReleaseStamp:'not_recorded_in_trade_schema'}))
      range('closing-deal',target,read('broker_deals',DEAL,'account_id=? AND position_id=?',[accountId,positionId],'',LIMIT.dealsPerPosition),
        LIMIT.dealsPerPosition,row=>ownerMatches(row,target),row=>({row:project(row,DEAL),
          quantityMeaning:row.volume_contract===1?'executed_lots':'unverified_retained_lots',moneyMeaning:'stored_native_net_once_signed_costs_already_included'}))
      range('lifecycle-verdict',target,read('position_lifecycle_evidence',[...VERDICT,'ledger_rows','trade_ids','reason','last_error'],
        'account_id=? AND position_id=?',[accountId,positionId]),1,row=>ownerMatches(row,target),row=>({row:project(row,VERDICT),
          reasonRecorded:row.reason!=null,lastErrorRecorded:row.last_error!=null,
          ledgerRows:Array.isArray(parse(row.ledger_rows))?parse(row.ledger_rows).slice(0,8).map(r=>project(r,['id','status','net','writtenOff'])):null,
          tradeIds:ids(parse(row.trade_ids)),openingExecution:'ids_and_quantities_not_retained_in_verdict_schema'}))
      range('closing-attribution',target,read('broker_close_attribution',['account_id','deal_id','position_id','order_id','execution_at','state','cause','confidence',
        'verified_at','attempts','expected_json','evidence_json'],'account_id=? AND position_id=?',[accountId,positionId],'execution_at DESC',LIMIT.attributionPerPosition),
        LIMIT.attributionPerPosition,row=>ownerMatches(row,target),row=>{
          const expected=parse(row.expected_json),evidence=parse(row.evidence_json)
          const matches=value=>brokerMatches(value,target)&&identity(value.dealId)===identity(row.deal_id)&&identity(value.orderId)===identity(row.order_id)
          return {row:project(row,['account_id','deal_id','position_id','order_id','execution_at','state','cause','confidence','verified_at','attempts']),
            units:'ctrader_protocol_volume',expectedStatus:expected==null?'not_recorded_or_oversized':matches(expected)?'stored_owned_record':'identity_conflict',
            expected:matches(expected)?project(expected,EXPECTED):null,evidenceStatus:evidence==null?'not_recorded_or_oversized':matches(evidence)?'stored_owned_record':'identity_conflict',
            evidence:matches(evidence)?project(evidence,ORDER_EVIDENCE):null,actorMeaning:'market_order_does_not_prove_initiator'}
        })
      range('entry-intent',target,read('entry_intents',INTENT,'account_id=? AND broker_position_id=?',[accountId,positionId],'rowid',LIMIT.intentsPerPosition),
        LIMIT.intentsPerPosition,row=>ownerMatches(row,target,'account_id','broker_position_id'),row=>({row:project(row,INTENT),
          volumeMeaning:'requested_not_opening_fill',stopMeaning:'requested_entry_bracket_not_current_stop_inference',entryReleaseStamp:'not_recorded_in_intent_schema'}))
      const partialBasis=new Map()
      range('general-partial',target,read('general_partial_attempts',['id','account_id','position_id','trade_id','monitor_id','state','attempted_at','confirmed_at','checked_at',
        'plan_json','raw_json','receipt_json','residual_json','reason'],'account_id=? AND position_id=?',[accountId,positionId],'id DESC',LIMIT.partialsPerPosition),
        LIMIT.partialsPerPosition,row=>ownerMatches(row,target)&&ownedTrades.has(row.trade_id),row=>{
          const value=projectedPartial(row,target,ownedTrades.get(row.trade_id))
          if(value.planStatus==='stored_owned_record')partialBasis.set(row.id,value)
          return value
        })
      for(const [tradeId,trade] of ownedTrades)for(const kind of ['scale_out','close','volume_reduced']){
        range('lifecycle-journal',target,read('position_events',[...EVENT,'detail_json'],'trade_id=? AND kind=?',[tradeId,kind],'id DESC',LIMIT.eventsPerKind),
          LIMIT.eventsPerKind,row=>ownerMatches(row,target)&&row.trade_id===tradeId&&row.symbol===trade.symbol,row=>{
            const detail=parse(row.detail_json),receipt=detail?.receipt,residual=detail?.residual
            const basis=partialBasis.get(detail?.attemptId),plan=basis?.trade_id===tradeId?basis.plan:null
            const ownedNested=value=>plan&&brokerMatches(value,target)&&value.host===plan.host
              && identity(value.symbolId)===identity(plan.identity.symbolId)
              && (value.side==null||side(value.side)===side(plan.side))
            const status=value=>value==null?'not_recorded':!plan?'attempt_basis_not_retained':ownedNested(value)?'stored_owned_record':'identity_conflict'
            return {row:project(row,EVENT),quantityMeaning:'writer_specific_units',detail:detail?{
              ...project(detail,['attemptId','requestedVolume','volumeUnit','dealId','orderId','executedAtMs','planState','receiptSource']),
              receiptStatus:status(receipt),receipt:ownedNested(receipt)?project(receipt,RECEIPT):null,
              residualStatus:status(residual),residual:ownedNested(residual)?project(residual,RESIDUAL):null}:null}
          })
      }
    }
    return {summary:{status:omittedRecords||truncatedRanges||unavailableSections||identityConflicts?'incomplete':'observed',
      source:'stored_rows_only',readAt:now,limits:LIMIT,requestedTradeIds:[...new Set(tradeIds)],requestedDealIds:requestedDeals,
      positions:targets.size,omittedRecords,truncatedRanges,identityConflicts,unavailableSections,bytes,
      brokerRequests:0,writes:0,financialCertification:false},records}
  }).deferred()
}
