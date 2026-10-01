// cpp-verify/src/tests/test_mae_chandelier_observe.cpp
// Standalone. Does not link the order engine. may_amend must stay false.
#include <cassert>
#include <iostream>
#include <vector>
#include "../mae_chandelier_observe.hpp"

int main() {
  std::vector<MaeBar> bars;
  for (int i = 0; i < 30; ++i) bars.push_back(MaeBar{101.0 + i, 99.0 + i, 100.0 + i});
  const MaeObserve row = mae_chandelier_observe(120, 112, bars);
  assert(row.may_amend == false);
  assert(row.mae == 8);
  assert(row.bars_ok);
  const MaeObserve bad = mae_chandelier_observe(0, 112, bars);
  assert(bad.may_amend == false);
  std::cout << "mae-chandelier-observe cpp-verify: may_amend false\n";
  return 0;
}
