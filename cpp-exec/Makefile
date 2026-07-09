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

.PHONY: all test clean

all: $(BIN)

$(BIN): $(SRC)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

bin/%: src/tests/%.cpp $(LIB_SRC)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB_SRC) -o $@ $(LDFLAGS) $(LDLIBS)

test: $(TEST_BINS)
	@set -e; for t in $(TEST_BINS); do ./$$t; done

clean:
	rm -rf bin
