// GET /state/prices is the base tier of the Desk and Trade price maps: the
// newest close per symbol across every scan cycle. bracketMoney converts a
// quote-currency stop/target to USD through it, so when it is missing a
// cross's money reads "—".
//
// Before P1/P4 M2 a worker failure came back as 200 {prices:{}, error}, and
// the pages read `px?.prices || {}` — an unavailable read and an empty market
// looked identical (owner principle 6: the website shows no fake result). The
// route now answers 503 with a reason; this reader turns either shape into an
// explicit "unavailable" the page can say out loud.
//
// V3 M2b (M2 check nit 3): agentGet attaches the reply to the error it
// throws, so the note names WHY — the deadline, busy workers, a worker
// failure and its driver words — instead of repeating the route's generic
// "temporarily unavailable. Please retry." inside "Latest prices unavailable".

const REASON_WORDS = {
  performance_report_deadline: 'the price read ran past its time limit',
  performance_report_worker_capacity: 'every report worker was busy',
  performance_report_worker_exit: 'the report worker stopped before answering',
  performance_report_worker_error: 'the report worker failed',
}

/** The reason a failed read gives, from the reply agentGet attached. */
function failureReason(error) {
  const body = error?.body
  const code = typeof body?.reason === 'string' && body.reason ? body.reason : null
  if (!code) return { reason: error?.message || 'the price read failed' }
  const words = REASON_WORDS[code] || (/_bound$/.test(code) ? 'the report exceeds a fixed size bound' : 'the price read failed')
  const detail = typeof body.detail === 'string' && body.detail ? `: ${body.detail}` : ''
  const retryAfter = Number.isFinite(body.retryAfter) && body.retryAfter > 0 ? body.retryAfter : null
  const facts = [code, Number.isFinite(error.status) ? `HTTP ${error.status}` : null, retryAfter ? `retry after ${retryAfter} s` : null].filter(Boolean)
  return { reason: `${words}${detail} — ${facts.join(', ')}`, code, retryAfter }
}

/**
 * @param {(path: string) => Promise<any>} get  agentGet or a test double
 * @returns {Promise<{ prices: Record<string, any>, status: 'ok' | 'unavailable', reason: string | null,
 *   code?: string | null, retryAfter?: number | null }>}
 *   Never rejects: a failed read is a value, not an exception.
 */
export async function loadLatestPrices(get) {
  let body
  try {
    body = await get('/state/prices')
  } catch (error) {
    return { prices: {}, status: 'unavailable', ...failureReason(error) }
  }
  // An agent from before M2 still answers a failure as 200 {prices:{}, error}.
  if (body?.error) return { prices: {}, status: 'unavailable', reason: String(body.error) }
  if (!body || typeof body.prices !== 'object' || body.prices == null || Array.isArray(body.prices)) {
    return { prices: {}, status: 'unavailable', reason: 'the reply carried no price map' }
  }
  return { prices: body.prices, status: 'ok', reason: null }
}

/** The sentence a page shows when the base tier is unavailable, else null. */
export function latestPricesNote(read) {
  if (read?.status !== 'unavailable') return null
  return `Latest prices unavailable (${read.reason}). Cross-currency stop and target amounts may read "—" until the next refresh.`
}
