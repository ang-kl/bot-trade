import { brokerReadCache } from '../../agent/lib/broker-read-scope.js'
import { agentPost, getAgentConn } from './agent-api.js'

// Share the existing broker READ between Performance and Desk. Current cached
// values paint immediately; this slower read refreshes the source independently.
export function createOverviewReader(read, options = {}) {
  const shared = brokerReadCache({ ttlMs: 60_000, ...options })
  return key => shared(key, async () => {
    const result = await read()
    if (!result?.ok || !Array.isArray(result.accounts)) throw Error('Broker snapshot unavailable')
    return result
  })
}
const read = createOverviewReader(async () => {
  const result = await agentPost('/actions/broker-positions', { accountId: 'all' })
  return result
})
export function refreshBrokerOverview() {
  const conn = getAgentConn()
  // A different operator credential must never receive the prior cached read.
  return read(`${conn.base}\u0000${conn.secret}`)
}
