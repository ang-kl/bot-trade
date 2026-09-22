// cpp-exec/src/json.hpp
//
// Minimal JSON value tree + serializer + parser. No external deps, no
// exceptions escape: parse() returns std::nullopt on malformed input.
// Numbers are stored as double — cTrader ids fit in a double's 53-bit
// mantissa, and the Node side of this project already lives with that.
#pragma once

#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace jsn {

class Value;
using Object = std::map<std::string, Value>;
using Array  = std::vector<Value>;

class Value {
public:
  enum class Type { Null, Bool, Number, String, Obj, Arr };

  Value() : type_(Type::Null) {}
  Value(std::nullptr_t) : type_(Type::Null) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(double d) : type_(Type::Number), num_(d) {}
  Value(int i) : type_(Type::Number), num_(i) {}
  Value(long long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
  Value(const char* s) : type_(Type::String), str_(s) {}
  Value(std::string s) : type_(Type::String), str_(std::move(s)) {}
  Value(Object o) : type_(Type::Obj), obj_(std::make_shared<Object>(std::move(o))) {}
  Value(Array a) : type_(Type::Arr), arr_(std::make_shared<Array>(std::move(a))) {}

  Type type() const { return type_; }
  bool isNull()   const { return type_ == Type::Null; }
  bool isBool()   const { return type_ == Type::Bool; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isObject() const { return type_ == Type::Obj; }
  bool isArray()  const { return type_ == Type::Arr; }

  bool asBool(bool dflt = false) const { return isBool() ? bool_ : dflt; }
  double asNumber(double dflt = 0) const { return isNumber() ? num_ : dflt; }
  const std::string& asString() const { static const std::string kEmpty; return isString() ? str_ : kEmpty; }
  const Object& asObject() const { static const Object kEmpty; return isObject() ? *obj_ : kEmpty; }
  const Array& asArray() const { static const Array kEmpty; return isArray() ? *arr_ : kEmpty; }

  // Lookup on objects; returns Null value when key missing or not an object.
  const Value& get(const std::string& key) const {
    static const Value kNull;
    if (!isObject()) return kNull;
    auto it = obj_->find(key);
    return it == obj_->end() ? kNull : it->second;
  }

  // Mutating set for object builders.
  void set(const std::string& key, Value v) {
    if (type_ != Type::Obj) { type_ = Type::Obj; obj_ = std::make_shared<Object>(); }
    (*obj_)[key] = std::move(v);
  }

private:
  Type type_;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  std::shared_ptr<Object> obj_;
  std::shared_ptr<Array> arr_;
};

inline void escapeInto(const std::string& s, std::string& out) {
  for (unsigned char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
}

inline void dumpInto(const Value& v, std::string& out) {
  switch (v.type()) {
    case Value::Type::Null:   out += "null"; break;
    case Value::Type::Bool:   out += v.asBool() ? "true" : "false"; break;
    case Value::Type::Number: {
      double d = v.asNumber();
      // JSON has no NaN/Infinity — mirror JSON.stringify and emit null so
      // output stays parseable (e.g. Inf pnlPct from a zero-price bar).
      if (!std::isfinite(d)) { out += "null"; break; }
      // Integral values print without a fraction — payloadType etc. must be
      // plain ints on the wire.
      if (d == static_cast<double>(static_cast<long long>(d)) &&
          d >= -9.007199254740992e15 && d <= 9.007199254740992e15) {
        char buf[32];
        std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(d));
        out += buf;
      } else {
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.17g", d);
        out += buf;
      }
      break;
    }
    case Value::Type::String:
      out += '"'; escapeInto(v.asString(), out); out += '"';
      break;
    case Value::Type::Obj: {
      out += '{';
      bool first = true;
      for (const auto& [k, val] : v.asObject()) {
        if (!first) out += ',';
        first = false;
        out += '"'; escapeInto(k, out); out += "\":";
        dumpInto(val, out);
      }
      out += '}';
      break;
    }
    case Value::Type::Arr: {
      out += '[';
      bool first = true;
      for (const auto& val : v.asArray()) {
        if (!first) out += ',';
        first = false;
        dumpInto(val, out);
      }
      out += ']';
      break;
    }
  }
}

inline std::string dump(const Value& v) {
  std::string out;
  dumpInto(v, out);
  return out;
}

// ---- parser ---------------------------------------------------------------

namespace detail {

struct Parser {
  const char* p;
  const char* end;
  int depth = 0;
  static constexpr int kMaxDepth = 64;

  void ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p; }
  bool eat(char c) { if (p < end && *p == c) { ++p; return true; } return false; }
  bool lit(const char* s, size_t n) {
    if (static_cast<size_t>(end - p) < n) return false;
    for (size_t i = 0; i < n; ++i) if (p[i] != s[i]) return false;
    p += n;
    return true;
  }

  std::optional<Value> value() {
    if (++depth > kMaxDepth) return std::nullopt;
    ws();
    if (p >= end) { --depth; return std::nullopt; }
    std::optional<Value> r;
    switch (*p) {
      case '{': r = object(); break;
      case '[': r = array(); break;
      case '"': { auto s = string(); r = s ? std::optional<Value>(Value(std::move(*s))) : std::nullopt; break; }
      case 't': r = lit("true", 4)  ? std::optional<Value>(Value(true))  : std::nullopt; break;
      case 'f': r = lit("false", 5) ? std::optional<Value>(Value(false)) : std::nullopt; break;
      case 'n': r = lit("null", 4)  ? std::optional<Value>(Value(nullptr)) : std::nullopt; break;
      default:  r = number(); break;
    }
    --depth;
    return r;
  }

  std::optional<Value> object() {
    ++p; // '{'
    Object o;
    ws();
    if (eat('}')) return Value(std::move(o));
    for (;;) {
      ws();
      if (p >= end || *p != '"') return std::nullopt;
      auto key = string();
      if (!key) return std::nullopt;
      ws();
      if (!eat(':')) return std::nullopt;
      auto v = value();
      if (!v) return std::nullopt;
      o[std::move(*key)] = std::move(*v);
      ws();
      if (eat(',')) continue;
      if (eat('}')) return Value(std::move(o));
      return std::nullopt;
    }
  }

  std::optional<Value> array() {
    ++p; // '['
    Array a;
    ws();
    if (eat(']')) return Value(std::move(a));
    for (;;) {
      auto v = value();
      if (!v) return std::nullopt;
      a.push_back(std::move(*v));
      ws();
      if (eat(',')) continue;
      if (eat(']')) return Value(std::move(a));
      return std::nullopt;
    }
  }

  std::optional<std::string> string() {
    ++p; // '"'
    std::string s;
    while (p < end) {
      unsigned char c = static_cast<unsigned char>(*p++);
      if (c == '"') return s;
      if (c == '\\') {
        if (p >= end) return std::nullopt;
        char e = *p++;
        switch (e) {
          case '"':  s += '"';  break;
          case '\\': s += '\\'; break;
          case '/':  s += '/';  break;
          case 'b':  s += '\b'; break;
          case 'f':  s += '\f'; break;
          case 'n':  s += '\n'; break;
          case 'r':  s += '\r'; break;
          case 't':  s += '\t'; break;
          case 'u': {
            unsigned cp = 0;
            if (!hex4(cp)) return std::nullopt;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              // surrogate pair
              if (!lit("\\u", 2)) return std::nullopt;
              unsigned lo = 0;
              if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) return std::nullopt;
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            appendUtf8(cp, s);
            break;
          }
          default: return std::nullopt;
        }
      } else if (c < 0x20) {
        return std::nullopt;
      } else {
        s += static_cast<char>(c);
      }
    }
    return std::nullopt;
  }

  bool hex4(unsigned& out) {
    if (end - p < 4) return false;
    unsigned v = 0;
    for (int i = 0; i < 4; ++i) {
      char c = *p++;
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
      else return false;
    }
    out = v;
    return true;
  }

  static void appendUtf8(unsigned cp, std::string& s) {
    if (cp < 0x80) { s += static_cast<char>(cp); }
    else if (cp < 0x800) {
      s += static_cast<char>(0xC0 | (cp >> 6));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      s += static_cast<char>(0xE0 | (cp >> 12));
      s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      s += static_cast<char>(0xF0 | (cp >> 18));
      s += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      s += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }

  std::optional<Value> number() {
    const char* start = p;
    if (p < end && *p == '-') ++p;
    while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p;
    if (p < end && *p == '.') { ++p; while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p; }
    if (p < end && (*p == 'e' || *p == 'E')) {
      ++p;
      if (p < end && (*p == '+' || *p == '-')) ++p;
      while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p;
    }
    if (p == start) return std::nullopt;
    std::string tok(start, p);
    char* endp = nullptr;
    double d = std::strtod(tok.c_str(), &endp);
    if (endp != tok.c_str() + tok.size()) return std::nullopt;
    return Value(d);
  }
};

} // namespace detail

inline std::optional<Value> parse(const std::string& text) {
  detail::Parser pr{text.data(), text.data() + text.size()};
  auto v = pr.value();
  if (!v) return std::nullopt;
  pr.ws();
  if (pr.p != pr.end) return std::nullopt; // trailing garbage is a reject
  return v;
}

} // namespace jsn
