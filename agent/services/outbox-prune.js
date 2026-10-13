// Bound inspected primary-key rows as well as deletions. A sparse expiry must
// not become one full-table scan. The fixed high-water mark leaves new
// arrivals for the next scheduled pass.
//
// Claude · № 13,878 13-Oct (owner "Stop queuing while off"; claude-builder):
// a row older than the cutoff goes whether it was sent or not, and a row held
// by notify OFF ('notify_off') goes at any age: nothing is queued while off
// any more, and switching back on delivers nothing from the off period.
// Measured 12-10: 84,587 such rows since 22-08, 624 MB, never removed because
// this deleted only sent rows. Rows deferred by quiet hours or the hourly
// digest keep their 14 days to be delivered.
export async function pruneSentOutboxCooperatively(db, cutoffIso, { onProgress } = {}) {
  const end = db.prepare('SELECT MAX(id) id FROM telegram_outbox').get().id
  const firstPage = db.prepare('SELECT id FROM telegram_outbox WHERE id <= ? ORDER BY id LIMIT 200')
  const page = db.prepare('SELECT id FROM telegram_outbox WHERE id > ? AND id <= ? ORDER BY id LIMIT 200')
  const due = "(queued_at < ? OR (sent_at IS NULL AND reason = 'notify_off'))"
  const firstRemove = db.prepare(`DELETE FROM telegram_outbox WHERE id <= ? AND ${due}`)
  const remove = db.prepare(`DELETE FROM telegram_outbox WHERE id > ? AND id <= ? AND ${due}`)
  let cursor = null
  let changes = 0
  while (end != null && (cursor == null || cursor < end)) {
    const ids = cursor == null ? firstPage.all(end) : page.all(cursor, end)
    if (!ids.length) break
    const next = ids.at(-1).id
    changes += (cursor == null ? firstRemove.run(next, cutoffIso) : remove.run(cursor, next, cutoffIso)).changes
    cursor = next
    onProgress?.({ cursor, end })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { changes }
}
