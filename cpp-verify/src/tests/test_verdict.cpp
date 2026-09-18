// cpp-verify/src/tests/test_verdict.cpp — the comparison rules, no sockets.
#include <cassert>
#include <cmath>
#include <cstdio>
#include <string>

#include "../verdict.hpp"

using namespace verify;

namespace {

int failures = 0;
void check(bool cond, const std::string& what) {
  if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what.c_str()); ++failures; }
}

// THE FIXTURES SPEAK IN THE BROKER'S UNITS, because that is what the code
// under test receives: volume in CENTS OF UNITS and money scaled by
// moneyDigits. The helpers take units and dollars and convert, so a test
// reads in the keeper's terms while the Deal carries the wire's.
constexpr double kCenti = 100.0;   // cents of units, and moneyDigits = 2

Deal openDeal(long long pos, double price, double units, long long ts, double commDollars = -1.0) {
  Deal d;
  d.dealId = ts;            // unique enough for a fixture
  d.positionId = pos;
  d.symbolId = 22396;
  d.volume = static_cast<long long>(units * kCenti);
  d.tradeSide = 1;
  d.executionPrice = price;
  d.executionTimestamp = ts;
  d.commission = commDollars * kCenti;
  return d;
}

Deal closeDeal(long long pos, double price, double units, long long ts,
               double grossDollars, double swapDollars = 0, double commDollars = -1.0) {
  Deal d = openDeal(pos, price, units, ts, commDollars);
  d.dealId = ts + 1;
  d.tradeSide = 2;
  d.hasClose = true;
  d.grossProfit = grossDollars * kCenti;
  d.swap = swapDollars * kCenti;
  return d;
}

DealFetch complete(std::vector<Deal> ds) {
  DealFetch f;
  f.ok = true;
  f.complete = true;
  f.pages = 1;
  f.deals = std::move(ds);
  f.moneyDigits = 2;        // what the broker reports; see moneyDigitsUnknown*
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


// ---------------------------------------------------------------------------
// PR-AW — the units the broker actually speaks.
//
// MEASURED 18-09-2026, the verifier's first ten live verdicts: ten records,
// ten `disputed`, and every single net_pnl off by EXACTLY 100x —
// 9/900, -52.2/-5220, -10.92/-1092, 28.73/2873, 44.71/4471, 34.16/3416,
// -143.4/-14340. A constant factor across three asset classes is not a
// corrupt ledger, it is a unit. cTrader scales money by 10^moneyDigits and
// deal volume by 100 (cents of units); this service compared both raw.
//
// The consequence was not noise but silence: with a constant factor on money,
// NO record could ever reach `verified`, whatever its data. A guard that
// cannot return agreement is failure mode #3 wearing a verdict.
// ---------------------------------------------------------------------------

void theTenMeasuredDisputesWereTheVerifiersOwnUnits() {
  // 2020.HK position 241485960 as the broker reported it and as the keeper
  // stored it. Before this fix: volume 612 vs 61200, net_pnl -10.92 vs -1092.
  KeeperRecord r;
  r.positionId = 241485960;
  r.symbolId = 22396;
  r.tradeSide = 1;
  r.volume = 612;                  // units
  r.entryPrice = 10.0;
  r.exitPrice = 9.98;
  r.netPnl = -10.92;               // dollars
  r.openedAtMs = 1789369726000;    // the keeper's second precision
  r.closedAtMs = 1789435930589;

  DealFetch f = complete({
    openDeal(241485960, 10.0, 612, 1789369726429, 0.0),
    closeDeal(241485960, 9.98, 612, 1789435930661, -10.92, 0.0, 0.0),
  });
  Verdict v = judge(r, f);
  check(v.state == State::Verified,
        "the 2020.HK row verifies once volume and money are read in the broker's units: " + v.reason);
  check(v.brokerVolume && std::fabs(*v.brokerVolume - 612) < 1e-9, "brokerVolume is units, not centi-units");
  check(v.brokerNetPnl && std::fabs(*v.brokerNetPnl - (-10.92)) < 0.005, "brokerNetPnl is dollars, not cents");
}

void aFractionalVolumeIsNotTruncatedIntoADispute() {
  // COST.US 241583897: keeper 9.4 units, broker 940 centi-units. The route
  // read the keeper's REAL volume as long long, truncated it to 9, and then
  // disputed its own truncation.
  KeeperRecord r;
  r.positionId = 7;
  r.symbolId = 1;
  r.tradeSide = 1;
  r.volume = 9.4;
  r.entryPrice = 100.0;
  r.exitPrice = 103.0;
  r.netPnl = 28.2;
  r.openedAtMs = 1000;
  r.closedAtMs = 2000;
  DealFetch f = complete({openDeal(7, 100.0, 9.4, 1000, 0.0),
                          closeDeal(7, 103.0, 9.4, 2000, 28.2, 0.0, 0.0)});
  f.deals[0].symbolId = 1;
  Verdict v = judge(r, f);
  check(v.state == State::Verified, "9.4 units against 940 centi-units agrees: " + v.reason);
}

void theKeepersSecondPrecisionIsNotADispute() {
  // Every opened_at_ms the keeper stores ends in 000; the broker reports ms.
  KeeperRecord r = matching();
  r.openedAtMs = 1000;
  r.closedAtMs = 2000;
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1421),    // +421 ms
                          closeDeal(500, 1.2445, 10000, 2934, 100.0)});  // +934 ms
  Verdict v = judge(r, f);
  check(v.state == State::Verified, "sub-second format difference is not a finding: " + v.reason);
}

