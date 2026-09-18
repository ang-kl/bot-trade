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
 * THE COMPARISON CONTRACT'S VERSION, and the reason it exists.
 *
 * A verdict is only as good as the rules that produced it, and those rules
 * have been wrong: until PR-AW this service compared cTrader's money integer
 * against the keeper's dollars and disputed every record by exactly 100x. The
 * fix was correct and reached nothing, because a `disputed` verdict is
 * terminal — the keeper re-arms `unverified` records only, so ten records
 * wrongly disputed on 18-09-2026 would have stayed disputed for ever, judged
 * by a verifier that no longer exists.
 *
 * `disputed` could not tell "the broker and the keeper genuinely disagree"
 * from "the verifier was wrong when it asked". Stamping every verdict with
 * the contract that produced it is what makes that distinction possible: the
 * keeper re-asks anything judged under an older contract, once, and a record
 * re-disputed under the current one is a real finding.
 *
 * BUMP THIS whenever a change alters what counts as agreement — a new field,
 * a changed tolerance, a units correction. Do NOT bump it for a refactor that
 * cannot change a verdict: every bump costs one re-verification of every
 * disputed record.
 *
 *   1 — original (PR-AE).
 *   2 — PR-AW: money scaled by the broker's moneyDigits, volume by 100,
 *       timestamps compared with a 1 s tolerance, volume read as a double.
 */
constexpr int kVerdictContractVersion = 2;

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
  std::optional<double> volume;      // UNITS, as the keeper stores them (REAL)
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
  std::optional<double> brokerVolume;
  std::optional<long long> brokerSymbolId;
  std::optional<int> brokerTradeSide;
  // FIELDS THAT WERE NOT COMPARED, and why. A verdict that silently skips a
  // field and still says `verified` claims more than it checked; anything
  // here forces Unverified instead.
  std::vector<std::string> uncompared;
};

/** Tolerances. Prices are compared in absolute terms against the instrument's
 *  own scale, money to the cent — both deliberately tight: a verifier that
 *  shrugs at a disagreement is not a verifier. */
struct Tolerance {
  double price = 1e-9;   // exact, modulo binary representation
  double money = 0.005;  // half a cent
  double volume = 1e-6;  // units, after the centi-units conversion
  // TIMESTAMPS ARE COMPARED WITH A TOLERANCE, and it is not slack: the keeper
  // records second precision (every opened_at_ms it stores ends in 000) while
  // the broker reports milliseconds, so a zero tolerance disputed every
  // record on a difference that is a known property of the two formats. One
  // second is the keeper's own resolution. It is far tighter than the real
  // disagreements this found on the same pass — NATGAS closed_at_ms late by
  // 265 SECONDS — which is the point: the tolerance must absorb the format
  // and still catch the defect.
  double timeMs = 1000;
};

/** cTrader expresses deal volume in CENTS OF UNITS (agent/lib/lot-sizing.js
 *  documents the same constant for the order path). It is a protocol-wide
 *  scale, not a per-symbol one — lotSize converts units to LOTS, which is a
 *  different question. Measured against four symbols across three asset
 *  classes on 18-09-2026: 61200/612, 1500/15, 1800/18, 3610/36.1. */
constexpr double kVolumeCentiUnits = 100.0;

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
