// node --test agent/routes/session-routes.test.js
//
// Route-level assertions the service tests cannot make: the STATUS CODES the
// brief specifies, and that the current session is identified from the
// request's own Authorization header rather than from anything the client
// sends in the body.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import actionsRouter from './actions.js'
import stateRouter from './state.js'
import { publicSessionId } from '../services/browser-sessions.js'
import { registerClientPing, clientSummary, dropTabsForSession } from '../services/client-presence.js'

const TOKEN_A = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'sess_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/138.0.0.0 Safari/537.36'

function serve(db) {
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}` }
}

function freshDb() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({
    [TOKEN_A]: Date.now() + 86_400_000,
    [TOKEN_B]: Date.now() + 86_400_000,
  }))
  return db
}

const as = (token) => ({ Authorization: `Bearer ${token}`, 'user-agent': UA, 'content-type': 'application/json' })

test('GET /state/sessions marks the caller current from its own bearer token', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    // Seed both sessions by touching them through a real request.
    await fetch(`${base}/state/client-ping?tab=t1&tz=Asia/Singapore&page=/desk`, { headers: as(TOKEN_A) })
    await fetch(`${base}/state/client-ping?tab=t2&tz=Asia/Singapore&page=/risk`, { headers: as(TOKEN_B) })

    const a = await (await fetch(`${base}/state/sessions`, { headers: as(TOKEN_A) })).json()
    assert.equal(a.currentSessionId, publicSessionId(TOKEN_A))
    assert.equal(a.sessions.find(s => s.isCurrent).id, publicSessionId(TOKEN_A))

    // The SAME data, requested with the other token, marks the other session
    // current — proving it is derived per-request and not stored.
    const b = await (await fetch(`${base}/state/sessions`, { headers: as(TOKEN_B) })).json()
    assert.equal(b.currentSessionId, publicSessionId(TOKEN_B))
    assert.equal(b.sessions.find(s => s.isCurrent).id, publicSessionId(TOKEN_B))
  } finally { server.close() }
})

test('the presence heartbeat links a tab to the session that sent it', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    await fetch(`${base}/state/client-ping?tab=tabX&tz=Asia/Singapore&page=/tune`, { headers: as(TOKEN_A) })
    const tab = clientSummary().tabs.find(t => t.id === 'tabX')
    // Derived server-side from the Authorization header — the request carried
    // no sid parameter at all.
    assert.equal(tab.sid, publicSessionId(TOKEN_A))

    const view = await (await fetch(`${base}/state/sessions`, { headers: as(TOKEN_A) })).json()
    const mine = view.sessions.find(s => s.isCurrent)
    assert.ok(mine.openTabs >= 1)
    assert.ok(mine.pages.includes('/tune'))
  } finally { server.close() }
})

test('a client-supplied sid is ignored — the server decides who you are', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    const lie = publicSessionId(TOKEN_B)
    await fetch(`${base}/state/client-ping?tab=liar&tz=Asia/Singapore&page=/desk&sid=${lie}`, { headers: as(TOKEN_A) })
    const tab = clientSummary().tabs.find(t => t.id === 'liar')
    assert.equal(tab.sid, publicSessionId(TOKEN_A), 'the query sid must not win')
    assert.notEqual(tab.sid, lie)
  } finally { server.close() }
})

test('POST self-revoke → 409, and the credential survives', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    await fetch(`${base}/state/client-ping?tab=t1&page=/desk`, { headers: as(TOKEN_A) })
    const id = publicSessionId(TOKEN_A)
    const res = await fetch(`${base}/actions/sessions/${id}/revoke`, {
      method: 'POST', headers: as(TOKEN_A), body: JSON.stringify({ reason: 'oops' }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.code, 'self_revoke_forbidden')
    assert.ok(JSON.parse(getState(db, 'device_sessions'))[TOKEN_A], 'still authenticates')
  } finally { server.close() }
})

test('POST revoke another → 200, credential removed, tabs dropped', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    await fetch(`${base}/state/client-ping?tab=mine&page=/desk`, { headers: as(TOKEN_A) })
    await fetch(`${base}/state/client-ping?tab=theirs&page=/risk`, { headers: as(TOKEN_B) })
    assert.equal(clientSummary().tabs.filter(t => t.id === 'theirs').length, 1)

    const res = await fetch(`${base}/actions/sessions/${publicSessionId(TOKEN_B)}/revoke`, {
      method: 'POST', headers: as(TOKEN_A), body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.state, 'revoked')
    // >= 1, not == 1: the presence roster is module-level state shared across
    // the tests in this file, so an earlier test's tab under the SAME session
    // is legitimately dropped by this call too. Pinning an exact count here
    // would be asserting test ordering, not behaviour. The assertion that
    // matters is that this session's tab is gone and the other session's is
    // not — checked below and in the dropTabsForSession test.
    assert.ok(body.queuedItemsCancelled >= 1, 'the remote tab is dropped')
    // The wire response must not claim a socket was closed.
    assert.equal(body.transportClosed, false)

    assert.equal(JSON.parse(getState(db, 'device_sessions'))[TOKEN_B], undefined)
    // Its tab is gone from the OPEN roster.
    assert.equal(clientSummary().tabs.some(t => t.id === 'theirs'), false)
  } finally { server.close() }
})

test('POST revoke an unknown session → 404', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    const res = await fetch(`${base}/actions/sessions/0123456789abcdef/revoke`, {
      method: 'POST', headers: as(TOKEN_A), body: JSON.stringify({}),
    })
    assert.equal(res.status, 404)
  } finally { server.close() }
})

test('revocation is rate limited', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    let sawTooMany = false
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${base}/actions/sessions/0123456789abcdef/revoke`, {
        method: 'POST', headers: as(TOKEN_A), body: JSON.stringify({}),
      })
      if (res.status === 429) { sawTooMany = true; break }
    }
    assert.ok(sawTooMany, 'repeated attempts must be throttled')
  } finally { server.close() }
})

test('/state/sessions is never served from the shared 10s cache', async () => {
  const db = freshDb()
  const { server, base } = serve(db)
  try {
    const first = await (await fetch(`${base}/state/sessions`, { headers: as(TOKEN_A) })).json()
    // A cached response would repeat the identical serverTime; a live one
    // cannot, because the age figures beside it must move.
    await new Promise(r => setTimeout(r, 1100))
    const second = await (await fetch(`${base}/state/sessions`, { headers: as(TOKEN_A) })).json()
    assert.notEqual(first.serverTime, second.serverTime)
  } finally { server.close() }
})

test('dropTabsForSession only touches the named session', () => {
  registerClientPing({ tab: 'a1', sid: 'sessionOne', page: '/desk' })
  registerClientPing({ tab: 'b1', sid: 'sessionTwo', page: '/risk' })
  const n = dropTabsForSession('sessionOne')
  assert.equal(n, 1)
  const open = clientSummary().tabs.map(t => t.id)
  assert.equal(open.includes('a1'), false)
  assert.equal(open.includes('b1'), true)
  // Idempotent: a second call finds nothing left to close.
  assert.equal(dropTabsForSession('sessionOne'), 0)
  assert.equal(dropTabsForSession(null), 0)
})
