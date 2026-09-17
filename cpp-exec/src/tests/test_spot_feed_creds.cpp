// PR-AB — credentials refresh in place; the feed is not rebuilt for them.
//
// WHAT WAS WRONG (measured 17-09-2026 on the demo sidecar):
//
//   10:01:25  credentials updated via /connect … → spot feed (re)started: 0 VPO symbol(s)
//   10:04:05  credentials updated via /connect … → spot feed (re)started: 0 VPO symbol(s)
//                                                → subscribed to 53 symbol(s)
//
// Every POST /connect tore the feed down and built a new one, and with a tick
// recorder configured that teardown was unconditional. A fresh SpotFeed starts
// at generation 1, and tick_recorder.cpp writes a GAP on any generation
// change — so a CREDENTIAL ROTATION, which the feed's already-authenticated
// connection does not care about, cost a hole in the tick record plus a full
// resubscribe. Neither restart above was caused by an input the feed reads.
//
// These tests need no broker: updateCredentials() is pure state, and the
// point is precisely that it does NOT touch the connection.
#include <cassert>
#include <cstdio>
#include <string>
#include <thread>

#include "../spot_feed.hpp"

namespace {

SpotFeed makeFeed() {
  return SpotFeed("127.0.0.1", "cid", "csecret", "token", 1234567,
                  /*symbolIds=*/{}, /*onTick=*/nullptr, /*depthEnabled=*/false);
}

// A rotated token is stored and reported as a change.
void testRotationIsAChange() {
  SpotFeed feed = makeFeed();
  assert(feed.updateCredentials("cid", "csecret", "token-2") && "a new token is a change");
  assert(!feed.updateCredentials("cid", "csecret", "token-2") && "the same values twice are not");
}

// THE CASE THE PRODUCTION LOG SHOWED: /connect arrives with everything
// identical. Nothing changed, so nothing is written and the caller has no
// reason to rebuild the feed.
void testIdenticalPushIsNotAChange() {
  SpotFeed feed = makeFeed();
  assert(!feed.updateCredentials("cid", "csecret", "token") &&
         "an identical push must report no change, or the feed rebuilds for nothing");
}

// AN EMPTY FIELD IS "NOT SUPPLIED", NEVER "CLEAR IT". /connect treats
// clientSecret as optional, so a blank must not silently un-authenticate the
// next reconnect — a failure that would surface minutes later as a feed that
// cannot come back, with nothing pointing here.
void testEmptyFieldsDoNotClear() {
  SpotFeed feed = makeFeed();
  assert(!feed.updateCredentials("", "", "") && "all-empty changes nothing");
  // A real rotation still lands when only the token is supplied.
  assert(feed.updateCredentials("", "", "token-2"));
  assert(!feed.updateCredentials("", "", "token-2"));
}

// Concurrent refreshes from the HTTP thread while another reader runs: this
// is the shape TSan is pointed at (the feed thread snapshots these under the
// same mutex in connectAuthSubscribe).
void testConcurrentUpdatesAreSafe() {
  SpotFeed feed = makeFeed();
  std::thread a([&feed] {
    for (int i = 0; i < 500; i++) feed.updateCredentials("cid", "csecret", "tok-a" + std::to_string(i));
  });
  std::thread b([&feed] {
    for (int i = 0; i < 500; i++) feed.updateCredentials("cid", "csecret", "tok-b" + std::to_string(i));
  });
  a.join();
  b.join();
  // No assertion on the winner — the property is that this does not race.
  assert(feed.updateCredentials("cid", "csecret", "tok-final"));
}

} // namespace

int main() {
  testRotationIsAChange();
  testIdenticalPushIsNotAChange();
  testEmptyFieldsDoNotClear();
  testConcurrentUpdatesAreSafe();
  std::printf("test_spot_feed_creds: all passed\n");
  return 0;
}
