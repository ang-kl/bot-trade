// cpp-exec/src/tests/test_tick_firer.cpp — P6b: the tick entry path.
// Sizing from the permit's figures at the signal's stop distance; the
// refusals (no permit, recorder not RECORDING, price bound, unaffordable
// lot, queue full); the payload the send boundary sees; permits are one
// use; the fire thread under concurrent fills (run under TSan too).
// GW-1 (WP-D D3): the permit is spent only after the firer's checks; the
// per-fire slot counter with the fires-seen acknowledgement; the push's full
// replace; the profile and boot refusals; non-tick entries spending slots.
#include <atomic>
#include <cassert>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../decision_ring.hpp"
#include "../engine.hpp"
#include "../json.hpp"
#include "../order_guard.hpp"
#include "../tick_firer.hpp"
#include "../tick_shadow.hpp"

using namespace tick;

static jsn::Value permitFor(long long acct, long long sym, const std::string& side, long long expMs = 9'000'000'000'000LL) {
  jsn::Value p{jsn::Object{}};
  p.set("id", std::string("p") + std::to_string(acct) + side);
  p.set("intentId", std::string("i") + std::to_string(acct) + side);
  p.set("accountId", static_cast<double>(acct));
  p.set("symbolId", static_cast<double>(sym));
  p.set("side", side);
  p.set("epoch", 3.0);
  p.set("expiresAtMs", static_cast<double>(expMs));
  p.set("usdRisk", 100.0);
  p.set("usdPerLotPerUnit", 1.0);      // $1 per lot per wire unit
  p.set("volumePerLot", 10000000.0);
  p.set("lotStep", 0.01);
  p.set("minLots", 0.01);
  p.set("maxLots", 50.0);
  p.set("overshootFraction", 0.25);
  return p;
}

static ShadowFill fillAt(long long sym, const std::string& side, long long entry, long long stop, long long ask, long long bid) {
  ShadowFill f;
  f.symbolId = sym; f.side = side; f.signalSeq = 10; f.entrySeq = 12; f.recvMs = 1000;
  f.entry = entry; f.stopDistance = stop;
  f.stop = side == "BUY" ? entry - stop : entry + stop;
  f.target = side == "BUY" ? entry + 3 * stop : entry - 3 * stop;
  f.signalAsk = ask; f.signalBid = bid; f.profileHash = "abcdef0123456789";
  return f;
}

static int countKind(const DecisionRing& ring, const std::string& kind, const std::string& code = "") {
  int n = 0;
  for (const auto& r : ring.since(0)) if (r.component == "tick" && r.kind == kind && (code.empty() || r.code == code)) n++;
  return n;
}

static void test_size_volume() {
  jsn::Value p = permitFor(1, 7, "BUY");
  std::string why;
  // $100 R at a 50-unit stop and $1/lot/unit → 2 lots → 20,000,000
  auto v = TickFirer::sizeVolume(p, 50, &why);
  assert(v && *v == 20000000.0);
  // floored to the lot step: $100 / (33 × 1) = 3.0303 → 3.03 lots
  v = TickFirer::sizeVolume(p, 33, &why);
  assert(v && *v == 30300000.0);
  // capped at maxLots: a 1-unit stop would buy 100 lots → 50
  v = TickFirer::sizeVolume(p, 1, &why);
  assert(v && *v == 500000000.0);
  // below the minimum lot: a 20,000-unit stop buys 0.005 lots → refused, never rounded up
  v = TickFirer::sizeVolume(p, 20000, &why);
  assert(!v && why.rfind("unaffordable_lot", 0) == 0);
  // missing figures → refused
  jsn::Value bare = permitFor(1, 7, "BUY"); bare.set("usdRisk", 0.0);
  assert(!TickFirer::sizeVolume(bare, 50, &why) && why.rfind("sizing", 0) == 0);
  assert(!TickFirer::sizeVolume(p, 0, &why) && why.rfind("sizing", 0) == 0);
  std::puts("sizeVolume: ok");
}

