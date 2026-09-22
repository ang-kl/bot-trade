# OpenSSL: Homebrew keg on macOS is not on default search paths; fall back to /usr (Linux/CI).
BREW_OPENSSL := $(shell brew --prefix openssl@3 2>/dev/null)
OPENSSL_PREFIX := $(if $(BREW_OPENSSL),$(BREW_OPENSSL),/usr)

CXX      := clang++
CXXFLAGS := -std=c++20 -Wall -Wextra -I$(OPENSSL_PREFIX)/include
LDFLAGS  := -L$(OPENSSL_PREFIX)/lib
LDLIBS   := -lssl -lcrypto -lcurl

SRC      := $(wildcard src/*.cpp)
TEST_SRC := $(wildcard src/tests/*.cpp)
# Tests link against everything except the production entrypoint.
LIB_SRC  := $(filter-out src/main.cpp,$(SRC))

# HEADER DEPENDENCIES (16-09-2026). Until this line every rule listed only
# .cpp prerequisites, so a change to a HEADER rebuilt nothing and `make test`
# re-ran stale binaries and reported green. Measured at the time:
# `touch src/tick_shadow.hpp && make test` planned ZERO recompiles, and a
# mutation that deleted the shadow book's per-class commission — a function
# that lives in tick_shadow.hpp — reported "all passed", rc=0, while `grep -c`
# confirmed the edit had landed. That is a gate that cannot go red, on code it
# did not compile: this repo's recurring failure mode at the build level.
#
# WHY A WILDCARD AND NOT `-MMD -MP`. Each binary here is built by ONE compiler
# invocation over the test file plus every library source (no object files),
# and with several inputs and a single `-o`, `-MMD` writes ONE depfile that
# each translation unit OVERWRITES in turn — measured: the resulting
# `bin/x.d` listed only the LAST source's headers. A dependency file that
# silently covers one file in twenty is the same defect wearing a seatbelt.
# Because the build already recompiles every TU for every binary, precise
# dependencies buy nothing here; correctness does. This wildcard is
# re-evaluated on every run, so a newly added header is picked up with no
# bootstrap step and nothing to regenerate.
HDRS     := $(wildcard src/*.hpp) $(wildcard src/tests/*.hpp)

BIN       := bin/cpp-exec
# Each tests/*.cpp defines its own main, so every test file gets its own binary.
TEST_BINS := $(patsubst src/tests/%.cpp,bin/%,$(TEST_SRC))

# P2b-2: the threading tests under ThreadSanitizer (plan §14 "ThreadSanitizer
# where supported"). Only the tests that drive real threads across a socket
# or a ring — the whole suite under TSan would double the build for no
# additional coverage. Separate output dir so the plain binaries stay cached.
TSAN_TESTS := test_scanner_mirror test_spot_feed_creds test_async_session test_tick_recorder test_tick_segments test_tick_workers test_tick_shadow test_tick_firer test_spot_feed_stop test_spot_feed_heartbeat test_spot_quotes test_tick_tap test_telemetry test_engine_send_boundary test_protection_ratchet
TSAN_BINS  := $(addprefix bin/tsan/,$(TSAN_TESTS))

.PHONY: all test tsan clean

all: $(BIN)

$(BIN): $(SRC) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

bin/%: src/tests/%.cpp $(LIB_SRC) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do ./$$t; done

bin/tsan/%: src/tests/%.cpp $(LIB_SRC) $(HDRS)
	@mkdir -p bin/tsan
	$(CXX) $(CXXFLAGS) -g -fsanitize=thread $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

tsan: $(TSAN_BINS)
	@set -e; for t in $(TSAN_BINS); do TSAN_OPTIONS="halt_on_error=1 second_deadlock_stack=1" ./$$t; done

clean:
	rm -rf bin
