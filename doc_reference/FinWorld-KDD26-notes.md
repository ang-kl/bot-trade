# FinWorld (KDD '26) — reference notes for bot-trade

Source: *FinWorld: An All-in-One Open-Source Platform for End-to-End Financial
AI Research and Deployment*, Zhang, Zhao, Zong, Wang, An (NTU/SMU/Skywork),
KDD '26. Code: https://github.com/DVampire/FinWorld · arXiv:2508.02292.
CC-BY-4.0. Notes compiled 07-07-2026 for the bot-trade project.

## What the paper is

A research **platform** (not a strategy): 7-layer architecture (Config,
Dataset, Model, Training, Evaluation, Task, Presentation) unifying four
financial AI task families — time-series forecasting, algorithmic trading,
portfolio management, LLM applications — across ML (LightGBM/XGBoost),
DL (Transformer, PatchTST, TimeMixer, TimeXer…), RL (PPO, SAC, DQN, DDPG),
and LLM agents (GRPO-finetuned). Benchmarked on DJ30/SP500/SSE50/HS300,
daily+minute data 1995–2025, ~800M points, 2×H100.

## Task formulations (paper §3)

Notation: `x_{1:T} ∈ R^{N×T×D}` price history of N assets, D=OHLC dims;
`z_{1:T_ex} ∈ R^{T_ex×C}` exogenous covariates (indicators, sentiment, macro).

1. **Forecasting (Eq. 1)** — predict S-day *returns*, not prices (prices are
   non-stationary): `R̂_{T+1:T+S} = F_θ(x_{1:T}, z_{1:T_ex})`,
   with `R_t = x_t/x_T − 1`.
2. **Algorithmic trading (Eq. 2–3)** — (a) predictive: `ŷ = F_θ(x, z)` then a
   decision rule (buy if ŷ>τ, sell if ŷ<−τ, else hold); (b) RL: MDP with policy
   `π_θ(a_t|s_t)` maximizing `E[Σ r_t]`.
3. **Portfolio management (Eq. 4–5)** — weights `w_t ∈ Δ^{N+1}` (index 0 =
   cash), `Σ w_{t,i}=1, w≥0`; maximize `E[Σ U(w_t, x_t)]`.
4. **LLM applications (Eq. 6)** — `y = M_φ(D_1..D_K)` over multimodal inputs;
   GRPO (group-relative PPO) used for two-stage RL finetuning:
   stage 1 financial-reasoning datasets, stage 2 simulated trading envs
   (actions BUY/HOLD/SELL, reward = realized or risk-adjusted return).

## Metric formulas (paper Appendix D, Tables 6–7) — the reusable gold

Forecasting (per asset i, time t; ŷ predicted, y actual, R(·)=rank):

- **MAE** = (1/TN) Σ_t Σ_i |ŷ_{i,t} − y_{i,t}|
- **MSE** = (1/TN) Σ_t Σ_i (ŷ_{i,t} − y_{i,t})²
- **RankIC_t** = Spearman rank correlation across assets at time t
  = Σ_i (R(ŷ_{i,t})−R̄_ŷ)(R(y_{i,t})−R̄_y) / √(Σ(R(ŷ)−R̄_ŷ)²·Σ(R(y)−R̄_y)²)
- **RankIC** = (1/T) Σ_t RankIC_t
- **RankICIR** = mean(RankIC_t) / std(RankIC_t)

Trading/portfolio (return series `rets`, N periods per year, r_f risk-free,
V = cumulative value):

- **ARR** = (Π_t (1+r_t))^{N/T} − 1  — annualized compounded return
- **SR (Sharpe)** = (E[rets] − r_f)/Std(rets) × √N
- **MDD** = max_t [ (max_{s≤t} V_s − V_t) / max_{s≤t} V_s ]
- **CR (Calmar)** = ARR / |MDD|
- **DD (downside dev)** = √((1/T) Σ min(r_t − r_f, 0)²) × √N
- **SoR (Sortino)** = (E[rets] − r_f)/DD × √N
- **VOL** = Std(rets) × √N

Experimental conventions worth copying: transaction fee 1e-4, no leverage,
results averaged over 3 seeds, train/valid split at a fixed calendar date
(2023-05-01), per-stock normalization, Alpha158 feature set (145 dims).

## Headline empirical results (paper Tables 2–4)

- Forecasting: modern DL (TimeXer, TimeMixer) beats GBDT on MAE/MSE/RankIC.
- Trading: RL (SAC/PPO) tops most single stocks (e.g. SAC 101.55% ARR TSLA);
  **but** these are backtests on 2023–2025 validation of models trained on
  1995–2023 — a strongly trending mega-cap period. BUY&HOLD is competitive
  on several names, which the tables show honestly.
- LLM agents: RL-finetuned 7B models (FinWorld-RL-7B) beat their base models
  on financial reasoning benchmarks and trading sims.

## What bot-trade adopts from this paper

1. **Metric suite** — our backtest now reports ARR, Sharpe, Sortino, Calmar,
   VOL, MDD, expectancy per the exact formulas above (risk-free = 0,
   annualized by trades-per-year over the tested span). Implemented in
   `agent/scripts/backtest-fib.js`.
2. **Return-not-price principle** (§3.1) — already our practice; the fib
   engine works in relative price space and the backtest reports % returns.
3. **Honest baseline comparison** — FinWorld always shows BUY&HOLD next to
   fancy methods. Our GO/NO-GO gate is the same spirit: a strategy must beat
   doing nothing after costs.
4. **Radar/report presentation ideas** (App. B) — multi-metric radar chart of
   ARR/SR/MDD/CR/SoR/VOL is a candidate for the Tune backtest card.

## What bot-trade deliberately does NOT adopt (the critique)

- **RL/DL/LLM entry decisions.** FinWorld's own results carry the warning:
  its RL wins come from one 2-year trending window, single seeds ±3 runs,
  US mega-caps, zero slippage/latency modelling, full-long/full-short
  actions with no position sizing. None of that survives contact with a
  $50k retail forex account. Our deterministic fib rules stay.
- **Alpha158 factor mining.** 145 features on daily bars invites overfit;
  we keep 3 inputs (swings, ATR, optionally RSI).
- **The platform itself.** It's a Python research monorepo for H100 clusters,
  explicitly "not for live high-frequency trading". Our Railway agent + broker
  API is the deployment layer FinWorld lacks.

## Owner critique requested ("kitchen sink")

Wanting every tool is natural, but the paper itself demonstrates the trap:
with 20+ models benchmarked, the best model *differs per dataset and metric*
(TimeXer wins DJ30 forecasting, TimeMixer wins HS300; SAC wins TSLA, PPO wins
META). Kitchen sinks produce a menu, not a decision. What transfers to a
one-person real-money operation is the **measurement discipline** (the metric
formulas above), the **honest baselines**, and the **fixed-date train/test
split** — not the model zoo. We take the yardsticks, not the kitchen.
