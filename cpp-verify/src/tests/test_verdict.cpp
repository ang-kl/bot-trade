// cpp-verify/src/tests/test_verdict.cpp — the comparison rules, no sockets.
#include <cassert>
#include <cstdio>
#include <string>

#include "../verdict.hpp"

using namespace verify;

namespace {

int failures = 0;
void check(bool cond, const std::string& what) {
  if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what.c_str()); ++failures; }
}

Deal openDeal(long long pos, double price, long long vol, long long ts, double comm = -1.0) {
  Deal d;
  d.dealId = ts;            // unique enough for a fixture
  d.positionId = pos;
  d.symbolId = 22396;
  d.volume = vol;
  d.tradeSide = 1;
  d.executionPrice = price;
  d.executionTimestamp = ts;
  d.commission = comm;
  return d;
}

Deal closeDeal(long long pos, double price, long long vol, long long ts,
               double gross, double swap = 0, double comm = -1.0) {
  Deal d = openDeal(pos, price, vol, ts, comm);
  d.dealId = ts + 1;
  d.tradeSide = 2;
  d.hasClose = true;
  d.grossProfit = gross;
  d.swap = swap;
  return d;
}

DealFetch complete(std::vector<Deal> ds) {
  DealFetch f;
  f.ok = true;
  f.complete = true;
  f.pages = 1;
  f.deals = std::move(ds);
  return f;
}

KeeperRecord matching() {
  KeeperRecord r;
  r.positionId = 500;
  r.symbolId = 22396;
  r.tradeSide = 1;
  r.volume = 10000;
  r.entryPrice = 1.2345;
  r.exitPrice = 1.2445;
  r.netPnl = 98.0;          // gross 100, two commissions of -1
  r.openedAtMs = 1000;
  r.closedAtMs = 2000;
  return r;
}

DealFetch matchingFetch() {
  return complete({openDeal(500, 1.2345, 10000, 1000),
                   closeDeal(500, 1.2445, 10000, 2000, 100.0)});
}

void aRecordThatAgreesWithTheBrokerIsVerified() {
  Verdict v = judge(matching(), matchingFetch());
  check(v.state == State::Verified, "agreeing record verifies");
  check(v.disputes.empty(), "no disputes on an agreeing record");
  check(v.dealCount == 2, "both deals counted");
  check(v.sawOpen && v.sawClose, "open and close both seen");
}

void anIncompleteFetchCanNeverVerifyAndNeverDisputes() {
  // THE RULE THAT MATTERS MOST (I10). The keeper's own importer sends
  // maxRows 500 and ignores hasMore; a verifier that inherited that would
  // confirm records against a truncated read. Here a partial fetch is
  // unverified whether or not the fields happen to agree.
  DealFetch f = matchingFetch();
  f.complete = false;
  f.error = "paging stalled at 1500 with hasMore set";
  Verdict v = judge(matching(), f);
  check(v.state == State::Unverified, "partial fetch does not verify");
  check(v.reason == f.error, "the paging reason is carried, not invented");

  // And with a record that DISAGREES, it still refuses rather than disputing:
  // the gap is ours.
  KeeperRecord wrong = matching();
  wrong.netPnl = -500;
  Verdict v2 = judge(wrong, f);
  check(v2.state == State::Unverified, "partial fetch does not dispute either");
  check(v2.disputes.empty(), "no findings manufactured from a partial read");
}

void aDisagreeingFieldIsNamedWithBothReadings() {
  KeeperRecord r = matching();
  r.entryPrice = 1.2300;                    // broker says 1.2345
  Verdict v = judge(r, matchingFetch());
  check(v.state == State::Disputed, "a wrong entry price disputes");
  check(v.disputes.size() == 1, "exactly one field disputed");
  check(v.disputes[0].field == "entry_price", "the disagreeing FIELD is named");
  check(v.disputes[0].keeper == "1.23", "keeper reading carried");
  check(v.disputes[0].broker == "1.2345", "broker reading carried");
  check(v.disputes[0].delta > 0.0044 && v.disputes[0].delta < 0.0046, "delta is broker - keeper");
  // net_pnl agrees, so it must NOT appear: "the data is corrupt" is not a
  // verdict, "entry_price disagrees" is (CLAUDE.md failure mode #6).
  check(v.reason.find("net_pnl") == std::string::npos, "only the disagreeing field is named");
}

