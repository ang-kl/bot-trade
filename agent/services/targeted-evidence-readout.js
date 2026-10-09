// Codex · №12,435 · 2026-10-09; codex-footprint: targeted-owned-evidence.
// Private operator readout. No arbitrary SQL, broker call, profiler or action.
// Every monetary/position value is a dated stored observation, never refreshed here.
import { readHybridVerdicts } from './diagnostic-readout.js'
import { brokerPolicyObservation } from '../lib/stop-policy.js'
import { readStoredInitialRisk } from './initial-risk-readout.js'
import { readScannerEvidence } from './scanner-evidence-readout.js'
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

// Codex · №12,808 · 2026-10-10; codex-footprint: hybrid-verdict-only-read.
// This scope reads only the two verdicts and primary-key owners of bounded
// stored refusals. A position is never inferred from a matching account alone.
const protocolId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function hybridVolume(value) {
  const result = {}
  for (const field of VOLUME_FIELDS) {
    const v = value[field]
    if (['accountId', 'positionId', 'symbolId'].includes(field)) result[field] = protocolId(v)
    else if (field === 'source') result[field] = v === 'ordinary_enrolment_reads' ? v : null
    else if (field === 'units') result[field] = v === 'ctrader_protocol_volume' ? v : null
    else if (field === 'host') result[field] = ['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(v) ? v : null
    else if (field === 'side') result[field] = ['BUY', 'SELL'].includes(v) ? v : null
    else if (field.endsWith('Valid')) result[field] = typeof v === 'boolean' ? v : null
    else result[field] = typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  return result
}
function readHybridEvidence(db, now) {
  return db.transaction(() => {
    const verdicts = readHybridVerdicts(db)
    const pass = verdicts.momentum_partial_pass_json, deferred = pass.cappedHybrid?.deferred
    const out = { readAt: now, scope: 'hybrid', verdicts, refusals: {
      status: deferred?.rows ? 'observed' : 'unavailable', total: deferred?.total ?? null,
      truncated: deferred?.truncated ?? false, limit: CAP, rows: [],
    } }
    // Do not read another state value or any owner when no refusal exists.
    if (!deferred?.rows?.length) return out
    const raw = stored(db, 'momentum_partial_pass_json')?.cappedHybrid?.deferred
    if (!Array.isArray(raw) || raw.length !== deferred.total) throw Error('invalid_refusal_snapshot')
    const owner = db.prepare('SELECT id,account_id,ctrader_position_id FROM trades WHERE id=?')
    for (const [index, refusal] of raw.slice(0, CAP).entries()) {
      const v = object(refusal?.volumeInputs) ? refusal.volumeInputs : null
      const tradeId = Number.isSafeInteger(refusal?.tradeId) && refusal.tradeId > 0 ? refusal.tradeId : null
      const accountId = protocolId(refusal?.accountId), suppliedPosition = refusal?.positionId
      const positionId = protocolId(suppliedPosition ?? v?.positionId)
      const row = { index, passAt: pass.at, reason: deferred.rows[index].reason,
        tradeId, accountId, positionId, ownerStatus: 'refusal_identity_missing_or_invalid', owner: null,
        inputStatus: refusal?.volumeInputs == null ? 'not_recorded' : v ? 'identity_unverified' : 'malformed', inputs: null }
      const owned = tradeId === null ? null : owner.get(tradeId)
      if (tradeId !== null && !owned) row.ownerStatus = 'trade_missing'
      else if (owned && accountId && positionId) {
        const ownAccount = protocolId(owned.account_id), ownPosition = protocolId(owned.ctrader_position_id)
        if (!ownAccount || !ownPosition) row.ownerStatus = 'owner_identity_missing_or_invalid'
        else if (accountId !== ownAccount || positionId !== ownPosition
          || (suppliedPosition != null && protocolId(suppliedPosition) !== ownPosition)) row.ownerStatus = 'identity_conflict'
        else {
          row.ownerStatus = 'stored_owned_position'
          row.owner = { tradeId: owned.id, accountId: ownAccount, positionId: ownPosition }
          if (v) {
            const inputAccount = protocolId(v.accountId), inputPosition = protocolId(v.positionId)
            row.inputStatus = !inputAccount || !inputPosition ? 'identity_missing_or_invalid'
              : inputAccount !== ownAccount || inputPosition !== ownPosition ? 'identity_conflict' : 'stored_owned_observation'
            if (row.inputStatus === 'stored_owned_observation') {
              row.inputs = hybridVolume(v)
              row.invalidFields = VOLUME_FIELDS.filter(field => v[field] != null && row.inputs[field] === null)
            }
          }
        }
      }
      if (row.ownerStatus === 'identity_conflict' && v) row.inputStatus = 'identity_conflict'
      out.refusals.rows.push(row)
    }
    return out
  }).deferred()
}

export function readTargetedEvidence(db, now=Date.now(), tradeIds=[]) {
  if(!Array.isArray(tradeIds)||tradeIds.length>8||tradeIds.some(n=>!Number.isSafeInteger(n)||n<=0)) throw Error('invalid_targets')
  // The existing status index narrows to open trades; the new trade/kind index
  // retrieves each movement kind without walking thousands of observations.
  const owners=db.prepare(`SELECT id,account_id,ctrader_position_id,symbol,side,status FROM trades
    WHERE status='open' ORDER BY closed_at DESC,id DESC LIMIT ?`).all(CAP+1)
  const selected=[],missingTargets=[]
  // Codex · №12,439 · 2026-10-09; codex-footprint: retained-movement-targets.
  // Explicit primary-key targets remain readable if they naturally close
  // while the release gates run. Never search all closed-position history.
  for(const id of new Set(tradeIds)) {
    const row=owners.slice(0,CAP).find(r=>r.id===id) || db.prepare('SELECT id,account_id,ctrader_position_id,symbol,side,status FROM trades WHERE id=?').get(id)
    if(row) selected.push(row)
    // Codex · №12,692 · 2026-10-09; codex-footprint: explicit-missing-target.
    // Preserve the result of this primary-key read; absence is not an owned
    // position and must not disappear from the explicit operator request.
    else missingTargets.push({status:'unverified',source:'stored_rows_only',tradeId:id,reason:'trade_missing'})
  }
  // Requested targets get the finite output budget before the open population.
  for(const row of owners.slice(0,CAP)) if(!selected.some(r=>r.id===row.id)) selected.push(row)
  const pass=stored(db,'momentum_partial_pass_json'), protection=stored(db,'independent_protection_json')
  const out={readAt:now,limits:{openTrades:CAP,totalTradesBound:CAP+tradeIds.length,rowsPerMovementKind:PER_KIND,ownerOrder:'closed_at_desc_id_desc',targetTradeIds:tradeIds},truncatedTrades:owners.length>CAP,
    verdicts:readHybridVerdicts(db),missingTargets,trades:[]}
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
  setTimer=setTimeout,clearTimer=clearTimeout,fetchImpl=fetch}={}) {
  const tradeIds=targetIds(env.OWNED_EVIDENCE_TRADE_IDS)
  if(tradeIds===null)return null
  // Codex · №12,808 · 2026-10-10; codex-footprint: hybrid-verdict-only-read.
  const scope=env.OWNED_EVIDENCE_SCOPE,hybridOnly=scope==='hybrid'
  if(scope!=null&&!hybridOnly)return null
  if(hybridOnly&&(tradeIds.length||env.OWNED_EVIDENCE_SCANNER==='1'))return null
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
      if(n>16000||bytes+n>ceiling){dropped++;return false}
      bytes+=n;log(line);return true
    } catch { dropped++;return false }
  }
  try {
    if(db.prepare('INSERT OR IGNORE INTO agent_state(key,value) VALUES (?,?)')
      .run(`owned_evidence:${id}`,JSON.stringify({at:now(),tradeIds,...(hybridOnly?{scope}: {})})).changes!==1) return null
  } catch { emit('not-started',{reason:'durable_claim_failed'});return null }
  // A single delayed read gives ordinary enrolment a chance to persist inputs.
  // It never runs enrolment, submits an order, or repeats until a desired result.
  let hybridReadStarted=false
  const timer=setTimer(()=>{
    if(hybridOnly){if(hybridReadStarted)return;hybridReadStarted=true}
    if(now()>=expires){emit('exit',{reason:'deadline_expired',dropped});return}
    try {
      if(hybridOnly){
        const {verdicts,refusals,...metadata}=readHybridEvidence(db,now())
        const {rows,...bounds}=refusals
        emit('summary',{...metadata,refusals:bounds})
        for(const [key,value] of Object.entries(verdicts))emit('stored-verdict',{key,readAt:metadata.readAt,...value})
        for(const refusal of rows)emit('hybrid-refusal',refusal)
        emit('exit',{at:now(),done:dropped===0,dropped,bytes,...(dropped?{reason:'output_incomplete'}:{})})
        return
      }
      const {trades,missingTargets,...metadata}=readTargetedEvidence(db,now(),tradeIds)
      emit('summary',{...metadata,missingTargetIds:missingTargets.map(row=>row.tradeId)})
      // Requested missing records get their bounded verdict before population
      // detail can consume the output budget. No account identity is invented.
      for(const target of missingTargets) emit('initial-risk',{owner:null,...target})
      const emitTrade=trade=>{
        const {movements,initialRisk,...fields}=trade;emit('owned-position',fields)
        if(initialRisk) emit('initial-risk',{owner:trade.owner,...initialRisk})
        for(const group of movements) {
          const {rows,...bounds}=group;emit('movement-range',{owner:trade.owner,...bounds})
          for(const row of rows) emit('movement',{owner:trade.owner,row})
        }
      }
      // Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
      // Requested ownership evidence keeps priority. Scanner reads are a
      // separate opt-in, once-only projection before the remaining population.
      const requested=trades.filter(t=>tradeIds.includes(t.owner.id)),remaining=trades.filter(t=>!tradeIds.includes(t.owner.id))
      for(const trade of requested)emitTrade(trade)
      const finish=scanner=>{for(const trade of remaining)emitTrade(trade);emit('exit',{at:now(),done:true,dropped,bytes,...(scanner?{scanner}:{})})}
      if(env.OWNED_EVIDENCE_SCANNER!=='1'){finish();return}
      if(now()>=expires){emit('exit',{at:now(),done:false,reason:'deadline_expired',dropped,bytes});return}
      return readScannerEvidence(db,{now:now(),env,fetchImpl,expiresAtMs:expires,clock:now}).then(result=>{
        if(now()>=expires){emit('exit',{at:now(),done:false,reason:'deadline_expired',dropped,bytes});return}
        const scanner={status:result.summary.status,omittedRecords:result.summary.omittedRecords||0,emittedRecords:0,droppedRecords:0}
        if(emit('scanner-summary',result.summary))scanner.emittedRecords++;else scanner.droppedRecords++
        for(const row of result.records){if(emit(row.kind,row.value))scanner.emittedRecords++;else scanner.droppedRecords++}
        finish(scanner)
      }).catch(()=>{
        emit('scanner-summary',{status:'unavailable',reason:'scanner_read_failed',orderAuthority:false})
        finish({status:'unavailable',reason:'scanner_read_failed'})
      })
    } catch { emit('exit',{at:now(),done:false,reason:'stored_read_failed',dropped}) }
  },180000)
  timer?.unref?.()
  emit('scheduled',{at:now(),delayMs:180000,expires,brokerRequests:0,profiling:false,scannerRead:env.OWNED_EVIDENCE_SCANNER==='1',nativeReadLimit:env.OWNED_EVIDENCE_SCANNER==='1'?1:0,...(hybridOnly?{scope}:{})})
  return ()=>clearTimer(timer)
}
