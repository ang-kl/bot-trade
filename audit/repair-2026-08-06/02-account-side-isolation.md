# 02 — Account-side isolation (F-RISK-01)

Phase 2 of the Verified Defect Repair programme. Verified at
`cf2dbf9e01e3ede657a8d3c0b1c6d0d0f1849784`.

## Finding

**F-RISK-01 — live/demo account-side contamination.**

**Status:** repaired *before* this programme began, in #662. This document
records the verification at the programme's frozen SHA rather than claiming the
fix as programme work.

## Observation

`getCtraderCreds` computed `isLive` from either the caller's
`accountOverride.isLive` or the `ctrader_is_live` state key, used it locally to
select the host (`live.ctraderapi.com` vs `demo.ctraderapi.com`) and to filter
the enabled-account roster — and then **did not return it**.

## Causal chain

1. `getCtraderCreds` computes `isLive` and drops it from the returned object.
2. `sameSideAccountIds` reads `baseCreds?.isLive`.
3. That evaluates `!!undefined === false` on **every** call.
4. The demo side is therefore selected unconditionally, including for live
   credentials.
5. Live credentials sweep demo accounts, and any second **live** account is
   silently dropped from the daily loss cap and the profit ratchet.

The failure is silent by construction: a wrong-but-plausible roster produces no
error, and every downstream figure computed from it is self-consistent.

## Remedy

One line — `isLive` is returned from `getCtraderCreds`
(`agent/lib/ctrader-creds.js:60`), with the causal chain recorded in a comment
at the return site so a future edit cannot re-drop it without reading why it is
there.

## Verification at this SHA

- `agent/lib/ctrader-creds.js:53-60` — `host` is derived from `isLive`, and
  `isLive` is a property of the returned object.
- The roster query at `:41-43` filters `is_live = ?` on the same value, so the
  host and the roster cannot disagree.
- Cross-side selection is impossible by invariant: one sidecar session is one
  host, and the roster is filtered on the same flag that chose the host.

## Counter-evidence considered

The audits also asserted that demo accounts generate no evidence at all because
the two-sidecar split is unfinished. That is a **separate**, still-open finding
(F-CONN-01, Phases 2–3 of the split). It is not evidence against this repair
and is not claimed as fixed here.

## Economic effect

Before: a second live account was invisible to the daily loss cap and the
profit ratchet — a protection gap, not a sizing error.

After: both live accounts are swept.

## Policy boundary

None. Correctness fix; no threshold read or written.

## Rollback

Revert #662. Doing so restores the unconditional demo-side selection.

## Residual risk

None identified for this specific defect. The wider two-sidecar split
(F-CONN-01) remains open and is tracked separately.
