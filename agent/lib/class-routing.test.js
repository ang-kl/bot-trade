// Claude · № 15,144 16-Oct (owner: "B priorities class … C·2 build class-aware
// routing" after § 15,128; claude-builder). node --test agent/lib/class-routing.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseToken, compilePolicy, loadClassRouting, isRouted, classPriority, _resetClassRoutingForTests, CLASS_ROUTING_FILE } from './class-routing.js'
import { STRATEGY_KEYS } from '../services/strategies.js'

test('token grammar: strategy, strategy:side, *:side; anything else is malformed', () => {
  assert.deepEqual(parseToken('va_breakout:long'), { strategy: 'va_breakout', side: 'long' })
  assert.deepEqual(parseToken('RSI_MEANREV:Short'), { strategy: 'rsi_meanrev', side: 'short' })
  assert.deepEqual(parseToken('rsi2_reversion'), { strategy: 'rsi2_reversion', side: null })
  assert.deepEqual(parseToken('*:long'), { strategy: '*', side: 'long' })
  for (const bad of ['', ':long', 'va_breakout:', 'va breakout:long', 'va_breakout:buy', '*:*', '42', '_x', null, 42]) assert.equal(parseToken(bad), null, String(bad))
})

test('compilePolicy: priorities default to 9, malformed tokens and unknown strategies are reported, never silently dropped or guessed', () => {
  const p = compilePolicy({
    enabled: true,
    scanShare: { prioritySlots: 8, priorityMaxRank: 3 },
    classes: { Energy: { priority: 5, block: ['va_breakout:long', 'nonsense token', 'cup_handel:long'] }, crypto: { priority: 1 }, other: { block: 'not-a-list' } },
    symbols: { natgas: { block: ['*:long'] } },
  }, { knownStrategies: STRATEGY_KEYS })
  assert.equal(p.enabled, true)
  assert.deepEqual(p.scanShare, { prioritySlots: 8, priorityMaxRank: 3 })
  assert.equal(p.classes.energy.priority, 5)
  assert.deepEqual(p.classes.energy.block.map(t => t.token), ['va_breakout:long', 'cup_handel:long'])
  assert.equal(p.classes.crypto.priority, 1)
  assert.deepEqual(p.classes.crypto.block, [])
  assert.equal(p.classes.other.priority, 9)
  assert.deepEqual(p.symbols.NATGAS.block.map(t => t.token), ['*:long'])
  assert.equal(p.warnings.length, 3, p.warnings.join('\n'))
  assert.match(p.warnings.join('\n'), /malformed token "nonsense token"/)
  assert.match(p.warnings.join('\n'), /unknown strategy "cup_handel"/)
  assert.match(p.warnings.join('\n'), /other\.block is not an array/)
  // The real registry raises no warning for the real file's tokens.
  assert.ok(STRATEGY_KEYS.includes('va_breakout') && STRATEGY_KEYS.includes('rsi_meanrev') && STRATEGY_KEYS.includes('rsi2_reversion'))
})

test('compilePolicy: a bad scanShare turns the share off with a warning; a non-object file turns the policy off with a reason', () => {
  const p = compilePolicy({ scanShare: { prioritySlots: 0, priorityMaxRank: 3 }, classes: {} })
  assert.equal(p.scanShare, null)
  assert.match(p.warnings[0], /scanShare/)
  assert.equal(p.enabled, true)
  for (const bad of [null, [], 'x', 7]) {
    const off = compilePolicy(bad)
    assert.equal(off.enabled, false); assert.match(off.reason, /not an object/)
  }
  assert.equal(compilePolicy({ enabled: false, classes: {} }).enabled, false)
})

test('isRouted: the symbol token beats the class token, a side-less token blocks both sides, an unlisted class or an off policy routes nothing', () => {
  const p = compilePolicy({
    classes: { energy: { block: ['va_breakout:long'] }, equity: { block: ['rsi_meanrev'] } },
    symbols: { NATGAS: { block: ['*:long'] } },
  })
  const r1 = isRouted(p, { cls: 'energy', symbol: 'SPOTCRUDE', strategy: 'va_breakout', bias: 'long' })
  assert.equal(r1.ok, false); assert.equal(r1.token, 'va_breakout:long'); assert.equal(r1.source, 'class energy')
  assert.match(r1.reason, /va_breakout long routed out of class energy by class-routing\.json token "va_breakout:long"/)
  assert.deepEqual(isRouted(p, { cls: 'energy', symbol: 'SPOTCRUDE', strategy: 'va_breakout', bias: 'short' }), { ok: true, reason: null })
  assert.deepEqual(isRouted(p, { cls: 'energy', symbol: 'SPOTCRUDE', strategy: 'donchian_breakout', bias: 'long' }), { ok: true, reason: null })
  const r2 = isRouted(p, { cls: 'energy', symbol: 'natgas', strategy: 'donchian_breakout', bias: 'long' })
  assert.equal(r2.ok, false); assert.equal(r2.source, 'symbol NATGAS'); assert.equal(r2.token, '*:long')
  assert.equal(isRouted(p, { cls: 'energy', symbol: 'NATGAS', strategy: 'donchian_breakout', bias: 'short' }).ok, true)
  assert.equal(isRouted(p, { cls: 'equity', symbol: 'AAPL.US', strategy: 'rsi_meanrev', bias: 'long' }).ok, false)
  assert.equal(isRouted(p, { cls: 'equity', symbol: 'AAPL.US', strategy: 'rsi_meanrev', bias: 'short' }).ok, false)
  assert.equal(isRouted(p, { cls: 'fx', symbol: 'EURUSD', strategy: 'va_breakout', bias: 'long' }).ok, true, 'unlisted class')
  assert.equal(isRouted(p, { cls: undefined, symbol: 'X', strategy: 'va_breakout', bias: 'long' }).ok, true)
  assert.equal(isRouted({ ...p, enabled: false }, { cls: 'energy', symbol: 'NATGAS', strategy: 'va_breakout', bias: 'long' }).ok, true, 'off')
  assert.equal(isRouted(null, { cls: 'energy', symbol: 'NATGAS', strategy: 'va_breakout', bias: 'long' }).ok, true, 'no policy')
  assert.equal(classPriority(p, 'energy'), 9, 'no priority given → 9')
  assert.equal(classPriority(compilePolicy({ classes: { crypto: { priority: 1 } } }), 'CRYPTO'), 1)
  assert.equal(classPriority(null, 'crypto'), 9)
})

