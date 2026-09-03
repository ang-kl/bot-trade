// 03-09-2026: the momentum book's first pass on the one open market (BTCUSD)
// was approved on two demo accounts and then refused post-approval with
// `order_ambiguous: guard_no_target` — the market-order guard rejected the
// book's STATED no-target bracket. allowNoTarget waives only the target
// check; the stop guard still holds. The loop wiring that sets it, and the
// per-account symbol resolution on the same path, are pinned on source with
// comments stripped (failure mode #2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateOrderBracket } from './exec-engine.js'

test('allowNoTarget waives the target guard only; the stop guard and allowNaked keep their meaning', () => {
  const base = { orderType: 'MARKET', tradeSide: 'BUY', volume: 100, relativeStopLoss: 500 }
  assert.match(validateOrderBracket(base).reason, /^guard_no_target/)
  assert.deepEqual(validateOrderBracket({ ...base, allowNoTarget: true }), { ok: true })
  assert.match(validateOrderBracket({ orderType: 'MARKET', allowNoTarget: true }).reason, /^guard_naked_order/, 'no stop is still refused')
  assert.deepEqual(validateOrderBracket({ orderType: 'MARKET', allowNaked: true }), { ok: true })
  assert.deepEqual(validateOrderBracket({ ...base, orderType: 'LIMIT' }), { ok: true }, 'limits were never guarded here')
  assert.match(validateOrderBracket({ ...base, allowNoTarget: 'yes' }).reason, /^guard_no_target/, 'only the literal true waives it')
})

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('loop.js: autoTrade resolves the symbol id PER ACCOUNT and states allowNoTarget for a noTarget synth; the book gets symbolIdFor', () => {
  const src = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const start = src.indexOf('export async function autoTrade(')
  const end = src.indexOf('\nexport ', start + 1)
  const body = src.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.ok(body.includes('await resolveSymbolId(db, {'), 'autoTrade resolves through resolveSymbolId with this account\'s creds')
  assert.ok(!body.includes("getState(db, 'symbol_id_map')"), 'autoTrade never reads the shared map directly')
  // Both flags, and only with a stop attached: Node's exec-engine reads
  // allowNoTarget; the C++ sidecar's order_guard knows only allowNaked and
  // refused every book market order on 03-09-2026 with the Node-only flag.
  assert.ok(body.includes('synth.noTarget === true && !tpDistance && slDistance > 0 ? { allowNoTarget: true, allowNaked: true }'), 'the stated no-target bracket sets allowNoTarget AND allowNaked, gated on a stop being attached')
  assert.ok(src.includes('symbolIdFor: async (creds, symbol) =>'), 'the book is handed a per-account resolver')
})

test('closed-market-limits.js resolves the id per account too', () => {
  const src = strip(readFileSync(new URL('../services/closed-market-limits.js', import.meta.url), 'utf8'))
  assert.ok(src.includes('await resolveSymbolId(db, creds, symbol'))
  assert.ok(!src.includes("getState(db, 'symbol_id_map')"))
})
