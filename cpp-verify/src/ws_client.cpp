// cpp-exec/src/ws_client.cpp
#include "ws_client.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>

#include <cstring>

namespace wsframe {

std::vector<uint8_t> encodeFrame(uint8_t opcode, const std::string& payload,
                                 const uint8_t maskKey[4]) {
  std::vector<uint8_t> out;
  out.reserve(payload.size() + 14);
  out.push_back(static_cast<uint8_t>(0x80 | (opcode & 0x0F))); // FIN always set
  const uint8_t maskBit = maskKey ? 0x80 : 0x00;
  size_t n = payload.size();
  if (n < 126) {
    out.push_back(static_cast<uint8_t>(maskBit | n));
  } else if (n <= 0xFFFF) {
    out.push_back(static_cast<uint8_t>(maskBit | 126));
    out.push_back(static_cast<uint8_t>(n >> 8));
    out.push_back(static_cast<uint8_t>(n & 0xFF));
  } else {
    out.push_back(static_cast<uint8_t>(maskBit | 127));
    for (int i = 7; i >= 0; --i)
      out.push_back(static_cast<uint8_t>((static_cast<uint64_t>(n) >> (8 * i)) & 0xFF));
  }
  if (!maskKey) {
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
  }
  out.insert(out.end(), maskKey, maskKey + 4);
  for (size_t i = 0; i < n; ++i)
    out.push_back(static_cast<uint8_t>(payload[i]) ^ maskKey[i % 4]);
  return out;
}

std::optional<Frame> decodeFrame(const std::vector<uint8_t>& buf, bool fromClient) {
  if (buf.size() < 2) return std::nullopt;
  Frame f;
  f.fin = (buf[0] & 0x80) != 0;
  f.opcode = buf[0] & 0x0F;
  bool masked = (buf[1] & 0x80) != 0;
  uint64_t len = buf[1] & 0x7F;
  size_t pos = 2;
  if (len == 126) {
    if (buf.size() < 4) return std::nullopt;
    len = (static_cast<uint64_t>(buf[2]) << 8) | buf[3];
    pos = 4;
  } else if (len == 127) {
    if (buf.size() < 10) return std::nullopt;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | buf[2 + i];
    pos = 10;
  }
  if ((buf[0] & 0x70) != 0 || masked != fromClient) {
    // RSV bits without an extension, a masked server frame, or an unmasked
    // client frame — protocol violation; signal the caller to drop the
    // connection.
    f.opcode = 0xFF;
    f.bytesConsumed = buf.size();
    return f;
  }
  if (len > (64ull << 20)) { f.opcode = 0xFF; f.bytesConsumed = buf.size(); return f; }
  uint8_t key[4] = {0, 0, 0, 0};
  if (masked) {
    if (buf.size() < pos + 4) return std::nullopt;
    std::memcpy(key, buf.data() + pos, 4);
    pos += 4;
  }
  if (buf.size() < pos + len) return std::nullopt;
  f.payload.assign(reinterpret_cast<const char*>(buf.data() + pos), static_cast<size_t>(len));
  if (masked)
    for (size_t i = 0; i < f.payload.size(); ++i)
      f.payload[i] = static_cast<char>(static_cast<uint8_t>(f.payload[i]) ^ key[i % 4]);
  f.bytesConsumed = pos + static_cast<size_t>(len);
  return f;
}

} // namespace wsframe

static std::string base64(const uint8_t* data, size_t len) {
  std::string out;
  out.resize(4 * ((len + 2) / 3) + 1);
  int n = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(out.data()), data,
                          static_cast<int>(len));
  out.resize(n > 0 ? static_cast<size_t>(n) : 0);
  return out;
}

std::string wsAcceptFor(const std::string& secWebSocketKey) {
  static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  std::string joined = secWebSocketKey + kGuid;
  uint8_t digest[SHA_DIGEST_LENGTH];
  SHA1(reinterpret_cast<const unsigned char*>(joined.data()), joined.size(), digest);
  return base64(digest, sizeof digest);
}

// ---- CtraderWs -------------------------------------------------------------

CtraderWs::~CtraderWs() { teardown(); }

std::string CtraderWs::lastError() const {
  std::lock_guard<std::mutex> lk(ioMtx_);
  return lastError_;
}

void CtraderWs::setError(const std::string& e) {
  std::lock_guard<std::mutex> lk(ioMtx_);
  lastError_ = e;
}

