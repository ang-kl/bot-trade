> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 13 — Graham voting / weighing classification

## The finding, plainly

**There is no valuation pipeline anywhere in this repository.** No financial
statements, no normalised earnings or free cash flow, no balance-sheet strength, no
debt or liquidity analysis, no dilution, no valuation range, no margin of safety. All
twelve strategies are price-and-volume only, on horizons from minutes to days.

Under §16's short-run/long-run lens, every operation responds to **votes** — price,
momentum, liquidity, volatility, crowding — and **none** uses any **weight**.

## Graham's three-part test, applied literally

| Test | Verdict |
|---|---|
| 1. Thorough analysis | **partially met** — on price evidence only. Backtests exist and run. |
| 2. Safety of principal | **met in the bounded-survival sense** — per-trade risk %, daily loss cap, equity stop, position caps, and bracket enforcement in both engines. Not met in the promise-against-loss sense, which §3.2 says is not the right reading for leveraged trading. |
| 3. Adequate return after costs | **UNPROVEN** — spread, commission, slippage, swap, failed fills and latency were not measurable. |

## Classification

- FX, indices, commodities, leveraged CFDs → **BOUNDED SPECULATION**
- Equity CFDs (0066.HK, 0005.HK) → **UNCLASSIFIED — INSUFFICIENT EVIDENCE**, and under
  §3.1 they default to speculation: an equity traded on price patterns with no
  valuation input is not an investment because the underlying is a stock.

**Per §16 this is not a failure.** It would be a failure only if speculation were
mislabelled as investment, or if risk were unbounded. Neither is the case: nothing in
the codebase calls this investing, and the caps are real and enforced.

No separate investment module is recommended. §16 is explicit that one would require
audited statements, normalised earnings, balance-sheet strength, valuation range,
margin of safety, catalyst-independent holding logic, a much longer review cadence and
no leveraged-CFD assumption — an entirely separate system, and contaminating the
short-run logic with a fraction of it would be worse than not having it.
