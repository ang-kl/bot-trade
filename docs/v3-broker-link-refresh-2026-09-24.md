# V3 broker-deal link refresh - 24 September 2026

## Refreshed starting point

PR #1064 is already merged as `add9b45c9b05da448c998117d9c371646241e114`.
Its final head `aaafdbb7296f69590be5652c5a0c9a6169ab329e` passed CI run
35951402095. The earlier failed fixture was corrected; it is not a current
CI blocker. The post-merge inline review `discussion_r4089587802` identifies
one remaining defect in the same change.

## Demonstrated defect and correction

`persistDeals` correctly computes a null match for an ambiguous, foreign or
unscoped identity, but its conflict-update statement used COALESCE to retain
an existing matched_trade_id. Re-import could report unmatched while the
stored deal remained attached to an arbitrary local trade. The downstream
price reconciler reads that stored link.

Persist the newly computed match, including null:

```sql
matched_trade_id = excluded.matched_trade_id
```

This is a link-metadata correction on the existing import path, not a money
repair or an automatic deduplication. The monetary assignments, aggregation,
rounding, timing, broker calls and risk/validation settings are unchanged.
No production import or reconciliation operation was invoked for this work.
No trade is selected as the authoritative AVY/GEV lifecycle based on dates.
Different local dates alone do not establish two genuine broker lifecycles.

## Verification question and stopping condition

For a previously linked deal, re-import must make the stored match and the
reported match agree, including when identity proof stops being unique.
The six repository regression tests exercise actual functions on disposable
SQLite fixtures:

1. A duplicate introduced after the first import clears the stale link;
   the real downstream reconciler examines no arbitrary trade.
2. A legacy foreign-account link is cleared.
3. Unscoped re-import clears an unproven link without rewriting account data.
4. A still-valid link survives repeated import and another account's same ID.
5. Repeated refusal remains idempotent and preserves known broker open time.
6. A cleared link can resolve again after uniqueness is restored in a fixture.

The tests compare all trade rows before/after and broker net/gross P&L, swap
and commission. Fixtures contain deliberate price/volume disagreements so
an accidentally retained link is observable by the downstream test.

A local Node 22.16.0 / SQLite 3.49.1 simulation of the retrieved function
reproduced the old defect for duplicate, unscoped and foreign-account cases.
The corrected assignment passed those three cases and the valid-link control,
with the money and trade snapshots unchanged. This is a focused simulation,
not a full local checkout or an independent production verification. The
current runtime cannot resolve github.com for a Git clone; the full repository
gate must therefore be executed and inspected through GitHub Actions.
No C++ source is changed. Do not weaken, skip or repeat passing unrelated
checks without an invalidating source change. Stop after the final PR gate and
review are resolved or a specific access/approval limitation is identified.

## Release and remaining evidence

Keep this follow-up on review hold until its complete CI is green and its
Node release is authorised. No Railway configuration, deployment, restart,
feed switch, trading switch, credential or broker position/order was changed.

There is no bulk migration: already-stored links outside a subsequent import
remain untouched. This patch does not resolve the AVY/GEV duplicate trade rows,
fill missing historical P&L, or prove that historical accounting is complete.
Those require separate broker/deal provenance and any applicable approval.

Rollback of a later authorised release restores the prior Node image/code;
it would restore the stale-link defect. It must not reinstate an arbitrary
match or adjust any monetary field to make an acceptance check pass.
