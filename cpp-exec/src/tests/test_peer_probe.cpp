// cpp-exec/src/tests/test_peer_probe.cpp — the pure halves of the peer
// probe (PR-B): URL parsing (https and junk REFUSED — a TLS client is what
// this slice deliberately avoids) and HTTP status extraction. The socket
// path is exercised against a live peer in deployment; hysteresis lives in
// runLoop and is covered by the down-after-3 constant being the single
// transition writer (reviewed, not simulated — no fake-socket harness here).
#include <cassert>
#include <cstdio>
#include <string>

#include "../peer_probe.hpp"

static void test_parse_peer_url() {
  std::string h, p;
  int port = 0;
  assert(parsePeerUrl("http://cpp-acct.railway.internal:8080", h, port, p));
  assert(h == "cpp-acct.railway.internal" && port == 8080 && p == "/health");
  assert(parsePeerUrl("http://peer:9000/custom", h, port, p));
  assert(h == "peer" && port == 9000 && p == "/custom");
  // Refused shapes: https (no TLS client by design), no port, junk, empty.
  assert(!parsePeerUrl("https://peer:8080", h, port, p));
  assert(!parsePeerUrl("http://peer", h, port, p));
  assert(!parsePeerUrl("http://:8080", h, port, p));
  assert(!parsePeerUrl("peer:8080", h, port, p));
  assert(!parsePeerUrl("http://peer:0", h, port, p));
  assert(!parsePeerUrl("http://peer:99999", h, port, p));
  assert(!parsePeerUrl("", h, port, p));
}

static void test_parse_http_status() {
  assert(parseHttpStatus("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}") == 200);
  assert(parseHttpStatus("HTTP/1.0 503 Service Unavailable\r\n\r\n") == 503);
  assert(parseHttpStatus("HTTP/1.1 404") == 404);
  assert(parseHttpStatus("") == -1);
  assert(parseHttpStatus("garbage") == -1);
  assert(parseHttpStatus("HTTP/1.1 ") == -1);
  assert(parseHttpStatus("HTTP/1.1 xx1") == -1);
}

static void test_bad_url_stays_off() {
  PeerProbe probe;
  probe.start("not-a-url", nullptr);
  assert(!probe.enabled());
  probe.start("", nullptr);
  assert(!probe.enabled());
  probe.stop(); // stop on a never-started probe must be a safe no-op
}

int main() {
  test_parse_peer_url();
  test_parse_http_status();
  test_bad_url_stays_off();
  std::printf("test_peer_probe: OK\n");
  return 0;
}