void aRealTimestampGapIsStillCaught() {
  // NATGAS 241647090 on the same pass: closed_at_ms 265 SECONDS late. The
  // tolerance must absorb the format and still catch this.
  KeeperRecord r = matching();
  r.openedAtMs = 1000;
  r.closedAtMs = 1789434084425;
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1000),
                          closeDeal(500, 1.2445, 10000, 1789433819475, 100.0)});
  Verdict v = judge(r, f);
  check(v.state == State::Disputed, "a 265-second gap is a real disagreement");
  check(v.disputes.size() == 1 && v.disputes[0].field == "closed_at_ms",
        "and it is the only one named");
}

void aVolumeOfZeroAgainstARealPositionStillDisputes() {
  // NATGAS 241563888: the keeper recorded volume 0 against 900000 centi-units
  // (9000 units). Not a unit artefact — a real hole, and it must survive.
  KeeperRecord r = matching();
  r.volume = 0;
  DealFetch f = complete({openDeal(500, 1.2345, 9000, 1000),
                          closeDeal(500, 1.2445, 9000, 2000, 100.0)});
  Verdict v = judge(r, f);
  check(v.state == State::Disputed, "volume 0 against 9000 units is a finding, not a unit");
  bool named = false;
  for (const auto& d : v.disputes) if (d.field == "volume") named = true;
  check(named, "and the field is named");
}

void anUnreadableMoneyScaleIsNeverGuessed() {
  DealFetch f = matchingFetch();
  f.moneyDigits.reset();                 // the trader record could not be read
  Verdict v = judge(matching(), f);
  check(v.state == State::Unverified,
        "agreement on what WAS checked is not agreement: a record whose money "
        "nobody compared must not read `verified`");
  check(v.uncompared.size() == 1 && v.uncompared[0] == "net_pnl", "and the skipped field is named");
  check(v.reason.find("money scale") != std::string::npos, "and the reason says why: " + v.reason);
  check(!v.brokerNetPnl, "no figure is published at a guessed scale");
}

void anUnreadableMoneyScaleStillReportsRealDisputes() {
  DealFetch f = matchingFetch();
  f.moneyDigits.reset();
  KeeperRecord r = matching();
  r.entryPrice = 9.99;                   // a disagreement that has nothing to do with money
  Verdict v = judge(r, f);
  check(v.state == State::Disputed, "a price disagreement stands on its own");
  check(v.disputes.size() == 1 && v.disputes[0].field == "entry_price", "named, and money is not invented");
}

void aNonStandardMoneyScaleIsHonoured() {
  // moneyDigits is per-broker, which is exactly why it is read rather than
  // hardcoded. At 3 digits the same wire integers mean a tenth as much.
  DealFetch f = complete({openDeal(500, 1.2345, 10000, 1000),
                          closeDeal(500, 1.2445, 10000, 2000, 100.0)});
  f.moneyDigits = 3;
  KeeperRecord r = matching();
  r.netPnl = 9.8;                        // 9800 wire units at 10^3
  Verdict v = judge(r, f);
  check(v.state == State::Verified, "the broker's own scale is applied, not 2: " + v.reason);
}

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

  theTenMeasuredDisputesWereTheVerifiersOwnUnits();
  aFractionalVolumeIsNotTruncatedIntoADispute();
  theKeepersSecondPrecisionIsNotADispute();
  aRealTimestampGapIsStillCaught();
  aVolumeOfZeroAgainstARealPositionStillDisputes();
  anUnreadableMoneyScaleIsNeverGuessed();
  anUnreadableMoneyScaleStillReportsRealDisputes();
  aNonStandardMoneyScaleIsHonoured();

  if (failures) { std::fprintf(stderr, "test_verdict: %d failure(s)\n", failures); return 1; }
  std::fprintf(stderr, "test_verdict: all passed\n");
  return 0;
}
