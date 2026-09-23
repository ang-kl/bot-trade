#include "../scanner.hpp"
#include <cassert>
#include <fstream>
#include <sstream>
#include <set>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
Value read(const char* path) { std::ifstream f(path); assert(f); std::stringstream s; s << f.rdbuf(); return *jsn::parse(s.str()); }
Value batch(const Value& fixture, const Value& expected, const std::string& account, const std::string& host = "demo.ctraderapi.com") {
  Array rows;
  for (const auto& e : fixture.get("events").asArray()) {
    int flags = (e.get("bid").isNumber() ? 1 : 0) | (e.get("ask").isNumber() ? 2 : 0)
      | (e.get("snapshot").asBool() ? 16 : 0) | (e.get("crossed").asBool() ? 32 : 0) | (e.get("changed").asBool() ? 0 : 64);
    rows.push_back(Value(Object{{"sequence", e.get("seq")}, {"sourceSequence", e.get("seq")},
      {"receivedAtMs", e.get("recvMs")}, {"sourceTimestampMs", Value()}, {"flags", flags}, {"bid", e.get("bid")}, {"ask", e.get("ask")}}));
  }
  return Value(Object{{"schemaVersion", 1}, {"purpose", "mirror"}, {"feed", Object{{"provider", "ctrader"},
    {"host", host}, {"accountId", account}, {"symbolId", "7"}}}, {"feedEpoch", "gateway-epoch-1"},
    {"configVersion", "fixture-v1"}, {"profileHash", expected.get("profileHash")}, {"profile", fixture.get("params")},
    {"candidateTtlMs", 3600000}, {"records", rows}});
}
void matches(const Value& c, const Value& w) {
  assert(c.get("sourceSequence").asNumber() == w.get("seq").asNumber());
  const auto& s = c.get("signal");
  for (const auto name : {"side", "trigger2", "bid", "ask", "stopDistance", "setupId", "confirmations", "H", "L", "B", "D"})
    assert(jsn::dump(s.get(name)) == jsn::dump(w.get(name)));
  assert(s.get("directionReason").asString() == w.get("dirReason").asString());
  assert(!c.get("orderAuthority").asBool()); assert(c.get("sourceTimestampMs").isNull());
  assert(c.get("evaluatedAtMs").asNumber() < c.get("expiresAtMs").asNumber());
}
int main() {
  const auto fixture = read("src/tests/fixtures/tick_momentum_fixture.json");
  const auto expected = read("src/tests/fixtures/tick_momentum_expected.json");
  const long long now = fixture.get("events").asArray().back().get("recvMs").asNumber() + 1;
  {
    scan::TickScanner scanner(1, 8, [=] { return now; });
    auto body = batch(fixture, expected, "11"); const auto records = body.get("records").asArray();
    bool refused = false;
    try { scanner.submit(body); } catch (const std::runtime_error&) { refused = true; }
    assert(refused); assert(scanner.status().get("work").asArray().empty());
    // A refused batch must remain entirely retryable, even after previous
    // batches have completed. Replayed prefixes consume no queue capacity.
    for (size_t start = 0; start < records.size(); start += 7) {
      auto tooBig = body;
      if (records.size() - start > 7) {
        tooBig.set("records", Array(records.begin() + start, records.end()));
        refused = false;
        try { scanner.submit(tooBig); } catch (const std::runtime_error&) { refused = true; }
        assert(refused);
      }
      const auto end = std::min(start + 7, records.size());
      const auto prefix = start > 0 ? start - 7 : start;
      auto part = body; part.set("records", Array(records.begin() + prefix, records.begin() + end));
      const auto receipt = scanner.submit(part);
      assert(receipt.get("accepted").asNumber() == end - start);
      assert(receipt.get("duplicates").asNumber() == start - prefix);
      assert(receipt.get("dropped").asNumber() == 0); scanner.flush();
    }
    assert(scanner.status().get("processed").asNumber() == records.size());
    assert(scanner.status().get("dropped").asNumber() == 0);
    const auto candidates = scanner.candidates(0).get("candidates").asArray();
    assert(candidates.size() == expected.get("signals").asArray().size());
    for (size_t i = 0; i < candidates.size(); ++i) matches(candidates[i], expected.get("signals").asArray()[i]);
  }
  std::set<std::string> referenceIds;
  for (int workers : {1, 2, 4}) {
    scan::TickScanner scanner(workers, 4096, [=] { return now; });
    for (const auto& account : {"11", "22"}) {
      auto body = batch(fixture, expected, account);
      assert(scanner.submit(body).get("accepted").asNumber() == fixture.get("events").asArray().size());
      assert(scanner.submit(body).get("duplicates").asNumber() == fixture.get("events").asArray().size());
    }
    scanner.flush(); const auto rows = scanner.candidates(0).get("candidates").asArray();
    assert(rows.size() == 2 * expected.get("signals").asArray().size());
    std::map<std::string, size_t> seen; std::set<std::string> ids;
    for (const auto& c : rows) {
      const auto account = c.get("feed").get("accountId").asString();
      matches(c, expected.get("signals").asArray().at(seen[account]++));
      assert(ids.insert(c.get("candidateId").asString()).second);
    }
    assert(seen.at("11") == 2 && seen.at("22") == 2);
    if (workers == 1) referenceIds = ids; else assert(ids == referenceIds); // restart/worker count cannot duplicate economic identity
    assert(scanner.status().get("dropped").asNumber() == 0);
    assert(scanner.status().get("work").asArray().size() == 2);
  }
  {
    scan::TickScanner scanner(1, 4096, [=] { return now; }); auto bad = batch(fixture, expected, "11");
    auto rows = bad.get("records").asArray(); rows.back().set("sequence", 1); bad.set("records", rows);
    bool rejected = false; try { scanner.submit(bad); } catch (const std::invalid_argument&) { rejected = true; }
    assert(rejected); assert(scanner.status().get("work").asArray().empty()); // atomic validation
    auto clean = batch(fixture, expected, "11"); auto records = clean.get("records").asArray();
    records.at(116).set("gapBefore", true); clean.set("records", records); scanner.submit(clean); scanner.flush();
    const auto afterGap = scanner.candidates(0);
    for (const auto& c : afterGap.get("candidates").asArray()) assert(c.get("sourceSequence").asNumber() != 118);
    auto live = batch(fixture, expected, "11", "live.ctraderapi.com"); scanner.submit(live); scanner.flush();
    assert(scanner.status().get("work").asArray().size() == 2); // broker ID collision cannot join environments
  }
  {
    scan::TickScanner scanner(1, 4096, [=] { return now; }); auto body = batch(fixture, expected, "11"); body.set("candidateTtlMs", 1);
    scanner.submit(body); scanner.flush(); assert(scanner.candidates(0).get("candidates").asArray().empty());
    assert(scanner.status().get("work").asArray().front().get("expiredCandidates").asNumber() > 0);
  }
  {
    scan::CandidateRing ring;
    for (int i = 0; i < 4100; ++i) ring.push(Value(Object{{"candidateId", i}}));
    const auto data = ring.read(0); assert(data.get("gap").asBool()); assert(data.get("overwritten").asNumber() == 4);
    assert(data.get("candidates").asArray().size() == 256); assert(ring.read(5000).get("gap").asBool());
  }
  std::cout << "scanner frozen oracle, account/feed isolation, retries, gaps, expiry and bounded output passed\n";
}
