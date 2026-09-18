// cpp-verify/src/journal.hpp — the verifier's OWN record of what it said.
//
// WHY A SECOND COPY EXISTS, and it is not redundancy for its own sake.
//
// A verdict is written back into `position_history` — the AGENT'S database.
// That means the auditor's findings are stored by the audited party. If that
// row is later rebuilt, reset, or simply wrong about what the verifier said,
// there is no second copy to appeal to. An auditor whose only record lives
// with the audited is a weak auditor, and this service exists precisely so
// that nothing certifies its own work.
//
// So every verdict is also appended HERE, on cpp-verify's own volume, in a
// file the agent cannot reach. Append-only, one file per month, one JSON
// object per line — the same shape as the Node-side archive so both can be
// read with the same tools.
//
// UNCONFIGURED IS A STATE, NOT A FAILURE (the rule verify-client.js states for
// VERIFY_URL, applied here). With no VERIFY_JOURNAL_DIR the journal is off,
// `/health` says so, and verdicts are still served — a service that refused to
// verify because it could not write its diary would be trading one failure for
// a worse one.
//
// AND IT PROVES IT CAN WRITE, AT BOOT. The volume is mounted at /data and this
// process runs as `appuser` (uid 10001, --no-create-home): a root-owned mount
// is a real possibility, and a journal that silently drops every line while
// reporting healthy is exactly CLAUDE.md failure mode #3. So open() performs
// a real write at startup and `/health` carries the answer, including the
// errno reason when it fails.
#pragma once

#include <mutex>
#include <string>

namespace verify {

class Journal {
 public:
  /**
   * Point the journal at a directory. Empty dir = off (not an error).
   *
   * Performs a REAL APPEND at boot rather than an access() check: permissions
   * on a mounted volume can pass a stat and still refuse a write, and the only
   * honest test of "can I write here" is writing.
   */
  void open(const std::string& dir);

  /** Append one verdict line. Returns false and records why on failure. */
  bool append(const std::string& line);

  bool configured() const { return !dir_.empty(); }
  bool writable() const { return writable_; }
  const std::string& dir() const { return dir_; }
  const std::string& lastError() const { return lastError_; }
  long long written() const { return written_; }

  /** The month file this would append to now, for /health and for tests. */
  std::string pathFor(long long epochMs) const;

 private:
  mutable std::mutex mtx_;
  std::string dir_;
  std::string lastError_;
  bool writable_ = false;
  long long written_ = 0;
};

/** The process-wide journal. */
Journal& journal();

}  // namespace verify
