// cpp-exec/src/ws_client.hpp
//
// TLS WebSocket client for the cTrader JSON feed (wss://host:5036).
// Frame encode/decode are free functions so the unit tests can exercise the
// wire format without sockets or OpenSSL handshakes.
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
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
// deterministic — production callers pass a random key. A null maskKey
// encodes an UNMASKED frame, which is what a server sends (P2b-2: the fake
// broker in the async-session tests is the only server this repo writes).
std::vector<uint8_t> encodeFrame(uint8_t opcode, const std::string& payload,
                                 const uint8_t maskKey[4]);

// Decode one frame from the head of `buf`. nullopt = need more bytes.
// Frames with the reserved bits set decode with opcode 0xFF so the caller
// can fail the connection. `fromClient` selects which side's rules apply:
// a server frame (the default, what this client reads) must NOT be masked;
// a client frame (what the fake broker reads) MUST be, and is unmasked here.
std::optional<Frame> decodeFrame(const std::vector<uint8_t>& buf, bool fromClient = false);

} // namespace wsframe

// Computes the Sec-WebSocket-Accept value for a given key (RFC 6455 §4.2.2).
std::string wsAcceptFor(const std::string& secWebSocketKey);

// One connection, shared by a READER thread and any number of WRITER threads
// (P2b-2, the async broker session):
//
//   connect / recvText / close  — the reader (owning) thread ONLY. The reader
//                                 owns fd_/ssl_/ctx_ lifetime and buf_.
//   sendText                    — ANY thread. Serialized by ioMtx_ against the
//                                 reader's SSL_read: OpenSSL forbids SSL_read
//                                 and SSL_write on one SSL* concurrently
//                                 (threads(7)), and that lock is what makes
//                                 the split safe. The reader waits for
//                                 readability OUTSIDE the lock (select on the
//                                 fd), so a writer is never held for a whole
//                                 receive slice — only for the read call.
//   wakeReader                  — ANY thread. `::shutdown(2)` on the kernel
//                                 socket; touches nothing else, so the
//                                 reader's in-flight SSL_read returns 0 and it
//                                 tears its own connection down.
//   isOpen / lastError          — ANY thread.
//
// The alternative — calling close() cross-thread — is what audit finding C1
// describes: SSL_free and ::close(fd_) underneath a reader still inside
// SSL_read, then FD_SET(-1). That is undefined behaviour, not a tolerable
// race. Wake the reader and let it tear its own connection down.
class CtraderWs {
public:
  CtraderWs() = default;
  ~CtraderWs();
  CtraderWs(const CtraderWs&) = delete;
  CtraderWs& operator=(const CtraderWs&) = delete;

  // TCP (+ TLS unless `tls` is false) connect + HTTP upgrade. Returns false
  // (and sets lastError) on any failure; the object is safe to reuse for
  // another connect(). The plain (non-TLS) transport exists for the
  // loopback fake broker in the tests; production always passes true.
  bool connect(const std::string& host, int port = 5036, bool tls = true);
  bool sendText(const std::string& text);
  // Waits up to timeoutMs for a complete text frame. Handles ping->pong and
  // close internally. nullopt = timeout, closed, or error (check isOpen()).
  std::optional<std::string> recvText(int timeoutMs);
  void close();

  void wakeReader();
  bool isOpen() const { return open_.load(std::memory_order_acquire); }
  std::string lastError() const;

private:
  bool sendFrame(uint8_t opcode, const std::string& payload);
  bool fillBuffer(int timeoutMs); // one read into buf_, respecting timeout
  bool sendRaw(const uint8_t* data, size_t len);
  int rawRead(uint8_t* out, size_t cap);  // caller holds ioMtx_
  void teardown();
  void setError(const std::string& e);

  // fd_ is written only by the owning thread (connect/teardown) but READ by
  // wakeReader() from another one, so every write and that read take fdMtx_.
  // The owning thread's own reads (select/SSL_set_fd) need no lock — it is
  // the only writer.
  mutable std::mutex fdMtx_;
  int fd_ = -1;
  // Serializes every SSL_read / SSL_write (and the plain-transport
  // equivalents) plus lastError_. Never held across a wait for readability.
  mutable std::mutex ioMtx_;
  void* ssl_ = nullptr;   // SSL*      (void* keeps OpenSSL out of this header)
  void* ctx_ = nullptr;   // SSL_CTX*
  bool tls_ = true;
  std::atomic<bool> open_{false};
  std::vector<uint8_t> buf_;
  std::string lastError_;
};
