// ---------------------------------------------------------------------------
// agent/lib/verify-contract.js — the verdict contract version, keeper side.
//
// WHY A VERSION EXISTS AT ALL. A verdict is only as good as the rules that
// produced it, and those rules have been wrong. Until PR-AW cpp-verify
// compared cTrader's money integer against this keeper's dollars and disputed
// every record by exactly 100x. The fix was correct and REACHED NOTHING:
// `drainVerifyBacklog` re-arms records whose state is `unverified`, so a
// `disputed` verdict is terminal. Ten records wrongly disputed on 18-09-2026
// would have stayed disputed for ever, judged by a verifier that no longer
// exists — and the tally would have read `verified: 0` with nothing wrong.
//
// THE UNDERLYING GAP, stated plainly: `disputed` could not distinguish "the
// broker and the keeper genuinely disagree" from "the verifier was wrong when
// it asked". Only the first deserves to be terminal.
//
// So every verdict now carries the contract that produced it, and the backlog
// re-asks anything judged under an older one — once. A record re-disputed
// under the current contract is a real finding about the trading record.
//
// THIS IS THE SAME SHAPE AS PR-AU, one state along. There the re-verify cap
// stranded records whose attempts were spent against a verifier that could
// not answer; here the verdict itself stranded records judged by a verifier
// that answered wrongly. Both were rules that were right in general and wrong
// for records mishandled before the fix existed. The difference is that this
// one is a standing rule rather than a one-off repair: the next time the
// comparison changes, the re-ask happens by itself.
// ---------------------------------------------------------------------------

/**
 * MUST EQUAL `kVerdictContractVersion` in cpp-verify/src/verdict.hpp.
 * A test pins the two together, because a keeper that thinks the contract is
 * newer than the verifier's would re-ask the same records for ever, and one
 * that thinks it is older would never re-ask at all.
 *
 *   1 — original (PR-AE).
 *   2 — PR-AW: money scaled by the broker's moneyDigits, volume by 100,
 *       timestamps compared with a 1 s tolerance, volume read as a double.
 *   3 — fix-the-exits BC: volume compared in LOTS through the symbol's own
 *       lotSize, sent with the request from the broker's declaration in the
 *       lot-size registry; without one the volume is uncompared.
 */
export const VERDICT_CONTRACT_VERSION = 3

/**
 * Is a stored verdict older than the rules now in force?
 *
 * A NULL version means "recorded before verdicts carried one", which is every
 * verdict written before PR-AY — exactly the records this exists to rescue.
 * It is stale, not current: absent is not the same as up to date.
 */
export function verdictIsStale (version, current = VERDICT_CONTRACT_VERSION) {
  if (version == null) return true
  const n = Number(version)
  return Number.isFinite(n) ? n < current : true
}
