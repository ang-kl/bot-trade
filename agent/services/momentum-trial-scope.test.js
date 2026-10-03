// node --test agent/services/momentum-trial-scope.test.js
//
// §6 (owner-approved 03-10-2026, № 10,777·B·4): the momentum trial's scope —
// which accounts, strategies and symbols are in the momentum trial / book —
// is unchanged by a PR unless the PR says so. The scope is read from the
// repo's own declarations (momentum-account.json, momentum-entries.json,
// strategy-pins.json, global-strategies.json, momentum-book.json,
// momentum-universe.json and the strategy registry) and compared with the
// committed snapshot beside this file. A widening or a narrowing fails here
// by name; the fix is to regenerate the snapshot DELIBERATELY, with the
// owner's yes, and to say so in the PR body.
import test from 'node:test'
import assert from 'node:assert/strict'
import { momentumTrialScope, readSnapshot, SNAPSHOT_URL } from './momentum-trial-scope.js'

/** Every leaf path whose value differs, so the failure names what moved. */
export function scopeDiff(expected, actual, path = '') {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(expected) && isObj(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    return [...keys].sort().flatMap(k => scopeDiff(expected[k], actual[k], path ? `${path}.${k}` : k))
  }
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  return same ? [] : [`${path || '(root)'}: snapshot ${JSON.stringify(expected)} → repo ${JSON.stringify(actual)}`]
}

const HOW_TO_FIX = [
  'The momentum trial scope in the repo differs from the committed snapshot',
  `(${SNAPSHOT_URL.pathname}).`,
  'If the change is DELIBERATE and the owner approved widening or narrowing the trial,',
  'regenerate the snapshot with `node agent/services/momentum-trial-scope.js --write`',
  'and name the change in the PR body. If it is not deliberate, this PR silently',
  'changed who or what the momentum trial reaches — revert that change.',
].join(' ')

test('§6 gate: the momentum trial scope (accounts, strategies, symbols) matches the committed snapshot', () => {
  const diff = scopeDiff(readSnapshot(), momentumTrialScope())
  assert.deepEqual(diff, [], `${HOW_TO_FIX}\n\nWhat moved:\n  ${diff.join('\n  ')}`)
})

test('§6 shape: the scope names accounts, strategies, the book switch and symbols, and the snapshot is complete', () => {
  const scope = momentumTrialScope()
  assert.deepEqual(Object.keys(scope).sort(), ['accounts', 'book', 'strategies', 'symbols'])
  assert.ok(Array.isArray(scope.accounts.planAccounts))
  assert.ok(scope.strategies.momentumKeys.includes('tsmom_long'), 'the registry has the momentum family strategy')
  assert.ok(Object.keys(scope.symbols).length >= 1, 'the universe has at least one symbol group')
  for (const [group, list] of Object.entries(scope.symbols)) {
    assert.ok(list.length >= 1, `universe group ${group} is empty`)
    assert.deepEqual(list, [...list].sort(), `${group} is sorted (order-blind comparison)`)
  }
  assert.deepEqual(Object.keys(readSnapshot()).sort(), ['accounts', 'book', 'strategies', 'symbols'])
})

test('§6 the diff names a widened account list, a dropped symbol and a flipped switch — the gate can go red', () => {
  const snap = readSnapshot()
  const widened = structuredClone(snap)
  widened.accounts.planAccounts.push('99999999')
  const d1 = scopeDiff(snap, widened)
  assert.equal(d1.length, 1)
  assert.match(d1[0], /^accounts\.planAccounts: /)

  const narrowed = structuredClone(snap)
  const group = Object.keys(narrowed.symbols)[0]
  narrowed.symbols[group] = narrowed.symbols[group].slice(1)
  assert.match(scopeDiff(snap, narrowed)[0], new RegExp(`^symbols\\.${group}: `))

  const off = structuredClone(snap)
  off.book.enabled = !off.book.enabled
  assert.deepEqual(scopeDiff(snap, off), [`book.enabled: snapshot ${snap.book.enabled} → repo ${!snap.book.enabled}`])

  const strategies = structuredClone(snap)
  strategies.strategies.momentumKeys.push('tsmom_short')
  assert.match(scopeDiff(snap, strategies)[0], /^strategies\.momentumKeys: /)

  assert.deepEqual(scopeDiff(snap, structuredClone(snap)), [], 'identical scopes diff to nothing')
})
