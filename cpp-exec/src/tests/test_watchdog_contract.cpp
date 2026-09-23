#include "../watchdog_contract.hpp"
#include <cassert>
#include <iostream>
int main() {
  GatewayWorkView v; v.service = "cpp-acct"; v.host = "live.ctraderapi.com";
  v.now = 1800000000000LL; v.startedAt = v.now - 60000; v.connected = true; v.credentials = true;
  v.reconciles = {{11, v.now - 1000}, {22, 0}}; v.feedAccount = 11; v.quoteMaxAgeMs = 60000; v.quotes = {{7, v.now - 500}, {8, 0}};
  const auto first = gatewayWorkContract(v); v.now += 30000; const auto later = gatewayWorkContract(v);
  assert(first.get("workComplete").asBool()); assert(first.get("work").asArray().size() == 4);
  assert(jsn::dump(first.get("work")) == jsn::dump(later.get("work"))); // HTTP read never freshens receipts/deadlines
  assert(later.get("work").asArray()[1].get("lastCompletedAtMs").asNumber() == 0);
  assert(later.get("work").asArray()[3].get("lastQuoteAtMs").asNumber() == 0);
  v.quotes.resize(2049); assert(!gatewayWorkContract(v).get("workComplete").asBool());
  v.service = "wrong-service"; assert(!gatewayWorkContract(v).get("workComplete").asBool());
  std::cout << "gateway completed work retains original timestamps, absent receipts, identity and bounds\n";
}
