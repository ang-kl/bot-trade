// cpp-exec/src/tests/test_auth_error_policy.cpp
//
// Whose fact is an auth error?
//
// Production incident, 2026-08-04 ~23:47Z. The owner enabled one demo account
// in the registry. The token did not cover it, so authorizing it returned
// CH_ACCESS_TOKEN_INVALID — and the session-level handler read that as "this
// token is dead", closed the websocket, and the sidecar reconnected roughly
// once a second until the account was removed:
//
//   connected and authenticated to demo.ctraderapi.com (2/4 account(s))
//   auth-family broker error 'CH_ACCESS_TOKEN_INVALID' — closing session
//   extra account 46979908 auth failed — skipped this session…
//   extra account 47790949 auth failed — …"websocket is not connected"
//
// The loop directly above that handler already had the right answer — skip
// this account, keep the session, retry on the next reconnect — and the
// handler overruled it. The cost: /health stopped answering inside its
// timeout, every account row on the page read "unknown", and the execution
// engine had no stable session to place or close an order on.
//
// These pin the rule that settles it. They need no socket, which is the point:
// the policy is now one pure function instead of two handlers that disagreed.
#include <cassert>
#include <cstdio>

#include "../engine.hpp"

int main() {
  // An extra account's rejection costs THAT ACCOUNT, never the session.
  assert(authErrorAction("CH_ACCESS_TOKEN_INVALID", true) == AuthErrorAction::SkipAccount);
  assert(authErrorAction("ACCOUNT_NOT_AUTHORIZED", true) == AuthErrorAction::SkipAccount);
  assert(authErrorAction("CH_ACCESS_TOKEN_EXPIRED", true) == AuthErrorAction::SkipAccount);

  // The same code OUTSIDE extra-account authorization still kills the session.
  // This is the case the guard was written for and must not be weakened: if
  // the token cannot authorize the account we trade on, the session is dead
  // and pretending otherwise leaves every order failing against a socket that
  // /health calls healthy.
  assert(authErrorAction("CH_ACCESS_TOKEN_INVALID", false) == AuthErrorAction::KillSession);
  assert(authErrorAction("NOT_AUTHENTICATED", false) == AuthErrorAction::KillSession);
  assert(authErrorAction("CH_CLIENT_AUTH_FAILURE", false) == AuthErrorAction::KillSession);
  assert(authErrorAction("ALREADY_LOGGED_IN", false) == AuthErrorAction::KillSession);

  // Everything else is somebody else's problem — a rejected order must never
  // drop the connection.
  for (const char* code : {"TRADING_BAD_VOLUME", "NOT_ENOUGH_MONEY", "MARKET_CLOSED", ""}) {
    assert(authErrorAction(code, false) == AuthErrorAction::Ignore);
    assert(authErrorAction(code, true) == AuthErrorAction::Ignore);
    assert(!isAuthFamilyError(code));
  }

  // The classifier itself, unchanged in membership — a code silently leaving
  // this set would turn a dead token into a permanently broken session.
  for (const char* code : {"CH_ACCESS_TOKEN_INVALID", "ACCOUNT_NOT_AUTHORIZED",
                           "NOT_AUTHENTICATED", "CH_CLIENT_AUTH_FAILURE",
                           "ALREADY_LOGGED_IN", "CH_ACCESS_TOKEN_EXPIRED"}) {
    assert(isAuthFamilyError(code));
  }

  std::printf("test_auth_error_policy OK\n");
  return 0;
}
