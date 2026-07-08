# How professionals exercise algo quant — study notes & ground-up review of bot-trade

Owner brief (2026-07-08): "Think and propose ground-up change if necessary, as
you go through past PDFs and search around how [to] exercise algo quant."
Sources: our FinWorld KDD'26 notes, our microstructure notes, plus the
backtest-validation literature (Bailey & López de Prado's Deflated Sharpe
Ratio; purged/combinatorial cross-validation; walk-forward analysis frameworks
with majority-pass gates — links at bottom).

## 1. What the practice literature actually prescribes

1. **One backtest is one draw.** Walk-forward analysis (WFA) splits history
   into K sequential out-of-sample segments; a strategy must pass a
   *majority* of segments, with a *catastrophic veto* (any segment blowing
   past a drawdown cap kills it), and a final untouched holdout under
   parameter lock. "8–20 independent OOS tests, not one lucky window."
2. **Count your trials.** The Deflated Sharpe Ratio (Bailey–López de Prado)
   corrects for selection bias under multiple testing: if you looked at N
   strategy configurations and report the best, its Sharpe is inflated and
   must be deflated by a function of N and the variance across trials. >90%
   of published strategies fail live money — mostly this effect.
3. **Prefer parameter plateaus over optima; avoid repeated re-backtesting.**
   Every additional tuning pass consumes statistical validity.
4. **Purged CV / CPCV** for ML-heavy pipelines (train/test leakage control).
5. **Forward test is the real exam**: paper/demo results must be compared
   against backtest expectancy (the "reality gap"); promote to live only when
   the gap is small and the sample is real.

## 2. Ground-up review of bot-trade against that standard

**Verdict: the architecture does NOT need a ground-up change.** The things a
rebuild usually has to fix are already right here, some by design and some by
hard-won correction:

| Practice standard | bot-trade today |
|---|---|
| Backtest engine == live engine (no sim/live drift) | ✅ same `computeFibSignal`, same conviction bar, same cooldowns |
| Conservative fills & costs | ✅ next-open fills, 0.02% cost, SL-before-TP |
| Fixed parameters, no optimizer loop | ✅ 0.618/0.272/conviction-8 are fixed — tiny overfit surface (keep it that way) |
| Deterministic, auditable decisions | ✅ no LLM in the trade path; every decision in risk_events |
| Tail-risk beyond point estimates | ✅ bootstrap MDD p95, CVaR(95) |
| Forward-test gate before live money | ✅ graduation checklist (≥10 demo trades, PF≥1, funded account) |

**The real gaps are process-level, not architectural** — and they map exactly
onto the literature:

1. **Single-window verdicts.** Our GO/THIN/NO-GO comes from ONE 1,000-bar
   pass. WFA says: split into K segments, demand a majority of positive
   segments, veto on any catastrophic one. Without this, one lucky window can
   mint a GO.
2. **Uncounted multiple testing.** The backtest sweeps symbols × timeframes
   (× filters soon) — 40+ cells per run. Picking the best-looking cell and
   arming it is textbook selection bias; the Sharpe shown for that cell is
   inflated and should be discounted for the number of cells looked at.
3. **No reality-gap tracking.** Demo fills exist now; nothing yet compares
   live expectancy/PF against the backtest's cell that justified arming.

## 3. Proposal — "Evaluation v2" (process upgrade, no rebuild)

1. **Walk-forward verdicts** (`backtest-fib.js`): split each symbol×TF series
   into K=4 sequential segments; report per-segment totals; GO additionally
   requires ≥3/4 segments positive and no segment with MDD beyond a cap. UI
   shows a tiny 4-cell strip (▮▮▮▯) per row — evidence at a glance.
2. **Trials-aware honesty** (UI): the results footer states "you just looked
   at N cells — the best one is partly luck", and the evidence popover for
   any best-in-run cell notes the deflation caveat with the trial count.
   (Full DSR math optional later; the count + warning captures most of the
   value at zero risk.)
3. **Reality-gap card** (Monitor): once ≥5 closed demo trades exist for an
   armed symbol×TF, show backtest PF vs live PF side by side; a live PF
   under ~60% of backtest PF flags "gap — strategy behaving worse live".
4. **Keep rejecting**: parameter auto-optimization (plateau discipline —
   our fixed fib constants are a feature), ML/meta-labeling layers, new entry
   strategies without this same gauntlet, HFT/microstructure signals (see
   microstructure notes §2).

Effort: ~1 day. All three land in existing files; no schema/architecture
changes; each independently shippable in the usual PR flow.

## Sources

- Bailey & López de Prado, *The Deflated Sharpe Ratio* — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- *Purged cross-validation* — https://en.wikipedia.org/wiki/Purged_cross-validation
- CPCV vs walk-forward vs k-fold, PBO comparison — https://www.sciencedirect.com/science/article/abs/pii/S0950705124011110
- Walk-forward validation framework with majority-pass / catastrophic-veto gates — https://arxiv.org/abs/2512.12924 and https://arxiv.org/pdf/2603.09219
- Walk-forward optimization primer — https://blog.quantinsti.com/walk-forward-optimization-introduction/
- Double out-of-sample WFA — https://arxiv.org/abs/2602.10785
- Internal: `FinWorld-KDD26-notes.md`, `microstructure-frequent-trading-notes.md`
