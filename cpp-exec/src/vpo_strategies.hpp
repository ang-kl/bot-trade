// cpp-exec/src/vpo_strategies.hpp
//
// Concrete StrategyModule implementations for the Virtual Pending Order
// engine. Two are REAL, ported implementations (VwapTrendStrategy,
// VpValueStrategy) — the two the owner's prompts named directly ("VWAP and
// Volume Profile"). The other five requested names (EMA, BRK, C&H, FIBC,
// RSI) are honest STUBS: they compile, register, and report their key, but
// recompute() never arms them. Faking their trading logic without porting
// and verifying it against the real JS strategies (ema-pullback.js,
// donchian-breakout.js, cup-handle.js, fib-confluence.js, rsi2-reversion.js)
// would be exactly the "fake results" the owner has repeatedly asked this
// codebase to avoid — each needs its own porting pass before it's real.
//
// IMPORTANT — indicator math vs. arm/trigger logic:
//   vpo_indicators.{hpp,cpp}'s atr()/vwapAnchored()/volumeProfile() are
//   byte-parity ports of agent/lib/indicators.js — same contract as
//   backtest.hpp's fib port.
//   The ARM/trigger decision below is NOT a byte-identical port of
//   vwap-trend.js / vp-value.js — those compute a SIGNAL on an already-
//   confirmed closed bar (the pullback already happened). A virtual
//   pending order instead has to ARM *before* the touch and wait — that is
//   the entire point of this engine — so recompute() here decides "is the
//   trend/profile setup currently valid" and arms the LEVEL itself as the
//   trigger, rather than requiring the touch to have already occurred.
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

// Honest stubs — see file header. Each simply reports its key and never
// arms until it gets its own real porting pass.
#define VPO_STUB_STRATEGY(ClassName) \
  class ClassName : public StrategyModule { \
  public: \
    using StrategyModule::StrategyModule; \
    void recompute(const std::vector<Bar>&, const std::vector<Bar>&) override { disarm(); } \
  }

VPO_STUB_STRATEGY(EmaPullbackStrategy);       // key="ema_pullback"  — TODO: port ema-pullback.js
VPO_STUB_STRATEGY(DonchianBreakoutStrategy);  // key="donchian_breakout" (owner's "BRK") — TODO: port donchian-breakout.js
VPO_STUB_STRATEGY(CupHandleStrategy);         // key="cup_handle" (owner's "C&H") — TODO: port cup-handle.js
VPO_STUB_STRATEGY(FibConfluenceStrategy);     // key="fib_confluence" (owner's "FIBC") — TODO: port fib-confluence.js
VPO_STUB_STRATEGY(Rsi2ReversionStrategy);     // key="rsi2_reversion" (owner's "RSI") — TODO: port rsi2-reversion.js

#undef VPO_STUB_STRATEGY

} // namespace vpo
