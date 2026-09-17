// node --test agent/services/position-protect.test.js
//
// The one piece of logic behind BOTH POST /actions/position-protect and the
// Telegram "Set TP" inline button. It had no test file at all, which is part of
// how the defect below survived: the only coverage was through the callers,
// and every one of them injects a fake `amend` that bypasses exec-engine's
// `assertAmendIntent` entirely.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB } from '../db.js'
import { protectPosition } from './position-protect.js'

const PP_CREDS = { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: 'A' }

const ppDb = () => initDB(':memory:')

/** One active monitored position on account A, linked to a broker position id. */
function ppSeed(db, positionId, symbol, { current_sl = null, current_tp = null } = {}) {
  const t = db.prepare(
    'INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)'
  ).run(symbol, 'long', 'open', 'A', String(positionId))
  db.prepare(
    'INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,source) VALUES (?,?,?,?,?,?,?)'
  ).run(t.lastInsertRowid, symbol, 'active', 'A', current_sl, current_tp, 'bot')
  return t.lastInsertRowid
}


// ---------------------------------------------------------------------------
// BOTH LEGS, ALWAYS (17-09-2026, second review).
//
// cTrader's amend REPLACES protection. This function built `{positionId,
// takeProfit}` from a tp-only request and sent it — verified live as
// `BUTTON AMEND ARGS: {"positionId":700,"takeProfit":1950}`. The targetless
// alert's one-tap Set-TP button routes here, and that alert's whole premise is
// that these positions DO have a stop, so one tap would have taken a protected
// position NAKED. The mirror case (sl-only) was already throwing in production
// via assertAmendIntent and invisible here because tests inject deps.amend.
// ---------------------------------------------------------------------------

test('THE BUTTON DOOR: a tp-only request carries the broker stop through', async () => {
  const db = ppDb()
  ppSeed(db, '700', 'ETHUSD', { current_sl: 1700, current_tp: null })
  const sent = []
  const r = await protectPosition(db, PP_CREDS, { positionId: '700', tp: 1950, source: 'telegram' }, {
    amend: async (_c, args) => { sent.push(args); return { executionType: 'OK' } },
    readPosition: async () => ({ positionId: '700', stopLoss: 1723.26, takeProfit: null }),
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].takeProfit, 1950)
  assert.equal(sent[0].stopLoss, 1723.26, 'the BROKER stop, not the book\'s 1700, and not nothing')
  assert.equal(r.ok, true)
})

test('the mirror: an sl-only request carries the broker target through', async () => {
  const db = ppDb()
  ppSeed(db, '701', 'ETHUSD', { current_sl: 1700, current_tp: 1900 })
  const sent = []
  await protectPosition(db, PP_CREDS, { positionId: '701', sl: 1750 }, {
    amend: async (_c, args) => { sent.push(args); return { executionType: 'OK' } },
    readPosition: async () => ({ positionId: '701', stopLoss: 1700, takeProfit: 1905 }),
  })
  assert.equal(sent[0].stopLoss, 1750)
  assert.equal(sent[0].takeProfit, 1905)
})

test('a leg the broker genuinely does not hold is said out loud, not omitted', async () => {
  const db = ppDb()
  ppSeed(db, '702', 'ETHUSD', { current_sl: null, current_tp: null })
  const sent = []
  await protectPosition(db, PP_CREDS, { positionId: '702', tp: 1950 }, {
    amend: async (_c, args) => { sent.push(args); return { executionType: 'OK' } },
    readPosition: async () => ({ positionId: '702', stopLoss: null, takeProfit: null }),
  })
  assert.equal(sent[0].clearStopLoss, true, 'omission is what caused this defect; intent is stated')
  assert.ok(!('stopLoss' in sent[0]) || sent[0].stopLoss == null)
})