static void test_refusals_and_payload() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(512);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  std::vector<jsn::Value> sent;
  std::mutex sentMtx;
  firer.setSendHookForTests([&](const jsn::Value& p) {
    { std::lock_guard<std::mutex> lk(sentMtx); sent.push_back(p); }
    EngineResult r; r.ok = true; r.body = jsn::Value{jsn::Object{}};
    jsn::Value pos{jsn::Object{}}; pos.set("positionId", 777.0); r.body.set("position", pos);
    return r;
  });
  const ShadowFill f = fillAt(7, "BUY", 100500, 50, 100490, 100480);
  // no accounts in TICK_MOMENTUM: nothing, not even a refusal
  assert(firer.onFill(f, 1000) == 0 && firer.counters().fills == 1);
  assert(countKind(ring, "fire_refused") == 0);
  // an account, no permit
  firer.setAccounts({1});
  assert(firer.onFill(f, 1000) == 0);
  assert(firer.counters().refusedNoPermit == 1 && countKind(ring, "fire_refused", "no_permit") == 1);
  // recorder not RECORDING: refused BEFORE the permit is taken (it survives)
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  bool recording = false;
  firer.setRecordingCheck([&] { return recording; });
  assert(firer.onFill(f, 1000) == 0);
  assert(firer.counters().refusedRecorder == 1 && permits.size() == 1 && countKind(ring, "fire_refused", "recorder_not_recording") == 1);
  recording = true;
  // price bound: 0.25 × 50 = 12 from the signal's ask 100490 → a fill at 100510 is 20 away → refused.
  // GW-1 (gap 3), CHANGED DELIBERATELY: the permit is NOT spent by a refused
  // fill any more (it used to be — take() ran before the checks).
  const ShadowFill far = fillAt(7, "BUY", 100510, 50, 100490, 100480);
  assert(firer.onFill(far, 1000) == 0);
  assert(firer.counters().refusedPriceBound == 1 && permits.size() == 1 && countKind(ring, "fire_refused", "price_bound") == 1);
  // an expired permit is no permit
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY", 500));
  assert(firer.onFill(f, 1000) == 0 && firer.counters().refusedNoPermit == 2 && permits.size() == 0);
  // unaffordable: an R that buys less than the minimum lot
  jsn::Value poor = permitFor(1, 7, "BUY"); poor.set("usdRisk", 0.2);
  permits.set(1, 7, "BUY", poor);
  assert(firer.onFill(f, 1000) == 0 && firer.counters().refusedUnaffordable == 1 && countKind(ring, "fire_refused", "unaffordable_lot") == 1);
  // the good path: queued, sent through the hook with the boundary's payload
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  firer.start();
  assert(firer.onFill(f, 1000) == 1);
  for (int i = 0; i < 200 && firer.counters().sent == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  firer.stop();
  assert(firer.counters().queued == 1 && firer.counters().sent == 1 && firer.counters().rejected == 0);
  assert(sent.size() == 1);
  const jsn::Value& p = sent[0];
  assert(p.get("ctidTraderAccountId").asNumber(0) == 1 && p.get("symbolId").asNumber(0) == 7);
  assert(p.get("tradeSide").asString() == "BUY" && p.get("orderType").asString() == "MARKET");
  assert(p.get("volume").asNumber(0) == 20000000.0);
  assert(p.get("relativeStopLoss").asNumber(0) == 50 && p.get("relativeTakeProfit").asNumber(0) == 150);
  assert(p.get("label").asString() == "tick:abcdef0123456789|||||||i1BUY" && p.get("comment").asString() == "abot-tick");
  assert(p.get("permit").isObject() && p.get("permit").get("id").asString() == "p1BUY" && p.get("intentId").asString() == "i1BUY");
  assert(countKind(ring, "fire") == 1 && countKind(ring, "fire_result", "ok") == 1);
  // PR-1b (20-09-2026): the `fire_result` detail carries the breakout FACT —
  // the keeper's fire ledger turns these four tokens into the risk event a
  // tick close needs for `direction_reason` (position-history REQUIRED_FIELDS).
  {
    std::string detail;
    for (const auto& r : ring.since(0)) if (r.component == "tick" && r.kind == "fire_result" && r.code == "ok") detail = r.detail;
    assert(detail.find("entry=" + std::to_string(f.entry)) != std::string::npos);
    assert(detail.find("stop=" + std::to_string(f.stop)) != std::string::npos);
    assert(detail.find("target=" + std::to_string(f.target)) != std::string::npos);
    assert(detail.find("side=BUY") != std::string::npos);
    // the signal ask this BUY fill crossed (PR-1b follow-up)
    assert(detail.find("ref=" + std::to_string(f.signalAsk)) != std::string::npos);
  }
  assert(permits.size() == 0 && "the permit was one use");
  // a second fill on the same account/symbol/side has no permit until the keeper pushes again
  assert(firer.onFill(f, 1000) == 0 && firer.counters().refusedNoPermit == 3);
  // a rejected send is counted and rung, never retried
  firer.setSendHookForTests([&](const jsn::Value&) { EngineResult r; r.ok = false; r.body = jsn::Value{jsn::Object{}}; r.body.set("errorCode", std::string("permit_epoch_stale")); r.body.set("description", std::string("epoch 2 vs 3")); return r; });
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  firer.start();
  assert(firer.onFill(f, 1000) == 1);
  for (int i = 0; i < 200 && firer.counters().rejected == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  firer.stop();
  assert(firer.counters().rejected == 1 && countKind(ring, "fire_reject", "permit_epoch_stale") == 1);
  // status json carries the shape the keeper reads
  auto st = jsn::parse(firer.statusJson());
  assert(st && st->get("places").asBool(false) && st->get("accounts").asNumber(0) == 1 && st->get("sent").asNumber(0) == 1 && st->get("rejected").asNumber(0) == 1);
  firer.setAccounts({});
  st = jsn::parse(firer.statusJson());
  assert(st && !st->get("places").asBool(true));
  std::puts("refusals and payload: ok");
}

// The permit exactly as the keeper's feeder emits it (entry-ledger permitOf +
// tick-permits permitSizing), fed through buildPayload and then the send
// boundary's validatePermit under a fence — the two sides joined (RACE
// CHECKER 11-09-2026: a string accountId here was refused permit_mismatch,
// and no test saw it).
static void test_feeder_shaped_permit_passes_the_boundary() {
  const char* wire = "{\"id\":\"pabc123def456\",\"intentId\":\"iabc123def456\",\"accountId\":46979908,\"environment\":\"demo\","
                     "\"symbolId\":41,\"symbol\":\"XAUUSD\",\"side\":\"BUY\",\"volume\":null,\"epoch\":3,\"expiresAt\":\"2026-09-11T10:00:00.000Z\","
                     "\"expiresAtMs\":9000000000000,\"usdRisk\":100,\"usdPerLotPerUnit\":0.001,\"volumePerLot\":10000000,\"lotStep\":0.01,"
                     "\"minLots\":0.01,\"maxLots\":1000,\"overshootFraction\":0.25,\"minStopFraction\":0.0015,\"maxFireDelayMs\":5000}";
  auto permit = jsn::parse(wire);
  assert(permit && permit->isObject());
  // XAUUSD 2400.00 → wire 240,000,000; a 0.15 % floor is 360,000 units; stop 400,000 clears it
  ShadowFill f = fillAt(41, "BUY", 240000000, 400000, 239990000, 239980000);
  std::string why;
  auto vol = TickFirer::sizeVolume(*permit, f.stopDistance, &why);
  assert(vol && *vol == 2500000.0); // 100 / (400,000 × 0.001) = 0.25 lots
  jsn::Value payload = TickFirer::buildPayload(46979908, f, *vol, *permit);
  GuardSnapshot g{false, true, true, 0.0, {}, {{46979908, 3}}};
  std::set<std::string> used;
  const PermitVerdict pv = validatePermit(payload, g, used, 1000);
  assert(pv.ok && pv.permitId == "pabc123def456" && pv.intentId == "iabc123def456");
  assert(validateOrder(payload, g).ok);
  const PermitVerdict again = validatePermit(payload, g, used, 1000);
  assert(!again.ok && again.reason.rfind("permit_consumed", 0) == 0);
  // the same permit with the accountId as a STRING is what the old feeder sent: refused
  jsn::Value str = *permit; str.set("accountId", std::string("46979908"));
  std::set<std::string> used2;
  const PermitVerdict sv = validatePermit(TickFirer::buildPayload(46979908, f, *vol, str), g, used2, 1000);
  assert(!sv.ok && sv.reason.rfind("permit_mismatch", 0) == 0);
  std::puts("feeder-shaped permit through the boundary: ok");
}

static void test_stop_floor_stale_and_abandon() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(512);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  firer.setAccounts({1});
  // stop floor: minStopFraction 0.0015 × entry 240,000,000 = 360,000; a 20,000-unit stop (one gold spread) is refused
  jsn::Value p = permitFor(1, 41, "BUY"); p.set("minStopFraction", 0.0015); p.set("usdPerLotPerUnit", 0.001);
  permits.set(1, 41, "BUY", p);
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 20000, 239995000, 239990000), 1000) == 0);
  assert(firer.counters().refusedStopFloor == 1 && countKind(ring, "fire_refused", "stop_below_floor") == 1);
  // and the same permit's figures with a stop above the floor size to 0.25 lots
  permits.set(1, 41, "BUY", p);
  std::atomic<int> sent{0};
  firer.setSendHookForTests([&](const jsn::Value&) { sent.fetch_add(1); EngineResult r; r.ok = true; r.body = jsn::Value{jsn::Object{}}; return r; });
  // stale at the send: the fill is at 1000, the clock says 10 s later, maxFireDelayMs 5000
  jsn::Value slow = p; slow.set("maxFireDelayMs", 5000.0);
  permits.set(1, 41, "BUY", slow);
  long long clock = 11000;
  firer.setClockForTests([&] { return clock; });
  firer.start();
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 400000, 239990000, 239980000), 1000) == 1);
  // The worker increments the counter before publishing its decision record.
  // Wait for both observations within the same budget before asserting them.
  for (int i = 0; i < 200 && (firer.counters().refusedStale == 0 || countKind(ring, "fire_refused", "fire_stale") == 0); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  assert(firer.counters().refusedStale == 1 && sent.load() == 0 && countKind(ring, "fire_refused", "fire_stale") == 1);
  // in time: sent
  clock = 3000;
  permits.set(1, 41, "BUY", slow);
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 400000, 239990000, 239980000), 1000) == 1);
  for (int i = 0; i < 200 && (sent.load() == 0 || firer.counters().sent == 0); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  assert(sent.load() == 1 && firer.counters().sent == 1);
  firer.stop();
  // abandon: queued fires are dropped by stop(), never sent after it
  TickFirer idle(engine, permits);
  idle.setDecisionRing(&ring);
  idle.setAccounts({1});
  idle.setSendHookForTests([&](const jsn::Value&) { sent.fetch_add(1); EngineResult r; r.ok = true; r.body = jsn::Value{jsn::Object{}}; return r; });
  for (long long s = 1; s <= 3; ++s) { permits.set(1, s, "SELL", permitFor(1, s, "SELL")); assert(idle.onFill(fillAt(s, "SELL", 100485, 50, 100490, 100480), 1000) == 1); }
  assert(idle.queueDepth() == 3);
  idle.start();
  idle.stop();
  assert(idle.counters().abandoned + idle.counters().sent == 3);
  assert(idle.queueDepth() == 0);
  idle.stop();
  assert(idle.counters().sent == static_cast<uint64_t>(sent.load() - 1) && countKind(ring, "fire_abandoned") == static_cast<int>(idle.counters().abandoned));
  std::puts("stop floor, stale send and abandon: ok");
}

