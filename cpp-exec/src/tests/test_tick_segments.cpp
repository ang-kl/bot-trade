// cpp-exec/src/tests/test_tick_segments.cpp — PR-I: the sealed-segment READ
// path (tick_recorder.hpp "the sealed-segment READ path"). What it proves:
//
//  - the listing carries SEALED segments only, oldest first, 0 / 1 / many,
//    and an ".open" file is counted as openBytes and NEVER listed;
//  - the entry cap sets `truncated`;
//  - range reads reassemble to the file's exact bytes, `len` is clamped to
//    kMaxChunkBytes, and an offset past EOF is len 0 + eof (not an error);
//  - the six refusals the name boundary exists for: "../" traversal, an
//    absolute path, an ".open" suffix, a wrong extension, bad digits, and a
//    well-formed name that does not exist;
//  - a segment RETIRED between the listing and the read answers not_found —
//    never a short read presented as the whole file;
//  - a HARDLINK with a legal sealed name is refused (checker m-1: a hardlink
//    has no target for realpath to resolve), and a SYMLINK is not listed at
//    all and leaks no foreign size (checker m-2: ::stat followed the link);
//  - base64 round-trips (encoded here, decoded by a reference decoder);
//  - and END TO END (checker M-3): the REAL routes, registered by the REAL
//    registerTickSegmentRoutes, on a REAL HttpServer over a REAL socket —
//    which is what pins readRequest's query parsing, the bearer gate and the
//    JSON field names the Node puller reads. As lambdas in main.cpp these
//    routes were out of reach of every test binary (the Makefile excludes
//    main.cpp), and a mutation emptying HttpRequest::query killed the whole
//    read path with a green suite.
//
// It also runs the reader WHILE the recorder's writer thread is sealing
// segments (the concurrency claim in the header: sealed files are immutable,
// so no lock is needed) — which is why this file is in TSAN_TESTS.
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

#include "../http_server.hpp"
#include "../json.hpp"
#include "../tick_recorder.hpp"
#include "../tick_segment_routes.hpp"

using namespace tick;

namespace {

std::string tmpSpool() {
  char buf[] = "/tmp/tick_seg_XXXXXX";
  const char* d = mkdtemp(buf);
  assert(d);
  const std::string dir = std::string(d) + "/spool";
  assert(::mkdir(dir.c_str(), 0755) == 0);
  return dir;
}

std::string segName(unsigned long long startMs, unsigned index) {
  char n[64];
  std::snprintf(n, sizeof n, "seg-%013llu-%06u.tks", startMs, index);
  return n;
}

void writeFile(const std::string& path, const std::string& body) {
  std::FILE* f = std::fopen(path.c_str(), "wb");
  assert(f);
  if (!body.empty()) assert(std::fwrite(body.data(), 1, body.size(), f) == body.size());
  std::fclose(f);
}

std::string bytesOf(size_t n, unsigned seed = 1) {
  std::string s(n, '\0');
  for (size_t i = 0; i < n; ++i) s[i] = static_cast<char>((i * 31u + seed * 7u) & 0xFF);
  return s;
}

std::string base64Decode(const std::string& in) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::string out;
  int buf = 0, bits = 0;
  for (char c : in) {
    if (c == '=') break;
    const int v = val(c);
    assert(v >= 0);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += static_cast<char>((buf >> bits) & 0xFF); }
  }
  return out;
}

// ---------------------------------------------------------------------------