test('a read that FAILS refuses the amend rather than guessing from the book', async () => {
  // The local book has `current_sl`. Using it would be the tempting shortcut,
  // but our record is what this module exists to correct against broker truth.
  const db = ppDb()
  ppSeed(db, '703', 'ETHUSD', { current_sl: 1700, current_tp: null })
  const sent = []
  await assert.rejects(
    protectPosition(db, PP_CREDS, { positionId: '703', tp: 1950 }, {
      amend: async (_c, args) => { sent.push(args); return {} },
      readPosition: async () => { throw new Error('ws timeout') },
    }),
    /could not read the position's current protection/,
  )
  assert.deepEqual(sent, [])
})

test('a position missing from the live read refuses too', async () => {
  const db = ppDb()
  ppSeed(db, '704', 'ETHUSD', { current_sl: 1700, current_tp: null })
  const sent = []
  await assert.rejects(
    protectPosition(db, PP_CREDS, { positionId: '704', tp: 1950 }, {
      amend: async (_c, args) => { sent.push(args); return {} },
      readPosition: async () => null,
    }),
    /not in a live broker read/,
  )
  assert.deepEqual(sent, [])
})

test('BOTH legs given: no read at all, and both are sent as asked', async () => {
  const db = ppDb()
  ppSeed(db, '705', 'ETHUSD', { current_sl: 1700, current_tp: 1900 })
  const sent = []
  let reads = 0
  await protectPosition(db, PP_CREDS, { positionId: '705', sl: 1750, tp: 1950 }, {
    amend: async (_c, args) => { sent.push(args); return {} },
    readPosition: async () => { reads++; return null },
  })
  assert.equal(reads, 0, 'nothing is missing, so nothing is fetched')
  assert.equal(sent[0].stopLoss, 1750)
  assert.equal(sent[0].takeProfit, 1950)
})

test('a carried-through leg is not journalled as a move; a requested one is', async () => {
  const db = ppDb()
  ppSeed(db, '706', 'ETHUSD', { current_sl: 1723.26, current_tp: null })
  await protectPosition(db, PP_CREDS, { positionId: '706', tp: 1950, source: 'telegram' }, {
    amend: async () => ({}),
    readPosition: async () => ({ positionId: '706', stopLoss: 1723.26, takeProfit: null }),
  })
  const kinds = db.prepare('SELECT kind FROM position_events ORDER BY id').all().map(r => r.kind)
  assert.deepEqual(kinds, ['tp_moved'], 'the stop was re-sent unchanged — not news')
})

test('a carried leg that DISAGREES with the book is journalled — it is a correction', async () => {
  const db = ppDb()
  ppSeed(db, '707', 'ETHUSD', { current_sl: 1700, current_tp: null })
  await protectPosition(db, PP_CREDS, { positionId: '707', tp: 1950 }, {
    amend: async () => ({}),
    readPosition: async () => ({ positionId: '707', stopLoss: 1723.26, takeProfit: null }),
  })
  const rows = db.prepare('SELECT kind, from_value, to_value FROM position_events ORDER BY id').all()
  const sl = rows.find(r => r.kind === 'sl_moved')
  assert.ok(sl, JSON.stringify(rows))
  assert.equal(sl.from_value, 1700)
  assert.equal(sl.to_value, 1723.26)
})

test('the request-handler read is given an explicit, SHORT timeout', async () => {
  // Both callers — the HTTP route and the Telegram callback — now WAIT on this
  // read where they used to return immediately. `wsReconcile`'s 25s default
  // inside `withRetry(..., 2)` is 81s worst case. The refusal is what protects
  // the position; the timeout is what keeps the refusal from being a hang.
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(new URL('./position-protect.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// PROTECT_READ_TIMEOUT_MS'), false, 'comment stripper works')
  const readerBlock = src.slice(src.indexOf('const read = deps.readPosition'), src.indexOf('export async function protectPosition'))
  assert.ok(readerBlock.length > 0, 'the reader block anchor is gone — this test proves nothing')
  assert.match(readerBlock, /PROTECT_READ_TIMEOUT_MS/, 'the read must not inherit the 25s default')
  // Same module rule as tp-suggest: the live WS query, never a cache.
  const specifiers = [...readerBlock.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  assert.deepEqual(specifiers, ['../lib/ctrader-ws.js'],
    'an alias or a wrapper is how the sidecar cache got back in last time')
})