static void test_queue_bound_and_account_clear() {
  ExecEngine engine;
  TickPermitStore permits;
  TickFirer firer(engine, permits);
  firer.setAccounts({1});
  // not started: the queue fills to its bound, the 65th is refused and counted
  for (long long s = 1; s <= 65; ++s) permits.set(1, s, "BUY", permitFor(1, s, "BUY"));
  int queued = 0;
  for (long long s = 1; s <= 65; ++s) queued += firer.onFill(fillAt(s, "BUY", 100500, 50, 100490, 100480), 1000);
  assert(queued == 64 && firer.queueDepth() == 64 && firer.counters().refusedQueueFull == 1);
  // the store clears an account's permits when it leaves the set
  permits.set(1, 9, "SELL", permitFor(1, 9, "SELL"));
  permits.set(2, 9, "SELL", permitFor(2, 9, "SELL"));
  permits.clearAccount(1);
  assert(permits.size() == 1 && !permits.take(1, 9, "SELL", 1000) && permits.take(2, 9, "SELL", 1000));
  std::puts("queue bound and account clear: ok");
}

static void test_concurrent_fills() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(4096);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  std::atomic<int> sent{0};
  firer.setSendHookForTests([&](const jsn::Value&) { sent.fetch_add(1); EngineResult r; r.ok = true; r.body = jsn::Value{jsn::Object{}}; return r; });
  firer.setAccounts({1, 2});
  firer.start();
  std::vector<std::thread> workers;
  for (int w = 0; w < 2; ++w) {
    workers.emplace_back([&, w] {
      for (int i = 0; i < 50; ++i) {
        const long long sym = 100 * (w + 1) + i;
        permits.set(1, sym, "SELL", permitFor(1, sym, "SELL"));
        permits.set(2, sym, "SELL", permitFor(2, sym, "SELL"));
        firer.onFill(fillAt(sym, "SELL", 100485, 50, 100490, 100480), 1000);
      }
    });
  }
  // the keeper repushes accounts while fills arrive
  std::thread pusher([&] { for (int i = 0; i < 20; ++i) { firer.setAccounts({1, 2}); (void)firer.statusJson(); } });
  for (auto& t : workers) t.join();
  pusher.join();
  for (int i = 0; i < 400 && firer.queueDepth() > 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  firer.stop();
  const FireCounters c = firer.counters();
  std::printf("counters: fills %llu queued %llu sent %llu rejected %llu noPermit %llu unaffordable %llu priceBound %llu recorder %llu queueFull %llu sizing %llu\n",
              (unsigned long long)c.fills, (unsigned long long)c.queued, (unsigned long long)c.sent, (unsigned long long)c.rejected,
              (unsigned long long)c.refusedNoPermit, (unsigned long long)c.refusedUnaffordable, (unsigned long long)c.refusedPriceBound,
              (unsigned long long)c.refusedRecorder, (unsigned long long)c.refusedQueueFull, (unsigned long long)c.refusedSizing);
  assert(c.fills == 100);
  assert(c.queued + c.refusedQueueFull == 200);
  assert(c.sent == c.queued && static_cast<uint64_t>(sent.load()) == c.queued);
  assert(permits.size() == 0);
  std::printf("concurrent fills: queued %llu, refused full %llu, sent %llu\n",
              (unsigned long long)c.queued, (unsigned long long)c.refusedQueueFull, (unsigned long long)c.sent);
}


