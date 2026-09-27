import test from 'node:test'
import assert from 'node:assert/strict'
import { replayCostedExit } from './costed-exit-replay.js'

const H=3600000
const trade={side:'BUY',entry:100,originalStop:90,entryMs:0,volume:100,cashPerPriceFullVolume:10}
const costs={entryCommission:1,exitCommissionFull:1,minExitCommission:0,carryPerDayFull:24,slippagePrice:0,askSpreadPrice:0}
const bar=(t,o,h,l,c)=>({t,o,h,l,c})
const run=(bars,candidate={},extra={})=>replayCostedExit({bars,trade,costs,candidate:{kind:'fixed',target:120,...candidate},barMs:H,cutoff:10*H,...extra})
test('costed replay retains original risk and deducts commission and carry once',()=>{
 const r=run([bar(0,100,110,95,105),bar(H,105,121,104,120)])
 assert.equal(r.status,'closed');assert.equal(r.grossCash,200);assert.equal(r.commissionCash,2)
 assert.deepEqual(r.carryCashRange,[1,2]);assert.deepEqual(r.netCashRange,[196,197]);assert.equal(r.originalRiskCash,100)
 assert.equal(trade.volume,100);assert.equal(trade.originalStop,90)
})
test('a gap through a stop fills at the worse open, never magically at the stop',()=>{
 const r=run([bar(0,85,88,80,83)])
 assert.equal(r.fills[0].price,85);assert.equal(r.grossCash,-150)
})
test('simultaneous SL/TP touch is ambiguous and unfinished trades stay open',()=>{
 assert.equal(run([bar(0,100,125,85,110)]).status,'ambiguous')
 assert.equal(run([bar(0,100,110,95,105)]).status,'open_at_cutoff')
})
test('missing costs, wrong direction and pre-entry possible hit are refused',()=>{
 assert.equal(run([bar(0,100,121,99,120)],{}, {costs:{...costs,slippagePrice:undefined}}).status,'not_verifiable')
 assert.equal(run([],{}, {trade:{...trade,side:'OTHER'}}).status,'not_verifiable')
 assert.equal(run([bar(0,100,121,99,120)],{}, {trade:{...trade,entryMs:H/2}}).status,'ambiguous')
})
test('short liquidation uses the ask spread and adverse slippage explicitly',()=>{
 const r=run([bar(0,100,104,79,80)],{target:80},{trade:{...trade,side:'SELL',originalStop:110},costs:{...costs,askSpreadPrice:1,slippagePrice:.5}})
 assert.equal(r.fills[0].price,80.5);assert.equal(r.grossCash,195)
})
test('partial runner charges each exit minimum and keeps residual at original risk',()=>{
 const r=run([bar(0,100,131,99,130),bar(H,130,141,129,140)],{kind:'partial',trigger:130,target:140,closeFraction:.25},
  {costs:{...costs,minExitCommission:1}})
 assert.equal(r.status,'closed');assert.equal(r.fills.length,2);assert.equal(r.grossCash,375)
 assert.equal(r.commissionCash,3);assert.equal(r.closedFraction,1)
})
test('full V3 replay refuses missing management coverage instead of silently dropping ATR/rank exits',()=>{
 assert.equal(run([bar(0,100,110,99,105)],{requiresManagementHistory:true}).status,'not_verifiable')
})
