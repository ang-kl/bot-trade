import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { jsonExceptScannerRegistration, scannerRegistrationJson, SCANNER_PROFILES_PATH, SCANNER_REGISTRATION_BYTES } from './scanner-registration-body.js'
import { initDB, setState } from '../db.js'
import { nativeProfileHash } from '../services/scanner-profiles.js'
import { scannerProfileRegistry, SCANNER_PROFILE_LIMIT } from '../services/scanner-profile-registry.js'
import actionsRouter from './actions.js'

async function listen(t, app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(r => server.close(r)))
  return `http://127.0.0.1:${server.address().port}`
}
const post = (url, body, token) => fetch(url, { method: 'POST', body,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
const padded = bytes => JSON.stringify({ profiles: [], pad: 'x'.repeat(bytes) })

test('the registration body is parsed only after authentication, with its own 512 KiB bound', async t => {
  assert.equal(SCANNER_PROFILES_PATH, '/actions/scanner-profiles')
  assert.equal(SCANNER_REGISTRATION_BYTES, 512 * 1024)
  const atAuth = []
  const app = express()
  app.use(jsonExceptScannerRegistration())
  app.use((req, res, next) => {
    // What the auth step sees: on the registration path no parser has touched
    // the request ('body' is only set once a parser has run).
    atAuth.push({ path: req.path, parsed: 'body' in req && req.body !== undefined })
    return req.headers.authorization === 'Bearer ok' ? next() : res.status(401).json({ error: 'Unauthorized' })
  })
  app.use(SCANNER_PROFILES_PATH, scannerRegistrationJson())
  app.post(SCANNER_PROFILES_PATH, (req, res) => res.json({ bytes: req.body.pad.length }))
  app.post('/actions/other', (req, res) => res.json({ ok: true }))
  // Four parameters make this Express's error handler (quiet 413s in the log).
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).end())
  const base = await listen(t, app)

  assert.equal((await post(`${base}${SCANNER_PROFILES_PATH}`, padded(400_000))).status, 401)
  assert.deepEqual(atAuth.pop(), { path: SCANNER_PROFILES_PATH, parsed: false })
  // Express routes case-insensitively and ignores one trailing slash; the
  // skip matches the same paths, and the scoped mount still parses them.
  assert.equal((await post(`${base}/ACTIONS/Scanner-Profiles/`, padded(400_000))).status, 401)
  assert.equal(atAuth.pop().parsed, false)
  const accepted = await post(`${base}${SCANNER_PROFILES_PATH}`, padded(400_000), 'ok')
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).bytes, 400_000)
  assert.equal((await post(`${base}/actions/scanner-profiles/`, padded(400_000), 'ok')).status, 200)
  assert.equal((await post(`${base}${SCANNER_PROFILES_PATH}`, padded(SCANNER_REGISTRATION_BYTES), 'ok')).status, 413)
  // Every other path keeps the global 100 KB default, parsed before auth as before.
  assert.equal((await post(`${base}/actions/other`, padded(200_000), 'ok')).status, 413)
  assert.equal((await post(`${base}/actions/other`, JSON.stringify({ a: 1 }))).status, 401)
  assert.deepEqual(atAuth.pop(), { path: '/actions/other', parsed: true })
})

test('the 796-profile draft (above the old 100 KB parser) registers through the actions router; 1025 is refused', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(11,0)').run()
  const symbols = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`SYM${i}`, 100 + i]))
  setState(db, 'symbol_id_map:11', JSON.stringify({ map: symbols }))
  const cells = []
  for (const symbolId of Object.values(symbols)) for (const strategy of ['fib_confluence', 'rsi2_reversion', 'donchian_breakout'])
    for (const timeframe of ['5m', '30m', '1h', '4h', '1d']) cells.push({ source: 'cpp-scan-timeframe', strategy, timeframe, options: {}, configVersion: 'tf-v1',
      candidateTtlMs: 3600000, profileHash: nativeProfileHash(strategy, {}), feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: String(symbolId) } })
  const app = express()
  app.use(jsonExceptScannerRegistration())
  app.use((req, res, next) => req.headers.authorization === 'Bearer ok' ? next() : res.sendStatus(401))
  app.use(SCANNER_PROFILES_PATH, scannerRegistrationJson())
  app.use('/actions', actionsRouter(db, { scannerProfiles: { env: {} } }))
  const url = `${await listen(t, app)}${SCANNER_PROFILES_PATH}`
  const draft = JSON.stringify({ expectedRevision: scannerProfileRegistry(db).revision, profiles: cells.slice(0, 796) })
  assert.ok(Buffer.byteLength(draft) > 100 * 1024, 'the draft must exceed the default parser to prove the scoped one')
  const response = await post(url, draft, 'ok')
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).profiles.length, 796)
  assert.equal(scannerProfileRegistry(db).valid, true)
  const over = JSON.stringify({ expectedRevision: scannerProfileRegistry(db).revision, profiles: cells.slice(0, SCANNER_PROFILE_LIMIT + 1) })
  assert.ok(Buffer.byteLength(over) < SCANNER_REGISTRATION_BYTES, 'the count bound must be reachable over HTTP')
  const refused = await post(url, over, 'ok')
  assert.equal(refused.status, 400); assert.equal((await refused.json()).error, 'registration_bound')
})

test('index.js skips the global parser for registration, authenticates, then mounts the scoped parser', () => {
  // Wiring pin, a last resort: index.js boots the whole agent and cannot be
  // imported by a test. Comments are stripped first (failure mode #2).
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  const at = pattern => { const m = source.match(pattern); assert.ok(m, String(pattern)); return m.index }
  assert.doesNotMatch(source, /app\.use\(\s*express\.json\(/)
  const skip = at(/app\.use\(jsonExceptScannerRegistration\(\)\)/)
  const auth = at(/app\.use\(authMiddleware\)/)
  const scoped = at(/app\.use\(SCANNER_PROFILES_PATH, scannerRegistrationJson\(\)\)/)
  const actions = at(/app\.use\('\/actions', actionsRouter\(db\)\)/)
  assert.ok(skip < auth && auth < scoped && scoped < actions, JSON.stringify({ skip, auth, scoped, actions }))
  assert.match(source, /import \{[^}]*\bjsonExceptScannerRegistration\b[^}]*\bscannerRegistrationJson\b[^}]*\bSCANNER_PROFILES_PATH\b[^}]*\} from '\.\/routes\/scanner-registration-body\.js'/)
})
