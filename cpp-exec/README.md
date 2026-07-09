# cpp-exec — execution sidecar

A small C++ service that handles **order execution and position monitoring
only**. It speaks the same cTrader Open API JSON-over-WebSocket protocol as
`agent/lib/ctrader-ws.js` (wss on port 5036, frames of
`{payloadType, payload}`). All strategy, risk, and signal logic stays in the
Node agent; this sidecar just places, amends, closes, and watches positions.

## What it does

- Authenticates the app and trading account against cTrader.
- Accepts execution commands from the Node agent over HTTP (port 8091),
  authenticated with a shared secret.
- Sends new-order / amend-SLTP / close-position requests and tracks the
  resulting execution events.
- Reconciles open positions on connect and answers heartbeats to keep the
  session alive.

## Environment variables

| Variable                | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `CTRADER_HOST`          | cTrader Open API host (JSON WebSocket, :5036)  |
| `CTRADER_CLIENT_ID`     | Open API application client id                 |
| `CTRADER_CLIENT_SECRET` | Open API application client secret             |
| `CTRADER_ACCESS_TOKEN`  | OAuth access token for the trading account     |
| `CTRADER_ACCOUNT_ID`    | ctidTraderAccountId to authorize and trade on  |
| `EXEC_SECRET`           | Shared secret; Node must send it on every call |
| `PORT`                  | HTTP listen port (default 8091)                |

## How the Node agent delegates

Set on the **agent** service:

- `EXEC_ENGINE=cpp` — routes execution through this sidecar.
- `EXEC_URL=http://<cpp-exec-host>:8091` — where to reach it.
- `EXEC_SECRET` — must match the sidecar's value.

With `EXEC_ENGINE=cpp`, the agent stops sending order traffic itself and
POSTs execution intents to the sidecar instead. Everything else (signals,
risk checks, Telegram, journaling) is unchanged.

## Rollback

Unset `EXEC_ENGINE` (or set it to anything other than `cpp`) and redeploy
the agent. It falls back to the pure JS execution path in
`agent/lib/ctrader-ws.js` immediately; the sidecar can stay running or be
stopped — nothing else depends on it.

## Build and test locally

```sh
make        # builds bin/cpp-exec (clang++, C++20, OpenSSL via Homebrew or /usr)
make test   # builds and runs src/tests/*
make clean
```

Docker image (same as Railway uses):

```sh
docker build -t cpp-exec .
```
