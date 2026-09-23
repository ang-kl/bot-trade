// Standalone, read-only outer observation. Runs without the Node application,
// its database, broker credentials or Telegram command polling.
export async function observeVerifier({ url, secret, now = Date.now, maxAgeMs = 60000, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 15000 || maxAgeMs > 300000) throw new Error('observer_deadline_invalid')
  let endpoint
  try { endpoint = new URL(url) } catch { return { ok: false, state: 'unconfigured' } }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !secret) return { ok: false, state: 'unconfigured' }
  try {
    const r = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (r.status !== 200) return { ok: false, state: 'unreachable_or_unauthorized' }
    const chunks = []; let size = 0
    for await (const c of r.body) { size += c.byteLength; if (size > 256 * 1024) throw new Error('response_bound'); chunks.push(c) }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), at = now()
    const fresh = value => Number.isSafeInteger(value) && value > 0 && value <= at && at - value < maxAgeMs
    if (body.schemaVersion !== 1 || !fresh(body.observedAtMs)) return { ok: false, state: 'invalid_or_stale_response' }
    if (body.enabled !== true) return { ok: false, state: 'supervision_inactive' }
    if (body.durable !== true) return { ok: false, state: 'incident_storage_unavailable' }
    const required = ['node', 'cpp-exec', 'cpp-acct']
    const stalled = required.filter(service => !fresh(body.services?.[service]?.attemptedAtMs))
    return { ok: !stalled.length, state: stalled.length ? 'probe_progress_stalled' : 'probe_progress_observed',
      observedAtMs: at, stalled, deliveryAccepted: false,
      note: 'Progress is independent of target reachability. This receipt does not confirm notification delivery or activate supervision.' }
  } catch { return { ok: false, state: 'probe_unavailable' } }
}
