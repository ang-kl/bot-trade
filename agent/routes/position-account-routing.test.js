// node --test agent/routes/position-account-routing.test.js
//
// PR-F checker M1: POST /actions/position-close with no `account` in the
// body used to fall back to the PRIMARY account's credentials, and
// /actions/position-protect used bare getCtraderCreds(db) for every
// position — a close or a stop change for a position held on account B was
// sent on account A's session. Both routes now resolve the POSITION's own
// account (credsForPosition, as /position-double and /position-reverse do)
// and echo which source chose it. Behaviour is pinned on the resolver with a
// seeded registry; the two routes are pinned by comment-stripped source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { credsForPosition, credsForAccountId } from './actions.js'

function seeded() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'ctrader_access_token', 'tok')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('42','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('43','2',1,1,'active')`).run()
  return db
}

test('a position recorded on account B, closed with NO account in the body, resolves to B\'s creds — not the primary', () => {
  const db = seeded()
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, entry_price, sl_price, tp_price, volume, strategy, ctrader_position_id, account_id, source)
              VALUES ('EURUSD', 'BUY', 'open', datetime('now'), 1.1, 1.09, 1.12, 0.5, 'fib_618_fade', '777', '43', 'autotrade')`).run()
  const c = credsForPosition(db, '777')
  assert.equal(c.accountId, '43')
  assert.equal(c.isLive, true)
  assert.equal(c.accountSource, 'position_record')
  // unknown position → the selected account, and it says so
  const u = credsForPosition(db, '999')
  assert.equal(u.accountId, '42')
  assert.equal(u.accountSource, 'selected_account')
  // an explicit body account still wins (the route spreads accountSource: 'body')
  assert.equal(credsForAccountId(db, '43').accountId, '43')
})

const strip = s => s.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, m => (m[0] === '/' ? ' ' : m))
const routeBody = (src, path) => {
  const start = src.indexOf(`router.post('${path}'`)
  const end = src.indexOf('\n  router.', start + 1)
  assert.ok(start > 0 && end > start, `${path} route found`)
  return src.slice(start, end)
}

test('/position-close resolves the position\'s account when the body names none, and echoes accountSource', () => {
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  // Protection now has behavioural HTTP tests in protection-account.test.js
  // for its stricter missing/ambiguous-account contract.
  for (const path of ['/position-close']) {
    const body = routeBody(src, path)
    assert.ok(body.includes("credsForAccountId(db, req.body.account), accountSource: 'body' } : credsForPosition(db, positionId)"), `${path}: body account wins, else the position record`)
    assert.ok(!body.includes('getCtraderCreds(db)'), `${path}: no primary-only creds left`)
    assert.ok(!body.includes('credsForAccountId(db, req.body?.account)'), `${path}: no silent primary fallback left`)
    assert.ok(/accountSource: creds\.accountSource/.test(body), `${path}: the reply names the source`)
  }
})

test('the sheet posts carry the account on every position route (comment-stripped source pin)', () => {
  const src = strip(readFileSync(new URL('../../src/components/PositionManager.jsx', import.meta.url), 'utf8'))
  const posts = src.match(/agentPost\('\/actions\/position-(protect|guard|double|reverse|close)', /g) || []
  assert.equal(posts.length, 6, 'six position posts in the sheet')
  const wrapped = src.match(/agentPost\('\/actions\/position-(protect|guard|double|reverse|close)', withAcct\(/g) || []
  assert.equal(wrapped.length, 6, 'every one goes through withAcct')
  assert.match(src, /const withAcct = body => \(\{ \.\.\.body, \.\.\.\(acct != null \? \{ account: String\(acct\) \} : \{\}\) \}\)/)
})
