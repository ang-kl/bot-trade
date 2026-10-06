// Keep the existing sent/14-day policy, but bound inspected primary-key rows
// as well as deletions. A sparse expiry must not become one full-table scan.
// The fixed high-water mark leaves new arrivals for the next scheduled pass.
export async function pruneSentOutboxCooperatively(db, cutoffIso, { onProgress } = {}) {
  const end = db.prepare('SELECT MAX(id) id FROM telegram_outbox').get().id
  const firstPage = db.prepare('SELECT id FROM telegram_outbox WHERE id <= ? ORDER BY id LIMIT 200')
  const page = db.prepare('SELECT id FROM telegram_outbox WHERE id > ? AND id <= ? ORDER BY id LIMIT 200')
  const firstRemove = db.prepare('DELETE FROM telegram_outbox WHERE id <= ? AND sent_at IS NOT NULL AND queued_at < ?')
  const remove = db.prepare('DELETE FROM telegram_outbox WHERE id > ? AND id <= ? AND sent_at IS NOT NULL AND queued_at < ?')
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
