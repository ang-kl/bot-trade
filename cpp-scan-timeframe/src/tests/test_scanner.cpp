#include "../scanner.hpp"
#include <cassert>
#include <fstream>
#include <sstream>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
Value read(const char* path) { std::ifstream f(path); assert(f); std::stringstream s; s << f.rdbuf(); return *jsn::parse(s.str()); }
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
    assert(scanner.status().get("work").asArray().front().get("lastCompletedAtMs").asNumber() == now);
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
  const auto identity = scan::identity(body);
  const auto one = scan::candidate(identity, "fib_618_fade", now, now, Value(), now, Value(), "1h");
  const auto four = scan::candidate(identity, "fib_618_fade", now, now, Value(), now, Value(), "4h");
  assert(one.get("candidateId").asString() != four.get("candidateId").asString());
  std::cout << "closed-bar native baseline matches frozen JavaScript; unsupported semantics and invalid bars refused\n";
}
