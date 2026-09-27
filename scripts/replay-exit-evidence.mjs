// Offline only. Usage: node scripts/replay-exit-evidence.mjs <private evidence directory> <output.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { replayCostedExit } from '../agent/lib/costed-exit-replay.js'
import { classifyClosingOrder } from '../agent/services/broker-exit-attribution.js'
const [directory, output]=process.argv.slice(2)
if(!directory||!output)throw Error('Evidence directory and output path required')
const read=name=>JSON.parse(readFileSync(resolve(directory,name+'.json'),'utf8'))
const history=read('broker_history'), analysis=read('analysis'), cocoa=read('cocoa_history')
const H=3600000,results=[]
for(const raw of history.rows){
 const row=analysis.rows.find(r=>r.tradeId===raw.tradeId), d=raw.closingDeal
 const expected={accountId:raw.accountId,positionId:raw.positionId,orderId:raw.orderId,dealId:raw.dealId,
   symbolId:String(d.symbolId),tradeSide:d.tradeSide,filledVolume:d.filledVolume,executionPrice:d.executionPrice,
   executionTimestamp:d.executionTimestamp,entryPrice:d.closePositionDetail.entryPrice}
 const attribution=classifyClosingOrder({ctidTraderAccountId:raw.accountId,order:raw.closingOrder,deal:[d]},expected)
 const bars=raw.tradeId===1717?cocoa.bars:raw.bars
 const valuePerPrice=row.gross/((row.side==='BUY'?1:-1)*(row.exit-row.entry))
 const actualHours=(row.exitMs-row.entryMs)/H
 const input={bars,barMs:H,cutoff:history.cutoff,trade:{side:row.side,entry:row.entry,originalStop:row.originalSL,
   entryMs:row.entryMs,volume:row.volume,cashPerPriceFullVolume:valuePerPrice}}
 const scenarios=[]
 // This fixed scenario set is sensitivity analysis, not parameter search.
 // Costs are retrospective proxies from the same trade, not information known at entry.
 for(const surchargeR of [0,.02]){
   const totalCommission=Math.abs(row.brokerCommission)
   const costs={entryCommission:totalCommission/2,exitCommissionFull:totalCommission/2,
     minExitCommission:totalCommission/2,carryPerDayFull:-row.swap/(actualHours/24),
     slippagePrice:surchargeR*row.originalRisk,askSpreadPrice:0}
   const label=surchargeR===0?'observed_cost_proxy_no_extra_slippage':'observed_cost_proxy_plus_0.02R_per_exit'
   if(row.strategy==='tsmom_long'){
     const costReserve=(Math.max(0,-row.swap)+totalCommission)/valuePerPrice+costs.slippagePrice
     const target=row.entry+3*row.originalRisk+costReserve
     const candidate={kind:'fixed',target}
     scenarios.push({label,candidate:'3R_plus_observed_cost_threshold_original_stop',costModel:costs,
       target,costReservePrice:costReserve,...replayCostedExit({...input,costs,candidate})})
   }
   if(row.strategy==='cup_handle')scenarios.push({label,candidate:'1R_end_of_H1_trail_after_1R_original_target',costModel:costs,
     ...replayCostedExit({...input,costs,candidate:{kind:'trail',trailR:1,activationR:1,target:row.originalTP}})})
 }
 results.push({tradeId:row.tradeId,accountId:row.accountId,symbol:row.symbol,currency:row.currency,
   channel:row.channel,strategy:row.strategy,baselineNet:row.net,originalRisk:row.originalRisk,originalVolume:row.volume,
   previousReason:row.localReason,attribution,scenarios})
}
const out={version:1,createdAt:new Date().toISOString(),cutoff:history.cutoff,
 methodology:{mode:'OFFLINE_RETROSPECTIVE_SENSITIVITY',sourceHash:createHash('sha256').update(readFileSync(resolve(directory,'broker_history.json'))).digest('hex'),
   invariant:'Same entry, original stop risk and volume. No trading or policy activation.',
   limits:['Observed swaps are prorated by elapsed calendar time, not historical rollover schedules.',
     'Observed round-trip commission is split equally across entry and exit; this is a scenario assumption.',
     'The 0 and 0.02R execution surcharges are sensitivity bounds, not observed future fills.',
     'Currency conversion is held at the actual close conversion; future conversion is unknown.',
     '3R scenario isolates target geometry with the original stop; it is NOT the full ATR/rank V3 manager.',
     'Full V3 net replay remains Not Verifiable without the management state, historical costs and broker volume metadata.',
     'The trail is one frozen H1 end-of-bar rule; it does not reconstruct historical tick controllers.',
     'Open and ambiguous outcomes are not assigned zero net or included in a misleading closed-only PF.']},results}
writeFileSync(resolve(output),JSON.stringify(out,null,2)+'\n')
const counts={}
for(const r of results)for(const s of r.scenarios){const k=s.candidate+'|'+s.label;counts[k]??={};counts[k][s.status]=(counts[k][s.status]||0)+1}
console.log(JSON.stringify({trades:results.length,attribution:results.reduce((a,r)=>{a[r.attribution.cause??r.attribution.reason]=(a[r.attribution.cause??r.attribution.reason]||0)+1;return a},{}),scenarios:counts,coin:results.filter(r=>r.strategy==='cup_handle').map(r=>({id:r.tradeId,baseline:r.baselineNet,scenarios:r.scenarios.map(s=>({label:s.label,status:s.status,net:s.netCashRange,reason:s.reason}))}))},null,2))
