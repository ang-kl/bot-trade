// cpp-exec/src/term_seal.hpp — GW-1 (V3-SEQUENCE item 38, P8c item 1): the
// SIGTERM seal.
//
// Before this, SIGTERM had its default action: the kernel ended the process
// on the spot, the tick recorder's open segment was never fsynced or renamed,
// and every redeploy left a ".tks.open" tail for the next boot to quarantine.
// runuser, the entrypoint's privilege drop, made it worse: it forwards
// SIGTERM and SIGKILLs its child 2 s later (measured), so even a handler
// would have had 2 s. The entrypoint now execs through setpriv (no process
// in between), and this unit turns the signal into an orderly seal:
//
//   1. blockTermSignals() — called in main BEFORE any thread starts, so every
//      thread inherits a mask with SIGTERM and SIGINT blocked and no thread
//      can take the signal with its default action;
//   2. startTermWatcher(onTerm) — one detached thread sigwait()s for either
//      signal, runs `onTerm` (main passes the recorder's stop(): drain,
//      fsync, rename), flushes stdio and leaves with _Exit(128 + signal) —
//      143 for SIGTERM. Nonzero on purpose: railway.json's restartPolicyType
//      is ON_FAILURE, so a SIGTERM that is not a redeploy still restarts the
//      service. _Exit, not exit(): the other threads are still running, and
//      static destructors under them are a crash, not a shutdown.
#pragma once
#include <functional>

namespace term_seal {

// Blocks SIGTERM and SIGINT in the calling thread (and so in every thread it
// starts afterwards). A no-op handler is installed as well, so a thread that
// somehow runs with them unblocked cannot take the default action (which, in
// a container, ends PID 1 without the seal). Returns false if the mask could
// not be set.
bool blockTermSignals();

// Starts the detached watcher. `onTerm(sig)` runs on the watcher thread; the
// process then exits 128 + sig. `exitFn` replaces _Exit (tests only).
void startTermWatcher(std::function<void(int)> onTerm, std::function<void(int)> exitFn = {});

} // namespace term_seal
