> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 07 — Opportunity and veto funnel

**STATUS: BLOCKED — DATA UNAVAILABLE.** No agent database is present. Executable
read-only queries: `evidence/data-queries.sql`. Machine stub: `machine/opportunity-funnel.json`.

## What is known without the DB

One funnel stage is proved by live measurement (05-08 12:26 UTC): the **connectivity
gate** at `loop.js:1173` skipped every demo-account dispatch — **965 `account_probe`
skips in 24h, 0 trades opened in 12h** against 87 the day before. See F-CONN-01. That
gate sits *before* strategy computation, so its victims never reach any later stage
and are invisible to every downstream funnel count.

## The unit problem — H05, `provisional`

`vetoBreakdown()` (`agent/services/veto-breakdown.js:74-76`) counts **skip rows** from
`decision_log`, honouring `?days` clamped to 1..90. Prompt §10 requires a **unique
opportunity identity** and forbids computing conversion rates by subtracting counts
in different units. A skip count is not an opportunity count: one opportunity blocked
by four gates and re-evaluated on twelve scans is one opportunity and forty-eight
rows.

This is why the owner's 7-day figure — 793 approved vs 46,380 vetoed, a 1.7% approval
rate — **cannot be read as "1.7% of opportunities were approved"**. The 32,115
`unknown_daily_pnl` rows are the clearest case: they are one unresolved closed trade,
logged 32,115 times.

Not a defect in `veto-breakdown` — it reports what it says it reports. It is a defect
in reading it as a conversion rate.

## BLOCKED

Per-gate: opportunities reached, gross vs unique vs overlapping veto counts, marginal
opportunities removed, risk avoided, positive opportunities missed, negative
opportunities avoided, and marginal change in expectancy/drawdown/risk-of-ruin. Plus
the entire §10.1 missed-signal taxonomy and the §10.2 counterfactual replay.
