// cpp-exec/src/tests/test_json.cpp — plain-assert tests for json.hpp.
// Build: clang++ -std=c++20 -I.. test_json.cpp -o test_json && ./test_json
#include <cassert>
#include <cstdio>

#include "../json.hpp"

using jsn::Value;

static void testBuildAndDump() {
  Value v{jsn::Object{}};
  v.set("payloadType", 2100);
  Value p{jsn::Object{}};
  p.set("clientId", "abc");
  p.set("clientSecret", "s\"3\n");
  p.set("flag", true);
  p.set("nothing", nullptr);
  v.set("payload", p);
  std::string out = jsn::dump(v);
  // std::map orders keys, so output is deterministic.
  assert(out ==
         "{\"payload\":{\"clientId\":\"abc\",\"clientSecret\":\"s\\\"3\\n\","
         "\"flag\":true,\"nothing\":null},\"payloadType\":2100}");
}

static void testDumpArrayAndNumbers() {
  jsn::Array a;
  a.push_back(Value(1));
  a.push_back(Value(2.5));
  a.push_back(Value(-3));
  a.push_back(Value(false));
  assert(jsn::dump(Value(a)) == "[1,2.5,-3,false]");
  // 53-bit-safe integral doubles print without a fraction
  assert(jsn::dump(Value(9007199254740992.0)) == "9007199254740992");
}

static void testParseRoundtrip() {
  auto v = jsn::parse(
      "{\"payloadType\":2126,\"payload\":{\"executionType\":\"ORDER_FILLED\","
      "\"position\":{\"positionId\":12345,\"price\":1.2345},"
      "\"tags\":[\"a\",\"b\"],\"live\":true,\"gone\":null}}");
  assert(v && v->isObject());
  assert(v->get("payloadType").asNumber() == 2126);
  const Value& p = v->get("payload");
  assert(p.get("executionType").asString() == "ORDER_FILLED");
  assert(p.get("position").get("positionId").asNumber() == 12345);
  assert(p.get("position").get("price").asNumber() == 1.2345);
  assert(p.get("tags").asArray().size() == 2);
  assert(p.get("tags").asArray()[1].asString() == "b");
  assert(p.get("live").asBool());
  assert(p.get("gone").isNull());
  assert(p.get("missingKey").isNull()); // missing lookup is Null, not a crash
}

static void testParseEscapes() {
  auto v = jsn::parse("\"line\\n tab\\t quote\\\" u\\u0041 cjk\\u4e2d\"");
  assert(v && v->isString());
  assert(v->asString() == "line\n tab\t quote\" uA cjk\xe4\xb8\xad");
  // surrogate pair -> 4-byte UTF-8
  auto e = jsn::parse("\"\\ud83d\\ude00\"");
  assert(e && e->asString() == "\xf0\x9f\x98\x80");
}

static void testEscapeRoundtrip() {
  std::string tricky = "a\"b\\c\nd\te\x01f";
  std::string dumped = jsn::dump(Value(tricky));
  auto back = jsn::parse(dumped);
  assert(back && back->asString() == tricky);
}

static void testParseRejects() {
  assert(!jsn::parse(""));
  assert(!jsn::parse("{"));
  assert(!jsn::parse("{\"a\":}"));
  assert(!jsn::parse("[1,2,]"));
  assert(!jsn::parse("{\"a\":1} trailing"));
  assert(!jsn::parse("\"unterminated"));
  assert(!jsn::parse("{\"a\" 1}"));
  assert(!jsn::parse("nul"));
  assert(!jsn::parse("--1"));
  // unpaired high surrogate
  assert(!jsn::parse("\"\\ud83d\""));
  // depth bomb must not blow the stack
  std::string deep(200, '[');
  assert(!jsn::parse(deep));
}

static void testParseNumbers() {
  assert(jsn::parse("0")->asNumber() == 0);
  assert(jsn::parse("-12.5e2")->asNumber() == -1250);
  assert(jsn::parse("  42  ")->asNumber() == 42);
}

int main() {
  testBuildAndDump();
  testDumpArrayAndNumbers();
  testParseRoundtrip();
  testParseEscapes();
  testEscapeRoundtrip();
  testParseRejects();
  testParseNumbers();
  std::puts("test_json: all assertions passed");
  return 0;
}
