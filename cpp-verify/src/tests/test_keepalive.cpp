#include "fake_broker.hpp"
#include "../verify_session.hpp"
#include <cassert>

using namespace std::chrono_literals;

int main() {
  std::atomic<bool> beforeAppAuth{true};
  std::atomic<int> heartbeatsBeforeAuth{-1};
  FakeBroker broker([&](FakeBroker& b, const jsn::Value& f) {
    const int type = static_cast<int>(f.get("payloadType").asNumber());
    if (type == 2100) {
      // Longer than the test heartbeat period. Never send before app auth.
      std::this_thread::sleep_for(150ms);
      heartbeatsBeforeAuth = b.heartbeats();
      beforeAppAuth = false;
      b.reply(f, 2101, jsn::Value{jsn::Object{}});
    } else if (type == 2102) {
      b.reply(f, 2103, jsn::Value{jsn::Object{}});
    } else if (type == 2121) {
      b.reply(f, 2122, *jsn::parse(R"({"trader":{"moneyDigits":2}})"));
    } else if (type == 2124) {
      // Pending reads own the mutex, so they must keep the socket alive too.
      b.replyAfter(300, f, 2125, *jsn::parse(R"({"ctidTraderAccountId":22,"position":[]})"));
    } else {
      assert(false && "unexpected broker request");
    }
  });
  verify::VerifySession session("test", "id", "secret", "token");
  session.setLoopbackTransportForTests(broker.port());
  session.setHeartbeatIntervalForTests(50);
  assert(session.connect(22));
  assert(!beforeAppAuth && heartbeatsBeforeAuth == 0);

  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (broker.heartbeats() < 3 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(10ms);
  assert(broker.heartbeats() >= 3); // No protection/history requests while idle.
  const int beforeRead = broker.heartbeats();
  assert(session.protection(22).get("ok").asBool());
  assert(broker.heartbeats() >= beforeRead + 3); // Sent during a slow read.

  broker.dropClient();
  assert(!session.protection(22).get("ok").asBool());
  assert(session.connect(22));
  assert(session.protection(22).get("ok").asBool());
  std::fprintf(stderr, "test_keepalive: idle, pending read and reconnect passed\n");
}
