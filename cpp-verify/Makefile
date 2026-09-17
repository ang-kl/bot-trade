# cpp-verify — the read-only position verifier.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory: the WebSocket
# transport and the HTTP server are cpp-exec's and are compiled from there
# rather than copied. Copies drift; this cannot.
#
# WHAT IS DELIBERATELY ABSENT: cpp-exec/src/engine.cpp and everything it
# pulls in. "Read-only" is a property of the link line here, not a promise
# about routing — grep this file before believing any claim that this binary
# cannot place an order.

BREW_OPENSSL := $(shell brew --prefix openssl@3 2>/dev/null)
OPENSSL_PREFIX := $(if $(BREW_OPENSSL),$(BREW_OPENSSL),/usr)

CXX      := clang++
CXXFLAGS := -std=c++20 -Wall -Wextra -I$(OPENSSL_PREFIX)/include
LDFLAGS  := -L$(OPENSSL_PREFIX)/lib
LDLIBS   := -lssl -lcrypto

SHARED   := ../cpp-exec/src/ws_client.cpp ../cpp-exec/src/http_server.cpp
SRC      := $(wildcard src/*.cpp)
TEST_SRC := $(wildcard src/tests/*.cpp)
LIB_SRC  := $(filter-out src/main.cpp,$(SRC)) $(SHARED)

# Headers are prerequisites for the same reason cpp-exec's Makefile spells
# out at length (see its comment): without them a header-only change rebuilds
# nothing and `make test` re-runs stale binaries, so a mutation check on code
# that lives in a .hpp reports green while the edit is sitting on disk.
HDRS     := $(wildcard src/*.hpp) $(wildcard src/tests/*.hpp) \
            $(wildcard ../cpp-exec/src/*.hpp) $(wildcard ../cpp-exec/src/tests/*.hpp)

BIN       := bin/cpp-verify
TEST_BINS := $(patsubst src/tests/%.cpp,bin/%,$(TEST_SRC))

.PHONY: all test clean

all: $(BIN)

$(BIN): $(SRC) $(SHARED) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) $(SHARED) -o $@ $(LDFLAGS) $(LDLIBS)

bin/%: src/tests/%.cpp $(LIB_SRC) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do ./$$t; done

clean:
	rm -rf bin
