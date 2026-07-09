// cpp-exec/src/ws_client.hpp
//
// TLS WebSocket client for the cTrader JSON feed (wss://host:5036).
// Frame encode/decode are free functions so the unit tests can exercise the
// wire format without sockets or OpenSSL handshakes.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wsframe {

enum Opcode : uint8_t {
  CONT = 0x0, TEXT = 0x1, BINARY = 0x2, CLOSE = 0x8, PING = 0x9, PONG = 0xA,
};

struct Frame {
  uint8_t opcode = 0;
  bool fin = true;
  std::string payload;
  size_t bytesConsumed = 0; // how many input bytes the decoder used
};

// Client frames MUST be masked (RFC 6455 §5.3); maskKey lets tests be
// deterministic — production callers pass a random key.
std::vector<uint8_t> encodeFrame(uint8_t opcode, const std::string& payload,
                                 const uint8_t maskKey[4]);

// Decode one server frame from the head of `buf`. nullopt = need more bytes.
// Frames with the reserved bits set or masked server frames decode with
// opcode 0xFF so the caller can fail the connection.
std::optional<Frame> decodeFrame(const std::vector<uint8_t>& buf);

} // namespace wsframe

// Computes the Sec-WebSocket-Accept value for a given key (RFC 6455 §4.2.2).
std::string wsAcceptFor(const std::string& secWebSocketKey);

class CtraderWs {
public:
  CtraderWs() = default;
  ~CtraderWs();
  CtraderWs(const CtraderWs&) = delete;
  CtraderWs& operator=(const CtraderWs&) = delete;

  // TLS connect + HTTP upgrade. Returns false (and sets lastError) on any
  // failure; the object is safe to reuse for another connect().
  bool connect(const std::string& host, int port = 5036);
  bool sendText(const std::string& text);
  // Waits up to timeoutMs for a complete text frame. Handles ping->pong and
  // close internally. nullopt = timeout, closed, or error (check isOpen()).
  std::optional<std::string> recvText(int timeoutMs);
  void close();
  bool isOpen() const { return open_; }
  const std::string& lastError() const { return lastError_; }

private:
  bool sendFrame(uint8_t opcode, const std::string& payload);
  bool fillBuffer(int timeoutMs); // one TLS read into buf_, respecting timeout
  bool sendRaw(const uint8_t* data, size_t len);
  void teardown();

  int fd_ = -1;
  void* ssl_ = nullptr;   // SSL*      (void* keeps OpenSSL out of this header)
  void* ctx_ = nullptr;   // SSL_CTX*
  bool open_ = false;
  std::vector<uint8_t> buf_;
  std::string lastError_;
};