void CtraderWs::teardown() {
  open_.store(false, std::memory_order_release);
  {
    // A writer between its open_ check and its SSL_write is excluded here,
    // so ssl_ is never freed underneath a call that is using it.
    std::lock_guard<std::mutex> lk(ioMtx_);
    if (ssl_) {
      SSL_free(static_cast<SSL*>(ssl_));
      ssl_ = nullptr;
    }
    if (ctx_) {
      SSL_CTX_free(static_cast<SSL_CTX*>(ctx_));
      ctx_ = nullptr;
    }
  }
  {
    std::lock_guard<std::mutex> lk(fdMtx_);
    if (fd_ >= 0) {
      ::close(fd_);
      fd_ = -1;
    }
  }
  buf_.clear();
}

void CtraderWs::wakeReader() {
  std::lock_guard<std::mutex> lk(fdMtx_);
  // Half-closing both directions makes the reader's select() return readable
  // and its SSL_read() return 0. We deliberately do NOT ::close() here: the
  // descriptor stays owned by the connecting thread, so there is no window in
  // which this number could be handed to some unrelated open() and then
  // written to by the reader.
  if (fd_ >= 0) ::shutdown(fd_, SHUT_RDWR);
}

bool CtraderWs::connect(const std::string& host, int port, bool tls) {
  teardown();
  setError("");
  tls_ = tls;

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  std::string portStr = std::to_string(port);
  if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
    setError("dns resolve failed for " + host);
    return false;
  }
  int fd = -1;
  for (addrinfo* ai = res; ai; ai = ai->ai_next) {
    fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    setError("tcp connect failed");
    return false;
  }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  {
    std::lock_guard<std::mutex> lk(fdMtx_);
    fd_ = fd;
  }

  if (tls_) {
    SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) { setError("SSL_CTX_new failed"); teardown(); return false; }
    SSL_CTX_set_default_verify_paths(ctx);
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
    SSL* ssl = SSL_new(ctx);
    if (!ssl) { SSL_CTX_free(ctx); setError("SSL_new failed"); teardown(); return false; }
    {
      std::lock_guard<std::mutex> lk(ioMtx_);
      ctx_ = ctx;
      ssl_ = ssl;
    }
    SSL_set_fd(ssl, fd_);
    SSL_set_tlsext_host_name(ssl, host.c_str()); // SNI — cTrader hosts require it
    SSL_set1_host(ssl, host.c_str());
    if (SSL_connect(ssl) != 1) {
      setError("tls handshake failed: " +
               std::string(ERR_reason_error_string(ERR_get_error()) ?: "unknown"));
      teardown();
      return false;
    }
  }

  // HTTP upgrade
  uint8_t keyBytes[16];
  if (RAND_bytes(keyBytes, sizeof keyBytes) != 1) {
    setError("RAND_bytes failed");
    teardown();
    return false;
  }
  std::string key = base64(keyBytes, sizeof keyBytes);
  std::string req =
      "GET / HTTP/1.1\r\n"
      "Host: " + host + ":" + portStr + "\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: " + key + "\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "\r\n";
  if (!sendRaw(reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
    setError("handshake write failed");
    teardown();
    return false;
  }

  // Read until end of HTTP headers.
  std::string resp;
  while (resp.find("\r\n\r\n") == std::string::npos) {
    uint8_t tmp[2048];
    int n;
    {
      std::lock_guard<std::mutex> lk(ioMtx_);
      n = rawRead(tmp, sizeof tmp);
    }
    if (n <= 0) { setError("handshake read failed"); teardown(); return false; }
    resp.append(reinterpret_cast<const char*>(tmp), static_cast<size_t>(n));
    if (resp.size() > 64 * 1024) { setError("oversized handshake response"); teardown(); return false; }
  }
  if (resp.rfind("HTTP/1.1 101", 0) != 0) {
    setError("upgrade rejected: " + resp.substr(0, resp.find("\r\n")));
    teardown();
    return false;
  }
  // Validate Sec-WebSocket-Accept (case-insensitive header scan).
  std::string lower = resp;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  size_t hp = lower.find("sec-websocket-accept:");
  if (hp == std::string::npos) { setError("missing Sec-WebSocket-Accept"); teardown(); return false; }
  size_t vs = resp.find(':', hp) + 1;
  size_t ve = resp.find("\r\n", vs);
  std::string accept = resp.substr(vs, ve - vs);
  accept.erase(0, accept.find_first_not_of(" \t"));
  accept.erase(accept.find_last_not_of(" \t") + 1);
  if (accept != wsAcceptFor(key)) {
    setError("Sec-WebSocket-Accept mismatch");
    teardown();
    return false;
  }

  size_t bodyStart = resp.find("\r\n\r\n") + 4;
  if (bodyStart < resp.size())
    buf_.assign(resp.begin() + static_cast<long>(bodyStart), resp.end());
  open_.store(true, std::memory_order_release);
  return true;
}

