import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import {
  PHASES, acctPhaseKey, masterPhases, accountOverrides,
  effectivePhases, setAccountPhases, phasesView, phaseWanted,
} from './account-phases.js'

function db_() {
  const dir = mkdtempSync(join(tmpdir(), 'acct-phases-'))
  const db = initDB(join(dir, 'test.db'))
  db.prepare('INSERT OR REPLACE INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT OR REPLACE INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run('42993489', 1, 0, 'manage_only', '1251247')
  return db
}
const armAll = (db) => {
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
  setState(db, 'autotrade_enabled', 'true')
}

test('master defaults are ASYMMETRIC and must stay that way', () => {
  const db = initDB(join(mkdtempSync(join(tmpdir(), 'ap-')), 'x.db'))
  // A fresh DB: scan/analyze default ON, autotrade defaults OFF. If autotrade
  // ever defaulted ON, an unreadable or fresh database would arrive ARMED.
  const m = masterPhases(db)
  assert.equal(m.scan, true)
  assert.equal(m.analyze, true)
  assert.equal(m.autotrade, false, 'autotrade must NEVER default on')
})

test('no override means inherit — byte-identical to the pre-switch behaviour', () => {
  const db = db_()
  armAll(db)
  assert.deepEqual(accountOverrides(db, '46130058'), { scan: null, analyze: null, autotrade: null })
  const e = effectivePhases(db, '46130058')
  assert.equal(e.scan, true); assert.equal(e.analyze, true); assert.equal(e.autotrade, true)
  for (const p of PHASES) assert.equal(e.source[p], 'master')
})

test('a per-account OFF stops that account and NOT the others', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { autotrade: false })
  assert.equal(effectivePhases(db, '46130058').autotrade, false)
  assert.equal(effectivePhases(db, '46130058').source.autotrade, 'account')
  // The other account is untouched — this is the whole point of the feature.
  assert.equal(effectivePhases(db, '42993489').autotrade, true)
})

test('THE MASTER IS AN ABSOLUTE VETO — a per-account ON cannot defeat it', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { autotrade: true, scan: true, analyze: true })
  // Master off ⇒ everything off, regardless of any override. The kill switch
  // has to remain a kill switch.
  setState(db, 'autotrade_enabled', 'false')
  setState(db, 'scan_enabled', 'false')
  setState(db, 'analyze_enabled', 'false')
  const e = effectivePhases(db, '46130058')
  assert.equal(e.autotrade, false)
  assert.equal(e.scan, false)
  assert.equal(e.analyze, false)
  // ...and the UI is told it is the MASTER's doing, so the owner does not go
  // hunting for a per-account switch that would have no effect.
  for (const p of PHASES) assert.equal(e.source[p], 'master', p)
})

test('the three phases are independent of each other', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { analyze: false })
  const e = effectivePhases(db, '46130058')
  assert.equal(e.scan, true, 'scan untouched')
  assert.equal(e.analyze, false)
  assert.equal(e.autotrade, true, 'autotrade untouched')
})

test('null clears an override back to inheriting', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { autotrade: false })
  assert.equal(effectivePhases(db, '46130058').autotrade, false)
  setAccountPhases(db, '46130058', { autotrade: null })
  assert.equal(accountOverrides(db, '46130058').autotrade, null)
  assert.equal(effectivePhases(db, '46130058').autotrade, true, 'follows the master again')
})

test('setAccountPhases ignores junk instead of throwing or writing it', () => {
  const db = db_()
  armAll(db)
  const r = setAccountPhases(db, '46130058', { autotrade: 'yes', nonsense: true, scan: false })
  // 'yes' is not a boolean → not written; an unknown phase name → ignored.
  assert.deepEqual(Object.keys(r.set), ['scan'])
  assert.equal(effectivePhases(db, '46130058').autotrade, true, 'unchanged by the junk')
  assert.equal(effectivePhases(db, '46130058').scan, false)
})

test('a null accountId resolves to the master alone (no per-account keys)', () => {
  const db = db_()
  armAll(db)
  const e = effectivePhases(db, null)
  assert.equal(e.autotrade, true)
  for (const p of PHASES) assert.equal(e.source[p], 'master')
})

