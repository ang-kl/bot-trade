// cpp-exec/src/tests/test_engine_accounts.cpp — M2 multi-account roster
// bookkeeping on ExecEngine. No network: everything here happens before a
// connection exists (roster assembly, dedupe, credential resets, empty
// reconcile snapshots). The incremental live-session AccountAuth path needs
// a broker socket and is exercised on staging (plan M4).
#include <cassert>
#include <cstdio>

#include "../engine.hpp"

int main() {
  // Fresh engine: no credentials, empty roster.
  {
    ExecEngine e;
    assert(!e.hasCredentials());
    assert(e.accountIds().empty());
  }

  // Roster assembly: primary first, extras appended, duplicates dropped.
  {
    ExecEngine e;
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok", 100,
                     {200, 300, 200, 100});
    assert(e.hasCredentials());
    auto ids = e.accountIds();
    assert(ids.size() == 3);
    assert(ids[0] == 100 && ids[1] == 200 && ids[2] == 300);
  }

  // Single-account call keeps the legacy shape exactly.
  {
    ExecEngine e;
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok", 42);
    auto ids = e.accountIds();
    assert(ids.size() == 1 && ids[0] == 42);
  }

  // A different token is a NEW session: the roster resets to the new set
  // (the old accounts' auth belonged to the old token).
  {
    ExecEngine e;
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok1", 100, {200});
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok2", 500, {600});
    auto ids = e.accountIds();
    assert(ids.size() == 2);
    assert(ids[0] == 500 && ids[1] == 600);
  }

  // Non-positive ids are ignored everywhere.
  {
    ExecEngine e;
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok", 100, {0, -5});
    assert(e.accountIds().size() == 1);
  }

  // Per-account reconcile snapshots start empty for every id.
  {
    ExecEngine e;
    e.setCredentials("demo.ctraderapi.com", "ci", "cs", "tok", 100, {200});
    assert(e.lastReconcileJson(100).empty());
    assert(e.lastReconcileAtMs(200) == 0);
    assert(e.lastReconcileJson().empty()); // primary alias
  }

  std::printf("test_engine_accounts: all assertions passed\n");
  return 0;
}
