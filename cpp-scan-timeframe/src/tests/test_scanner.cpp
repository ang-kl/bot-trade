#include "../scanner.hpp"
#include <cassert>
#include <fstream>
#include <sstream>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
Value read(const char* path) { std::ifstream f(path); assert(f); std::stringstream s; s << f.rdbuf(); return *jsn::parse(s.str()); }
namespace {
constexpr long long HOUR = 3600000;
// One closed 1h bar for one registered cell, as Node's bridge sends it. The
// symbol varies the cell; the epoch is the producer process (Node mints a new
// one per process); `bar` picks which closed bar.
Value cellBody(int symbol, const std::string& epoch, long long bar, long long received, Value calendar = Value()) {
  const long long t = bar * HOUR;
  return Value(Object{{"schemaVersion", 1}, {"purpose", "mirror"},
    {"feed", Object{{"provider", "ctrader"}, {"host", "demo.ctraderapi.com"}, {"accountId", "46130058"}, {"symbolId", std::to_string(symbol)}}},
    {"feedEpoch", epoch}, {"configVersion", "tf-v1"}, {"profileHash", scan::nativeProfileHash("donchian_breakout")}, {"candidateTtlMs", HOUR},
    {"strategy", "donchian_breakout"}, {"timeframe", "1h"}, {"barMode", "closed"}, {"barDurationMs", HOUR}, {"options", Object{}},
    {"receivedAtMs", received}, {"sourceTimestampMs", t}, {"calendar", calendar},
    {"bars", Array{Value(Object{{"t", t}, {"o", 1.0}, {"h", 1.1}, {"l", 0.9}, {"c", 1.05}, {"v", 10.0}})}}});
}
struct Tally { int queued = 0, duplicate = 0, refused = 0; };
// Offers `cells` cells once each, flushing like the serial Node worker so the
// 32-job queue bound is never the reason for a refusal.
Tally offer(scan::TimeframeScanner& s, int cells, const std::string& epoch, long long bar, long long received, int first = 1) {
  Tally out;
  for (int i = 0; i < cells; ++i) {
    try { const auto r = s.submit(cellBody(first + i, epoch, bar, received)); if (r.get("duplicate").asBool()) ++out.duplicate; else ++out.queued; }
    catch (const std::runtime_error&) { ++out.refused; }
    if (i % 16 == 15) s.flush();
  }
  s.flush(); return out;
}
}
int main() {
  auto fixtures = read("src/tests/fixtures/fib-parity.json");
  for (const auto& fixture : fixtures.asArray()) {
    auto body = fixture.get("request"); body.set("profileHash", scan::fibProfileHash());
    const long long now = body.get("receivedAtMs").asNumber();
    scan::TimeframeScanner scanner([=] { return now; });
    assert(scanner.submit(body).get("queued").asBool()); scanner.flush();
    assert(scanner.submit(body).get("duplicate").asBool());
    const auto out = scanner.results(0); assert(out.get("candidates").asArray().size() == 1);
    const auto& result = out.get("candidates").asArray().front();
    const auto& expected = fixture.get("expected");
    if (expected.isNull()) assert(result.get("outcome").asString() == "no_signal");
    else {
      assert(result.get("outcome").asString() == "candidate");
      const auto& actual = result.get("candidate").get("signal");
      for (const auto field : {"entry", "sl", "tp1", "tp2", "conviction", "rr", "time_cap_minutes"})
        assert(std::fabs(actual.get(field).asNumber() - expected.get(field).asNumber()) < 1e-9);
      assert(actual.get("bias").asString() == expected.get("bias").asString());
      assert(result.get("candidate").get("timeframe").asString() == body.get("timeframe").asString());
    }
    // Completed with nothing queued: the cell is counted, and it is not work
    // (no per-bar deadline for cpp-verify to judge).
    assert(scanner.status().get("work").asArray().empty());
    assert(scanner.status().get("cells").get("lastCompletedAtMs").asNumber() == now);
    assert(scanner.status().get("cells").get("count").asNumber() == 1);
  }
  auto body = fixtures.asArray().front().get("request"); body.set("profileHash", scan::fibProfileHash());
  const long long now = body.get("receivedAtMs").asNumber(); scan::TimeframeScanner scanner([=] { return now; });
  const auto refuses = [&](Value v) { bool threw = false; try { scanner.submit(v); } catch (const std::invalid_argument&) { threw = true; } assert(threw); };
  auto bad = body; bad.set("strategy", "vwap_trend"); refuses(bad);
  bad = body; bad.set("options", Object{{"rsiFilter", true}}); refuses(bad);
  bad = body; bad.set("barMode", "partial"); refuses(bad);
  bad = body; bad.set("timeframe", "4h"); refuses(bad);
  bad = body; auto bars = bad.get("bars").asArray(); bars.back().set("t", now); bad.set("bars", bars); refuses(bad);
  assert(scanner.status().get("work").asArray().empty());
  auto ema = read("src/tests/fixtures/ema-options-parity.json").asArray().front().get("request");
  bad = ema; bad.set("profileHash",scan::nativeProfileHash("ema_pullback")); refuses(bad);
  bad = ema; auto settings = bad.get("options"); settings.set("minSlAtr",1.25); bad.set("options",settings); refuses(bad);
  for (const auto& settings : std::vector<Value>{Value(),Array{},Object{{"pendingSetup",true}}}) {
    bad = ema; bad.set("options",settings); refuses(bad);
  }
  bad = ema; settings = bad.get("options"); settings.set("pendingSetup",1); bad.set("options",settings); refuses(bad);
  bad = ema; settings = bad.get("options"); settings.set("maxSlAtr",-1); bad.set("options",settings); refuses(bad);
  bad = ema; settings = bad.get("options"); settings.set("extra",true); bad.set("options",settings); refuses(bad);
  assert(scanner.status().get("work").asArray().empty());
  auto rsi = read("src/tests/fixtures/rsi-options-parity.json").asArray().front().get("request");
  bad = rsi; bad.set("profileHash",scan::nativeProfileHash("rsi_meanrev")); refuses(bad);
  bad = rsi; bad.set("options",Object{{"minRr",1.2}}); refuses(bad);
  for (const auto& value : std::vector<Value>{Value(),Value("1"),Value(false),Value(-1),Value(1e16)}) {
    assert(scan::nativeProfileHash("rsi_meanrev",Object{{"minRr",value}}).empty());
    bad = rsi; bad.set("options",Object{{"minRr",value}}); refuses(bad);
  }
  assert(scan::nativeProfileHash("rsi_meanrev",Object{{"minRr",0},{"extra",true}}).empty());
  assert(scanner.status().get("work").asArray().empty());
  const auto identity = scan::identity(body);
  const auto one = scan::candidate(identity, "fib_618_fade", now, now, Value(), now, Value(), "1h");
  const auto four = scan::candidate(identity, "fib_618_fade", now, now, Value(), now, Value(), "4h");
  assert(one.get("candidateId").asString() != four.get("candidateId").asString());
  {
    // A producer restart must not reduce admissions. The plan's 690 cells
    // under Node epoch A, then the same bars from a restarted Node (epoch B):
    // duplicates, not 429s — the cell survives the epoch. The next bar from
    // epoch B lands in the same cells. Keyed with the epoch this read
    // 512 queued / 178 refused, then 0 queued / 690 refused.
    const long long received = 500 * HOUR;
    long long clock = received; scan::TimeframeScanner s([&] { return clock; });
    auto a = offer(s, 690, "epoch-a", 480, received);
    assert(a.queued == 690 && a.refused == 0);
    auto b = offer(s, 690, "epoch-b", 480, received);
    assert(b.duplicate == 690 && b.queued == 0 && b.refused == 0);
    auto next = offer(s, 690, "epoch-b", 481, received);
    assert(next.queued == 690 && next.refused == 0);
    const auto st = s.status();
    assert(st.get("cells").get("count").asNumber() == 690);
    assert(st.get("work").asArray().empty()); // nothing queued, nothing due
    // Every result carries its own epoch, so Node's reference join still sees it.
    const auto first = s.results(0), latest = s.results(static_cast<long long>(first.get("latestCursor").asNumber()) - 1);
    assert(first.get("latestCursor").asNumber() == 1380); // 690 + 690 evaluations; the 690 duplicates evaluated nothing
    assert(first.get("candidates").asArray().front().get("feedEpoch").asString() == "epoch-a");
    assert(latest.get("candidates").asArray().back().get("feedEpoch").asString() == "epoch-b");
  }
  {
    // The table holds 1024 cells across any number of epochs; a 1025th fresh
    // cell is refused while none is stale, and admitted once the least
    // recently offered idle cell has gone stale — which is then evicted.
    long long clock = 500 * HOUR; scan::TimeframeScanner s([&] { return clock; }, HOUR);
    for (const auto* epoch : {"e1", "e2", "e3"}) {
      auto t = offer(s, 1024, epoch, 480 + (epoch[1] - '1'), clock);
      assert(t.refused == 0 && t.queued == 1024);
    }
    assert(s.status().get("cells").get("capacity").asNumber() == 1024);
    assert(offer(s, 1, "e3", 482, clock, 1025).refused == 1);
    clock += HOUR - 1; // cells 2..1024 are re-offered; cell 1 is not
    assert(offer(s, 1023, "e4", 482, clock, 2).duplicate == 1023);
    assert(offer(s, 1, "e4", 482, clock, 1025).refused == 1); // cell 1 is idle but not yet stale
    clock += 1;
    assert(offer(s, 1, "e4", 482, clock, 1025).queued == 1);
    const auto cells = s.status().get("cells");
    assert(cells.get("count").asNumber() == 1024 && cells.get("evicted").asNumber() == 1);
    // The evicted cell was cell 1: it comes back as a new cell (and evicts
    // nothing, since every other cell was offered within the hour).
    assert(offer(s, 1, "e4", 482, clock, 1).refused == 1);
  }
  {
    // Work is exactly what is due. A job waits behind a running one for the
    // same cell: the row stays queued, due from the OLDEST waiting receipt,
    // and never leaves the list while a job for the cell is still queued.
    std::mutex m; std::condition_variable cv; int allowed = 0, calls = 0; const auto tester = std::this_thread::get_id();
    const long long received = 500 * HOUR;
    scan::TimeframeScanner s([&]() -> long long {
      if (std::this_thread::get_id() != tester) { std::unique_lock l(m); const int me = ++calls; cv.wait(l, [&] { return allowed >= me; }); }
      return received;
    });
    assert(s.submit(cellBody(7, "e1", 480, received - 5000)).get("queued").asBool());
    for (int i = 0; i < 2000 && [&] { std::lock_guard l(m); return calls; }() == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(s.submit(cellBody(7, "e1", 481, received - 1000)).get("queued").asBool());
    auto work = s.status().get("work").asArray();
    assert(work.size() == 1 && work.front().get("state").asString() == "queued");
    assert(work.front().get("pending").asNumber() == 2 && work.front().get("nextDueMs").asNumber() == received - 5000);
    { std::lock_guard l(m); allowed = 1; } cv.notify_all();
    for (int i = 0; i < 2000 && [&] { std::lock_guard l(m); return calls; }() < 2; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    work = s.status().get("work").asArray();
    assert(work.size() == 1 && work.front().get("state").asString() == "queued");
    assert(work.front().get("pending").asNumber() == 1 && work.front().get("nextDueMs").asNumber() == received - 1000);
    { std::lock_guard l(m); allowed = 2; } cv.notify_all();
    s.flush();
    assert(s.status().get("work").asArray().empty());
  }
  {
    // cpp-verify refuses a contract over 256 KiB (and its HTTP read stops at
    // 256 KiB), which reads as an unreachable scanner. A full table of 1024
    // cells, each offered with a production-sized calendar (about 1 KB),
    // must still publish a contract inside that bound.
    Array intervals; for (int i = 0; i < 20; ++i) intervals.push_back(Value(Object{{"fromMs", 1790000000000LL + i}, {"toMs", 1790000000100LL + i}}));
    const Value calendar(Object{{"identity", Object{{"provider", "ctrader"}, {"accountId", "46130058"}, {"host", "demo.ctraderapi.com"}, {"symbolId", "1"}}},
      {"source", "ctrader:ProtoOASymbol"}, {"version", "v1"}, {"observedAtMs", 1790000000000LL}, {"expiresAtMs", 1790086400000LL},
      {"fromMs", 1789300000000LL}, {"toMs", 1790172800000LL}, {"intervals", intervals}, {"sessionOpenedAtMs", Value()}, {"sessionId", Value()}, {"nextOpeningMs", Value()}});
    assert(jsn::dump(calendar).size() > 900);
    const long long received = 500 * HOUR; scan::TimeframeScanner s([=] { return received; });
    for (int i = 1; i <= 1024; ++i) { s.submit(cellBody(i, "e1", 480, received, calendar)); if (i % 16 == 0) s.flush(); }
    s.flush();
    const auto body = jsn::dump(s.status());
    assert(s.status().get("cells").get("count").asNumber() == 1024);
    assert(body.size() <= 256 * 1024);
  }
  std::cout << "closed-bar native baseline matches frozen JavaScript; unsupported semantics and invalid bars refused\n";
}
