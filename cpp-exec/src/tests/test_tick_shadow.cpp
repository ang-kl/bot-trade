// cpp-exec/src/tests/test_tick_shadow.cpp — P6a: the shadow book fills and
// exits exactly as the reference replayer (agent/lib/tick-replay-sim.js)
// over the checked-in fixture, under two sim settings (the second with
// slippage, commissions and a hold cap); the ledger's cursor contract; and
// the ledger under concurrent writers and a reader (run under TSan too).
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../json.hpp"
#include "../tick_shadow.hpp"
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

static ShadowSim simFrom(const jsn::Value& j) {
  ShadowSim s;
  s.latencyMs = static_cast<long long>(j.get("latencyMs").asNumber(250));
  s.slippage = static_cast<long long>(j.get("slippage").asNumber(0));
  s.commissionPerSide = static_cast<long long>(j.get("commissionPerSide").asNumber(0));
  s.targetR = j.get("targetR").asNumber(3);
  s.minTargetToCost = j.get("minTargetToCost").asNumber(3);
  s.maxHoldEvents = static_cast<int>(j.get("maxHoldEvents").asNumber(0));
  s.maxHoldMs = static_cast<long long>(j.get("maxHoldMs").asNumber(6LL * 3600 * 1000));
  return s;
}

static void test_agrees_with_the_replayer() {
  auto fixture = jsn::parse(slurp("src/tests/fixtures/tick_momentum_fixture.json"));
  auto expected = jsn::parse(slurp("src/tests/fixtures/tick_shadow_expected.json"));
  assert(fixture && expected);
  const StrategyParams params = paramsFrom(fixture->get("params"));
  const std::string hash = expected->get("profileHash").asString();
  const auto& cases = expected->get("cases").asArray();
  assert(!cases.empty());
  for (size_t c = 0; c < cases.size(); ++c) {
    const auto& cs = cases[c];
    TickMomentumStrategy strat(params);
    assert(strat.profileHash() == hash);
    ShadowBook book(simFrom(cs.get("sim")), params.rangeEvents, 7, strat.profileHash());
    std::vector<ShadowTrade> got;
    for (const auto& e : fixture->get("events").asArray()) {
      StrategyQuote q;
      q.seq = static_cast<uint32_t>(e.get("seq").asNumber(0));
      q.recvMs = static_cast<uint64_t>(e.get("recvMs").asNumber(0));
      q.hasBid = e.get("bid").isNumber(); q.hasAsk = e.get("ask").isNumber();
      q.bid = static_cast<long long>(e.get("bid").asNumber(0)); q.ask = static_cast<long long>(e.get("ask").asNumber(0));
      q.snapshot = e.get("snapshot").asBool(false); q.crossed = e.get("crossed").asBool(false); q.changed = e.get("changed").asBool(true);
      if (auto closed = book.onQuote(q)) got.push_back(*closed);   // the book first
      if (auto sig = strat.onQuote(q)) book.offer(*sig);            // then the strategy's signal
    }
    const auto& want = cs.get("trades").asArray();
    std::printf("case %zu: trades got %zu, expected %zu; open at end %s\n", c, got.size(), want.size(), book.open() ? "yes" : "no");
    assert(got.size() == want.size());
    for (size_t i = 0; i < want.size(); ++i) {
      const auto& w = want[i]; const ShadowTrade& g = got[i];
      assert(g.side == w.get("side").asString());
      assert(g.signalSeq == static_cast<uint32_t>(w.get("signalSeq").asNumber(0)));
      assert(g.entrySeq == static_cast<uint32_t>(w.get("entrySeq").asNumber(0)));
      assert(g.exitSeq == static_cast<uint32_t>(w.get("exitSeq").asNumber(0)));
      assert(g.entry == static_cast<long long>(w.get("entry").asNumber(0)));
      assert(g.exit == static_cast<long long>(w.get("exit").asNumber(0)));
      assert(g.stop == static_cast<long long>(w.get("stop").asNumber(0)));
      assert(g.target == static_cast<long long>(w.get("target").asNumber(0)));
      assert(g.stopDistance == static_cast<long long>(w.get("stopDistance").asNumber(0)));
      assert(g.reason == w.get("reason").asString());
      assert(g.holdEvents == static_cast<int>(w.get("holdEvents").asNumber(0)));
      assert(g.holdMs == static_cast<uint64_t>(w.get("holdMs").asNumber(0)));
      assert(std::fabs(g.grossR - w.get("grossR").asNumber(0)) < 1e-9);
      assert(std::fabs(g.netR - w.get("netR").asNumber(0)) < 1e-9);
      assert(g.symbolId == 7 && g.profileHash == hash);
    }
    assert(book.open().has_value() == cs.get("openAtEnd").asBool(false));
    assert(book.rejected().cost == static_cast<uint64_t>(cs.get("rejected").get("cost").asNumber(0)));
    assert(book.rejected().noFill == static_cast<uint64_t>(cs.get("rejected").get("noFill").asNumber(0)));
  }
}

