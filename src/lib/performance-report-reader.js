import { agentGet, getAgentConn, pageAsleep } from './agent-api.js'
import { createReportQueue } from './report-read-queue.js'

const connectionKey = () => { const c = getAgentConn(); return `${c.base}\u0000${c.secret}` }
const read = createReportQueue((_key, path, connection) => {
  if (connectionKey() !== connection) throw Error('Connection changed before report refresh')
  return agentGet(path)
}, { canRead: () => !pageAsleep() })

export function readPerformanceReport(path) {
  const connection = connectionKey()
  return read(`${connection}\u0000${path}`, path, connection)
}
