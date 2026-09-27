// test_health_view.cpp — cpp-verify's open GET /health publishes no account id.
//
// GET /health answers unauthenticated and the repository is public. It used
// to list sessions[].accounts: every ctidTraderAccountId the verifier's
// history sessions were authorized on. health_view::sessions builds that
// array; these tests hold it to an allowlist.
//
// THE POSITIVE CONTROL MATTERS. "The open JSON contains no id" passes just as
// well when the rows carry no ids at all, so every absence check runs beside
// the trusted view of the SAME rows, which must carry every id (CLAUDE.md #1:
// a check that cannot fail proves nothing).

#include <cstdio>
#include <string>
#include <vector>

#include "../health_view.hpp"
#include "../json.hpp"

static int failures = 0;
static void check(bool ok, const char* what) {
  if (!ok) { std::fprintf(stderr, "  FAIL: %s\n", what); ++failures; }
}

static bool has(const std::string& hay, const std::string& needle) {
  return hay.find(needle) != std::string::npos;
}

// Ids long enough that no count or flag could print them by accident.
static const long long kIdA = 46912345, kIdB = 46998877, kIdC = 47011223;

static std::vector<health_view::SessionRow> rows() {
  return {
    {"demo.ctraderapi.com", true, {kIdA, kIdB}},
    {"live.ctraderapi.com", false, {kIdC}},
  };
}

void openViewCarriesNoAccountId() {
  const std::string open = jsn::dump(health_view::sessions(rows(), false));
  const std::string trusted = jsn::dump(health_view::sessions(rows(), true));
  for (long long id : {kIdA, kIdB, kIdC}) {
    const std::string s = std::to_string(id);
    check(has(trusted, s), "positive control: the trusted view lists every authorized account id");
    check(!has(open, s), "the open view lists no account id");
  }
  check(!has(open, "\"accounts\""), "the open view carries no accounts field at all");
  check(has(trusted, "\"accounts\""), "the trusted view keeps the accounts list the operator reads");
}

void openViewKeepsWhatMonitoringNeeds() {
  const jsn::Value v = health_view::sessions(rows(), false);
  check(v.isArray() && v.asArray().size() == 2, "one row per session, open or not");
  const auto& a = v.asArray();
  check(a[0].get("host").asString() == "demo.ctraderapi.com", "row 0 keeps its host");
  check(a[0].get("open").asBool(), "row 0 keeps its open flag");
  check(a[0].get("accountCount").asNumber(-1) == 2, "row 0 keeps its account COUNT");
  check(a[1].get("host").asString() == "live.ctraderapi.com", "row 1 keeps its host");
  check(!a[1].get("open").asBool() && a[1].get("open").isBool(), "row 1 keeps a false open flag, not an absent one");
  check(a[1].get("accountCount").asNumber(-1) == 1, "row 1 keeps its account count");
  // The allowlist: exactly the three named fields, nothing copied beside them.
  check(a[0].asObject().size() == 3, "an open row carries exactly host, open and accountCount");
}

void emptyIsAnEmptyArray() {
  const jsn::Value v = health_view::sessions({}, false);
  check(v.isArray() && v.asArray().empty(), "no sessions is [] — the shape Node's log line was measured on");
  const jsn::Value z = health_view::sessions({{"demo.ctraderapi.com", true, {}}}, false);
  check(z.asArray()[0].get("accountCount").asNumber(-1) == 0, "a session with no accounts reads 0, not absent");
}

int main() {
  openViewCarriesNoAccountId();
  openViewKeepsWhatMonitoringNeeds();
  emptyIsAnEmptyArray();
  if (failures) { std::fprintf(stderr, "test_health_view: %d failure(s)\n", failures); return 1; }
  std::printf("test_health_view: ok\n");
  return 0;
}
