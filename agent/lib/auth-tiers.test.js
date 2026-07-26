// node --test agent/lib/auth-tiers.test.js
//
// D12: read tier vs full (money-moving) tier. Backward compatible when
// AGENT_SECRET_READ is unset — every check must collapse to "one secret,
// one tier" in that case.

import test from 'node:test'
import assert from 'node:assert/strict'
import { requiresFullTier, classifyToken, tierAuthorizes } from './auth-tiers.js'

test('requiresFullTier: only GET is the read tier', () => {
  assert.equal(requiresFullTier('GET'), false)
  assert.equal(requiresFullTier('get'), false)
  assert.equal(requiresFullTier('POST'), true)
  assert.equal(requiresFullTier('PUT'), true)
  assert.equal(requiresFullTier('PATCH'), true)
  assert.equal(requiresFullTier('DELETE'), true)
  assert.equal(requiresFullTier(undefined), true)
})

test('classifyToken: no token is always unauthenticated', () => {
  assert.equal(classifyToken('', { agentSecret: 'S' }), null)
  assert.equal(classifyToken(null, { agentSecret: 'S' }), null)
  assert.equal(classifyToken(undefined, {}), null)
})

test('classifyToken: the master secret is always full tier', () => {
  assert.equal(classifyToken('S', { agentSecret: 'S', agentSecretRead: 'R' }), 'full')
})

test('classifyToken: a valid device session is full tier — Telegram login is already a second factor', () => {
  const isValidSession = (t) => t === 'sess_abc'
  assert.equal(classifyToken('sess_abc', { agentSecret: 'S', isValidSession }), 'full')
  assert.equal(classifyToken('sess_unknown', { agentSecret: 'S', isValidSession }), null)
})

test('classifyToken: the read secret is the read tier, never full', () => {
  assert.equal(classifyToken('R', { agentSecret: 'S', agentSecretRead: 'R' }), 'read')
})

test('classifyToken: an unrecognized token is unauthenticated even with a read secret configured', () => {
  assert.equal(classifyToken('garbage', { agentSecret: 'S', agentSecretRead: 'R' }), null)
})

test('classifyToken: AGENT_SECRET_READ unset — a token equal to "" never matches (no accidental open door)', () => {
  assert.equal(classifyToken('', { agentSecret: 'S', agentSecretRead: '' }), null)
  assert.equal(classifyToken('anything', { agentSecret: 'S', agentSecretRead: undefined }), null)
})

test('tierAuthorizes: full tier authorizes every method', () => {
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(tierAuthorizes('full', m), true)
})

test('tierAuthorizes: read tier authorizes only GET', () => {
  assert.equal(tierAuthorizes('read', 'GET'), true)
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(tierAuthorizes('read', m), false)
})

test('tierAuthorizes: null (unauthenticated) never authorizes anything', () => {
  assert.equal(tierAuthorizes(null, 'GET'), false)
  assert.equal(tierAuthorizes(null, 'POST'), false)
})

// ---- backward compatibility: unset AGENT_SECRET_READ collapses to the old
// one-secret-one-tier behaviour exactly ------------------------------------

test('backward compat: with no read secret configured, only the master secret (or a session) ever authorizes anything', () => {
  const isValidSession = () => false
  for (const method of ['GET', 'POST', 'DELETE']) {
    const tier = classifyToken('S', { agentSecret: 'S', agentSecretRead: undefined, isValidSession })
    assert.equal(tierAuthorizes(tier, method), true, `master secret must still authorize ${method}`)
    const noTier = classifyToken('anything-else', { agentSecret: 'S', agentSecretRead: undefined, isValidSession })
    assert.equal(tierAuthorizes(noTier, method), false, `a non-matching token must still be refused on ${method}`)
  }
})
