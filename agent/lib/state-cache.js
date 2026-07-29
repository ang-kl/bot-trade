// Shared read-cache handle for GET /state/* — and, crucially, the way a WRITE
// tells that cache it is out of date.
//
// THE CACHE WAS WRITE-BLIND. /state/* serves every GET from a 10-second
// response cache (state.js), which is the right call for aggregations that six
// polling tabs would otherwise recompute dozens of times a minute. But nothing
// invalidated it, so for up to ten seconds after a successful config write the
// agent kept serving the PRE-WRITE answer — and the UI saves, re-reads, and
// paints the old value back over the new one.
//
// Found 2026-07-29 while shipping per-symbol strategy arming: the Tune row
// reverted to its previous pick ~200ms after a save the agent had accepted and
// stored. Measured directly against the agent, with the browser out of the
// picture — POST, then three GETs, all three returning the superseded value.
//
// This is very likely the mechanism behind the owner's older report, "i feel
// not saved but actually is" (2026-07-28). That was answered with a persistent
// "last saved" line, which treated the symptom: the save HAD worked, and the
// screen was showing a cached copy of the world from before it.
//
// The fix is one shared epoch. Any successful non-GET on /actions/* bumps it;
// every cache entry stamped with an older epoch is dead on arrival. Dropping
// the whole cache on a write is deliberate — writes are rare next to reads, so
// the cost is one recompute, and per-key invalidation would need every route to
// declare which reads it affects, which is exactly the kind of bookkeeping that
// goes stale and silently reintroduces this bug.
let epoch = 0

/** Current cache epoch. Entries stamped with an older value must be ignored. */
export const stateEpoch = () => epoch

/** Called after any successful write — every cached read is now suspect. */
export function invalidateStateCache() {
  epoch += 1
  return epoch
}