static void test_cost_screen_and_busy_book() {
  ShadowSim sim; sim.minTargetToCost = 3; sim.targetR = 3;
  ShadowBook book(sim, 64, 1, "h");
  TickSignal wide; wide.side = "BUY"; wide.seq = 5; wide.recvMs = 1000; wide.bid = 1000; wide.ask = 1100; wide.stopDistance = 50; // target 150 vs cost 100 → 1.5 < 3
  assert(!book.offer(wide) && book.rejected().cost == 1 && !book.hasPending());
  TickSignal tight = wide; tight.ask = 1010; // target 150 vs cost 10 → 15 ≥ 3
  assert(book.offer(tight) && book.hasPending());
  assert(!book.offer(tight) && book.rejected().noFill == 1);
  // not filled before the latency, filled at the first tradable event after it
  StrategyQuote q; q.hasBid = q.hasAsk = true; q.bid = 1000; q.ask = 1010; q.seq = 6; q.recvMs = 1200;
  assert(!book.onQuote(q) && !book.open());
  q.seq = 7; q.recvMs = 1300; q.crossed = true;               // a crossed quote is not tradable
  assert(!book.onQuote(q) && !book.open());
  q.crossed = false; q.seq = 8; q.recvMs = 1350; q.ask = 1012;
  assert(!book.onQuote(q) && book.open() && book.open()->entry == 1012 && book.open()->stop == 962 && book.open()->target == 1162 && book.open()->entrySeq == 8);
  // a gap through the stop fills where the price was, not at the stop
  q.seq = 9; q.recvMs = 1400; q.bid = 900; q.ask = 910;
  auto t = book.onQuote(q);
  assert(t && t->reason == "stop" && t->exit == 900 && t->grossR == -2.24 && !book.open());
}

static void test_reset_marks_never_drops() {
  ShadowSim sim; sim.minTargetToCost = 1;
  ShadowBook fresh(sim, 64, 1, "h");
  assert(!fresh.markAtLast("reset") && "nothing open, nothing marked");
  ShadowBook book(sim, 64, 1, "h");
  TickSignal sg; sg.side = "SELL"; sg.seq = 1; sg.recvMs = 1000; sg.bid = 2000; sg.ask = 2010; sg.stopDistance = 100;
  assert(book.offer(sg));
  StrategyQuote q; q.hasBid = q.hasAsk = true; q.seq = 2; q.recvMs = 1300; q.bid = 2000; q.ask = 2010;
  assert(!book.onQuote(q) && book.open() && book.open()->entry == 2000);
  q.seq = 3; q.recvMs = 1400; q.bid = 1950; q.ask = 1960;          // the last executable side
  assert(!book.onQuote(q));
  q.seq = 4; q.recvMs = 1500; q.crossed = true; q.bid = 1; q.ask = 0; // not tradable: must not become "last"
  assert(!book.onQuote(q));
  auto t = book.markAtLast("reset");
  assert(t && t->reason == "reset" && t->exit == 1960 && t->exitSeq == 3 && t->grossR == 0.4 && t->holdEvents == 1 && t->holdMs == 100);
  assert(!book.open() && !book.hasPending());
  // a pending (unfilled) signal at a reset is simply forgotten — no trade was ever on
  ShadowBook pend(sim, 64, 1, "h");
  assert(pend.offer(sg) && !pend.markAtLast("reset") && !pend.hasPending());
}

static void test_ledger_cursor_and_threads() {
  ShadowLedger led(8);
  assert(led.latestSeq() == 0 && led.since(0).empty());
  ShadowTrade t; t.side = "BUY"; t.symbolId = 3; t.netR = 1.5; t.reason = "target";
  for (int i = 0; i < 10; ++i) { t.signalSeq = static_cast<uint32_t>(i); led.record(t); }
  assert(led.latestSeq() == 10 && led.total() == 10);
  auto all = led.since(0);
  assert(all.size() == 8 && all.front().first == 3 && all.back().first == 10); // the ring keeps the newest 8
  assert(led.since(9).size() == 1 && led.since(10).empty());
  auto dump = jsn::parse(led.dumpJson(9, led.bootId()));
  assert(dump && dump->get("trades").asArray().size() == 1 && dump->get("bootId").asString() == led.bootId());
  auto stale = jsn::parse(led.dumpJson(9, "other-boot"));
  assert(stale && stale->get("trades").asArray().size() == 8); // a bootId mismatch hands over the whole ring
  const auto& tj = dump->get("trades").asArray()[0];
  assert(tj.get("seq").asNumber() == 10 && tj.get("netR").asNumber() == 1.5 && tj.get("side").asString() == "BUY" && tj.get("symbolId").asNumber() == 3);
  // two worker threads recording while a reader dumps — the ledger's mutex is the only shared state
  ShadowLedger shared(64);
  std::atomic<bool> stop{false};
  std::thread reader([&] { while (!stop.load()) { (void)shared.dumpJson(0, shared.bootId()); (void)shared.since(0); } });
  std::vector<std::thread> writers;
  for (int w = 0; w < 2; ++w) writers.emplace_back([&, w] { ShadowTrade x; x.symbolId = w; for (int i = 0; i < 500; ++i) shared.record(x); });
  for (auto& th : writers) th.join();
  stop.store(true); reader.join();
  assert(shared.total() == 1000 && shared.since(0).size() == 64);
}

int main() {
  test_agrees_with_the_replayer();
  test_cost_screen_and_busy_book();
  test_reset_marks_never_drops();
  test_ledger_cursor_and_threads();
  std::puts("test_tick_shadow: all passed");
  return 0;
}
