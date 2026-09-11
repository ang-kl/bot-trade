// cpp-exec/src/tests/test_tick_strategy.cpp — P4: the live implementation
// agrees with the reference oracle (agent/lib/tick-strategy.js) signal for
// signal on the checked-in fixture, and the profile hash is the same
// string on both sides. Run from cpp-exec/ (the Makefile does).
#include <cassert>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "../json.hpp"
#include "../tick_strategy.hpp"

using namespace tick;

static std::string slurp(const char* path) {
  std::ifstream f(path);
  assert(f && "fixture missing — run from cpp-exec/");
  std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

static StrategyParams paramsFrom(const jsn::Value& p) {
  StrategyParams s;
  s.rangeEvents = static_cast<int>(p.get("rangeEvents").asNumber(256));
  s.momentumEvents = static_cast<int>(p.get("momentumEvents").asNumber(64));
  s.minEfficiency = p.get("minEfficiency").asNumber(0.4);
  s.spreadBufferMult = p.get("spreadBufferMult").asNumber(0.5);
  s.confirmations = static_cast<int>(p.get("confirmations").asNumber(2));
  s.stopVolMult = p.get("stopVolMult").asNumber(2);
  s.minStopPrice = static_cast<long long>(p.get("minStopPrice").asNumber(1));
  s.priceIncrement = static_cast<long long>(p.get("priceIncrement").asNumber(1));
  s.maxSpread = static_cast<long long>(p.get("maxSpread").asNumber(1000000));
  s.maxQuoteAgeMs = static_cast<long long>(p.get("maxQuoteAgeMs").asNumber(60000));
  s.expiryEvents = static_cast<int>(p.get("expiryEvents").asNumber(256));
  s.rearmCooldownEvents = static_cast<int>(p.get("rearmCooldownEvents").asNumber(64));
  return s;
}

int main() {
  auto fixture = jsn::parse(slurp("src/tests/fixtures/tick_momentum_fixture.json"));
  auto expected = jsn::parse(slurp("src/tests/fixtures/tick_momentum_expected.json"));
  assert(fixture && expected);
  const StrategyParams params = paramsFrom(fixture->get("params"));
  TickMomentumStrategy strat(params);
  assert(strat.profileHash() == expected->get("profileHash").asString());

  std::vector<TickSignal> got;
  for (const auto& e : fixture->get("events").asArray()) {
    StrategyQuote q;
    q.seq = static_cast<uint32_t>(e.get("seq").asNumber(0));
    q.recvMs = static_cast<uint64_t>(e.get("recvMs").asNumber(0));
    q.hasBid = e.get("bid").isNumber(); q.hasAsk = e.get("ask").isNumber();
    q.bid = static_cast<long long>(e.get("bid").asNumber(0)); q.ask = static_cast<long long>(e.get("ask").asNumber(0));
    q.snapshot = e.get("snapshot").asBool(false); q.crossed = e.get("crossed").asBool(false); q.changed = e.get("changed").asBool(true);
    if (auto s = strat.onQuote(q)) got.push_back(*s);
  }
  const auto& want = expected->get("signals").asArray();
  std::printf("signals: got %zu, expected %zu\n", got.size(), want.size());
  assert(got.size() == want.size());
  for (size_t i = 0; i < want.size(); ++i) {
    const auto& w = want[i];
    const TickSignal& g = got[i];
    assert(g.seq == static_cast<uint32_t>(w.get("seq").asNumber(0)));
    assert(g.side == w.get("side").asString());
    assert(g.trigger2 == static_cast<long long>(w.get("trigger2").asNumber(0)));
    assert(g.bid == static_cast<long long>(w.get("bid").asNumber(0)) && g.ask == static_cast<long long>(w.get("ask").asNumber(0)));
    assert(g.stopDistance == static_cast<long long>(w.get("stopDistance").asNumber(0)));
    assert(g.setupId == static_cast<int>(w.get("setupId").asNumber(0)));
    assert(g.confirmations == static_cast<int>(w.get("confirmations").asNumber(0)));
    assert(g.H == static_cast<long long>(w.get("H").asNumber(0)) && g.L == static_cast<long long>(w.get("L").asNumber(0)) && g.B == static_cast<long long>(w.get("B").asNumber(0)));
    assert(g.D == static_cast<long long>(w.get("D").asNumber(0)));
  }
  // the rejections the fixture plants: a snapshot, a one-sided update, a crossed quote; one repeat; one stale gap
  assert(strat.rejected().invalid == 3 && strat.rejected().repeat == 1 && strat.rejected().stale == 1);
  // no signal from an unwarmed strategy, ever
  TickMomentumStrategy cold(params);
  for (int i = 0; i < params.rangeEvents; ++i) { StrategyQuote q; q.seq = i + 1; q.recvMs = 1000 + i; q.hasBid = q.hasAsk = true; q.bid = 1000 + i * 50; q.ask = q.bid + 10; assert(!cold.onQuote(q)); }
  assert(cold.state() == SetupState::WARMING);
  // 11-09-2026 audit (plan §4/§5): a continuity break re-warms. An ARMED
  // strategy fed a snapshot (what the worker marks a gap as) or a one-sided
  // update drops its window and needs N+1 fresh prior events again.
  for (int mode = 0; mode < 2; ++mode) {
    TickMomentumStrategy w(params);
    uint32_t seq = 0; uint64_t t = 1'000'000;
    auto quiet = [&](bool snapshot, bool oneSided) {
      StrategyQuote q; q.seq = ++seq; t += 50; q.recvMs = t; q.changed = true; q.crossed = false; q.snapshot = snapshot;
      q.hasBid = true; q.hasAsk = !oneSided; q.bid = 100000 + (seq % 7) * 2; q.ask = 100010 + (seq % 7) * 2;
      return w.onQuote(q);
    };
    for (int i = 0; i < params.rangeEvents + 2; ++i) quiet(false, false);
    assert(w.state() == SetupState::ARMED);
    quiet(mode == 0, mode == 1);
    assert(w.state() == SetupState::WARMING);
    for (int i = 0; i < params.rangeEvents; ++i) quiet(false, false);
    assert(w.state() == SetupState::WARMING); // N prior events are not enough
    quiet(false, false); quiet(false, false);
    assert(w.state() == SetupState::ARMED);   // N+1 prior events and one inside the range
  }
  std::puts("test_tick_strategy: all passed");
  return 0;
}
