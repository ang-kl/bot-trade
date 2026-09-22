CXX ?= g++
CXXFLAGS := -std=c++20 -O2 -Wall -Wextra -pthread
LDLIBS := -lcrypto
SRC := $(wildcard src/*.cpp)
HDR := $(wildcard src/*.hpp)
LIB := $(filter-out src/main.cpp,$(SRC))
TEST := $(patsubst src/tests/%.cpp,bin/%,$(wildcard src/tests/*.cpp))
.PHONY: all test clean
all: bin/cpp-scan-timeframe
bin/cpp-scan-timeframe: $(SRC) $(HDR)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDLIBS)
bin/%: src/tests/%.cpp $(LIB) $(HDR)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB) -o $@ $(LDLIBS)
test: $(TEST)
	@set -e; for t in $(TEST); do ./$$t; done
clean:
	rm -rf bin
