// cpp-exec/src/tests/test_engine_telemetry.cpp — ExecEngine::placeOrder must
// log a telemetry record for every outcome (guard reject, transport failure)
// when a sink is attached, and must not touch it at all when none is set.
// Neither path needs a live broker connection: a guard rejection returns
// before the socket is touched, and an unconnected engine's request() fails
// fast with NOT_CONNECTED — both exercised here without any network I/O.
#include <cassert>
#include <cstdio>
#include <unistd.h>

#include "../engine.hpp"
#include "../telemetry.hpp"

static std::string tmpPath() {
  char buf[] = "/tmp/cppexec_engine_telemetry_XXXXXX";
  int fd = mkstemp(buf);
  if (fd >= 0) close(fd);
  return std::string(buf);
}

static jsn::Value bracketedMarketOrder() {
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("MARKET"));
  o.set("symbolId", 1.0);
  o.set("volume", 100.0);
  o.set("relativeStopLoss", 50000.0);
  o.set("relativeTakeProfit", 50000.0);
  // Required since PHASE 2 — an order with no account never reaches the socket.
  o.set("ctidTraderAccountId", 4002.0);
  return o;
}

static std::vector<TelemetryRecord> readBack(const std::string& path) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return {};
  std::vector<TelemetryRecord> out;
  TelemetryRecord r;
  while (std::fread(&r, sizeof(r), 1, f) == 1) out.push_back(r);
  std::fclose(f);
  return out;
}

// A naked market order is rejected by the guard before the socket is ever
// touched — no connection needed to exercise the TK_ORDER_REJECT path.
static void test_reject_logs_telemetry() {
  const std::string path = tmpPath();
  Telemetry telemetry(64, path);
  ExecEngine engine;
  engine.setTelemetry(&telemetry);

  jsn::Value naked{jsn::Object{}};
  naked.set("orderType", std::string("MARKET"));
  naked.set("symbolId", 7.0);
  naked.set("volume", 50.0);
  // The account is required since PHASE 2 (owner, 2026-07-30) — without it the
  // guard refuses with guard_no_account and this test would be asserting the
  // wrong rejection. Naming it keeps the NAKED-order path the thing under test.
  naked.set("ctidTraderAccountId", 4002.0);
  EngineResult r = engine.placeOrder(naked);
  assert(!r.ok);

  telemetry.flush();
  auto records = readBack(path);
  assert(records.size() == 1);
  assert(records[0].kind == TK_ORDER_REJECT);
  assert(records[0].symbol_id == 7);
  assert(records[0].volume == 50.0);
  assert(records[0].verdict == 0);
  assert(records[0].reason_code == 3); // guard_naked_order
  std::remove(path.c_str());
}

// PHASE 2: an order that names no account is refused, and the refusal is
// telemetered under its own reason code — so a regression shows up in the
// offline binary log, not only in stderr.
static void test_missing_account_logs_telemetry() {
  const std::string path = tmpPath();
  Telemetry telemetry(64, path);
  ExecEngine engine;
  engine.setTelemetry(&telemetry);

  jsn::Value noAcct{jsn::Object{}};
  noAcct.set("orderType", std::string("MARKET"));
  noAcct.set("symbolId", 9.0);
  noAcct.set("volume", 25.0);
  noAcct.set("relativeStopLoss", 50000.0);
  noAcct.set("relativeTakeProfit", 50000.0);
  EngineResult r = engine.placeOrder(noAcct);
  assert(!r.ok);
  assert(r.body.get("errorCode").asString().find("guard_no_account") != std::string::npos);

  telemetry.flush();
  auto records = readBack(path);
  assert(records.size() == 1);
  assert(records[0].kind == TK_ORDER_REJECT);
  assert(records[0].symbol_id == 9);
  assert(records[0].verdict == 0);
  assert(records[0].reason_code == 10); // guard_no_account
  std::remove(path.c_str());
}

// A bracketed order passes the guard but this engine was never connected —
// request() fails fast with NOT_CONNECTED. Submit + result should both land.
static void test_submit_then_result_logs_telemetry() {
  const std::string path = tmpPath();
  Telemetry telemetry(64, path);
  ExecEngine engine;
  engine.setTelemetry(&telemetry);

  EngineResult r = engine.placeOrder(bracketedMarketOrder());
  assert(!r.ok); // never connected

  telemetry.flush();
  auto records = readBack(path);
  assert(records.size() == 2);
  assert(records[0].kind == TK_ORDER_SUBMIT);
  assert(records[0].verdict == 1);
  assert(records[0].symbol_id == 1);
  assert(records[1].kind == TK_ORDER_RESULT);
  assert(records[1].verdict == 0);
  assert(records[1].reason_code == 6); // NOT_CONNECTED
  std::remove(path.c_str());
}

// No sink attached (the TELEMETRY_PATH-unset production default) — placeOrder
// must behave identically, just without logging anything, never a crash.
static void test_no_telemetry_is_a_safe_noop() {
  ExecEngine engine; // telemetry_ stays null — never call setTelemetry
  jsn::Value naked{jsn::Object{}};
  naked.set("orderType", std::string("MARKET"));
  naked.set("volume", 10.0);
  EngineResult r = engine.placeOrder(naked);
  assert(!r.ok);
  EngineResult r2 = engine.placeOrder(bracketedMarketOrder());
  assert(!r2.ok);
}

int main() {
  test_reject_logs_telemetry();
  test_missing_account_logs_telemetry();
  test_submit_then_result_logs_telemetry();
  test_no_telemetry_is_a_safe_noop();
  std::puts("test_engine_telemetry: all assertions passed");
  return 0;
}
