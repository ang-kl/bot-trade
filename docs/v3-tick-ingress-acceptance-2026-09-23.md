# Tick scanner admission correction - 23 September 2026

The unchanged 500-stream, eight-client workload reproduced the ingress failure
at 20:31 SGT: 159,344 accepted and 35,156 dropped of 194,500 input records.
The existing 18:02 failure remains retained separately.

HTTP admission previously advanced each record sequence before the bounded
worker queue accepted it. Partial batches returned 202 with explicit drops,
and a retry could not recover records already marked submitted.

The scanner now checks available shard capacity for the entire nonduplicate
batch while holding the single-producer lock. A refused batch changes no
stream registry, sequence, source receipt or metadata. HTTP 429 permits a
bounded client retry. Queue size, worker count, strategy and gateway code are
unchanged; consumption can only increase space during this admission window.

At 20:44 SGT, the same workload accepted and processed all 194,500 records
with zero input drops in 3.546 seconds. Acknowledgement p95/p99 were
167.57/239.97 ms; concurrent health p99 10.25 ms; sampled RSS 41.23 MiB.
2,412 HTTP 429 responses were retried within the original fixed retry budget.
The 513th stream remained rejected, unauthenticated reads returned 401, and
orderAuthority remained false. Native tests cover wholly
refused batches, replayed prefixes, retry continuity and exact oracle signals.

[Raw before/after evidence](evidence/v3-tick-ingress-retry-2026-09-23.json).
This is ingress acceptance for one synthetic workload. Undrained comparison
output still reports its overwrite gap. Continuous collection, real feed
peaks, broker protection latency and production acceptance remain separate.
No production service, feed, trading flag or broker position was changed.

Release scope: only cpp-scan-tick needs this native change; verify actual Railway
watch filters before merging. A production rollout is not claimed or authorised
by this local result. Rollback restores the preceding scanner image with feeds
still disabled; it restores the known ingress limitation and cannot count as
lossless acceptance.

The first full gate caught a reference-copy invariant violation. The correction
now counts queued/in-progress work in the scanner wrapper, retaining byte-identical
shared worker/ring sources. The bound includes in-progress work conservatively.
The oracle and refusal tests remain in place; no test threshold was weakened.

Local merge-gate checks: complete backend suite (including native HTTP tests),
ESLint, 936 frontend tests, production build and no-green check executed. The
sole backend failure was the unchanged CPU-ratio timing assertion while two
full suites competed for CPU. Its unchanged seven-test file passed when run
alone on each tree. No skip or threshold change was introduced. Tick-readiness
HTTP timing tests ran separately (28 passed). CI must still pass on the PR.
