// agent/services/entry-mode-gateway.test.js — PR-G: the post-switch gateway
// binding the human route and the bot's pass share (guard push, VPO disarm,
// BLOCKED on a failed push), with the sidecar replaced by injected deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, markEntryModeBlocked } from './entry-mode.js'
import { bindEntryModeGateway } from './entry-mode-gateway.js'

const ACCT = '46130058'
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: ACCT, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  return db
}
function deps(over = {}) {
  const calls = { sync: [], disarm: [], blocked: [] }
  const d = {
    execMod: { tag: 'exec' },
    execBaseFor: (c) => `base:${c.who}`,
    sideForAccount: () => ({ name: 'side_a', isLive: false }),
    sideCreds: async () => ({ ready: true, who: 'side' }),
    credsForAccountId: () => ({ ready: true, who: 'acct' }),
    syncExecGuard: async (db, exec, side, opts) => { calls.sync.push({ side: side.name, force: opts.force, creds: opts.creds.who }); return { pushed: true, acked: [ACCT] } },
    pushVpoDisarm: async (db, id, base, opts) => { calls.disarm.push({ id, base, ...opts }); return { ok: true } },
    markEntryModeBlocked: (db, id, reason) => { calls.blocked.push(reason); return markEntryModeBlocked(db, id, reason) },
    ...over,
  }
  return { d, calls }
}

test('a successful push binds the guard with force and disarms the VPO tier for a non-TIME_BASED mode, using the account\'s own credentials', async () => {
  const db = fresh()
  const r = requestEntryMode(db, ACCT, 'STOPPED')
  const { d, calls } = deps()
  const out = await bindEntryModeGateway(db, ACCT, 'STOPPED', { epoch: r.status.modeEpoch, deps: d })
  assert.equal(out.gateway.pushed, true); assert.equal(out.gateway.side, 'side_a'); assert.deepEqual(out.gateway.acked, [ACCT])
  assert.deepEqual(calls.sync, [{ side: 'side_a', force: true, creds: 'side' }])
  assert.deepEqual(calls.disarm, [{ id: ACCT, base: 'base:acct', reason: 'entry_mode STOPPED', epoch: r.status.modeEpoch }])
  assert.deepEqual(calls.blocked, [])
  assert.equal(out.status.transitionState, 'STABLE')
})

test('TIME_BASED pushes the guard but never disarms the VPO tier; a failed push marks the account BLOCKED with entries stopped', async () => {
  const db = fresh()
  const r = requestEntryMode(db, ACCT, 'TIME_BASED')
  assert.equal(r.status.transitionState, 'WARMING')
  const ok = deps()
  await bindEntryModeGateway(db, ACCT, 'TIME_BASED', { epoch: r.status.modeEpoch, deps: ok.d })
  assert.deepEqual(ok.calls.disarm, [], 'time-based keeps the VPO arming')
  const failing = deps({ syncExecGuard: async () => ({ pushed: false, error: 'sidecar 502' }) })
  const out = await bindEntryModeGateway(db, ACCT, 'TIME_BASED', { epoch: r.status.modeEpoch, deps: failing.d })
  assert.equal(out.gateway.pushed, false); assert.equal(out.gateway.error, 'sidecar 502')
  assert.deepEqual(failing.calls.blocked, ['sidecar 502'])
  assert.equal(out.status.transitionState, 'BLOCKED'); assert.equal(out.status.effectiveEntryMode, 'STOPPED')
  assert.equal(engineStatusFor(db, ACCT).transitionState, 'BLOCKED', 'the record itself is BLOCKED, not only the reply')
})

test('no side or no ready credentials → BLOCKED with the reason; a throwing dep is reported, never thrown', async () => {
  const db = fresh()
  const r = requestEntryMode(db, ACCT, 'TIME_BASED')
  const none = deps({ sideCreds: async () => ({ ready: false }) })
  const out = await bindEntryModeGateway(db, ACCT, 'TIME_BASED', { epoch: r.status.modeEpoch, deps: none.d })
  assert.equal(out.gateway.pushed, false); assert.match(out.gateway.error, /no credentials/)
  assert.equal(out.status.transitionState, 'BLOCKED')
  const boom = deps({ sideForAccount: () => { throw new Error('registry gone') } })
  const thrown = await bindEntryModeGateway(db, ACCT, 'TIME_BASED', { epoch: 1, deps: boom.d })
  assert.equal(thrown.gateway.pushed, false); assert.equal(thrown.gateway.error, 'registry gone')
})

test('pin: the human route binds through bindEntryModeGateway and no longer inlines the push; the bot\'s pass binds through it too', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const route = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  const start = route.indexOf("router.post('/entry-mode'")
  const end = route.indexOf("router.post('/tick-observation'")
  assert.ok(start > 0 && end > start)
  const body = route.slice(start, end)
  assert.match(body, /bindEntryModeGateway\(db, String\(accountId\), mode, \{ epoch: r\.status\.modeEpoch \}\)/)
  assert.doesNotMatch(body, /syncExecGuard\(|pushVpoDisarm\(/, 'the push is not duplicated in the route')
  const auto = strip(readFileSync(new URL('./entry-mode-auto.js', import.meta.url), 'utf8'))
  assert.match(auto, /import \{ bindEntryModeGateway \} from '\.\/entry-mode-gateway\.js'/)
  assert.match(auto, /gateway = bindEntryModeGateway/)
  // the call site, not only the default parameter (checker note 11): every
  // switch the pass makes binds the gateway with the epoch it was given —
  // and entry-mode-auto.test.js asserts the calls through a stub.
  assert.match(auto, /const bound = await gateway\(db, id, mode, \{ epoch: r\.status\.modeEpoch \}\)/)
})

// WP-A (dual admission, 25-09-2026): the VPO disarm above is keyed on the
// MODE STRING (`want !== 'TIME_BASED'`), not on the account's bases. That is
// inert only because vpo_cpp_direct is retired (admitEntry refuses it first).
// A "time + tick" account is TIME_BASED, so this line would leave a
// re-enabled VPO tier armed beside tick. This pin fails the moment the
// producer is un-retired while the disarm is still keyed on the mode string
// — re-key it on basesFor in the same change. Comments stripped (failure
// mode #2), so a comment naming the line cannot satisfy it.
test('pin: vpo_cpp_direct stays retired while the VPO disarm is keyed on the mode string, not on basesFor', async () => {
  const { ENTRY_PRODUCERS } = await import('../lib/entry-producers.js')
  const vpo = ENTRY_PRODUCERS.find(p => p.id === 'vpo_cpp_direct')
  assert.ok(vpo, 'vpo_cpp_direct is still in the registry')
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./entry-mode-gateway.js', import.meta.url), 'utf8'))
  const modeKeyed = src.includes("if (want !== 'TIME_BASED') {")
  if (modeKeyed) assert.ok(vpo.retired, 'vpo_cpp_direct was un-retired but the VPO disarm is still keyed on the mode string — re-key entry-mode-gateway.js on basesFor first (a TIME_BASED + [bar, tick] account would keep VPO armed)')
  else assert.match(src, /basesFor\(/, 'the disarm was re-keyed: it must read the bases')
})
