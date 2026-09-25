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

/**
 * @param {(path: string) => Promise<any>} get  agentGet or a test double
 * @returns {Promise<{ prices: Record<string, any>, status: 'ok' | 'unavailable', reason: string | null }>}
 *   Never rejects: a failed read is a value, not an exception.
 */
export async function loadLatestPrices(get) {
  let body
  try {
    body = await get('/state/prices')
  } catch (error) {
    return { prices: {}, status: 'unavailable', reason: error?.message || 'the price read failed' }
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
