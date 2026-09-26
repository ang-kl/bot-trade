// cpp-exec/src/term_seal.cpp — see term_seal.hpp.
#include "term_seal.hpp"

#include <pthread.h>
#include <signal.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <thread>

namespace term_seal {

namespace {
extern "C" void noopTermHandler(int) {}

sigset_t termSet() {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGTERM);
  sigaddset(&set, SIGINT);
  return set;
}
} // namespace

bool blockTermSignals() {
  struct sigaction sa{};
  sa.sa_handler = noopTermHandler;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, nullptr);
  sigaction(SIGINT, &sa, nullptr);
  const sigset_t set = termSet();
  return pthread_sigmask(SIG_BLOCK, &set, nullptr) == 0;
}

void startTermWatcher(std::function<void(int)> onTerm, std::function<void(int)> exitFn) {
  std::thread([onTerm = std::move(onTerm), exitFn = std::move(exitFn)] {
    const sigset_t set = termSet();
    int sig = 0;
    while (sigwait(&set, &sig) != 0) {}
    if (onTerm) onTerm(sig);
    std::fflush(nullptr);
    const int code = 128 + sig;
    if (exitFn) exitFn(code);
    else std::_Exit(code);
  }).detach();
}

} // namespace term_seal
