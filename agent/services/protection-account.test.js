import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { handleProtectionCallback, pollTelegramCommands } from './telegram-control.js'
import { protectionCredentials, protectionCallback, parseProtectionCallback } from './protection-account.js'

function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_CHAT_ID']) {
    const old = process.env[key]
    process.env[key] = key === 'TELEGRAM_OWNER_CHAT_ID' ? '99' : 'fixture'
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'ctrader_access_token', 'fixture')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run('42', 0)
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run('43', 1)
  return db
}
function position(db, account) {
  const trade = db.prepare(`INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id)
    VALUES ('EURUSD','long','open',?,'700')`).run(account).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol,trade_id,status,account_id,current_sl,current_tp)
    VALUES ('EURUSD',?,'active',?,1.05,1.2)`).run(trade, account)
}
function broker(sent) {
  return {
    readPosition: async () => ({ positionId: '700', stopLoss: 1.05, takeProfit: 1.2 }),
    amend: async (creds, args) => { sent.push({ account: creds.accountId, live: creds.isLive, ...args }); return {} },
  }
}

test('protection account resolution uses the unique recorded owner and refuses selected-account fallback', t => {
  const db = fixture(t)
  assert.throws(() => protectionCredentials(db, { positionId: '700' }), /explicit account is required/)
  position(db, '43')
  assert.equal(protectionCredentials(db, { positionId: '700' }).accountId, '43')
  position(db, '42')
  assert.throws(() => protectionCredentials(db, { positionId: '700' }), /ambiguous/)
  db.prepare("UPDATE trades SET status = 'closed' WHERE account_id = '42'").run()
  db.prepare("UPDATE monitored_positions SET status = 'closed' WHERE account_id = '42'").run()
  assert.throws(() => protectionCredentials(db, { positionId: '700' }), /ambiguous/, 'an old account-less button cannot be retargeted to the remaining account')
  assert.equal(protectionCredentials(db, { positionId: '700', accountId: '43' }).accountId, '43')
  for (const accountId of ['999', '', 'all', '_all']) {
    assert.throws(() => protectionCredentials(db, { positionId: '700', accountId }), /account.*required/)
  }
})

test('HTTP protection uses the requested account and rejects unknown/ambiguous routing without a broker call', async t => {
  const db = fixture(t), sent = [], app = express()
  position(db, '42'); position(db, '43')
  app.use(express.json()); app.use('/actions', actionsRouter(db, { positionProtection: broker(sent) }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const post = account => fetch(`http://127.0.0.1:${server.address().port}/actions/position-protect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, positionId: '700', tp: 1.21 }),
  })
  for (const account of [undefined, '', '999', 'all']) assert.equal((await post(account)).status, 400)
  assert.equal(sent.length, 0)
  const res = await post('43'), data = await res.json()
  assert.equal(res.status, 200)
  assert.equal(data.accountId, '43'); assert.equal(data.accountSource, 'body'); assert.equal(data.ledgerUpdated, true)
  assert.deepEqual(sent, [{ account: '43', live: true, positionId: 700, stopLoss: 1.05, takeProfit: 1.21 }])
  assert.equal(db.prepare("SELECT current_tp FROM monitored_positions WHERE account_id='42'").get().current_tp, 1.2)
})

test('new and legacy TP callbacks resolve account identity without borrowing primary credentials', async t => {
  const db = fixture(t), sent = []
  position(db, '43')
  const legacy = await handleProtectionCallback(db, ['prottp', '700', '1.21'], broker(sent))
  assert.equal(legacy.accountId, '43')
  position(db, '42')
  await assert.rejects(handleProtectionCallback(db, ['prottp', '700', '1.22'], broker(sent)), /ambiguous/)
  const scoped = await handleProtectionCallback(db, ['prottp', '43', '700', '1.22'], broker(sent))
  assert.equal(scoped.accountId, '43')
  await assert.rejects(handleProtectionCallback(db, ['prottp', '999', '700', '1.22'], broker(sent)), /registered account/)
  assert.equal(sent.length, 2)
  assert.ok(sent.every(s => s.account === '43' && s.stopLoss === 1.05))
})

test('real Telegram poll wires the scoped handler and still ignores another chat', async t => {
  const db = fixture(t), sent = [], replies = []
  position(db, '42'); position(db, '43')
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const method = String(url).split('/').at(-1), body = JSON.parse(opts.body)
    if (method === 'getUpdates') return { json: async () => ({ ok: true, result: [
      { update_id: 1, callback_query: { id: 'foreign', message: { chat: { id: '98' } }, data: 'prottp|43|700|1.21' } },
      { update_id: 2, callback_query: { id: 'owner', message: { chat: { id: '99' } }, data: 'prottp|43|700|1.21' } },
    ] }) }
    replies.push({ method, body }); return { json: async () => ({ ok: true, result: {} }) }
  })
  const handled = await pollTelegramCommands(db, { creds: { ready: true, accountId: '42' }, positionProtection: broker(sent) })
  assert.equal(handled, 1); assert.equal(sent.length, 1); assert.equal(sent[0].account, '43')
  assert.ok(replies.some(r => r.method === 'sendMessage' && r.body.text.includes('account 43')))
  const record = JSON.parse(db.prepare("SELECT body FROM action_log WHERE path='prottp'").get().body)
  assert.equal(record.accountId, '43')
})

test('callback identity is bounded without truncation and malformed legacy payloads fail closed', () => {
  assert.equal(protectionCallback('43', '700', 1.21), 'prottp|43|700|1.21')
  for (const account of [null, '', 'all', '4|3', '1'.repeat(65)]) assert.equal(protectionCallback(account, '700', 1.21), null)
  for (const parts of [['prottp','43','700','Infinity'], ['prottp','43','700junk','1.2'], ['prottp','','700','1.2'], ['prottp','43','700','1.2','extra']]) {
    assert.throws(() => parseProtectionCallback(parts))
  }
})
