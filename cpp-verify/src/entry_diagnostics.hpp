#pragma once
#include "json.hpp"

namespace verify {
// Relays Node's own per-account entry records (the `entryDiagnostics` block of
// the Node watchdog contract) onto /watchdog-status. PURE and TRANSPORT-FREE:
// it includes json.hpp and nothing else, holds no session, and can place,
// amend or cancel nothing — agent/services/sidecar-pins.test.js pins that.
//
// What it relays is NOT verified here. cpp-verify did not observe Node's
// refusals and cannot confirm them at the broker, so the payload is labelled
// `node_records_relayed` / brokerVerified:false. The one broker-read value is
// each account's open-position count, taken from cpp-verify's OWN protection
// reconcile (fresh, ok, source broker_reconcile), never from Node.
//
//   diagnostics  the block as Node sent it (held in memory only: the watchdog
//                state file that is fsynced every probe never carries it)
//   contractAtMs when cpp-verify accepted the Node contract that carried it
//                (0 = none since this process started)
//   protection   ProtectionWatch::status()
//   graceMs      the service grace; an older contract is marked stale
jsn::Value entryDiagnosticsView(const jsn::Value& diagnostics, long long contractAtMs,
                                const jsn::Value& protection, long long now, long long graceMs);
}
