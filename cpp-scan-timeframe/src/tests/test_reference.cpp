#include "../scanner.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
using jsn::Value;
static Value read(const char* path) {
  std::ifstream f(path); assert(f); std::stringstream s; s << f.rdbuf(); return *jsn::parse(s.str());
}
static bool same(const Value& a, const Value& b) {
  if (a.isNumber() && b.isNumber()) return std::fabs(a.asNumber() - b.asNumber()) <= 1e-9;
  if (a.isObject() && b.isObject()) {
    if (a.asObject().size() != b.asObject().size()) return false;
    for (const auto& [key,value] : a.asObject()) if (!b.asObject().count(key) || !same(value,b.get(key))) return false;
    return true;
  }
  return jsn::dump(a) == jsn::dump(b);
}
int main() {
  auto fixtures = read("src/tests/fixtures/reference-parity.json");
  auto all = fixtures.asArray();
  const auto optionsFixtures = read("src/tests/fixtures/ema-options-parity.json");
  for (const auto& row : optionsFixtures.asArray()) all.push_back(row);
  fixtures = all;
  std::map<std::string, std::map<std::string,int>> outcomes;
  for (const auto& fixture : fixtures.asArray()) {
    const auto& body = fixture.get("request");
    assert(body.get("profileHash").asString() == scan::nativeProfileHash(body.get("strategy").asString(),body.get("options")));
    const long long now = body.get("receivedAtMs").asNumber();
    scan::TimeframeScanner scanner([=] { return now; });
    assert(scanner.submit(body).get("queued").asBool()); scanner.flush();
    const auto page = scanner.results(0);
    assert(page.get("candidates").asArray().size() == 1);
    const auto& result = page.get("candidates").asArray().front();
    const auto& expected = fixture.get("expected");
    const auto& actual = result.get("candidate").get("signal");
    if (expected.isNull()) assert(result.get("outcome").asString() == "no_signal");
    else {
      assert(result.get("outcome").asString() == "candidate");
      for (const auto field : {"bias", "entry", "sl", "tp1", "tp2", "conviction", "rr", "time_cap_minutes",
                               "timeframe", "strategy", "direction_reason", "confluenceCount", "sl_atr_mult",
                               "sl_widened_to_floor", "stack_confirmed", "cup", "fvg"}) {
        if (!same(actual.get(field), expected.get(field)))
          std::cerr << body.get("strategy").asString() << "/" << fixture.get("name").asString() << "/" << field
                    << ": " << jsn::dump(actual) << " != " << jsn::dump(expected) << "\n";
        assert(same(actual.get(field), expected.get(field)));
      }
    }
    assert(result.get("strategy").asString() == body.get("strategy").asString());
    assert(!result.get("orderAuthority").asBool());
    outcomes[body.get("strategy").asString()][expected.isNull() ? "none" : expected.get("bias").asString()]++;
  }
  assert(outcomes.size() == 11);
  for (const auto& [strategy, sides] : outcomes) {
    if (strategy == "cup_handle") assert(sides.at("long") > 0 && !sides.count("short"));
    else if (strategy == "inv_cup_handle") assert(sides.at("short") > 0 && !sides.count("long"));
    else assert(sides.at("long") > 0 && sides.at("short") > 0);
    assert(sides.at("none") > 0);
    std::cout << strategy << ": frozen permitted directions and refused cases match JavaScript\n";
  }
  const auto pivots = read("src/tests/fixtures/pivots-parity.json");
  for (const auto& fixture : pivots.asArray()) {
    std::vector<bt::Bar> bars;
    for (const auto& b : fixture.get("bars").asArray()) bars.push_back({b.get("t").asNumber(), b.get("o").asNumber(),
      b.get("h").asNumber(), b.get("l").asNumber(), b.get("c").asNumber(), b.get("v").asNumber()});
    const auto swings = bt::findSwings(bars, bars.size());
    for (const auto& [key, actual] : std::vector<std::pair<std::string,std::vector<bt::SwingPoint>>>{{"highs", swings.highs},{"lows", swings.lows}}) {
      const auto& expected = fixture.get("expected").get(key).asArray();
      assert(actual.size() == expected.size());
      for (size_t i = 0; i < actual.size(); ++i) {
        assert(actual[i].idx == expected[i].get("idx").asNumber());
        assert(actual[i].price == expected[i].get("price").asNumber());
      }
    }
  }
  std::cout << "strict swing pivots reject tied highs, tied lows and flat plateaus\n";
}
