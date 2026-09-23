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

## Review follow-up and expanded release proposal - 24 September 2026

The fresh review correctly found that the gateway's actual ScannerMirror caller
discarded a batch after any non-202 reply. The earlier synthetic client retried;
that result therefore never proved lossless gateway-to-scanner transport.

The correction retains the identical serialized batch while retrying transient
transport errors, HTTP 408/429 and server errors. It permits at most six attempts
with 5/10/20/40/80 ms backoff; each existing HTTP call remains bounded at 2 seconds.
The quote producer still performs only a bounded ring push and never waits.
Later records do not overtake the retained batch. Permanent rejection and retry
exhaustion remain counted losses, with explicit gap/rewarm on the next record.
The bounded queue and 256-record consumer batch are unchanged. New counters
separate attempts, retried records, pending records, permanent rejection and
retry exhaustion. This is not durable across gateway restart: a new feed epoch
still explicitly resets observation continuity.

Focused tests cover identical-byte retries, ambiguous transport replay, sequence
order, permanent rejection, bounded exhaustion/recovery, nonblocking quote
ingestion and actual loopback HTTP 429/202/403/503/408 handling. Complete cpp-exec
CI, including its applicable threading tests, is required before release.

**New approval required:** this follow-up changes `cpp-exec/**`, so the current
Railway filters now redeploy BOTH broker gateways as well as Node and the tick
scanner. The earlier scanner-only release scope does not cover those additional
gateway restarts. Keep #1048 held until the owner approves this exact expansion.
Neither scanner feed, trading activation, credentials, notification policy nor
any broker order/position may be changed. No deliberate outage drill is included.

Proposed verification: after green repository/native gates, merge #1048; verify
the four expected deployments, both unchanged feed-OFF configurations and fresh
seven-account independent protection receipts. Abort the rollout/acceptance on
unhealthy services, unexpected service changes or degraded protection coverage;
do not alter positions to make the test pass. Roll back affected services to
their pre-release images with feeds still OFF. The pre-follow-up gateway images
are `4d0ff3e6-edcb-46dc-aec1-7b0459c7f46b` (exec) and
`9dc816ab-5bab-4b3a-be76-3859016ccbb1` (account gateway); the tick image is
`3350d396-4b70-4297-a052-4cbd3e6cf48c`. Record the then-current Node image before
release. Rollback restores the known transport/ingress limitation; it does not
establish full V3 acceptance or trading readiness.
