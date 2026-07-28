// DB_PATH handling.
//
// Production, 2026-07-28: /health reported dbPath as " /data/agent.db" — a
// leading space in the Railway variable. One character, and the value stops
// being an absolute path, so SQLite resolves it against the process cwd and
// writes inside the container instead of the mounted volume. Every redeploy
// then wipes the account link, the logins and the trade history. Nothing errors,
// because opening the wrong path succeeds.
//
// These tests cover the two ways a configured DB_PATH silently isn't a volume
// path, at the level the boot code decides it: whitespace and non-absoluteness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from './db.js'

// The boot rule, extracted so it can be asserted directly. index.js applies
// exactly this: trim, fall back only when the trimmed value is empty.
const resolveDbPath = (raw) => (raw ?? '').trim() || './agent.db'

test('a leading or trailing space in DB_PATH is trimmed away', () => {
  assert.equal(resolveDbPath(' /data/agent.db'), '/data/agent.db')
  assert.equal(resolveDbPath('/data/agent.db '), '/data/agent.db')
  assert.equal(resolveDbPath('\t/data/agent.db\n'), '/data/agent.db')
})

test('the untrimmed form is exactly the data-loss trap being closed', () => {
  // Documents WHY the trim matters: with the space, the value is not absolute,
  // so it resolves against the working directory — not the volume.
  assert.equal(path.isAbsolute(' /data/agent.db'), false)
  assert.equal(path.isAbsolute(resolveDbPath(' /data/agent.db')), true)
})

test('an unset or whitespace-only DB_PATH falls back to the local file', () => {
  assert.equal(resolveDbPath(undefined), './agent.db')
  assert.equal(resolveDbPath(''), './agent.db')
  assert.equal(resolveDbPath('   '), './agent.db')
})

test('db.name is the authoritative path — it is what SQLite opened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpath-'))
  const file = path.join(dir, 'agent.db')
  const db = initDB(file)
  assert.equal(db.name, file)
  // And that path is stat-able, which is the check dbPersistent now relies on
  // instead of trusting that the variable was set.
  assert.ok(fs.statSync(db.name).size > 0)
})

test('statting the untrimmed path fails while the trimmed one succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpath2-'))
  const file = path.join(dir, 'agent.db')
  initDB(file)
  assert.throws(() => fs.statSync(` ${file}`))
  assert.ok(fs.statSync(file).size > 0)
})