// Caller holds ioMtx_. Returns the byte count, 0 on EOF, <0 on error.
int CtraderWs::rawRead(uint8_t* out, size_t cap) {
  if (tls_) {
    if (!ssl_) return -1;
    return SSL_read(static_cast<SSL*>(ssl_), out, static_cast<int>(cap));
  }
  int fd;
  { std::lock_guard<std::mutex> lk(fdMtx_); fd = fd_; }
  if (fd < 0) return -1;
  return static_cast<int>(::recv(fd, out, cap, 0));
}

bool CtraderWs::sendRaw(const uint8_t* data, size_t len) {
  std::lock_guard<std::mutex> lk(ioMtx_);
  size_t off = 0;
  if (tls_) {
    if (!ssl_) return false;
    while (off < len) {
      int n = SSL_write(static_cast<SSL*>(ssl_), data + off, static_cast<int>(len - off));
      if (n <= 0) return false;
      off += static_cast<size_t>(n);
    }
    return true;
  }
  int fd;
  { std::lock_guard<std::mutex> fk(fdMtx_); fd = fd_; }
  if (fd < 0) return false;
  while (off < len) {
    ssize_t n = ::send(fd, data + off, len - off, MSG_NOSIGNAL);
    if (n <= 0) return false;
    off += static_cast<size_t>(n);
  }
  return true;
}

bool CtraderWs::sendFrame(uint8_t opcode, const std::string& payload) {
  if (!open_.load(std::memory_order_acquire)) return false;
  uint8_t mask[4];
  if (RAND_bytes(mask, sizeof mask) != 1) return false;
  auto frame = wsframe::encodeFrame(opcode, payload, mask);
  if (!sendRaw(frame.data(), frame.size())) {
    setError("frame write failed");
    open_.store(false, std::memory_order_release);
    return false;
  }
  return true;
}

bool CtraderWs::sendText(const std::string& text) {
  return sendFrame(wsframe::TEXT, text);
}

bool CtraderWs::fillBuffer(int timeoutMs) {
  // TLS may already have decrypted bytes buffered; skip select() then.
  bool buffered = false;
  if (tls_) {
    std::lock_guard<std::mutex> lk(ioMtx_);
    buffered = ssl_ && SSL_pending(static_cast<SSL*>(ssl_)) > 0;
  }
  if (!buffered) {
    // The wait for readability is OUTSIDE ioMtx_ so writers on other threads
    // are never held for a receive slice.
    fd_set rfds;
    FD_ZERO(&rfds);
    if (fd_ < 0) { setError("socket closed"); open_.store(false, std::memory_order_release); return false; }
    FD_SET(fd_, &rfds);
    timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
    int r = select(fd_ + 1, &rfds, nullptr, nullptr, &tv);
    if (r == 0) return false; // timeout — not an error
    if (r < 0) { setError("select failed"); open_.store(false, std::memory_order_release); return false; }
  }
  uint8_t tmp[8192];
  int n;
  {
    std::lock_guard<std::mutex> lk(ioMtx_);
    if (!open_.load(std::memory_order_acquire)) return false;
    n = rawRead(tmp, sizeof tmp);
    if (n <= 0) {
      lastError_ = "connection closed by peer";
      open_.store(false, std::memory_order_release);
      return false;
    }
  }
  buf_.insert(buf_.end(), tmp, tmp + n);
  return true;
}

std::optional<std::string> CtraderWs::recvText(int timeoutMs) {
  while (open_.load(std::memory_order_acquire)) {
    auto f = wsframe::decodeFrame(buf_);
    if (!f) {
      if (!fillBuffer(timeoutMs)) return std::nullopt;
      continue;
    }
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<long>(f->bytesConsumed));
    switch (f->opcode) {
      case wsframe::TEXT:
        // cTrader sends single-frame JSON; fragmented text is out of scope
        // and treated as a protocol error to keep parsing honest.
        if (!f->fin) { setError("fragmented frame"); close(); return std::nullopt; }
        return f->payload;
      case wsframe::PING:
        sendFrame(wsframe::PONG, f->payload);
        continue;
      case wsframe::PONG:
        continue;
      case wsframe::CLOSE:
        sendFrame(wsframe::CLOSE, "");
        setError("close frame received");
        teardown();
        return std::nullopt;
      default:
        setError("unexpected opcode");
        teardown();
        return std::nullopt;
    }
  }
  return std::nullopt;
}

void CtraderWs::close() {
  if (open_.load(std::memory_order_acquire)) sendFrame(wsframe::CLOSE, "");
  teardown();
}
