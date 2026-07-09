// cpp-exec/src/tests/test_frames.cpp — WS frame encode/decode without sockets.
// Build: clang++ -std=c++20 -I.. -I$(brew --prefix openssl@3)/include \
//        test_frames.cpp ../ws_client.cpp -L$(brew --prefix openssl@3)/lib \
//        -lssl -lcrypto -o test_frames && ./test_frames
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "../ws_client.hpp"

using wsframe::decodeFrame;
using wsframe::encodeFrame;

static const uint8_t kMask[4] = {0x12, 0x34, 0x56, 0x78};

// Server frames are unmasked: unmask an encoded client frame to simulate one.
static std::vector<uint8_t> asServerFrame(uint8_t opcode, const std::string& payload) {
  std::vector<uint8_t> out;
  out.push_back(static_cast<uint8_t>(0x80 | opcode));
  size_t n = payload.size();
  if (n < 126) out.push_back(static_cast<uint8_t>(n));
  else if (n <= 0xFFFF) {
    out.push_back(126);
    out.push_back(static_cast<uint8_t>(n >> 8));
    out.push_back(static_cast<uint8_t>(n & 0xFF));
  } else {
    out.push_back(127);
    for (int i = 7; i >= 0; --i)
      out.push_back(static_cast<uint8_t>((static_cast<uint64_t>(n) >> (8 * i)) & 0xFF));
  }
  out.insert(out.end(), payload.begin(), payload.end());
  return out;
}

static void testEncodeSmall() {
  auto f = encodeFrame(wsframe::TEXT, "{\"payloadType\":51}", kMask);
  assert(f[0] == 0x81);          // FIN + text
  assert((f[1] & 0x80) != 0);    // mask bit set — client frames MUST mask
  assert((f[1] & 0x7F) == 18);   // length
  assert(f[2] == 0x12 && f[5] == 0x78); // mask key in place
  // first payload byte '{' xor mask[0]
  assert(f[6] == ('{' ^ 0x12));
  assert(f.size() == 2 + 4 + 18);
}

static void testEncodeMedium() {
  std::string payload(300, 'x');
  auto f = encodeFrame(wsframe::TEXT, payload, kMask);
  assert((f[1] & 0x7F) == 126);
  assert(f[2] == 0x01 && f[3] == 0x2C); // 300 big-endian
  assert(f.size() == 4 + 4 + 300);
}

static void testEncodeLarge() {
  std::string payload(70000, 'y');
  auto f = encodeFrame(wsframe::TEXT, payload, kMask);
  assert((f[1] & 0x7F) == 127);
  uint64_t len = 0;
  for (int i = 0; i < 8; ++i) len = (len << 8) | f[2 + i];
  assert(len == 70000);
  assert(f.size() == 10 + 4 + 70000);
}

static void testEncodeMaskingReversible() {
  std::string payload = "hello \xe4\xb8\xad frames";
  auto f = encodeFrame(wsframe::TEXT, payload, kMask);
  std::string unmasked;
  for (size_t i = 6; i < f.size(); ++i)
    unmasked += static_cast<char>(f[i] ^ kMask[(i - 6) % 4]);
  assert(unmasked == payload);
}

static void testDecodeText() {
  auto buf = asServerFrame(wsframe::TEXT, "{\"payloadType\":2101,\"payload\":{}}");
  auto f = decodeFrame(buf);
  assert(f && f->fin && f->opcode == wsframe::TEXT);
  assert(f->payload == "{\"payloadType\":2101,\"payload\":{}}");
  assert(f->bytesConsumed == buf.size());
}

static void testDecodeNeedsMoreBytes() {
  auto full = asServerFrame(wsframe::TEXT, "abcdef");
  // every strict prefix must decode to "need more"
  for (size_t cut = 0; cut < full.size(); ++cut) {
    std::vector<uint8_t> part(full.begin(), full.begin() + static_cast<long>(cut));
    assert(!decodeFrame(part));
  }
  assert(decodeFrame(full));
}

static void testDecodeMediumAndLarge() {
  std::string mid(500, 'm');
  auto f1 = decodeFrame(asServerFrame(wsframe::TEXT, mid));
  assert(f1 && f1->payload == mid);
  std::string big(70000, 'b');
  auto f2 = decodeFrame(asServerFrame(wsframe::BINARY, big));
  assert(f2 && f2->opcode == wsframe::BINARY && f2->payload.size() == 70000);
}

static void testDecodePingClose() {
  auto ping = decodeFrame(asServerFrame(wsframe::PING, "hb"));
  assert(ping && ping->opcode == wsframe::PING && ping->payload == "hb");
  auto close = decodeFrame(asServerFrame(wsframe::CLOSE, ""));
  assert(close && close->opcode == wsframe::CLOSE);
}

static void testDecodeTwoFramesBuffered() {
  auto a = asServerFrame(wsframe::TEXT, "first");
  auto b = asServerFrame(wsframe::TEXT, "second");
  std::vector<uint8_t> both = a;
  both.insert(both.end(), b.begin(), b.end());
  auto f1 = decodeFrame(both);
  assert(f1 && f1->payload == "first" && f1->bytesConsumed == a.size());
  std::vector<uint8_t> rest(both.begin() + static_cast<long>(f1->bytesConsumed), both.end());
  auto f2 = decodeFrame(rest);
  assert(f2 && f2->payload == "second");
}

static void testDecodeRejectsMaskedServerFrame() {
  auto bad = encodeFrame(wsframe::TEXT, "masked", kMask); // mask bit set
  auto f = decodeFrame(bad);
  assert(f && f->opcode == 0xFF); // flagged as protocol violation
}

static void testDecodeRejectsRsvBits() {
  auto buf = asServerFrame(wsframe::TEXT, "x");
  buf[0] |= 0x40; // RSV1 without negotiated extension
  auto f = decodeFrame(buf);
  assert(f && f->opcode == 0xFF);
}

static void testRoundtripThroughUnmask() {
  // encode -> strip mask -> decode must return the original payload
  std::string payload = "{\"payloadType\":2106,\"payload\":{\"symbolId\":41}}";
  auto client = encodeFrame(wsframe::TEXT, payload, kMask);
  std::vector<uint8_t> server;
  server.push_back(client[0]);
  server.push_back(client[1] & 0x7F); // clear mask bit
  for (size_t i = 6; i < client.size(); ++i)
    server.push_back(client[i] ^ kMask[(i - 6) % 4]);
  auto f = decodeFrame(server);
  assert(f && f->payload == payload);
}

static void testAcceptKey() {
  // RFC 6455 §1.3 worked example
  assert(wsAcceptFor("dGhlIHNhbXBsZSBub25jZQ==") ==
         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

int main() {
  testEncodeSmall();
  testEncodeMedium();
  testEncodeLarge();
  testEncodeMaskingReversible();
  testDecodeText();
  testDecodeNeedsMoreBytes();
  testDecodeMediumAndLarge();
  testDecodePingClose();
  testDecodeTwoFramesBuffered();
  testDecodeRejectsMaskedServerFrame();
  testDecodeRejectsRsvBits();
  testRoundtripThroughUnmask();
  testAcceptKey();
  std::puts("test_frames: all assertions passed");
  return 0;
}
