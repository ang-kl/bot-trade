// cTrader Open API integration
// Endpoints sourced from Spotware's official repos:
//   github.com/spotware/OpenApiPy  (endpoints.py, auth.py)
//   github.com/spotware/OpenAPI.Net (ApiInfo.cs)
//
// OAuth2: REST via https://openapi.ctrader.com/apps/*
// Accounts + Deals: WebSocket JSON via wss://demo|live.ctraderapi.com:5036
//   (REST /connect/tradingaccounts is deprecated per Spotware forum Oct 2024)
//
// Setup:
// 1. Register app at https://openapi.ctrader.com
// 2. Set env vars: CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET
// 3. Add redirect URI from the deployment origin (/link-up route)

import WebSocket from 'ws'
import { encodeLabel, convictionBucket } from '../agent/lib/trade-labels.js'

const CTRADER_API = 'https://openapi.ctrader.com'

// Reconstructs the request origin without relying on the browser sending an
// Origin header. Browsers only guarantee Origin on cross-origin/POST, so
// same-origin GETs (like auth-url) arrive without one on most platforms.
// Vercel, Netlify and other proxies expose x-forwarded-host/proto; fall
// back to the raw Host header for direct node invocations.
function resolveOrigin(req) {
  const h = req.headers || {}
  if (typeof h.origin === 'string' && h.origin) return h.origin
  const host = h['x-forwarded-host'] || h.host
  if (!host) return null
  const proto = h['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

// Payload types — from github.com/spotware/openapi-proto-messages
const PT = {
  HEARTBEAT:          51,
  APP_AUTH_REQ:       2100,
  APP_AUTH_RES:       2101,
  ACCOUNT_AUTH_REQ:   2102,
  ACCOUNT_AUTH_RES:   2103,
  NEW_ORDER_REQ:      2106,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  RECONCILE_REQ:      2124,
  RECONCILE_RES:      2125,
  EXECUTION_EVENT:    2126,
  ORDER_ERROR_EVENT:  2132,
  TRADER_REQ:         2121,
  TRADER_RES:         2122,
  SYMBOLS_LIST_REQ:   2114,
  SYMBOLS_LIST_RES:   2115,
  SYMBOL_BY_ID_REQ:   2116,
  SYMBOL_BY_ID_RES:   2117,
  DEAL_LIST_REQ:      2133,
  DEAL_LIST_RES:      2134,
  GET_TRENDBARS_REQ:  2137,
  GET_TRENDBARS_RES:  2138,
  ERROR_RES:          2142,
  GET_ACCOUNTS_REQ:   2149,
  GET_ACCOUNTS_RES:   2150,
}

// Trendbar period enum — maps abot timeframes to cTrader ProtoOATrendbarPeriod
// Spotware natively supports: M1, M2, M3, M4, M5, M10, M15, M30, H1, H4, H12,
// D1, W1, MN1. Any abot timeframe not listed here (20m, 2h, 8h, 5d, 2w, 3M,
// 6M, 1y) is synthesised on the client by aggregating OHLCV from a shorter
// native period — see src/lib/aggregate-bars.js.
const TRENDBAR_PERIOD = {
  '1m': 'M1', '2m': 'M2', '3m': 'M3', '5m': 'M5',
  '10m': 'M10', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '4h': 'H4', '12h': 'H12',
  '1d': 'D1', '1w': 'W1', '1M': 'MN1',
}

// ── WebSocket JSON helper ──
// Opens a connection, runs a sequence of request/response pairs, then closes.
// Each step: { send: {payloadType, payload}, expect: payloadType }
// Returns array of response payloads.

function wsQuery(host, steps, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:5036`)
    const results = []
    const seenMessages = [] // track every payloadType we receive for debugging
    let stepIdx = 0
    let heartbeatTimer

    const cleanup = () => {
      clearInterval(heartbeatTimer)
      if (ws.readyState === WebSocket.OPEN) ws.close()
    }

    const timer = setTimeout(() => {
      cleanup()
      const stepLabel = steps[stepIdx]
        ? `waiting for payloadType ${steps[stepIdx].expect} on step ${stepIdx + 1}/${steps.length} (sent ${steps[stepIdx].send.payloadType})`
        : 'unknown step'
      const seenStr = seenMessages.length ? ` | received: [${seenMessages.join(',')}]` : ' | no messages received'
      reject(new Error(`cTrader WebSocket timeout after ${timeoutMs}ms — ${stepLabel}${seenStr}`))
    }, timeoutMs)

    ws.on('open', () => {
      // Heartbeat every 9s (server requires < 10s)
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT }))
        }
      }, 9000)
      // Send first step
      const step = steps[stepIdx]
      ws.send(JSON.stringify({
        clientMsgId: `step_${stepIdx}`,
        payloadType: step.send.payloadType,
        payload: step.send.payload,
      }))
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // Track every non-heartbeat message for timeout diagnostics
      if (msg.payloadType !== PT.HEARTBEAT) {
        seenMessages.push(msg.payloadType)
      }

      // Handle generic protocol errors
      if (msg.payloadType === PT.ERROR_RES) {
        cleanup()
        clearTimeout(timer)
        const err = msg.payload || {}
        const parts = [err.errorCode, err.description, err.maintenanceEndTimestamp]
          .filter(Boolean)
          .join(' — ')
        reject(new Error(`cTrader error (step ${stepIdx + 1}, sent ${steps[stepIdx]?.send?.payloadType}): ${parts || 'Unknown'}`))
        return
      }

      // Handle order-specific errors — cTrader sends these instead of a
      // regular ERROR_RES when a NEW_ORDER_REQ / CLOSE_POSITION_REQ is
      // rejected. Without this branch, we sit waiting for EXECUTION_EVENT
      // that will never come and hit the 25s timeout.
      if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
        cleanup()
        clearTimeout(timer)
        const err = msg.payload || {}
        const parts = [err.errorCode, err.description].filter(Boolean).join(' — ')
        const orderRef = err.orderId ? ` orderId=${err.orderId}` : ''
        const posRef = err.positionId ? ` positionId=${err.positionId}` : ''
        reject(new Error(`cTrader order rejected: ${parts || 'Unknown'}${orderRef}${posRef}`))
        return
      }

      // Skip heartbeats
      if (msg.payloadType === PT.HEARTBEAT) return

      const expected = steps[stepIdx]?.expect
      if (msg.payloadType === expected) {
        results.push(msg.payload || {})
        stepIdx++
        if (stepIdx >= steps.length) {
          // All steps done
          cleanup()
          clearTimeout(timer)
          resolve(results)
        } else {
          // Send next step
          const next = steps[stepIdx]
          ws.send(JSON.stringify({
            clientMsgId: `step_${stepIdx}`,
            payloadType: next.send.payloadType,
            payload: next.send.payload,
          }))
        }
      }
    })

    ws.on('error', (err) => {
      cleanup()
      clearTimeout(timer)
      reject(new Error(`cTrader WebSocket error: ${err.message}`))
    })

    ws.on('close', () => {
      clearTimeout(timer)
      clearInterval(heartbeatTimer)
    })
  })
}

export default async function handler(req, res) {
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET

  // ── OAuth2 (REST) ──

  if (req.method === 'GET' && req.query.action === 'auth-url') {
    if (!clientId) return res.status(500).json({ error: 'CTRADER_CLIENT_ID not configured' })
    // Browsers often omit Origin on same-origin GETs, so fall back to the
    // forwarded host headers Vercel (and most reverse proxies) inject.
    const origin = resolveOrigin(req)
    if (!origin) return res.status(400).json({ error: 'unable to resolve request origin' })
    const redirectUri = `${origin}/link-up`
    const url = `${CTRADER_API}/apps/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`
    return res.status(200).json({ url, redirectUri })
  }

  if (req.method === 'POST' && req.body.action === 'exchange-token') {
    const { code, redirectUri } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      })
      const tokenRes = await fetch(`${CTRADER_API}/apps/token?${params}`)
      const d = await tokenRes.json()
      if (d.error || d.errorCode) return res.status(400).json({ error: d.errorDescription || d.description || d.error || d.errorCode })
      return res.status(200).json({
        accessToken: d.accessToken ?? d.access_token,
        refreshToken: d.refreshToken ?? d.refresh_token,
        expiresIn: d.expiresIn ?? d.expires_in,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (req.method === 'POST' && req.body.action === 'refresh-token') {
    const { refreshToken } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      })
      const tokenRes = await fetch(`${CTRADER_API}/apps/token?${params}`)
      const d = await tokenRes.json()
      if (d.error || d.errorCode) return res.status(400).json({ error: d.errorDescription || d.description || d.error || d.errorCode })
      return res.status(200).json({
        accessToken: d.accessToken ?? d.access_token,
        refreshToken: d.refreshToken ?? d.refresh_token ?? refreshToken,
        expiresIn: d.expiresIn ?? d.expires_in,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Accounts + Deals (WebSocket JSON API on port 5036) ──

  if (req.method === 'POST' && req.body.action === 'accounts') {
    const { accessToken } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    try {
      // 1. App auth → 2. Get accounts by access token
      const results = await wsQuery('demo.ctraderapi.com', [
        {
          send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } },
          expect: PT.APP_AUTH_RES,
        },
        {
          send: { payloadType: PT.GET_ACCOUNTS_REQ, payload: { accessToken } },
          expect: PT.GET_ACCOUNTS_RES,
        },
      ])

      const accountList = results[1]?.ctidTraderAccount || []
      return res.status(200).json({
        accounts: accountList.map(a => ({
          accountId: a.ctidTraderAccountId,
          accountNumber: a.traderLogin,
          brokerTitle: a.brokerTitleShort || a.brokerTitle || 'cTrader',
          isLive: a.isLive ?? !a.isDemo,
          balance: a.balance?.amount ? a.balance.amount / 100 : null,
          currency: a.depositCurrency || a.balance?.currency || '',
        })),
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (req.method === 'POST' && req.body.action === 'deals') {
    const { accessToken, accountId, from, to } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    // Determine host — use live for live accounts, demo for demo
    // For now default to demo; the frontend can pass isLive flag later
    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    const now = Date.now()
    const fromTs = from ? new Date(from).getTime() : now - 30 * 24 * 60 * 60 * 1000 // default last 30 days
    const toTs = to ? new Date(to).getTime() : now

    try {
      // 1. App auth → 2. Account auth → 3. Deal list
      const results = await wsQuery(host, [
        {
          send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } },
          expect: PT.APP_AUTH_RES,
        },
        {
          send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } },
          expect: PT.ACCOUNT_AUTH_RES,
        },
        {
          send: {
            payloadType: PT.DEAL_LIST_REQ,
            payload: {
              ctidTraderAccountId: parseInt(accountId),
              fromTimestamp: fromTs,
              toTimestamp: toTs,
              maxRows: 1000,
            },
          },
          expect: PT.DEAL_LIST_RES,
        },
      ])

      const rawDeals = results[2]?.deal || []

      // Transform cTrader deals to our trade format
      const trades = rawDeals
        .filter(d => d.closePositionDetail) // only deals that closed a position
        .map((d, i) => {
          const cpd = d.closePositionDetail || {}
          return {
            id: i + 1,
            dealId: d.dealId,
            symbol: `SID:${d.symbolId}`, // symbolId needs resolution via symbol list
            direction: d.tradeSide === 'BUY' || d.tradeSide === 1 ? 'BUY' : 'SELL',
            entryTime: cpd.entryPrice ? new Date(d.executionTimestamp || 0).toISOString() : '',
            exitTime: new Date(d.executionTimestamp || 0).toISOString(),
            entryPrice: cpd.entryPrice || 0,
            exitPrice: d.executionPrice || 0,
            volume: d.filledVolume ? d.filledVolume / 100 : 0, // cTrader uses cents of lots
            grossProfit: cpd.grossProfit ? cpd.grossProfit / 100 : 0,
            commission: Math.abs(cpd.commission ? cpd.commission / 100 : 0),
            swap: Math.abs(cpd.swap ? cpd.swap / 100 : 0),
            netProfit: ((cpd.grossProfit || 0) - Math.abs(cpd.commission || 0) - Math.abs(cpd.swap || 0)) / 100,
            pips: 0, // would need symbol pip size to calculate
          }
        })

      // Running balance
      let runningBalance = 0
      for (const t of trades) {
        runningBalance += t.netProfit
        t.runningBalance = Math.round(runningBalance * 100) / 100
      }

      return res.status(200).json({ trades, count: trades.length })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Symbol search (WebSocket JSON API) ──

  if (req.method === 'POST' && req.body.action === 'symbols') {
    const { accessToken, accountId } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      const results = await wsQuery(host, [
        {
          send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } },
          expect: PT.APP_AUTH_RES,
        },
        {
          send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } },
          expect: PT.ACCOUNT_AUTH_RES,
        },
        {
          send: { payloadType: PT.SYMBOLS_LIST_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } },
          expect: PT.SYMBOLS_LIST_RES,
        },
      ])

      const symbols = (results[2]?.symbol || []).map(s => ({
        symbolId: s.symbolId,
        name: s.symbolName,
        description: s.description || '',
        enabled: s.enabled !== false,
      }))

      // Client-side filter by query string
      const query = (req.body.query || '').toUpperCase()
      const filtered = query
        ? symbols.filter(s => s.name.toUpperCase().includes(query) || s.description.toUpperCase().includes(query))
        : symbols

      // Return ALL matching symbols — Pepperstone has hundreds and the user
      // needs to find specific ones by name (e.g. JPN225). Earlier 100-cap
      // hid symbols that appeared later in the list alphabetically.
      return res.status(200).json({ symbols: filtered, totalCount: symbols.length })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Trendbars / OHLCV (WebSocket JSON API) ──

  if (req.method === 'POST' && req.body.action === 'trendbars') {
    const { accessToken, accountId, symbolId, timeframe, from, to } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    const period = TRENDBAR_PERIOD[timeframe]
    if (!period) {
      return res.status(400).json({
        error: `Unknown timeframe "${timeframe}". Valid: ${Object.keys(TRENDBAR_PERIOD).join(', ')}`,
      })
    }
    const now = Date.now()
    const fromTs = from ? new Date(from).getTime() : now - 30 * 24 * 60 * 60 * 1000
    const toTs = to ? new Date(to).getTime() : now

    try {
      const results = await wsQuery(host, [
        {
          send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } },
          expect: PT.APP_AUTH_RES,
        },
        {
          send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } },
          expect: PT.ACCOUNT_AUTH_RES,
        },
        {
          send: {
            payloadType: PT.GET_TRENDBARS_REQ,
            payload: {
              ctidTraderAccountId: parseInt(accountId),
              symbolId: parseInt(symbolId),
              period,
              fromTimestamp: fromTs,
              toTimestamp: toTs,
            },
          },
          expect: PT.GET_TRENDBARS_RES,
        },
      ])

      // cTrader stores trendbar OHLC in raw "points" where 1 point = 10^-5
      // (i.e. raw values are price × 100000). Convert to actual prices.
      // See: https://help.ctrader.com/open-api/messages/#ProtoOATrendbar
      const POINTS_PER_PRICE = 100000
      const bars = (results[2]?.trendbar || []).map(b => {
        const lowRaw = b.low || 0
        return {
          t: b.utcTimestampInMinutes ? b.utcTimestampInMinutes * 60 * 1000 : 0,
          o: (lowRaw + (b.deltaOpen || 0)) / POINTS_PER_PRICE,
          h: (lowRaw + (b.deltaHigh || 0)) / POINTS_PER_PRICE,
          l: lowRaw / POINTS_PER_PRICE,
          c: (lowRaw + (b.deltaClose || 0)) / POINTS_PER_PRICE,
          v: b.volume || 0,
        }
      })

      return res.status(200).json({
        candles: bars,
        symbolId,
        period,
        count: bars.length,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Symbol Details (min/step/max volume, digits) via SYMBOL_BY_ID_REQ ──
  // Needed before placing an order — the broker tells us the minVolume and
  // volume increment for the symbol, so we don't guess at "100 for 0.01 lot".

  if (req.method === 'POST' && req.body.action === 'symbol-details') {
    const { accessToken, accountId, symbolId } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })
    if (!symbolId) return res.status(400).json({ error: 'symbolId is required' })

    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        {
          send: {
            payloadType: PT.SYMBOL_BY_ID_REQ,
            payload: {
              ctidTraderAccountId: parseInt(accountId),
              symbolId: [parseInt(symbolId)],
            },
          },
          expect: PT.SYMBOL_BY_ID_RES,
        },
      ])

      // The response's `symbol` field is an array (the req takes a list).
      // Take the first one since we asked for a single symbolId.
      const sym = results[2]?.symbol?.[0] || {}

      return res.status(200).json({
        symbolId: parseInt(symbolId),
        digits: sym.digits != null ? sym.digits : null,
        pipPosition: sym.pipPosition != null ? sym.pipPosition : null,
        lotSize: sym.lotSize != null ? sym.lotSize : null,
        minVolume: sym.minVolume != null ? sym.minVolume : null,
        maxVolume: sym.maxVolume != null ? sym.maxVolume : null,
        stepVolume: sym.stepVolume != null ? sym.stepVolume : null,
        tradingMode: sym.tradingMode || null,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Account Info (balance, equity) via TRADER_REQ ──

  if (req.method === 'POST' && req.body.action === 'account-info') {
    const { accessToken, accountId } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        { send: { payloadType: PT.TRADER_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.TRADER_RES },
      ])

      const trader = results[2]?.trader || {}
      // cTrader uses variable monetary precision via `moneyDigits`:
      //   moneyDigits = 2 → divide raw by 10^2 (standard USD cents)
      //   moneyDigits = 5 → divide raw by 10^5 (what Pepperstone returns)
      // Default to 2 if field is missing.
      const moneyDigits = trader.moneyDigits != null ? trader.moneyDigits : 2
      const moneyDivisor = Math.pow(10, moneyDigits)
      // depositAssetId is a numeric cTrader asset ID (e.g. 14 = USD), NOT a
      // currency string. Resolving it to a symbol requires ASSET_LIST_REQ,
      // which we don't run here. Return empty string — the UI omits currency
      // suffix instead of rendering "$1,779.03 14".
      return res.status(200).json({
        balance: trader.balance != null ? trader.balance / moneyDivisor : null,
        equity: trader.equity != null ? trader.equity / moneyDivisor : null,
        currency: '',
        depositAssetId: trader.depositAssetId || null,
        leverage: trader.leverageInCents != null ? trader.leverageInCents / 100 : null,
        moneyDigits,
        accountId,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Open Positions via RECONCILE_REQ (2124) ──
  // Returns all currently-open positions for the account. Used by Link-Up
  // to display an "Active Trades" table.

  if (req.method === 'POST' && req.body.action === 'open-positions') {
    const { accessToken, accountId } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const host = req.body.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        { send: { payloadType: PT.RECONCILE_REQ, payload: { ctidTraderAccountId: parseInt(accountId) } }, expect: PT.RECONCILE_RES },
      ])

      const reconcile = results[2] || {}

      // Resolve symbolId → symbolName via SYMBOL_BY_ID batch lookup. Merge
      // position and resting-order symbol IDs into a single call so we only
      // pay one round-trip even if the account has a mix of both.
      const allSymbolIds = [...new Set([
        ...(reconcile.position || []).map(p => p.tradeData?.symbolId),
        ...(reconcile.order || []).map(o => o.tradeData?.symbolId),
      ].filter(Boolean))]
      let symbolNameMap = {}
      if (allSymbolIds.length > 0) {
        try {
          const symResults = await wsQuery(host, [
            { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
            { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
            { send: { payloadType: PT.SYMBOL_BY_ID_REQ, payload: { ctidTraderAccountId: parseInt(accountId), symbolId: allSymbolIds.map(id => parseInt(id)) } }, expect: PT.SYMBOL_BY_ID_RES },
          ])
          for (const s of (symResults[2]?.symbol || [])) {
            symbolNameMap[String(s.symbolId)] = s.symbolName
          }
        } catch {}
      }

      const normSide = (s) => s === 'BUY' || s === 1 ? 'BUY' : 'SELL'
      // Each position has tradeData with symbolId, volume, tradeSide, etc.
      const positions = (reconcile.position || []).map(p => {
        const t = p.tradeData || {}
        const md = p.moneyDigits != null ? p.moneyDigits : 2
        const divisor = Math.pow(10, md)
        return {
          positionId: p.positionId,
          symbolId: t.symbolId,
          symbolName: symbolNameMap[String(t.symbolId)] || null,
          side: normSide(t.tradeSide),
          volume: t.volume,
          openPrice: p.price,
          openTimestamp: t.openTimestamp,
          stopLoss: p.stopLoss || null,
          takeProfit: p.takeProfit || null,
          swap: p.swap != null ? p.swap / divisor : 0,
          commission: p.commission != null ? p.commission / divisor : 0,
          usedMargin: p.usedMargin != null ? p.usedMargin / divisor : null,
          label: t.label || '',
          comment: t.comment || '',
        }
      })

      // Pending orders — LIMIT/STOP/STOP_LIMIT that haven't filled yet.
      // cTrader returns them in `reconcile.order` as a sibling to positions.
      // Shape mirrors `positions` with order-specific fields layered on top.
      const ORDER_TYPE_MAP = { 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LIMIT' }
      const orders = (reconcile.order || []).map(o => {
        const t = o.tradeData || {}
        const rawType = o.orderType
        return {
          orderId: o.orderId,
          symbolId: t.symbolId,
          symbolName: symbolNameMap[String(t.symbolId)] || null,
          side: normSide(t.tradeSide),
          volume: t.volume,
          orderType: typeof rawType === 'number' ? (ORDER_TYPE_MAP[rawType] || String(rawType)) : String(rawType ?? '').replace(/^ORDER_TYPE_/, ''),
          orderStatus: o.orderStatus,     // 'ORDER_STATUS_ACCEPTED' etc.
          limitPrice: o.limitPrice || null,
          stopPrice: o.stopPrice || null,
          stopLoss: o.stopLoss || null,
          takeProfit: o.takeProfit || null,
          expirationTimestamp: o.expirationTimestamp || null,
          utcLastUpdateTimestamp: o.utcLastUpdateTimestamp || t.openTimestamp || null,
          label: t.label || '',
          comment: t.comment || '',
        }
      })

      return res.status(200).json({
        positions,
        count: positions.length,
        orders,
        pendingOrders: orders.length,
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Place Order — the ONE action that actually moves money ──
  // Hardened with multiple safety checks. Demo-only by default.

  if (req.method === 'POST' && req.body.action === 'place-order') {
    const {
      accessToken, accountId, symbolId,
      tradeSide,              // 'BUY' | 'SELL'
      volume,                 // int — cTrader volume (from symbol minVolume)
      orderType = 'MARKET',
      stopLoss,               // absolute price (only used for LIMIT/STOP/STOP_LIMIT)
      stopLossDistance,       // distance in price units (USD for BTCUSD) — used
                              // to build relativeStopLoss for MARKET orders
      takeProfit,
      takeProfitDistance,
      limitPrice,             // absolute price — required for LIMIT / STOP_LIMIT
      stopPrice,              // absolute price — required for STOP / STOP_LIMIT
      comment = 'abot-copilot',
      label: rawLabel,          // caller can pass a fully-formed label string
      labelMeta,                // or pass {source, strategy, conviction, session, timeframe, regime, version}
      isLive = false,
    } = req.body

    // Build the cTrader label: explicit `label` wins, otherwise encode from
    // `labelMeta` (source defaults to 'copilot'), otherwise fall back to a
    // minimal copilot tag so reconcile can still identify our orders.
    let label
    if (typeof rawLabel === 'string' && rawLabel.length > 0) {
      label = rawLabel
    } else if (labelMeta && typeof labelMeta === 'object') {
      label = encodeLabel({
        source: labelMeta.source || 'copilot',
        version: labelMeta.version,
        strategy: labelMeta.strategy,
        conviction: typeof labelMeta.conviction === 'number'
          ? convictionBucket(labelMeta.conviction)
          : labelMeta.conviction,
        session: labelMeta.session,
        timeframe: labelMeta.timeframe,
        regime: labelMeta.regime,
      })
    } else {
      label = encodeLabel({ source: 'copilot' })
    }

    // ── Safety gates (server-enforced) ──

    // 1. Live/demo routing — pick the correct cTrader host. Live accounts are
    //    NO LONGER blocked but the client must explicitly pass isLive: true
    //    AND include a liveConfirm: true flag. This prevents any old code path
    //    that passes isLive without explicit acknowledgement from accidentally
    //    trading on live.
    if (isLive === true && req.body.liveConfirm !== true) {
      return res.status(403).json({
        error: 'SAFETY: live account requires liveConfirm: true in request body'
      })
    }

    // 2. Volume must be positive int. No hard upper bound here; the client
    //    fetches symbol metadata and sends minVolume.
    if (typeof volume !== 'number' || volume <= 0 || volume > 100000) {
      return res.status(400).json({ error: `SAFETY: volume ${volume} outside allowed range (1..100000)` })
    }

    // 3. Stop loss protection: either absolute `stopLoss` OR `stopLossDistance`
    //    must be provided. MARKET orders use distance (converted to relative),
    //    LIMIT/STOP orders use absolute.
    const hasAbsoluteSl = typeof stopLoss === 'number' && stopLoss > 0
    const hasDistanceSl = typeof stopLossDistance === 'number' && stopLossDistance > 0
    if (!hasAbsoluteSl && !hasDistanceSl) {
      return res.status(400).json({ error: 'SAFETY: stopLoss or stopLossDistance is required' })
    }

    // 4. Side validation
    if (tradeSide !== 'BUY' && tradeSide !== 'SELL') {
      return res.status(400).json({ error: `SAFETY: tradeSide must be BUY or SELL (got ${tradeSide})` })
    }

    // 5. Symbol ID required
    if (!symbolId) {
      return res.status(400).json({ error: 'SAFETY: symbolId is required' })
    }

    // 6. Credentials
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    // Dynamic host routing — caller must be explicit about which one they want
    const host = isLive === true ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      // Build the NEW_ORDER_REQ payload
      const orderPayload = {
        ctidTraderAccountId: parseInt(accountId),
        symbolId: parseInt(symbolId),
        orderType,
        tradeSide,
        volume: Math.round(volume),
        comment,
        label,
      }

      // SL/TP handling is order-type-specific per cTrader Open API:
      //   - MARKET:       must use relativeStopLoss / relativeTakeProfit
      //                   (distance in 1/100000 of a price unit)
      //   - LIMIT/STOP:   must use absolute stopLoss / takeProfit
      // Sending absolute SL with a MARKET order returns INVALID_REQUEST.
      const POINTS_PER_PRICE = 100000
      if (orderType === 'MARKET') {
        if (hasDistanceSl) {
          orderPayload.relativeStopLoss = Math.round(stopLossDistance * POINTS_PER_PRICE)
        }
        if (typeof takeProfitDistance === 'number' && takeProfitDistance > 0) {
          orderPayload.relativeTakeProfit = Math.round(takeProfitDistance * POINTS_PER_PRICE)
        }
      } else {
        // LIMIT / STOP / STOP_LIMIT — cTrader expects absolute prices.
        if (hasAbsoluteSl) orderPayload.stopLoss = Number(stopLoss)
        if (typeof takeProfit === 'number') orderPayload.takeProfit = Number(takeProfit)

        // Attach the trigger price for each non-MARKET order type.
        //   LIMIT        → needs limitPrice only (resting buy-below / sell-above)
        //   STOP         → needs stopPrice only (breakout entry)
        //   STOP_LIMIT   → needs BOTH stopPrice (trigger) and limitPrice (max fill)
        if (orderType === 'LIMIT' || orderType === 'STOP_LIMIT') {
          if (typeof limitPrice !== 'number' || limitPrice <= 0) {
            return res.status(400).json({ error: `SAFETY: ${orderType} order requires limitPrice` })
          }
          orderPayload.limitPrice = Number(limitPrice)
        }
        if (orderType === 'STOP' || orderType === 'STOP_LIMIT') {
          if (typeof stopPrice !== 'number' || stopPrice <= 0) {
            return res.status(400).json({ error: `SAFETY: ${orderType} order requires stopPrice` })
          }
          orderPayload.stopPrice = Number(stopPrice)
        }
      }

      // Run the sequence: app auth → account auth → new order → execution event
      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        { send: { payloadType: PT.NEW_ORDER_REQ, payload: orderPayload }, expect: PT.EXECUTION_EVENT },
      ], 20_000) // 20s timeout — order fills usually <5s

      const exec = results[2] || {}
      const deal = exec.deal || {}
      const position = exec.position || {}
      const order = exec.order || {}

      // Price can be in several places depending on whether we got
      // ORDER_ACCEPTED or ORDER_FILLED as the first execution event.
      // ORDER_ACCEPTED events can have deal.executionPrice = 0, which is a
      // placeholder, NOT a real fill. Use a positive-value filter instead of
      // `??` (which only falls through on null/undefined, not on 0).
      const firstPositive = (...vals) =>
        vals.find(v => typeof v === 'number' && v > 0) ?? null
      const executionPrice = firstPositive(
        deal.executionPrice,
        order.executionPrice,
        position.price,
        order.tradeData?.price,
      )

      return res.status(200).json({
        success: true,
        executionType: exec.executionType,
        dealId: deal.dealId || order.orderId || null,
        executionPrice,
        positionId: position.positionId || deal.positionId || order.positionId || null,
        stopLoss: hasAbsoluteSl ? Number(stopLoss) : null,
        stopLossDistance: hasDistanceSl ? Number(stopLossDistance) : null,
        side: tradeSide,
        volume,
        symbolId,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      return res.status(500).json({ error: `Order failed: ${err.message}` })
    }
  }

  // ── Amend Position SL/TP — AMEND_POSITION_SLTP_REQ (2110) ──
  // Modifies the stop-loss and/or take-profit of an OPEN position without
  // closing it. Used by the Wealth Advisor monitor loop to move a stop to
  // breakeven, trail a runner, or tighten risk after a position proves out.
  //
  // Request body:
  //   { accessToken, accountId, positionId, stopLoss?, takeProfit?, isLive }
  //
  // Either stopLoss OR takeProfit (or both) must be supplied. Omitted legs
  // are left at their current broker value. Both are absolute price levels,
  // NOT distances — this matches cTrader's ProtoOAAmendPositionSLTPReq.
  //
  // Common errors surfaced back to the client:
  //   POSITION_NOT_FOUND  — position already closed (SL/TP hit, or manual)
  //   INVALID_STOPLOSS    — SL is on the wrong side of current market
  //   INVALID_TAKEPROFIT  — TP is on the wrong side of current market
  if (req.method === 'POST' && req.body.action === 'amend-position') {
    const { accessToken, accountId, positionId, stopLoss, takeProfit, isLive = false } = req.body
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })
    if (!positionId) return res.status(400).json({ error: 'positionId is required' })
    const hasSl = typeof stopLoss === 'number' && stopLoss > 0
    const hasTp = typeof takeProfit === 'number' && takeProfit > 0
    if (!hasSl && !hasTp) {
      return res.status(400).json({ error: 'amend-position requires stopLoss or takeProfit (or both)' })
    }
    const host = isLive === true ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    const payload = { ctidTraderAccountId: parseInt(accountId), positionId: parseInt(positionId) }
    if (hasSl) payload.stopLoss = Number(stopLoss)
    if (hasTp) payload.takeProfit = Number(takeProfit)
    try {
      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        { send: { payloadType: PT.AMEND_POSITION_SLTP_REQ, payload }, expect: PT.EXECUTION_EVENT },
      ], 15_000)
      const exec = results[2] || {}
      const position = exec.position || {}
      return res.status(200).json({
        success: true,
        positionId: parseInt(positionId),
        executionType: exec.executionType,
        stopLoss: position.stopLoss ?? (hasSl ? Number(stopLoss) : null),
        takeProfit: position.takeProfit ?? (hasTp ? Number(takeProfit) : null),
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      const errMsg = err.message || ''
      // Race: the position closed between our snapshot and the amend call.
      // Return 200 with alreadyClosed so the client log doesn't scream.
      if (errMsg.includes('POSITION_NOT_FOUND') || errMsg.includes('Position not found')) {
        return res.status(200).json({
          success: false,
          alreadyClosed: true,
          positionId: parseInt(positionId),
          reason: 'Position already closed before the amend request reached cTrader.',
          rawError: errMsg,
          timestamp: new Date().toISOString(),
        })
      }
      return res.status(500).json({ error: `Amend failed: ${errMsg}` })
    }
  }

  // ── Close Position — CLOSE_POSITION_REQ (2111) ──
  // Used by the 5-min trend / 1-min exit strategy to close after the hold period.

  if (req.method === 'POST' && req.body.action === 'close-position') {
    const { accessToken, accountId, positionId, volume, isLive = false } = req.body

    if (isLive === true && req.body.liveConfirm !== true) {
      return res.status(403).json({
        error: 'SAFETY: live account requires liveConfirm: true in request body'
      })
    }
    if (!positionId) {
      return res.status(400).json({ error: 'positionId is required' })
    }
    // cTrader REQUIRES volume on CLOSE_POSITION_REQ — omitting it returns
    // "Message missing required fields: volume" from the broker.
    if (typeof volume !== 'number' || volume <= 0) {
      return res.status(400).json({ error: 'volume is required and must be a positive number' })
    }
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'cTrader credentials not configured' })

    const host = isLive === true ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

    try {
      const closePayload = {
        ctidTraderAccountId: parseInt(accountId),
        positionId: parseInt(positionId),
        volume: Math.round(volume),
      }

      const results = await wsQuery(host, [
        { send: { payloadType: PT.APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT.APP_AUTH_RES },
        { send: { payloadType: PT.ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT.ACCOUNT_AUTH_RES },
        { send: { payloadType: PT.CLOSE_POSITION_REQ, payload: closePayload }, expect: PT.EXECUTION_EVENT },
      ], 20_000)

      const exec = results[2] || {}
      const deal = exec.deal || {}
      const position = exec.position || {}
      const order = exec.order || {}

      // Price can live in several places — filter zeros since ORDER_ACCEPTED
      // events can have placeholder 0 executionPrice before the real fill.
      const firstPositiveC = (...vals) =>
        vals.find(v => typeof v === 'number' && v > 0) ?? null
      const closePrice = firstPositiveC(
        deal.executionPrice,
        order.executionPrice,
        position.price,
      )

      return res.status(200).json({
        success: true,
        executionType: exec.executionType,
        dealId: deal.dealId || null,
        closePrice,
        positionId: position.positionId || parseInt(positionId),
        grossProfit: deal.closePositionDetail?.grossProfit ?? null,
        netProfit: deal.closePositionDetail ? (
          ((deal.closePositionDetail.grossProfit || 0)
            - Math.abs(deal.closePositionDetail.commission || 0)
            - Math.abs(deal.closePositionDetail.swap || 0)) / 100
        ) : null,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      // POSITION_NOT_FOUND is a race, not a failure: the position was already
      // closed before our CLOSE_POSITION_REQ arrived at the broker. Most
      // common cause is the position hit its SL or TP between our open call
      // and our close call (especially for short holds with tight stops).
      // From the bot's perspective the outcome is identical — the position
      // is gone — so surface it as a success with an `alreadyClosed: true`
      // flag so the client can log a calm "already closed" message instead
      // of a scary error and can query deal history for the real close.
      const errMsg = err.message || ''
      if (errMsg.includes('POSITION_NOT_FOUND') || errMsg.includes('Position not found')) {
        return res.status(200).json({
          success: true,
          alreadyClosed: true,
          positionId: parseInt(positionId),
          reason: 'Position was already closed when CLOSE_POSITION_REQ reached cTrader. Most likely the SL or TP was hit between our open and close calls. Check your cTrader deal history for the actual exit price and P&L.',
          rawError: errMsg,
          timestamp: new Date().toISOString(),
        })
      }
      return res.status(500).json({ error: `Close failed: ${err.message}` })
    }
  }

  res.status(400).json({ error: 'Invalid action' })
}
