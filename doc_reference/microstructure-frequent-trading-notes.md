# Market Microstructure & Frequent Trading — study notes and critique

Owner-supplied brief (2026-07-08): "Quantitative trading success is fundamentally
rooted in micro-structure analysis and the law of large numbers…" citing
order-book imbalance, market making, spread mean-reversion, and four repos +
three papers. This document studies each claim, records the formulas, and — as
with the FinWorld notes — says honestly what bot-trade adopts and what it
rejects, with reasons.

> Source note: arxiv.org and safe-frankfurt.de are unreachable from the build
> sandbox (proxy 403), so the paper summaries below are from the published
> literature these URLs refer to (Cont–Kukanov–Stoikov line of OFI research;
> Jones 2013 HFT survey). The four GitHub repos WERE fetched and read
> (2026-07-08, second pass after the owner challenged the first version of
> this doc, which had summarised them from prior knowledge) — findings in §1.5.

---

## 1. The claims, with the actual math

### 1.1 Law of large numbers / why frequency helps

Per-trade expectancy with win rate `p`, average win `W`, average loss `L`:

```
E = p·W − (1−p)·L                      (expectancy per trade)
SE(Ê) = σ_trade / √N                   (standard error shrinks with √N)
t-stat = Ê·√N / σ_trade                (significance grows with √N)
SR_annual = SR_per_trade · √(trades/year)
```

This is the honest core of the brief: **edge quality is Ê/σ, but confidence
and annualized Sharpe scale with √N.** A market maker doing 10,000 trades/day
can prove a tiny edge in a week; a 4h swing strategy doing ~2 trades/week needs
*years* of live data for the same statistical confidence.

**Cuts both ways:** costs also aggregate with N. If per-trade cost `c`
(spread + commission + slippage) exceeds the raw edge, frequency multiplies
the loss with the same √N confidence. Retail frequent trading usually dies
here, not on signal quality.

### 1.2 Order-book imbalance (OBI) / order-flow imbalance (OFI)

Best-level imbalance:

```
OBI = (V_bid − V_ask) / (V_bid + V_ask)        ∈ [−1, +1]
```

Cont–Kukanov–Stoikov order-flow imbalance over a window (the arXiv 2004.08290
lineage): sum signed changes at the best quotes,

```
e_n  = ΔV_bid·1{bid unchanged/improved} − ΔV_ask·1{ask unchanged/improved}
OFI  = Σ e_n over the window
ΔP  ≈ β · OFI / AvgDepth               (price impact is ~linear in OFI,
                                        slope inversely prop. to depth)
```

Empirical findings the brief cites are real: short-horizon (seconds) returns
correlate strongly with OFI, and the Fed note's point is that when depth is
thin the *same* imbalance moves price more (impact amplification).

### 1.3 Market making

The market maker earns the quoted spread `s` per round trip, minus adverse
selection (getting filled just before the price moves against the inventory).
Canonical model (Avellaneda–Stoikov 2008):

```
reservation price  r(q,t) = mid − q·γ·σ²·(T−t)
optimal half-spread δ     = γσ²(T−t)/2 + (1/γ)·ln(1 + γ/k)
```

where `q` = inventory, `γ` = risk aversion, `k` = order-arrival decay. Profit
condition: spread earned > adverse selection + inventory risk. This *requires*
being at the top of the queue — a latency game.

### 1.4 Statistical arbitrage / spread mean reversion

Pairs trading on cointegrated assets; the spread `x` is modelled as
Ornstein–Uhlenbeck:

```
dx = θ(μ − x)dt + σ dW        z = (x − μ)/σ_x
```

