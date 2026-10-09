// Codex · №12,435 · 2026-10-09; codex-footprint: targeted-owned-evidence.
// Private operator readout. No arbitrary SQL, broker call, profiler or action.
// Every monetary/position value is a dated stored observation, never refreshed here.
import { readHybridVerdicts } from './diagnostic-readout.js'
import { brokerPolicyObservation } from '../lib/stop-policy.js'
import { readStoredInitialRisk } from './initial-risk-readout.js'
const CAP = 64, PER_KIND = 8
const scalar = x => typeof x === 'number' ? Number.isFinite(x) ? x : null
  : typeof x === 'boolean' ? x
    : typeof x === 'string' && /^[\w.:+ -]{1,100}$/.test(x) ? x : null
const project = (x, keys) => Object.fromEntries(keys.map(k => [k, scalar(x?.[k])]))
function stored(db, key) {
  const row=db.prepare('SELECT CASE WHEN length(value)<=131072 THEN value END value FROM agent_state WHERE key=?').get(key)
  try { return JSON.parse(row?.value || 'null') } catch { return null }
}
const MOVEMENT_FIELDS=['v','source','confirmation','stopMoved','accountId','positionId','symbolId','direction','entryPrice',
  'beforeCheckedAtMs','afterCheckedAtMs','beforeStopLoss','afterStopLoss']
const VOLUME_FIELDS=['source','units','host','accountId','positionId','symbolId','side','metadataReceivedAtMs',
  'reconcileReceivedAtMs','volume','halfVolume','minVolume','stepVolume','minVolumeValid','stepVolumeValid']

function targetIds(raw) {
  if(raw == null || raw === '') return []
  if(typeof raw !== 'string' || !/^[1-9]\d{0,14}(,[1-9]\d{0,14}){0,7}$/.test(raw)) return null
  return [...new Set(raw.split(',').map(Number))]
}
export function readTargetedEvidence(db, now=Date.now(), tradeIds=[]) {
  if(!Array.isArray(tradeIds)||tradeIds.length>8||tradeIds.some(n=>!Number.isSafeInteger(n)||n<=0)) throw Error('invalid_targets')
  // The existing status index narrows to open trades; the new trade/kind index
  // retrieves each movement kind without walking thousands of observations.
  const owners=db.prepare(`SELECT id,account_id,ctrader_position_id,symbol,side,status FROM trades
    WHERE status='open' ORDER BY closed_at DESC,id DESC LIMIT ?`).all(CAP+1)
  const selected=[]
  // Codex · №12,439 · 2026-10-09; codex-footprint: retained-movement-targets.
  // Explicit primary-key targets remain readable if they naturally close
  // while the release gates run. Never search all closed-position history.
  for(const id of tradeIds) {
    if(selected.some(r=>r.id===id)) continue
    const row=owners.slice(0,CAP).find(r=>r.id===id) || db.prepare('SELECT id,account_id,ctrader_position_id,symbol,side,status FROM trades WHERE id=?').get(id)
    if(row) selected.push(row)
  }
  // Requested targets get the finite output budget before the open population.
  for(const row of owners.slice(0,CAP)) if(!selected.some(r=>r.id===row.id)) selected.push(row)
  const pass=stored(db,'momentum_partial_pass_json'), protection=stored(db,'independent_protection_json')
  const out={readAt:now,limits:{openTrades:CAP,totalTradesBound:CAP+tradeIds.length,rowsPerMovementKind:PER_KIND,ownerOrder:'closed_at_desc_id_desc',targetTradeIds:tradeIds},truncatedTrades:owners.length>CAP,
    verdicts:readHybridVerdicts(db),trades:[]}
  for(const owner of selected) {
    const record={owner:project(owner,['id','account_id','ctrader_position_id','symbol','side','status']),movements:[],volumeRefusals:[],protection:[]}
    // Codex · №12,611 · 2026-10-09; codex-footprint: stored-initial-risk-evidence.
    // Only explicit operator targets receive this additional local projection.
    if(tradeIds.includes(owner.id)) record.initialRisk=readStoredInitialRisk(db,owner.id)
    if(!owner.account_id || !owner.ctrader_position_id) { record.unavailable='missing_owner'; out.trades.push(record); continue }
    for(const kind of ['trail_tightened','sl_moved','scale_out']) {
      const rows=db.prepare(`SELECT id,at,account_id,position_id,trade_id,symbol,kind,from_value,to_value,source,
        CASE WHEN length(detail_json)<=16000 THEN detail_json END detail_json
        FROM position_events WHERE trade_id=? AND kind=? ORDER BY id DESC LIMIT ?`).all(owner.id,kind,PER_KIND+1)
      const group={kind,truncated:rows.length>PER_KIND,identityConflicts:0,rows:[]}
      for(const row of rows.slice(0,PER_KIND)) {
        if(String(row.account_id)!==String(owner.account_id) || String(row.position_id)!==String(owner.ctrader_position_id)
          || row.symbol!==owner.symbol) { group.identityConflicts++; continue }
        let detail; try { detail=JSON.parse(row.detail_json) } catch { /* legacy/missing */ }
        group.rows.push({...project(row,['id','at','account_id','position_id','trade_id','symbol','kind','from_value','to_value','source']),
          provenance:project(detail,['nativeSide','nativeBootId','nativeSeq','nativeAtMs','host']),
          movement:detail?.movement ? project(detail.movement,MOVEMENT_FIELDS) : null})
      }
      record.movements.push(group)
    }
    for(const refusal of (Array.isArray(pass?.cappedHybrid?.deferred)?pass.cappedHybrid.deferred:[]).slice(0,CAP)) {
      if(refusal.tradeId!==owner.id || String(refusal.accountId)!==String(owner.account_id)) continue
      const v=refusal.volumeInputs
      const owned=v && String(v.accountId)===String(owner.account_id) && String(v.positionId)===String(owner.ctrader_position_id)
      record.volumeRefusals.push({passAt:scalar(pass.at),reason:scalar(refusal.reason),
        inputStatus:owned?'stored_owned_observation':v?'identity_conflict':'not_recorded',
        inputs:owned?project(v,VOLUME_FIELDS):null})
    }
    for(const account of (Array.isArray(protection?.accounts)?protection.accounts:[]).slice(0,CAP)) {
      if(String(account.accountId)!==String(owner.account_id)) continue
      for(const p of (Array.isArray(account.positions)?account.positions:[]).slice(0,CAP)) {
        if(String(p.positionId)!==String(owner.ctrader_position_id)) continue
        record.protection.push({readAt:scalar(protection.readAt),...project(account,['accountId','host','checkedAtMs','ok']),
          position:{...project(p,['positionId','symbolId','tradeSide','volume','price','entryPrice','stopLoss','takeProfit']),
            ...brokerPolicyObservation(p)}})
      }
    }
    out.trades.push(record)
  }
  return out
}

