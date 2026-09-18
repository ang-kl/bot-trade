# cpp-verify — the position verifier. READ-ONLY AT THE BROKER: it never
# places, amends or cancels. It does write one thing — its own verdict journal.
#
# BUILD CONTEXT IS THIS DIRECTORY, and the WebSocket transport and HTTP server
# are VENDORED COPIES of cpp-exec's, sitting in src/ beside this service's own.
#
# That is a reversal, and the reason is measured rather than preferred. While
# this service compiled cpp-exec's files in place, its build context had to be
# the repository root — and the repository root carries railway.json and
# Dockerfile belonging to the NODE service, which Railway reads in preference
# to any panel setting on a fresh deploy. The result was a service named
# cpp-verify that built, in turn, the trading agent (crash-looping on
# AGENT_SECRET) and then cpp-exec itself — an ORDER-PLACING ENGINE running
# where the read-only one belongs. Sharing source cost the read-only guarantee.
#
# Copies drift, so the drift is made loud instead of silent:
# agent/services/sidecar-pins.test.js asserts each file here is BYTE-IDENTICAL
# to cpp-exec/src/, and goes red naming the file when it is not.
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

# The vendored transport sits in src/ alongside this service's own sources, so
# the wildcard covers it and every vendored file keeps cpp-exec's own relative
# includes unchanged — which is what lets the byte-identity test be exact.
SRC      := $(wildcard src/*.cpp)
TEST_SRC := $(wildcard src/tests/*.cpp)
LIB_SRC  := $(filter-out src/main.cpp,$(SRC))

# Headers are prerequisites for the same reason cpp-exec's Makefile spells
# out at length (see its comment): without them a header-only change rebuilds
# nothing and `make test` re-runs stale binaries, so a mutation check on code
# that lives in a .hpp reports green while the edit is sitting on disk.
HDRS     := $(wildcard src/*.hpp) $(wildcard src/tests/*.hpp)

BIN       := bin/cpp-verify
TEST_BINS := $(patsubst src/tests/%.cpp,bin/%,$(TEST_SRC))

.PHONY: all test clean

all: $(BIN)

$(BIN): $(SRC) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

bin/%: src/tests/%.cpp $(LIB_SRC) $(HDRS)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do ./$$t; done

clean:
	rm -rf bin