// GW-1 (gap 3): a permit survives every check that refuses the fill — price
// bound, stop floor, unaffordable lot, sizing — and the next in-bound fill
// spends it.
static void test_permit_is_spent_only_after_the_checks() {
  ExecEngine engine;
  TickPermitStore permits;
  TickFirer firer(engine, permits);
  firer.setAccounts({1});
  jsn::Value p = permitFor(1, 41, "BUY"); p.set("minStopFraction", 0.0015); p.set("usdPerLotPerUnit", 0.001);
  permits.set(1, 41, "BUY", p);
  // price bound: 0.25 × 400,000 = 100,000 from the ask; 300,000 away
  assert(firer.onFill(fillAt(41, "BUY", 240300000, 400000, 240000000, 239990000), 1000) == 0);
  // stop floor: 20,000 < 360,000
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 20000, 239995000, 239990000), 1000) == 0);
  // unaffordable: a stop so wide the R buys under 0.01 lot (100 / (20,000,000 × 0.001) = 0.005)
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 20000000, 239000000, 238990000), 1000) == 0);
  const FireCounters c = firer.counters();
  assert(c.refusedPriceBound == 1 && c.refusedStopFloor == 1 && c.refusedUnaffordable == 1 && c.queued == 0);
  assert(permits.size() == 1 && "every refusal left the permit");
  // the in-bound fill spends it
  assert(firer.onFill(fillAt(41, "BUY", 240000000, 400000, 239990000, 239980000), 1000) == 1);
  assert(permits.size() == 0 && firer.counters().queued == 1);
  std::puts("permit spent only after the checks: ok");
}

