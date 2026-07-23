// cpp-exec/src/vpo_strategies.hpp
//
// Concrete StrategyModule implementations for the Virtual Pending Order
// engine. All seven of the owner's named strategies ("VWAP and Volume
// Profile", then "EMA, BRK, C&H, FIBC, RSI") are now real, ported
// implementations — see vpo_strategies.cpp for each one's provenance
// comment citing the JS module it was ported from
// (ema-pullback.js/donchian-breakout.js/cup-handle.js/fib-confluence.js/
// rsi2-reversion.js) and exactly which gates carried over vs. had to be
// adapted for the arm-before-touch model (see note below).
//
// IMPORTANT — indicator math vs. arm/trigger logic:
//   vpo_indicators.{hpp,cpp}'s atr()/vwapAnchored()/volumeProfile()/sma()/
//   ema()/rsi() are byte-parity ports of the equivalent JS indicator
//   helpers — same contract as backtest.hpp's fib port.
//   The ARM/trigger decision in each recompute() below is NOT a byte-
//   identical port of the JS strategy files — those compute a SIGNAL on an
//   already-confirmed closed bar (the setup already happened). A virtual
//   pending order instead has to ARM *before* the touch and wait — that is
//   the entire point of this engine — so recompute() here decides "is the
//   setup currently valid" and arms the LEVEL itself as the trigger, rather
//   than requiring the touch/breakout to have already occurred. Two
//   consequences worth knowing when reading each implementation:
//     1. Gates that can only be evaluated on the breakout/touch bar ITSELF
//        (e.g. donchian-breakout.js's and cup-handle.js's breakout-volume
//        checks) cannot be pre-verified before that bar exists, so they are
//        dropped rather than faked — each strategy's comment says so
//        explicitly where it applies.
//     2. Strategies whose JS signal already means "act at the current
//        price right now" (fib-confluence.js, rsi2-reversion.js) arm at the
//        CURRENT close as the trigger — the engine's next tick fires it
//        near-immediately, which is the faithful analogue of "this is
//        already true, trade it."
#pragma once

#include "vpo_strategy.hpp"

namespace vpo {

// VWAP trend-pullback, as a virtual pending order: while price sits on the
// trend side of a sloping anchored VWAP (built from the MICRO/15m bars —
// the level moves too fast to found on 4h aggregation), arm at the current
// VWAP price expecting a touch-and-bounce in the trend direction. Disarms
// the moment the trend condition itself breaks (VWAP stops sloping the
// right way, or price is already too far past it for a pullback thesis).
class VwapTrendStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="vwap_trend"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Volume-profile value-area rotation, as a virtual pending order: the
// profile (POC/VAH/VAL) is built from the MACRO/4h bars (a developing
// session's value area is a slower-moving structure — recomputing it off
// tick-by-tick 15m bars would just be noise). Arms at whichever value-area
// edge price is currently approaching, expecting a rotation back toward
// the POC.
class VpValueStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="vp_value"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// EMA20/EMA50 trend-pullback, as a virtual pending order: ported from
// agent/services/ema-pullback.js. Trend = EMA20 vs EMA50 order (20 above 50
// = uptrend). JS fires once the closed bar has ALREADY dipped to and closed
// back above EMA20 with the trend intact; this engine instead arms at the
// EMA20 price the moment that trend+proximity condition holds (close still
// on the trend side of the line, not yet pulled back more than
// MAX_PULLBACK_ATR), waiting for the next touch — same distToLine/
// kMaxPullbackAtr pattern as VwapTrendStrategy, using EMA20 as the line
// instead of anchored VWAP. Runs on the MICRO bars (a 20/50-period EMA
// cross needs the faster series to stay current intrabar).
class EmaPullbackStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="ema_pullback"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Donchian 20-bar range breakout ("BRK"), ported from
// agent/services/donchian-breakout.js. JS fires when the closed bar has
// ALREADY closed beyond the prior-20 high/low band on expanding volume;
// this engine arms at whichever band edge (hi for a long breakout, lo for a
// short one) price is currently closest to and waiting to test, same
// catch-radius pattern as VpValueStrategy's value-area edges. The volume
// filter cannot be pre-verified (it reads the breakout bar's OWN volume,
// which doesn't exist yet before the touch) so it's dropped rather than
// faked — see vpo_strategies.hpp's file header, point 1. Runs on the MICRO
// bars (channel + touch need to react to the faster series).
class DonchianBreakoutStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="donchian_breakout"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Cup & Handle breakout ("C&H"), ported from agent/services/cup-handle.js.
// JS fires when the closed bar has ALREADY broken above the
// handle/prior-2-bar high on expanding volume; this engine searches the
// same cup+handle structure (trend, rim, depth, round-bottom, handle
// length/retrace/taper gates — all evaluable from bars already observed)
// and, on the first qualifying candidate, arms at the breakout level
// itself, waiting for the touch. The breakout-volume gate is dropped for
// the same reason as DonchianBreakoutStrategy (needs the not-yet-existing
// breakout bar's own volume) — see file header, point 1. Runs on the MACRO
// bars: a 15-120 bar cup is a slow structure, the same reasoning
// VpValueStrategy uses for its profile.
//
// Both directions share ONE dir-parameterized search (vpo_strategies.cpp's
// recomputeCupHandle) so the gating logic can never drift between them —
// the exact structure cup-handle.js itself uses (searchCupHandle(dir)).
class CupHandleStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="cup_handle"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Inverted (bearish) Cup & Handle — cup-handle.js's dir=-1 branch, own
// `inv_cup_handle` key matching the Node registry, mirroring the classic
// pattern top-for-bottom: a rounded DOME between two roughly-level low
// rims, a handle drifting back up toward the rim, arming a SELL at the
// breakdown level (min of prior-2-bar lows and the handle low).
class InvCupHandleStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="inv_cup_handle"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Multi-Fibonacci confluence ("FIBC"), ported from
// agent/services/fib-confluence.js. Unlike the breakout strategies above,
// this JS signal already means "price is INSIDE a confluence zone right
// now, trade it" — there's no future touch to wait for, so this engine
// arms at the CURRENT close as the trigger (file header, point 2); the
// engine's next tick fires it almost immediately, the faithful analogue of
// "this is already true." relativeStopLoss/relativeTakeProfit are derived
// from the actual zone width (not a flat ATR multiple), mirroring the JS's
// zoneLo/zoneHi-based stop exactly. Runs on the MICRO bars (swing pivots
// need the faster series to stay current).
class FibConfluenceStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="fib_confluence"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

// Connors RSI(2) mean-reversion ("RSI"), ported from
// agent/services/rsi2-reversion.js. Same "already true, trade it now"
// shape as FibConfluenceStrategy — arms at the current close the instant
// the oversold/overbought-against-trend condition holds. The JS's
// MIN_TF_MIN=60 floor (the 2026-07-21 walk-forward lesson: this edge lives
// on 1h+ timeframes, not 5m-30m) has no direct timeframe string to check
// against here, so it's enforced structurally instead: this strategy reads
// the MACRO bars (VPO_MACRO_TF, default 4h — comfortably above the floor),
// never the micro series. Deploying this key requires VPO_MACRO_TF stay
// >=1h; there is no runtime guard for a misconfigured deployment.
class Rsi2ReversionStrategy : public StrategyModule {
public:
  using StrategyModule::StrategyModule; // key="rsi2_reversion"
  void recompute(const std::vector<Bar>& macroBars, const std::vector<Bar>& microBars) override;
};

} // namespace vpo
