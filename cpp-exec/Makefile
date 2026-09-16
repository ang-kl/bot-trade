# OpenSSL: Homebrew keg on macOS is not on default search paths; fall back to /usr (Linux/CI).
BREW_OPENSSL := $(shell brew --prefix openssl@3 2>/dev/null)
OPENSSL_PREFIX := $(if $(BREW_OPENSSL),$(BREW_OPENSSL),/usr)

CXX      := clang++
CXXFLAGS := -std=c++20 -Wall -Wextra -I$(OPENSSL_PREFIX)/include
LDFLAGS  := -L$(OPENSSL_PREFIX)/lib
LDLIBS   := -lssl -lcrypto

SRC      := $(wildcard src/*.cpp)
TEST_SRC := $(wildcard src/tests/*.cpp)
# Tests link against everything except the production entrypoint.
LIB_SRC  := $(filter-out src/main.cpp,$(SRC))

BIN       := bin/cpp-exec
# Each tests/*.cpp defines its own main, so every test file gets its own binary.
TEST_BINS := $(patsubst src/tests/%.cpp,bin/%,$(TEST_SRC))

# P2b-2: the threading tests under ThreadSanitizer (plan §14 "ThreadSanitizer
# where supported"). Only the tests that drive real threads across a socket
# or a ring — the whole suite under TSan would double the build for no
# additional coverage. Separate output dir so the plain binaries stay cached.
TSAN_TESTS := test_async_session test_tick_recorder test_tick_segments test_tick_workers test_tick_shadow test_tick_firer test_spot_feed_stop test_spot_feed_heartbeat test_telemetry test_engine_send_boundary
TSAN_BINS  := $(addprefix bin/tsan/,$(TSAN_TESTS))

.PHONY: all test tsan clean

all: $(BIN)

$(BIN): $(SRC)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

bin/%: src/tests/%.cpp $(LIB_SRC)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do ./$$t; done

bin/tsan/%: src/tests/%.cpp $(LIB_SRC)
	@mkdir -p bin/tsan
	$(CXX) $(CXXFLAGS) -g -fsanitize=thread $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

tsan: $(TSAN_BINS)
	@set -e; for t in $(TSAN_BINS); do TSAN_OPTIONS="halt_on_error=1 second_deadlock_stack=1" ./$$t; done

clean:
	rm -rf bin