export function startTargetedEvidenceReadout(db,{env=process.env,log=console.log,now=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  const tradeIds=targetIds(env.OWNED_EVIDENCE_TRADE_IDS)
  if(tradeIds===null)return null
  const id=env.OWNED_EVIDENCE_RUN_ID,expires=Date.parse(env.OWNED_EVIDENCE_EXPIRES_AT||'')
  if(typeof id!=='string'|| !/^[a-zA-Z0-9_-]{8,64}$/.test(id)|| !Number.isFinite(expires)||expires<=now()||expires-now()>3600000) return null
  let bytes=0,dropped=0
  const emit=(kind,value)=>{
    try {
      const line=JSON.stringify({diagnostic:'owned-evidence-v1',runId:id,
        commit:/^[a-f0-9]{40}$/.test(env.RAILWAY_GIT_COMMIT_SHA||'')?env.RAILWAY_GIT_COMMIT_SHA:null,
        deployment:/^[a-f0-9-]{36}$/.test(env.RAILWAY_DEPLOYMENT_ID||'')?env.RAILWAY_DEPLOYMENT_ID:null,kind,value})
      const n=Buffer.byteLength(line)
      // Codex · №12,437 · 2026-10-09; codex-footprint: bounded-evidence-review.
      // Reserve the terminal record even if detail output reaches its cap.
      const ceiling=kind==='exit'?256*1024:256*1024-2048
      if(n>16000||bytes+n>ceiling){dropped++;return}
      bytes+=n;log(line)
    } catch { dropped++ }
  }
  try {
    if(db.prepare('INSERT OR IGNORE INTO agent_state(key,value) VALUES (?,?)')
      .run(`owned_evidence:${id}`,JSON.stringify({at:now(),tradeIds})).changes!==1) return null
  } catch { emit('not-started',{reason:'durable_claim_failed'});return null }
  // A single delayed read gives ordinary enrolment a chance to persist inputs.
  // It never runs enrolment, submits an order, or repeats until a desired result.
  const timer=setTimer(()=>{
    if(now()>=expires){emit('exit',{reason:'deadline_expired',dropped});return}
    try {
      const {trades,...metadata}=readTargetedEvidence(db,now(),tradeIds)
      emit('summary',metadata)
      for(const trade of trades) {
        const {movements,initialRisk,...fields}=trade;emit('owned-position',fields)
        if(initialRisk) emit('initial-risk',{owner:trade.owner,...initialRisk})
        for(const group of movements) {
          const {rows,...bounds}=group;emit('movement-range',{owner:trade.owner,...bounds})
          for(const row of rows) emit('movement',{owner:trade.owner,row})
        }
      }
      emit('exit',{at:now(),done:true,dropped,bytes})
    } catch { emit('exit',{at:now(),done:false,reason:'stored_read_failed',dropped}) }
  },180000)
  timer?.unref?.()
  emit('scheduled',{at:now(),delayMs:180000,expires,brokerRequests:0,profiling:false})
  return ()=>clearTimer(timer)
}