void anAbsentKeeperFieldIsADisputeNotAZero() {
  // The owner's rule: a position record must be totally filled, no null
  // field. So a missing field is a finding — and specifically NOT compared
  // as 0, which would silently "agree" with a broker zero.
  KeeperRecord r = matching();
  r.netPnl = std::nullopt;
  Verdict v = judge(r, matchingFetch());
  check(v.state == State::Disputed, "an absent field disputes");
  check(v.disputes.size() == 1 && v.disputes[0].field == "net_pnl", "the absent field is named");
  check(v.disputes[0].keeper == "absent", "absent is reported as absent, not 0");
}

void aPresentZeroIsAReading() {
  // The mirror of the case above (I5). A broker net P&L of exactly zero and
  // a keeper zero agree — and must not be treated as missing.
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1000, 0.0),
                          closeDeal(500, 1.2345, 10000, 2000, 0.0, 0.0, 0.0)});
  KeeperRecord r = matching();
  r.exitPrice = 1.2345;
  r.netPnl = 0.0;
  Verdict v = judge(r, f);
  check(v.state == State::Verified, "a present zero verifies against a broker zero");
}

void anUnknownPositionIsAbsentNotDisputed() {
  KeeperRecord r = matching();
  r.positionId = 999;                        // no such position in the fetch
  Verdict v = judge(r, matchingFetch());
  check(v.state == State::Absent, "an unknown position is absent");
  check(v.disputes.empty(), "absent carries no field disputes");
}

void aStillOpenPositionIsUnverified() {
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1000)});
  Verdict v = judge(matching(), f);
  check(v.state == State::Unverified, "no closing deal means unverified");
  check(v.reason.find("still open") != std::string::npos, "and says why");
}

void anOpeningDealOutsideTheWindowIsUnverified() {
  // Only the closing deal is in range: the entry price cannot be checked, so
  // the answer is "widen the window", not "entry_price disagrees".
  DealFetch f = complete({closeDeal(500, 1.2445, 10000, 2000, 100.0)});
  Verdict v = judge(matching(), f);
  check(v.state == State::Unverified, "a missing opening deal does not dispute");
  check(v.reason.find("window") != std::string::npos, "and names the window");
}

void partialClosesAreVolumeWeightedAndSummed() {
  DealFetch f = complete({openDeal(500, 1.0, 20000, 1000),
                          closeDeal(500, 1.10, 10000, 2000, 50.0),
                          closeDeal(500, 1.20, 10000, 3000, 100.0)});
  KeeperRecord r;
  r.positionId = 500;
  r.symbolId = 22396;
  r.tradeSide = 1;
  r.volume = 20000;
  r.entryPrice = 1.0;
  r.exitPrice = 1.15;                        // (1.10 + 1.20) / 2, volume-weighted
  r.netPnl = 147.0;                          // 150 gross, three commissions of -1
  r.openedAtMs = 1000;
  r.closedAtMs = 3000;                       // the LAST close
  Verdict v = judge(r, f);
  check(v.state == State::Verified, "two partial closes reconcile");
  check(v.dealCount == 3, "all three deals counted");
}

void anotherPositionsDealsAreNeverMixedIn() {
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1000),
                          closeDeal(500, 1.2445, 10000, 2000, 100.0),
                          openDeal(600, 9.9, 99999, 1500),
                          closeDeal(600, 1.0, 99999, 2500, -9999.0)});
  Verdict v = judge(matching(), f);
  check(v.state == State::Verified, "a second position in the window changes nothing");
  check(v.dealCount == 2, "only this position's deals are counted");
}

void theJsonCarriesTheBrokerFiguresAndTheDisputes() {
  KeeperRecord r = matching();
  r.exitPrice = 1.0;
  std::string js = verdictJson(judge(r, matchingFetch()));
  check(js.find("\"state\":\"disputed\"") != std::string::npos, "state in the json");
  check(js.find("exit_price") != std::string::npos, "the field name in the json");
  check(js.find("\"broker\"") != std::string::npos, "broker figures in the json");
}

} // namespace

int main() {
  aRecordThatAgreesWithTheBrokerIsVerified();
  anIncompleteFetchCanNeverVerifyAndNeverDisputes();
  aDisagreeingFieldIsNamedWithBothReadings();
  anAbsentKeeperFieldIsADisputeNotAZero();
  aPresentZeroIsAReading();
  anUnknownPositionIsAbsentNotDisputed();
  aStillOpenPositionIsUnverified();
  anOpeningDealOutsideTheWindowIsUnverified();
  partialClosesAreVolumeWeightedAndSummed();
  anotherPositionsDealsAreNeverMixedIn();
  theJsonCarriesTheBrokerFiguresAndTheDisputes();

  if (failures) { std::fprintf(stderr, "test_verdict: %d failure(s)\n", failures); return 1; }
  std::fprintf(stderr, "test_verdict: all passed\n");
  return 0;
}
