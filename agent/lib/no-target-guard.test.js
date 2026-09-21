// No strategy may waive the owner's mandatory broker-native TP1 invariant.
// The shared Node boundary and the autoTrade wiring are pinned here; the C++
// mirror has its own executable guard test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateOrderBracket } from './exec-engine.js'

test('allowNoTarget and allowNaked cannot waive mandatory TP1', () => {
  const base = { orderType: 'MARKET', tradeSide: 'BUY', volume: 100, relativeStopLoss: 500 }
  assert.match(validateOrderBracket(base).reason, /^guard_no_target/)
  assert.match(validateOrderBracket({ ...base, allowNoTarget: true }).reason, /^guard_no_target/)
  assert.match(validateOrderBracket({ orderType: 'MARKET', allowNoTarget: true }).reason, /^guard_naked_order/, 'no stop is still refused')
  assert.match(validateOrderBracket({ orderType: 'MARKET', allowNaked: true }).reason, /^guard_no_target/, 'a stop waiver is not a target waiver')
  assert.deepEqual(validateOrderBracket({ orderType: 'MARKET', allowNaked: true, relativeTakeProfit: 500 }), { ok: true })
  assert.match(validateOrderBracket({ ...base, orderType: 'LIMIT' }).reason, /^guard_no_target/, 'resting entries can fill and require TP1')
  assert.match(validateOrderBracket({ ...base, allowNoTarget: 'yes' }).reason, /^guard_no_target/, 'no value waives TP1')
})

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('loop.js: autoTrade resolves the symbol id per account and carries no target waiver', () => {
  const src = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const start = src.indexOf('export async function autoTrade(')
  const end = src.indexOf('\nexport ', start + 1)
  const body = src.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.ok(body.includes('await resolveSymbolId(db, {'), 'autoTrade resolves through resolveSymbolId with this account\'s creds')
  assert.ok(!body.includes("getState(db, 'symbol_id_map')"), 'autoTrade never reads the shared map directly')
  assert.ok(!body.includes('allowNoTarget'), 'autoTrade must carry no target waiver')
  assert.ok(!body.includes('allowNaked'), 'autoTrade must carry no target waiver through the C++ escape hatch')
  assert.ok(src.includes('symbolIdFor: async (creds, symbol) =>'), 'the book is handed a per-account resolver')
})

test('closed-market-limits.js resolves the id per account too', () => {
  const src = strip(readFileSync(new URL('../services/closed-market-limits.js', import.meta.url), 'utf8'))
  assert.ok(src.includes('await resolveSymbolId(db, creds, symbol'))
  assert.ok(!src.includes("getState(db, 'symbol_id_map')"))
})