// GW-1 (gap 1): the per-fire slot counter and the fires-seen acknowledgement.
static void test_slots_cap_each_fire_and_the_ack_arithmetic() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(512);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  firer.setBootId("B1");
  firer.setAccounts({1});
  // no slot figure: unlimited, as before GW-1
  assert(firer.slots().empty());
  firer.setSlots({{1, SlotPush{1, 0, "B1"}}});
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  permits.set(1, 8, "BUY", permitFor(1, 8, "BUY"));
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  assert(firer.onFill(fillAt(8, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(firer.counters().refusedAccountCap == 1 && countKind(ring, "fire_refused", "account_cap") == 1);
  assert(permits.size() == 1 && "the capped fill left its permit");
  // the same figure pushed again, Node not having seen the fire: still capped (fires 1, seen 0)
  firer.setSlots({{1, SlotPush{1, 0, "B1"}}});
  assert(firer.slots().at(1) == 0);
  assert(firer.onFill(fillAt(8, "BUY", 100500, 50, 100490, 100480), 1000) == 0 && firer.counters().refusedAccountCap == 2);
  // a push naming ANOTHER boot acknowledges nothing
  firer.setSlots({{1, SlotPush{1, 1, "B0"}}});
  assert(firer.slots().at(1) == 0);
  // Node has seen the fire (firesSeen 1 on this boot): its figure is the truth
  firer.setSlots({{1, SlotPush{1, 1, "B1"}}});
  assert(firer.slots().at(1) == 1);
  assert(firer.onFill(fillAt(8, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  assert(firer.counters().queued == 2 && permits.size() == 0);
  // an account the push no longer names is unlimited again
  firer.setSlots({});
  assert(firer.slots().empty());
  auto st = jsn::parse(firer.statusJson());
  assert(st && st->get("refusedAccountCap").asNumber(0) == 2 && st->get("slots").isObject() && st->get("bootId").asString() == "B1");
  std::puts("slots cap each fire; the ack arithmetic: ok");
}

// GW-1 (gap 1, concurrency; also under make tsan): two workers filling 50
// symbols each for one account with 3 slots queue exactly 3.
static void test_slots_hold_under_concurrent_fills() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(4096);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  firer.setBootId("B1");
  firer.setAccounts({1});
  firer.setSlots({{1, SlotPush{3, 0, "B1"}}});
  for (int w = 0; w < 2; ++w) for (int i = 0; i < 50; ++i) { const long long sym = 100 * (w + 1) + i; permits.set(1, sym, "SELL", permitFor(1, sym, "SELL")); }
  std::vector<std::thread> workers;
  for (int w = 0; w < 2; ++w) {
    workers.emplace_back([&, w] {
      for (int i = 0; i < 50; ++i) firer.onFill(fillAt(100 * (w + 1) + i, "SELL", 100485, 50, 100490, 100480), 1000);
    });
  }
  std::thread pusher([&] { for (int i = 0; i < 20; ++i) { (void)firer.statusJson(); (void)firer.slots(); } });
  for (auto& t : workers) t.join();
  pusher.join();
  const FireCounters c = firer.counters();
  assert(c.queued == 3);
  assert(c.refusedAccountCap == c.fills - 3 - c.refusedQueueFull);
  assert(permits.size() == 97);
  std::puts("slots hold under concurrent fills: ok");
}

// GW-1: a stale fire and a definite reject give the slot back; TIMEOUT and
// DISCONNECTED (the order may have reached the broker) do not; a push
// between the reservation and the refund makes the refund a no-op.
static void test_slot_refunds() {
  assert(!TickFirer::isAmbiguousReject("NOT_ENOUGH_MONEY") && TickFirer::isAmbiguousReject("TIMEOUT") && TickFirer::isAmbiguousReject("DISCONNECTED"));
  ExecEngine engine;
  TickPermitStore permits;
  TickFirer firer(engine, permits);
  firer.setBootId("B1");
  firer.setAccounts({1});
  std::atomic<bool> timeout{false}; // read on the fire thread: an atomic, not a string (TSan)
  firer.setSendHookForTests([&](const jsn::Value&) { EngineResult r; r.ok = false; r.body = jsn::Value{jsn::Object{}}; r.body.set("errorCode", std::string(timeout.load() ? "TIMEOUT" : "NOT_ENOUGH_MONEY")); return r; });
  auto waitRejected = [&](uint64_t n) { for (int i = 0; i < 400 && firer.counters().rejected < n; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5)); };
  firer.setSlots({{1, SlotPush{1, 0, "B1"}}});
  firer.start();
  // a definite reject: the slot comes back
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  waitRejected(1);
  for (int i = 0; i < 200 && firer.slots().at(1) != 1; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  assert(firer.slots().at(1) == 1 && firer.counters().slotsRefunded == 1);
  // a TIMEOUT: the slot stays spent
  timeout.store(true);
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  waitRejected(2);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  assert(firer.slots().at(1) == 0 && firer.counters().slotsRefunded == 1);
  firer.stop();
  // a stale fire: never sent, the slot comes back
  TickFirer slow(engine, permits);
  slow.setBootId("B1");
  slow.setAccounts({1});
  slow.setSendHookForTests([&](const jsn::Value&) { EngineResult r; r.ok = true; r.body = jsn::Value{jsn::Object{}}; return r; });
  slow.setClockForTests([] { return 60000LL; });
  slow.setSlots({{1, SlotPush{1, 0, "B1"}}});
  jsn::Value p = permitFor(1, 7, "BUY"); p.set("maxFireDelayMs", 5000.0);
  permits.set(1, 7, "BUY", p);
  assert(slow.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  assert(slow.slots().at(1) == 0);
  slow.start();
  for (int i = 0; i < 400 && slow.counters().refusedStale == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  for (int i = 0; i < 200 && slow.slots().at(1) != 1; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  assert(slow.counters().refusedStale == 1 && slow.slots().at(1) == 1);
  slow.stop();
  // a push between the reservation and a refusal: no refund (the push already counts it)
  TickFirer racing(engine, permits);
  racing.setBootId("B1");
  racing.setAccounts({1});
  racing.setSendHookForTests([&](const jsn::Value&) { EngineResult r; r.ok = false; r.body = jsn::Value{jsn::Object{}}; r.body.set("errorCode", std::string("NOT_ENOUGH_MONEY")); return r; });
  racing.setSlots({{1, SlotPush{2, 0, "B1"}}});
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  assert(racing.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1); // queued, not started yet
  racing.setSlots({{1, SlotPush{2, 1, "B1"}}});                                   // Node saw the fire
  assert(racing.slots().at(1) == 2);
  racing.start();
  for (int i = 0; i < 400 && racing.counters().rejected == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  racing.stop();
  assert(racing.slots().at(1) == 2 && racing.counters().slotsRefunded == 0);
  std::puts("slot refunds: ok");
}

// GW-1 (gap 2): the push fully replaces an account's permits.
static void test_replace_accounts_withdraws_dropped_keys() {
  TickPermitStore permits;
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  permits.set(1, 8, "SELL", permitFor(1, 8, "SELL"));
  permits.set(2, 7, "BUY", permitFor(2, 7, "BUY"));
  jsn::Value fresh = permitFor(1, 7, "BUY"); fresh.set("id", std::string("fresh"));
  permits.replaceAccounts({1}, {TickPermitStore::Entry{1, 7, "BUY", fresh}});
  assert(permits.size() == 2);
  assert(!permits.take(1, 8, "SELL", 1000) && "a key the push no longer carries is withdrawn");
  auto kept = permits.take(1, 7, "BUY", 1000);
  assert(kept && kept->get("id").asString() == "fresh");
  assert(permits.take(2, 7, "BUY", 1000) && "an account the push does not name keeps its permits");
  // an empty set for a placing account withdraws everything it held
  permits.set(1, 9, "BUY", permitFor(1, 9, "BUY"));
  permits.replaceAccounts({1}, {});
  assert(permits.size() == 0);
  std::puts("replaceAccounts withdraws dropped keys: ok");
}

// GW-1 (gaps 5 and 6): the profile and boot refusals keep the permit; a
// permit with neither field (an older keeper) is not checked.
static void test_profile_and_boot_refusals() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(512);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  firer.setBootId("B");
  firer.setAccounts({1});
  jsn::Value other = permitFor(1, 7, "BUY"); other.set("profileHash", std::string("0000000000000000"));
  permits.set(1, 7, "BUY", other);
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(firer.counters().refusedProfile == 1 && permits.size() == 1 && countKind(ring, "fire_refused", "profile_mismatch") == 1);
  jsn::Value oldBoot = permitFor(1, 7, "BUY"); oldBoot.set("profileHash", std::string("abcdef0123456789")); oldBoot.set("bootId", std::string("A"));
  permits.set(1, 7, "BUY", oldBoot);
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(firer.counters().refusedBoot == 1 && permits.size() == 1 && countKind(ring, "fire_refused", "permit_other_boot") == 1);
  jsn::Value mine = oldBoot; mine.set("bootId", std::string("B"));
  permits.set(1, 7, "BUY", mine);
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY")); // no profileHash, no bootId: not checked
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  std::puts("profile and boot refusals: ok");
}

// GW-1 (gap 6, the restart double-spend the WP names): boot A spends P; a new
// engine + firer (boot B) receives the same P. The fresh engine's empty
// consumed-permit set would accept it — the boot check is what refuses it.
static void test_a_permit_cannot_cross_a_restart() {
  GuardSnapshot g{false, true, true, 0.0, {}, {{1, 3}}};
  jsn::Value P = permitFor(1, 7, "BUY"); P.set("bootId", std::string("A"));
  {
    ExecEngine engineA;
    TickPermitStore permitsA;
    TickFirer a(engineA, permitsA);
    a.setBootId("A");
    a.setAccounts({1});
    permitsA.set(1, 7, "BUY", P);
    assert(a.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 1);
  }
  ExecEngine engineB;
  TickPermitStore permitsB;
  TickFirer b(engineB, permitsB);
  b.setBootId("B");
  b.setAccounts({1});
  // the gateway alone cannot remember: the new boot's boundary would accept P
  std::set<std::string> freshConsumed;
  jsn::Value payload = TickFirer::buildPayload(1, fillAt(7, "BUY", 100500, 50, 100490, 100480), 20000000.0, P);
  assert(validatePermit(payload, g, freshConsumed, 1000).ok);
  permitsB.set(1, 7, "BUY", P);
  assert(b.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(b.counters().refusedBoot == 1 && b.counters().queued == 0);
  std::puts("a permit cannot cross a restart: ok");
}

// GW-1 (gap 1c): a non-tick entry spends a slot of its account until the
// next push; a 'tick:' entry (the firer's own, counted at the queue) does not.
static void test_non_tick_entries_spend_slots() {
  ExecEngine engine;
  TickPermitStore permits;
  TickFirer firer(engine, permits);
  firer.setAccounts({1});
  firer.setSlots({{1, SlotPush{2, 0, ""}}});
  firer.noteEntry(1, "tick:abcdef0123456789|||||||i1BUY");
  assert(firer.slots().at(1) == 2);
  firer.noteEntry(1, "AU|v1|VWAP|H|LN|4h|TR|iabc");
  assert(firer.slots().at(1) == 1);
  firer.noteEntry(2, "AU|v1|VWAP|H|LN|4h|TR|iabc"); // an account with no figure: nothing to spend
  assert(firer.slots().count(2) == 0);
  firer.noteEntry(1, "AU");
  firer.noteEntry(1, "AU");
  assert(firer.slots().at(1) == 0 && firer.counters().entriesNoted == 4);
  std::puts("non-tick entries spend slots: ok");
}

// GW-1 checker B1: /health answers unauthenticated, and the slot map is keyed
// by ctidTraderAccountId. The open summary carries a count, never an id.
static void test_open_health_entry_carries_no_account_id() {
  ExecEngine engine;
  TickPermitStore permits;
  TickFirer firer(engine, permits);
  firer.setAccounts({46979908});
  firer.setSlots({{46979908, SlotPush{2, 0, ""}}, {43002148, SlotPush{1, 0, ""}}});
  auto st = jsn::parse(firer.statusJson());
  assert(st);
  const std::string open = jsn::dump(TickFirer::healthEntry(*st, false));
  assert(open.find("46979908") == std::string::npos && open.find("43002148") == std::string::npos);
  const jsn::Value openV = TickFirer::healthEntry(*st, false);
  assert(openV.get("slots").isNull() && openV.get("slotAccounts").asNumber(-1) == 2);
  const jsn::Value trustedV = TickFirer::healthEntry(*st, true);
  assert(trustedV.get("slots").get("46979908").asNumber(-1) == 2 && trustedV.get("slotAccounts").asNumber(-1) == 2);
  std::puts("open /health entry carries no account id: ok");
}

// GW-1 checker nit: with no slot left AND no permit, the refusal names the
// missing permit; a held permit at 0 slots is still account_cap.
static void test_no_permit_is_named_before_the_cap() {
  ExecEngine engine;
  TickPermitStore permits;
  DecisionRing ring(128);
  TickFirer firer(engine, permits);
  firer.setDecisionRing(&ring);
  firer.setAccounts({1});
  firer.setSlots({{1, SlotPush{0, 0, ""}}});
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(firer.counters().refusedNoPermit == 1 && firer.counters().refusedAccountCap == 0 && countKind(ring, "fire_refused", "no_permit") == 1);
  permits.set(1, 7, "BUY", permitFor(1, 7, "BUY"));
  assert(firer.onFill(fillAt(7, "BUY", 100500, 50, 100490, 100480), 1000) == 0);
  assert(firer.counters().refusedAccountCap == 1 && permits.size() == 1);
  std::puts("no_permit is named before the cap: ok");
}

int main() {
  test_size_volume();
  test_refusals_and_payload();
  test_feeder_shaped_permit_passes_the_boundary();
  test_stop_floor_stale_and_abandon();
  test_queue_bound_and_account_clear();
  test_concurrent_fills();
  test_permit_is_spent_only_after_the_checks();
  test_slots_cap_each_fire_and_the_ack_arithmetic();
  test_slots_hold_under_concurrent_fills();
  test_slot_refunds();
  test_replace_accounts_withdraws_dropped_keys();
  test_profile_and_boot_refusals();
  test_a_permit_cannot_cross_a_restart();
  test_non_tick_entries_spend_slots();
  test_open_health_entry_carries_no_account_id();
  test_no_permit_is_named_before_the_cap();
  std::puts("test_tick_firer: all passed");
  return 0;
}