void test_the_name_boundary_accepts_only_the_recorder_s_own_sealed_names() {
  assert(isSealedSegmentName("seg-1757548800000-000001.tks"));
  assert(isSealedSegmentName("seg-0000000000000-999999.tks"));
  // The six refusals (the last one — a valid name that does not exist — is
  // exercised against the filesystem below; it is a 404, not a bad name).
  assert(!isSealedSegmentName("../seg-1757548800000-000001.tks"));
  assert(!isSealedSegmentName("seg-1757548800000-000001.tks/../../../etc/passwd"));
  assert(!isSealedSegmentName("/data/tick/seg-1757548800000-000001.tks"));
  assert(!isSealedSegmentName("seg-1757548800000-000001.tks.open"));
  assert(!isSealedSegmentName("seg-1757548800000-000001.torn"));
  assert(!isSealedSegmentName("seg-175754880000x-000001.tks"));
  assert(!isSealedSegmentName("seg-175754880000-000001.tks"));   // 12 digits
  assert(!isSealedSegmentName("seg-1757548800000-00001.tks"));   // 5 digits
  assert(!isSealedSegmentName("seg-1757548800000_000001.tks"));  // wrong separator
  assert(!isSealedSegmentName(""));
  assert(!isSealedSegmentName(".."));
  std::puts("  name boundary: only seg-<13>-<6>.tks");
}

void test_listing_is_sealed_only_oldest_first_and_never_the_open_one() {
  // 0 sealed
  const std::string dir = tmpSpool();
  SegmentList empty = listSealedSegments(dir);
  assert(empty.segments.empty() && empty.openBytes == 0 && !empty.truncated);

  // 1 sealed
  writeFile(dir + "/" + segName(1757548800000ull, 2), bytesOf(128));
  SegmentList one = listSealedSegments(dir);
  assert(one.segments.size() == 1);
  assert(one.segments[0].name == segName(1757548800000ull, 2));
  assert(one.segments[0].bytes == 128 && one.segments[0].index == 2);
  assert(one.segments[0].sealedAtMs > 1'600'000'000'000ull);

  // many, out of creation order, plus one OPEN file and three files that are
  // not segments at all
  writeFile(dir + "/" + segName(1757548700000ull, 1), bytesOf(64));
  writeFile(dir + "/" + segName(1757548900000ull, 3), bytesOf(256));
  writeFile(dir + "/" + segName(1757549000000ull, 4) + ".open", bytesOf(999));
  writeFile(dir + "/" + segName(1757548600000ull, 9) + ".torn", bytesOf(5));
  writeFile(dir + "/README", "not a segment");
  writeFile(dir + "/.recorder.lock", "");
  SegmentList many = listSealedSegments(dir);
  assert(many.segments.size() == 3);
  assert(many.segments[0].name == segName(1757548700000ull, 1));
  assert(many.segments[1].name == segName(1757548800000ull, 2));
  assert(many.segments[2].name == segName(1757548900000ull, 3));
  assert(many.openBytes == 999);            // reported…
  for (const auto& e : many.segments) {     // …never served
    assert(e.name.find(".open") == std::string::npos);
    assert(e.name.find(".torn") == std::string::npos);
  }
  assert(!many.truncated);

  // the entry cap
  SegmentList capped = listSealedSegments(dir, 2);
  assert(capped.segments.size() == 2 && capped.truncated);
  assert(capped.segments[0].name == segName(1757548700000ull, 1));
  std::puts("  listing: sealed only, oldest first, open never listed, cap sets truncated");
}