enter at |z| > 2, exit near 0. Empirically repeatable but capacity-constrained
and regime-fragile (the correlated pair decouples exactly when you're sized up
— e.g. 2007 quant quake, documented in the Jones HFT survey's references).

### 1.5 The four repos, actually read

- **wilsonfreitas/awesome-quant** — an index, not code. 17 categories. The
  entries relevant to us: backtesting engines (Backtrader, vectorbt,
  Backtesting.py, nautilus_trader) and risk analytics (PyPortfolioOpt,
  Riskfolio-Lib, pyfolio/empyrical). Verdict: a map of the Python ecosystem;
  our stack is Node — the *methods* port, the libraries don't.
- **EliteQuant/EliteQuant** — despite the brief's "platform-agnostic
  collection … research-to-production workflows", it is **another link list**
  (platforms, libraries, company blogs; entries filtered at 100+ stars).
  No architecture, no code to adopt.
- **github.com/topics/quant-trading-framework** — 7 small repos; the flagship
  is `Krexibd/quant-trading` (VIX calculator via variance-swap replication —
  Riemann sum over an option strip; Monte Carlo price paths as Wiener
  processes, *with the author's own caveat that the i.i.d. assumption breaks
  on real markets*; Engle–Granger two-step cointegration pairs with ±1σ
  standardized-residual thresholds; Bollinger W/M and RSI head-shoulder
  pattern detection; MACD/Heikin-Ashi/London-Breakout/Dual-Thrust/SAR
  strategy scripts). Verdict: a strategy sampler. Its useful transferable
  idea is not any single strategy but the Monte Carlo mindset — a single
  historical path is one draw from a distribution.
- **dcajasn/Riskfolio-Lib** — the substantial one. 26+ convex risk measures
  in three families (dispersion: σ/MAD/GMD; downside: semi-σ, **CVaR**, EVaR,
  RLVaR, Tail Gini; drawdown: ADD, Ulcer, **CDaR**, EDaR, MDD) and optimizers
  (mean-risk with 4 objectives, Kelly log-utility, risk parity, HRP/HERC/NCO,
  Black-Litterman, worst-case MV). Needs a returns panel + covariance —
  i.e., a *portfolio* of simultaneous positions. We hold 1–3 sequential
  positions from one strategy, so the optimizers don't apply yet; the risk
  *measures* do.

**Adopted from this second pass (implemented in `backtest-fib.js`):**

```
CVaR(95)  = mean of the worst 5% of per-trade returns   (Riskfolio family)
MDD p95   = 95th-pct max drawdown over 1,000 bootstrap
            reshuffles of the trade sequence            (MC mindset, applied
                                                         to trades not prices
                                                         — no Wiener/i.i.d.
                                                         price assumption)
```

Both appear in the Tune → Backtest table. Rationale: our GO verdict rests on
~10 trades; the observed MDD is one lucky-or-unlucky ordering. Bootstrapping
the *same trades* answers "how bad could this exact edge have looked?" —
demo sanity check: 10 alternating trades showed 1.1% path-MDD but 4.8% p95.
Revisit Riskfolio's HRP/risk-parity only if the bot ever runs multiple
concurrent strategies/instruments as a true portfolio.

---

## 2. Critique — what the brief glosses over

1. **The edges it lists are latency- and access-gated.** OBI/market-making
   edges live at the top-of-book on sub-second horizons. Capturing them needs
   colocation (µs), exchange depth feeds, and maker fee schedules. Our stack is
   a retail cTrader JSON-over-WSS connection with ~100–300 ms round trips, a
   5-minute loop, and taker spreads. We would BE the adverse selection, not
   collect it. The Jones survey itself says HFT profits are concentrated in a
   handful of speed-race winners — it's an arms race, not an open buffet.
2. **cTrader Open API depth (SUBSCRIBE_DEPTH_QUOTES) is broker-internal.**
   Peppersone's book is its own liquidity pool, not the market; OBI computed on
   it predicts the broker's quote engine, not price discovery. Building OBI
   signals on it is kitchen-sinking (same trap the FinWorld critique flagged).
3. **"Liquidity provision" is not available to us at all.** Retail cTrader
   accounts cannot post inside the spread on FX — there is no maker rebate,
   no queue. Every trade we do pays the spread. Full stop.
4. **LLN is quietly an argument AGAINST our current stats.** Our 4h GO verdict
   rests on ~10 trades. By §1.1, t ≈ Ê√10/σ — weak. The honest reading is not
   "trade more often to fix it" (costs, point 1) but "hold the GO bar and let
   demo evidence accumulate; treat backtest GO as necessary, not sufficient."
   This is already how the graduation checklist is framed.
5. **Stat-arb pairs** need a second correlated instrument, cointegration
   monitoring, and separate risk plumbing — a second strategy engine. Rejected
   for focus, same reasoning as rejecting FinWorld's RL/factor-mining layers.

## 3. What bot-trade adopts (validated, small, real)

| Adoption | Why it survives the critique | Where |
|---|---|---|
| **Spread gate before every autotrade order** | The one microstructure cost we *can* measure with our access: live bid/ask right before entry. Spread is paid instantly; if it eats > `maxSpreadFracOfSL` (default 25%) of the SL distance, the approved R:R was fiction — veto and log it like any risk veto. Off-hours/rollover spread blowouts (the sessions.js warning) become enforced, not advisory. | `agent/loop.js` autoTrade + `risk.js` config `maxSpreadFracOfSL`, Tune → Risk → Trade quality |
| **Cost realism in backtests** | Already present (0.02%/side, SL-before-TP, next-open fills) — the brief's LLN-of-costs point is why it must stay. | `backtest-fib.js` |
| **Honest N** | Monitor/backtest copy keeps stating trade counts; GO threshold stays ≥10 trades + PF ≥ 1.1 with the explicit caveat that N≈10 is thin evidence. | Tune backtest verdict copy |
| **Session/liquidity awareness** | Thin-liquidity warning already exists; the spread gate now enforces it at the moment it matters. | `lib/sessions.js` + spread gate |

## 4. What is rejected, by name

- **Market making / liquidity provision** — no maker access, no rebates, no
  colocation; structurally impossible from a retail cTrader account.
- **OBI/OFI entry signals** — depth feed is broker-internal; horizon mismatch
  (seconds vs 4h); would be uninspectable noise in the risk gate.
- **HFT-style frequency increase** — our all-in cost per trade (spread ≈
  0.6–1.2 pips on majors + commission) versus sub-pip short-horizon edges:
  negative expectancy amplified √N times.
- **Pairs/stat-arb engine** — second strategy engine; violates the
  one-strategy-done-well decision made after the FinWorld review.

## 5. Answer to the brief's closing question

Asset class: **FX majors + XAUUSD** (broker: Pepperstone cTrader, demo
46130058). Frequency horizon: **4h/1d swing** — deliberately the opposite end
of the spectrum from HFT, because at retail access the only durable edges are
ones latency can't erode. Expected cadence ~1–2 trades/week; the buzzer is
Telegram, not the screen.

## Sources (owner-supplied)

- https://github.com/wilsonfreitas/awesome-quant
- https://github.com/topics/quant-trading-framework
- https://github.com/dcajasn/Riskfolio-Lib
- https://github.com/EliteQuant/EliteQuant
- https://arxiv.org/abs/2004.08290 (OFI & market impact)
- https://www.federalreserve.gov/econres/notes/feds-notes/order-flow-imbalances-and-amplification-of-price-movements-evidence-from-u-s-treasury-markets-20251103.html
- https://safe-frankfurt.de/…/SA2016_Jones-HFT-Survey-SSRN-id2236201-2013.pdf (Jones 2013, "What do we know about high-frequency trading?")
