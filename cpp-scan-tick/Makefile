CXX ?= g++
CXXFLAGS := -std=c++20 -O2 -Wall -Wextra -pthread
LDLIBS := -lcrypto
SRC := $(wildcard src/*.cpp)
HDR := $(wildcard src/*.hpp)
LIB := $(filter-out src/main.cpp,$(SRC))
TEST := $(patsubst src/tests/%.cpp,bin/%,$(wildcard src/tests/*.cpp))
# The tests that drive real worker threads, under ThreadSanitizer: stream
# turnover (a new feed epoch while the old one's events are still queued) and
# the symbol workers. Separate output dir so the plain binaries stay cached.
TSAN := $(addprefix bin/tsan/,test_scanner test_tick_workers)
.PHONY: all test tsan clean
all: bin/cpp-scan-tick
bin/cpp-scan-tick: $(SRC) $(HDR)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDLIBS)
bin/%: src/tests/%.cpp $(LIB) $(HDR)
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $< $(LIB) -o $@ $(LDLIBS)
test: $(TEST)
	@set -e; for t in $(TEST); do ./$$t; done
bin/tsan/%: src/tests/%.cpp $(LIB) $(HDR)
	@mkdir -p bin/tsan
	$(CXX) $(CXXFLAGS) -g -fsanitize=thread $< $(LIB) -o $@ $(LDLIBS)
tsan: $(TSAN)
	@set -e; for t in $(TSAN); do TSAN_OPTIONS="halt_on_error=1 second_deadlock_stack=1" ./$$t; done
clean:
	rm -rf bin