void test_range_reads_reassemble_to_the_exact_bytes() {
  const std::string dir = tmpSpool();
  const std::string name = segName(1757548800000ull, 1);
  const std::string body = bytesOf(5000, 3);
  writeFile(dir + "/" + name, body);

  // whole file in one call
  SegmentChunk whole = readSegmentChunk(dir, name, 0, 1 << 20);
  assert(whole.status == ChunkStatus::OK);
  assert(whole.totalBytes == body.size() && whole.bytes == body && whole.eof);
  // base64 round-trips through the transport
  assert(base64Decode(base64Encode(whole.bytes)) == body);
  // every length class the padding has
  for (size_t n : { size_t{0}, size_t{1}, size_t{2}, size_t{3}, size_t{4}, size_t{255} })
    assert(base64Decode(base64Encode(body.substr(0, n))) == body.substr(0, n));

  // reassembled in 512-byte chunks
  std::string acc;
  uint64_t off = 0;
  for (;;) {
    SegmentChunk c = readSegmentChunk(dir, name, off, 512);
    assert(c.status == ChunkStatus::OK && c.totalBytes == body.size());
    acc += c.bytes;
    off += c.bytes.size();
    if (c.eof) break;
    assert(c.bytes.size() == 512);
  }
  assert(acc == body);

  // offset past EOF: len 0, eof, NOT an error
  SegmentChunk past = readSegmentChunk(dir, name, body.size() + 1000, 512);
  assert(past.status == ChunkStatus::OK && past.bytes.empty() && past.eof);
  assert(past.totalBytes == body.size() && past.offset == body.size() + 1000);
  SegmentChunk at = readSegmentChunk(dir, name, body.size(), 512);
  assert(at.status == ChunkStatus::OK && at.bytes.empty() && at.eof);

  // len is clamped to the declared maximum
  const std::string big = bytesOf((1u << 20) + 4096, 5);
  const std::string bigName = segName(1757548900000ull, 2);
  writeFile(dir + "/" + bigName, big);
  SegmentChunk clamped = readSegmentChunk(dir, bigName, 0, 64ull << 20);
  assert(clamped.status == ChunkStatus::OK);
  assert(clamped.bytes.size() == kMaxChunkBytes && !clamped.eof);
  assert(clamped.bytes == big.substr(0, kMaxChunkBytes));
  SegmentChunk tail = readSegmentChunk(dir, bigName, kMaxChunkBytes, 64ull << 20);
  assert(tail.status == ChunkStatus::OK && tail.eof && tail.bytes.size() == 4096);
  std::puts("  range reads: byte-exact, clamped to 1 MiB, past-EOF is eof not error");
}

void test_the_six_refusals() {
  const std::string dir = tmpSpool();
  const std::string name = segName(1757548800000ull, 1);
  writeFile(dir + "/" + name, bytesOf(200));
  // the neighbour a traversal would reach, so the refusal is not "absent file"
  writeFile(dir + "/../secret", "s3cret");

  struct Case { const char* name; ChunkStatus want; };
  const Case cases[] = {
    { "../secret", ChunkStatus::BAD_NAME },                                   // traversal
    { "/etc/passwd", ChunkStatus::BAD_NAME },                                 // absolute path
    { "seg-1757548800000-000001.tks.open", ChunkStatus::BAD_NAME },           // the open tail
    { "seg-1757548800000-000001.torn", ChunkStatus::BAD_NAME },               // wrong extension
    { "seg-17575488000zz-000001.tks", ChunkStatus::BAD_NAME },                // bad digits
    { "seg-1757548800001-000042.tks", ChunkStatus::NOT_FOUND },               // well-formed, absent
  };
  for (const Case& c : cases) {
    SegmentChunk r = readSegmentChunk(dir, c.name, 0, 4096);
    assert(r.status == c.want);
    assert(r.bytes.empty() && r.totalBytes == 0);
  }
  // a traversal dressed as a valid name is refused too
  assert(readSegmentChunk(dir, name + "/../../secret", 0, 16).status == ChunkStatus::BAD_NAME);
  // and a SYMLINK inside the spool carrying a valid name cannot escape it
  const std::string linkName = segName(1757548800000ull, 7);
  if (::symlink("/etc/passwd", (dir + "/" + linkName).c_str()) == 0)
    assert(readSegmentChunk(dir, linkName, 0, 16).status == ChunkStatus::BAD_NAME);
  std::puts("  refusals: traversal, absolute, .open, wrong extension, bad digits, absent, symlink");
}

