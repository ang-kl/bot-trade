// cpp-exec/src/tests/test_spot_feed_heartbeat.cpp — 11-09-2026 audit (the
// investigation's finding 5): the spot feed's idle heartbeat must land
// within a second of its bound. It used a 5 s receive slice against a 9 s
// bound, so the effective bound was 9–14 s — past cTrader's 10 s guidance
// the constant claimed to honour — and nothing tested the feed's side of
// it. This drives the feed against the fake broker with a 200 ms bound: a
// 5 s slice sends nothing inside the window below; a 1 s slice sends one
// heartbeat per slice once idle.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <thread>

#include "../spot_feed.hpp"
#include "fake_broker.hpp"

using namespace std::chrono;

namespace {
constexpr int kAppAuthReq = 2100, kAppAuthRes = 2101, kAccountAuthReq = 2102, kAccountAuthRes = 2103;
constexpr int kSubscribeSpotsReq = 2127, kSubscribeSpotsRes = 2128;

int typeOf(const jsn::Value& f) { return static_cast<int>(f.get("payloadType").asNumber(-1)); }

void handshake(FakeBroker& b, const jsn::Value& f) {
  const int type = typeOf(f);
  jsn::Value p{jsn::Object{}};
  if (type == kAppAuthReq) { b.reply(f, kAppAuthRes, p); return; }
  if (type == kAccountAuthReq) { p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId")); b.reply(f, kAccountAuthRes, p); return; }
  if (type == kSubscribeSpotsReq) { p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId")); b.reply(f, kSubscribeSpotsRes, p); return; }
}
} // namespace

static void test_the_feed_heartbeats_within_a_slice_of_its_idle_bound() {
  FakeBroker broker(handshake);
  assert(broker.port() > 0);
  SpotFeed feed("127.0.0.1", "ci", "cs", "tok", 4002, /*symbolIds=*/{41}, /*onTick=*/nullptr, /*depthEnabled=*/false);
  feed.setLoopbackTransportForTests(broker.port());
  feed.setHeartbeatIdleMsForTests(200);
  std::thread t([&feed] { feed.runLoop(); });
  std::this_thread::sleep_for(milliseconds(2600));
  const int hb = broker.heartbeats();
  std::printf("feed heartbeats in 2.6 s at a 200 ms bound: %d\n", hb);
  assert(hb >= 2); // one per receive slice once idle past the bound — impossible with a 5 s slice
  assert(feed.isConnected());
  feed.stop();
  t.join();
  assert(broker.connections() == 1);
}

int main() {
  test_the_feed_heartbeats_within_a_slice_of_its_idle_bound();
  std::puts("test_spot_feed_heartbeat: all passed");
  return 0;
}
