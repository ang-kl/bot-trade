// Connectivity gate for per-account sweeps (owner, 2026-07-31: "even if I
// have 5 selected trade-account, and one isn't connect - do you still probe
// the one isn't connect"). sidecarRoster() is the single source the gates
// consult; its semantics must be exact:
//   - cpp mode + healthy connected sidecar → the authorized roster, as strings
//   - cpp mode + unreachable/disconnected/rosterless sidecar → null (UNKNOWN)
//     so callers FAIL OPEN and probe everything, as before the gate existed
//   - js mode → null (no persistent session to be disconnected from)
//   - cached: repeated calls within the TTL do not re-hit /health
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { sidecarRoster } from './exec-engine.js'

const realFetch = globalThis.fetch
const realEnv = { EXEC_ENGINE: process.env.EXEC_ENGINE }
afterEach(() => {
  globalThis.fetch = realFetch
  if (realEnv.EXEC_ENGINE === undefined) delete process.env.EXEC_ENGINE
  else process.env.EXEC_ENGINE = realEnv.EXEC_ENGINE
})

function mockHealth(body, { ok = true } = {}) {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok, status: ok ? 200 : 503, json: async () => body }
  }
  return () => calls
}

test('js mode never reports a roster — every account is probed as before', async () => {
  process.env.EXEC_ENGINE = 'js'
  const calls = mockHealth({ ok: true, connected: true, accounts: [1, 2] })
  assert.equal(await sidecarRoster({ ttlMs: 0 }), null)
  assert.equal(calls(), 0, 'js mode must not even hit /health')
})

test('cpp mode returns the authorized roster as strings, and caches it', async () => {
  process.env.EXEC_ENGINE = 'cpp'
  const calls = mockHealth({ ok: true, connected: true, accounts: [46130058, 43097342] })
  const roster = await sidecarRoster({ ttlMs: 60_000 })
  assert.deepEqual(roster, ['46130058', '43097342'])
  // Within the TTL the cached answer is reused — sweeps in the same loop
  // cycle must not multiply /health probes.
  await sidecarRoster({ ttlMs: 60_000 })
  await sidecarRoster({ ttlMs: 60_000 })
  assert.equal(calls(), 1)
})

test('a disconnected or rosterless sidecar is UNKNOWN (null), never an empty roster', async () => {
  process.env.EXEC_ENGINE = 'cpp'
  // connected:false — the roster it reports is not a live session's roster.
  mockHealth({ ok: true, connected: false, accounts: [46130058] })
  assert.equal(await sidecarRoster({ ttlMs: 0 }), null)
  // No accounts field at all (older binary): unknown, not "nobody".
  mockHealth({ ok: true, connected: true })
  assert.equal(await sidecarRoster({ ttlMs: 0 }), null)
  // Unreachable: pingSidecar returns ok:false → unknown. An empty array here
  // would silently stop reconciling EVERY account on a health blip.
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await sidecarRoster({ ttlMs: 0 }), null)
})

test('an authorized-but-empty roster IS an empty array — that is a real answer', async () => {
  process.env.EXEC_ENGINE = 'cpp'
  mockHealth({ ok: true, connected: true, accounts: [] })
  assert.deepEqual(await sidecarRoster({ ttlMs: 0 }), [])
})

// --- withNumericIds (production bug 2026-07-31) ----------------------------
// "Position close (LLM) FAILED: Corn — Couldn't parse integer: For input
// string: ""233934803"" (INVALID_REQUEST)": the TEXT-column position id was
// forwarded to the broker as a JSON string. Every sidecar-bound body now
// passes through withNumericIds at the delegator.
test('withNumericIds coerces int64 fields and leaves garbage visible', async () => {
  const { withNumericIds } = await import('./exec-engine.js')
  const out = withNumericIds({ positionId: '233934803', volume: '100000', ctidTraderAccountId: '46130058', label: 'keep' })
  assert.deepEqual(out, { positionId: 233934803, volume: 100000, ctidTraderAccountId: 46130058, label: 'keep' })
  // Even a value that arrives with embedded quotes (the exact production
  // artefact) resolves to the number.
  assert.equal(withNumericIds({ positionId: '"233934803"' }).positionId, 233934803)
  // Garbage stays as-is so the broker rejects it LOUDLY, not as a silent null.
  assert.equal(withNumericIds({ positionId: 'abc' }).positionId, 'abc')
  assert.equal(withNumericIds({ positionId: null }).positionId, null)
})