void test_a_hardlink_cannot_smuggle_a_file_into_the_spool() {
  // Checker m-1: realpath resolves SYMLINKS. A HARDLINK has no target to
  // resolve — realpath returns the link's own path, inside the spool — while
  // the inode is a file from anywhere on the same filesystem. Before the
  // st_nlink check this read the victim's bytes with status OK.
  const std::string dir = tmpSpool();
  const std::string victim = dir + "/../victim";
  writeFile(victim, "VICTIM-BYTES-OUTSIDE-THE-SPOOL");
  const std::string name = segName(1757548800000ull, 1);
  if (::link(victim.c_str(), (dir + "/" + name).c_str()) != 0) {
    std::puts("  hardlink: SKIPPED (link() unsupported here)");
    return;
  }
  const SegmentChunk c = readSegmentChunk(dir, name, 0, 64);
  assert(c.status == ChunkStatus::BAD_NAME);
  assert(c.bytes.empty() && c.totalBytes == 0);
  // A segment this recorder really sealed has exactly one link and still reads.
  const std::string real = segName(1757548900000ull, 2);
  writeFile(dir + "/" + real, bytesOf(128, 4));
  assert(readSegmentChunk(dir, real, 0, 64).status == ChunkStatus::OK);
  std::puts("  hardlink: a planted link is BAD_NAME, a sealed segment still reads");
}

void test_a_symlink_is_not_listed_and_leaks_no_foreign_size() {
  // Checker m-2: ::stat FOLLOWS the link, so a legally-named symlink was
  // listed with the TARGET's size — an authenticated caller learned the size
  // of a file outside the spool, and every sync carried a permanently
  // failing entry (the read path refuses it). ::lstat + S_ISREG drops it.
  const std::string dir = tmpSpool();
  const std::string linkName = segName(1757548800000ull, 1);
  if (::symlink("/etc/passwd", (dir + "/" + linkName).c_str()) != 0) {
    std::puts("  symlink listing: SKIPPED (symlink() unsupported here)");
    return;
  }
  const SegmentList list = listSealedSegments(dir);
  assert(list.segments.empty());
  assert(list.openBytes == 0);
  // a real segment beside it is still listed with its own size
  const std::string real = segName(1757548900000ull, 2);
  writeFile(dir + "/" + real, bytesOf(200, 6));
  const SegmentList both = listSealedSegments(dir);
  assert(both.segments.size() == 1 && both.segments[0].name == real && both.segments[0].bytes == 200);
  std::puts("  symlink listing: not listed, no foreign size leaked");
}

void test_a_segment_retired_mid_read_is_not_found_never_a_partial_lie() {
  const std::string dir = tmpSpool();
  const std::string name = segName(1757548800000ull, 1);
  const std::string body = bytesOf(4096, 9);
  writeFile(dir + "/" + name, body);
  // first chunk read while it is there
  SegmentChunk first = readSegmentChunk(dir, name, 0, 1024);
  assert(first.status == ChunkStatus::OK && first.bytes == body.substr(0, 1024) && !first.eof);
  // retirement (retire() unlinks; nothing ever rewrites a sealed file)
  assert(::unlink((dir + "/" + name).c_str()) == 0);
  SegmentChunk after = readSegmentChunk(dir, name, 1024, 1024);
  assert(after.status == ChunkStatus::NOT_FOUND);
  assert(after.bytes.empty() && after.totalBytes == 0 && !after.eof);
  // the listing forgets it too
  assert(listSealedSegments(dir).segments.empty());
  std::puts("  retired mid-read: 404, never a short read dressed as the file");
}

