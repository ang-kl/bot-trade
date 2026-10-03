// ---------------------------------------------------------------------------
// agent/lib/then-always.js — run `before`, then `after` exactly once whether
// or not `before` threw (Wave 2 row 2.1, S-2 small round, 26-09-2026).
//
// WHY. S-2 moved the momentum book out of the scan branch to the end of the
// cycle's symbols block (loop.js, after `} // end symbolsJson`). Every phase
// before it that has no try/catch of its own — the scan persist,
// rankHotSymbols, the llmBlocked read, runMonitorPhase — then threw straight
// to the cycle's catch and skipped the book's trail and exits for that
// cycle. The loop hands the whole pre-book region to `before` and the book to
// `after`, so one throw anywhere before the book no longer costs a cycle of
// stops and exits. The book stays once per cycle: it has one call site.
//
// CONTRACT
//   • `after` runs once, after `before` settles, and is handed `before`'s
//     error (null when `before` returned; a nullish throw is handed over as
//     an Error so `after` can still tell).
//   • `before`'s error is RETHROWN, as the same value, once `after` settles —
//     so the caller's own error accounting (the cycle catch: the main_loop
//     beat, recordError, the backoff counter) sees exactly what it did.
//   • `after`'s own throw never masks `before`'s error; when `before`
//     returned, `after`'s throw propagates as usual.
//   • When BOTH threw (27-09 follow-up (4), 03-10-2026): `after`'s error used
//     to be dropped on the floor — the book's own failure vanished behind the
//     pre-book one. It is now handed to `onAfterError(afterError, error)`
//     (default: console.error) and attached to the rethrown error as
//     `.afterError` when that error is an object, so the cycle catch's record
//     can name both. The rethrown value is still `before`'s error, unchanged
//     in identity.
// ---------------------------------------------------------------------------

export async function thenAlways(before, after, { onAfterError = defaultOnAfterError } = {}) {
  let threw = false
  let error
  try {
    await before()
  } catch (err) {
    threw = true
    error = err
  }
  let afterThrew = false
  let afterError
  try {
    await after(threw ? (error ?? new Error(`before() threw ${String(error)}`)) : null)
  } catch (err) {
    afterThrew = true
    afterError = err
  }
  if (threw) {
    if (afterThrew) {
      try { onAfterError(afterError, error) } catch { /* the report must not replace the error */ }
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        try { error.afterError = afterError } catch { /* frozen: the hook still saw it */ }
      }
    }
    throw error
  }
  if (afterThrew) throw afterError
}

function defaultOnAfterError(afterError, error) {
  console.error(`[thenAlways] after() also threw (not masking the first error "${String(error?.message ?? error)}"): ${String(afterError?.message ?? afterError)}`)
}
