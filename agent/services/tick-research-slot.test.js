// node --test agent/services/tick-research-slot.test.js
// Claude · № 13,102 11-Oct (Codex P2 on #1311): the shared research slot is
// held while the tick research door lists or pulls remote segments, so the
// bar-form door cannot start beside that preprocessing; released after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { researchSlot, releaseResearchSlot, acquireResearchSlot } from './research-slot.js'
import { startTickResearchJobWithSync, _resetTickResearchJobs } from './tick-research-run.js'
import { initDB } from '../db.js'

test('the shared slot is held during the remote segment listing and released afterwards; a held slot refuses the sync', async () => {
  _resetTickResearchJobs(); if (researchSlot()) releaseResearchSlot(researchSlot().id)
  const db = initDB(':memory:'); const cache = mkdtempSync(join(tmpdir(), 'tick-slot-'))
  let seenDuringList = null
  const listAll = async () => { seenDuringList = researchSlot(); return { names: [], recordsPerSegment: [], segments: 0, reachable: 0, sides: [] } }
  const r = await startTickResearchJobWithSync(db, {}, { segmentsDir: join(cache, 'none'), listAll, cacheDir: cache })
  assert.ok(seenDuringList, 'the slot must be held while listing'); assert.match(seenDuringList.what, /segment sync/)
  assert.equal(researchSlot(), null, 'released once the sync path ends'); assert.ok(r.status >= 400)
  // Another door holding the slot: the sync does not start.
  acquireResearchSlot('bar-form research', 'bf-1')
  const held = await startTickResearchJobWithSync(db, {}, { segmentsDir: join(cache, 'none'), listAll, cacheDir: cache })
  assert.equal(held.status, 409); assert.equal(held.body.error, 'research_running'); assert.match(held.body.where, /bar-form research/)
  releaseResearchSlot('bf-1'); rmSync(cache, { recursive: true, force: true })
})
