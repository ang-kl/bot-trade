// cpp-verify/src/verify_session.hpp — a READ-ONLY cTrader session.
//
// WHY THIS EXISTS INSTEAD OF REUSING ExecEngine. The owner's requirement
// (17-09-2026) is an INDEPENDENT verifier: it re-fetches a position's deals
// from the broker itself and compares them against the record the keeper
// wrote, so the keeper never certifies its own work. A verifier that links
// the execution engine carries placeOrder/amend/close in its binary, and
// "read-only" then rests on nobody ever wiring a route to them.
//
// So this class implements EXACTLY three broker messages — app auth, account
// auth, deal list — and has no method that can write. The guarantee is
// structural: there is no code path from any HTTP request to an order,
// because the code does not exist in this process.
//
// ONE SESSION PER HOST, WHICH IS THE POINT. cpp-exec and cpp-acct each pin a
// single broker host (CTRADER_HOST) and hold one session. The owner asked for
// ONE verifier covering demo AND live, so this holds a session per host and
// `/connect` adds to the map rather than replacing it. CTRADER_HOST must be
// UNSET on this service — a pin would make the requirement impossible.
#pragma once

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "../../cpp-exec/src/json.hpp"
#include "../../cpp-exec/src/ws_client.hpp"

namespace verify {

/** One deal as the broker reports it. Copied, never recomputed. */
struct Deal {
  long long dealId = 0;
  long long positionId = 0;
  long long symbolId = 0;
  long long volume = 0;
  int tradeSide = 0;              // 1 BUY, 2 SELL
  double executionPrice = 0;
  long long executionTimestamp = 0;
  bool hasClose = false;          // carries closePositionDetail
  double grossProfit = 0;
  double swap = 0;
  double commission = 0;
  double balance = 0;
};

/** What a fetch produced, and whether it is COMPLETE. */
struct DealFetch {
  bool ok = false;
  std::string error;
  std::vector<Deal> deals;
  // PAGING IS NOT OPTIONAL. The keeper's own importer sends maxRows 500 and
  // never reads `hasMore`, so a week with more than 500 deals truncates in
  // silence (measured 17-09). A verifier that inherited that would confirm a
  // record against a partial fetch and call it verified.
  bool complete = false;
  int pages = 0;
};

class VerifySession {
public:
  VerifySession(std::string host, std::string clientId, std::string clientSecret,
                std::string accessToken);

  /** App auth + account auth. Returns false and sets lastError() on failure. */
  bool connect(long long accountId);

  /**
   * Every deal for `accountId` in [fromMs, toMs], following `hasMore` to
   * exhaustion. `complete` is false when the walk stopped early for ANY
   * reason — a caller must treat that as "unknown", never as "none".
   */
  DealFetch deals(long long accountId, long long fromMs, long long toMs);

  bool isOpen() const { return ws_.isOpen(); }
  std::string lastError() const { return lastError_; }
  const std::string& host() const { return host_; }

  /** Tests only: plain TCP to a loopback fake broker instead of TLS. */
  void setLoopbackTransportForTests(int port) { loopbackPort_ = port; }

private:
  std::optional<jsn::Value> sendAndWait(int reqType, const jsn::Value& payload,
                                        int expectType, int timeoutMs);

  std::string host_, clientId_, clientSecret_, accessToken_, lastError_;
  int loopbackPort_ = 0;
  CtraderWs ws_;
  std::mutex mtx_;              // one request at a time on this socket
};

} // namespace verify
