// Standalone outbox on the independent observer host. No application database,
// broker authority or Telegram command poller is required.
import { open, rename } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
const CAP = 128
async function load(path) {
  try {
    const handle = await open(path, 'r')
    let raw
    try { if ((await handle.stat()).size > 256 * 1024) throw new Error('observer_journal_bound'); raw = await handle.readFile('utf8') } finally { await handle.close() }
    const state = JSON.parse(raw)
    if (state.schemaVersion !== 1 || !Array.isArray(state.pending) || state.pending.length > CAP
      || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || (state.active !== null && typeof state.active !== 'string')
      || state.pending.some(p => !p || typeof p.id !== 'string' || !['failure','recovery'].includes(p.kind) || !Number.isSafeInteger(p.attempts) || !Number.isSafeInteger(p.nextAttemptAt))) throw new Error('observer_journal_invalid')
    return state
  } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, sequence: 0, active: null, pending: [], lastAccepted: null }; throw error }
}
async function save(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
}
export async function sendObserverTelegram(event, { token, chatId, fetchImpl = fetch }) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '') || !/^-?\d+$/.test(String(chatId || ''))) throw new Error('observer_delivery_unconfigured')
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text: `Verifier observer ${event.kind}: ${event.reason}\nIncident ${event.incidentId}\nEvent ${event.id}\nObserved ${new Date(event.observedAt).toISOString()}` }),
  })
  const chunks = []; let size = 0
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > 16384) throw new Error('observer_delivery_response_bound'); chunks.push(chunk) }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (response.status !== 200 || body.ok !== true || !Number.isSafeInteger(body.result?.message_id)) throw new Error('observer_delivery_not_accepted')
  return { messageId: body.result.message_id }
}
// The independent supervisor must enforce one process per journal (e.g. flock).
// Ambiguous send/crash can repeat the SAME event ID: at-least-once, not exactly-once.
export function createObserverDelivery({ path, enabled = false, send, now = Date.now }) {
  let running = false
  return async function deliver(observation) {
    if (!enabled) return { state: 'muted', accepted: false }
    if (!isAbsolute(path || '') || typeof send !== 'function') throw new Error('observer_journal_or_transport_unconfigured')
    if (running) return { state: 'in_flight', accepted: false }
    running = true
    try {
      const state = await load(path), at = now()
      if (typeof observation?.ok !== 'boolean' || typeof observation.state !== 'string' || !/^[a-z_]{1,80}$/.test(observation.state)) throw new Error('observer_receipt_invalid')
      const enqueue = kind => {
        if (state.pending.length >= CAP) throw new Error('observer_outbox_capacity')
        state.sequence++
        const id = `${at}:${state.sequence}`
        const incidentId = state.active ?? id
        state.pending.push({ id, incidentId, kind, reason: observation.state, observedAt: at, attempts: 0, nextAttemptAt: at })
        state.active = kind === 'failure' ? incidentId : null
      }
      let deferredTransition = !observation.ok && !state.active ? 'failure' : observation.ok && state.active ? 'recovery' : null
      if (deferredTransition && state.pending.length < CAP) { enqueue(deferredTransition); deferredTransition = null }
      await save(path, state)
      const event = state.pending[0]
      if (!event || event.nextAttemptAt > at) return { state: event ? 'retry_wait' : 'idle', pending: state.pending.length, accepted: false, capacityBlocked: deferredTransition !== null }
      event.attempts++; event.nextAttemptAt = at + Math.min(300000, 1000 * 2 ** Math.min(event.attempts, 8))
      await save(path, state) // attempt survives process loss before/after send
      let receipt
      try { receipt = await send(event) } catch { return { state: 'delivery_failed', eventId: event.id, pending: state.pending.length, accepted: false, capacityBlocked: deferredTransition !== null } }
      if (!Number.isSafeInteger(receipt?.messageId)) return { state: 'delivery_unconfirmed', eventId: event.id, pending: state.pending.length, accepted: false, capacityBlocked: deferredTransition !== null }
      state.pending.shift(); state.lastAccepted = { eventId: event.id, at: now(), messageId: receipt.messageId }
      // A full journal must still drain. Only after a confirmed removal may
      // the deferred transition occupy its slot; persist both atomically.
      if (deferredTransition) enqueue(deferredTransition)
      await save(path, state)
      return { state: 'telegram_accepted', eventId: event.id, pending: state.pending.length, accepted: true, readConfirmed: false }
    } finally { running = false }
  }
}