test('the key namespace matches the acct: convention the loop already uses', () => {
  assert.equal(acctPhaseKey('46130058', 'autotrade'), 'acct:46130058:autotrade_enabled')
  assert.equal(acctPhaseKey('46130058', 'scan'), 'acct:46130058:scan_enabled')
  assert.equal(acctPhaseKey('46130058', 'analyze'), 'acct:46130058:analyze_enabled')
})

test('phaseWanted: one account off does NOT stop the shared scan', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { scan: false })
  // The other account still needs the scan, so the work must still happen —
  // scan is one shared pass, not per-account work that can be skipped in part.
  assert.equal(phaseWanted(db, 'scan', ['46130058', '42993489']), true)
})

test('phaseWanted: nobody wants it ⇒ stop paying for it', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { scan: false })
  setAccountPhases(db, '42993489', { scan: false })
  assert.equal(phaseWanted(db, 'scan', ['46130058', '42993489']), false)
  // ...and the other phases are unaffected by a scan decision.
  assert.equal(phaseWanted(db, 'analyze', ['46130058', '42993489']), true)
  assert.equal(phaseWanted(db, 'autotrade', ['46130058', '42993489']), true)
})

test('phaseWanted: an EMPTY roster means "unknown", never "nobody"', () => {
  const db = db_()
  armAll(db)
  // A registry that failed to load must not silently stop the pipeline, so an
  // empty or missing roster keeps the pre-switch behaviour.
  assert.equal(phaseWanted(db, 'scan', []), true)
  assert.equal(phaseWanted(db, 'scan', null), true)
  assert.equal(phaseWanted(db, 'scan', undefined), true)
})

test('phaseWanted: master off answers false whatever the accounts say', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '46130058', { scan: true })
  setState(db, 'scan_enabled', 'false')
  assert.equal(phaseWanted(db, 'scan', ['46130058']), false)
})

test('phasesView reports every registry row, master, overrides and effective', () => {
  const db = db_()
  armAll(db)
  setAccountPhases(db, '42993489', { autotrade: false })
  const v = phasesView(db)
  assert.equal(v.master.autotrade, true)
  const ids = v.accounts.map(a => a.accountId).sort()
  assert.deepEqual(ids, ['42993489', '46130058'])
  const live = v.accounts.find(a => a.accountId === '42993489')
  assert.equal(live.isLive, true)
  assert.equal(live.enabled, false)
  assert.equal(live.overrides.autotrade, false)
  assert.equal(live.effective.autotrade, false)
  const demo = v.accounts.find(a => a.accountId === '46130058')
  assert.equal(demo.effective.autotrade, true, 'unaffected by the other account')
})

test('phasesView carries balance, open/pending counts and never charges NULL rows to an account', () => {
  const db = db_()
  armAll(db)
  // Per-account balance stamp (the loop writes this on reconcile).
  setState(db, 'acct:46130058:account_balance_usd', '52085.06')
  // Two attributed open positions, one NULL legacy row, one other-account row.
  const mp = db.prepare("INSERT INTO monitored_positions (symbol, side, entry_price, account_id, status) VALUES (?,?,?,?,'active')")
  mp.run('EURUSD', 'long', 1.1, '46130058')
  mp.run('GBPUSD', 'long', 1.27, '46130058')
  mp.run('USDJPY', 'long', 155, null)
  mp.run('XAUUSD', 'short', 2400, '42993489')
  // One working pending order attributed, one already-filled one that must not count.
  const po = db.prepare("INSERT INTO pending_orders (symbol, status, account_id) VALUES (?,?,?)")
  po.run('NATGAS', 'working', '46130058')
  po.run('WHEAT', 'filled', '46130058')

  const v = phasesView(db)
  const a = v.accounts.find(x => x.accountId === '46130058')
  assert.equal(a.balance, 52085.06)
  assert.equal(a.openPositions, 2, 'NULL and other-account rows must not be charged here')
  assert.equal(a.pendingOrders, 1, 'only working orders count')
  const b = v.accounts.find(x => x.accountId === '42993489')
  assert.equal(b.balance, null, 'never reconciled = unknown, not zero')
  assert.equal(b.openPositions, 1)
  assert.equal(b.pendingOrders, 0)
})
