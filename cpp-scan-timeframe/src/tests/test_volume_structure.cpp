#include "../volume_structure.hpp"
#include "../json.hpp"
#include <cassert>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
static void equal(double a, double b) { if (std::fabs(a-b) > 1e-9) std::cerr << a << " != " << b << '\n'; assert(std::fabs(a-b) <= 1e-9); }
int main() {
  std::ifstream f("src/tests/fixtures/volume-parity.json"); assert(f); std::stringstream s; s << f.rdbuf();
  const auto fixture = *jsn::parse(s.str());
  for (const auto& row : fixture.get("calendar").asArray()) equal(tfscan::fxDayOpenMs(row.get("t").asNumber()),row.get("open").asNumber());
  for (const auto& row : fixture.get("structures").asArray()) {
    std::vector<bt::Bar> bars;
    for (const auto& b : row.get("bars").asArray()) bars.push_back({b.get("t").asNumber(),b.get("o").asNumber(),b.get("h").asNumber(),b.get("l").asNumber(),b.get("c").asNumber(),b.get("v").asNumber()});
    const auto actual = tfscan::volumeStructure(bars); const auto& expected = row.get("expected");
    assert(actual.valid == !expected.isNull()); if (!actual.valid) continue;
    equal(actual.openMs,expected.get("openMs").asNumber()); equal(actual.sessionBars,expected.get("sessionBars").asNumber());
    equal(actual.prev.pocPrice,expected.get("prev").get("vpoc").asNumber());
    equal(actual.prev.vahPrice,expected.get("prev").get("vah").asNumber()); equal(actual.prev.valPrice,expected.get("prev").get("val").asNumber());
    assert(actual.structure == expected.get("structure").asString()); assert(actual.migration == expected.get("migration").get("direction").asString());
    const auto& nodes = expected.get("lvns").asArray(); assert(actual.lvns.size() == nodes.size());
    for (size_t i = 0; i < nodes.size(); ++i) { equal(actual.lvns[i].first,nodes[i].get("lo").asNumber()); equal(actual.lvns[i].second,nodes[i].get("hi").asNumber()); }
  }
  bool refused = false; try { tfscan::fxDayOpenMs(4102444800000LL); } catch (const std::invalid_argument&) { refused = true; } assert(refused);
  std::cout << "New York session boundaries, DST changes, volume profiles, LVNs and migration match JavaScript\n";
}