test('the checked-in file: the owner\'s four blocks and the 8-of-15 share, exactly (owner answers after № 15,144), no warnings against the registry', () => {
  _resetClassRoutingForTests()
  const p = loadClassRouting({ knownStrategies: STRATEGY_KEYS })
  assert.equal(p.enabled, true)
  assert.equal(p.source, 'file')
  assert.equal(p.file, CLASS_ROUTING_FILE)
  assert.deepEqual(p.warnings, [])
  assert.deepEqual(p.scanShare, { prioritySlots: 8, priorityMaxRank: 3 })
  const blocks = Object.fromEntries(Object.entries(p.classes).filter(([, c]) => c.block.length).map(([k, c]) => [k, c.block.map(t => t.token)]))
  assert.deepEqual(blocks, { equity: ['rsi_meanrev:short', 'rsi2_reversion:long'], energy: ['va_breakout:long'] })
  assert.deepEqual(Object.fromEntries(Object.entries(p.symbols).map(([k, c]) => [k, c.block.map(t => t.token)])), { NATGAS: ['*:long'] })
  // Tier A (priority ≤ 3) is crypto, index, fx, metal — the owner's "profitable classes first".
  const tierA = Object.entries(p.classes).filter(([, c]) => c.priority <= 3).map(([k]) => k).sort()
  assert.deepEqual(tierA, ['crypto', 'fx', 'index', 'metal'])
  assert.equal(p.classes.crypto.priority, 1)
  assert.equal(p.classes.equity.priority, 5)
  assert.equal(p.classes.energy.priority, 5)
})

test('loadClassRouting: an unreadable file is OFF with its reason; the memo re-reads when the file changes', () => {
  _resetClassRoutingForTests()
  const off = loadClassRouting({ file: '/nonexistent/class-routing.json' })
  assert.equal(off.enabled, false); assert.match(off.reason, /unreadable/); assert.equal(off.source, 'unavailable')
  const dir = mkdtempSync(join(tmpdir(), 'class-routing-'))
  try {
    const file = join(dir, 'class-routing.json')
    writeFileSync(file, JSON.stringify({ classes: { energy: { priority: 5, block: ['va_breakout:long'] } } }))
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    const t0 = 1_800_000_000_000
    const p1 = loadClassRouting({ file, now: t0 })
    assert.equal(p1.classes.energy.block.length, 1)
    writeFileSync(file, JSON.stringify({ classes: { energy: { priority: 5, block: [] } } }))
    utimesSync(file, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
    assert.equal(loadClassRouting({ file, now: t0 + 1_000 }), p1, 'within the minute the memo answers')
    const p2 = loadClassRouting({ file, now: t0 + 61_000 })
    assert.notEqual(p2, p1)
    assert.equal(p2.classes.energy.block.length, 0, 'the changed file is read after the check interval')
    writeFileSync(file, '{broken')
    utimesSync(file, new Date(1_700_000_200_000), new Date(1_700_000_200_000))
    const p3 = loadClassRouting({ file, now: t0 + 122_000 })
    assert.equal(p3.enabled, false); assert.match(p3.reason, /unreadable/)
  } finally { rmSync(dir, { recursive: true, force: true }); _resetClassRoutingForTests() }
})

test('the memo is keyed by validation context: the scanner\'s key-less load never hides the view\'s unknown-strategy warnings (Codex round 1 on #1390)', () => {
  _resetClassRoutingForTests()
  const dir = mkdtempSync(join(tmpdir(), 'class-routing-ctx-'))
  try {
    const file = join(dir, 'class-routing.json')
    writeFileSync(file, JSON.stringify({ classes: { energy: { priority: 5, block: ['cup_handel:long'] } } }))
    const t0 = 1_800_000_000_000
    const scanner = loadClassRouting({ file, now: t0 })
    assert.deepEqual(scanner.warnings, [], 'no registry handed in → nothing to warn against')
    const view = loadClassRouting({ file, knownStrategies: STRATEGY_KEYS, now: t0 + 1_000 })
    assert.equal(view.warnings.length, 1)
    assert.match(view.warnings[0], /unknown strategy "cup_handel"/)
    assert.equal(loadClassRouting({ file, now: t0 + 2_000 }), scanner, 'each context keeps its own memo')
    assert.equal(loadClassRouting({ file, knownStrategies: STRATEGY_KEYS, now: t0 + 3_000 }), view)
  } finally { rmSync(dir, { recursive: true, force: true }); _resetClassRoutingForTests() }
})
