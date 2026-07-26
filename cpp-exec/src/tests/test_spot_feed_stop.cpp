// P7 / audit C1 + C2 — SpotFeed shutdown.
//
// What was wrong. SpotFeed::stop() called ws_.close() directly, and stop() is
// invoked from an HTTP thread (POST /connect) while the feed thread sits in
// recvText(). close() sends a CLOSE frame (SSL_write) and then tears down:
// SSL_free, then ::close(fd_), then fd_ = -1 — all while the other thread may
// be inside SSL_read on that same SSL*, and whose next fillBuffer() would do
// FD_SET(-1, ...). That is undefined behaviour, not a benign race.
//
// It is also why /connect could hang: main.cpp held vpoMtx across stop() +
// join(), and the feed's reconnect backoff slept up to 60s uninterruptibly,
// so GET /health (same mutex) blocked behind it long enough for the platform
// health check to fail and restart the process, with no crash to explain it.
//
// These tests do not need a broker. Everything below runs against a refused
// TCP connect, which is exactly the state the backoff exists for.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <thread>

#include "../spot_feed.hpp"
#include "../ws_client.hpp"

using namespace std::chrono;

namespace {

// Nothing listens here, so connect() is refused immediately and runLoop()
// spends effectively all of its time in the reconnect backoff.
constexpr const char* kDeadHost = "127.0.0.1";

SpotFeed makeFeed() {
  return SpotFeed(kDeadHost, "cid", "csecret", "token", 1234567,
                  /*symbolIds=*/{}, /*onTick=*/nullptr, /*depthEnabled=*/false);
}

long long msSince(steady_clock::time_point t0) {
  return duration_cast<milliseconds>(steady_clock::now() - t0).count();
}

// stop() must interrupt the backoff sleep, not wait it out.
void testStopInterruptsBackoff() {
  SpotFeed feed = makeFeed();
  std::thread t([&feed] { feed.runLoop(); });

  // Let the backoff climb: 1000ms then 2000ms have elapsed by ~3s, so the
  // feed is now sleeping on a 4000ms wait. A stop() that waits that sleep out
  // — the old std::this_thread::sleep_for — cannot finish inside the bound
  // below; one that signals the condition variable finishes in microseconds.
  std::this_thread::sleep_for(milliseconds(3300));

  auto t0 = steady_clock::now();
  feed.stop();
  t.join();
  const long long took = msSince(t0);
  std::printf("  stop+join during backoff took %lldms\n", took);
  assert(took < 1500);
}

// The common case at /connect: stop() arrives before the feed has got
// anywhere. It must still return the thread, and must not double-free.
void testStopBeforeRun() {
  SpotFeed feed = makeFeed();
  feed.stop();
  auto t0 = steady_clock::now();
  std::thread t([&feed] { feed.runLoop(); });
  t.join();
  assert(msSince(t0) < 1500);
}

// A retry storm at /connect can land two stops on one feed. stop() is
// idempotent by construction — a flag, a socket shutdown that no-ops on
// fd -1, and a notify with no waiter.
void testStopIsIdempotent() {
  SpotFeed feed = makeFeed();
  std::thread t([&feed] { feed.runLoop(); });
  std::this_thread::sleep_for(milliseconds(200));
  feed.stop();
  feed.stop();
  t.join();
  feed.stop(); // after the thread is gone, too
}

// wakeReader() is the cross-thread primitive stop() is built on. On a socket
// that was never opened it must do nothing at all rather than shutdown(-1).
void testWakeReaderOnUnconnectedSocket() {
  CtraderWs ws;
  ws.wakeReader();
  ws.wakeReader();
  assert(!ws.isOpen());
}

// And on a connection that failed: connect() to a refused port leaves fd_ at
// -1 after its own teardown, so the same must hold.
void testWakeReaderAfterFailedConnect() {
  CtraderWs ws;
  const bool ok = ws.connect(kDeadHost, 5036);
  assert(!ok);
  assert(!ws.isOpen());
  ws.wakeReader();
  ws.close(); // close-after-failed-connect is also a no-op
  ws.wakeReader();
}

} // namespace

int main() {
  testWakeReaderOnUnconnectedSocket();
  testWakeReaderAfterFailedConnect();
  testStopBeforeRun();
  testStopIsIdempotent();
  testStopInterruptsBackoff();
  std::printf("test_spot_feed_stop: all assertions passed\n");
  return 0;
}
