// Offline scenario engine. Inputs are explicit; this module never sizes or trades.
const finite=n=>typeof n==='number'&&Number.isFinite(n)
const positive=n=>finite(n)&&n>0
export function replayCostedExit({bars,trade,candidate={},costs,barMs,cutoff}={}) {
  const refuse=reason=>({status:'not_verifiable',reason})
  if (!['BUY','SELL'].includes(trade?.side)||![trade.entry,trade.originalStop,trade.volume,trade.cashPerPriceFullVolume,barMs].every(positive)
    || !finite(trade.entryMs)||!finite(cutoff)||cutoff<=trade.entryMs) return refuse('original_risk_size_direction_and_window_required')
  if (!costs||!['entryCommission','exitCommissionFull','minExitCommission','slippagePrice','askSpreadPrice'].every(k=>finite(costs[k])&&costs[k]>=0)
    || !finite(costs.carryPerDayFull)) return refuse('explicit_cost_model_required')
  const dir=trade.side==='BUY'?1:-1,risk=dir*(trade.entry-trade.originalStop)
  if (!(risk>0)) return refuse('original_stop_wrong_side')
  if (candidate.requiresManagementHistory && !(candidate.managementCoverageThroughMs>=cutoff)) return refuse('ATR_rank_management_history_incomplete')
  if (!['fixed','trail','partial'].includes(candidate.kind)) return refuse('candidate_kind_required')
  if (candidate.target!=null && (!positive(candidate.target)||dir*(candidate.target-trade.entry)<=0)) return refuse('target_wrong_side')
  if (candidate.kind==='partial' && (!positive(candidate.trigger)||dir*(candidate.trigger-trade.entry)<=0
    || !positive(candidate.closeFraction)||candidate.closeFraction>=1||!positive(candidate.target)
    || dir*(candidate.target-candidate.trigger)<=0)) return refuse('partial_plan_required')
  if (candidate.kind==='trail' && (!positive(candidate.trailR)||!finite(candidate.activationR)||candidate.activationR<0)) return refuse('trail_rule_required')
  if (!Array.isArray(bars)||!bars.length) return refuse('bars_required')
  let last=-Infinity
  for(const b of bars){
    if(!b||![b.t,b.o,b.h,b.l,b.c].every(finite)||b.t<=last||b.l<=0||b.l>Math.min(b.o,b.c)||b.h<Math.max(b.o,b.c)) return refuse('invalid_or_unordered_bars')
    last=b.t
  }
  const fills=[];let remaining=1,stop=trade.originalStop,peak=trade.entry,commission=costs.entryCommission,carryLow=0,carryHigh=0,gross=0,previous=trade.entryMs,used=0
  const carry=(untilLow,untilHigh,fraction)=>{
    const a=costs.carryPerDayFull*fraction*Math.max(0,untilLow-previous)/86400000
    const b=costs.carryPerDayFull*fraction*Math.max(0,untilHigh-previous)/86400000
    carryLow+=Math.min(a,b);carryHigh+=Math.max(a,b)
  }
  const fill=(price,lo,hi,fraction,reason)=>{
    const execution=price-dir*costs.slippagePrice
    gross+=dir*(execution-trade.entry)*trade.cashPerPriceFullVolume*fraction
    commission+=Math.max(costs.minExitCommission,costs.exitCommissionFull*fraction)
    carry(lo,hi,fraction)
    fills.push({price:execution,fraction,reason,earliestMs:lo,latestMs:hi})
    remaining-=fraction
  }
  const result=(status,reason)=>({status,reason,fills,originalRiskPrice:risk,originalRiskCash:risk*trade.cashPerPriceFullVolume,
    originalVolume:trade.volume,closedFraction:1-remaining,barsUsed:used,grossCash:gross,commissionCash:commission,
    carryCashRange:[carryLow,carryHigh],netCashRange:status==='closed'?[gross-commission-carryHigh,gross-commission-carryLow]:null})
  for(const raw of bars){
    if(raw.t+barMs<=trade.entryMs||raw.t+barMs>cutoff) continue
    const spread=dir===-1?costs.askSpreadPrice:0
    const b={t:raw.t,o:raw.o+spread,h:raw.h+spread,l:raw.l+spread,c:raw.c+spread}
    const target=candidate.kind==='partial'&&fills.length===0?candidate.trigger:candidate.target
    const hitStop=dir===1?b.l<=stop:b.h>=stop
    const hitTarget=target!=null&&(dir===1?b.h>=target:b.l<=target)
    if(b.t<trade.entryMs){
      const couldArmTrail=candidate.kind==='trail'&&dir*((dir===1?b.h:b.l)-trade.entry)/risk>=candidate.activationR
      if(hitStop||hitTarget||couldArmTrail)return result('ambiguous','entry_hour_path_unknown')
      continue
    }
    used++
    // Gaps are known before either intrabar extreme. A favourable target gap
    // receives only the target, avoiding optimistic price improvement.
    const gapStop=dir===1?b.o<=stop:b.o>=stop
    const gapTarget=target!=null&&(dir===1?b.o>=target:b.o<=target)
    if(gapStop){fill(b.o,b.t,b.t,remaining,'stop_gap');return result('closed','stop_gap')}
    if(hitStop&&hitTarget&&!gapTarget)return result('ambiguous','same_bar_stop_and_target')
    if(hitTarget){
      if(candidate.kind==='partial'&&fills.length===0){
        if(hitStop || (dir===1?b.h>=candidate.target:b.l<=candidate.target))return result('ambiguous','partial_and_another_exit_in_same_bar')
        fill(target,b.t,b.t+barMs,candidate.closeFraction,'partial')
      }else{fill(target,b.t,b.t+barMs,remaining,'target');return result('closed','target')}
    }
    if(hitStop){fill(stop,b.t,b.t+barMs,remaining,'stop');return result('closed','stop')}
    // A discrete, end-of-bar trail candidate, not a reconstruction of live ticks.
    if(candidate.kind==='trail'){
      peak=dir===1?Math.max(peak,b.h):Math.min(peak,b.l)
      if(dir*(peak-trade.entry)/risk>=candidate.activationR){const next=peak-dir*candidate.trailR*risk;stop=dir===1?Math.max(stop,next):Math.min(stop,next)}
    }
    // Optional pre-recorded management updates activate only at their timestamp.
    for(const u of candidate.stopUpdates??[])if(u.at>=b.t&&u.at<b.t+barMs&&positive(u.stop))stop=dir===1?Math.max(stop,u.stop):Math.min(stop,u.stop)
    const forced=(candidate.forceExits??[]).find(x=>x.at>=b.t&&x.at<b.t+barMs)
    if(forced)return result('not_verifiable','intrabar_management_fill_requires_ticks')
  }
  // No fabricated liquidation, winning trade or net PF from an open residual.
  return result('open_at_cutoff','remaining_exposure_not_liquidated')
}
