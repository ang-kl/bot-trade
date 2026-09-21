#include "fake_broker.hpp"
#include "../protection_watch.hpp"
#include <atomic>
#include <cassert>
#include <memory>

int main() {
  std::atomic<int> mode{0};
  FakeBroker broker([&](FakeBroker& b, const jsn::Value& f) {
    int type = static_cast<int>(f.get("payloadType").asNumber());
    if (type == 2100 || type == 2102) { b.reply(f, type + 1, jsn::Value{jsn::Object{}}); return; }
    if (type == 2121) {
      jsn::Value p{jsn::Object{}}, t{jsn::Object{}}; t.set("moneyDigits", 2); p.set("trader", t);
      b.reply(f, 2122, p); return;
    }
    assert(type == 2124); // No order-writing payload exists in this session.
    auto payload = jsn::parse(mode == 0
      ? R"({"ctidTraderAccountId":"22","position":[{"positionId":"7","stopLoss":90,"tradeData":{"symbolId":1}},{"positionId":"8","takeProfit":120}]})"
      : mode == 1 ? R"({"ctidTraderAccountId":11,"position":[]})"
      : mode == 2 ? R"({"ctidTraderAccountId":22})"
      : mode == 3 ? R"({"ctidTraderAccountId":22,"position":[{"positionId":7},{"positionId":7}]})"
      : R"({"ctidTraderAccountId":22,"position":"bad"})");
    b.reply(f, 2125, *payload);
  });
  auto session = std::make_shared<verify::VerifySession>("broker.test", "id", "secret", "token");
  session->setLoopbackTransportForTests(broker.port());
  assert(session->connect(22));
  verify::ProtectionWatch watch;
  watch.replace("broker.test", session, {22});
  watch.pollOnce();
  auto status = watch.status();
  auto first = status.get("accounts").asArray()[0];
  assert(first.get("ok").asBool());
  assert(first.get("openCount").asNumber() == 2);
  assert(first.get("missingSl").asNumber() == 1);
  assert(first.get("missingTp").asNumber() == 1);
  assert(first.get("accountId").asString() == "22");
  assert(first.get("checkedAtMs").asNumber() > 0);
  mode = 1; watch.pollOnce();
  assert(!watch.status().get("accounts").asArray()[0].get("ok").asBool());
  mode = 2; watch.pollOnce();
  auto empty = watch.status().get("accounts").asArray()[0];
  assert(empty.get("ok").asBool() && empty.get("openCount").asNumber() == 0);
  for (int bad : {3, 4}) {
    mode = bad; watch.pollOnce();
    assert(!watch.status().get("accounts").asArray()[0].get("ok").asBool());
  }
  broker.dropClient();
  watch.pollOnce();
  assert(!watch.status().get("accounts").asArray()[0].get("ok").asBool());
  watch.replace("broker.test", session, {});
  assert(watch.status().get("accounts").asArray().empty());
  std::fprintf(stderr, "test_protection: all passed\n");
}
