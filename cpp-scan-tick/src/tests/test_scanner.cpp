#include "../scanner.hpp"
#include <cassert>
#include <fstream>
#include <sstream>
#include <set>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
Value read(const char* path) { std::ifstream f(path); assert(f); std::stringstream s; s << f.rdbuf(); return *jsn::parse(s.str()); }
Value batch(const Value& fixture, const Value& expected, const std::string& account, const std::string& host = "demo.ctraderapi.com",
            const std::string& epoch = "gateway-epoch-1", const std::string& symbol = "7", size_t count = 0) {
  Array rows;
  for (const auto& e : fixture.get("events").asArray()) {
    if (count && rows.size() >= count) break;
    int flags = (e.get("bid").isNumber() ? 1 : 0) | (e.get("ask").isNumber() ? 2 : 0)
      | (e.get("snapshot").asBool() ? 16 : 0) | (e.get("crossed").asBool() ? 32 : 0) | (e.get("changed").asBool() ? 0 : 64);
    rows.push_back(Value(Object{{"sequence", e.get("seq")}, {"sourceSequence", e.get("seq")},
      {"receivedAtMs", e.get("recvMs")}, {"sourceTimestampMs", Value()}, {"flags", flags}, {"bid", e.get("bid")}, {"ask", e.get("ask")}}));
  }
  return Value(Object{{"schemaVersion", 1}, {"purpose", "mirror"}, {"feed", Object{{"provider", "ctrader"},
    {"host", host}, {"accountId", account}, {"symbolId", symbol}}}, {"feedEpoch", epoch},
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
  // A gateway restart mints a new feed epoch. Keyed with the epoch, every
  // restart added 53 streams until 'stream_capacity' refused all input.
  const auto submitRetrying = [](scan::TickScanner& s, const Value& body) {
    for (int attempt = 0;; ++attempt) {
      try { return s.submit(body); }
      catch (const std::runtime_error&) { assert(attempt < 20000); std::this_thread::sleep_for(std::chrono::microseconds(100)); }
    }
  };
  const auto row = [](const Value& status, const std::string& symbol) {
    for (const auto& w : status.get("work").asArray()) if (w.get("symbolId").asString() == symbol) return w;
    return Value();
  };
  {
    // A restart must not reduce admissions: 512 streams under epoch A, then
    // the same 512 from a restarted gateway (epoch B) are all accepted.
    scan::TickScanner scanner(2, 4096, [=] { return now; });
    for (const auto* epoch : {"epoch-a", "epoch-b"}) {
      for (int symbol = 1; symbol <= 512; ++symbol) {
        const auto r = submitRetrying(scanner, batch(fixture, expected, "11", "demo.ctraderapi.com", epoch, std::to_string(symbol), 20));
        assert(r.get("accepted").asNumber() == 20);
      }
      scanner.flush();
    }
    const auto status = scanner.status();
    assert(status.get("work").asArray().size() == 512); // one row per stream, not per epoch
    assert(status.get("streams").get("draining").asNumber() == 0);
    assert(status.get("streams").get("epochTurnovers").asNumber() == 512);
    for (const auto& w : status.get("work").asArray()) {
      assert(w.get("feedEpoch").asString() == "epoch-b" && w.get("epochTurnovers").asNumber() == 1);
      assert(w.get("resets").asNumber() >= 1); // the new slot rewarmed from a gap
    }
    // cpp-verify refuses a contract over 256 KiB: a full stream table fits.
    assert(jsn::dump(status).size() <= 256 * 1024);
  }
  {
    // The first record under the new epoch is a snapshot (rewarm), and the
    // superseded epoch cannot take the stream back.
    scan::TickScanner scanner(1, 4096, [=] { return now; });
    scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "epoch-a", "7", 30)); scanner.flush();
    const auto before = scanner.comparisons(0).get("latestCursor").asNumber();
    scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "epoch-b", "7", 30)); scanner.flush();
    const auto after = scanner.comparisons(static_cast<long long>(before)).get("candidates").asArray();
    assert(after.size() == 30 && after.front().get("feedEpoch").asString() == "epoch-b");
    assert(after.front().get("quote").get("snapshot").asBool());
    bool refused = false;
    try { scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "epoch-a", "7", 30)); }
    catch (const std::invalid_argument& e) { refused = std::string(e.what()) == "superseded_feed_epoch"; }
    assert(refused);
    const auto status = scanner.status();
    assert(status.get("streams").get("supersededEpochRefusals").asNumber() == 1);
    assert(status.get("work").asArray().size() == 1 && row(status, "7").get("feedEpoch").asString() == "epoch-b");
  }
  {
    // Turnover under load: a new epoch arrives while the old epoch's events
    // are still in the worker rings. Each old event must still reach its own
    // slot (a replaced-in-place slot threw out_of_range on a worker thread),
    // and every superseded slot is erased once drained. Run under TSan too.
    scan::TickScanner scanner(2, 64, [=] { return now; });
    for (int turn = 0; turn < 40; ++turn)
      for (const auto* symbol : {"7", "8", "9"})
        submitRetrying(scanner, batch(fixture, expected, "11", "demo.ctraderapi.com", "e" + std::to_string(turn), symbol, 25));
    scanner.flush();
    const auto status = scanner.status();
    assert(status.get("work").asArray().size() == 3 && status.get("streams").get("draining").asNumber() == 0);
    assert(status.get("streams").get("epochTurnovers").asNumber() == 39 * 3);
    assert(status.get("processed").asNumber() == 40 * 3 * 25 && status.get("dropped").asNumber() == 0);
    for (const auto* symbol : {"7", "8", "9"}) assert(row(status, symbol).get("feedEpoch").asString() == "e39");
  }
  {
    // A full table admits a new stream only by evicting a stale one: the
    // least recently fed stream with nothing in flight, stale after an hour.
    long long clock = now; scan::TickScanner scanner(1, 4096, [&] { return clock; }, 3600000);
    for (int symbol = 1; symbol <= 512; ++symbol) { scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "e1", std::to_string(symbol), 5)); scanner.flush(); }
    const auto refusedNew = [&] {
      try { scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "e1", "513", 5)); scanner.flush(); return false; }
      catch (const std::runtime_error&) { return true; }
    };
    assert(refusedNew());
    clock += 3600000 - 1; // streams 2..512 are fed again (duplicates still count); stream 1 is not
    for (int symbol = 2; symbol <= 512; ++symbol) scanner.submit(batch(fixture, expected, "11", "demo.ctraderapi.com", "e1", std::to_string(symbol), 5));
    assert(refusedNew());
    clock += 1;
    assert(!refusedNew());
    const auto status = scanner.status();
    assert(status.get("streams").get("evicted").asNumber() == 1 && status.get("work").asArray().size() == 512);
    assert(row(status, "1").isNull() && !row(status, "513").isNull());
  }
  std::cout << "scanner frozen oracle, account/feed isolation, retries, gaps, expiry and bounded output passed\n";
}