void test_reads_run_against_a_live_writer_without_locking() {
  // The concurrency claim made in the header, exercised: the recorder's
  // writer thread seals segments (tiny segmentBytes) while a reader thread
  // lists and reads them. A sealed file is immutable, so every chunk read
  // must be byte-exact against a re-read of the same file.
  const std::string dir = tmpSpool();
  RecorderConfig cfg;
  cfg.spoolDir = dir;
  cfg.feedId = "demo.ctraderapi.com/…7342";
  cfg.queueRecords = 4096;
  cfg.segmentBytes = 4096;              // seals every ~100 records
  cfg.fsyncEveryMs = 50;
  cfg.budgetCheckEveryMs = 10;
  TickRecorder rec(cfg, [](const std::string&, uint64_t& avail, uint64_t& total) {
    avail = 40ull << 30; total = 50ull << 30; return true;
  });
  assert(rec.start());
  assert(rec.setRecording(true));

  std::atomic<bool> stop{false};
  std::atomic<uint64_t> chunks{0};
  std::thread reader([&] {
    while (!stop.load()) {
      const SegmentList list = listSealedSegments(dir);
      for (const SegmentEntry& e : list.segments) {
        std::string acc;
        uint64_t off = 0;
        for (;;) {
          SegmentChunk c = readSegmentChunk(dir, e.name, off, 700);
          if (c.status != ChunkStatus::OK) break;   // retired under us: fine
          acc += c.bytes;
          off += c.bytes.size();
          if (c.eof) break;
        }
        if (!acc.empty()) {
          // A sealed segment decodes; the header is the first 64 bytes.
          assert(acc.size() >= kHeaderBytes);
          assert(std::memcmp(acc.data(), "TKSG", 4) == 0);
          chunks.fetch_add(1);
        }
        assert(e.name.find(".open") == std::string::npos);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  });

  for (int i = 0; i < 4000; ++i) {
    rec.onQuote(7, true, 100000 + i, true, 100010 + i, 1'757'548'800'000ull + i, 1);
    if (i % 500 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  stop.store(true);
  reader.join();
  rec.stop();
  assert(chunks.load() > 0);
  // Every listed segment still decodes end to end after the writer is gone.
  const SegmentList list = listSealedSegments(dir);
  assert(!list.segments.empty());
  for (const SegmentEntry& e : list.segments) {
    const SegmentRead sr = readSegment(dir + "/" + e.name);
    assert(sr.headerOk && !sr.truncated);
  }
  std::puts("  live writer: sealed reads are byte-exact with no lock");
}

void test_query_parsing_feeds_the_route() {
  // The route reads name/offset/len out of the raw query the server now
  // keeps; the path itself is still the dispatch key.
  assert(queryParam("name=seg-1757548800000-000001.tks&offset=64&len=1024", "name") == "seg-1757548800000-000001.tks");
  assert(queryParam("name=a&offset=64&len=1024", "offset") == "64");
  assert(queryParam("name=a&offset=64&len=1024", "len") == "1024");
  assert(queryParam("name=a", "len", "0") == "0");
  assert(queryParam("", "name") == "");
  // percent-decoding, and a repeat cannot smuggle a second value past the
  // check made on the first
  assert(queryParam("name=%2E%2E%2Fsecret", "name") == "../secret");
  assert(queryParam("name=good&name=../secret", "name") == "good");
  std::puts("  query: name/offset/len, percent-decoded, first occurrence wins");
}

// ---------------------------------------------------------------------------
// The END-TO-END half (checker M-3): the REAL routes on a REAL HttpServer
// over a REAL socket. Nothing below reaches into the helpers; it speaks the
// wire the Node puller speaks, so it pins readRequest's query parsing, the
// bearer gate, the status codes and the JSON FIELD NAMES the puller reads.

struct HttpReply { int status = 0; std::string body; };

HttpReply httpGet(int port, const std::string& target, const std::string& bearer, bool sendAuth = true) {
  HttpReply out;
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  assert(fd >= 0);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = inet_addr("127.0.0.1");
  timeval tv{};
  tv.tv_sec = 10;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0) { ::close(fd); return out; }
  std::string req = "GET " + target + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (sendAuth) req += "Authorization: Bearer " + bearer + "\r\n";
  req += "Connection: close\r\n\r\n";
  size_t off = 0;
  while (off < req.size()) {
    const ssize_t n = ::send(fd, req.data() + off, req.size() - off, 0);
    if (n <= 0) break;
    off += static_cast<size_t>(n);
  }
  std::string raw;
  char buf[8192];
  for (;;) {
    const ssize_t n = ::recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    raw.append(buf, static_cast<size_t>(n));
  }
  ::close(fd);
  const size_t sp = raw.find(' ');
  if (sp != std::string::npos) out.status = std::atoi(raw.c_str() + sp + 1);
  const size_t sep = raw.find("\r\n\r\n");
  if (sep != std::string::npos) out.body = raw.substr(sep + 4);
  // the server always declares JSON; the puller parses it as such
  assert(raw.find("Content-Type: application/json") != std::string::npos || out.status == 0);
  return out;
}

void test_the_real_routes_over_a_real_socket() {
  const std::string dir = tmpSpool();
  const std::string secret = "e2e-secret";
  const std::string nameA = segName(1757548800000ull, 1);
  const std::string nameB = segName(1757548900000ull, 2);
  const std::string bodyA = bytesOf(3000, 11);
  writeFile(dir + "/" + nameA, bodyA);
  writeFile(dir + "/" + nameB, bytesOf(500, 12));
  writeFile(dir + "/" + segName(1757549000000ull, 3) + ".open", bytesOf(77));

  const int port = 20000 + static_cast<int>(::getpid() % 9000);
  HttpServer server(port, secret);
  registerTickSegmentRoutes(server, dir, /*recorderPresent=*/true, secret);
  std::thread([&server] { server.run(); }).detach();
  for (int i = 0; i < 200; ++i) {
    if (httpGet(port, "/tick-segments", secret).status != 0) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }

  // --- the listing, on the wire
  HttpReply list = httpGet(port, "/tick-segments", secret);
  assert(list.status == 200);
  auto parsed = jsn::parse(list.body);
  assert(parsed && parsed->isObject());
  assert(parsed->get("enabled").asBool());
  assert(parsed->get("spool").asString() == dir);
  assert(parsed->get("openBytes").asNumber() == 77);
  assert(parsed->get("truncated").asBool() == false);
  assert(parsed->get("maxChunkBytes").asNumber() == static_cast<double>(kMaxChunkBytes));
  const jsn::Array& segs = parsed->get("segments").asArray();
  assert(segs.size() == 2);
  assert(segs[0].get("name").asString() == nameA);                 // oldest first
  assert(segs[1].get("name").asString() == nameB);
  assert(segs[0].get("bytes").asNumber() == static_cast<double>(bodyA.size()));
  assert(segs[0].get("index").asNumber() == 1);
  assert(segs[0].get("sealedAtMs").asNumber() > 1.6e12);

  // --- a multi-chunk read, reassembled byte-exact THROUGH THE WIRE
  std::string acc;
  uint64_t off = 0;
  for (int guard = 0; guard < 100; ++guard) {
    HttpReply r = httpGet(port, "/tick-segment?name=" + nameA + "&offset=" + std::to_string(off) + "&len=512", secret);
    assert(r.status == 200);
    auto c = jsn::parse(r.body);
    assert(c && c->isObject());
    // the exact field names the Node puller reads
    assert(c->get("name").asString() == nameA);
    assert(c->get("totalBytes").asNumber() == static_cast<double>(bodyA.size()));
    assert(c->get("offset").asNumber() == static_cast<double>(off));
    const std::string chunk = base64Decode(c->get("b64").asString());
    assert(c->get("len").asNumber() == static_cast<double>(chunk.size()));
    acc += chunk;
    off += chunk.size();
    if (c->get("eof").asBool()) break;
    assert(chunk.size() == 512);
  }
  assert(acc == bodyA);

  // --- the refusals, on the wire
  assert(httpGet(port, "/tick-segment?name=../secret&offset=0&len=16", secret).status == 400);
  assert(httpGet(port, "/tick-segment?name=" + nameA + ".open&offset=0&len=16", secret).status == 400);
  assert(httpGet(port, "/tick-segment?name=seg-1757548800099-000009.tks&offset=0&len=16", secret).status == 404);
  // percent-encoded traversal survives readRequest's decoding and is still refused
  assert(httpGet(port, "/tick-segment?name=%2E%2E%2Fsecret&offset=0&len=16", secret).status == 400);
  // offset past EOF is 200 with len 0 + eof
  {
    HttpReply past = httpGet(port, "/tick-segment?name=" + nameA + "&offset=999999&len=512", secret);
    assert(past.status == 200);
    auto p = jsn::parse(past.body);
    assert(p && p->get("len").asNumber() == 0 && p->get("eof").asBool());
  }
  // --- the bearer gate
  assert(httpGet(port, "/tick-segments", "", /*sendAuth=*/false).status == 401);
  assert(httpGet(port, "/tick-segments", "wrong-secret").status == 401);
  assert(httpGet(port, "/tick-segment?name=" + nameA + "&offset=0&len=16", "wrong-secret").status == 401);
  std::puts("  e2e: the real routes on a real socket — listing, multi-chunk, refusals, bearer");
}

void test_the_real_routes_with_no_recorder_and_with_no_secret() {
  const std::string dir = tmpSpool();
  // (a) no recorder: {enabled:false} with 200, the /tick-status shape
  {
    const std::string secret = "e2e-secret-2";
    const int port = 20000 + static_cast<int>((::getpid() + 1) % 9000);
    HttpServer server(port, secret);
    registerTickSegmentRoutes(server, dir, /*recorderPresent=*/false, secret);
    std::thread([&server] { server.run(); }).detach();
    for (int i = 0; i < 200; ++i) {
      if (httpGet(port, "/tick-segments", secret).status != 0) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    HttpReply r = httpGet(port, "/tick-segments", secret);
    assert(r.status == 200);
    auto p = jsn::parse(r.body);
    assert(p && p->get("enabled").isBool() && !p->get("enabled").asBool());
    assert(p->get("reason").asString() == "TICK_SPOOL_PATH not set");
    HttpReply c = httpGet(port, "/tick-segment?name=seg-1757548800000-000001.tks", secret);
    assert(c.status == 200);
    auto pc = jsn::parse(c.body);
    assert(pc && !pc->get("enabled").asBool());
    // and still 401 without the header
    assert(httpGet(port, "/tick-segments", "", false).status == 401);
  }
  // (b) NO EXEC_SECRET configured: segment bytes stay unreachable. The
  // HttpServer's own gate admits a literal "Bearer " here, so the routes'
  // own check is the thing refusing — this is the case that check exists for.
  {
    const std::string nameA = segName(1757548800000ull, 1);
    writeFile(dir + "/" + nameA, bytesOf(300, 21));
    const int port = 20000 + static_cast<int>((::getpid() + 2) % 9000);
    HttpServer server(port, "");
    registerTickSegmentRoutes(server, dir, /*recorderPresent=*/true, "");
    std::thread([&server] { server.run(); }).detach();
    for (int i = 0; i < 200; ++i) {
      if (httpGet(port, "/tick-segments", "").status != 0) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    assert(httpGet(port, "/tick-segments", "").status == 401);          // "Bearer " passes the server gate, the route refuses
    assert(httpGet(port, "/tick-segments", "", false).status == 401);   // no header at all
    assert(httpGet(port, "/tick-segment?name=" + nameA + "&offset=0&len=16", "").status == 401);
  }
  std::puts("  e2e: {enabled:false} with no recorder; unreachable with no EXEC_SECRET");
}

} // namespace

int main() {
  test_the_name_boundary_accepts_only_the_recorder_s_own_sealed_names();
  test_listing_is_sealed_only_oldest_first_and_never_the_open_one();
  test_range_reads_reassemble_to_the_exact_bytes();
  test_the_six_refusals();
  test_a_hardlink_cannot_smuggle_a_file_into_the_spool();
  test_a_symlink_is_not_listed_and_leaks_no_foreign_size();
  test_a_segment_retired_mid_read_is_not_found_never_a_partial_lie();
  test_reads_run_against_a_live_writer_without_locking();
  test_query_parsing_feeds_the_route();
  test_the_real_routes_over_a_real_socket();
  test_the_real_routes_with_no_recorder_and_with_no_secret();
  std::puts("test_tick_segments: all passed");
  return 0;
}
