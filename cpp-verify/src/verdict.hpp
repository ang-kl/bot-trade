// cpp-verify/src/verdict.hpp — comparing a keeper record against the broker.
//
// This is the whole point of the service, so it is a pure function over two
// inputs and lives apart from the socket and the HTTP route: it is testable
// without a broker, and every rule below is exercised by test_verdict.cpp.
//
// THE RULES IT ENCODES (the owner's invariants for a closed-position record,
// 17-09-2026):
//
//   I5  a present zero is a reading; an ABSENT field is not a zero.
//   I10 `hasMore` is followed to exhaustion — a partial fetch can never
//       produce `verified`.
//   I12 name the DISAGREEING FIELD before calling anything wrong. The
//       verdict carries a per-field list, never a bare boolean.
//   I16 the states are unverified / verified / disputed, and "the broker has
//       no such position" is its own state (`absent`), not a dispute.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "verify_session.hpp"

namespace verify {

/**
 * What the keeper says about one closed position. Every field is OPTIONAL in
 * the C++ sense on purpose: the difference between "the keeper recorded 0"
 * and "the keeper recorded nothing" is exactly what the completeness gate
 * exists to catch, and `double = 0` cannot express it (CLAUDE.md: absent is
 * not the same as none).
 */
struct KeeperRecord {
  long long positionId = 0;
  std::optional<long long> symbolId;
  std::optional<int> tradeSide;        // opening side: 1 BUY, 2 SELL
  std::optional<long long> volume;
  std::optional<double> entryPrice;
  std::optional<double> exitPrice;
  std::optional<double> netPnl;
  std::optional<long long> openedAtMs;
  std::optional<long long> closedAtMs;
};

/** One field the two sources disagree about, with both readings. */
struct FieldDispute {
  std::string field;
  std::string keeper;   // rendered, or "absent"
  std::string broker;
  double delta = 0;     // broker - keeper for numerics, 0 otherwise
};

enum class State { Unverified, Verified, Disputed, Absent };

struct Verdict {
  State state = State::Unverified;
  // Why, in one line, when the state is not Verified. Never empty then.
  std::string reason;
  std::vector<FieldDispute> disputes;
  // What the broker actually reported, so the caller can store the verified
  // figures rather than re-deriving them (I8: broker figures are copied).
  int dealCount = 0;
  bool sawOpen = false;
  bool sawClose = false;
  std::optional<double> brokerEntryPrice;
  std::optional<double> brokerExitPrice;
  std::optional<double> brokerNetPnl;
  std::optional<long long> brokerOpenedAtMs;
  std::optional<long long> brokerClosedAtMs;
  std::optional<long long> brokerVolume;
  std::optional<long long> brokerSymbolId;
  std::optional<int> brokerTradeSide;
};

/** Tolerances. Prices are compared in absolute terms against the instrument's
 *  own scale, money to the cent — both deliberately tight: a verifier that
 *  shrugs at a disagreement is not a verifier. */
struct Tolerance {
  double price = 1e-9;   // exact, modulo binary representation
  double money = 0.005;  // half a cent
};

/**
 * Compare. `fetch` must be the result of VerifySession::deals over a window
 * that CONTAINS the position's whole life; an incomplete fetch yields
 * Unverified with the paging reason, never Disputed — a gap in our reading is
 * not evidence against the keeper.
 */
Verdict judge(const KeeperRecord& rec, const DealFetch& fetch, Tolerance tol = {});

/** Verdict as the JSON the route answers with. */
std::string verdictJson(const Verdict& v);

const char* stateName(State s);

} // namespace verify
