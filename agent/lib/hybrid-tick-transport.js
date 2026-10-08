// Codex · №12,321 · 2026-10-09; codex-footprint: native-hybrid-profit.
import { execBaseFor } from './exec-engine.js'

export function hybridTickTransport({ fetch: request = globalThis.fetch, env = process.env, baseFor = execBaseFor } = {}) {
  const call = async (host, method, path, body) => {
    if (!env.EXEC_SECRET) throw Error('hybrid gateway authentication unavailable')
    const response = await request(baseFor(host) + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { authorization: `Bearer ${env.EXEC_SECRET}`, ...(body == null ? {} : { 'content-type': 'application/json' }) },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw Error(`hybrid gateway ${response.status} on ${path.split('?')[0]}`)
    return response.json()
  }
  return {
    async configure(host, groups) {
      // Resolve at this send boundary, not at the earlier plan/roster read.
      // Secrets travel only to the existing host-owned authenticated gateway;
      // they are never stored in the plan, tick journal or status record.
      const accounts = groups.map(({ creds, plans }) => {
        if (!creds?.ready || creds.host !== host || !plans.length
          || plans.some(p => p.accountId !== String(creds.accountId) || p.host !== host)) throw Error('hybrid account routing mismatch')
        const accessToken = typeof creds.resolveAccessToken === 'function' ? creds.resolveAccessToken(creds) : creds.accessToken
        if (![accessToken, creds.clientId, creds.clientSecret].every(v => typeof v === 'string' && v.trim())) throw Error('hybrid current credentials unavailable')
        return { accountId: String(creds.accountId), clientId: creds.clientId, clientSecret: creds.clientSecret, accessToken, plans }
      })
      return call(host, 'POST', '/hybrid-profit/config', { host, accounts })
    },
    events: host => call(host, 'GET', '/hybrid-profit/events?wait=1'),
    acknowledge: (host, eventId) => call(host, 'POST', '/hybrid-profit/ack', { eventId }),
  }
}
